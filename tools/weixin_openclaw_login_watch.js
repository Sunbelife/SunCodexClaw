#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const { deepMerge, readConfigEntry, upsertConfigEntry } = require('./lib/local_secret_store');
const {
  DEFAULT_BASE_URL,
  DEFAULT_BOT_TYPE,
  fetchLoginQr,
  normalizeString,
  pollLoginStatus,
} = require('./lib/openclaw_weixin_client');

const REPO_DIR = path.resolve(__dirname, '..');
const DEFAULT_CONFIG_DIR = path.join(REPO_DIR, 'config', 'weixin_openclaw');
const PATH_VALUE = process.env.PATH || '/usr/bin:/bin:/usr/sbin:/sbin';
const CODEX_HOME_VALUE = process.env.CODEX_HOME || path.join(process.env.HOME || '', '.codex');
const NODE_BIN = process.execPath;

function getArg(flag, fallback = '') {
  const idx = process.argv.indexOf(flag);
  if (idx >= 0 && idx + 1 < process.argv.length) return process.argv[idx + 1];
  return fallback;
}

function hasFlag(flag) {
  return process.argv.includes(flag);
}

function ensure(condition, message) {
  if (!condition) throw new Error(message);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readJsonIfExists(filePath) {
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function loadConfig(accountName, configDir) {
  const defaultPath = path.resolve(configDir, 'default.json');
  const defaultConfig = deepMerge(
    readJsonIfExists(defaultPath) || {},
    readConfigEntry('weixin_openclaw', 'default', {})
  );
  const chosen = normalizeString(accountName) || 'default';
  if (chosen === 'default') return defaultConfig;
  const accountPath = path.resolve(configDir, `${chosen}.json`);
  const accountConfig = readJsonIfExists(accountPath) || {};
  const yamlConfig = readConfigEntry('weixin_openclaw', chosen, {});
  return deepMerge(defaultConfig, accountConfig, yamlConfig);
}

function resolveStateFile(accountName) {
  return path.join(REPO_DIR, '.runtime', 'weixin_openclaw', accountName, 'login-watch.json');
}

function writeState(stateFile, patch) {
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  let current = {};
  if (fs.existsSync(stateFile)) {
    try {
      current = JSON.parse(fs.readFileSync(stateFile, 'utf8')) || {};
    } catch (_) {
      current = {};
    }
  }
  const next = {
    ...current,
    ...patch,
    updated_at: new Date().toISOString(),
  };
  fs.writeFileSync(stateFile, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
}

function launchRunner(accountName, logFile) {
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  const label = `com.sunbelife.suncodexclaw.weixin.bot.${accountName}`;
  const shellCmd = [
    `export PATH=${shellEscape(PATH_VALUE)}`,
    `export CODEX_HOME=${shellEscape(CODEX_HOME_VALUE)}`,
    `cd ${shellEscape(REPO_DIR)}`,
    `${shellEscape(NODE_BIN)} tools/weixin_openclaw_bot.js --account ${shellEscape(accountName)} >> ${shellEscape(logFile)} 2>&1`,
  ].join(' && ');

  if (process.platform === 'darwin') {
    spawnSync('launchctl', ['remove', label], { stdio: 'ignore' });
    const submitted = spawnSync('launchctl', ['submit', '-l', label, '--', '/bin/zsh', '-lc', shellCmd], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (submitted.status === 0) {
      const listed = spawnSync('launchctl', ['list', label], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      if (listed.status === 0) {
        const match = String(listed.stdout || '').match(/"PID"\s*=\s*(\d+);/);
        return match ? Number(match[1]) : 0;
      }
      return 0;
    }
  }

  const out = fs.openSync(logFile, 'a');
  const child = spawn('node', ['tools/weixin_openclaw_bot.js', '--account', accountName], {
    cwd: REPO_DIR,
    detached: true,
    stdio: ['ignore', out, out],
  });
  child.unref();
  return child.pid || 0;
}

function shellEscape(value) {
  return `'${String(value || '').replace(/'/g, `'\\''`)}'`;
}

async function main() {
  const accountName = normalizeString(getArg('--account', 'default')) || 'default';
  const configDir = path.resolve(getArg('--config-dir', DEFAULT_CONFIG_DIR));
  const timeoutMs = Math.max(10_000, Number.parseInt(getArg('--timeout-ms', '480000'), 10) || 480_000);
  const pollIntervalMs = Math.max(1000, Number.parseInt(getArg('--poll-interval-ms', '2000'), 10) || 2000);
  const stateFile = path.resolve(getArg('--state-file', resolveStateFile(accountName)));
  const logFile = path.resolve(
    getArg('--runner-log', path.join(path.dirname(stateFile), 'run.log'))
  );
  const config = loadConfig(accountName, configDir);
  const baseUrl = normalizeString(config.base_url) || DEFAULT_BASE_URL;
  const botType = normalizeString(config.bot_type) || DEFAULT_BOT_TYPE;
  const routeTag = normalizeString(config.route_tag);

  const qr = await fetchLoginQr({ baseUrl, botType, routeTag });
  ensure(qr.qrcode, '二维码 token 为空');
  ensure(qr.qrcodeUrl, '二维码链接为空');

  writeState(stateFile, {
    account: accountName,
    status: 'qr_ready',
    qrcode: qr.qrcode,
    qrcode_url: qr.qrcodeUrl,
    base_url: baseUrl,
  });
  console.log(`qrcode_url=${qr.qrcodeUrl}`);

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = await pollLoginStatus({
      baseUrl,
      qrcode: qr.qrcode,
      routeTag,
    });
    writeState(stateFile, {
      status: status.status || 'wait',
      account_id: status.accountId || '',
      user_id: status.userId || '',
    });

    if (status.status === 'confirmed' && status.botToken) {
      upsertConfigEntry('weixin_openclaw', accountName, {
        token: status.botToken,
        base_url: status.baseUrl || baseUrl,
        account_id: status.accountId || '',
        user_id: status.userId || '',
        bot_type: botType,
        route_tag: routeTag,
      });
      const runnerPid = hasFlag('--skip-runner')
        ? 0
        : launchRunner(accountName, logFile);
      writeState(stateFile, {
        status: hasFlag('--skip-runner') ? 'confirmed' : 'runner_started',
        runner_pid: runnerPid || '',
      });
      console.log(`confirmed account=${accountName} runner_pid=${runnerPid || ''}`);
      return;
    }

    if (status.status === 'expired') {
      writeState(stateFile, { status: 'expired' });
      console.log('expired');
      return;
    }

    await sleep(pollIntervalMs);
  }

  writeState(stateFile, { status: 'timeout' });
  console.log('timeout');
}

main().catch((err) => {
  console.error(err?.stack || err?.message || String(err));
  process.exit(1);
});
