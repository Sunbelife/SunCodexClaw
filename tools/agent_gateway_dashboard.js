#!/usr/bin/env node
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const REPO_DIR = path.resolve(__dirname, '..');
const CHATLOG_DIR = path.join(REPO_DIR, 'Chatlog');
const FEISHU_RUNTIME_DIR = path.join(REPO_DIR, '.runtime', 'feishu');
const BRIDGE_SCRIPT = path.join(REPO_DIR, 'tools', 'feishu_desktop_bridge.js');
const NODE_BIN = process.execPath || 'node';

function getArg(flag, fallback = '') {
  const idx = process.argv.indexOf(flag);
  if (idx >= 0 && idx + 1 < process.argv.length) return process.argv[idx + 1];
  return fallback;
}

function normalizeString(value) {
  return String(value || '').trim();
}

function readJsonIfExists(filePath, fallback = null) {
  if (!fs.existsSync(filePath)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_) {
    return fallback;
  }
}

function readTextIfExists(filePath, fallback = '') {
  if (!fs.existsSync(filePath)) return fallback;
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (_) {
    return fallback;
  }
}

function countJsonlLines(filePath) {
  const raw = readTextIfExists(filePath, '');
  if (!raw) return 0;
  return raw.split(/\r?\n/).filter(Boolean).length;
}

function statIso(filePath) {
  try {
    return fs.statSync(filePath).mtime.toISOString();
  } catch (_) {
    return '';
  }
}

function listDirs(dirPath) {
  if (!fs.existsSync(dirPath)) return [];
  try {
    return fs.readdirSync(dirPath, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
  } catch (_) {
    return [];
  }
}

function runBridge(command, account = '', payload = null) {
  const args = [BRIDGE_SCRIPT, command];
  if (account) args.push(account);
  const run = spawnSync(NODE_BIN, args, {
    cwd: REPO_DIR,
    input: payload ? `${JSON.stringify(payload)}\n` : undefined,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 12,
  });
  const output = `${run.stdout || ''}${run.stderr || ''}`.trim();
  if (run.status !== 0) {
    return {
      ok: false,
      exitCode: run.status || 1,
      error: output || `${command} failed`,
    };
  }
  try {
    return JSON.parse(run.stdout || '{}');
  } catch (_) {
    return {
      ok: false,
      exitCode: 0,
      error: output || 'bridge returned non-json output',
    };
  }
}

function runBridgeAsync(command, account = '', payload = null) {
  return new Promise((resolve) => {
    const args = [BRIDGE_SCRIPT, command];
    if (account) args.push(account);
    const child = spawn(NODE_BIN, args, {
      cwd: REPO_DIR,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (buf) => {
      stdout = `${stdout}${String(buf || '')}`;
      if (stdout.length > 1024 * 1024 * 12) stdout = stdout.slice(-1024 * 1024 * 12);
    });
    child.stderr.on('data', (buf) => {
      stderr = `${stderr}${String(buf || '')}`;
      if (stderr.length > 1024 * 1024 * 4) stderr = stderr.slice(-1024 * 1024 * 4);
    });
    child.on('error', (err) => {
      resolve({
        ok: false,
        exitCode: 1,
        error: `${command} failed to start: ${err.message}`,
      });
    });
    child.on('close', (code) => {
      const output = `${stdout || ''}${stderr || ''}`.trim();
      if (code !== 0) {
        resolve({
          ok: false,
          exitCode: code || 1,
          error: output || `${command} failed`,
        });
        return;
      }
      try {
        resolve(JSON.parse(stdout || '{}'));
      } catch (_) {
        resolve({
          ok: false,
          exitCode: 0,
          error: output || 'bridge returned non-json output',
        });
      }
    });
    child.stdin.end(payload ? `${JSON.stringify(payload)}\n` : '');
  });
}

function buildChatlogSummary(chatlogDir = CHATLOG_DIR, limit = 24) {
  const bots = [];
  for (const botName of listDirs(chatlogDir)) {
    const botDir = path.join(chatlogDir, botName);
    const dateFolders = listDirs(botDir).sort().reverse();
    const days = dateFolders.slice(0, Math.max(1, Number(limit) || 24)).map((date) => {
      const filePath = path.join(botDir, date, 'chat.jsonl');
      return {
        date,
        filePath,
        messages: countJsonlLines(filePath),
        updatedAt: statIso(filePath),
      };
    }).filter((item) => item.messages > 0 || item.updatedAt);
    const totalMessages = days.reduce((sum, item) => sum + item.messages, 0);
    bots.push({
      botName,
      totalMessages,
      latestDate: days[0]?.date || '',
      latestUpdatedAt: days[0]?.updatedAt || '',
      days,
    });
  }
  bots.sort((a, b) => String(b.latestUpdatedAt || '').localeCompare(String(a.latestUpdatedAt || '')));
  return {
    dir: chatlogDir,
    botCount: bots.length,
    bots,
  };
}

function isPlainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function compactText(value, maxLength = 500) {
  const text = normalizeString(value).replace(/\s+/g, ' ');
  if (!text || text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 1))}…`;
}

function safeIdSegment(value) {
  const text = normalizeString(value);
  return text.replace(/[^A-Za-z0-9_.:-]+/g, '_').slice(0, 120) || 'thread';
}

function readJsonlRecords(filePath, maxLines = 0) {
  const raw = readTextIfExists(filePath, '');
  if (!raw) return [];
  const lines = raw.split(/\r?\n/).filter(Boolean);
  const selected = maxLines > 0 && lines.length > maxLines ? lines.slice(-maxLines) : lines;
  const records = [];
  for (const line of selected) {
    try {
      const parsed = JSON.parse(line);
      if (isPlainObject(parsed)) records.push(parsed);
    } catch (_) {
      // Keep the dashboard resilient if a JSONL write was interrupted.
    }
  }
  return records;
}

function chatTypeLabel(chatType) {
  const value = normalizeString(chatType).toLowerCase();
  if (value === 'group') return '飞书群聊';
  if (value === 'p2p') return '飞书私聊';
  if (value) return `飞书 · ${value}`;
  return '飞书';
}

function senderLabelFromRecord(record) {
  const sender = isPlainObject(record?.sender) ? record.sender : {};
  return normalizeString(
    sender.displayName
    || sender.name
    || sender.openId
    || sender.userId
    || sender.unionId
    || record?.chat_scope_actor
    || record?.chatScopeActor
    || ''
  );
}

function describeChatlogAttachments(record) {
  const attachments = record?.attachments;
  const messageType = normalizeString(record?.message_type || record?.messageType);
  if (Array.isArray(attachments) && attachments.length) {
    return `[${messageType || '附件'}消息 · ${attachments.length} 个附件]`;
  }
  if (isPlainObject(attachments) && Object.keys(attachments).length) {
    return `[${messageType || '附件'}消息]`;
  }
  if (messageType && messageType !== 'text') return `[${messageType} 消息]`;
  return '';
}

function chatlogRecordText(record) {
  const text = normalizeString(record?.text || record?.raw_text || record?.rawText);
  if (text) return text;
  const event = normalizeString(record?.event);
  const reason = normalizeString(record?.reason);
  if (reason) return event === 'skip' ? `跳过：${reason}` : reason;
  const attachmentText = describeChatlogAttachments(record);
  if (attachmentText) return attachmentText;
  return event ? `[${event}]` : '';
}

function chatlogRoleFromRecord(record) {
  const direction = normalizeString(record?.direction).toLowerCase();
  if (direction === 'in') return 'user';
  if (direction === 'out') return 'assistant';
  if (direction === 'error') return 'error';
  return 'system';
}

function normalizeChatlogMessage(record, botName) {
  const role = chatlogRoleFromRecord(record);
  const text = chatlogRecordText(record);
  if (!text) return null;
  return {
    role,
    text: compactText(text, role === 'assistant' ? 4000 : 2000),
    at: normalizeString(record?.ts || record?.created_at || record?.createdAt),
    senderName: role === 'assistant'
      ? normalizeString(record?.bot_name || record?.botName || botName)
      : senderLabelFromRecord(record),
    event: normalizeString(record?.event),
    direction: normalizeString(record?.direction),
    messageType: normalizeString(record?.message_type || record?.messageType),
    platform: 'feishu',
  };
}

function inferAccountFromBotName(botName, bridgeAccounts = []) {
  const name = normalizeString(botName);
  if (!name) return '';
  const exact = bridgeAccounts.find((item) => normalizeString(item?.displayName) === name);
  if (exact?.account) return normalizeString(exact.account);
  const loose = bridgeAccounts.find((item) => {
    const displayName = normalizeString(item?.displayName);
    const account = normalizeString(item?.account);
    return (displayName && (displayName.includes(name) || name.includes(displayName)))
      || (account && (account.includes(name) || name.includes(account)));
  });
  return normalizeString(loose?.account || '');
}

function buildChatlogConversationThreads(chatlogDir = CHATLOG_DIR, options = {}) {
  const settings = Array.isArray(options) ? { bridgeAccounts: options } : (options || {});
  const bridgeAccounts = Array.isArray(settings.bridgeAccounts) ? settings.bridgeAccounts : [];
  const dayLimit = Number(settings.dayLimit ?? 90);
  const historyLimit = Math.max(20, Number(settings.historyLimit || 160));
  const threadLimitPerAccount = Math.max(10, Number(settings.threadLimitPerAccount || 200));
  const maxLinesPerFile = Math.max(0, Number(settings.maxLinesPerFile || 0));
  const accounts = {};
  const bots = [];
  let totalThreads = 0;
  let totalMessages = 0;

  for (const botName of listDirs(chatlogDir)) {
    const botDir = path.join(chatlogDir, botName);
    const dateFolders = listDirs(botDir).sort();
    const selectedDates = dayLimit > 0 ? dateFolders.slice(-dayLimit) : dateFolders;
    const groups = new Map();

    for (const date of selectedDates) {
      const filePath = path.join(botDir, date, 'chat.jsonl');
      for (const record of readJsonlRecords(filePath, maxLinesPerFile)) {
        const account = normalizeString(record.account) || inferAccountFromBotName(botName, bridgeAccounts) || botName;
        const chatScope = normalizeString(record.chat_scope || record.chatScope || record.chat_id || record.chatId);
        const threadKey = chatScope || normalizeString(record.thread_id || record.threadId) || normalizeString(record.message_id || record.messageId);
        if (!threadKey) continue;
        const groupKey = `${account}:${threadKey}`;
        if (!groups.has(groupKey)) {
          groups.set(groupKey, {
            account,
            botName: normalizeString(record.bot_name || record.botName || botName) || botName,
            chatId: normalizeString(record.chat_id || record.chatId),
            chatType: normalizeString(record.chat_type || record.chatType),
            chatScope,
            threadIds: new Set(),
            records: [],
            firstTs: '',
            lastTs: '',
            initiator: '',
            initiatorId: '',
          });
        }
        const group = groups.get(groupKey);
        const ts = normalizeString(record.ts || record.created_at || record.createdAt);
        if (ts && (!group.firstTs || ts < group.firstTs)) group.firstTs = ts;
        if (ts && (!group.lastTs || ts > group.lastTs)) group.lastTs = ts;
        const threadId = normalizeString(record.thread_id || record.threadId);
        if (threadId) group.threadIds.add(threadId);
        const sender = isPlainObject(record.sender) ? record.sender : {};
        if (!group.initiator && normalizeString(record.direction).toLowerCase() === 'in') {
          group.initiator = senderLabelFromRecord(record) || '飞书用户';
          group.initiatorId = normalizeString(sender.openId || sender.userId || sender.unionId);
        }
        const message = normalizeChatlogMessage(record, group.botName);
        if (message) {
          group.records.push(message);
          totalMessages += 1;
        }
      }
    }

    const botThreads = Array.from(groups.values()).map((group) => {
      group.records.sort((a, b) => normalizeString(a.at).localeCompare(normalizeString(b.at)));
      const history = group.records.slice(-historyLimit);
      const lastMessage = history[history.length - 1] || null;
      const initiator = group.initiator || '飞书用户';
      const platform = chatTypeLabel(group.chatType);
      return {
        id: `feishu:${safeIdSegment(group.account)}:${safeIdSegment(group.chatScope || Array.from(group.threadIds)[0])}`,
        source: 'feishu_chatlog',
        account: group.account,
        botName: group.botName,
        title: `${platform.replace(/^飞书/, '') || '会话'} · ${initiator}`.replace(/^ · /, ''),
        name: `${platform} · ${initiator}`,
        platform: 'feishu',
        platformLabel: platform,
        initiator,
        initiatorId: group.initiatorId,
        startedAt: group.firstTs,
        updatedAt: group.lastTs || group.firstTs,
        chatId: group.chatId,
        chatType: group.chatType,
        chatScope: group.chatScope,
        threadIds: Array.from(group.threadIds),
        messageCount: group.records.length,
        turnCount: group.records.filter((item) => item.role === 'user' || item.role === 'assistant').length,
        preview: compactText(lastMessage?.text || '', 180),
        history,
      };
    }).sort((a, b) => normalizeString(b.updatedAt).localeCompare(normalizeString(a.updatedAt)));

    const latestUpdatedAt = botThreads[0]?.updatedAt || '';
    const inferredAccount = botThreads[0]?.account || inferAccountFromBotName(botName, bridgeAccounts);
    bots.push({
      botName,
      account: inferredAccount,
      threadCount: botThreads.length,
      latestUpdatedAt,
      latestPreview: botThreads[0]?.preview || '',
    });
    totalThreads += botThreads.length;

    for (const thread of botThreads) {
      if (!accounts[thread.account]) accounts[thread.account] = [];
      accounts[thread.account].push(thread);
    }
  }

  for (const account of Object.keys(accounts)) {
    accounts[account] = accounts[account]
      .sort((a, b) => normalizeString(b.updatedAt).localeCompare(normalizeString(a.updatedAt)))
      .slice(0, threadLimitPerAccount);
  }
  bots.sort((a, b) => normalizeString(b.latestUpdatedAt).localeCompare(normalizeString(a.latestUpdatedAt)));

  return {
    dir: chatlogDir,
    generatedAt: new Date().toISOString(),
    totalThreads,
    totalMessages,
    threadLimitPerAccount,
    historyLimit,
    accounts,
    bots,
  };
}

function countFiles(dirPath, suffix = '') {
  if (!fs.existsSync(dirPath)) return 0;
  try {
    return fs.readdirSync(dirPath)
      .filter((name) => !suffix || name.endsWith(suffix))
      .length;
  } catch (_) {
    return 0;
  }
}

function buildApprovalSummary(runtimeDir = FEISHU_RUNTIME_DIR) {
  const approvalsDir = path.join(runtimeDir, 'approvals');
  if (!fs.existsSync(approvalsDir)) {
    return {
      dir: approvalsDir,
      pendingTotal: 0,
      ownerBindings: 0,
      accounts: [],
    };
  }
  const pendingFiles = fs.readdirSync(approvalsDir).filter((name) => name.endsWith('.pending.json'));
  const accounts = pendingFiles.map((fileName) => {
    const account = fileName.replace(/\.pending\.json$/, '');
    const pendingPath = path.join(approvalsDir, fileName);
    const ownerPath = path.join(approvalsDir, `${account}.owner.json`);
    const pending = readJsonIfExists(pendingPath, {});
    const requests = pending && typeof pending.requests === 'object' && !Array.isArray(pending.requests)
      ? pending.requests
      : {};
    return {
      account,
      pending: Object.keys(requests).length,
      ownerBound: Boolean(readJsonIfExists(ownerPath, null)),
      pendingPath,
      ownerPath,
    };
  });
  return {
    dir: approvalsDir,
    pendingTotal: accounts.reduce((sum, item) => sum + item.pending, 0),
    ownerBindings: accounts.filter((item) => item.ownerBound).length,
    accounts,
  };
}

function buildRuntimeSummary(runtimeDir = FEISHU_RUNTIME_DIR) {
  return {
    dir: runtimeDir,
    memoryFiles: countFiles(path.join(runtimeDir, 'memory'), '.json'),
    scheduledJobFiles: countFiles(path.join(runtimeDir, 'scheduled_jobs'), '.json'),
    logFiles: countFiles(path.join(runtimeDir, 'logs'), '.log'),
    approval: buildApprovalSummary(runtimeDir),
  };
}

function stripTomlComment(line) {
  const input = String(line || '');
  let quote = '';
  let escaped = false;
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quote && ch === '\\') {
      escaped = true;
      continue;
    }
    if ((ch === '"' || ch === "'") && (!quote || quote === ch)) {
      quote = quote ? '' : ch;
      continue;
    }
    if (!quote && ch === '#') return input.slice(0, i).trim();
  }
  return input.trim();
}

function parseTomlStringValue(rawValue) {
  const value = stripTomlComment(rawValue).trim();
  if (!value) return '';
  if (value.startsWith('"')) {
    try {
      return String(JSON.parse(value));
    } catch (_) {
      return value.replace(/^"|"$/g, '');
    }
  }
  if (value.startsWith("'")) return value.replace(/^'|'$/g, '');
  return value;
}

function parseTomlStringArray(rawValue) {
  const value = stripTomlComment(rawValue).trim();
  if (!value || !value.startsWith('[')) return [];
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) return parsed.map((item) => String(item));
  } catch (_) {
    // TOML arrays in our configs are JSON-compatible. The regex fallback keeps
    // the dashboard useful if a hand-edited file has a minor formatting quirk.
  }
  const values = [];
  const re = /"((?:\\.|[^"\\])*)"|'([^']*)'/g;
  let match;
  while ((match = re.exec(value))) {
    if (match[1] !== undefined) {
      try {
        values.push(JSON.parse(`"${match[1]}"`));
      } catch (_) {
        values.push(match[1]);
      }
    } else {
      values.push(match[2]);
    }
  }
  return values;
}

function parseMcpServersFromToml(tomlText, sourceFile = '') {
  const servers = new Map();
  let current = null;
  let currentEnv = null;

  const ensureServer = (name) => {
    if (!servers.has(name)) {
      servers.set(name, {
        name,
        command: '',
        args: [],
        startupTimeoutSec: null,
        envKeys: [],
        sourceFile,
      });
    }
    return servers.get(name);
  };

  for (const rawLine of String(tomlText || '').split(/\r?\n/)) {
    const line = stripTomlComment(rawLine);
    if (!line) continue;

    const section = line.match(/^\[([^\]]+)\]$/);
    if (section) {
      const baseMatch = section[1].match(/^mcp_servers\.([^.]+)$/);
      const envMatch = section[1].match(/^mcp_servers\.([^.]+)\.env$/);
      current = baseMatch ? ensureServer(baseMatch[1]) : null;
      currentEnv = envMatch ? ensureServer(envMatch[1]) : null;
      continue;
    }

    const kv = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+)$/);
    if (!kv) continue;
    const key = kv[1];
    const value = kv[2];

    if (current) {
      if (key === 'command') current.command = parseTomlStringValue(value);
      if (key === 'args') current.args = parseTomlStringArray(value);
      if (key === 'startup_timeout_sec') current.startupTimeoutSec = Number(value) || null;
      continue;
    }

    if (currentEnv && !currentEnv.envKeys.includes(key)) {
      currentEnv.envKeys.push(key);
    }
  }

  return Array.from(servers.values()).sort((a, b) => a.name.localeCompare(b.name));
}

function listCodexHomeConfigPaths(homeDir = os.homedir()) {
  const homes = [];
  try {
    for (const entry of fs.readdirSync(homeDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (entry.name !== '.codex' && !entry.name.startsWith('.codex-fei-')) continue;
      const home = path.join(homeDir, entry.name);
      const configPath = path.join(home, 'config.toml');
      if (!fs.existsSync(configPath)) continue;
      homes.push({ home, name: entry.name, configPath });
    }
  } catch (_) {
    return [];
  }
  homes.sort((a, b) => a.name.localeCompare(b.name));
  return homes;
}

function inferMcpServerPath(server) {
  const args = Array.isArray(server.args) ? server.args : [];
  const scriptArg = args.find((arg) => path.isAbsolute(arg) && /\.(mjs|cjs|js)$/i.test(arg));
  if (scriptArg) return scriptArg;
  if (server.command && path.isAbsolute(server.command)) return server.command;
  return '';
}

function readPackageInfoForServer(serverPath) {
  if (!serverPath) return null;
  const startDir = fs.existsSync(serverPath) && fs.statSync(serverPath).isDirectory()
    ? serverPath
    : path.dirname(serverPath);
  const packagePath = path.join(startDir, 'package.json');
  const pkg = readJsonIfExists(packagePath, null);
  if (!pkg) return null;
  return {
    name: pkg.name || '',
    version: pkg.version || '',
    packagePath,
  };
}

function uniq(values) {
  return Array.from(new Set(values.filter((item) => item !== undefined && item !== null && String(item) !== '')));
}

function buildMcpSummary(homeDir = os.homedir()) {
  const configHomes = listCodexHomeConfigPaths(homeDir);
  const homes = configHomes.map((homeInfo) => {
    const text = readTextIfExists(homeInfo.configPath, '');
    const servers = parseMcpServersFromToml(text, homeInfo.configPath).map((server) => {
      const serverPath = inferMcpServerPath(server);
      const packageInfo = readPackageInfoForServer(serverPath);
      return {
        ...server,
        home: homeInfo.home,
        homeName: homeInfo.name,
        sourceFile: homeInfo.configPath,
        serverPath,
        exists: serverPath ? fs.existsSync(serverPath) : false,
        packageName: packageInfo?.name || '',
        packageVersion: packageInfo?.version || '',
        packagePath: packageInfo?.packagePath || '',
      };
    });
    return {
      home: homeInfo.home,
      name: homeInfo.name,
      configPath: homeInfo.configPath,
      servers,
    };
  });

  const grouped = new Map();
  for (const home of homes) {
    for (const server of home.servers) {
      if (!grouped.has(server.name)) grouped.set(server.name, []);
      grouped.get(server.name).push(server);
    }
  }

  const uniqueServers = Array.from(grouped.entries()).map(([name, servers]) => ({
    name,
    configuredHomes: servers.map((server) => server.homeName),
    configuredHomeCount: servers.length,
    commands: uniq(servers.map((server) => server.command)),
    args: uniq(servers.flatMap((server) => server.args || [])),
    envKeys: uniq(servers.flatMap((server) => server.envKeys || [])),
    serverPaths: uniq(servers.map((server) => server.serverPath)),
    packageNames: uniq(servers.map((server) => server.packageName)),
    packageVersions: uniq(servers.map((server) => server.packageVersion)),
    missingCount: servers.filter((server) => server.serverPath && !server.exists).length,
  })).sort((a, b) => a.name.localeCompare(b.name));

  return {
    homeDir,
    homeCount: homes.length,
    serverCount: homes.reduce((sum, home) => sum + home.servers.length, 0),
    uniqueServerCount: uniqueServers.length,
    homes,
    uniqueServers,
  };
}

function buildDashboardPayload() {
  const summary = runBridge('summary');
  const bridgeAccounts = Array.isArray(summary?.accounts) ? summary.accounts : [];
  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    repo: REPO_DIR,
    bridge: summary,
    chatlog: buildChatlogSummary(),
    chatlogThreads: buildChatlogConversationThreads(CHATLOG_DIR, { bridgeAccounts }),
    runtime: buildRuntimeSummary(),
    mcp: buildMcpSummary(),
  };
}

function renderDashboardHtml() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>SunCodexClaw 控制台</title>
  <style>
    :root {
      color-scheme: light;
      --app-bg: #f5f5f7;
      --app-bg-elevated: rgba(255, 255, 255, 0.9);
      --app-surface: #ffffff;
      --app-surface-elevated: rgba(255, 255, 255, 0.92);
      --app-text: rgba(29, 29, 31, 0.92);
      --app-text-secondary: rgba(29, 29, 31, 0.62);
      --app-text-tertiary: rgba(29, 29, 31, 0.42);
      --app-primary: #0071e3;
      --app-primary-hover: #0077ed;
      --app-primary-active: #005ecb;
      --app-secondary-bg: rgba(15, 23, 42, 0.05);
      --app-border: rgba(15, 23, 42, 0.08);
      --app-border-strong: rgba(15, 23, 42, 0.14);
      --app-shadow: 0 18px 50px rgba(15, 23, 42, 0.12);
      --app-bg-glow-1: rgba(0, 113, 227, 0.12);
      --app-bg-glow-2: rgba(15, 23, 42, 0.05);
      --success: #34c759;
      --warning: #ff9500;
      --danger: #ff3b30;
    }
    .dark {
      color-scheme: dark;
      --app-bg: #0b0b0f;
      --app-bg-elevated: rgba(22, 23, 29, 0.92);
      --app-surface: #16171d;
      --app-surface-elevated: rgba(22, 23, 29, 0.92);
      --app-text: rgba(255, 255, 255, 0.92);
      --app-text-secondary: rgba(255, 255, 255, 0.66);
      --app-text-tertiary: rgba(255, 255, 255, 0.45);
      --app-primary: #4f9cff;
      --app-primary-hover: #69a9ff;
      --app-primary-active: #2f7fe8;
      --app-secondary-bg: rgba(255, 255, 255, 0.08);
      --app-border: rgba(255, 255, 255, 0.1);
      --app-border-strong: rgba(255, 255, 255, 0.18);
      --app-shadow: 0 18px 50px rgba(0, 0, 0, 0.36);
      --app-bg-glow-1: rgba(79, 156, 255, 0.12);
      --app-bg-glow-2: rgba(255, 255, 255, 0.04);
    }
    [v-cloak] { display: none; }
    * { box-sizing: border-box; }
    html, body, #app { min-height: 100%; }
    body {
      margin: 0;
      color: var(--app-text);
      background: var(--app-bg);
      font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", "Helvetica Neue", sans-serif;
      text-rendering: optimizeLegibility;
      -webkit-font-smoothing: antialiased;
      -moz-osx-font-smoothing: grayscale;
    }
    button, input, textarea { font: inherit; }
    button { color: inherit; }
    .app {
      min-height: 100vh;
      background:
        radial-gradient(circle at 15% 5%, var(--app-bg-glow-1), transparent 360px),
        radial-gradient(circle at 92% 4%, var(--app-bg-glow-2), transparent 420px),
        var(--app-bg);
    }
    .app-shell {
      display: grid;
      grid-template-columns: 220px minmax(0, 1fr);
      min-height: 100vh;
    }
    .sidebar {
      position: sticky;
      top: 0;
      height: 100vh;
      padding: 22px 18px;
      border-right: 1px solid var(--app-border);
      background: var(--app-bg-elevated);
      backdrop-filter: blur(22px);
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 12px;
      margin-bottom: 28px;
      padding: 8px;
    }
    .brand-logo {
      width: 42px;
      height: 42px;
      border-radius: 14px;
      display: grid;
      place-items: center;
      color: #ffffff;
      font-weight: 800;
      background: linear-gradient(135deg, var(--app-primary), #7db7ff);
      box-shadow: 0 12px 24px rgba(0, 113, 227, 0.25);
    }
    .brand-title { font-size: 16px; font-weight: 700; letter-spacing: -0.02em; }
    .brand-subtitle { margin-top: 2px; color: var(--app-text-secondary); font-size: 12px; }
    .nav { display: grid; gap: 8px; }
    .nav-button {
      width: 100%;
      border: 0;
      border-radius: 14px;
      padding: 12px 13px;
      background: transparent;
      display: flex;
      align-items: center;
      justify-content: space-between;
      cursor: pointer;
      color: var(--app-text-secondary);
      transition: background 0.18s ease, color 0.18s ease;
    }
    .nav-button:hover, .nav-button.active {
      color: var(--app-text);
      background: var(--app-secondary-bg);
    }
    .nav-count {
      min-width: 24px;
      height: 22px;
      padding: 0 7px;
      border-radius: 999px;
      display: inline-grid;
      place-items: center;
      color: var(--app-primary);
      background: rgba(0, 113, 227, 0.1);
      font-size: 12px;
      font-weight: 700;
    }
    .sidebar-foot {
      position: absolute;
      left: 18px;
      right: 18px;
      bottom: 18px;
      padding: 14px;
      border: 1px solid var(--app-border);
      border-radius: 18px;
      color: var(--app-text-secondary);
      background: var(--app-surface-elevated);
      font-size: 12px;
      line-height: 1.55;
    }
    .main {
      min-width: 0;
      padding: 22px;
    }
    .topbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      margin-bottom: 18px;
    }
    .eyebrow {
      color: var(--app-primary);
      font-size: 13px;
      font-weight: 700;
      letter-spacing: 0.04em;
      text-transform: uppercase;
    }
    h1 {
      margin: 3px 0 0;
      font-size: clamp(26px, 3vw, 40px);
      line-height: 1.05;
      letter-spacing: -0.045em;
    }
    .topbar-actions {
      display: flex;
      align-items: center;
      gap: 10px;
      flex-wrap: wrap;
      justify-content: flex-end;
    }
    .button {
      border: 1px solid var(--app-border);
      border-radius: 999px;
      padding: 9px 14px;
      background: var(--app-surface-elevated);
      color: var(--app-text);
      cursor: pointer;
      transition: transform 0.16s ease, border-color 0.16s ease, background 0.16s ease;
    }
    .button:hover {
      transform: translateY(-1px);
      border-color: var(--app-border-strong);
      background: var(--app-secondary-bg);
    }
    .button.primary {
      border-color: transparent;
      background: var(--app-primary);
      color: #ffffff;
      font-weight: 700;
    }
    .button.danger {
      color: var(--danger);
      border-color: rgba(255, 59, 48, 0.22);
      background: rgba(255, 59, 48, 0.08);
    }
    .metrics {
      display: none;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 14px;
      margin-bottom: 16px;
    }
    .metric-card {
      padding: 17px;
      border: 1px solid var(--app-border);
      border-radius: 20px;
      background: var(--app-surface-elevated);
      box-shadow: var(--app-shadow);
    }
    .metric-label {
      color: var(--app-text-secondary);
      font-size: 12px;
    }
    .metric-value {
      margin-top: 8px;
      font-size: 30px;
      font-weight: 800;
      letter-spacing: -0.04em;
    }
    .metric-note {
      margin-top: 4px;
      color: var(--app-text-tertiary);
      font-size: 12px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .message-layout {
      display: grid;
      grid-template-columns: minmax(240px, 0.82fr) minmax(260px, 0.9fr) minmax(420px, 1.5fr) minmax(300px, 0.85fr);
      gap: 12px;
      min-height: 640px;
      height: calc(100vh - 104px);
    }
    .panel {
      min-width: 0;
      min-height: 0;
      border: 1px solid var(--app-border);
      border-radius: 24px;
      background: var(--app-surface);
      box-shadow: var(--app-shadow);
      overflow: hidden;
    }
    .chat-list-container {
      display: flex;
      flex-direction: column;
      height: 100%;
    }
    .thread-list-panel {
      display: flex;
      flex-direction: column;
      height: 100%;
      min-width: 0;
    }
    .list-header {
      padding: 22px 20px 14px;
      border-bottom: 1px solid var(--app-border);
    }
    .list-title-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
    }
    .list-title { font-size: 22px; font-weight: 800; letter-spacing: -0.03em; }
    .list-subtitle { margin-top: 5px; color: var(--app-text-secondary); font-size: 13px; }
    .list-tabs {
      display: flex;
      gap: 8px;
      margin-top: 16px;
    }
    .list-tab {
      border: 0;
      border-radius: 999px;
      padding: 7px 11px;
      color: var(--app-text-secondary);
      background: var(--app-secondary-bg);
      cursor: pointer;
      font-size: 13px;
    }
    .list-tab.active {
      color: var(--app-primary);
      background: rgba(0, 113, 227, 0.1);
      font-weight: 700;
    }
    .search-box {
      margin-top: 14px;
      height: 38px;
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 0 12px;
      border-radius: 12px;
      color: var(--app-text-tertiary);
      background: var(--app-secondary-bg);
    }
    .search-box input {
      min-width: 0;
      flex: 1;
      border: 0;
      outline: 0;
      color: var(--app-text);
      background: transparent;
    }
    .chat-list {
      flex: 1;
      min-height: 0;
      overflow: auto;
      padding: 8px 0;
    }
    .chat-list-item {
      width: 100%;
      border: 0;
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 12px 16px;
      cursor: pointer;
      text-align: left;
      color: var(--app-text);
      background: transparent;
      transition: background 0.18s ease;
    }
    .chat-list-item:hover, .chat-list-item.active {
      background: var(--app-secondary-bg);
    }
    .thread-list {
      flex: 1;
      min-height: 0;
      overflow: auto;
      padding: 8px;
      display: grid;
      align-content: start;
      gap: 6px;
    }
    .thread-list-item {
      width: 100%;
      border: 0;
      border-radius: 14px;
      padding: 11px 12px;
      color: var(--app-text-secondary);
      background: transparent;
      cursor: pointer;
      text-align: left;
      display: grid;
      gap: 5px;
      min-width: 0;
      transition: background 0.18s ease, color 0.18s ease;
    }
    .thread-list-item:hover,
    .thread-list-item.active {
      color: var(--app-text);
      background: var(--app-secondary-bg);
    }
    .thread-list-item.active {
      box-shadow: inset 3px 0 0 var(--app-primary);
    }
    .thread-title-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      min-width: 0;
    }
    .thread-title {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: var(--app-text);
      font-size: 14px;
      font-weight: 800;
    }
    .thread-time {
      flex: 0 0 auto;
      color: var(--app-text-tertiary);
      font-size: 11px;
    }
    .thread-line {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: var(--app-text-secondary);
      font-size: 12px;
      line-height: 1.35;
    }
    .thread-badge {
      display: inline-flex;
      align-items: center;
      width: fit-content;
      max-width: 100%;
      padding: 3px 7px;
      border-radius: 999px;
      color: var(--app-primary);
      background: rgba(0, 113, 227, 0.08);
      font-size: 11px;
      font-weight: 800;
    }
    .avatar-wrapper {
      position: relative;
      flex: 0 0 auto;
    }
    .avatar {
      width: 56px;
      height: 56px;
      border-radius: 14px;
      display: grid;
      place-items: center;
      color: #ffffff;
      font-weight: 800;
      background: linear-gradient(135deg, var(--app-primary), #84c1ff);
      overflow: hidden;
    }
    .unread-badge {
      position: absolute;
      top: -2px;
      right: -2px;
      width: 12px;
      height: 12px;
      border: 2px solid var(--app-surface);
      border-radius: 50%;
      background: #007aff;
      box-shadow: 0 2px 4px rgba(0, 122, 255, 0.4);
    }
    .content-container {
      min-width: 0;
      flex: 1;
      display: grid;
      gap: 4px;
    }
    .first-row, .second-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      min-width: 0;
    }
    .user-name {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-size: 16px;
      font-weight: 500;
    }
    .time-text {
      flex: 0 0 auto;
      color: var(--app-text-secondary);
      font-size: 13px;
    }
    .message-preview {
      min-width: 0;
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: var(--app-text-secondary);
      font-size: 14px;
      line-height: 1.4;
    }
    .message-type-tag {
      display: inline-flex;
      align-items: center;
      margin-right: 6px;
      padding: 2px 6px;
      border-radius: 6px;
      background: rgba(0, 122, 255, 0.1);
      color: var(--app-primary);
      font-size: 12px;
      font-weight: 700;
      vertical-align: middle;
    }
    .chat-window {
      display: flex;
      flex-direction: column;
      min-width: 0;
    }
    .chat-window-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      padding: 20px 22px;
      border-bottom: 1px solid var(--app-border);
      background: var(--app-surface-elevated);
    }
    .detail-title { font-size: 21px; font-weight: 800; letter-spacing: -0.03em; }
    .detail-subtitle {
      margin-top: 4px;
      color: var(--app-text-secondary);
      font-size: 13px;
    }
    .status-pill {
      display: inline-flex;
      align-items: center;
      gap: 7px;
      padding: 7px 11px;
      border-radius: 999px;
      background: var(--app-secondary-bg);
      color: var(--app-text-secondary);
      font-size: 13px;
      font-weight: 700;
    }
    .status-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--app-text-tertiary);
    }
    .status-dot.running { background: var(--success); }
    .status-dot.warning { background: var(--warning); }
    .status-dot.stopped, .status-dot.error { background: var(--danger); }
    .chat-body {
      flex: 1;
      min-height: 0;
      overflow: auto;
      padding: 22px;
      display: flex;
      gap: 16px;
      background:
        linear-gradient(var(--app-bg), var(--app-bg)) padding-box,
        var(--app-bg);
    }
    .bubble {
      max-width: none;
      width: 100%;
      border: 1px solid var(--app-border);
      border-radius: 20px;
      padding: 16px;
      background: var(--app-surface-elevated);
    }
    .bubble-title {
      margin-bottom: 8px;
      font-weight: 800;
      letter-spacing: -0.02em;
    }
    .bubble-text {
      color: var(--app-text-secondary);
      line-height: 1.65;
      word-break: break-word;
    }
    .dashboard-chat {
      display: grid;
      grid-template-rows: auto auto minmax(0, 1fr) auto;
      gap: 12px;
      min-height: 0;
    }
    .conversation {
      min-height: 0;
      max-height: none;
      overflow: auto;
      display: grid;
      align-content: start;
      gap: 10px;
      padding: 12px;
      border: 1px solid var(--app-border);
      border-radius: 18px;
      background: var(--app-bg);
    }
    .message-row {
      display: flex;
    }
    .message-row.user {
      justify-content: flex-end;
    }
    .message-row.assistant {
      justify-content: flex-start;
    }
    .message-row.progress,
    .message-row.error-row {
      justify-content: flex-start;
    }
    .message-bubble {
      max-width: min(84%, 620px);
      border: 1px solid var(--app-border);
      border-radius: 18px;
      padding: 11px 13px;
      color: var(--app-text);
      background: var(--app-surface-elevated);
      white-space: pre-wrap;
      word-break: break-word;
      line-height: 1.58;
    }
    .message-row.user .message-bubble {
      color: #ffffff;
      background: var(--app-primary);
      border-color: transparent;
    }
    .message-row.progress .message-bubble {
      max-width: min(92%, 680px);
      border-style: dashed;
      color: var(--app-text-secondary);
      background: rgba(0, 113, 227, 0.07);
      font-size: 13px;
    }
    .message-row.error-row .message-bubble {
      max-width: min(92%, 680px);
      border-color: rgba(255, 59, 48, 0.22);
      color: var(--danger);
      background: rgba(255, 59, 48, 0.08);
      font-size: 13px;
    }
    .composer {
      display: grid;
      gap: 10px;
    }
    .composer textarea {
      width: 100%;
      min-height: 92px;
      resize: vertical;
      border: 1px solid var(--app-border);
      border-radius: 18px;
      padding: 13px 14px;
      color: var(--app-text);
      background: var(--app-surface);
      outline: none;
      line-height: 1.55;
    }
    .composer textarea:focus {
      border-color: rgba(0, 113, 227, 0.42);
      box-shadow: 0 0 0 4px rgba(0, 113, 227, 0.1);
    }
    .composer-footer {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      color: var(--app-text-tertiary);
      font-size: 12px;
    }
    .thread-select-row {
      max-height: 190px;
      overflow: auto;
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      gap: 8px;
    }
    .thread-chip {
      border: 1px solid var(--app-border);
      border-radius: 16px;
      padding: 10px 11px;
      color: var(--app-text-secondary);
      background: var(--app-surface-elevated);
      cursor: pointer;
      font-size: 12px;
      text-align: left;
      display: grid;
      gap: 4px;
      min-width: 0;
    }
    .thread-chip.active {
      color: var(--app-primary);
      border-color: rgba(0, 113, 227, 0.24);
      background: rgba(0, 113, 227, 0.08);
      font-weight: 800;
    }
    .thread-chip-main {
      color: var(--app-text);
      font-size: 13px;
      font-weight: 800;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .thread-chip-meta,
    .thread-chip-preview,
    .thread-meta,
    .message-meta {
      color: var(--app-text-tertiary);
      font-size: 11px;
      font-weight: 500;
    }
    .thread-chip-preview {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .thread-meta {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 8px;
      padding: 9px 11px;
      border: 1px solid var(--app-border);
      border-radius: 14px;
      background: var(--app-secondary-bg);
    }
    .message-meta {
      margin-bottom: 5px;
    }
    .message-row.user .message-meta {
      color: rgba(255, 255, 255, 0.78);
    }
    .message-text {
      white-space: pre-wrap;
    }
    .detail-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 12px;
    }
    .info-card {
      border: 1px solid var(--app-border);
      border-radius: 18px;
      padding: 14px;
      background: var(--app-surface-elevated);
      min-width: 0;
    }
    .info-label {
      color: var(--app-text-secondary);
      font-size: 12px;
      margin-bottom: 8px;
    }
    .info-value {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-weight: 700;
    }
    .actions-row {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
    }
    .timeline {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
    }
    .day-chip {
      padding: 7px 10px;
      border-radius: 999px;
      color: var(--app-primary);
      background: rgba(0, 113, 227, 0.08);
      font-size: 12px;
      font-weight: 700;
    }
    .right-panel {
      display: flex;
      flex-direction: column;
      min-width: 0;
      min-height: 0;
    }
    .right-scroll {
      flex: 1;
      min-width: 0;
      min-height: 0;
      overflow-x: hidden;
      overflow-y: auto;
      padding: 18px;
      display: grid;
      align-content: start;
      gap: 12px;
    }
    .section-title {
      padding: 20px 20px 0;
      font-size: 20px;
      font-weight: 800;
      letter-spacing: -0.03em;
    }
    .section-note {
      padding: 4px 20px 14px;
      color: var(--app-text-secondary);
      font-size: 13px;
      border-bottom: 1px solid var(--app-border);
    }
    .mcp-card {
      min-width: 0;
      max-width: 100%;
      border: 1px solid var(--app-border);
      border-radius: 18px;
      padding: 14px;
      background: var(--app-surface-elevated);
    }
    .mcp-head {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 10px;
      margin-bottom: 9px;
    }
    .mcp-head > div {
      min-width: 0;
    }
    .mcp-name { font-weight: 800; }
    .mcp-count {
      flex: 0 0 auto;
      border-radius: 999px;
      padding: 4px 8px;
      color: var(--app-primary);
      background: rgba(0, 113, 227, 0.1);
      font-size: 12px;
      font-weight: 800;
    }
    .path-line {
      min-width: 0;
      max-width: 100%;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: var(--app-text-secondary);
      font-family: "SF Mono", ui-monospace, Menlo, Consolas, monospace;
      font-size: 12px;
      line-height: 1.6;
    }
    .tag-list {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin-top: 10px;
    }
    .tag {
      border-radius: 999px;
      padding: 4px 8px;
      color: var(--app-text-secondary);
      background: var(--app-secondary-bg);
      font-size: 12px;
    }
    .empty {
      padding: 18px;
      color: var(--app-text-secondary);
      text-align: center;
    }
    .error {
      margin-bottom: 14px;
      border: 1px solid rgba(255, 59, 48, 0.24);
      border-radius: 16px;
      padding: 12px 14px;
      color: var(--danger);
      background: rgba(255, 59, 48, 0.08);
    }
    pre {
      margin: 0;
      max-height: 260px;
      overflow: auto;
      white-space: pre-wrap;
      word-break: break-word;
      color: var(--app-text-secondary);
      font-family: "SF Mono", ui-monospace, Menlo, Consolas, monospace;
      font-size: 12px;
      line-height: 1.6;
    }
    @media (max-width: 1180px) {
      .app-shell { grid-template-columns: 1fr; }
      .sidebar {
        position: relative;
        height: auto;
        border-right: 0;
        border-bottom: 1px solid var(--app-border);
      }
      .sidebar-foot { position: static; margin-top: 18px; }
      .message-layout {
        grid-template-columns: minmax(250px, 0.8fr) minmax(280px, 0.9fr) minmax(0, 1.25fr);
        height: auto;
      }
      .right-panel { grid-column: 1 / -1; }
    }
    @media (max-width: 1500px) and (min-width: 1181px) {
      .message-layout {
        grid-template-columns: minmax(250px, 0.85fr) minmax(280px, 0.95fr) minmax(0, 1.35fr);
      }
      .right-panel { grid-column: 1 / -1; min-height: 320px; }
    }
    @media (max-width: 760px) {
      .main { padding: 16px; }
      .topbar { align-items: flex-start; flex-direction: column; }
      .metrics { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .message-layout { grid-template-columns: 1fr; }
      .detail-grid { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <div id="app" class="app" :class="{ dark: theme === 'dark' }" v-cloak>
    <div class="app-shell">
      <aside class="sidebar">
        <div class="brand">
          <div class="brand-logo">SC</div>
          <div>
            <div class="brand-title">SunCodexClaw</div>
            <div class="brand-subtitle">本地机器人后台</div>
          </div>
        </div>
        <nav class="nav">
          <button type="button" class="nav-button active">
            <span>机器人</span>
            <span class="nav-count">{{ accounts.length }}</span>
          </button>
        </nav>
        <div class="sidebar-foot">
          <strong>后台对话</strong><br>
          选中机器人后直接聊天。执行过程会写进对话流，店铺任务仍走 MCP-first。
        </div>
      </aside>

      <main class="main">
        <header class="topbar">
          <div>
            <div class="eyebrow">Agent Gateway · Vue Console</div>
            <h1>SunCodexClaw 控制台</h1>
          </div>
          <div class="topbar-actions">
            <button type="button" class="button" @click="toggleTheme">{{ theme === 'dark' ? '浅色' : '深色' }}</button>
            <button type="button" class="button primary" @click="load(true)" :disabled="loading">{{ loading ? '刷新中...' : '刷新状态' }}</button>
          </div>
        </header>

        <div v-if="lastError" class="error">{{ lastError }}</div>

        <section class="message-layout">
          <aside class="panel chat-list-container">
            <div class="list-header">
              <div class="list-title-row">
                <div class="list-title">机器人私信</div>
                <span class="status-pill"><span class="status-dot running"></span>本机</span>
              </div>
              <div class="list-subtitle">按站内信样式整理，每个机器人像一条会话。</div>
              <div class="list-tabs">
                <button type="button" class="list-tab" :class="{ active: filter === 'all' }" @click="filter = 'all'">全部</button>
                <button type="button" class="list-tab" :class="{ active: filter === 'warn' }" @click="filter = 'warn'">异常</button>
                <button type="button" class="list-tab" :class="{ active: filter === 'running' }" @click="filter = 'running'">运行中</button>
              </div>
              <label class="search-box">
                <span>搜索</span>
                <input v-model.trim="query" placeholder="机器人名 / account">
              </label>
            </div>
            <div class="chat-list">
              <button
                v-for="bot in filteredAccounts"
                :key="bot.account"
                type="button"
                class="chat-list-item"
                :class="{ active: selectedAccount === bot.account }"
                @click="selectAccount(bot.account)"
              >
                <div class="avatar-wrapper">
                  <div class="avatar">{{ avatarText(bot) }}</div>
                  <span v-if="needsAttention(bot)" class="unread-badge"></span>
                </div>
                <div class="content-container">
                  <div class="first-row">
                    <span class="user-name">{{ bot.displayName || bot.account }}</span>
                    <span class="time-text">{{ stateLabel(bot.status && bot.status.state) }}</span>
                  </div>
                  <div class="second-row">
                    <span class="message-preview">
                      <span class="message-type-tag">{{ bot.activity && bot.activity.state ? bot.activity.state : 'idle' }}</span>
                      {{ bot.activity && bot.activity.label ? bot.activity.label : '等待新消息' }}
                    </span>
                  </div>
                </div>
              </button>
              <div v-if="filteredAccounts.length === 0" class="empty">没有匹配的机器人。</div>
            </div>
          </aside>

          <aside class="panel thread-list-panel">
            <div class="list-header">
              <div class="list-title-row">
                <div class="list-title">机器人线程</div>
                <span class="status-pill">{{ accountThreads.length }} 个</span>
              </div>
              <div class="list-subtitle">{{ selectedBot.displayName || selectedBot.account || '未选择机器人' }} 的后台线程和飞书会话。</div>
              <label class="search-box">
                <span>搜索</span>
                <input v-model.trim="threadQuery" placeholder="发起人 / 平台 / 内容">
              </label>
            </div>
            <div class="thread-list">
              <button
                v-for="thread in filteredAccountThreads"
                :key="thread.id"
                type="button"
                class="thread-list-item"
                :class="{ active: selectedThread && selectedThread.id === thread.id }"
                @click="selectedThreadId = thread.id"
              >
                <div class="thread-title-row">
                  <span class="thread-title">{{ threadTitle(thread) }}</span>
                  <span class="thread-time">{{ formatTime(thread.updatedAt || thread.createdAt || thread.startedAt) }}</span>
                </div>
                <span class="thread-badge">{{ platformLabel(thread) }} · {{ isWritableThread(thread) ? '后台' : '飞书' }}</span>
                <div class="thread-line">发起：{{ initiatorLabel(thread) }} · 开始：{{ formatTime(thread.startedAt || thread.createdAt) }}</div>
                <div class="thread-line">{{ lastMessagePreview(thread) }}</div>
              </button>
              <div v-if="filteredAccountThreads.length === 0" class="empty">这个机器人还没有匹配的线程。</div>
            </div>
          </aside>

          <section class="panel chat-window">
            <div class="chat-window-header">
              <div>
                <div class="detail-title">{{ selectedThread ? threadTitle(selectedThread) : (selectedBot.displayName || selectedBot.account || '未选择线程') }}</div>
                <div class="detail-subtitle">{{ selectedBot.account || '-' }} · {{ platformLabel(selectedThread) }} · {{ shortPath(selectedBot.boot && selectedBot.boot.codexCwd) }}</div>
              </div>
              <span class="status-pill">
                <span class="status-dot" :class="statusClass(selectedBot)"></span>
                {{ selectedBot.activity && selectedBot.activity.label ? selectedBot.activity.label : stateLabel(selectedBot.status && selectedBot.status.state) }}
              </span>
            </div>
            <div class="chat-body">
              <article class="bubble dashboard-chat">
                <div>
                  <div class="bubble-title">对话</div>
                  <div class="bubble-text">右侧只显示当前线程内容；线程列表单独在左侧滚动。飞书历史先只读展示，后台发送默认不刷飞书。</div>
                </div>
                <div v-if="selectedThread" class="thread-meta">
                  <span>{{ platformLabel(selectedThread) }}</span>
                  <span>发起：{{ initiatorLabel(selectedThread) }}</span>
                  <span>开始：{{ formatTime(selectedThread.startedAt || selectedThread.createdAt) }}</span>
                  <span>{{ isWritableThread(selectedThread) ? '后台可执行' : '飞书历史只读' }}</span>
                </div>
                <div class="conversation">
                  <div v-if="threadLoading" class="empty">正在读取后台对话...</div>
                  <div v-else-if="!threadHistory.length" class="empty">还没有对话。你可以直接问它“你现在能帮我什么？”</div>
                  <div
                    v-for="(message, index) in threadHistory"
                    :key="index"
                    class="message-row"
                    :class="messageClass(message)"
                  >
                    <div class="message-bubble">
                      <div class="message-meta">{{ messageHeader(message) }}</div>
                      <div class="message-text">{{ message.text }}</div>
                    </div>
                  </div>
                </div>
                <form class="composer" @submit.prevent="sendDashboardMessage">
                  <textarea
                    v-model="threadInput"
                    placeholder="在后台和这个机器人说话。按 ⌘/Ctrl + Enter 发送。"
                    :disabled="sending || !selectedBot.account"
                    @keydown.meta.enter.prevent="sendDashboardMessage"
                    @keydown.ctrl.enter.prevent="sendDashboardMessage"
                  ></textarea>
                  <div class="composer-footer">
                    <span>{{ composerHint }}</span>
                    <button type="submit" class="button primary" :disabled="sending || !threadInput.trim() || !selectedBot.account">
                      {{ sending ? '机器人思考中...' : '发送给机器人' }}
                    </button>
                  </div>
                </form>
              </article>
            </div>
          </section>

          <aside class="panel right-panel">
            <div class="section-title">当前机器人</div>
            <div class="section-note">{{ selectedBot.displayName || selectedBot.account || '未选择机器人' }}</div>
            <div class="right-scroll">
              <article class="mcp-card">
                <div class="mcp-head">
                  <div>
                    <div class="mcp-name">状态</div>
                    <div class="path-line">{{ selectedBot.activity && selectedBot.activity.label ? selectedBot.activity.label : stateLabel(selectedBot.status && selectedBot.status.state) }}</div>
                  </div>
                  <span class="mcp-count">{{ stateLabel(selectedBot.status && selectedBot.status.state) }}</span>
                </div>
                <div class="path-line" v-if="selectedBot.activity && selectedBot.activity.detail">{{ selectedBot.activity.detail }}</div>
              </article>

              <article class="mcp-card">
                <div class="mcp-head">
                  <div>
                    <div class="mcp-name">Codex</div>
                    <div class="path-line">{{ selectedBot.boot && selectedBot.boot.codexModel ? selectedBot.boot.codexModel : '(default)' }}</div>
                  </div>
                  <span class="mcp-count">{{ selectedBot.boot && selectedBot.boot.progressMode ? selectedBot.boot.progressMode : 'doc' }}</span>
                </div>
                <div class="path-line">{{ shortPath(selectedBot.boot && selectedBot.boot.codexCwd) }}</div>
              </article>

              <article class="mcp-card">
                <div class="mcp-name">可用 MCP</div>
                <div v-if="accountMcpServers.length" class="tag-list">
                  <span v-for="server in accountMcpServers" :key="server.name" class="tag">{{ server.name }}</span>
                </div>
                <div v-else class="path-line">这个机器人暂无 MCP 配置。</div>
              </article>

              <article class="mcp-card">
                <div class="mcp-name">操作</div>
                <div class="actions-row" style="margin-top: 10px;">
                  <button type="button" class="button primary" @click="postAction(selectedBot.account, 'restart')" :disabled="!selectedBot.account || actioning">重启</button>
                  <button type="button" class="button" @click="postAction(selectedBot.account, 'start')" :disabled="!selectedBot.account || actioning">启动</button>
                  <button type="button" class="button danger" @click="postAction(selectedBot.account, 'stop')" :disabled="!selectedBot.account || actioning">停止</button>
                </div>
              </article>

              <details class="mcp-card">
                <summary class="mcp-name">全部 MCP 配置</summary>
                <div class="path-line" style="margin-top: 10px;">调试 API：/api/mcp</div>
                <div v-for="server in mcp.uniqueServers || []" :key="server.name" style="margin-top: 12px;">
                  <div class="mcp-head">
                    <div>
                      <div class="mcp-name">{{ server.name }}</div>
                      <div class="path-line" v-if="server.packageNames && server.packageNames.length">{{ server.packageNames.join(', ') }} {{ server.packageVersions.join(', ') }}</div>
                    </div>
                    <span class="mcp-count">{{ server.configuredHomeCount }} homes</span>
                  </div>
                  <div v-for="serverPath in server.serverPaths" :key="serverPath" class="path-line">{{ serverPath }}</div>
                </div>
              </details>

              <details class="mcp-card">
                <summary class="mcp-name">调试摘要</summary>
                <pre style="margin-top: 12px;">{{ rawSummary }}</pre>
              </details>
            </div>
          </aside>
        </section>
      </main>
    </div>
  </div>

  <script src="https://unpkg.com/vue@3/dist/vue.global.prod.js"></script>
  <script>
    if (!window.Vue) {
      document.write('<script src="https://cdn.jsdelivr.net/npm/vue@3/dist/vue.global.prod.js"><\\/script>');
    }
  </script>
  <script>
    (function () {
      function emptyData() {
        return {
          bridge: { accounts: [] },
          chatlog: { botCount: 0, bots: [] },
          chatlogThreads: { totalThreads: 0, accounts: {}, bots: [] },
          runtime: { approval: {} },
          mcp: { uniqueServers: [], homes: [] }
        };
      }

      function createDashboardApp() {
        return {
          data: function () {
            return {
              data: emptyData(),
              selectedAccount: '',
              selectedThreadId: '',
              threadsByAccount: {},
              threadInput: '',
              threadQuery: '',
              filter: 'all',
              query: '',
              loading: false,
              actioning: false,
              threadLoading: false,
              sending: false,
              lastError: '',
              theme: window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
            };
          },
          computed: {
            accounts: function () {
              return Array.isArray(this.data.bridge && this.data.bridge.accounts) ? this.data.bridge.accounts : [];
            },
            chatlog: function () {
              return this.data.chatlog || { botCount: 0, bots: [] };
            },
            chatlogThreads: function () {
              return this.data.chatlogThreads || { totalThreads: 0, accounts: {}, bots: [] };
            },
            runtime: function () {
              return this.data.runtime || {};
            },
            approval: function () {
              return (this.runtime && this.runtime.approval) || {};
            },
            mcp: function () {
              return this.data.mcp || { uniqueServers: [], homes: [] };
            },
            runningCount: function () {
              return this.accounts.filter(function (bot) {
                return bot.status && bot.status.state === 'running';
              }).length;
            },
            filteredAccounts: function () {
              var q = String(this.query || '').toLowerCase();
              var filter = this.filter;
              return this.accounts.filter(function (bot) {
                var haystack = String((bot.displayName || '') + ' ' + (bot.account || '')).toLowerCase();
                if (q && haystack.indexOf(q) === -1) return false;
                if (filter === 'running') return bot.status && bot.status.state === 'running';
                if (filter === 'warn') {
                  var activityState = bot.activity && bot.activity.state;
                  var statusState = bot.status && bot.status.state;
                  return statusState !== 'running' || (activityState && activityState !== 'idle');
                }
                return true;
              });
            },
            selectedBot: function () {
              var selected = this.selectedAccount;
              return this.accounts.find(function (bot) { return bot.account === selected; }) || this.accounts[0] || {};
            },
            selectedChatlog: function () {
              var bot = this.selectedBot || {};
              var bots = Array.isArray(this.chatlog.bots) ? this.chatlog.bots : [];
              var keys = [bot.displayName, bot.account].filter(Boolean).map(String);
              return bots.find(function (item) {
                return keys.some(function (key) {
                  return String(item.botName || '').indexOf(key) >= 0 || key.indexOf(String(item.botName || '')) >= 0;
                });
              }) || bots[0] || null;
            },
            accountMcpServers: function () {
              var account = this.selectedBot && this.selectedBot.account;
              if (!account || !Array.isArray(this.mcp.homes)) return [];
              var expectedHome = '.codex-' + account;
              var home = this.mcp.homes.find(function (item) { return item.name === expectedHome; });
              return home && Array.isArray(home.servers) ? home.servers : [];
            },
            accountThreadEnvelope: function () {
              var account = this.selectedBot && this.selectedBot.account;
              return (account && this.threadsByAccount[account]) || { threads: [] };
            },
            accountChatlogThreads: function () {
              var account = this.selectedBot && this.selectedBot.account;
              var grouped = this.chatlogThreads && this.chatlogThreads.accounts;
              return account && grouped && Array.isArray(grouped[account]) ? grouped[account] : [];
            },
            accountThreads: function () {
              var studioThreads = Array.isArray(this.accountThreadEnvelope.threads) ? this.accountThreadEnvelope.threads : [];
              var normalizedStudio = studioThreads.map((thread) => {
                var history = Array.isArray(thread.history) ? thread.history : [];
                var last = history.slice().reverse().find((item) => item && item.text);
                return Object.assign({}, thread, {
                  source: 'studio',
                  platform: 'dashboard',
                  platformLabel: '后台',
                  title: thread.name || '后台线程',
                  initiator: '后台',
                  startedAt: thread.createdAt || thread.created_at || '',
                  updatedAt: thread.updatedAt || thread.updated_at || '',
                  preview: thread.lastReplyPreview || (last && last.text) || '',
                });
              });
              var feishuThreads = this.accountChatlogThreads.map((thread) => Object.assign({
                source: 'feishu_chatlog',
                platform: 'feishu',
                platformLabel: '飞书',
              }, thread));
              return normalizedStudio.concat(feishuThreads).sort((a, b) => {
                return this.timeValue(b.updatedAt || b.createdAt || b.startedAt) - this.timeValue(a.updatedAt || a.createdAt || a.startedAt);
              });
            },
            filteredAccountThreads: function () {
              var q = String(this.threadQuery || '').toLowerCase();
              if (!q) return this.accountThreads;
              return this.accountThreads.filter((thread) => {
                var haystack = [
                  this.threadTitle(thread),
                  this.threadMeta(thread),
                  this.lastMessagePreview(thread),
                  thread.id,
                  thread.chatId,
                  thread.chatScope,
                ].join(' ').toLowerCase();
                return haystack.indexOf(q) >= 0;
              });
            },
            selectedThread: function () {
              var selected = this.selectedThreadId;
              var selectedThread = this.accountThreads.find(function (thread) { return thread.id === selected; });
              if (selectedThread && (!this.threadQuery || this.filteredAccountThreads.some(function (thread) { return thread.id === selectedThread.id; }))) {
                return selectedThread;
              }
              return this.filteredAccountThreads[0] || this.accountThreads[0] || null;
            },
            threadHistory: function () {
              return this.selectedThread && Array.isArray(this.selectedThread.history) ? this.selectedThread.history : [];
            },
            composerHint: function () {
              if (!this.selectedBot || !this.selectedBot.account) return '先选择一个机器人';
              if (!this.selectedThread) return '会自动创建后台线程';
              if (!this.isWritableThread(this.selectedThread)) return '当前查看飞书历史；发送会新建后台线程，不会刷飞书';
              return '后台线程 ' + this.selectedThread.id + ' · 默认只回后台';
            },
            rawSummary: function () {
              return JSON.stringify({
                generatedAt: this.data.generatedAt,
                repo: this.data.repo,
                chatlogThreads: {
                  totalThreads: this.chatlogThreads.totalThreads,
                  totalMessages: this.chatlogThreads.totalMessages
                },
                runtime: this.data.runtime,
                mcp: {
                  homeCount: this.mcp.homeCount,
                  uniqueServerCount: this.mcp.uniqueServerCount,
                  serverCount: this.mcp.serverCount
                }
              }, null, 2);
            }
          },
          methods: {
            load: async function (manual) {
              this.loading = true;
              this.lastError = '';
              try {
                var res = await fetch('/api/summary', { cache: 'no-store' });
                if (!res.ok) throw new Error('HTTP ' + res.status);
                this.data = await res.json();
                if (!this.selectedAccount && this.accounts.length) this.selectedAccount = this.accounts[0].account;
                if (this.selectedAccount && !this.accounts.some((bot) => bot.account === this.selectedAccount) && this.accounts.length) {
                  this.selectedAccount = this.accounts[0].account;
                }
                if (manual && this.selectedAccount) this.loadThreads(this.selectedAccount, true);
              } catch (err) {
                this.lastError = '读取后台状态失败：' + (err && err.message ? err.message : String(err));
              } finally {
                this.loading = false;
              }
            },
            selectAccount: function (account) {
              this.selectedAccount = account;
              this.selectedThreadId = '';
              this.threadQuery = '';
              this.loadThreads(account, false);
            },
            setThreadEnvelope: function (account, payload) {
              var next = Object.assign({}, this.threadsByAccount);
              next[account] = payload || { threads: [] };
              this.threadsByAccount = next;
              if (payload && payload.thread && payload.thread.id) {
                this.selectedThreadId = payload.thread.id;
              } else if (this.selectedThreadId && !this.accountThreads.some((thread) => thread.id === this.selectedThreadId)) {
                this.selectedThreadId = '';
              }
            },
            loadThreads: async function (account, silent) {
              if (!account) return;
              if (!silent) this.threadLoading = true;
              try {
                var res = await fetch('/api/threads/' + encodeURIComponent(account), { cache: 'no-store' });
                var payload = await res.json();
                if (!res.ok || payload.ok === false) throw new Error(payload.error || 'threads failed');
                this.setThreadEnvelope(account, payload);
              } catch (err) {
                this.lastError = '读取后台对话失败：' + (err && err.message ? err.message : String(err));
              } finally {
                if (!silent) this.threadLoading = false;
              }
            },
            ensureDashboardThread: async function () {
              var account = this.selectedBot && this.selectedBot.account;
              if (!account) throw new Error('未选择机器人');
              if (this.selectedThread && this.isWritableThread(this.selectedThread)) {
                this.selectedThreadId = this.selectedThread.id;
                return this.selectedThread;
              }
              var displayName = this.selectedBot.displayName || account;
              var selectedTitle = this.selectedThread ? this.threadTitle(this.selectedThread) : '';
              var res = await fetch('/api/threads/' + encodeURIComponent(account), {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                  name: selectedTitle ? ('后台接续 · ' + selectedTitle).slice(0, 60) : '后台对话',
                  chat_id: 'dashboard:' + account,
                  chat_type: 'dashboard',
                  chat_label: 'SunCodexClaw 后台 · ' + displayName
                })
              });
              var payload = await res.json();
              if (!res.ok || payload.ok === false) throw new Error(payload.error || 'thread-create failed');
              this.setThreadEnvelope(account, payload);
              return payload.thread;
            },
            sendDashboardMessage: async function () {
              var account = this.selectedBot && this.selectedBot.account;
              var text = String(this.threadInput || '').trim();
              if (!account || !text || this.sending) return;
              this.sending = true;
              this.lastError = '';
              try {
                var thread = await this.ensureDashboardThread();
                if (!thread || !thread.id) throw new Error('后台线程创建失败');
                this.threadInput = '';
                if (this.selectedThread && Array.isArray(this.selectedThread.history)) {
                  this.selectedThread.history.push({ role: 'user', text: text, at: new Date().toISOString(), senderName: '后台' });
                  this.selectedThread.history.push({ role: 'progress', text: '已发送到后台，等待机器人开始执行', at: new Date().toISOString(), senderName: '系统' });
                }
                var res = await fetch('/api/thread/' + encodeURIComponent(account) + '/' + encodeURIComponent(thread.id) + '/send', {
                  method: 'POST',
                  headers: { 'content-type': 'application/json' },
                  body: JSON.stringify({ text: text, deliver: 'dashboard' })
                });
                var payload = await res.json();
                if (!res.ok || payload.ok === false) throw new Error(payload.error || 'thread-send failed');
                this.setThreadEnvelope(account, payload);
              } catch (err) {
                this.lastError = '后台发送失败：' + (err && err.message ? err.message : String(err));
                if (!this.threadInput) this.threadInput = text;
              } finally {
                this.sending = false;
              }
            },
            messageClass: function (message) {
              var role = String(message && message.role || '').trim();
              if (role === 'user') return 'user';
              if (role === 'progress' || role === 'system') return 'progress';
              if (role === 'error') return 'error-row';
              return 'assistant';
            },
            isWritableThread: function (thread) {
              var source = String(thread && thread.source || 'studio');
              return source === 'studio' || source === 'dashboard' || source === 'backend';
            },
            timeValue: function (value) {
              var ts = Date.parse(String(value || ''));
              return Number.isFinite(ts) ? ts : 0;
            },
            formatTime: function (value) {
              var ts = this.timeValue(value);
              if (!ts) return '-';
              try {
                return new Intl.DateTimeFormat('zh-CN', {
                  month: '2-digit',
                  day: '2-digit',
                  hour: '2-digit',
                  minute: '2-digit',
                }).format(new Date(ts));
              } catch (_) {
                return String(value || '').slice(0, 16);
              }
            },
            compactText: function (value, maxLength) {
              var text = String(value || '').replace(/\s+/g, ' ').trim();
              var limit = maxLength || 90;
              return text.length > limit ? text.slice(0, limit - 1) + '…' : text;
            },
            platformLabel: function (thread) {
              return String((thread && (thread.platformLabel || thread.platform)) || '后台');
            },
            initiatorLabel: function (thread) {
              return String((thread && (thread.initiator || thread.initiatorId)) || '后台');
            },
            threadTitle: function (thread) {
              if (!thread) return '未选择线程';
              return String(thread.title || thread.name || thread.id || '线程');
            },
            threadMeta: function (thread) {
              if (!thread) return '';
              var count = Number(thread.messageCount || thread.turnCount || 0) || 0;
              return [
                this.platformLabel(thread),
                '发起 ' + this.initiatorLabel(thread),
                this.formatTime(thread.startedAt || thread.createdAt),
                count ? count + ' 条' : ''
              ].filter(Boolean).join(' · ');
            },
            lastMessagePreview: function (thread) {
              if (!thread) return '';
              if (thread.preview) return this.compactText(thread.preview, 96);
              var history = Array.isArray(thread.history) ? thread.history : [];
              var last = history.slice().reverse().find(function (item) { return item && item.text; });
              return last ? this.compactText(last.text, 96) : '还没有消息';
            },
            roleLabel: function (role) {
              if (role === 'user') return '用户';
              if (role === 'assistant') return '机器人';
              if (role === 'progress') return '执行进度';
              if (role === 'error') return '错误';
              return '系统';
            },
            messageHeader: function (message) {
              var sender = String((message && message.senderName) || this.roleLabel(message && message.role) || '').trim();
              var time = this.formatTime(message && message.at);
              var type = String((message && (message.messageType || message.event)) || '').trim();
              return [sender, time, type].filter(Boolean).join(' · ');
            },
            toggleTheme: function () {
              this.theme = this.theme === 'dark' ? 'light' : 'dark';
            },
            postAction: async function (account, action) {
              if (!account) return;
              if (!window.confirm(action + ' ' + account + ' ?')) return;
              this.actioning = true;
              this.lastError = '';
              try {
                var res = await fetch('/api/bot/' + encodeURIComponent(account) + '/' + action, { method: 'POST' });
                var payload = await res.json();
                if (!res.ok || payload.ok === false) throw new Error(payload.error || action + ' failed');
                await this.load(true);
              } catch (err) {
                this.lastError = '操作失败：' + (err && err.message ? err.message : String(err));
              } finally {
                this.actioning = false;
              }
            },
            avatarText: function (bot) {
              var name = String((bot && (bot.displayName || bot.account)) || '?').trim();
              return name.slice(0, 2).toUpperCase();
            },
            needsAttention: function (bot) {
              var activityState = bot && bot.activity && bot.activity.state;
              var statusState = bot && bot.status && bot.status.state;
              return statusState !== 'running' || (activityState && activityState !== 'idle');
            },
            statusClass: function (bot) {
              if (!bot) return '';
              if (bot.status && bot.status.state !== 'running') return bot.status.state || 'stopped';
              if (bot.activity && bot.activity.state && bot.activity.state !== 'idle') return bot.activity.state;
              return 'running';
            },
            stateLabel: function (state) {
              if (state === 'running') return '运行中';
              if (state === 'stopped') return '已停止';
              if (state === 'warning') return '警告';
              if (state === 'error') return '错误';
              return state || '未知';
            },
            shortPath: function (value) {
              var text = String(value || '');
              if (!text) return '-';
              return text.replace(/^\\/Users\\/[^/]+/, '~');
            }
          },
          mounted: async function () {
            await this.load(false);
            if (this.selectedAccount) this.loadThreads(this.selectedAccount, false);
            window.setInterval(() => this.load(false), 10000);
            window.setInterval(() => {
              if (this.selectedAccount) this.loadThreads(this.selectedAccount, true);
            }, 2500);
          }
        };
      }

      if (!window.Vue) {
        document.getElementById('app').innerHTML = '<div style="padding:24px">Vue 加载失败，请检查网络或本地依赖。</div>';
        return;
      }

      Vue.createApp(createDashboardApp()).mount('#app');
    })();
  </script>
</body>
</html>`;
}

function sendJson(res, value, status = 200) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(`${JSON.stringify(value, null, 2)}\n`);
}

function readJsonBody(req, limitBytes = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw = `${raw}${String(chunk || '')}`;
      if (raw.length > limitBytes) {
        reject(new Error('request body too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!raw.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(new Error(`invalid json body: ${err.message}`));
      }
    });
    req.on('error', reject);
  });
}

async function handleDashboardRequest(req, res) {
  const url = new URL(req.url || '/', 'http://127.0.0.1');
  if (req.method === 'GET' && url.pathname === '/') {
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
    });
    res.end(renderDashboardHtml());
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/summary') {
    sendJson(res, buildDashboardPayload());
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/mcp') {
    sendJson(res, buildMcpSummary());
    return;
  }
  if (req.method === 'GET' && url.pathname.startsWith('/api/account/')) {
    const account = decodeURIComponent(url.pathname.replace('/api/account/', ''));
    sendJson(res, runBridge('get', account));
    return;
  }

  const threadsMatch = url.pathname.match(/^\/api\/threads\/([^/]+)$/);
  if (threadsMatch) {
    const account = decodeURIComponent(threadsMatch[1]);
    if (req.method === 'GET') {
      sendJson(res, runBridge('threads', account));
      return;
    }
    if (req.method === 'POST') {
      const payload = await readJsonBody(req);
      const result = runBridge('thread-create', account, payload);
      sendJson(res, {
        ok: result.ok !== false,
        account,
        ...result,
      }, result.ok === false ? 500 : 200);
      return;
    }
  }

  const threadSendMatch = url.pathname.match(/^\/api\/thread\/([^/]+)\/([^/]+)\/send$/);
  if (req.method === 'POST' && threadSendMatch) {
    const account = decodeURIComponent(threadSendMatch[1]);
    const threadId = decodeURIComponent(threadSendMatch[2]);
    const payload = await readJsonBody(req);
    const result = await runBridgeAsync('thread-send', account, {
      ...payload,
      thread_id: threadId,
      deliver: payload.deliver || 'dashboard',
    });
    sendJson(res, {
      ok: result.ok !== false,
      account,
      threadId,
      ...result,
    }, result.ok === false ? 500 : 200);
    return;
  }

  const actionMatch = url.pathname.match(/^\/api\/bot\/([^/]+)\/(start|stop|restart)$/);
  if (req.method === 'POST' && actionMatch) {
    const account = decodeURIComponent(actionMatch[1]);
    const action = actionMatch[2];
    const result = runBridge(action, account);
    sendJson(res, {
      ok: result.ok !== false,
      action,
      account,
      ...result,
    }, result.ok === false ? 500 : 200);
    return;
  }
  sendJson(res, { ok: false, error: 'not found' }, 404);
}

function createDashboardServer() {
  return http.createServer((req, res) => {
    handleDashboardRequest(req, res).catch((err) => {
      sendJson(res, {
        ok: false,
        error: err?.message || String(err),
      }, 500);
    });
  });
}

function openBrowser(url) {
  const child = spawn('open', [url], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
}

function main() {
  if (process.argv.includes('--probe')) {
    process.stdout.write(`${JSON.stringify(buildDashboardPayload(), null, 2)}\n`);
    return;
  }
  if (process.argv.includes('--print-html')) {
    process.stdout.write(renderDashboardHtml());
    return;
  }

  const host = normalizeString(getArg('--host', process.env.AGENT_GATEWAY_DASHBOARD_HOST || '127.0.0.1')) || '127.0.0.1';
  const port = Number(getArg('--port', process.env.AGENT_GATEWAY_DASHBOARD_PORT || '8731')) || 8731;
  const server = createDashboardServer();
  server.listen(port, host, () => {
    const url = `http://${host}:${port}/`;
    console.log(`AGENT_GATEWAY_DASHBOARD_RUNNING ${url}`);
    if (process.argv.includes('--open')) openBrowser(url);
  });
}

module.exports = {
  buildChatlogConversationThreads,
  buildChatlogSummary,
  buildDashboardPayload,
  buildMcpSummary,
  buildRuntimeSummary,
  createDashboardServer,
  listCodexHomeConfigPaths,
  parseMcpServersFromToml,
  parseTomlStringArray,
  parseTomlStringValue,
  renderDashboardHtml,
  runBridge,
};

if (require.main === module) {
  main();
}
