#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const {
  readConfigEntry,
} = require('./lib/local_secret_store');
const {
  asPlainObject,
  createFeishuClient,
  ensure,
  normalizeString,
  resolveCredentials,
  sendCodexReplyPassthrough,
} = require('./lib/studio_runtime_support');
const {
  buildDailyStoreReport,
  renderDailyStoreReportFeishuCard,
  renderDailyStoreReportMarkdown,
  renderDailyStoreReportText,
  resolveDailyStoreReportConfig,
} = require('./lib/daily_store_report');

const DEFAULT_TIMEZONE = 'Asia/Shanghai';
const REPO_DIR = path.resolve(__dirname, '..');
const FEISHU_RUNTIME_DIR = path.join(REPO_DIR, '.runtime', 'feishu');
const RUN_LOCK_DIR = 'scheduled_job_run_locks';
const RUN_LOCK_STALE_MS = 30 * 60 * 1000;

function getArg(flag, fallback = '') {
  const idx = process.argv.indexOf(flag);
  if (idx >= 0 && idx + 1 < process.argv.length) return process.argv[idx + 1];
  return fallback;
}

function buildDefaultReportDate() {
  const now = new Date();
  const shifted = new Date(now.getTime() + 8 * 60 * 60 * 1000 - 24 * 60 * 60 * 1000);
  return shifted.toISOString().slice(0, 10);
}

function buildCurrentRunKey(timeZone = DEFAULT_TIMEZONE) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const parts = fmt.formatToParts(new Date());
  const map = {};
  for (const part of parts) {
    if (part.type !== 'literal') map[part.type] = part.value;
  }
  return `${map.year}-${map.month}-${map.day}`;
}

function safePathSegment(value) {
  const text = normalizeString(value).replace(/[^A-Za-z0-9._-]+/g, '_');
  return text || 'unknown';
}

function taskRunLockPath(accountName, taskId, runKey) {
  return path.join(
    FEISHU_RUNTIME_DIR,
    RUN_LOCK_DIR,
    `${safePathSegment(accountName)}__${safePathSegment(taskId)}__${safePathSegment(runKey)}.json`
  );
}

function readRunLock(filePath) {
  try {
    return asPlainObject(JSON.parse(fs.readFileSync(filePath, 'utf8')));
  } catch (_) {
    return {};
  }
}

function nowIso() {
  return new Date().toISOString();
}

function acquireDailySendGuard(accountName, taskId, runKey) {
  const filePath = taskRunLockPath(accountName, taskId, runKey);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const payload = {
    status: 'running',
    account_name: accountName,
    task_id: taskId,
    run_key: runKey,
    source: 'feishu_daily_report.js',
    pid: process.pid,
    created_at: nowIso(),
    updated_at: nowIso(),
  };
  try {
    fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
    });
    return { acquired: true, filePath };
  } catch (err) {
    if (err?.code !== 'EEXIST') throw err;
    const current = readRunLock(filePath);
    if (normalizeString(current.status) === 'sent') {
      return { acquired: false, filePath, reason: 'sent' };
    }
    const createdAt = Date.parse(normalizeString(current.created_at || current.updated_at));
    const stale = !Number.isFinite(createdAt) || Date.now() - createdAt > RUN_LOCK_STALE_MS;
    if (!stale) {
      return { acquired: false, filePath, reason: normalizeString(current.status) || 'locked' };
    }
    try {
      fs.unlinkSync(filePath);
    } catch (_) {
      return { acquired: false, filePath, reason: 'locked' };
    }
    return acquireDailySendGuard(accountName, taskId, runKey);
  }
}

function markDailySendGuardSent(lock) {
  if (!lock?.acquired || !lock.filePath) return;
  const current = readRunLock(lock.filePath);
  const next = {
    ...current,
    status: 'sent',
    updated_at: nowIso(),
  };
  fs.writeFileSync(lock.filePath, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
}

function releaseDailySendGuard(lock) {
  if (!lock?.acquired || !lock.filePath) return;
  try {
    fs.unlinkSync(lock.filePath);
  } catch (_) {
    // best effort
  }
}

function renderReportPayload(report, { channel = 'feishu', format = 'text' } = {}) {
  const normalizedChannel = String(channel || 'feishu').trim().toLowerCase() || 'feishu';
  const normalizedFormat = String(format || 'text').trim().toLowerCase() || 'text';

  if (normalizedFormat === 'card') {
    return {
      messageType: 'card',
      content: renderDailyStoreReportFeishuCard(report),
      fallbackText: renderDailyStoreReportText(report),
    };
  }

  if (normalizedFormat === 'markdown') {
    return {
      messageType: 'markdown',
      content: renderDailyStoreReportMarkdown(report, { channelType: normalizedChannel }),
    };
  }

  return {
    messageType: 'text',
    content: renderDailyStoreReportText(report),
  };
}

async function main() {
  const account = getArg('--account', process.env.FEISHU_ACCOUNT || 'default').trim() || 'default';
  const date = getArg('--date', '').trim();
  const channel = getArg('--channel', 'feishu').trim() || 'feishu';
  const format = getArg('--format', '').trim();
  const emitJson = process.argv.includes('--json');
  const shouldSend = process.argv.includes('--send');
  const allowDuplicate = process.argv.includes('--allow-duplicate');

  const config = readConfigEntry('feishu', account, {});
  const dailyReport = resolveDailyStoreReportConfig(config, account);
  ensure(dailyReport.store.baseUrl, `daily_report.store.base_url is required for account "${account}"`);
  ensure(dailyReport.store.email, `daily_report.store.email is required for account "${account}"`);
  ensure(dailyReport.store.password, `daily_report.store.password is required for account "${account}"`);

  const reportDate = date || buildDefaultReportDate();

  const report = await buildDailyStoreReport(dailyReport, reportDate);
  const payload = renderReportPayload(report, {
    channel,
    format: format || (String(channel).trim().toLowerCase() === 'wecom' ? 'markdown' : 'card'),
  });

  if (emitJson) {
    process.stdout.write(`${JSON.stringify({
      message_type: payload.messageType,
      content: payload.content,
      fallback_text: payload.fallbackText || '',
    })}\n`);
    return;
  }

  if (!shouldSend) {
    if (payload.messageType === 'card') {
      process.stdout.write(`${JSON.stringify(payload.content, null, 2)}\n`);
    } else {
      process.stdout.write(`${String(payload.content || '').trim()}\n`);
    }
    return;
  }

  ensure(dailyReport.chatId, `daily_report.chat_id is required for account "${account}"`);
  const taskId = `legacy_daily_store_report_${account}`;
  const runKey = buildCurrentRunKey(dailyReport.timeZone || DEFAULT_TIMEZONE);
  const sendGuard = allowDuplicate
    ? null
    : acquireDailySendGuard(account, taskId, runKey);
  if (sendGuard && !sendGuard.acquired) {
    process.stdout.write(`skip duplicate daily report for ${account} on ${runKey} (${sendGuard.reason || 'locked'})\n`);
    return;
  }
  const creds = resolveCredentials(config);
  const client = createFeishuClient({
    domain: config.domain || 'feishu',
    creds: {
      appId: creds.appId,
      appSecret: creds.appSecret,
      botOpenId: creds.botOpenId,
    },
  });
  const text = payload.messageType === 'text'
    ? payload.content
    : (payload.fallbackText || renderDailyStoreReportText(report));
  try {
    await sendCodexReplyPassthrough(client, dailyReport.chatId, text);
    if (sendGuard) markDailySendGuardSent(sendGuard);
    process.stdout.write(`sent daily report to ${dailyReport.chatId} for ${reportDate}\n`);
  } catch (err) {
    if (sendGuard) releaseDailySendGuard(sendGuard);
    throw err;
  }
}

main().catch((err) => {
  process.stderr.write(`${err.message || String(err)}\n`);
  process.exit(1);
});
