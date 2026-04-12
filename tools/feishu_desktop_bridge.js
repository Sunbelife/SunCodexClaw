#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  asPlainObject,
  deepMerge,
  listConfigEntryNames,
  loadLocalSecrets,
  readConfigEntry,
  resolveSecretsFile,
  writeLocalSecrets,
} = require('./lib/local_secret_store');
const {
  checkCodexEnvironment,
  compactText,
  createFeishuClient,
  generateCodexReply,
  normalizeString: normalizeSupportString,
  resolveCodexConfig,
  resolveCredentials,
} = require('./lib/studio_runtime_support');

const REPO_DIR = path.resolve(__dirname, '..');
const CONFIG_DIR = path.join(REPO_DIR, 'config', 'feishu');
const DEFAULT_CONFIG_PATH = path.join(CONFIG_DIR, 'default.json');
const RUNTIME_DIR = path.join(REPO_DIR, '.runtime', 'feishu');
const LOG_DIR = path.join(RUNTIME_DIR, 'logs');
const THREAD_DIR = path.join(RUNTIME_DIR, 'studio_threads');
const CTL_SCRIPT = path.join(REPO_DIR, 'tools', 'feishu_bot_ctl.sh');
const BOT_SCRIPT = path.join(REPO_DIR, 'tools', 'feishu_ws_bot.js');
const NODE_BIN = process.execPath || 'node';

function fail(message, code = 1) {
  console.error(message);
  process.exit(code);
}

function jsonOut(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function readJsonIfExists(filePath, fallback = null) {
  if (!fs.existsSync(filePath)) return fallback;
  const raw = fs.readFileSync(filePath, 'utf8');
  return JSON.parse(raw);
}

function ensurePlainObject(value) {
  return asPlainObject(value);
}

function readDefaultConfig() {
  return ensurePlainObject(readJsonIfExists(DEFAULT_CONFIG_PATH, {}));
}

function normalizeString(value) {
  return String(value || '').trim();
}

function normalizeStringList(value) {
  const list = Array.isArray(value) ? value : [];
  return list
    .map((item) => normalizeString(item))
    .filter(Boolean);
}

function fileExists(filePath) {
  return Boolean(filePath && fs.existsSync(filePath));
}

function dirExists(dirPath) {
  try {
    return fs.statSync(dirPath).isDirectory();
  } catch {
    return false;
  }
}

function listJsonAccounts() {
  if (!fs.existsSync(CONFIG_DIR)) return [];
  return fs.readdirSync(CONFIG_DIR)
    .filter((name) => name.endsWith('.json'))
    .map((name) => path.basename(name, '.json'))
    .filter((name) => name !== 'default' && !name.endsWith('.example'))
    .sort();
}

function listAllAccounts() {
  return Array.from(new Set([
    ...listJsonAccounts(),
    ...listConfigEntryNames('feishu').filter((name) => name !== 'default'),
  ])).sort();
}

function accountJsonPath(account) {
  return path.join(CONFIG_DIR, `${account}.json`);
}

function logPathForAccount(account) {
  return path.join(LOG_DIR, `${account}.log`);
}

function readLogTail(filePath, lineLimit = 220) {
  if (!fs.existsSync(filePath)) return [];
  const raw = fs.readFileSync(filePath, 'utf8');
  const lines = raw.split(/\r?\n/);
  return lines.slice(-lineLimit).filter((line) => line.length > 0);
}

function threadStorePath(account) {
  return path.join(THREAD_DIR, `${account}.json`);
}

function sanitizeThreadId(raw) {
  return normalizeString(raw).replace(/[^a-zA-Z0-9_-]/g, '');
}

function nowIso() {
  return new Date().toISOString();
}

function normalizeThreadRecord(thread) {
  const value = ensurePlainObject(thread);
  return {
    id: sanitizeThreadId(value.id) || `studio-${Date.now()}`,
    name: normalizeString(value.name) || '新线程',
    chatId: normalizeString(value.chat_id || value.chatId),
    chatType: normalizeString(value.chat_type || value.chatType || 'p2p') || 'p2p',
    chatLabel: normalizeString(value.chat_label || value.chatLabel) || '',
    codexThreadId: normalizeString(value.codex_thread_id || value.codexThreadId),
    status: normalizeString(value.status || 'idle') || 'idle',
    lastError: normalizeString(value.last_error || value.lastError),
    lastReplyPreview: normalizeString(value.last_reply_preview || value.lastReplyPreview),
    createdAt: normalizeString(value.created_at || value.createdAt) || nowIso(),
    updatedAt: normalizeString(value.updated_at || value.updatedAt) || nowIso(),
    history: Array.isArray(value.history)
      ? value.history
        .map((item) => ({
          role: normalizeString(item?.role || 'user') || 'user',
          text: normalizeString(item?.text),
        }))
        .filter((item) => item.text)
      : [],
  };
}

function readThreadStore(account) {
  const filePath = threadStorePath(account);
  const loaded = ensurePlainObject(readJsonIfExists(filePath, {}));
  const threads = Array.isArray(loaded.threads)
    ? loaded.threads.map(normalizeThreadRecord)
    : [];
  return {
    filePath,
    threads,
  };
}

function presentThread(thread) {
  const normalized = normalizeThreadRecord(thread);
  return {
    ...normalized,
    turnCount: Math.ceil((normalized.history || []).length / 2),
  };
}

function writeThreadStore(account, threads) {
  const filePath = threadStorePath(account);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const payload = {
    version: 1,
    threads: threads.map(normalizeThreadRecord),
  };
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return filePath;
}

function listRecentTargetsForAccount(account, limit = 8) {
  const filePath = logPathForAccount(account);
  const lines = readLogTail(filePath, 800);
  const seen = new Set();
  const results = [];
  let current = null;

  function commit(event) {
    if (!event || !event.chat_id) return;
    if (seen.has(event.chat_id)) return;
    seen.add(event.chat_id);
    const chatType = normalizeString(event.chat_type || 'p2p') || 'p2p';
    const labelPrefix = chatType === 'p2p' ? '私聊' : '群聊';
    results.push({
      id: event.chat_id,
      chatId: event.chat_id,
      chatType,
      label: normalizeString(event.chat_label) || `${labelPrefix} ${event.chat_id.slice(-6)}`,
      detail: [
        event.chat_scope_kind || '',
        event.message_type || '',
      ].filter(Boolean).join(' · '),
    });
  }

  for (const line of lines) {
    if (line === 'FEISHU_EVENT') {
      commit(current);
      current = {};
      continue;
    }
    if (!current) continue;
    const kv = parseKvLine(line);
    if (!kv) continue;
    if (['chat_id', 'chat_type', 'chat_scope_kind', 'message_type'].includes(kv.key)) {
      current[kv.key] = kv.value;
    }
  }
  commit(current);
  return results.reverse().slice(0, limit);
}

function listThreadsForAccount(account) {
  const store = readThreadStore(account);
  return {
    account,
    filePath: store.filePath,
    threads: store.threads.map(presentThread),
    recentTargets: listRecentTargetsForAccount(account),
  };
}

function parseKvLine(line) {
  const match = String(line || '').match(/^([a-z0-9_]+)=(.*)$/i);
  if (!match) return null;
  return { key: match[1], value: match[2] };
}

function parseStatusLine(line) {
  const trimmed = String(line || '').trim();
  const match = trimmed.match(/^\[(running|stopped|skip)\]\s+([^\s]+)\s+(.*)$/);
  if (!match) return null;
  const state = match[1];
  const account = match[2];
  const rest = match[3];
  let normalizedRest = rest;
  const details = {};
  const logMatch = normalizedRest.match(/\blog=(.+)$/);
  if (logMatch) {
    details.log = logMatch[1].trim();
    normalizedRest = normalizedRest.slice(0, logMatch.index).trim();
  }
  const partRegex = /([a-z_]+)=([^\s]+)/g;
  let found;
  while ((found = partRegex.exec(normalizedRest)) !== null) {
    details[found[1]] = found[2];
  }
  return {
    account,
    state,
    pid: details.pid && details.pid !== '(none)' ? Number(details.pid) : null,
    manager: details.manager || '',
    lastExit: details.last_exit || '',
    stalePid: details.stale_pid || '',
    logPath: details.log || logPathForAccount(account),
    raw: trimmed,
  };
}

function runCtl(args = []) {
  const run = spawnSync('bash', [CTL_SCRIPT, ...args], {
    cwd: REPO_DIR,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 8,
  });
  if (run.error) throw run.error;
  return {
    status: run.status || 0,
    stdout: run.stdout || '',
    stderr: run.stderr || '',
  };
}

function getCtlStatus(account) {
  const run = runCtl(['status', account]);
  if (run.status !== 0) {
    throw new Error((run.stderr || run.stdout || `status failed for ${account}`).trim());
  }
  const lines = `${run.stdout}\n${run.stderr}`.split(/\r?\n/).filter(Boolean);
  const parsed = lines.map(parseStatusLine).find(Boolean);
  return parsed || {
    account,
    state: 'unknown',
    pid: null,
    manager: '',
    lastExit: '',
    stalePid: '',
    logPath: logPathForAccount(account),
    raw: lines.join('\n'),
  };
}

function parseLaunchBoot(lines) {
  const boot = {};
  let capture = false;
  for (const line of lines) {
    if (line === 'FEISHU_WS_BOT_RUNNING') {
      capture = true;
      continue;
    }
    if (!capture) continue;
    const kv = parseKvLine(line);
    if (!kv) {
      if (/^\[info\]:/.test(line)) break;
      continue;
    }
    boot[kv.key] = kv.value;
  }
  return boot;
}

function finalizeEvent(target, event) {
  if (!event) return target;
  target.lastEvent = {
    chatId: event.chat_id || '',
    chatType: event.chat_type || '',
    messageId: event.message_id || '',
    messageType: event.message_type || '',
    senderType: event.sender_type || '',
    chatScope: event.chat_scope || '',
    chatScopeKind: event.chat_scope_kind || '',
    skipReason: event.skip_reason || '',
    state: event.state || 'received',
    codexThreadId: event.codex_thread_id || '',
    localThread: event.local_thread || '',
    replyMode: event.reply_mode || '',
  };
  return target;
}

function normalizeErrorSummary(raw) {
  const compact = normalizeString(raw).replace(/^'+|'+$/g, '');
  if (!compact) return '';
  if (compact.length <= 180) return compact;
  return `${compact.slice(0, 177)}...`;
}

function parseLogActivity(account, filePath, lines) {
  const boot = parseLaunchBoot(lines);
  const result = {
    boot,
    activeEvent: null,
    lastEvent: null,
    lastReply: null,
    lastError: null,
    logExcerpt: lines.slice(-36),
    logPath: filePath,
    logUpdatedAt: fileExists(filePath) ? fs.statSync(filePath).mtime.toISOString() : '',
  };

  let currentEvent = null;
  let pendingError = null;

  for (const line of lines) {
    if (line === 'FEISHU_EVENT') {
      if (currentEvent) finalizeEvent(result, currentEvent);
      currentEvent = { state: 'received' };
      continue;
    }

    const kv = parseKvLine(line);
    if (kv && currentEvent && [
      'chat_id',
      'chat_type',
      'message_id',
      'message_type',
      'sender_type',
      'chat_scope',
      'chat_scope_kind',
    ].includes(kv.key)) {
      currentEvent[kv.key] = kv.value;
      continue;
    }

    if (kv && kv.key === 'skip_reason') {
      if (currentEvent) {
        currentEvent.skip_reason = kv.value;
        currentEvent.state = 'skipped';
        finalizeEvent(result, currentEvent);
        currentEvent = null;
      }
      continue;
    }

    if (line.startsWith('reply=')) {
      const replyMatch = line.match(/^reply=(ok|cancelled)\s+mode=([^\s]+)\s+thread=(.*)$/);
      result.lastReply = {
        state: replyMatch ? replyMatch[1] : 'unknown',
        mode: replyMatch ? replyMatch[2] : '',
        localThread: replyMatch ? replyMatch[3] : '',
        codexThreadId: result.lastReply?.codexThreadId || '',
      };
      if (currentEvent) {
        currentEvent.state = result.lastReply.state === 'ok' ? 'completed' : result.lastReply.state;
        currentEvent.reply_mode = result.lastReply.mode;
        currentEvent.local_thread = result.lastReply.localThread;
        currentEvent.codex_thread_id = result.lastReply.codexThreadId || '';
        finalizeEvent(result, currentEvent);
        currentEvent = null;
      }
      continue;
    }

    if (line.startsWith('codex_thread_id=')) {
      const threadMatch = line.match(/^codex_thread_id=([^\s]+).*local_thread=([^\s]+)/);
      const codexThreadId = threadMatch ? threadMatch[1] : normalizeString(line.split('=')[1]);
      const localThread = threadMatch ? threadMatch[2] : '';
      result.lastReply = {
        ...(result.lastReply || {}),
        codexThreadId,
        localThread: localThread || result.lastReply?.localThread || '',
      };
      if (currentEvent) {
        currentEvent.codex_thread_id = codexThreadId;
        if (localThread) currentEvent.local_thread = localThread;
      }
      continue;
    }

    if (/^\[error\]:/.test(line)) {
      pendingError = { source: 'runtime', summary: '', code: '', details: [] };
      continue;
    }

    if (pendingError) {
      const codeMatch = line.match(/code:\s*([0-9]+)/);
      if (codeMatch) pendingError.code = codeMatch[1];
      const msgMatch = line.match(/msg:\s*'([^']+)'/);
      if (msgMatch) pendingError.summary = msgMatch[1];
      pendingError.details.push(line);
      if (line.trim() === ']' || line.trim() === ']]' || line.trim() === '},' || line.includes('permission_violations')) {
        result.lastError = {
          code: pendingError.code || '',
          summary: normalizeErrorSummary(pendingError.summary || pendingError.details.join(' ')),
          raw: pendingError.details.slice(-10),
        };
        pendingError = null;
      }
      continue;
    }

    const progressError = line.match(/^(progress_[a-z_]+)=error\b.*message=(.*)$/);
    if (progressError) {
      result.lastError = {
        code: result.lastError?.code || '',
        summary: normalizeErrorSummary(progressError[2] || line),
        raw: [line],
      };
      continue;
    }
  }

  if (currentEvent) {
    result.activeEvent = {
      chatId: currentEvent.chat_id || '',
      chatType: currentEvent.chat_type || '',
      messageId: currentEvent.message_id || '',
      messageType: currentEvent.message_type || '',
      senderType: currentEvent.sender_type || '',
      chatScope: currentEvent.chat_scope || '',
      chatScopeKind: currentEvent.chat_scope_kind || '',
      codexThreadId: currentEvent.codex_thread_id || result.lastReply?.codexThreadId || '',
      localThread: currentEvent.local_thread || result.lastReply?.localThread || '',
      state: currentEvent.state || 'received',
    };
  }

  const updatedAt = result.logUpdatedAt ? new Date(result.logUpdatedAt).getTime() : 0;
  const freshWindow = 15 * 60 * 1000;
  if (result.activeEvent && Date.now() - updatedAt > freshWindow) {
    result.activeEvent = null;
  }

  return result;
}

function summarizeActivity(status, logActivity) {
  if (status.state !== 'running') {
    return {
      state: status.state,
      label: status.state === 'stopped' ? '已停止' : '未运行',
      detail: status.lastExit ? `last_exit=${status.lastExit}` : '',
    };
  }

  if (logActivity.activeEvent) {
    const event = logActivity.activeEvent;
    const parts = [
      event.chatType || '(unknown)',
      event.messageType || '(unknown)',
      event.chatScopeKind || '',
    ].filter(Boolean);
    const threadPart = event.codexThreadId
      ? `Codex ${event.codexThreadId.slice(0, 8)}`
      : event.localThread
        ? `线程 ${event.localThread}`
        : '';
    return {
      state: 'busy',
      label: `执行中 · ${parts.join(' · ')}`,
      detail: threadPart,
    };
  }

  if (logActivity.lastError?.summary) {
    return {
      state: 'warning',
      label: '最近一次执行出现错误',
      detail: logActivity.lastError.code
        ? `${logActivity.lastError.code} · ${logActivity.lastError.summary}`
        : logActivity.lastError.summary,
    };
  }

  if (logActivity.lastReply?.state === 'ok') {
    return {
      state: 'idle',
      label: '空闲',
      detail: logActivity.lastReply.codexThreadId
        ? `最近线程 ${logActivity.lastReply.codexThreadId.slice(0, 8)}`
        : (logActivity.lastReply.localThread ? `最近 ${logActivity.lastReply.localThread}` : '最近执行完成'),
    };
  }

  return {
    state: 'idle',
    label: '空闲',
    detail: '等待新消息',
  };
}

function buildChecklist(merged) {
  const codex = ensurePlainObject(merged.codex);
  const progress = ensurePlainObject(merged.progress);
  const doc = ensurePlainObject(progress.doc);
  const speech = ensurePlainObject(merged.speech);
  return [
    {
      id: 'credentials',
      title: '飞书凭据已填写',
      done: Boolean(merged.app_id && merged.app_secret && merged.encrypt_key && merged.verification_token),
      hint: 'App ID / App Secret / Encrypt Key / Verification Token',
    },
    {
      id: 'bot-name',
      title: '机器人名称已设置',
      done: Boolean(merged.bot_name),
      hint: merged.bot_name ? merged.bot_name : '建议填写 bot_name，群里 @ 更稳定',
    },
    {
      id: 'workspace',
      title: 'Codex 工作目录可用',
      done: Boolean(codex.cwd && dirExists(codex.cwd)),
      hint: codex.cwd || '未填写 codex.cwd',
    },
    {
      id: 'add-dirs',
      title: '附加目录有效',
      done: normalizeStringList(codex.add_dirs).every(dirExists),
      hint: normalizeStringList(codex.add_dirs).length > 0
        ? normalizeStringList(codex.add_dirs).join('\n')
        : '未配置额外目录',
    },
    {
      id: 'progress',
      title: '任务进度通知配置完整',
      done: Boolean(progress.mode && (!progress.enabled || doc.title_prefix || progress.message)),
      hint: progress.mode === 'doc'
        ? (doc.title_prefix || '建议补充文档标题前缀')
        : (progress.message || '建议补充消息提示文案'),
    },
    {
      id: 'speech',
      title: '语音转写配置',
      done: speech.enabled !== true || Boolean(speech.model),
      hint: speech.enabled ? (speech.model || '已启用但未设置 model') : '未启用语音转写',
    },
  ];
}

function mergedConfigForAccount(account) {
  const defaultConfig = readDefaultConfig();
  const jsonPath = accountJsonPath(account);
  const fileConfig = ensurePlainObject(readJsonIfExists(jsonPath, {}));
  const yamlConfig = ensurePlainObject(readConfigEntry('feishu', account, {}));
  const merged = deepMerge(defaultConfig, fileConfig, yamlConfig);
  return {
    account,
    defaultConfig,
    jsonPath,
    jsonExists: fs.existsSync(jsonPath),
    jsonConfig: fileConfig,
    secretFile: resolveSecretsFile(),
    yamlConfig,
    merged,
  };
}

function splitConfigForSave(profile) {
  const merged = ensurePlainObject(profile);
  const progress = ensurePlainObject(merged.progress);
  const progressDoc = ensurePlainObject(progress.doc);
  const codex = ensurePlainObject(merged.codex);
  const speech = ensurePlainObject(merged.speech);

  const jsonConfig = {
    bot_name: normalizeString(merged.bot_name),
    domain: normalizeString(merged.domain || 'feishu'),
    reply_mode: normalizeString(merged.reply_mode || 'codex'),
    reply_prefix: normalizeString(merged.reply_prefix),
    ignore_self_messages: merged.ignore_self_messages !== false,
    auto_reply: merged.auto_reply !== false,
    require_mention: merged.require_mention !== false,
    require_mention_group_only: merged.require_mention_group_only !== false,
    progress: {
      enabled: progress.enabled !== false,
      message: normalizeString(progress.message || '已接收，正在执行。'),
      mode: normalizeString(progress.mode || 'doc'),
      doc: {
        title_prefix: normalizeString(progressDoc.title_prefix || ''),
        share_to_chat: progressDoc.share_to_chat !== false,
        link_scope: normalizeString(progressDoc.link_scope || 'same_tenant'),
        include_user_message: progressDoc.include_user_message !== false,
        write_final_reply: progressDoc.write_final_reply !== false,
      },
    },
    codex: {
      bin: normalizeString(codex.bin || 'codex'),
      model: normalizeString(codex.model || 'gpt-5.4'),
      reasoning_effort: normalizeString(codex.reasoning_effort || 'xhigh'),
      profile: normalizeString(codex.profile || ''),
      cwd: normalizeString(codex.cwd || ''),
      add_dirs: normalizeStringList(codex.add_dirs),
      history_turns: Number.isFinite(Number(codex.history_turns)) ? Number(codex.history_turns) : 6,
      system_prompt: normalizeString(codex.system_prompt || ''),
      sandbox: normalizeString(codex.sandbox || 'danger-full-access'),
      approval_policy: normalizeString(codex.approval_policy || 'never'),
    },
    speech: {
      enabled: speech.enabled !== false,
      model: normalizeString(speech.model || 'gpt-4o-mini-transcribe'),
      language: normalizeString(speech.language || ''),
      base_url: normalizeString(speech.base_url || 'https://api.openai.com/v1'),
      ffmpeg_bin: normalizeString(speech.ffmpeg_bin || ''),
    },
  };

  const yamlConfig = {
    app_id: normalizeString(merged.app_id),
    app_secret: normalizeString(merged.app_secret),
    encrypt_key: normalizeString(merged.encrypt_key),
    verification_token: normalizeString(merged.verification_token),
    bot_open_id: normalizeString(merged.bot_open_id),
    codex: {
      api_key: normalizeString(codex.api_key),
    },
    speech: {
      api_key: normalizeString(speech.api_key),
    },
  };

  return { jsonConfig, yamlConfig };
}

function sanitizeForEditor(merged) {
  const progress = ensurePlainObject(merged.progress);
  const codex = ensurePlainObject(merged.codex);
  const speech = ensurePlainObject(merged.speech);
  const doc = ensurePlainObject(progress.doc);
  return {
    app_id: normalizeString(merged.app_id),
    app_secret: normalizeString(merged.app_secret),
    encrypt_key: normalizeString(merged.encrypt_key),
    verification_token: normalizeString(merged.verification_token),
    bot_open_id: normalizeString(merged.bot_open_id),
    bot_name: normalizeString(merged.bot_name),
    domain: normalizeString(merged.domain || 'feishu'),
    reply_mode: normalizeString(merged.reply_mode || 'codex'),
    reply_prefix: normalizeString(merged.reply_prefix),
    ignore_self_messages: merged.ignore_self_messages !== false,
    auto_reply: merged.auto_reply !== false,
    require_mention: merged.require_mention !== false,
    require_mention_group_only: merged.require_mention_group_only !== false,
    progress: {
      enabled: progress.enabled !== false,
      message: normalizeString(progress.message || '已接收，正在执行。'),
      mode: normalizeString(progress.mode || 'doc'),
      doc: {
        title_prefix: normalizeString(doc.title_prefix),
        share_to_chat: doc.share_to_chat !== false,
        link_scope: normalizeString(doc.link_scope || 'same_tenant'),
        include_user_message: doc.include_user_message !== false,
        write_final_reply: doc.write_final_reply !== false,
      },
    },
    codex: {
      bin: normalizeString(codex.bin || 'codex'),
      api_key: normalizeString(codex.api_key),
      model: normalizeString(codex.model || 'gpt-5.4'),
      reasoning_effort: normalizeString(codex.reasoning_effort || 'xhigh'),
      profile: normalizeString(codex.profile),
      cwd: normalizeString(codex.cwd),
      add_dirs: normalizeStringList(codex.add_dirs),
      history_turns: Number.isFinite(Number(codex.history_turns)) ? Number(codex.history_turns) : 6,
      system_prompt: normalizeString(codex.system_prompt),
      sandbox: normalizeString(codex.sandbox || 'danger-full-access'),
      approval_policy: normalizeString(codex.approval_policy || 'never'),
    },
    speech: {
      enabled: speech.enabled !== false,
      api_key: normalizeString(speech.api_key),
      model: normalizeString(speech.model || 'gpt-4o-mini-transcribe'),
      language: normalizeString(speech.language),
      base_url: normalizeString(speech.base_url || 'https://api.openai.com/v1'),
      ffmpeg_bin: normalizeString(speech.ffmpeg_bin),
    },
  };
}

function buildAccountDetail(account) {
  const snapshot = mergedConfigForAccount(account);
  const status = getCtlStatus(account);
  const logPath = status.logPath || logPathForAccount(account);
  const logLines = readLogTail(logPath);
  const activity = parseLogActivity(account, logPath, logLines);
  const merged = snapshot.merged;
  return {
    account,
    displayName: normalizeString(merged.bot_name || snapshot.boot?.bot_name || account),
    status,
    activity: {
      ...activity,
      summary: summarizeActivity(status, activity),
    },
    paths: {
      repo: REPO_DIR,
      jsonConfig: snapshot.jsonPath,
      secretFile: snapshot.secretFile,
      logFile: logPath,
    },
    editor: sanitizeForEditor(merged),
    checklist: buildChecklist(merged),
  };
}

function buildSummary() {
  return {
    repo: REPO_DIR,
    secretFile: resolveSecretsFile(),
    accounts: listAllAccounts().map((account) => {
      const detail = buildAccountDetail(account);
      return {
        account: detail.account,
        displayName: detail.displayName,
        status: detail.status,
        activity: detail.activity.summary,
        boot: {
          codexCwd: detail.activity.boot.codex_cwd || detail.editor.codex.cwd,
          codexModel: detail.activity.boot.codex_model || detail.editor.codex.model,
          progressMode: detail.activity.boot.progress_mode || detail.editor.progress.mode,
          mentionAliases: normalizeString(detail.activity.boot.mention_aliases),
        },
        checklistDone: detail.checklist.filter((item) => item.done).length,
        checklistTotal: detail.checklist.length,
      };
    }),
  };
}

function mergedEnvironmentConfig(account = '') {
  const defaultConfig = readDefaultConfig();
  if (normalizeString(account)) {
    return mergedConfigForAccount(account).merged;
  }
  const yamlDefault = ensurePlainObject(readConfigEntry('feishu', 'default', {}));
  return deepMerge(defaultConfig, yamlDefault);
}

function buildEnvironmentHealth(account = '') {
  const merged = mergedEnvironmentConfig(account);
  const codex = resolveCodexConfig(merged);
  const health = checkCodexEnvironment({
    bin: codex.bin || 'codex',
    cwd: codex.cwd || REPO_DIR,
    apiKey: codex.apiKey,
  });
  return {
    account: normalizeString(account),
    ...health,
  };
}

function buildStudioThreadTitle({ account = '', threadName = '', userText = '' }) {
  return [
    compactText(account || 'Studio 机器人', 24),
    compactText(threadName || '新线程', 20),
    compactText(userText || '', 48),
  ].filter(Boolean).join(' | ');
}

function findThreadOrFail(account, threadId) {
  const store = readThreadStore(account);
  const target = sanitizeThreadId(threadId);
  const index = store.threads.findIndex((item) => item.id === target);
  if (index < 0) fail(`thread not found: ${threadId}`);
  return {
    store,
    index,
    thread: store.threads[index],
  };
}

function buildThreadEnvelope(account, activeThread = null) {
  const listing = listThreadsForAccount(account);
  return {
    ok: true,
    account,
    filePath: listing.filePath,
    recentTargets: listing.recentTargets,
    threads: listing.threads,
    thread: activeThread ? presentThread(activeThread) : null,
  };
}

function replaceYamlEntry(sectionName, entryName, value) {
  const loaded = loadLocalSecrets();
  const doc = ensurePlainObject(loaded.doc || {});
  doc.config = ensurePlainObject(doc.config);
  doc.config[sectionName] = ensurePlainObject(doc.config[sectionName]);
  doc.config[sectionName][entryName] = ensurePlainObject(value);
  return writeLocalSecrets(doc);
}

function writeAccountJson(account, jsonConfig) {
  const filePath = accountJsonPath(account);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(jsonConfig, null, 2)}\n`, 'utf8');
  return filePath;
}

function readPayload() {
  const raw = fs.readFileSync(0, 'utf8');
  return raw ? JSON.parse(raw) : {};
}

function handleSave(account) {
  const payload = readPayload();
  const profile = ensurePlainObject(payload.profile || payload);
  if (!normalizeString(account)) fail('account is required');
  if (!normalizeString(profile.bot_name)) fail('bot_name is required');
  if (!normalizeString(profile.codex?.cwd || '')) fail('codex.cwd is required');
  const split = splitConfigForSave(profile);
  const jsonPath = writeAccountJson(account, split.jsonConfig);
  const secretFile = replaceYamlEntry('feishu', account, split.yamlConfig);
  jsonOut({
    ok: true,
    account,
    jsonPath,
    secretFile,
    detail: buildAccountDetail(account),
  });
}

function handleCtlAction(action, account) {
  if (!normalizeString(account)) fail('account is required');
  const run = runCtl([action, account]);
  if (run.status !== 0) {
    fail((run.stderr || run.stdout || `${action} failed`).trim(), run.status || 1);
  }
  jsonOut({
    ok: true,
    action,
    account,
    output: normalizeString(run.stdout || run.stderr),
    detail: buildAccountDetail(account),
  });
}

function handleProbe(account) {
  if (!normalizeString(account)) fail('account is required');
  const run = spawnSync(NODE_BIN, [BOT_SCRIPT, '--account', account, '--dry-run'], {
    cwd: REPO_DIR,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 8,
  });
  const output = `${run.stdout || ''}\n${run.stderr || ''}`.trim();
  const lines = output.split(/\r?\n/).filter(Boolean);
  const facts = {};
  for (const line of lines) {
    const kv = parseKvLine(line);
    if (kv) facts[kv.key] = kv.value;
  }
  jsonOut({
    ok: run.status === 0,
    account,
    exitCode: run.status || 0,
    facts,
    output: lines,
  });
}

function handleHealth(account) {
  jsonOut(buildEnvironmentHealth(account));
}

function handleThreads(account) {
  if (!normalizeString(account)) fail('account is required');
  jsonOut(buildThreadEnvelope(account));
}

function handleThreadCreate(account) {
  if (!normalizeString(account)) fail('account is required');
  const payload = ensurePlainObject(readPayload());
  const chatId = normalizeString(payload.chat_id || payload.chatId);
  if (!chatId) fail('chat_id is required');

  const name = normalizeString(payload.name) || '新线程';
  const nextThread = normalizeThreadRecord({
    id: `studio-${Date.now().toString(36)}`,
    name,
    chat_id: chatId,
    chat_type: normalizeString(payload.chat_type || payload.chatType || 'p2p') || 'p2p',
    chat_label: normalizeString(payload.chat_label || payload.chatLabel),
    status: 'idle',
    history: [],
  });

  const store = readThreadStore(account);
  store.threads.unshift(nextThread);
  writeThreadStore(account, store.threads);
  jsonOut(buildThreadEnvelope(account, nextThread));
}

function handleThreadClose(account) {
  if (!normalizeString(account)) fail('account is required');
  const payload = ensurePlainObject(readPayload());
  const threadId = sanitizeThreadId(payload.thread_id || payload.threadId);
  if (!threadId) fail('thread_id is required');
  const store = readThreadStore(account);
  const nextThreads = store.threads.filter((item) => item.id !== threadId);
  if (nextThreads.length === store.threads.length) {
    fail(`thread not found: ${threadId}`);
  }
  writeThreadStore(account, nextThreads);
  jsonOut(buildThreadEnvelope(account));
}

async function handleThreadSend(account) {
  if (!normalizeString(account)) fail('account is required');
  const payload = ensurePlainObject(readPayload());
  const threadId = sanitizeThreadId(payload.thread_id || payload.threadId);
  const text = normalizeString(payload.text);
  if (!threadId) fail('thread_id is required');
  if (!text) fail('text is required');

  const { store, index, thread } = findThreadOrFail(account, threadId);
  const merged = mergedConfigForAccount(account).merged;
  const creds = resolveCredentials(merged);
  const codex = resolveCodexConfig(merged);
  const chatId = normalizeString(thread.chatId);
  if (!chatId) fail('thread chat_id is required');
  if (!normalizeString(codex.cwd)) fail('codex.cwd is required');

  const activeThread = normalizeThreadRecord({
    ...thread,
    status: 'running',
    last_error: '',
    updated_at: nowIso(),
  });
  store.threads[index] = activeThread;
  writeThreadStore(account, store.threads);

  try {
    const client = createFeishuClient({
      domain: normalizeString(merged.domain || 'feishu') || 'feishu',
      creds,
    });
    const reply = await generateCodexReply({
      codex,
      history: activeThread.history,
      userText: text,
      sessionId: activeThread.codexThreadId,
      threadTitle: buildStudioThreadTitle({
        account: normalizeString(merged.bot_name || account),
        threadName: activeThread.name,
        userText: text,
      }),
    });
    const replyText = normalizeString(reply.reply);
    if (!replyText) {
      throw new Error('codex returned empty reply');
    }
    const sentChunks = await sendCodexReplyPassthrough(client, chatId, replyText);

    const nextHistory = [
      ...(activeThread.history || []),
      { role: 'user', text },
      { role: 'assistant', text: compactText(replyText, 4000) },
    ];
    const maxItems = Math.max(0, Number(codex.historyTurns || 0)) * 2;
    while (maxItems > 0 && nextHistory.length > maxItems) nextHistory.shift();
    const completedThread = normalizeThreadRecord({
      ...activeThread,
      history: maxItems === 0 ? [] : nextHistory,
      codex_thread_id: normalizeString(reply.threadId || activeThread.codexThreadId),
      status: 'idle',
      last_reply_preview: compactText(replyText, 160),
      updated_at: nowIso(),
    });
    store.threads[index] = completedThread;
    writeThreadStore(account, store.threads);
    jsonOut({
      ...buildThreadEnvelope(account, completedThread),
      sentChunks,
      preview: completedThread.lastReplyPreview,
    });
  } catch (err) {
    const failedThread = normalizeThreadRecord({
      ...activeThread,
      status: 'error',
      last_error: err.message,
      updated_at: nowIso(),
    });
    store.threads[index] = failedThread;
    writeThreadStore(account, store.threads);
    fail(err.message);
  }
}

async function main() {
  const [, , command = '', account = ''] = process.argv;
  switch (command) {
    case 'summary':
      jsonOut(buildSummary());
      return;
    case 'get':
      jsonOut(buildAccountDetail(account));
      return;
    case 'save':
      handleSave(account);
      return;
    case 'start':
    case 'stop':
    case 'restart':
      handleCtlAction(command, account);
      return;
    case 'probe':
      handleProbe(account);
      return;
    case 'health':
      handleHealth(account);
      return;
    case 'threads':
      handleThreads(account);
      return;
    case 'thread-create':
      handleThreadCreate(account);
      return;
    case 'thread-close':
      handleThreadClose(account);
      return;
    case 'thread-send':
      await handleThreadSend(account);
      return;
    default:
      fail('Usage: node tools/feishu_desktop_bridge.js <summary|get|save|start|stop|restart|probe|health|threads|thread-create|thread-close|thread-send> [account]');
  }
}

main().catch((error) => {
  fail(error?.message || String(error));
});
