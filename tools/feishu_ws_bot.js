#!/usr/bin/env node
const fs = require('fs');
const https = require('https');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { randomBytes } = require('crypto');
const WebSocket = require('ws');
const {
  deepMerge,
  readConfigEntry,
  resolveSecretsFile,
  upsertConfigEntry,
} = require('./lib/local_secret_store');
const {
  resolveDailyStoreReportConfig,
} = require('./lib/daily_store_report');
const {
  createScheduledJobManager,
} = require('./lib/daily_report_task_manager');
const {
  normalizeChannelType,
  normalizeTargetType,
} = require('./lib/message_channel_delivery');
const {
  loadTalkNormalPromptMeta,
  mergeTalkNormalPrompt,
} = require('./lib/talk_normal_prompt');

let lark = null;
try {
  // eslint-disable-next-line global-require
  lark = require('@larksuiteoapi/node-sdk');
} catch (_) {
  lark = null;
}

let ffmpegStatic = '';
try {
  // eslint-disable-next-line global-require
  ffmpegStatic = require('ffmpeg-static') || '';
} catch (_) {
  ffmpegStatic = '';
}

const DEFAULT_CODEX_SYSTEM_PROMPT = [
  '你是“飞书 Codex 助手”，通过飞书和用户交流。',
  '请直接回答用户问题，不要复述用户原话。',
  '如果信息不足，先给最可执行的下一步，再明确缺少什么。',
  '不要承诺“稍后回复”或“几分钟后回复”；必须在当前这一条里给出可执行结果，或明确失败原因。',
  '默认使用简体中文，除非用户明确要求其他语言。',
].join('\n');
const DEFAULT_LOCAL_MODEL_SYSTEM_PROMPT = [
  '你是“飞书本地 Qwen 助手”，通过飞书和用户交流。',
  '当前接入的是本机本地文本模型，本身不直接读取文件、执行命令、修改代码或访问网络。',
  '但你可以把需要本机权限、Skills、MCP、命令执行、代码修改的任务转交给 codex cli。',
  '请直接回答用户问题，不要复述用户原话。',
  '如果用户的问题依赖图片、文件、本地代码库或联网信息，而消息文本本身不足以回答，请明确说明当前本地模型接入只支持基于文本内容作答。',
  '如果任务需要调用 codex，请只输出一种委托指令，不要输出其他正文：[[CODEX_DELEGATE: 这里写给 codex 的明确执行任务]]。',
  '默认使用简体中文，除非用户明确要求其他语言。',
].join('\n');
const FORCE_EXECUTE_CODE_TASK_PROMPT = [
  '用户这次是在要求你直接修改代码、排查问题或处理工程任务。',
  '默认先查看代码并直接动手实现，不要只给方案，不要只口头答应。',
  '优先完成文件修改、命令执行和必要验证，再回复结果。',
  '回复时简洁说明改了什么、验证了什么、还剩什么风险。',
].join('\n');
const MAX_IMAGE_INPUTS = 6;
const FEISHU_TEXT_CHUNK_LIMIT = 4000;
const FEISHU_MARKDOWN_CARD_CHUNK_LIMIT = 4000;
const FEISHU_FILE_UPLOAD_LIMIT = 30 * 1024 * 1024;
const FEISHU_IMAGE_UPLOAD_LIMIT = 10 * 1024 * 1024;
const FEISHU_SEND_FILE_DIRECTIVE_PREFIX = '[[FEISHU_SEND_FILE:';
const FEISHU_SEND_IMAGE_DIRECTIVE_PREFIX = '[[FEISHU_SEND_IMAGE:';
const CODEX_DELEGATE_INLINE_PREFIX = '[[CODEX_DELEGATE:';
const CODEX_DELEGATE_BLOCK_START = '[[CODEX_DELEGATE]]';
const CODEX_DELEGATE_BLOCK_END = '[[/CODEX_DELEGATE]]';
const DEFAULT_NON_CODING_MODEL_ROUTE_TRIGGERS = [
  '不用Codex',
  '不用 Codex',
  '不要Codex',
  '不要 Codex',
  '不要用Codex',
  '不要用 Codex',
  '别用Codex',
  '别用 Codex',
  '非Codex',
  '非 Codex',
  '使用其他模型',
  '用其他模型',
  '换其他模型',
  '其他模型',
  '非编程模型',
  '不要编程模型',
  '不用编程模型',
];
const DEFAULT_WRITING_MODEL_ROUTE_TRIGGERS = [
  '写公众号文章',
  '公众号文章',
  '写一篇公众号',
  '撰写公众号',
  '生成公众号文章',
  '写长文',
  '撰写长文',
  '长文Markdown',
  '长文 Markdown',
  'Markdown正文',
  'Markdown 正文',
  '生成正文',
  '写正文',
  '写成文章',
  '写成稿',
  '文章草稿',
  '成稿',
  '出稿',
  '尝鲜派风格',
  'iBETA风格',
  'iBETA 风格',
];
const FEISHU_ATTACHMENT_TEXT_CARRY_WINDOW_MS = 10 * 60 * 1000;
const FEISHU_ATTACHMENT_HISTORY_LOOKBACK_PAGE_SIZE = 20;
const FEISHU_CHAT_CONTEXT_LOOKBACK_PAGE_SIZE = 30;
const FEISHU_CHAT_CONTEXT_LOOKBACK_MS = 60 * 60 * 1000;
const FEISHU_CHAT_CONTEXT_MAX_MESSAGES = 12;
const FEISHU_CHAT_CONTEXT_MAX_CHARS = 3600;
const FEISHU_DOCX_TEXT_BLOCK_TYPE = 2;
const FEISHU_DOCX_HEADING2_BLOCK_TYPE = 4;
const FEISHU_DOCX_HEADING3_BLOCK_TYPE = 5;
const FEISHU_DOCX_CODE_BLOCK_TYPE = 14;
const VALID_CODEX_SANDBOXES = new Set(['read-only', 'workspace-write', 'danger-full-access']);
const VALID_CODEX_APPROVAL_POLICIES = new Set(['untrusted', 'on-failure', 'on-request', 'never']);

if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') {
  process.env.NODE_EXTRA_CA_CERTS = process.env.NODE_EXTRA_CA_CERTS || '';
  https.globalAgent.options.rejectUnauthorized = false;
}

function patchWsClientTlsBypass(wsClient) {
  if (!wsClient || process.env.NODE_TLS_REJECT_UNAUTHORIZED !== '0') return wsClient;
  wsClient.connect = function patchedConnect() {
    const connectUrl = this.wsConfig.getWS('connectUrl');
    let wsInstance;
    try {
      const { agent } = this;
      wsInstance = new WebSocket(connectUrl, {
        agent,
        rejectUnauthorized: false,
      });
    } catch (_) {
      this.logger.error('[ws]', 'new WebSocket error');
    }
    if (!wsInstance) return Promise.resolve(false);
    return new Promise((resolve) => {
      wsInstance.on('open', () => {
        this.logger.debug('[ws]', 'ws connect success');
        this.wsConfig.setWSInstance(wsInstance);
        this.pingLoop();
        resolve(true);
      });
      wsInstance.on('error', () => {
        this.logger.error('[ws]', 'ws connect failed');
        resolve(false);
      });
    });
  };
  return wsClient;
}
const VALID_PROGRESS_DOC_LINK_SCOPES = new Set(['same_tenant', 'anyone', 'closed']);
const IMAGE_FILE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.tif', '.tiff', '.bmp', '.ico']);
const TRANSCRIPTION_MIME_BY_EXTENSION = new Map([
  ['.mp3', 'audio/mpeg'],
  ['.mp4', 'audio/mp4'],
  ['.mpeg', 'audio/mpeg'],
  ['.mpga', 'audio/mpeg'],
  ['.m4a', 'audio/mp4'],
  ['.wav', 'audio/wav'],
  ['.webm', 'audio/webm'],
]);
const CONTENT_TYPE_EXTENSION_MAP = new Map([
  ['audio/mpeg', '.mp3'],
  ['audio/mp3', '.mp3'],
  ['audio/mp4', '.m4a'],
  ['audio/wav', '.wav'],
  ['audio/x-wav', '.wav'],
  ['audio/webm', '.webm'],
  ['audio/ogg', '.ogg'],
  ['audio/opus', '.opus'],
  ['application/ogg', '.ogg'],
]);
const REPO_DIR = path.resolve(__dirname, '..');
const FEISHU_RUNTIME_DIR = path.join(REPO_DIR, '.runtime', 'feishu');
const FEISHU_LOG_DIR = path.join(FEISHU_RUNTIME_DIR, 'logs');
const FEISHU_MEMORY_DIR = path.join(FEISHU_RUNTIME_DIR, 'memory');
const FEISHU_APPROVAL_DIR = path.join(FEISHU_RUNTIME_DIR, 'approvals');
const FEISHU_CODEX_EXEC_LOCK_DIR = path.join(FEISHU_RUNTIME_DIR, 'codex-exec.lock');
const FEISHU_WORKSPACE_ROOT = path.join(os.homedir(), 'Downloads', 'SunCodexClaw', 'feishu');
const FEISHU_INCOMING_ATTACHMENT_DIR = FEISHU_WORKSPACE_ROOT;
const FEISHU_MEMORY_HEADER = '<<SUNCODEXCLAW_MEMORY_BUNDLE_V1>>';
const FEISHU_MEMORY_FOOTER = '<<END_SUNCODEXCLAW_MEMORY_BUNDLE_V1>>';
const FEISHU_MEMORY_SCOPE_PROFILE = 'profile_facts';
const FEISHU_MEMORY_SCOPE_ROLE = 'role_memory';
const FEISHU_MEMORY_SCOPE_HISTORY = 'history';
const FEISHU_MEMORY_SECTION_ACTIVATED_HISTORY = 'activated_history';
const FEISHU_MEMORY_SECTION_RECENT_SUMMARY = 'recent_summary';
const FEISHU_MEMORY_SECTION_LIVE_TOOL_FACTS = 'live_tool_facts';
const FEISHU_MEMORY_MAX_SECTION_CHARS = 1200;
const FEISHU_MEMORY_MAX_RENDERED_ITEMS = 10;
const FEISHU_MEMORY_MAX_ITEM_CHARS = 180;
const FEISHU_MEMORY_MAX_RECENT_TURNS = 4;
const FEISHU_MEMORY_MAX_RECENT_TURN_CHARS = 120;
const FEISHU_MEMORY_MAX_LIVE_TOOL_FACTS = 2;
const FEISHU_MEMORY_MAX_LIVE_TOOL_FACT_CHARS = 180;
const FEISHU_MEMORY_STORE_MAX_PROFILE_FACTS = 48;
const FEISHU_MEMORY_STORE_MAX_ROLE_FACTS = 24;
const FEISHU_MEMORY_STORE_MAX_HISTORY_ITEMS = 240;
const FEISHU_MEMORY_STORE_MAX_RECENT_TURNS = 24;
const FEISHU_MEMORY_STORE_MAX_LIVE_TOOL_FACTS = 24;
const FEISHU_MEMORY_KEYWORD_PATTERN = /[\p{L}\p{N}]{2,12}/gu;
const FEISHU_CROSS_CHAT_LOG_TAIL_LINES = 1600;
const FEISHU_CROSS_CHAT_LIST_LIMIT = 8;
const FEISHU_CROSS_CHAT_MESSAGE_LIMIT = 8;
const FEISHU_CROSS_CHAT_PREVIEW_CHARS = 160;
const CODEX_EXEC_LOCK_STALE_MS = 6 * 60 * 60 * 1000;

function getArg(flag, fallback = '') {
  const idx = process.argv.indexOf(flag);
  if (idx >= 0 && idx + 1 < process.argv.length) return process.argv[idx + 1];
  return fallback;
}

function ensure(cond, msg) {
  if (!cond) throw new Error(msg);
}

function readJsonIfExists(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const raw = fs.readFileSync(filePath, 'utf8');
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`invalid json in ${filePath}: ${err.message}`);
  }
}

function readLogTail(filePath, lineLimit = 240) {
  if (!fs.existsSync(filePath)) return [];
  const raw = fs.readFileSync(filePath, 'utf8');
  const lines = raw.split(/\r?\n/).filter((line) => line.length > 0);
  return lines.slice(-Math.max(1, Number(lineLimit) || 1));
}

function parseKvLine(line) {
  const match = String(line || '').match(/^([a-z0-9_]+)=(.*)$/i);
  if (!match) return null;
  return {
    key: match[1],
    value: match[2],
  };
}

function asBool(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function asInt(value, fallback, min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number.parseInt(String(value), 10);
  if (Number.isNaN(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function asFloat(value, fallback, min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number.parseFloat(String(value));
  if (Number.isNaN(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function normalizeString(value) {
  return String(value || '').trim();
}

function ensureDirSync(dirPath) {
  if (!dirPath) return;
  fs.mkdirSync(dirPath, { recursive: true });
}

function resolveOptionalDir(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  return path.resolve(raw);
}

function resolveOptionalDirList(value) {
  const parts = Array.isArray(value)
    ? value
    : String(value || '')
      .split(new RegExp(`[\\n,${path.delimiter.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}]`, 'g'));
  const out = [];
  for (const part of parts) {
    const resolved = resolveOptionalDir(part);
    if (!resolved || out.includes(resolved)) continue;
    out.push(resolved);
  }
  return out;
}

function resolveOptionalPath(value, baseDir = '') {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (path.isAbsolute(raw)) return path.resolve(raw);
  return path.resolve(baseDir || process.cwd(), raw);
}

function removePathSync(targetPath) {
  if (!targetPath) return;
  fs.rmSync(targetPath, { recursive: true, force: true });
}

async function waitForNonEmptyFile(filePath, timeoutMs = 1200, intervalMs = 80) {
  const deadline = Date.now() + Math.max(0, Number(timeoutMs) || 0);
  while (Date.now() <= deadline) {
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      if (String(content || '').trim()) return content;
    } catch (_) {
      // keep polling until timeout
    }
    await new Promise((resolve) => setTimeout(resolve, Math.max(10, Number(intervalMs) || 80)));
  }
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (_) {
    return '';
  }
}

function copyDirFilteredSync(sourceDir, targetDir, {
  skipNames = new Set(),
  skipRelativePrefixes = [],
} = {}) {
  ensureDirSync(targetDir);
  const entries = fs.readdirSync(sourceDir, { withFileTypes: true });
  for (const entry of entries) {
    if (skipNames.has(entry.name)) continue;
    const sourcePath = path.join(sourceDir, entry.name);
    const targetPath = path.join(targetDir, entry.name);
    const relativePath = path.relative(sourceDir, sourcePath);
    if (skipRelativePrefixes.some((prefix) => relativePath === prefix || relativePath.startsWith(`${prefix}${path.sep}`))) {
      continue;
    }
    if (entry.isDirectory()) {
      copyDirFilteredSync(sourcePath, targetPath, {
        skipNames,
        skipRelativePrefixes,
      });
      continue;
    }
    fs.copyFileSync(sourcePath, targetPath);
  }
}

function readTextFileIfExists(filePath) {
  const target = String(filePath || '').trim();
  if (!target) return '';
  try {
    return fs.readFileSync(target, 'utf8');
  } catch (_) {
    return '';
  }
}

function writeTextFileIfChanged(filePath, nextContent) {
  const target = String(filePath || '').trim();
  if (!target) return false;
  const normalizedNext = String(nextContent || '');
  const previous = readTextFileIfExists(target);
  if (previous === normalizedNext) return false;
  ensureDirSync(path.dirname(target));
  fs.writeFileSync(target, normalizedNext);
  return true;
}

function getRealPathSafe(filePath) {
  try {
    return fs.realpathSync(filePath);
  } catch (_) {
    return '';
  }
}

function sameRealPath(leftPath, rightPath) {
  const leftReal = getRealPathSafe(leftPath);
  const rightReal = getRealPathSafe(rightPath);
  return Boolean(leftReal && rightReal && leftReal === rightReal);
}

function syncSharedCodexAuthSymlink(sourceAuthPath, targetAuthPath) {
  if (!sourceAuthPath || !targetAuthPath) {
    return { changed: false, skipped: true, reason: 'auth_path_missing' };
  }
  if (path.resolve(sourceAuthPath) === path.resolve(targetAuthPath)) {
    return { changed: false, skipped: true, reason: 'same_auth' };
  }
  if (!fs.existsSync(sourceAuthPath)) {
    return { changed: false, skipped: true, reason: 'source_auth_missing' };
  }

  ensureDirSync(path.dirname(targetAuthPath));
  try {
    const stat = fs.lstatSync(targetAuthPath);
    if (stat.isSymbolicLink() && sameRealPath(targetAuthPath, sourceAuthPath)) {
      return { changed: false, skipped: false, reason: 'shared_auth_current', targetAuthPath };
    }

    if (stat.isSymbolicLink()) {
      fs.unlinkSync(targetAuthPath);
    } else {
      const backupPath = `${targetAuthPath}.bak-${Date.now()}`;
      fs.renameSync(targetAuthPath, backupPath);
    }
  } catch (err) {
    if (err?.code !== 'ENOENT') {
      return {
        changed: false,
        skipped: true,
        reason: `target_auth_prepare_failed:${err.message}`,
        targetAuthPath,
      };
    }
  }

  fs.symlinkSync(sourceAuthPath, targetAuthPath);
  return { changed: true, skipped: false, reason: 'linked_shared_auth', targetAuthPath };
}

function isProcessAlive(pid) {
  const numericPid = Number(pid);
  if (!Number.isFinite(numericPid) || numericPid <= 0) return false;
  try {
    process.kill(numericPid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

function readCodexExecLockOwner() {
  const ownerPath = path.join(FEISHU_CODEX_EXEC_LOCK_DIR, 'owner.json');
  try {
    return JSON.parse(fs.readFileSync(ownerPath, 'utf8'));
  } catch (_) {
    return null;
  }
}

function isCodexExecLockStale() {
  let stat = null;
  try {
    stat = fs.statSync(FEISHU_CODEX_EXEC_LOCK_DIR);
  } catch (_) {
    return false;
  }
  const owner = readCodexExecLockOwner();
  const pid = Number(owner?.pid || 0);
  if (pid && !isProcessAlive(pid)) return true;
  return Date.now() - Number(stat.mtimeMs || 0) > CODEX_EXEC_LOCK_STALE_MS;
}

async function acquireCodexExecLock(label = 'codex') {
  if (process.env.FEISHU_DISABLE_CODEX_EXEC_LOCK === '1') {
    return () => {};
  }

  ensureDirSync(FEISHU_RUNTIME_DIR);
  const token = randomBytes(8).toString('hex');
  const startedAt = Date.now();
  let lastWaitLogAt = 0;
  while (true) {
    try {
      fs.mkdirSync(FEISHU_CODEX_EXEC_LOCK_DIR);
      fs.writeFileSync(
        path.join(FEISHU_CODEX_EXEC_LOCK_DIR, 'owner.json'),
        `${JSON.stringify({
          pid: process.pid,
          label,
          token,
          created_at: new Date().toISOString(),
        }, null, 2)}\n`
      );
      return () => {
        const owner = readCodexExecLockOwner();
        if (owner?.pid !== process.pid || owner?.token !== token) return;
        fs.rmSync(FEISHU_CODEX_EXEC_LOCK_DIR, { recursive: true, force: true });
      };
    } catch (err) {
      if (err?.code !== 'EEXIST') throw err;
      if (isCodexExecLockStale()) {
        fs.rmSync(FEISHU_CODEX_EXEC_LOCK_DIR, { recursive: true, force: true });
        continue;
      }
      const now = Date.now();
      if (now - startedAt > 5000 && now - lastWaitLogAt > 30000) {
        const owner = readCodexExecLockOwner();
        console.log(`codex_exec_lock_wait label=${JSON.stringify(label)} owner_pid=${owner?.pid || '(unknown)'}`);
        lastWaitLogAt = now;
      }
      await sleep(250 + Math.floor(Math.random() * 250));
    }
  }
}

function pickValue(candidates) {
  for (const [source, raw] of candidates) {
    const value = String(raw || '').trim();
    if (!value) continue;
    return { value, source };
  }
  return { value: '', source: '' };
}

function readCodexAuthSummary(codexHome = '') {
  const resolvedHome = String(codexHome || '').trim()
    ? path.resolve(String(codexHome || '').trim())
    : path.join(os.homedir(), '.codex');
  const authPath = path.join(resolvedHome, 'auth.json');
  const authText = readTextFileIfExists(authPath);
  const summary = {
    home: resolvedHome,
    authPath,
    exists: Boolean(authText),
    authMode: '',
    openaiApiKey: '',
    hasTokens: false,
  };
  if (!authText) return summary;
  try {
    const parsed = JSON.parse(authText);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return summary;
    summary.authMode = String(parsed.auth_mode || '').trim();
    summary.openaiApiKey = String(parsed.OPENAI_API_KEY || '').trim();
    summary.hasTokens = Boolean(parsed.tokens && typeof parsed.tokens === 'object');
  } catch (_) {
    return summary;
  }
  return summary;
}

function loadFeishuConfig(accountName, configDir) {
  const defaultPath = path.resolve(configDir, 'default.json');
  const defaultConfig = deepMerge(
    readJsonIfExists(defaultPath) || {},
    readConfigEntry('feishu', 'default', {})
  );
  const chosen = accountName || 'default';

  if (chosen === 'default') {
    return {
      accountName: 'default',
      config: defaultConfig,
      configPath: fs.existsSync(defaultPath) ? defaultPath : resolveSecretsFile(),
    };
  }

  const accountPath = path.resolve(configDir, `${chosen}.json`);
  const accountConfig = readJsonIfExists(accountPath);
  const yamlConfig = readConfigEntry('feishu', chosen, {});
  ensure(accountConfig || Object.keys(yamlConfig).length > 0, `feishu config not found: ${accountPath}`);
  return {
    accountName: chosen,
    config: deepMerge(defaultConfig, accountConfig || {}, yamlConfig),
    configPath: fs.existsSync(accountPath) ? accountPath : resolveSecretsFile(),
  };
}

function resolveDomain(domainValue) {
  const raw = String(domainValue || '').trim();
  if (!raw || raw.toLowerCase() === 'feishu') {
    return { value: lark.Domain.Feishu, label: 'feishu' };
  }
  if (raw.toLowerCase() === 'lark') {
    return { value: lark.Domain.Lark, label: 'lark' };
  }
  if (/^https?:\/\/\S+$/i.test(raw)) {
    return { value: raw.replace(/\/+$/, ''), label: raw.replace(/\/+$/, '') };
  }
  throw new Error(`invalid domain "${raw}", expected feishu | lark | https://open.xxx.com`);
}

function resolveCredentials(config) {
  const appId = pickValue([
    ['cli', getArg('--app-id', '')],
    ['env', process.env.FEISHU_APP_ID || ''],
    ['config', config.app_id || ''],
  ]);
  const appSecret = pickValue([
    ['cli', getArg('--app-secret', '')],
    ['env', process.env.FEISHU_APP_SECRET || ''],
    ['config', config.app_secret || ''],
  ]);
  const encryptKey = pickValue([
    ['cli', getArg('--encrypt-key', '')],
    ['env', process.env.FEISHU_ENCRYPT_KEY || ''],
    ['config', config.encrypt_key || ''],
  ]);
  const verificationToken = pickValue([
    ['cli', getArg('--verification-token', '')],
    ['env', process.env.FEISHU_VERIFICATION_TOKEN || ''],
    ['config', config.verification_token || ''],
  ]);
  const botOpenId = pickValue([
    ['cli', getArg('--bot-open-id', '')],
    ['env', process.env.FEISHU_BOT_OPEN_ID || ''],
    ['config', config.bot_open_id || ''],
  ]);

  return {
    appId,
    appSecret,
    encryptKey,
    verificationToken,
    botOpenId,
  };
}

function resolveReplyMode(config) {
  const raw = String(getArg('--reply-mode', process.env.FEISHU_REPLY_MODE || config.reply_mode || 'codex')).trim().toLowerCase();
  if (raw === 'codex' || raw === 'echo' || raw === 'local_model') return raw;
  throw new Error(`invalid reply_mode "${raw}", expected codex | echo | local_model`);
}

function resolveProgressConfig(config) {
  const progress = config.progress || {};
  const cliEnabled = getArg('--progress-notice', '');
  const envEnabled = process.env.FEISHU_PROGRESS_NOTICE;
  let enabled = true;
  if (cliEnabled !== '') {
    enabled = asBool(cliEnabled, true);
  } else if (progress.enabled !== undefined) {
    enabled = asBool(progress.enabled, true);
  } else if (envEnabled !== undefined && envEnabled !== '') {
    enabled = asBool(envEnabled, true);
  }

  const cliMessage = getArg('--progress-message', '');
  const message = String(
    cliMessage
      || progress.message
      || process.env.FEISHU_PROGRESS_MESSAGE
      || '已接收，正在执行。'
  ).trim();
  const doc = progress.doc || {};
  const titlePrefix = String(
    getArg(
      '--progress-doc-title-prefix',
      process.env.FEISHU_PROGRESS_DOC_TITLE_PREFIX || doc.title_prefix || 'Codex 任务进度'
    )
  ).trim() || 'Codex 任务进度';
  const shareToChat = asBool(
    getArg(
      '--progress-doc-share-to-chat',
      process.env.FEISHU_PROGRESS_DOC_SHARE_TO_CHAT || doc.share_to_chat
    ),
    true
  );
  const shareLinkScopeRaw = String(
    getArg(
      '--progress-doc-link-scope',
      process.env.FEISHU_PROGRESS_DOC_LINK_SCOPE || doc.link_scope || 'same_tenant'
    )
  ).trim().toLowerCase();
  const linkScope = VALID_PROGRESS_DOC_LINK_SCOPES.has(shareLinkScopeRaw)
    ? shareLinkScopeRaw
    : 'same_tenant';
  const includeUserMessage = asBool(
    getArg(
      '--progress-doc-include-user-message',
      process.env.FEISHU_PROGRESS_DOC_INCLUDE_USER_MESSAGE || doc.include_user_message
    ),
    true
  );
  const writeFinalReply = asBool(
    getArg(
      '--progress-doc-write-final-reply',
      process.env.FEISHU_PROGRESS_DOC_WRITE_FINAL_REPLY || doc.write_final_reply
    ),
    true
  );
  return {
    enabled,
    message: message || '已接收，正在执行。',
    mode: 'doc',
    doc: {
      titlePrefix,
      shareToChat,
      linkScope,
      includeUserMessage,
      writeFinalReply,
    },
  };
}

function resolveTypingConfig(config) {
  const typing = config.typing_indicator || {};
  const enabled = asBool(
    getArg('--typing-indicator', process.env.FEISHU_TYPING_INDICATOR || typing.enabled),
    true
  );
  const emoji = String(
    getArg('--typing-emoji', process.env.FEISHU_TYPING_EMOJI || typing.emoji || 'Typing')
  ).trim() || 'Typing';
  return { enabled, emoji };
}

function resolveMentionConfig(config) {
  const cliRequireMention = getArg('--require-mention', '');
  const envRequireMention = process.env.FEISHU_REQUIRE_MENTION;
  const cfgRequireMention = config.require_mention;

  const cliGroupOnly = getArg('--require-mention-group-only', '');
  const envGroupOnly = process.env.FEISHU_REQUIRE_MENTION_GROUP_ONLY;
  const cfgGroupOnly = config.require_mention_group_only;

  let requireMention = true;
  if (cliRequireMention !== '') {
    requireMention = asBool(cliRequireMention, true);
  } else if (cfgRequireMention !== undefined) {
    requireMention = asBool(cfgRequireMention, true);
  } else if (envRequireMention !== undefined && envRequireMention !== '') {
    requireMention = asBool(envRequireMention, true);
  }

  let groupOnly = true;
  if (cliGroupOnly !== '') {
    groupOnly = asBool(cliGroupOnly, true);
  } else if (cfgGroupOnly !== undefined) {
    groupOnly = asBool(cfgGroupOnly, true);
  } else if (envGroupOnly !== undefined && envGroupOnly !== '') {
    groupOnly = asBool(envGroupOnly, true);
  }

  return {
    requireMention,
    groupOnly,
  };
}

function resolveFakeStreamConfig(config) {
  const fake = config.fake_stream || {};
  return {
    enabled: asBool(
      getArg('--fake-stream', process.env.FEISHU_FAKE_STREAM || fake.enabled),
      false
    ),
    intervalMs: asInt(
      getArg('--fake-stream-interval-ms', process.env.FEISHU_FAKE_STREAM_INTERVAL_MS || fake.interval_ms),
      120,
      20,
      2000
    ),
    chunkChars: asInt(
      getArg('--fake-stream-chunk-chars', process.env.FEISHU_FAKE_STREAM_CHUNK_CHARS || fake.chunk_chars),
      1,
      1,
      128
    ),
    maxUpdates: asInt(
      getArg('--fake-stream-max-updates', process.env.FEISHU_FAKE_STREAM_MAX_UPDATES || fake.max_updates),
      120,
      1,
      4000
    ),
  };
}

function resolvePersonalProxyConfig(config, accountName = '') {
  const raw = config.personal_proxy || config.personalProxy || {};
  const enabled = asBool(
    getArg('--personal-proxy', process.env.FEISHU_PERSONAL_PROXY || raw.enabled),
    false
  );
  const ownerBindCommand = normalizeString(
    getArg(
      '--personal-proxy-bind-command',
      process.env.FEISHU_PERSONAL_PROXY_BIND_COMMAND || raw.owner_bind_command || raw.ownerBindCommand || '/proxy bind-owner'
    )
  ) || '/proxy bind-owner';
  const sensitivityMode = normalizeString(
    getArg(
      '--personal-proxy-sensitivity-mode',
      process.env.FEISHU_PERSONAL_PROXY_SENSITIVITY_MODE || raw.sensitivity_mode || raw.sensitivityMode || 'conservative'
    )
  ).toLowerCase() || 'conservative';
  const approvalTtlMinutes = asInt(
    getArg(
      '--personal-proxy-approval-ttl-minutes',
      process.env.FEISHU_PERSONAL_PROXY_APPROVAL_TTL_MINUTES || raw.approval_ttl_minutes || raw.approvalTtlMinutes
    ),
    30,
    1,
    24 * 60
  );
  const sessionGrantTtlMinutes = asInt(
    getArg(
      '--personal-proxy-session-grant-ttl-minutes',
      process.env.FEISHU_PERSONAL_PROXY_SESSION_GRANT_TTL_MINUTES || raw.session_grant_ttl_minutes || raw.sessionGrantTtlMinutes
    ),
    approvalTtlMinutes,
    1,
    24 * 60
  );

  return {
    enabled,
    accountName: normalizeString(accountName),
    botName: normalizeString(config.bot_name || config.botName),
    ownerBindCommand,
    sensitivityMode,
    approvalTtlMinutes,
    sessionGrantTtlMinutes,
  };
}

function resolveCodexConfig(config) {
  const codexConfig = config.codex || {};
  const sandbox = String(
    getArg('--codex-sandbox', process.env.FEISHU_CODEX_SANDBOX || codexConfig.sandbox || 'danger-full-access')
  ).trim();
  ensure(
    VALID_CODEX_SANDBOXES.has(sandbox),
    `invalid codex sandbox "${sandbox}", expected ${Array.from(VALID_CODEX_SANDBOXES).join(' | ')}`
  );
  const approvalPolicy = String(
    getArg(
      '--codex-approval-policy',
      process.env.FEISHU_CODEX_APPROVAL_POLICY || codexConfig.approval_policy || 'never'
    )
  ).trim();
  ensure(
    VALID_CODEX_APPROVAL_POLICIES.has(approvalPolicy),
    `invalid codex approval_policy "${approvalPolicy}", expected ${Array.from(VALID_CODEX_APPROVAL_POLICIES).join(' | ')}`
  );
  const cwd = resolveOptionalDir(getArg('--codex-cd', process.env.FEISHU_CODEX_CD || codexConfig.cwd || ''));
  const home = ensureCodexHomeReady(
    getArg('--codex-home', process.env.FEISHU_CODEX_HOME || codexConfig.home || '')
  );
  const homeProviderSync = syncCodexHomeProviderConfig(home);
  const homeAuthSync = syncCodexHomeAuth(home);
  const addDirs = resolveOptionalDirList(
    getArg('--codex-add-dirs', process.env.FEISHU_CODEX_ADD_DIRS || codexConfig.add_dirs || codexConfig.addDirs || '')
  ).filter((dir) => dir !== cwd);
  const cliApiKey = String(getArg('--codex-api-key', '')).trim();
  const selectedApiKey = cliApiKey
    ? {
      value: cliApiKey,
      source: 'cli',
      runtimeProvider: deriveCodexRuntimeProvider({ home, api_key: codexConfig.api_key || '' }),
    }
    : selectCodexApiKey({ home, api_key: codexConfig.api_key || '' });

  return {
    bin: String(getArg('--codex-bin', process.env.FEISHU_CODEX_BIN || codexConfig.bin || 'codex')).trim() || 'codex',
    model: String(getArg('--codex-model', process.env.FEISHU_CODEX_MODEL || codexConfig.model || '')).trim(),
    reasoningEffort: String(
      getArg(
        '--codex-reasoning-effort',
        process.env.FEISHU_CODEX_REASONING_EFFORT || codexConfig.reasoning_effort || ''
      )
    ).trim(),
    profile: String(getArg('--codex-profile', process.env.FEISHU_CODEX_PROFILE || codexConfig.profile || '')).trim(),
    home,
    cwd,
    addDirs,
    // Intentionally disable execution timeout: wait until the task exits naturally.
    timeoutSec: 0,
    historyTurns: asInt(getArg('--history-turns', process.env.FEISHU_HISTORY_TURNS || codexConfig.history_turns), 6, 0, 20),
    systemPrompt: mergeTalkNormalPrompt(
      String(getArg('--system-prompt', process.env.FEISHU_CODEX_SYSTEM_PROMPT || codexConfig.system_prompt || DEFAULT_CODEX_SYSTEM_PROMPT)).trim(),
      DEFAULT_CODEX_SYSTEM_PROMPT
    ),
    apiKey: selectedApiKey.value,
    apiKeySource: selectedApiKey.source,
    runtimeProvider: selectedApiKey.runtimeProvider,
    homeProviderSync,
    homeAuthSync,
    sandbox,
    approvalPolicy,
    modelRoutes: resolveCodexModelRoutes(codexConfig),
  };
}

function normalizeModelRouteKeywords(value) {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeString(item)).filter(Boolean);
  }
  const text = normalizeString(value);
  if (!text) return [];
  return text
    .split(/[\n,，、|]+/g)
    .map((item) => normalizeString(item))
    .filter(Boolean);
}

function resolveCodexModelRoutes(codexConfig = {}) {
  const routes = codexConfig.model_routes || codexConfig.modelRoutes || {};
  const writingRaw = routes.writing_request
    || routes.writingRequest
    || routes.writing
    || {};
  const nonCodingRaw = routes.non_coding_request
    || routes.nonCodingRequest
    || routes.non_coding
    || routes.nonCoding
    || {};
  const hasWritingRoute = writingRaw && Object.keys(writingRaw).length > 0;
  const hasNonCodingRoute = nonCodingRaw && Object.keys(nonCodingRaw).length > 0;
  const writingModel = normalizeString(
    getArg(
      '--codex-writing-model',
      process.env.FEISHU_CODEX_WRITING_MODEL || writingRaw.model || ''
    )
  );
  const writingReasoningEffort = normalizeString(
    getArg(
      '--codex-writing-reasoning-effort',
      process.env.FEISHU_CODEX_WRITING_REASONING_EFFORT || writingRaw.reasoning_effort || writingRaw.reasoningEffort || ''
    )
  );
  const nonCodingModel = normalizeString(
    getArg(
      '--codex-non-coding-model',
      process.env.FEISHU_CODEX_NON_CODING_MODEL || nonCodingRaw.model || ''
    )
  );
  const nonCodingReasoningEffort = normalizeString(
    getArg(
      '--codex-non-coding-reasoning-effort',
      process.env.FEISHU_CODEX_NON_CODING_REASONING_EFFORT || nonCodingRaw.reasoning_effort || nonCodingRaw.reasoningEffort || ''
    )
  );
  const writingConfiguredTriggers = normalizeModelRouteKeywords(
    writingRaw.trigger_keywords
      || writingRaw.triggerKeywords
      || writingRaw.triggers
      || writingRaw.keywords
      || ''
  );
  const configuredTriggers = normalizeModelRouteKeywords(
    nonCodingRaw.trigger_keywords
      || nonCodingRaw.triggerKeywords
      || nonCodingRaw.triggers
      || nonCodingRaw.keywords
      || ''
  );
  return {
    writingRequest: {
      enabled: asBool(writingRaw.enabled, hasWritingRoute || Boolean(writingModel)),
      model: writingModel,
      reasoningEffort: writingReasoningEffort,
      triggerKeywords: uniqueStrings([
        ...DEFAULT_WRITING_MODEL_ROUTE_TRIGGERS,
        ...writingConfiguredTriggers,
      ]),
    },
    nonCodingRequest: {
      enabled: asBool(nonCodingRaw.enabled, hasNonCodingRoute || Boolean(nonCodingModel)),
      model: nonCodingModel,
      reasoningEffort: nonCodingReasoningEffort,
      triggerKeywords: uniqueStrings([
        ...DEFAULT_NON_CODING_MODEL_ROUTE_TRIGGERS,
        ...configuredTriggers,
      ]),
    },
  };
}

function normalizeModelRouteTriggerText(value) {
  return normalizeString(value).toLowerCase().replace(/\s+/g, '');
}

function matchesModelRouteTrigger(text, keywords = []) {
  const raw = normalizeString(text);
  if (!raw) return '';
  const normalizedText = normalizeModelRouteTriggerText(raw);
  for (const keyword of keywords || []) {
    const normalizedKeyword = normalizeModelRouteTriggerText(keyword);
    if (!normalizedKeyword) continue;
    if (normalizedText.includes(normalizedKeyword)) return keyword;
  }
  return '';
}

function selectCodexConfigForUserText(codex, userText = '') {
  const candidates = [
    ['writing_request', codex?.modelRoutes?.writingRequest || {}],
    ['non_coding_request', codex?.modelRoutes?.nonCodingRequest || {}],
  ];
  for (const [name, route] of candidates) {
    if (!route.enabled) continue;
    const matchedKeyword = matchesModelRouteTrigger(userText, route.triggerKeywords || []);
    if (!matchedKeyword) continue;
    const model = normalizeString(route.model) || normalizeString(codex.model);
    const reasoningEffort = normalizeString(route.reasoningEffort) || normalizeString(codex.reasoningEffort);
    if (!model && !reasoningEffort) continue;
    return {
      ...codex,
      model,
      reasoningEffort,
      activeModelRoute: {
        name,
        matchedKeyword,
        model,
        reasoningEffort,
      },
    };
  }
  return codex;
}

function printCodexModelRouteConfig(codex) {
  const writingRoute = codex?.modelRoutes?.writingRequest || {};
  const writingTriggerCount = Array.isArray(writingRoute.triggerKeywords) ? writingRoute.triggerKeywords.length : 0;
  console.log(`codex_writing_route=${writingRoute.enabled ? 'true' : 'false'}`);
  console.log(`codex_writing_model=${writingRoute.model || '(default)'}`);
  console.log(`codex_writing_reasoning_effort=${writingRoute.reasoningEffort || '(default)'}`);
  console.log(`codex_writing_trigger_count=${writingTriggerCount}`);
  const route = codex?.modelRoutes?.nonCodingRequest || {};
  const triggerCount = Array.isArray(route.triggerKeywords) ? route.triggerKeywords.length : 0;
  console.log(`codex_non_coding_route=${route.enabled ? 'true' : 'false'}`);
  console.log(`codex_non_coding_model=${route.model || '(default)'}`);
  console.log(`codex_non_coding_reasoning_effort=${route.reasoningEffort || '(default)'}`);
  console.log(`codex_non_coding_trigger_count=${triggerCount}`);
}

function resolveLocalModelConfig(config) {
  const localModelConfig = config.local_model || config.localModel || {};
  const cwd = resolveOptionalDir(
    getArg('--local-model-cwd', process.env.FEISHU_LOCAL_MODEL_CWD || localModelConfig.cwd || '')
  );
  const promptScript = resolveOptionalPath(
    getArg(
      '--local-model-prompt-script',
      process.env.FEISHU_LOCAL_MODEL_PROMPT_SCRIPT
        || localModelConfig.prompt_script
        || localModelConfig.promptScript
        || (cwd ? 'prompt.sh' : '')
    ),
    cwd || process.cwd()
  );

  return {
    cwd,
    promptScript,
    serverBaseUrl: String(
      getArg(
        '--local-model-server-base-url',
        process.env.FEISHU_LOCAL_MODEL_SERVER_BASE_URL || localModelConfig.server_base_url || localModelConfig.serverBaseUrl || ''
      )
    ).trim().replace(/\/+$/, ''),
    requestTimeoutMs: asInt(
      getArg(
        '--local-model-request-timeout-ms',
        process.env.FEISHU_LOCAL_MODEL_REQUEST_TIMEOUT_MS || localModelConfig.request_timeout_ms || localModelConfig.requestTimeoutMs
      ),
      180000,
      1000,
      1800000
    ),
    model: String(
      getArg('--local-model-model', process.env.FEISHU_LOCAL_MODEL_MODEL || localModelConfig.model || '')
    ).trim(),
    maxKvSize: asInt(
      getArg('--local-model-max-kv-size', process.env.FEISHU_LOCAL_MODEL_MAX_KV_SIZE || localModelConfig.max_kv_size || localModelConfig.maxKvSize),
      1024,
      64,
      262144
    ),
    maxTokens: asInt(
      getArg('--local-model-max-tokens', process.env.FEISHU_LOCAL_MODEL_MAX_TOKENS || localModelConfig.max_tokens || localModelConfig.maxTokens),
      384,
      1,
      8192
    ),
    temp: asFloat(
      getArg('--local-model-temp', process.env.FEISHU_LOCAL_MODEL_TEMP || localModelConfig.temp),
      0.2,
      0,
      2
    ),
    historyTurns: asInt(
      getArg('--local-model-history-turns', process.env.FEISHU_LOCAL_MODEL_HISTORY_TURNS || localModelConfig.history_turns || localModelConfig.historyTurns),
      4,
      0,
      20
    ),
    systemPrompt: mergeTalkNormalPrompt(
      String(
        getArg(
          '--local-model-system-prompt',
          process.env.FEISHU_LOCAL_MODEL_SYSTEM_PROMPT || localModelConfig.system_prompt || localModelConfig.systemPrompt || DEFAULT_LOCAL_MODEL_SYSTEM_PROMPT
        )
      ).trim(),
      DEFAULT_LOCAL_MODEL_SYSTEM_PROMPT
    ) || DEFAULT_LOCAL_MODEL_SYSTEM_PROMPT,
  };
}

function resolveMemoryConfig(config) {
  const memoryConfig = config.memory || {};
  return {
    enabled: asBool(getArg('--memory-enabled', process.env.FEISHU_MEMORY_ENABLED || memoryConfig.enabled), true),
    roleMemory: String(
      getArg(
        '--memory-role-memory',
        process.env.FEISHU_MEMORY_ROLE_MEMORY || memoryConfig.role_memory || memoryConfig.roleMemory || ''
      )
    ).trim(),
  };
}

function detectBinary(bin, versionArgs = ['-version']) {
  const raw = String(bin || '').trim();
  if (!raw) return { found: false, version: '' };
  try {
    const run = spawnSync(raw, versionArgs, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    if (run.status !== 0) return { found: false, version: '' };
    const version = String(run.stdout || run.stderr || '').trim().split(/\r?\n/)[0] || '';
    return { found: true, version };
  } catch (_) {
    return { found: false, version: '' };
  }
}

function resolveFfmpegConfig(config) {
  const speechConfig = config.speech || {};
  const candidates = uniqueStrings([
    getArg('--speech-ffmpeg-bin', ''),
    process.env.FEISHU_SPEECH_FFMPEG_BIN || '',
    speechConfig.ffmpeg_bin || '',
    ffmpegStatic || '',
    'ffmpeg',
  ]);

  for (const bin of candidates) {
    const detected = detectBinary(bin);
    if (detected.found) {
      return {
        bin,
        version: detected.version,
      };
    }
  }

  return {
    bin: '',
    version: '',
  };
}

function resolveSpeechConfig(config, codex = {}) {
  const speechConfig = config.speech || {};
  const apiKey = pickValue([
    ['cli', getArg('--speech-api-key', '')],
    ['env', process.env.FEISHU_SPEECH_API_KEY || ''],
    ['config', speechConfig.api_key || ''],
    ['env_openai', process.env.OPENAI_API_KEY || ''],
    ['env_codex', process.env.CODEX_API_KEY || ''],
    [codex.apiKeySource || 'codex', codex.apiKey || ''],
  ]);
  const ffmpeg = resolveFfmpegConfig(config);
  const baseURL = String(
    getArg(
      '--speech-base-url',
      process.env.FEISHU_SPEECH_BASE_URL
        || process.env.OPENAI_BASE_URL
        || process.env.OPENAI_API_BASE
        || speechConfig.base_url
        || 'https://api.openai.com/v1'
    )
  ).trim().replace(/\/+$/, '') || 'https://api.openai.com/v1';

  return {
    enabled: asBool(getArg('--speech-enabled', process.env.FEISHU_SPEECH_ENABLED || speechConfig.enabled), true),
    model: String(
      getArg(
        '--speech-model',
        process.env.FEISHU_SPEECH_MODEL || speechConfig.model || 'gpt-4o-mini-transcribe'
      )
    ).trim() || 'gpt-4o-mini-transcribe',
    language: String(
      getArg(
        '--speech-language',
        process.env.FEISHU_SPEECH_LANGUAGE || speechConfig.language || ''
      )
    ).trim(),
    apiKey: apiKey.value,
    apiKeySource: apiKey.source,
    baseURL,
    ffmpegBin: ffmpeg.bin,
    ffmpegVersion: ffmpeg.version,
  };
}

function detectCodex(bin) {
  return detectBinary(bin, ['--version']);
}

function detectLocalModel(localModel) {
  const cwd = String(localModel?.cwd || '').trim();
  const promptScript = String(localModel?.promptScript || '').trim();
  const serverBaseUrl = String(localModel?.serverBaseUrl || '').trim();
  const cwdFound = Boolean(cwd && fs.existsSync(cwd));
  const promptScriptFound = Boolean(promptScript && fs.existsSync(promptScript));
  return {
    cwdFound,
    promptScriptFound,
    serverConfigured: Boolean(serverBaseUrl),
    ready: cwdFound && (promptScriptFound || Boolean(serverBaseUrl)),
  };
}

function parseMessageText(rawContent) {
  const content = String(rawContent || '').trim();
  if (!content) return '';
  try {
    const parsed = JSON.parse(content);
    if (parsed && typeof parsed.text === 'string') return parsed.text.trim();
  } catch (_) {
    return '';
  }
  return '';
}

function safeParseMessageContent(rawContent) {
  const content = String(rawContent || '').trim();
  if (!content) return null;
  try {
    return JSON.parse(content);
  } catch (_) {
    return null;
  }
}

function normalizeStructuredTextValue(rawValue, maxLength = 500) {
  const text = String(rawValue || '')
    .replace(/\r/g, '\n')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return '';
  if (text.length > maxLength) return `${text.slice(0, maxLength)}...`;
  return text;
}

function collectStructuredFieldValues(root, targetKeys, maxValues = 8) {
  const wanted = new Set(
    (Array.isArray(targetKeys) ? targetKeys : [targetKeys])
      .map((key) => String(key || '').trim().toLowerCase())
      .filter(Boolean)
  );
  if (!root || wanted.size === 0) return [];

  const results = [];
  const visited = new Set();
  const stack = [root];
  let loopGuard = 0;

  while (stack.length > 0 && results.length < maxValues && loopGuard < 4000) {
    loopGuard += 1;
    const current = stack.pop();
    if (current === null || current === undefined) continue;
    if (typeof current !== 'object') continue;
    if (visited.has(current)) continue;
    visited.add(current);

    if (Array.isArray(current)) {
      for (let i = current.length - 1; i >= 0; i -= 1) {
        stack.push(current[i]);
      }
      continue;
    }

    for (const [key, value] of Object.entries(current)) {
      const normalizedKey = String(key || '').trim().toLowerCase();
      if (wanted.has(normalizedKey) && (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')) {
        const normalizedValue = normalizeStructuredTextValue(value, 500);
        if (normalizedValue) results.push(normalizedValue);
      }
      if (value && typeof value === 'object') {
        stack.push(value);
      }
    }
  }

  return uniqueStrings(results);
}

function extractInlineTextFromParsedContent(parsed, options = {}) {
  const {
    keys = ['text', 'caption', 'description', 'summary', 'comment', 'message', 'content_text', 'contentText'],
    excludeValues = [],
    limit = 3,
  } = options || {};
  const excluded = new Set(
    (Array.isArray(excludeValues) ? excludeValues : [excludeValues])
      .map((value) => normalizeStructuredTextValue(value, 500).toLowerCase())
      .filter(Boolean)
  );
  return collectStructuredFieldValues(parsed, keys, Math.max(4, limit * 4))
    .map((value) => normalizeStructuredTextValue(value, 500))
    .filter((value) => value && !excluded.has(value.toLowerCase()))
    .slice(0, limit);
}

function extractQuotedMessageIdsFromParsedContent(parsed) {
  if (!parsed || typeof parsed !== 'object') return [];
  const quoteRoots = [
    parsed.quote,
    parsed.quote_container,
    parsed.quoteContainer,
    parsed.quoted,
  ].filter((item) => item && typeof item === 'object');

  return uniqueStrings([
    ...collectStructuredFieldValues(parsed, ['quote_message_id', 'quoteMessageId'], 4),
    ...quoteRoots.flatMap((item) => collectStructuredFieldValues(item, ['message_id', 'messageId'], 2)),
  ]);
}

function parseImageKey(rawContent) {
  const content = String(rawContent || '').trim();
  if (!content) return '';
  try {
    const parsed = JSON.parse(content);
    const imageKey = String(
      parsed?.image_key || parsed?.imageKey || parsed?.file_key || parsed?.fileKey || ''
    ).trim();
    return imageKey;
  } catch (_) {
    return '';
  }
}

function parseFileMessageContent(rawContent) {
  const content = String(rawContent || '').trim();
  if (!content) return { fileKey: '', fileName: '', fileSize: 0, text: '' };
  const parsed = safeParseMessageContent(content);
  if (!parsed) return { fileKey: '', fileName: '', fileSize: 0, text: '' };
  const fileKey = String(
    parsed?.file_key
    || parsed?.fileKey
    || parsed?.file?.file_key
    || parsed?.file?.fileKey
    || ''
  ).trim();
  const fileName = String(
    parsed?.file_name
    || parsed?.fileName
    || parsed?.name
    || parsed?.file?.file_name
    || parsed?.file?.fileName
    || parsed?.file?.name
    || ''
  ).trim();
  const rawSize = Number(
    parsed?.file_size
    || parsed?.fileSize
    || parsed?.size
    || parsed?.file?.file_size
    || parsed?.file?.fileSize
    || parsed?.file?.size
    || 0
  );
  const inlineText = extractInlineTextFromParsedContent(parsed, {
    excludeValues: [fileName],
    limit: 2,
  }).join('\n');
  return {
    fileKey,
    fileName,
    fileSize: Number.isFinite(rawSize) ? rawSize : 0,
    text: inlineText,
  };
}

function parseAudioMessageContent(rawContent) {
  const content = String(rawContent || '').trim();
  if (!content) return { fileKey: '', durationMs: 0 };
  try {
    const parsed = JSON.parse(content);
    const fileKey = String(
      parsed?.file_key
      || parsed?.fileKey
      || parsed?.audio_key
      || parsed?.audioKey
      || parsed?.audio?.file_key
      || parsed?.audio?.fileKey
      || parsed?.audio?.audio_key
      || parsed?.audio?.audioKey
      || ''
    ).trim();
    const rawDuration = Number(
      parsed?.duration
      || parsed?.duration_ms
      || parsed?.durationMs
      || parsed?.audio?.duration
      || parsed?.audio?.duration_ms
      || parsed?.audio?.durationMs
      || 0
    );
    return {
      fileKey,
      durationMs: Number.isFinite(rawDuration) ? rawDuration : 0,
    };
  } catch (_) {
    return { fileKey: '', durationMs: 0 };
  }
}

function uniqueStrings(items = []) {
  const out = [];
  const seen = new Set();
  for (const item of items) {
    const value = String(item || '').trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

function escapeRegExp(rawText) {
  return String(rawText || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseSimpleTomlValue(rawValue) {
  const text = String(rawValue || '').trim();
  if (!text) return '';
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    return text.slice(1, -1);
  }
  return text;
}

function readCodexHomeConfigSummary(codexHome = '') {
  const resolvedHome = resolveOptionalDir(codexHome);
  const configPath = resolvedHome ? path.join(resolvedHome, 'config.toml') : '';
  const configText = readTextFileIfExists(configPath);
  const summary = {
    home: resolvedHome,
    configPath,
    exists: Boolean(configText),
    modelProvider: '',
    providerName: '',
    providerBaseUrl: '',
  };
  if (!configText) return summary;

  const providerMatch = configText.match(/^\s*model_provider\s*=\s*(.+)\s*$/m);
  summary.modelProvider = parseSimpleTomlValue(providerMatch?.[1] || '');
  if (!summary.modelProvider) return summary;

  const providerPattern = new RegExp(
    `^\\s*\\[model_providers\\.${escapeRegExp(summary.modelProvider)}\\]\\s*$([\\s\\S]*?)(?=^\\s*\\[[^\\]]+\\]\\s*$|$)`,
    'm'
  );
  const sectionMatch = configText.match(providerPattern);
  const sectionText = sectionMatch?.[1] || '';
  if (!sectionText) return summary;

  const providerNameMatch = sectionText.match(/^\s*name\s*=\s*(.+)\s*$/m);
  const providerBaseUrlMatch = sectionText.match(/^\s*base_url\s*=\s*(.+)\s*$/m);
  summary.providerName = parseSimpleTomlValue(providerNameMatch?.[1] || '');
  summary.providerBaseUrl = parseSimpleTomlValue(providerBaseUrlMatch?.[1] || '');
  return summary;
}

function deriveCodexRuntimeProvider(codex = {}) {
  const homeSummary = readCodexHomeConfigSummary(codex.home || process.env.CODEX_HOME || path.join(os.homedir(), '.codex'));
  const provider = homeSummary.modelProvider || normalizeString(process.env.FEISHU_CODEX_PROVIDER || process.env.CODEX_MODEL_PROVIDER);
  const providerName = homeSummary.providerName || provider;
  return {
    provider,
    providerName,
    providerBaseUrl: homeSummary.providerBaseUrl,
    codexHome: homeSummary.home || normalizeString(codex.home || process.env.CODEX_HOME || path.join(os.homedir(), '.codex')),
    configPath: homeSummary.configPath || '',
  };
}

function selectCodexApiKey(codex = {}) {
  const runtimeProvider = deriveCodexRuntimeProvider(codex);
  const provider = String(runtimeProvider.provider || '').trim().toLowerCase();
  const primaryAuth = readCodexAuthSummary(runtimeProvider.codexHome || codex.home || '');
  const defaultAuthHome = path.join(os.homedir(), '.codex');
  const fallbackAuth = path.resolve(primaryAuth.home || '') === path.resolve(defaultAuthHome)
    ? { openaiApiKey: '' }
    : readCodexAuthSummary(defaultAuthHome);
  const candidates = [];

  if (provider === 'zerochat') {
    candidates.push(['env_zerochat', process.env.ZEROCHAT_API_KEY || '']);
    candidates.push(['env_openai', process.env.OPENAI_API_KEY || '']);
    candidates.push(['env_codex', process.env.CODEX_API_KEY || '']);
  } else {
    candidates.push(['env_openai', process.env.OPENAI_API_KEY || '']);
    candidates.push(['env_codex', process.env.CODEX_API_KEY || '']);
    candidates.push(['auth_home', primaryAuth.openaiApiKey || '']);
    candidates.push(['auth_default', fallbackAuth.openaiApiKey || '']);
  }

  candidates.push(['config', codex.api_key || codex.apiKey || '']);
  const selected = pickValue(candidates);
  return {
    ...selected,
    runtimeProvider,
  };
}

function syncCodexHomeProviderConfig(configuredHome) {
  const targetHome = resolveOptionalDir(configuredHome);
  if (!targetHome) return { changed: false, skipped: true, reason: 'home_missing' };

  const defaultHome = path.join(os.homedir(), '.codex');
  const sourceConfigPath = path.join(defaultHome, 'config.toml');
  const targetConfigPath = path.join(targetHome, 'config.toml');
  if (path.resolve(sourceConfigPath) === path.resolve(targetConfigPath)) {
    return { changed: false, skipped: true, reason: 'same_config' };
  }

  const sourceText = readTextFileIfExists(sourceConfigPath);
  const targetText = readTextFileIfExists(targetConfigPath);
  if (!sourceText || !targetText) {
    return {
      changed: false,
      skipped: true,
      reason: !sourceText ? 'source_config_missing' : 'target_config_missing',
    };
  }

  const sourceProviderMatch = sourceText.match(/^\s*model_provider\s*=\s*(.+)\s*$/m);
  const sourceProvider = parseSimpleTomlValue(sourceProviderMatch?.[1] || '');
  if (!sourceProvider) {
    let nextText = targetText;
    nextText = nextText.replace(/^\s*model_provider\s*=.*\n?/gm, '');
    nextText = nextText.replace(/^\s*\[model_providers\.[^\]]+\]\s*$[\s\S]*?(?=^\s*\[[^\]]+\]\s*$|$)/gm, '');
    nextText = nextText.replace(/^(?:\s*(?:name|base_url|wire_api|requires_openai_auth)\s*=.*\n)+/m, '');
    nextText = nextText.replace(/\n{3,}/g, '\n\n').trim();
    if (nextText) nextText = `${nextText}\n`;
    const changed = writeTextFileIfChanged(targetConfigPath, nextText);
    return {
      changed,
      skipped: false,
      reason: changed ? 'cleared_stale_provider' : 'provider_already_cleared',
      targetConfigPath,
    };
  }

  const sourceSectionPattern = new RegExp(
    `^\\s*\\[model_providers\\.${escapeRegExp(sourceProvider)}\\]\\s*$([\\s\\S]*?)(?=^\\s*\\[[^\\]]+\\]\\s*$|$)`,
    'm'
  );
  const sourceSectionMatch = sourceText.match(sourceSectionPattern);
  if (!sourceSectionMatch) {
    return { changed: false, skipped: true, reason: 'source_provider_section_missing' };
  }

  let nextText = targetText;
  if (/^\s*model_provider\s*=.*$/m.test(nextText)) {
    nextText = nextText.replace(/^\s*model_provider\s*=.*$/m, `model_provider = "${sourceProvider}"`);
  } else {
    nextText = `model_provider = "${sourceProvider}"\n${nextText}`;
  }

  const targetSectionPattern = new RegExp(
    `^\\s*\\[model_providers\\.${escapeRegExp(sourceProvider)}\\]\\s*$([\\s\\S]*?)(?=^\\s*\\[[^\\]]+\\]\\s*$|$)`,
    'm'
  );
  if (targetSectionPattern.test(nextText)) {
    nextText = nextText.replace(targetSectionPattern, sourceSectionMatch[0].trimEnd());
  } else {
    nextText = `${nextText.trimEnd()}\n\n${sourceSectionMatch[0].trimEnd()}\n`;
  }
  nextText = nextText.replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';

  const changed = writeTextFileIfChanged(targetConfigPath, nextText);
  return {
    changed,
    skipped: false,
    reason: changed ? 'synced' : 'already_current',
    sourceProvider,
    targetConfigPath,
  };
}

function syncCodexHomeAuth(configuredHome) {
  const targetHome = resolveOptionalDir(configuredHome);
  if (!targetHome) return { changed: false, skipped: true, reason: 'home_missing' };

  const defaultHome = path.join(os.homedir(), '.codex');
  const sourceAuthPath = path.join(defaultHome, 'auth.json');
  const targetAuthPath = path.join(targetHome, 'auth.json');
  if (path.resolve(sourceAuthPath) === path.resolve(targetAuthPath)) {
    return { changed: false, skipped: true, reason: 'same_auth' };
  }

  const sourceText = readTextFileIfExists(sourceAuthPath);
  if (!sourceText) {
    return { changed: false, skipped: true, reason: 'source_auth_missing' };
  }

  let sourceJson;
  try {
    sourceJson = JSON.parse(sourceText);
  } catch (_) {
    return { changed: false, skipped: true, reason: 'source_auth_invalid' };
  }

  if (!sourceJson || typeof sourceJson !== 'object' || Array.isArray(sourceJson)) {
    return { changed: false, skipped: true, reason: 'source_auth_invalid' };
  }

  const sourceOpenaiApiKey = String(sourceJson.OPENAI_API_KEY || '').trim();
  const sourceTokens = sourceJson.tokens && typeof sourceJson.tokens === 'object' ? sourceJson.tokens : null;
  if (!sourceOpenaiApiKey && !sourceTokens) {
    return { changed: false, skipped: true, reason: 'source_auth_empty' };
  }

  if (sourceTokens && sourceJson.auth_mode !== 'apikey') {
    return syncSharedCodexAuthSymlink(sourceAuthPath, targetAuthPath);
  }

  let targetJson = {};
  const targetText = readTextFileIfExists(targetAuthPath);
  if (targetText) {
    try {
      const parsed = JSON.parse(targetText);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        targetJson = parsed;
      }
    } catch (_) {
      targetJson = {};
    }
  }

  const nextJson = { ...targetJson };
  if (sourceOpenaiApiKey) nextJson.OPENAI_API_KEY = sourceOpenaiApiKey;
  else delete nextJson.OPENAI_API_KEY;
  if (sourceTokens) {
    nextJson.tokens = sourceTokens;
  }
  if (sourceJson.auth_mode) {
    nextJson.auth_mode = sourceJson.auth_mode;
  }
  if (sourceJson.last_refresh) {
    nextJson.last_refresh = sourceJson.last_refresh;
  }
  if (sourceJson.auth_mode && sourceJson.auth_mode !== 'apikey') {
    delete nextJson.OPENAI_API_KEY;
  }

  const nextTextNormalized = `${JSON.stringify(nextJson, null, 2)}\n`;
  const changed = writeTextFileIfChanged(targetAuthPath, nextTextNormalized);
  return {
    changed,
    skipped: false,
    reason: changed ? 'synced' : 'already_current',
    targetAuthPath,
  };
}

function isImageFilePath(filePath) {
  const ext = path.extname(String(filePath || '')).trim().toLowerCase();
  return IMAGE_FILE_EXTENSIONS.has(ext);
}

function normalizeAliasText(rawText) {
  return String(rawText || '')
    .replace(/[\u200b-\u200d\uFEFF]/g, '')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeMentionAlias(rawText) {
  let text = normalizeAliasText(rawText);
  if (!text) return '';
  text = text.replace(/[：:]+$/g, '').trim();
  text = text.replace(/[|｜]\s*任务进度$/i, '').trim();
  text = text.replace(/^[“"']+|[”"']+$/g, '').trim();
  text = text.replace(/[，,。.!！?？;；、]+$/g, '').trim();
  return text;
}

function parseMentionAliasList(rawValue) {
  if (Array.isArray(rawValue)) return rawValue;
  if (typeof rawValue === 'string') {
    return rawValue
      .split(/[\n,]/)
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [];
}

function extractSystemPromptAliases(rawText) {
  const text = String(rawText || '');
  if (!text) return [];
  const aliases = [];
  const identityBlock = text
    .split(/\r?\n\s*\r?\n/, 1)[0]
    .split(/\r?\n/)
    .slice(0, 3)
    .join('\n');

  for (const match of identityBlock.matchAll(/[“"]([^”"\n]{1,80})[”"]/g)) {
    if (match[1]) aliases.push(match[1]);
  }

  const firstLine = identityBlock.split(/\r?\n/, 1)[0] || '';
  const simpleMatch = firstLine.match(/你是[“"]?([^”"，。\n]{1,80})/);
  if (simpleMatch && simpleMatch[1]) aliases.push(simpleMatch[1]);

  return aliases;
}

function resolveMentionAliases({ botName = '', explicitAliases = [], replyPrefix = '', systemPrompt = '', progressTitlePrefix = '' }) {
  const aliases = uniqueStrings([
    botName,
    ...parseMentionAliasList(explicitAliases),
    replyPrefix,
    progressTitlePrefix,
    ...extractSystemPromptAliases(systemPrompt),
  ].map((item) => normalizeMentionAlias(item)).filter(Boolean));

  return aliases.sort((a, b) => b.length - a.length);
}

function buildFlexibleAliasPattern(alias) {
  const normalized = normalizeMentionAlias(alias);
  if (!normalized) return '';
  return escapeRegExp(normalized).replace(/\s+/g, '\\s+');
}

function detectTextualBotMention(rawText, aliases = []) {
  const text = normalizeAliasText(rawText);
  if (!text) return '';
  const boundary = '[\\s\\u00a0,，。.!！?？:：;；()（）\\[\\]{}<>《》]';

  for (const alias of aliases || []) {
    const pattern = buildFlexibleAliasPattern(alias);
    if (!pattern) continue;
    const regex = new RegExp(`(?:^|${boundary})[@＠]\\s*${pattern}(?=$|${boundary})`, 'i');
    if (regex.test(text)) return alias;
  }

  return '';
}

function stripLeadingTextMentions(rawText, aliases = []) {
  let text = String(rawText || '');
  if (!text) return '';

  let previous = null;
  while (text !== previous) {
    previous = text;
    for (const alias of aliases || []) {
      const pattern = buildFlexibleAliasPattern(alias);
      if (!pattern) continue;
      const regex = new RegExp(`^\\s*[@＠]\\s*${pattern}(?:\\s*[:：,，;；、-]\\s*|\\s+|$)`, 'i');
      text = text.replace(regex, ' ');
    }
    text = text.replace(/^\s+/, '');
  }

  return text;
}

function parsePostContent(rawContent) {
  const content = String(rawContent || '').trim();
  if (!content) return { text: '', imageKeys: [], fileAttachments: [] };
  let parsed = null;
  try {
    parsed = JSON.parse(content);
  } catch (_) {
    return { text: '', imageKeys: [], fileAttachments: [] };
  }
  const post = parsed?.post || parsed;
  const localeEntries = Object.values(post || {});
  const preferred = post?.zh_cn || post?.en_us || localeEntries[0] || {};
  const blocks = Array.isArray(preferred?.content) ? preferred.content : [];
  const textParts = [];
  const imageKeys = [];
  const fileAttachments = [];
  const seenObjects = new Set();

  function normalizeStructuredValue(rawValue, maxLength = 500) {
    const text = String(rawValue || '')
      .replace(/\r/g, '\n')
      .replace(/\u00a0/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!text) return '';
    if (text.length > maxLength) return `${text.slice(0, maxLength)}...`;
    return text;
  }

  function collectFieldValues(root, targetKeys, maxValues = 12) {
    const wanted = new Set(
      (Array.isArray(targetKeys) ? targetKeys : [targetKeys])
        .map((key) => String(key || '').trim().toLowerCase())
        .filter(Boolean)
    );
    if (!root || wanted.size === 0) return [];

    const results = [];
    const stack = [root];
    let loopGuard = 0;
    while (stack.length > 0 && results.length < maxValues && loopGuard < 4000) {
      loopGuard += 1;
      const current = stack.pop();
      if (current === null || current === undefined) continue;
      if (typeof current !== 'object') continue;
      if (seenObjects.has(current)) continue;
      seenObjects.add(current);

      if (Array.isArray(current)) {
        for (let index = current.length - 1; index >= 0; index -= 1) {
          stack.push(current[index]);
        }
        continue;
      }

      for (const [key, value] of Object.entries(current)) {
        const normalizedKey = String(key || '').trim().toLowerCase();
        if (wanted.has(normalizedKey) && (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')) {
          const normalizedValue = normalizeStructuredValue(value);
          if (normalizedValue) results.push(normalizedValue);
        }
        if (value && typeof value === 'object') {
          stack.push(value);
        }
      }
    }

    return uniqueStrings(results);
  }

  if (typeof preferred?.title === 'string' && preferred.title.trim()) {
    textParts.push(preferred.title.trim());
  }

  for (const block of blocks) {
    if (!Array.isArray(block)) continue;
    for (const item of block) {
      const tag = String(item?.tag || '').trim().toLowerCase();
      if (tag === 'text') {
        const itemText = String(item?.text || '').trim();
        if (itemText) textParts.push(itemText);
        continue;
      }
      if (tag === 'img' || tag === 'image') {
        const imageKey = String(
          item?.image_key || item?.imageKey || item?.file_key || item?.fileKey || ''
        ).trim();
        if (imageKey) imageKeys.push(imageKey);
        continue;
      }
      if (tag === 'file' || tag === 'media' || tag === 'attachment') {
        const fileKey = String(
          item?.file_key || item?.fileKey || item?.media_key || item?.mediaKey || ''
        ).trim();
        const fileName = String(
          item?.file_name || item?.fileName || item?.name || ''
        ).trim();
        if (fileKey) {
          fileAttachments.push({ fileKey, fileName, fileSize: 0 });
        }
      }
    }
  }

  // Newer Feishu rich-text/post payloads may not use the legacy `content[][]`
  // block layout. Fall back to a generic recursive extraction so markdown-like
  // rich text still reaches the bot instead of being treated as empty.
  if (textParts.length === 0) {
    const fallbackTextParts = collectFieldValues(
      post,
      [
        'text',
        'content',
        'content_text',
        'contentText',
        'title',
        'subtitle',
        'summary',
        'description',
        'markdown',
        'md_text',
        'plain_text',
        'plainText',
      ],
      12
    );
    textParts.push(...fallbackTextParts);
  }

  if (imageKeys.length === 0) {
    imageKeys.push(
      ...collectFieldValues(post, ['image_key', 'imageKey', 'file_key', 'fileKey'], 16)
    );
  }

  if (fileAttachments.length === 0) {
    const seenFileKeys = new Set();
    const candidateFileKeys = collectFieldValues(
      post,
      ['file_key', 'fileKey', 'media_key', 'mediaKey', 'attachment_key', 'attachmentKey'],
      16
    );
    const candidateFileNames = collectFieldValues(
      post,
      ['file_name', 'fileName', 'name', 'filename'],
      16
    );
    for (let index = 0; index < candidateFileKeys.length; index += 1) {
      const fileKey = String(candidateFileKeys[index] || '').trim();
      if (!fileKey || seenFileKeys.has(fileKey)) continue;
      seenFileKeys.add(fileKey);
      fileAttachments.push({
        fileKey,
        fileName: String(candidateFileNames[index] || '').trim(),
        fileSize: 0,
      });
    }
  }

  return {
    text: uniqueStrings(textParts).join('\n').trim(),
    imageKeys: uniqueStrings(imageKeys),
    fileAttachments: fileAttachments.filter((item) => item.fileKey),
  };
}

function extractAttachmentInlineText(rawContent, {
  mentions = [],
  mentionAliases = [],
  excludeValues = [],
  limit = 3,
} = {}) {
  const parsed = safeParseMessageContent(rawContent);
  if (!parsed) return '';
  const inlineText = extractInlineTextFromParsedContent(parsed, {
    excludeValues,
    limit,
  }).join('\n');
  return compactText(
    normalizeIncomingText(inlineText, mentions, mentionAliases),
    4000
  ).trim();
}

function buildAttachmentBundle({
  messageType = '',
  messageID = '',
  timestamp = Date.now(),
  sourceMessageIDs = null,
  textSegments = [],
  imageItems = [],
  fileItems = [],
  audioItems = [],
} = {}) {
  const fallbackMessageID = String(messageID || '').trim();
  const normalizedTimestamp = Number(timestamp);
  const normalizedImageItems = [];
  for (const item of imageItems || []) {
    const imageKey = String(item?.imageKey || '').trim();
    const sourceMessageID = String(item?.messageID || fallbackMessageID).trim();
    if (!imageKey || !sourceMessageID) continue;
    normalizedImageItems.push({
      messageID: sourceMessageID,
      imageKey,
      fileName: String(item?.fileName || '').trim(),
    });
  }
  const normalizedFileItems = [];
  for (const item of fileItems || []) {
    const fileKey = String(item?.fileKey || '').trim();
    const sourceMessageID = String(item?.messageID || fallbackMessageID).trim();
    if (!fileKey || !sourceMessageID) continue;
    normalizedFileItems.push({
      messageID: sourceMessageID,
      fileKey,
      fileName: String(item?.fileName || '').trim(),
      fileSize: Number(item?.fileSize) || 0,
    });
  }
  const normalizedAudioItems = [];
  for (const item of audioItems || []) {
    const fileKey = String(item?.fileKey || '').trim();
    const sourceMessageID = String(item?.messageID || fallbackMessageID).trim();
    if (!fileKey || !sourceMessageID) continue;
    normalizedAudioItems.push({
      messageID: sourceMessageID,
      fileKey,
      durationMs: Number(item?.durationMs) || 0,
    });
  }
  const normalizedSourceMessageIDs = uniqueStrings(
    Array.isArray(sourceMessageIDs)
      ? sourceMessageIDs
      : [
        fallbackMessageID,
        ...normalizedImageItems.map((item) => item.messageID),
        ...normalizedFileItems.map((item) => item.messageID),
        ...normalizedAudioItems.map((item) => item.messageID),
      ]
  );
  return {
    messageType: String(messageType || '').trim().toLowerCase(),
    messageID: fallbackMessageID,
    timestamp: Number.isFinite(normalizedTimestamp) ? normalizedTimestamp : Date.now(),
    textSegments: uniqueStrings(
      (textSegments || [])
        .map((item) => compactText(String(item || ''), 4000).trim())
        .filter(Boolean)
    ),
    imageItems: normalizedImageItems,
    fileItems: normalizedFileItems,
    audioItems: normalizedAudioItems,
    sourceMessageIDs: normalizedSourceMessageIDs,
  };
}

function hasAttachmentBundleContent(bundle = {}) {
  return Boolean(
    (Array.isArray(bundle?.imageItems) && bundle.imageItems.length > 0)
    || (Array.isArray(bundle?.fileItems) && bundle.fileItems.length > 0)
    || (Array.isArray(bundle?.audioItems) && bundle.audioItems.length > 0)
  );
}

function extractAttachmentBundleFromMessage({
  messageType = '',
  rawContent = '',
  messageID = '',
  mentions = [],
  mentionAliases = [],
  timestamp = Date.now(),
} = {}) {
  const normalizedType = String(messageType || '').trim().toLowerCase();
  const normalizedMessageID = String(messageID || '').trim();
  if (!normalizedMessageID) {
    return buildAttachmentBundle({ messageType: normalizedType, timestamp });
  }

  const textSegments = [];
  const imageItems = [];
  const fileItems = [];
  const audioItems = [];

  if (normalizedType === 'image') {
    const imageKey = parseImageKey(rawContent);
    if (imageKey) {
      imageItems.push({ messageID: normalizedMessageID, imageKey });
    }
    const inlineText = extractAttachmentInlineText(rawContent, {
      mentions,
      mentionAliases,
      excludeValues: [imageKey],
      limit: 2,
    });
    if (inlineText) textSegments.push(inlineText);
  }

  if (normalizedType === 'post') {
    const parsedPost = parsePostContent(rawContent);
    const normalizedPostText = compactText(
      normalizeIncomingText(parsedPost.text, mentions, mentionAliases),
      4000
    ).trim();
    if (normalizedPostText) textSegments.push(normalizedPostText);
    for (const imageKey of parsedPost.imageKeys || []) {
      if (!imageKey) continue;
      imageItems.push({ messageID: normalizedMessageID, imageKey });
    }
    for (const descriptor of parsedPost.fileAttachments || []) {
      if (!descriptor?.fileKey) continue;
      fileItems.push({
        messageID: normalizedMessageID,
        fileKey: descriptor.fileKey,
        fileName: descriptor.fileName,
        fileSize: descriptor.fileSize,
      });
    }
  }

  if (normalizedType === 'file') {
    const parsedFile = parseFileMessageContent(rawContent);
    if (parsedFile.fileKey) {
      fileItems.push({
        messageID: normalizedMessageID,
        fileKey: parsedFile.fileKey,
        fileName: parsedFile.fileName,
        fileSize: parsedFile.fileSize,
      });
    }
    const normalizedFileText = compactText(
      normalizeIncomingText(parsedFile.text, mentions, mentionAliases),
      4000
    ).trim();
    if (normalizedFileText) textSegments.push(normalizedFileText);
  }

  if (normalizedType === 'audio') {
    const parsedAudio = parseAudioMessageContent(rawContent);
    if (parsedAudio.fileKey) {
      audioItems.push({
        messageID: normalizedMessageID,
        fileKey: parsedAudio.fileKey,
        durationMs: parsedAudio.durationMs,
      });
    }
    const inlineText = extractAttachmentInlineText(rawContent, {
      mentions,
      mentionAliases,
      excludeValues: [parsedAudio.fileKey],
      limit: 2,
    });
    if (inlineText) textSegments.push(inlineText);
  }

  return buildAttachmentBundle({
    messageType: normalizedType,
    messageID: normalizedMessageID,
    timestamp,
    textSegments,
    imageItems,
    fileItems,
    audioItems,
  });
}

function extractAttachmentBundleFromMessageItem(messageItem = {}, options = {}) {
  return extractAttachmentBundleFromMessage({
    messageType: messageItem?.msg_type || messageItem?.message_type || '',
    rawContent: messageItem?.body?.content || messageItem?.content || '',
    messageID: messageItem?.message_id || messageItem?.messageId || '',
    mentions: messageItem?.mentions || [],
    mentionAliases: options?.mentionAliases || [],
    timestamp: options?.timestamp || Date.now(),
  });
}

function mergeAttachmentBundles(bundles = []) {
  const normalizedBundles = (bundles || [])
    .map((bundle) => buildAttachmentBundle(bundle))
    .filter((bundle) => hasAttachmentBundleContent(bundle))
    .sort((left, right) => left.timestamp - right.timestamp);
  if (normalizedBundles.length === 0) return null;

  return buildAttachmentBundle({
    messageType: normalizedBundles[normalizedBundles.length - 1]?.messageType || '',
    messageID: normalizedBundles[normalizedBundles.length - 1]?.messageID || '',
    timestamp: normalizedBundles[normalizedBundles.length - 1]?.timestamp || Date.now(),
    sourceMessageIDs: normalizedBundles.flatMap((bundle) => bundle.sourceMessageIDs || bundle.messageID || []),
    textSegments: normalizedBundles.flatMap((bundle) => bundle.textSegments || []),
    imageItems: normalizedBundles.flatMap((bundle) => bundle.imageItems || []),
    fileItems: normalizedBundles.flatMap((bundle) => bundle.fileItems || []),
    audioItems: normalizedBundles.flatMap((bundle) => bundle.audioItems || []),
  });
}

function selectAttachmentSource({
  currentAttachmentBundle = null,
  quotedAttachmentBundle = null,
  recentAttachmentBundle = null,
  historyAttachmentBundle = null,
} = {}) {
  const candidates = [
    { source: 'current_message_attachment', bundle: currentAttachmentBundle },
    { source: 'quoted_attachment', bundle: quotedAttachmentBundle },
    { source: 'recent_attachment_pair', bundle: recentAttachmentBundle },
    { source: 'history_attachment_pair', bundle: historyAttachmentBundle },
  ];
  for (const candidate of candidates) {
    if (hasAttachmentBundleContent(candidate.bundle)) {
      return {
        source: candidate.source,
        bundle: buildAttachmentBundle(candidate.bundle),
      };
    }
  }
  return {
    source: '',
    bundle: null,
  };
}

function extractMessageItemTimestamp(messageItem = {}) {
  const candidates = [
    messageItem?.create_time,
    messageItem?.createTime,
    messageItem?.timestamp,
    messageItem?.time,
    messageItem?.update_time,
    messageItem?.updateTime,
  ];
  for (const candidate of candidates) {
    const normalized = Number(candidate);
    if (Number.isFinite(normalized) && normalized > 0) {
      return normalized;
    }
  }
  return 0;
}

function senderIdentityMatches(left = {}, right = {}) {
  const lhs = normalizeSenderIdentity(left);
  const rhs = normalizeSenderIdentity(right);
  if (lhs.openId && rhs.openId) return lhs.openId === rhs.openId;
  if (lhs.userId && rhs.userId) return lhs.userId === rhs.userId;
  if (lhs.unionId && rhs.unionId) return lhs.unionId === rhs.unionId;
  const leftName = normalizeAliasText(lhs.displayName).toLowerCase();
  const rightName = normalizeAliasText(rhs.displayName).toLowerCase();
  if (leftName && rightName) return leftName === rightName;
  return false;
}

function findRecentAttachmentBundleFromMessageItems(messageItems = [], {
  currentMessageID = '',
  currentSenderIdentity = {},
  currentMessageTimestamp = 0,
  mentionAliases = [],
  windowMs = FEISHU_ATTACHMENT_TEXT_CARRY_WINDOW_MS,
} = {}) {
  const items = Array.isArray(messageItems) ? messageItems : [];
  const targetMessageID = String(currentMessageID || '').trim();
  const senderIdentity = normalizeSenderIdentity(currentSenderIdentity);
  if (!targetMessageID || buildCarrySenderKey(senderIdentity) === 'anonymous') {
    return null;
  }

  let baseTimestamp = Number(currentMessageTimestamp) || 0;
  if (!baseTimestamp) {
    const currentItem = items.find((item) => {
      const itemMessageID = String(item?.message_id || item?.messageId || '').trim();
      return itemMessageID === targetMessageID;
    });
    baseTimestamp = extractMessageItemTimestamp(currentItem);
  }
  if (!baseTimestamp) return null;

  const matchedBundles = [];
  for (const item of items) {
    const itemMessageID = String(item?.message_id || item?.messageId || '').trim();
    const itemMessageType = String(item?.msg_type || item?.message_type || item?.messageType || '').trim().toLowerCase();
    const itemTimestamp = extractMessageItemTimestamp(item);
    if (!itemMessageID || itemMessageID === targetMessageID) continue;
    if (item?.deleted) continue;
    if (!isCarryEligibleMessageType(itemMessageType)) continue;
    if (!itemTimestamp || itemTimestamp >= baseTimestamp) continue;
    if (baseTimestamp - itemTimestamp > windowMs) continue;
    if (!senderIdentityMatches(senderIdentity, extractMessageSenderIdentity(item))) continue;

    const bundle = extractAttachmentBundleFromMessageItem(item, {
      mentionAliases,
      timestamp: itemTimestamp,
    });
    if (!hasAttachmentBundleContent(bundle)) continue;
    matchedBundles.push(bundle);
  }

  return mergeAttachmentBundles(matchedBundles);
}

async function fetchRecentAttachmentBundleFromChatHistory(client, {
  chatID = '',
  currentMessageID = '',
  currentMessageItem = null,
  currentSenderIdentity = {},
  mentionAliases = [],
  pageSize = FEISHU_ATTACHMENT_HISTORY_LOOKBACK_PAGE_SIZE,
  logTag = 'attachment_history_lookup',
} = {}) {
  const targetChatID = String(chatID || '').trim();
  const targetMessageID = String(currentMessageID || '').trim();
  if (!client || !targetChatID || !targetMessageID) return null;
  if (buildCarrySenderKey(currentSenderIdentity) === 'anonymous') return null;

  let historyItems = [];
  let currentTimestamp = extractMessageItemTimestamp(currentMessageItem);

  try {
    const response = await client.im.v1.message.list({
      params: {
        container_id_type: 'chat',
        container_id: targetChatID,
        sort_type: 'ByCreateTimeDesc',
        page_size: Math.max(10, Math.min(50, Number(pageSize) || FEISHU_ATTACHMENT_HISTORY_LOOKBACK_PAGE_SIZE)),
      },
    });
    historyItems = Array.isArray(response?.data?.items) ? response.data.items : [];
    if (!currentTimestamp) {
      const listedCurrentItem = historyItems.find((item) => {
        const itemMessageID = String(item?.message_id || item?.messageId || '').trim();
        return itemMessageID === targetMessageID;
      });
      currentTimestamp = extractMessageItemTimestamp(listedCurrentItem);
    }
  } catch (err) {
    console.error(`${logTag}=error chat_id=${targetChatID} message_id=${targetMessageID} message=${err.message}`);
    return null;
  }

  if (!currentTimestamp) {
    const fetchedCurrentItem = await getMessageItemSafe(client, targetMessageID, `${logTag}_current_message_get`);
    currentTimestamp = extractMessageItemTimestamp(fetchedCurrentItem);
    if (fetchedCurrentItem) {
      const fetchedCurrentMessageID = String(fetchedCurrentItem?.message_id || fetchedCurrentItem?.messageId || '').trim();
      if (fetchedCurrentMessageID && !historyItems.some((item) => {
        const itemMessageID = String(item?.message_id || item?.messageId || '').trim();
        return itemMessageID === fetchedCurrentMessageID;
      })) {
        historyItems.push(fetchedCurrentItem);
      }
    }
  }

  return findRecentAttachmentBundleFromMessageItems(historyItems, {
    currentMessageID: targetMessageID,
    currentSenderIdentity,
    currentMessageTimestamp: currentTimestamp,
    mentionAliases,
  });
}

function stripAnsi(rawText) {
  return String(rawText || '')
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\u001b[@-_]/g, '');
}

function normalizeProgressSnippet(rawText, maxLength = 180) {
  const max = Math.max(40, maxLength);
  let text = stripAnsi(rawText);
  text = text.replace(/\r/g, '\n');
  text = text.replace(/\s+/g, ' ').trim();
  if (!text) return '';
  if (text.length > max) return `${text.slice(0, max)}...`;
  return text;
}

function normalizeProgressDetailText(rawText, maxLength = 12000) {
  const max = Math.max(200, maxLength);
  let text = stripAnsi(rawText);
  text = text.replace(/\r\n/g, '\n');
  text = text.replace(/\r/g, '\n');
  text = text.replace(/\u00a0/g, ' ');
  text = text.replace(/\u200b/g, '');

  const lines = text
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/g, ''));
  while (lines.length > 0 && !lines[0].trim()) lines.shift();
  while (lines.length > 0 && !lines[lines.length - 1].trim()) lines.pop();

  text = lines.join('\n');
  if (!text) return '';
  if (text.length > max) return `${text.slice(0, max)}\n...(已截断)`;
  return text;
}

function safeJsonStringify(value, maxLength = 12000) {
  const seen = new WeakSet();
  try {
    const text = JSON.stringify(
      value,
      (_, current) => {
        if (current && typeof current === 'object') {
          if (seen.has(current)) return '[Circular]';
          seen.add(current);
        }
        return current;
      },
      2
    );
    return normalizeProgressDetailText(text, maxLength);
  } catch (err) {
    return normalizeProgressDetailText(err?.message || String(value || ''), maxLength);
  }
}

function collectNestedValues(root, keys, maxValues = 12) {
  const targetKeys = new Set(
    (Array.isArray(keys) ? keys : [keys])
      .map((key) => String(key || '').trim().toLowerCase())
      .filter(Boolean)
  );
  if (!root || targetKeys.size === 0) return [];

  const results = [];
  const visited = new Set();
  const stack = [root];
  let loopGuard = 0;

  while (stack.length > 0 && results.length < maxValues && loopGuard < 3000) {
    loopGuard += 1;
    const current = stack.pop();
    if (current === null || current === undefined) continue;
    if (typeof current !== 'object') continue;
    if (visited.has(current)) continue;
    visited.add(current);

    if (Array.isArray(current)) {
      for (let i = current.length - 1; i >= 0; i -= 1) {
        stack.push(current[i]);
      }
      continue;
    }

    for (const [key, value] of Object.entries(current)) {
      if (targetKeys.has(String(key || '').trim().toLowerCase())) {
        results.push(value);
        if (results.length >= maxValues) break;
      }
      if (value && typeof value === 'object') stack.push(value);
    }
  }

  return results;
}

function pickNestedString(root, keys, maxLength = 12000) {
  const values = collectNestedValues(root, keys, 16);
  for (const value of values) {
    if (value === null || value === undefined) continue;
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      const text = normalizeProgressDetailText(String(value), maxLength);
      if (text) return text;
      continue;
    }
    if (Array.isArray(value)) {
      const joined = value
        .map((item) => {
          if (item === null || item === undefined) return '';
          if (typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean') {
            return String(item);
          }
          return safeJsonStringify(item, maxLength);
        })
        .filter(Boolean)
        .join('\n');
      const text = normalizeProgressDetailText(joined, maxLength);
      if (text) return text;
    }
  }
  return '';
}

function pickNestedNumber(root, keys) {
  const values = collectNestedValues(root, keys, 16);
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim() !== '') {
      const num = Number(value);
      if (Number.isFinite(num)) return num;
    }
  }
  return null;
}

function isCommandProgressEvent(event) {
  const type = String(event?.type || '').trim().toLowerCase();
  const itemType = String(event?.item?.type || '').trim().toLowerCase();
  if (itemType === 'command_execution') return true;
  if (type.includes('exec_command')) return true;
  if (type.includes('command_execution')) return true;
  return false;
}

function extractCommandProgressEntry(event) {
  if (!event || typeof event !== 'object') return null;

  const type = String(event?.type || '').trim();
  const lowerType = type.toLowerCase();
  const itemType = String(event?.item?.type || '').trim();
  const commandText = pickNestedString(event, ['parsed_cmd', 'command', 'cmd', 'command_line', 'shell_command']);
  const workingDirectory = pickNestedString(event, ['working_directory', 'cwd', 'directory']);
  const outputChunk = pickNestedString(event, ['chunk', 'output_chunk', 'stdout_chunk', 'stderr_chunk']);
  const stdout = pickNestedString(event, ['stdout']);
  const stderr = pickNestedString(event, ['stderr']);
  const aggregatedOutput = pickNestedString(event, ['aggregated_output', 'output']);
  const streamName = normalizeProgressSnippet(pickNestedString(event, ['stream', 'channel', 'source'], 80), 80);
  const exitCode = pickNestedNumber(event, ['exit_code', 'code']);
  const signal = pickNestedString(event, ['signal'], 80);
  const hasCommandMarkers = Boolean(
    isCommandProgressEvent(event) || commandText || workingDirectory || outputChunk || aggregatedOutput || exitCode !== null
  );

  if (!hasCommandMarkers) return null;

  let title = '命令执行';
  let summary = formatCodexProgressEvent(event) || '执行命令处理中';

  if (lowerType.includes('output') || outputChunk) {
    title = '命令输出';
    summary = streamName ? `命令输出中（${streamName}）` : '命令输出中';
  } else if (
    lowerType.includes('end')
    || type === 'item.completed'
    || type === 'item.failed'
    || exitCode !== null
    || stdout
    || stderr
    || aggregatedOutput
  ) {
    title = '命令执行结束';
    summary = exitCode !== null ? `命令执行结束（exit=${exitCode}）` : '命令执行结束';
  } else if (lowerType.includes('begin') || type === 'item.started' || commandText || workingDirectory) {
    title = '命令执行开始';
    summary = commandText ? `开始执行：${normalizeProgressSnippet(commandText, 80)}` : '开始执行命令';
  }

  const eventTypeLabel = [type, itemType].filter(Boolean).join(' / ');
  const meta = [];
  const sections = [];
  if (eventTypeLabel) meta.push({ label: '事件类型', value: eventTypeLabel });
  if (workingDirectory && title !== '命令输出') {
    meta.push({ label: '工作目录', value: workingDirectory, inlineCode: true });
  }
  if (streamName && outputChunk) {
    meta.push({ label: '输出流', value: streamName, inlineCode: true });
  }
  if (exitCode !== null || signal) {
    meta.push({
      label: '退出状态',
      value: `${exitCode !== null ? exitCode : '(unknown)'}${signal ? ` | signal=${signal}` : ''}`,
      inlineCode: true,
    });
  }
  if (commandText && title !== '命令输出') {
    sections.push({ label: '执行命令', content: commandText, format: 'code' });
  }
  if (outputChunk) {
    sections.push({ label: streamName ? `${streamName} 输出` : '输出内容', content: outputChunk, format: 'code' });
  }
  if (stdout) {
    sections.push({ label: 'stdout', content: stdout, format: 'code' });
  }
  if (stderr) {
    sections.push({ label: 'stderr', content: stderr, format: 'code' });
  }
  if (aggregatedOutput && !outputChunk && !stdout && !stderr) {
    sections.push({ label: '输出汇总', content: aggregatedOutput, format: 'code' });
  }
  if (meta.length === 0 && sections.length === 0) {
    sections.push({ label: '事件原文', content: safeJsonStringify(event, 6000), format: 'code' });
  }

  return {
    summary,
    entry: {
      kind: 'detail',
      title,
      meta,
      sections,
    },
  };
}

function extractRawProgressEntry(event) {
  if (String(event?.type || '').trim().toLowerCase() !== 'raw') return null;
  const text = normalizeProgressDetailText(event?.text, 12000);
  if (!text) return null;
  return {
    summary: '收到原始输出',
    entry: {
      kind: 'detail',
      title: '原始输出',
      sections: [
        { label: '原始输出', content: text, format: 'code' },
      ],
    },
  };
}

function extractErrorProgressEntry(event) {
  const type = String(event?.type || '').trim().toLowerCase();
  if (type !== 'error' && type !== 'turn.failed' && type !== 'item.failed') return null;

  const message = pickNestedString(event, ['message', 'error', 'details', 'stderr'], 6000);
  const raw = safeJsonStringify(event, 6000);
  const meta = [];
  const eventTypeLabel = String(event?.type || '').trim();
  if (eventTypeLabel) meta.push({ label: '事件类型', value: eventTypeLabel });
  const sections = [];
  if (message) sections.push({ label: '错误信息', content: message, format: 'text' });
  if (raw && raw !== message) {
    sections.push({ label: '事件原文', content: raw, format: 'code' });
  }
  if (sections.length === 0) return null;

  return {
    summary: formatCodexProgressEvent(event) || '执行出现错误',
    entry: {
      kind: 'detail',
      title: '错误事件',
      meta,
      sections,
    },
  };
}

function formatCodexProgressEventForDoc(event) {
  const rawEntry = extractRawProgressEntry(event);
  if (rawEntry) return rawEntry;

  const commandEntry = extractCommandProgressEntry(event);
  if (commandEntry) return commandEntry;

  const errorEntry = extractErrorProgressEntry(event);
  if (errorEntry) return errorEntry;

  const summary = formatCodexProgressEvent(event);
  if (!summary) return { summary: '', entry: null };
  return {
    summary,
    entry: {
      kind: 'line',
      text: summary,
    },
  };
}

function containsEditLimitSignal(value) {
  if (value === null || value === undefined) return false;
  const text = String(value).toLowerCase();
  return text.includes('230072') || text.includes('number of times it can be edited');
}

function isMessageEditLimitError(err) {
  if (!err) return false;
  if (containsEditLimitSignal(err?.message)) return true;

  const visited = new Set();
  const stack = [err];
  let loopGuard = 0;
  while (stack.length > 0 && loopGuard < 3000) {
    loopGuard += 1;
    const current = stack.pop();
    if (current === null || current === undefined) continue;
    const t = typeof current;
    if (t === 'string' || t === 'number' || t === 'boolean') {
      if (containsEditLimitSignal(current)) return true;
      continue;
    }
    if (t !== 'object') continue;
    if (visited.has(current)) continue;
    visited.add(current);
    if (Array.isArray(current)) {
      for (const item of current) stack.push(item);
      continue;
    }
    for (const [k, v] of Object.entries(current)) {
      if (k === 'code' && String(v) === '230072') return true;
      if (containsEditLimitSignal(v)) return true;
      if (v && typeof v === 'object') stack.push(v);
    }
  }
  return false;
}

function getFeishuApiResponseData(err) {
  if (!err || typeof err !== 'object') return null;
  const responseData = err?.response?.data;
  if (responseData && typeof responseData === 'object') return responseData;
  const data = err?.data;
  if (data && typeof data === 'object') return data;
  return null;
}

function getFeishuApiStatus(err) {
  const status = err?.response?.status ?? err?.status ?? null;
  const numeric = Number(status);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
}

function getFeishuApiCode(err) {
  const data = getFeishuApiResponseData(err);
  const code = data?.code ?? data?.error?.code ?? err?.code ?? null;
  if (code === null || code === undefined || code === '') return '';
  return String(code).trim();
}

function summarizeFeishuFieldViolations(fieldViolations) {
  if (!Array.isArray(fieldViolations) || fieldViolations.length === 0) return '';
  return fieldViolations
    .slice(0, 3)
    .map((item) => {
      if (!item || typeof item !== 'object') {
        return normalizeProgressSnippet(item, 120);
      }
      const field =
        normalizeProgressSnippet(item.field || item.name || item.key || item.path || '', 80)
        || 'field';
      const message =
        normalizeProgressSnippet(
          item.description
          || item.message
          || item.msg
          || item.reason
          || item.error_message
          || '',
          120
        )
        || normalizeProgressSnippet(safeJsonStringify(item, 200), 120);
      return `${field}: ${message}`;
    })
    .filter(Boolean)
    .join('; ');
}

function describeFeishuApiError(err) {
  const parts = [];
  const message = normalizeProgressSnippet(err?.message || '', 240);
  if (message) parts.push(`message=${message}`);

  const status = getFeishuApiStatus(err);
  if (status) parts.push(`http_status=${status}`);

  const data = getFeishuApiResponseData(err);
  const code = getFeishuApiCode(err);
  if (code) parts.push(`code=${code}`);

  const apiMessage = normalizeProgressSnippet(
    data?.msg || data?.message || data?.error?.message || data?.error?.msg || '',
    240
  );
  if (apiMessage) parts.push(`api_message=${apiMessage}`);

  const logID = normalizeProgressSnippet(data?.log_id || data?.error?.log_id || '', 120);
  if (logID) parts.push(`log_id=${logID}`);

  const violations = summarizeFeishuFieldViolations(data?.field_violations);
  if (violations) parts.push(`field_violations=${violations}`);

  return parts.join(' ') || 'unknown_error';
}

function extractFeishuPermissionViolations(err) {
  const data = getFeishuApiResponseData(err);
  const raw = Array.isArray(data?.permission_violations)
    ? data.permission_violations
    : Array.isArray(data?.error?.permission_violations)
      ? data.error.permission_violations
      : [];
  return raw
    .map((item) => {
      if (!item || typeof item !== 'object') {
        return normalizeProgressSnippet(item, 120);
      }
      return normalizeProgressSnippet(
        item.scope
        || item.permission
        || item.name
        || item.key
        || item.code
        || item.msg
        || item.message
        || '',
        120
      );
    })
    .filter(Boolean);
}

function classifyFeishuDocFailure(err) {
  const status = getFeishuApiStatus(err);
  const code = getFeishuApiCode(err);
  const data = getFeishuApiResponseData(err);
  const message = normalizeProgressSnippet(
    [
      err?.message,
      data?.msg,
      data?.message,
      data?.error?.message,
      data?.error?.msg,
    ].filter(Boolean).join(' '),
    400
  ).toLowerCase();
  const permissions = extractFeishuPermissionViolations(err);

  if (
    status === 429
    || code === '429'
    || message.includes('status code 429')
    || message.includes('frequency limit')
    || message.includes('too many request')
    || message.includes('rate limit')
  ) {
    return {
      type: 'rate_limit',
      permissions,
      userNotice: '进度文档接口触发限流，已自动跳过文档更新，任务会继续执行。',
      logReason: 'doc_rate_limited',
    };
  }

  if (
    code === '99991672'
    || permissions.length > 0
    || message.includes('access denied')
    || message.includes('权限')
    || message.includes('scope is required')
  ) {
    const permissionText = permissions.length > 0
      ? permissions.join(', ')
      : 'docs:permission.member, docs:permission.member:create';
    return {
      type: 'permission',
      permissions,
      userNotice: `进度文档权限不足（缺少 ${permissionText}），已自动跳过文档更新，任务会继续执行。`,
      logReason: 'doc_permission_denied',
    };
  }

  return {
    type: 'other',
    permissions,
    userNotice: '进度文档暂时不可用，已自动跳过文档更新，任务会继续执行。',
    logReason: 'doc_unavailable',
  };
}

function isRetryableFeishuDocWriteError(err) {
  const status = getFeishuApiStatus(err);
  if (status === 429) return true;

  const code = getFeishuApiCode(err);
  if (code === '99991400') return true;

  const details = describeFeishuApiError(err).toLowerCase();
  return details.includes('frequency limit') || details.includes('too many request');
}

function formatCodexProgressEvent(event) {
  const type = String(event?.type || '').trim();
  if (!type) return '';
  const safeType = normalizeProgressSnippet(type, 48) || type;

  if (type === 'thread.started') return '会话已创建';
  if (type === 'thread.completed') return '会话已结束';
  if (type === 'turn.started') return '开始分析消息';
  if (type === 'turn.completed') return '分析完成，正在生成回复';
  if (type === 'turn.failed') return '本轮处理失败';
  if (type === 'turn.cancelled') return '本轮处理已取消';
  if (type === 'error') {
    return '执行出现错误，正在重试或收尾';
  }

  if (type.startsWith('item.')) {
    const item = event?.item || {};
    const itemType = normalizeProgressSnippet(item?.type || '', 40) || '任务';
    if (type === 'item.started') {
      return `开始步骤：${itemType}`;
    }
    if (type === 'item.completed') {
      if (itemType === 'reasoning') {
        return '完成一步推理';
      }
      if (itemType === 'tool_call') {
        return '调用工具处理中';
      }
      if (itemType === 'command_execution') {
        return '执行命令处理中';
      }
      if (itemType === 'agent_message') {
        return '已生成回复草稿';
      }
      return `完成步骤：${itemType}`;
    }
    if (type === 'item.failed') {
      return `步骤失败：${itemType}`;
    }
    if (type === 'item.cancelled') {
      return `步骤取消：${itemType}`;
    }
    return `步骤更新：${itemType}`;
  }

  if (type.startsWith('agent_message.')) return '正在组织回复';
  if (type.startsWith('tool.')) return '工具调用处理中';
  return `处理中：${safeType}`;
}

function normalizeIncomingText(rawText, mentions = [], mentionAliases = []) {
  let text = String(rawText || '');
  if (!text) return '';

  for (const mention of mentions || []) {
    const key = String(mention?.key || '').trim();
    if (!key) continue;
    text = text.split(key).join(' ');
  }

  text = text.replace(/<at\b[^>]*>.*?<\/at>/gi, ' ');
  text = stripLeadingTextMentions(text, mentionAliases);
  text = text.replace(/\u00a0/g, ' ');
  text = text.replace(/^(?:@\S+\s*)+/, '');
  return text.trim();
}

function normalizeSenderIdentity(identity = {}) {
  return {
    displayName: String(identity.displayName || identity.name || '').trim(),
    openId: String(identity.openId || identity.open_id || '').trim(),
    userId: String(identity.userId || identity.user_id || '').trim(),
    unionId: String(identity.unionId || identity.union_id || '').trim(),
    senderType: String(identity.senderType || identity.sender_type || '').trim(),
  };
}

function extractEventSenderIdentity(eventData = {}) {
  const sender = eventData?.sender || {};
  const senderId = sender?.sender_id || {};
  return normalizeSenderIdentity({
    displayName: sender.name || sender.display_name || sender.displayName || '',
    openId: senderId.open_id || senderId.openId || '',
    userId: senderId.user_id || senderId.userId || '',
    unionId: senderId.union_id || senderId.unionId || '',
    senderType: sender.sender_type || sender.senderType || '',
  });
}

function extractMessageSenderIdentity(messageItem = {}) {
  const sender = messageItem?.sender || {};
  const senderId = String(sender.id || '').trim();
  const senderIdType = String(sender.id_type || sender.idType || '').trim().toLowerCase();
  const senderObjectId = sender?.sender_id || sender?.senderId || {};
  return normalizeSenderIdentity({
    displayName: sender.name || sender.display_name || sender.displayName || sender.sender_name || sender.senderName || '',
    openId: senderIdType === 'open_id'
      ? senderId
      : senderObjectId.open_id || senderObjectId.openId || '',
    userId: senderIdType === 'user_id'
      ? senderId
      : senderObjectId.user_id || senderObjectId.userId || '',
    unionId: senderIdType === 'union_id'
      ? senderId
      : senderObjectId.union_id || senderObjectId.unionId || '',
    senderType: sender.sender_type || sender.senderType || '',
  });
}

function buildSenderIdentitySummary(identity = {}, { includeType = false } = {}) {
  const normalized = normalizeSenderIdentity(identity);
  const parts = [];
  if (normalized.displayName) parts.push(normalized.displayName);
  if (normalized.openId) parts.push(`open_id=${normalized.openId}`);
  if (normalized.userId) parts.push(`user_id=${normalized.userId}`);
  if (normalized.unionId) parts.push(`union_id=${normalized.unionId}`);
  if (includeType && normalized.senderType) parts.push(`type=${normalized.senderType}`);
  return uniqueStrings(parts).join('，');
}

function sanitizeRuntimeAccountName(accountName = '') {
  return normalizeString(accountName || 'default').replace(/[^a-z0-9_.-]+/gi, '_') || 'default';
}

function personalProxyRuntimePaths(accountName = '') {
  const safeName = sanitizeRuntimeAccountName(accountName);
  return {
    dir: FEISHU_APPROVAL_DIR,
    owner: path.join(FEISHU_APPROVAL_DIR, `${safeName}.owner.json`),
    pending: path.join(FEISHU_APPROVAL_DIR, `${safeName}.pending.json`),
    grants: path.join(FEISHU_APPROVAL_DIR, `${safeName}.grants.json`),
    audit: path.join(FEISHU_APPROVAL_DIR, `${safeName}.audit.jsonl`),
  };
}

function writeJsonPretty(filePath, value) {
  ensureDirSync(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function appendJsonLine(filePath, value) {
  ensureDirSync(path.dirname(filePath));
  fs.appendFileSync(filePath, `${JSON.stringify(value)}\n`);
}

function appendPersonalProxyAudit(accountName, event = {}) {
  const paths = personalProxyRuntimePaths(accountName);
  appendJsonLine(paths.audit, {
    at: Date.now(),
    account_name: normalizeString(accountName),
    ...event,
  });
}

function normalizePersonalProxyOwner(raw = {}) {
  const owner = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return {
    accountName: normalizeString(owner.account_name || owner.accountName),
    openId: normalizeString(owner.open_id || owner.openId),
    userId: normalizeString(owner.user_id || owner.userId),
    unionId: normalizeString(owner.union_id || owner.unionId),
    chatID: normalizeString(owner.chat_id || owner.chatID || owner.chatId),
    chatType: normalizeString(owner.chat_type || owner.chatType),
    displayName: normalizeString(owner.display_name || owner.displayName || owner.name),
    boundAt: asInt(owner.bound_at || owner.boundAt, 0, 0, Number.MAX_SAFE_INTEGER),
    boundMessageID: normalizeString(owner.bound_message_id || owner.boundMessageID),
  };
}

function readPersonalProxyOwner(accountName) {
  const paths = personalProxyRuntimePaths(accountName);
  return normalizePersonalProxyOwner(readJsonIfExists(paths.owner) || {});
}

function writePersonalProxyOwner(accountName, owner) {
  const paths = personalProxyRuntimePaths(accountName);
  const normalized = normalizePersonalProxyOwner({
    ...owner,
    account_name: accountName,
  });
  writeJsonPretty(paths.owner, {
    account_name: accountName,
    open_id: normalized.openId,
    user_id: normalized.userId,
    union_id: normalized.unionId,
    chat_id: normalized.chatID,
    chat_type: normalized.chatType,
    display_name: normalized.displayName,
    bound_at: normalized.boundAt || Date.now(),
    bound_message_id: normalized.boundMessageID,
  });
  return normalized;
}

function isPersonalProxyOwnerBound(owner = {}) {
  const normalized = normalizePersonalProxyOwner(owner);
  return Boolean(normalized.openId || normalized.userId || normalized.unionId || normalized.chatID);
}

function personalProxyOwnerMatches(owner = {}, senderIdentity = {}, chatID = '') {
  const normalizedOwner = normalizePersonalProxyOwner(owner);
  const sender = normalizeSenderIdentity(senderIdentity);
  if (normalizedOwner.openId && sender.openId && normalizedOwner.openId === sender.openId) return true;
  if (normalizedOwner.userId && sender.userId && normalizedOwner.userId === sender.userId) return true;
  if (normalizedOwner.unionId && sender.unionId && normalizedOwner.unionId === sender.unionId) return true;
  if (normalizedOwner.chatID && chatID && normalizedOwner.chatID === chatID && !isGroupChat(normalizedOwner.chatType)) return true;
  return false;
}

function parsePersonalProxyCommand(rawText = '', personalProxy = {}) {
  const text = normalizeString(rawText);
  if (!text) return null;
  const bindCommand = normalizeString(personalProxy.ownerBindCommand || '/proxy bind-owner');
  if (text === bindCommand || text.startsWith(`${bindCommand} `)) {
    return { type: 'bind_owner' };
  }
  const approveMatch = text.match(/^\/proxy\s+approve\s+([a-z0-9_-]+)\s*$/i);
  if (approveMatch) {
    return { type: 'approve_once', approvalID: approveMatch[1] };
  }
  const approveSessionMatch = text.match(/^\/proxy\s+approve-session\s+([a-z0-9_-]+)\s*$/i);
  if (approveSessionMatch) {
    return { type: 'approve_session', approvalID: approveSessionMatch[1] };
  }
  const denyMatch = text.match(/^\/proxy\s+(?:deny|reject)\s+([a-z0-9_-]+)\s*$/i);
  if (denyMatch) {
    return { type: 'deny', approvalID: denyMatch[1] };
  }
  const statusMatch = text.match(/^\/proxy\s+status\s*$/i);
  if (statusMatch) return { type: 'status' };
  return null;
}

const PERSONAL_PROXY_SENSITIVE_RULES = [
  {
    label: 'secret',
    reason: '可能涉及账号、密码、密钥或 token',
    pattern: /(密钥|密码|口令|token|api[_-]?key|secret|credential|cookie|session|登录态|验证码|2fa|二次验证|授权码|私钥|证书)/i,
  },
  {
    label: 'customer',
    reason: '可能涉及客户、用户或个人信息',
    pattern: /(客户|用户信息|手机号|电话|邮箱|地址|收货人|联系人|身份证|实名|个人信息|隐私|画像|名单|会员|open_id|union_id|user_id)/i,
  },
  {
    label: 'finance',
    reason: '可能涉及财务、订单、支付或经营数据',
    pattern: /(财务|发票|付款|收款|余额|账单|流水|利润|成本|收入|订单|退款|售后|支付|银行卡|对账|报表|销售额|GMV|gmv)/i,
  },
  {
    label: 'internal',
    reason: '可能涉及内部资料、业务后台或未公开信息',
    pattern: /(内部|涉密|保密|后台|管理后台|admin|运营数据|未公开|公司资料|团队资料|会议纪要|项目资料|PRD|需求文档|知识库)/i,
  },
  {
    label: 'code',
    reason: '可能涉及代码仓库、本机文件或执行权限',
    pattern: /(代码|仓库|repo|repository|git|commit|分支|配置文件|本机|终端|命令行|shell|执行命令|运行命令|读文件|读取文件|打开文件|修改文件|部署|发布|数据库|SQL|日志)/i,
  },
  {
    label: 'chat_history',
    reason: '可能涉及历史聊天或他人消息',
    pattern: /(聊天记录|历史消息|私聊|群聊记录|转发给我|看看.*说了什么|谁说过|消息搜索|查.*消息|对话记录)/i,
  },
  {
    label: 'document',
    reason: '可能涉及文档、表格或文件内容读取',
    pattern: /(文档|飞书文档|多维表格|表格|sheet|spreadsheet|wiki|知识空间|附件|文件内容|下载|导出|云文档)/i,
  },
];

function classifyPersonalProxySensitivity(rawText = '', options = {}) {
  const text = normalizeString(rawText);
  const labels = [];
  const reasons = [];
  if (!text) {
    return { sensitive: false, labels, reasons };
  }
  for (const rule of PERSONAL_PROXY_SENSITIVE_RULES) {
    if (!rule.pattern.test(text)) continue;
    labels.push(rule.label);
    reasons.push(rule.reason);
  }
  if (options.hasAttachments) {
    labels.push('attachment');
    reasons.push('消息包含附件，可能需要读取文件或图片内容');
  }
  const uniqueLabels = uniqueStrings(labels).sort();
  const uniqueReasons = uniqueStrings(reasons);
  return {
    sensitive: uniqueLabels.length > 0,
    labels: uniqueLabels,
    reasons: uniqueReasons,
  };
}

function createPersonalProxyApprovalID() {
  return `pp_${Date.now().toString(36)}_${randomBytes(4).toString('hex')}`;
}

function clonePlainObject(value) {
  return JSON.parse(JSON.stringify(value || {}));
}

function readPersonalProxyPendingStore(accountName) {
  const paths = personalProxyRuntimePaths(accountName);
  const store = readJsonIfExists(paths.pending) || {};
  const requests = store.requests && typeof store.requests === 'object' && !Array.isArray(store.requests)
    ? store.requests
    : {};
  return { requests };
}

function writePersonalProxyPendingStore(accountName, store) {
  const paths = personalProxyRuntimePaths(accountName);
  writeJsonPretty(paths.pending, {
    requests: store?.requests && typeof store.requests === 'object' ? store.requests : {},
  });
}

function prunePersonalProxyPendingStore(accountName, store, now = Date.now()) {
  let changed = false;
  const requests = store.requests || {};
  for (const [approvalID, request] of Object.entries(requests)) {
    const expiresAt = Number(request?.expires_at || request?.expiresAt || 0);
    if (expiresAt > 0 && expiresAt <= now) {
      delete requests[approvalID];
      changed = true;
      appendPersonalProxyAudit(accountName, {
        event: 'expired',
        approval_id: approvalID,
      });
    }
  }
  if (changed) writePersonalProxyPendingStore(accountName, store);
  return store;
}

function readPersonalProxyGrantsStore(accountName) {
  const paths = personalProxyRuntimePaths(accountName);
  const store = readJsonIfExists(paths.grants) || {};
  const grants = store.grants && typeof store.grants === 'object' && !Array.isArray(store.grants)
    ? store.grants
    : {};
  return { grants };
}

function writePersonalProxyGrantsStore(accountName, store) {
  const paths = personalProxyRuntimePaths(accountName);
  writeJsonPretty(paths.grants, {
    grants: store?.grants && typeof store.grants === 'object' ? store.grants : {},
  });
}

function personalProxyGrantKey({ chatID = '', senderIdentity = {}, sensitivity = {} } = {}) {
  const sender = normalizeSenderIdentity(senderIdentity);
  const senderKey = sender.openId || sender.userId || sender.unionId || 'anonymous';
  const labels = uniqueStrings(sensitivity.labels || []).sort().join(',');
  return `${normalizeString(chatID) || 'unknown'}::${senderKey}::${labels || 'sensitive'}`;
}

function prunePersonalProxyGrantsStore(accountName, store, now = Date.now()) {
  let changed = false;
  for (const [key, grant] of Object.entries(store.grants || {})) {
    const expiresAt = Number(grant?.expires_at || grant?.expiresAt || 0);
    if (expiresAt > 0 && expiresAt <= now) {
      delete store.grants[key];
      changed = true;
    }
  }
  if (changed) writePersonalProxyGrantsStore(accountName, store);
  return store;
}

function hasPersonalProxySessionGrant(accountName, request = {}) {
  const store = prunePersonalProxyGrantsStore(accountName, readPersonalProxyGrantsStore(accountName));
  const key = personalProxyGrantKey(request);
  const grant = store.grants[key];
  if (!grant) return false;
  return Number(grant.expires_at || 0) > Date.now();
}

function addPersonalProxySessionGrant(accountName, request = {}, ttlMinutes = 30) {
  const store = prunePersonalProxyGrantsStore(accountName, readPersonalProxyGrantsStore(accountName));
  const key = personalProxyGrantKey(request);
  store.grants[key] = {
    key,
    chat_id: normalizeString(request.chatID),
    sender: normalizeSenderIdentity(request.senderIdentity || {}),
    labels: uniqueStrings(request.sensitivity?.labels || []).sort(),
    created_at: Date.now(),
    expires_at: Date.now() + Math.max(1, Number(ttlMinutes) || 30) * 60 * 1000,
    approval_id: normalizeString(request.approvalID),
  };
  writePersonalProxyGrantsStore(accountName, store);
  return store.grants[key];
}

function buildPersonalProxyPendingRequest({
  accountName,
  personalProxy,
  payload,
  taskKey,
  chatID,
  chatType,
  messageID,
  senderIdentity,
  userText,
  historyUserText,
  sensitivity,
} = {}) {
  const approvalID = createPersonalProxyApprovalID();
  const now = Date.now();
  return {
    approval_id: approvalID,
    account_name: normalizeString(accountName),
    status: 'pending',
    created_at: now,
    expires_at: now + Math.max(1, Number(personalProxy?.approvalTtlMinutes) || 30) * 60 * 1000,
    task_key: normalizeString(taskKey),
    chat_id: normalizeString(chatID),
    chat_type: normalizeString(chatType),
    message_id: normalizeString(messageID),
    sender: normalizeSenderIdentity(senderIdentity || {}),
    user_text_preview: compactText(historyUserText || userText, 1200),
    sensitivity,
    payload: clonePlainObject(payload || {}),
  };
}

function savePersonalProxyPendingRequest(accountName, request) {
  const store = prunePersonalProxyPendingStore(accountName, readPersonalProxyPendingStore(accountName));
  store.requests[request.approval_id] = request;
  writePersonalProxyPendingStore(accountName, store);
  return request;
}

function updatePersonalProxyPendingRequest(accountName, approvalID, patch = {}) {
  const normalizedApprovalID = normalizeString(approvalID || patch?.approval_id);
  if (!normalizedApprovalID) return null;
  const store = prunePersonalProxyPendingStore(accountName, readPersonalProxyPendingStore(accountName));
  const current = store.requests[normalizedApprovalID] || null;
  if (!current) return null;
  const next = {
    ...current,
    ...(patch || {}),
    approval_id: current.approval_id,
  };
  store.requests[normalizedApprovalID] = next;
  writePersonalProxyPendingStore(accountName, store);
  return next;
}

function takePersonalProxyPendingRequest(accountName, approvalID) {
  const store = prunePersonalProxyPendingStore(accountName, readPersonalProxyPendingStore(accountName));
  const request = store.requests[approvalID] || null;
  if (!request) return null;
  delete store.requests[approvalID];
  writePersonalProxyPendingStore(accountName, store);
  return request;
}

function normalizeCardActionValue(rawValue) {
  if (!rawValue) return {};
  if (typeof rawValue === 'string') {
    try {
      return JSON.parse(rawValue);
    } catch (_) {
      return {};
    }
  }
  if (typeof rawValue === 'object' && !Array.isArray(rawValue)) return rawValue;
  return {};
}

function extractPersonalProxyCardAction(data = {}) {
  const event = data?.event || {};
  const context = data?.context || event.context || {};
  const action = data?.action || event.action || {};
  const value = normalizeCardActionValue(action.value || action.option || data?.value || data?.event?.value);
  if (value.kind !== 'personal_proxy_approval') return null;
  const operator = data?.operator
    || event.operator
    || data?.operator_id
    || event.operator_id
    || data?.user
    || event.user
    || {};
  const operatorID = operator?.operator_id || operator?.user_id || operator?.sender_id || operator;
  return {
    approvalID: normalizeString(value.approval_id || value.approvalID),
    decision: normalizeString(value.decision),
    approvalCardMessageID: normalizeString(
      data?.open_message_id
      || event.open_message_id
      || context.open_message_id
      || data?.openMessageId
      || event.openMessageId
      || context.openMessageId
      || data?.message_id
      || event.message_id
      || data?.messageID
      || event.messageID
      || ''
    ),
    actorIdentity: normalizeSenderIdentity({
      displayName: operator.name || operator.display_name || operator.displayName || data?.name || event.name || '',
      openId: operator.open_id || operator.openId || operatorID.open_id || operatorID.openId || data?.open_id || event.open_id || data?.openId || event.openId || '',
      userId: operator.user_id || operator.userId || operatorID.user_id || operatorID.userId || data?.user_id || event.user_id || data?.userId || event.userId || '',
      unionId: operator.union_id || operator.unionId || operatorID.union_id || operatorID.unionId || data?.union_id || event.union_id || data?.unionId || event.unionId || '',
      senderType: 'user',
    }),
  };
}

function personalProxyBotLabel(personalProxy = {}, fallback = '9B呆子') {
  return compactText(normalizeString(personalProxy.botName || fallback || '9B呆子'), 40) || '9B呆子';
}

function normalizePersonalProxyApprovalCardStatus(rawStatus = '') {
  const status = normalizeString(rawStatus);
  if (status === 'approve_once' || status === 'approved_once') return 'approved_once';
  if (status === 'approve_session' || status === 'approved_session') return 'approved_session';
  if (status === 'deny' || status === 'denied') return 'denied';
  if (status === 'expired') return 'expired';
  return 'pending';
}

function personalProxyApprovalCardStatusMeta(status) {
  switch (normalizePersonalProxyApprovalCardStatus(status)) {
    case 'approved_once':
      return { label: '已允许一次', template: 'green' };
    case 'approved_session':
      return { label: '已允许本会话类似问题', template: 'green' };
    case 'denied':
      return { label: '已拒绝', template: 'red' };
    case 'expired':
      return { label: '已过期', template: 'grey' };
    default:
      return { label: '待审批', template: 'orange' };
  }
}

function buildPersonalProxyApprovalCard(request, personalProxy = {}, options = {}) {
  const botLabel = personalProxyBotLabel(personalProxy);
  const status = normalizePersonalProxyApprovalCardStatus(options.status || request?.status || 'pending');
  const statusMeta = personalProxyApprovalCardStatusMeta(status);
  const isPending = status === 'pending';
  const actorSummary = buildSenderIdentitySummary(options.actorIdentity || request?.decision_actor || {}, { includeType: false });
  const decidedAt = Number(options.decidedAt || request?.decided_at || 0);
  const decidedAtText = decidedAt > 0 ? new Date(decidedAt).toLocaleString('zh-CN', { hour12: false }) : '';
  const sensitivityReasons = Array.isArray(request?.sensitivity?.reasons) && request.sensitivity.reasons.length > 0
    ? request.sensitivity.reasons.join('\n')
    : '请求可能涉及敏感信息。';
  const senderSummary = buildSenderIdentitySummary(request?.sender || {}, { includeType: false }) || '未知发件人';
  const preview = compactText(request?.user_text_preview || '', 1200) || '(空)';
  const approvalID = normalizeString(request?.approval_id);
  const statusLines = isPending
    ? []
    : [
      `**处理状态**：${statusMeta.label}`,
      actorSummary ? `**处理人**：${actorSummary}` : '',
      decidedAtText ? `**处理时间**：${decidedAtText}` : '',
    ].filter(Boolean);
  const actionValue = (decision) => ({
    kind: 'personal_proxy_approval',
    approval_id: approvalID,
    decision,
  });
  const elements = [
    {
      tag: 'markdown',
      content: [
        ...statusLines,
        `**审批 ID**：${approvalID}`,
        `**提问人**：${senderSummary}`,
        `**来源会话**：${request?.chat_id || '(unknown)'}`,
        `**拦截原因**：\n${sensitivityReasons}`,
        '**对方问题预览**：',
        preview,
      ].join('\n\n'),
    },
  ];
  if (isPending) {
    elements.push({
      tag: 'action',
      actions: [
        {
          tag: 'button',
          text: { tag: 'plain_text', content: '允许一次' },
          type: 'primary',
          value: actionValue('approve_once'),
        },
        {
          tag: 'button',
          text: { tag: 'plain_text', content: '允许本会话类似问题' },
          type: 'default',
          value: actionValue('approve_session'),
        },
        {
          tag: 'button',
          text: { tag: 'plain_text', content: '拒绝' },
          type: 'danger',
          value: actionValue('deny'),
        },
      ],
    });
  }
  return {
    config: {
      wide_screen_mode: true,
      enable_forward: false,
      update_multi: true,
    },
    header: {
      template: statusMeta.template,
      title: {
        tag: 'plain_text',
        content: `${botLabel}隐私审批${isPending ? '' : `（${statusMeta.label}）`}`,
      },
    },
    elements,
  };
}

async function sendPersonalProxyOwnerText(client, owner, text, logTag = 'personal_proxy_owner_notice') {
  const normalizedOwner = normalizePersonalProxyOwner(owner);
  if (!normalizedOwner.chatID) return false;
  return sendTextReplySafe(client, normalizedOwner.chatID, text, logTag);
}

async function sendPersonalProxyOwnerCard(client, owner, card, logTag = 'personal_proxy_owner_card') {
  const normalizedOwner = normalizePersonalProxyOwner(owner);
  if (!normalizedOwner.chatID) return '';
  try {
    const response = await client.im.v1.message.create({
      params: {
        receive_id_type: 'chat_id',
      },
      data: {
        receive_id: normalizedOwner.chatID,
        content: JSON.stringify(card),
        msg_type: 'interactive',
      },
    });
    const messageID = normalizeString(
      response?.data?.message_id
      || response?.data?.messageId
      || response?.message_id
      || response?.messageId
      || ''
    );
    if (!messageID) console.warn(`${logTag}=sent message_id=missing`);
    return messageID;
  } catch (err) {
    console.error(`${logTag}=error message=${err.message}`);
    return '';
  }
}

async function sendPersonalProxyApprovalNotice(client, owner, request, personalProxy = {}) {
  const botLabel = personalProxyBotLabel(personalProxy);
  const card = buildPersonalProxyApprovalCard(request, personalProxy);
  const approvalCardMessageID = await sendPersonalProxyOwnerCard(client, owner, card);
  if (approvalCardMessageID) {
    return { sent: true, via: 'card', approvalCardMessageID };
  }
  const fallbackText = [
    `${botLabel}有一条敏感请求需要你确认：${request.approval_id}`,
    `提问人：${buildSenderIdentitySummary(request.sender || {}) || '未知'}`,
    `原因：${(request.sensitivity?.reasons || []).join('；') || '可能涉及敏感信息'}`,
    '允许：/proxy approve ' + request.approval_id,
    '拒绝：/proxy deny ' + request.approval_id,
  ].join('\n');
  const textSent = await sendPersonalProxyOwnerText(client, owner, fallbackText, 'personal_proxy_owner_text_fallback');
  return { sent: Boolean(textSent), via: textSent ? 'text' : '', approvalCardMessageID: '' };
}

async function patchPersonalProxyApprovalCard(client, request, personalProxy = {}, {
  status = 'pending',
  actorIdentity = {},
  decidedAt = Date.now(),
} = {}) {
  const messageID = normalizeString(
    request?.approval_card_message_id
    || request?.approvalCardMessageID
    || request?.approval_message_id
    || request?.approvalMessageID
    || ''
  );
  if (!messageID || !client?.im?.v1?.message?.patch) return false;
  const card = buildPersonalProxyApprovalCard(
    {
      ...(request || {}),
      status: normalizePersonalProxyApprovalCardStatus(status),
      decision_actor: normalizeSenderIdentity(actorIdentity || {}),
      decided_at: decidedAt,
    },
    personalProxy,
    { status, actorIdentity, decidedAt }
  );
  try {
    await client.im.v1.message.patch({
      path: {
        message_id: messageID,
      },
      data: {
        msg_type: 'interactive',
        content: JSON.stringify(card),
      },
    });
    return true;
  } catch (err) {
    console.error(`personal_proxy_card_patch=error approval_id=${request?.approval_id || '(unknown)'} message_id=${messageID} message=${err.message}`);
    return false;
  }
}

async function handlePersonalProxyCommand({
  client,
  accountName,
  personalProxy,
  command,
  senderIdentity,
  chatID,
  chatType,
  messageID,
  dispatchApprovedRequest,
} = {}) {
  if (!personalProxy?.enabled || !command) return { handled: false };
  if (command.type === 'bind_owner') {
    if (isGroupChat(chatType)) {
      await sendTextReplySafe(client, chatID, `请私聊 ${personalProxyBotLabel(personalProxy)} 执行绑定，避免把审批身份暴露在群里。`, 'personal_proxy_bind_reply');
      return { handled: true };
    }
    const owner = writePersonalProxyOwner(accountName, {
      accountName,
      openId: senderIdentity.openId,
      userId: senderIdentity.userId,
      unionId: senderIdentity.unionId,
      displayName: senderIdentity.displayName,
      chatID,
      chatType,
      boundAt: Date.now(),
      boundMessageID: messageID,
    });
    appendPersonalProxyAudit(accountName, {
      event: 'owner_bound',
      owner: {
        open_id: owner.openId,
        user_id: owner.userId,
        union_id: owner.unionId,
        chat_id: owner.chatID,
      },
    });
    await sendTextReplySafe(client, chatID, `已绑定你为 ${personalProxyBotLabel(personalProxy)} 的隐私审批人。之后敏感请求会先发给你确认。`, 'personal_proxy_bind_reply');
    return { handled: true };
  }

  if (command.type === 'status') {
    const owner = readPersonalProxyOwner(accountName);
    const pending = prunePersonalProxyPendingStore(accountName, readPersonalProxyPendingStore(accountName));
    const grants = prunePersonalProxyGrantsStore(accountName, readPersonalProxyGrantsStore(accountName));
    const ownerText = isPersonalProxyOwnerBound(owner)
      ? `已绑定：${buildSenderIdentitySummary(owner) || owner.chatID}`
      : '未绑定审批人';
    await sendTextReplySafe(
      client,
      chatID,
      [
        `personal_proxy=${personalProxy.enabled ? 'enabled' : 'disabled'}`,
        ownerText,
        `pending=${Object.keys(pending.requests || {}).length}`,
        `session_grants=${Object.keys(grants.grants || {}).length}`,
      ].join('\n'),
      'personal_proxy_status_reply'
    );
    return { handled: true };
  }

  if (command.type === 'approve_once' || command.type === 'approve_session' || command.type === 'deny') {
    const result = await decidePersonalProxyApproval({
      client,
      accountName,
      personalProxy,
      approvalID: command.approvalID,
      decision: command.type,
      actorIdentity: senderIdentity,
      source: 'text_command',
      dispatchApprovedRequest,
    });
    await sendTextReplySafe(client, chatID, result.message, 'personal_proxy_decision_reply');
    return { handled: true };
  }

  return { handled: false };
}

async function decidePersonalProxyApproval({
  client,
  accountName,
  personalProxy,
  approvalID,
  decision,
  actorIdentity,
  approvalCardMessageID = '',
  source = 'unknown',
  dispatchApprovedRequest,
} = {}) {
  const normalizedApprovalID = normalizeString(approvalID);
  const normalizedDecision = normalizeString(decision);
  if (!normalizedApprovalID) {
    return { ok: false, message: '缺少审批 ID。' };
  }
  const owner = readPersonalProxyOwner(accountName);
  if (!isPersonalProxyOwnerBound(owner)) {
    return { ok: false, message: `还没有绑定审批人，请先私聊 ${personalProxyBotLabel(personalProxy)} 发送 ${personalProxy.ownerBindCommand || '/proxy bind-owner'}。` };
  }
  if (!personalProxyOwnerMatches(owner, actorIdentity)) {
    appendPersonalProxyAudit(accountName, {
      event: 'decision_rejected_actor_mismatch',
      approval_id: normalizedApprovalID,
      decision: normalizedDecision,
      source,
      actor: normalizeSenderIdentity(actorIdentity || {}),
    });
    return { ok: false, message: '只有已绑定的审批人可以处理这条请求。' };
  }

  if (normalizedDecision !== 'deny' && normalizedDecision !== 'approve_once' && normalizedDecision !== 'approve_session') {
    return { ok: false, message: `不支持的审批动作：${normalizedDecision || '(empty)'}` };
  }

  const request = takePersonalProxyPendingRequest(accountName, normalizedApprovalID);
  if (!request) {
    return { ok: false, message: `审批请求不存在或已过期：${normalizedApprovalID}` };
  }
  if (approvalCardMessageID && !request.approval_card_message_id) {
    request.approval_card_message_id = normalizeString(approvalCardMessageID);
  }

  if (normalizedDecision === 'deny') {
    await patchPersonalProxyApprovalCard(client, request, personalProxy, {
      status: 'denied',
      actorIdentity,
    });
    appendPersonalProxyAudit(accountName, {
      event: 'denied',
      approval_id: normalizedApprovalID,
      source,
      approval_card_message_id: request.approval_card_message_id || '',
      request: {
        chat_id: request.chat_id,
        message_id: request.message_id,
        sender: request.sender,
        labels: request.sensitivity?.labels || [],
      },
    });
    await sendTextReplySafe(client, request.chat_id, '这个问题需要本人确认，暂时不能提供。', 'personal_proxy_denied_notice');
    return { ok: true, message: `已拒绝：${normalizedApprovalID}` };
  }

  if (normalizedDecision === 'approve_session') {
    addPersonalProxySessionGrant(accountName, {
      approvalID: normalizedApprovalID,
      chatID: request.chat_id,
      senderIdentity: request.sender,
      sensitivity: request.sensitivity,
    }, personalProxy.sessionGrantTtlMinutes);
  }

  appendPersonalProxyAudit(accountName, {
    event: normalizedDecision === 'approve_session' ? 'approved_session' : 'approved_once',
    approval_id: normalizedApprovalID,
    source,
    approval_card_message_id: request.approval_card_message_id || '',
    request: {
      chat_id: request.chat_id,
      message_id: request.message_id,
      sender: request.sender,
      labels: request.sensitivity?.labels || [],
    },
  });
  await patchPersonalProxyApprovalCard(client, request, personalProxy, {
    status: normalizedDecision,
    actorIdentity,
  });
  await sendTextReplySafe(client, request.chat_id, `本人已确认，${personalProxyBotLabel(personalProxy)}开始处理。`, 'personal_proxy_approved_notice');
  if (typeof dispatchApprovedRequest === 'function') {
    dispatchApprovedRequest(request, normalizedDecision);
  }
  return { ok: true, message: `已允许：${normalizedApprovalID}` };
}

async function maybeGatePersonalProxyRequest({
  client,
  accountName,
  personalProxy,
  payload,
  taskKey,
  chatID,
  chatType,
  messageID,
  senderIdentity,
  userText,
  historyUserText,
  hasAttachments = false,
} = {}) {
  if (!personalProxy?.enabled) return { handled: false };
  const dispatchMeta = payload?.dispatchMeta || {};
  if (dispatchMeta.personalProxyApproved) return { handled: false };

  const owner = readPersonalProxyOwner(accountName);
  if (isPersonalProxyOwnerBound(owner) && personalProxyOwnerMatches(owner, senderIdentity, chatID)) {
    return { handled: false };
  }

  const sensitivity = classifyPersonalProxySensitivity(historyUserText || userText, {
    hasAttachments,
    mode: personalProxy.sensitivityMode,
  });
  if (!sensitivity.sensitive) return { handled: false };

  if (hasPersonalProxySessionGrant(accountName, {
    chatID,
    senderIdentity,
    sensitivity,
  })) {
    appendPersonalProxyAudit(accountName, {
      event: 'session_grant_used',
      chat_id: chatID,
      message_id: messageID,
      sender: normalizeSenderIdentity(senderIdentity || {}),
      labels: sensitivity.labels,
    });
    return { handled: false };
  }

  if (!isPersonalProxyOwnerBound(owner)) {
    appendPersonalProxyAudit(accountName, {
      event: 'blocked_missing_owner',
      chat_id: chatID,
      message_id: messageID,
      sender: normalizeSenderIdentity(senderIdentity || {}),
      labels: sensitivity.labels,
    });
    await sendTextReplySafe(
      client,
      chatID,
      `这个问题涉及敏感信息，需要本人确认；但 ${personalProxyBotLabel(personalProxy)} 还没有绑定审批主号。请本人私聊 ${personalProxyBotLabel(personalProxy)} 发送 ${personalProxy.ownerBindCommand}。`,
      'personal_proxy_missing_owner_reply'
    );
    return { handled: true };
  }

  const request = savePersonalProxyPendingRequest(accountName, buildPersonalProxyPendingRequest({
    accountName,
    personalProxy,
    payload,
    taskKey,
    chatID,
    chatType,
    messageID,
    senderIdentity,
    userText,
    historyUserText,
    sensitivity,
  }));
  appendPersonalProxyAudit(accountName, {
    event: 'pending_created',
    approval_id: request.approval_id,
    chat_id: chatID,
    message_id: messageID,
    sender: normalizeSenderIdentity(senderIdentity || {}),
    labels: sensitivity.labels,
  });

  const notice = await sendPersonalProxyApprovalNotice(client, owner, request, personalProxy);
  if (notice?.approvalCardMessageID) {
    request.approval_card_message_id = notice.approvalCardMessageID;
    updatePersonalProxyPendingRequest(accountName, request.approval_id, {
      approval_card_message_id: notice.approvalCardMessageID,
    });
  }
  const noticeSent = Boolean(notice?.sent);
  await sendTextReplySafe(
    client,
    chatID,
    noticeSent
      ? '这个问题涉及敏感信息，我已经发给本人确认。本人允许后我再继续。'
      : `这个问题涉及敏感信息，需要本人确认。审批通知发送失败，请本人私聊 ${personalProxyBotLabel(personalProxy)} 输入 /proxy approve ${request.approval_id} 或 /proxy deny ${request.approval_id}。`,
    'personal_proxy_pending_reply'
  );
  return { handled: true, approvalID: request.approval_id };
}

function extractQuotedMessageIdsFromRawContent(rawContent) {
  return extractQuotedMessageIdsFromParsedContent(safeParseMessageContent(rawContent));
}

function summarizeFeishuMessageContent(messageType, rawContent = '') {
  const type = String(messageType || '').trim().toLowerCase();
  if (type === 'text') {
    return compactText(parseMessageText(rawContent), 1200);
  }
  if (type === 'post') {
    const parsed = parsePostContent(rawContent);
    const lines = [];
    if (parsed.text) lines.push(parsed.text);
    if (Array.isArray(parsed.fileAttachments) && parsed.fileAttachments.length > 0) {
      const fileNames = parsed.fileAttachments.map((item) => item.fileName).filter(Boolean);
      lines.push(fileNames.length > 0 ? `[文件 ${parsed.fileAttachments.length} 个] ${fileNames.join('，')}` : `[文件 ${parsed.fileAttachments.length} 个]`);
    }
    if (Array.isArray(parsed.imageKeys) && parsed.imageKeys.length > 0) {
      lines.push(`[图片 ${parsed.imageKeys.length} 张]`);
    }
    return compactText(lines.join('\n'), 1200);
  }
  if (type === 'file') {
    const parsed = parseFileMessageContent(rawContent);
    const lines = [];
    if (parsed.fileName) lines.push(`文件：${parsed.fileName}`);
    if (parsed.text) lines.push(`附带文字：${parsed.text}`);
    return compactText(lines.join('\n'), 1200);
  }
  if (type === 'audio') {
    const parsed = parseAudioMessageContent(rawContent);
    const durationText = formatDurationFromMs(parsed.durationMs);
    return durationText ? `[语音消息 ${durationText}]` : '[语音消息]';
  }
  if (type === 'image') {
    return '[图片消息]';
  }
  return '';
}

function buildQuotedMessageContextBlock(messageItem = {}) {
  const messageType = String(messageItem?.msg_type || messageItem?.message_type || '').trim().toLowerCase();
  const rawContent = String(messageItem?.body?.content || messageItem?.content || '').trim();
  const summary = summarizeFeishuMessageContent(messageType, rawContent);
  if (!summary) return { promptText: '', historyText: '' };
  const senderSummary = buildSenderIdentitySummary(extractMessageSenderIdentity(messageItem), { includeType: true });
  const lines = [
    '这是用户当前消息里引用/回复的上一条消息，请一并参考：',
  ];
  if (senderSummary) lines.push(`引用消息发送者：${senderSummary}`);
  if (messageType) lines.push(`引用消息类型：${messageType}`);
  lines.push('引用消息内容：');
  lines.push(summary);
  return {
    promptText: lines.join('\n'),
    historyText: compactText(
      [
        `[引用${messageType ? ` ${messageType}` : ''}]`,
        senderSummary ? `发送者：${senderSummary}` : '',
        summary,
      ].filter(Boolean).join(' '),
      800
    ),
  };
}

function buildRecentChatContextFromMessageItems(messageItems = [], {
  currentMessageID = '',
  currentMessageTimestamp = 0,
  maxMessages = FEISHU_CHAT_CONTEXT_MAX_MESSAGES,
  maxChars = FEISHU_CHAT_CONTEXT_MAX_CHARS,
  lookbackMs = FEISHU_CHAT_CONTEXT_LOOKBACK_MS,
} = {}) {
  const targetMessageID = String(currentMessageID || '').trim();
  const items = Array.isArray(messageItems) ? messageItems : [];
  if (!targetMessageID || items.length === 0) return { promptText: '', historyText: '', count: 0 };

  let baseTimestamp = Number(currentMessageTimestamp) || 0;
  if (!baseTimestamp) {
    const currentItem = items.find((item) => {
      const itemMessageID = String(item?.message_id || item?.messageId || '').trim();
      return itemMessageID === targetMessageID;
    });
    baseTimestamp = extractMessageItemTimestamp(currentItem);
  }
  if (!baseTimestamp) return { promptText: '', historyText: '', count: 0 };

  const maxAge = Math.max(0, Number(lookbackMs) || FEISHU_CHAT_CONTEXT_LOOKBACK_MS);
  const candidates = [];
  for (const item of items) {
    const itemMessageID = String(item?.message_id || item?.messageId || '').trim();
    if (!itemMessageID || itemMessageID === targetMessageID || item?.deleted) continue;
    const timestamp = extractMessageItemTimestamp(item);
    if (!timestamp || timestamp >= baseTimestamp) continue;
    if (maxAge > 0 && baseTimestamp - timestamp > maxAge) continue;

    const messageType = String(item?.msg_type || item?.message_type || item?.messageType || '').trim().toLowerCase();
    const rawContent = String(item?.body?.content || item?.content || '').trim();
    const summary = summarizeFeishuMessageContent(messageType, rawContent)
      || `[${buildCrossChatMessageTypeLabel(messageType)}消息]`;
    const compactSummary = compactText(summary, 360).trim();
    if (!compactSummary) continue;
    candidates.push({
      timestamp,
      sender: buildSenderLabel(extractMessageSenderIdentity(item)),
      messageType,
      summary: compactSummary,
    });
  }

  const selected = candidates
    .sort((left, right) => left.timestamp - right.timestamp)
    .slice(-Math.max(1, Number(maxMessages) || FEISHU_CHAT_CONTEXT_MAX_MESSAGES));
  if (selected.length === 0) return { promptText: '', historyText: '', count: 0 };

  const lines = selected.map((item) => {
    const timeLabel = formatCrossChatTimestamp(item.timestamp);
    const typeLabel = buildCrossChatMessageTypeLabel(item.messageType);
    return `${timeLabel ? `${timeLabel} ` : ''}${item.sender || '未知发件人'}（${typeLabel}）：${item.summary}`;
  });
  const rendered = compactText(lines.join('\n'), maxChars);
  return {
    promptText: `当前群聊里，用户点名你之前的最近消息摘要如下。请结合这些消息理解“上面/刚才/这个文件/聊天记录”等指代，但不要主动泄露无关隐私：\n${rendered}`,
    historyText: rendered,
    count: selected.length,
  };
}

async function fetchRecentChatContextFromChatHistory(client, {
  chatID = '',
  currentMessageID = '',
  currentMessageItem = null,
  pageSize = FEISHU_CHAT_CONTEXT_LOOKBACK_PAGE_SIZE,
  logTag = 'chat_context_lookup',
} = {}) {
  const targetChatID = String(chatID || '').trim();
  const targetMessageID = String(currentMessageID || '').trim();
  if (!client || !targetChatID || !targetMessageID) return { promptText: '', historyText: '', count: 0 };

  let historyItems = [];
  let currentTimestamp = extractMessageItemTimestamp(currentMessageItem);

  try {
    const response = await client.im.v1.message.list({
      params: {
        container_id_type: 'chat',
        container_id: targetChatID,
        sort_type: 'ByCreateTimeDesc',
        page_size: Math.max(10, Math.min(50, Number(pageSize) || FEISHU_CHAT_CONTEXT_LOOKBACK_PAGE_SIZE)),
      },
    });
    historyItems = Array.isArray(response?.data?.items) ? response.data.items : [];
    if (!currentTimestamp) {
      const listedCurrentItem = historyItems.find((item) => {
        const itemMessageID = String(item?.message_id || item?.messageId || '').trim();
        return itemMessageID === targetMessageID;
      });
      currentTimestamp = extractMessageItemTimestamp(listedCurrentItem);
    }
  } catch (err) {
    console.error(`${logTag}=error chat_id=${targetChatID} message_id=${targetMessageID} message=${err.message}`);
    return { promptText: '', historyText: '', count: 0 };
  }

  if (!currentTimestamp) {
    const fetchedCurrentItem = await getMessageItemSafe(client, targetMessageID, `${logTag}_current_message_get`);
    currentTimestamp = extractMessageItemTimestamp(fetchedCurrentItem);
    if (fetchedCurrentItem) {
      const fetchedCurrentMessageID = String(fetchedCurrentItem?.message_id || fetchedCurrentItem?.messageId || '').trim();
      if (fetchedCurrentMessageID && !historyItems.some((item) => {
        const itemMessageID = String(item?.message_id || item?.messageId || '').trim();
        return itemMessageID === fetchedCurrentMessageID;
      })) {
        historyItems.push(fetchedCurrentItem);
      }
    }
  }

  return buildRecentChatContextFromMessageItems(historyItems, {
    currentMessageID: targetMessageID,
    currentMessageTimestamp: currentTimestamp,
  });
}

function extractMentionOpenId(mention) {
  return String(
    mention?.id?.open_id
      || mention?.open_id
      || mention?.openId
      || ''
  ).trim();
}

function extractMentionName(mention) {
  return normalizeMentionAlias(
    mention?.name
      || mention?.display_name
      || mention?.displayName
      || mention?.id?.name
      || ''
  );
}

function isBotMentioned(mentions, botOpenId) {
  const target = String(botOpenId || '').trim();
  if (!target) return false;
  for (const mention of mentions || []) {
    if (extractMentionOpenId(mention) === target) return true;
  }
  return false;
}

function detectBotOpenIdCandidate(mentions = [], mentionAliases = []) {
  const aliasSet = new Set(
    (mentionAliases || [])
      .map((item) => normalizeMentionAlias(item))
      .filter(Boolean)
  );
  if (aliasSet.size === 0) return null;

  const matched = [];
  for (const mention of mentions || []) {
    const openId = extractMentionOpenId(mention);
    const name = extractMentionName(mention);
    if (!openId || !name || !aliasSet.has(name)) continue;
    matched.push({ openId, name });
  }

  const uniqueMatches = uniqueStrings(matched.map((item) => item.openId));
  if (uniqueMatches.length !== 1) return null;
  return matched.find((item) => item.openId === uniqueMatches[0]) || null;
}

function reconcileBotOpenIdFromMentions({ accountName, creds, mentions = [], mentionAliases = [] }) {
  const candidate = detectBotOpenIdCandidate(mentions, mentionAliases);
  if (!candidate) return null;

  const targetAccount = String(accountName || 'default').trim() || 'default';
  const current = String(creds?.botOpenId?.value || '').trim();
  const needsPersist = current !== candidate.openId;
  const action = current ? 'reconciled' : 'auto_detected';

  if (creds?.botOpenId) {
    creds.botOpenId.value = candidate.openId;
    creds.botOpenId.source = current === candidate.openId
      ? (creds.botOpenId.source || 'config')
      : `runtime:${action}`;
  }
  if (!needsPersist) return candidate;

  try {
    const saved = upsertConfigEntry('feishu', targetAccount, {
      bot_open_id: candidate.openId,
    });
    if (creds?.botOpenId) creds.botOpenId.source = `config:${action}`;
    console.log(
      `bot_open_id_${action}=ok account=${targetAccount} name=${candidate.name || '(unknown)'} file=${saved.filePath}`
    );
    return candidate;
  } catch (err) {
    console.error(`bot_open_id_${action}=error account=${targetAccount} message=${err.message}`);
    return candidate;
  }
}

function isGroupChat(chatType) {
  const normalized = String(chatType || '').trim().toLowerCase();
  if (!normalized) return true;
  return normalized !== 'p2p';
}

function buildConversationScope(chatID, chatType, senderIdentity = {}, messageID = '') {
  const chat = String(chatID || '').trim();
  const normalizedSender = normalizeSenderIdentity(senderIdentity);
  const actorFragment = normalizedSender.senderType && normalizedSender.senderType !== 'user'
    ? ''
    : buildCarrySenderKey(normalizedSender);
  const actorKey = actorFragment && actorFragment !== 'anonymous'
    ? `actor:${actorFragment}`
    : '';
  if (!chat) {
    return {
      key: '',
      stateKey: '',
      kind: 'missing_chat',
      actorKey,
    };
  }
  if (!isGroupChat(chatType)) {
    return {
      key: chat,
      stateKey: chat,
      kind: 'p2p',
      actorKey,
    };
  }
  return {
    key: chat,
    stateKey: chat,
    kind: 'group_chat',
    actorKey,
  };
}

function isCarryEligibleMessageType(messageType) {
  const normalized = String(messageType || '').trim().toLowerCase();
  return normalized === 'file' || normalized === 'image' || normalized === 'post' || normalized === 'audio';
}

function hasExplicitBotMentionInMessage(message, mentionAliases = [], botOpenId = '') {
  const targetMessage = message || {};
  const messageType = String(targetMessage?.message_type || '').trim().toLowerCase();
  const mentions = Array.isArray(targetMessage?.mentions) ? targetMessage.mentions : [];
  const parsedText = messageType === 'text' ? parseMessageText(targetMessage?.content || '') : '';
  const parsedPost = messageType === 'post' ? parsePostContent(targetMessage?.content || '') : { text: '' };
  const normalizedMessageText = messageType === 'post' ? parsedPost.text : parsedText;
  if (isBotMentioned(mentions, botOpenId)) return true;
  if (detectBotOpenIdCandidate(mentions, mentionAliases)) return true;
  return Boolean(detectTextualBotMention(normalizedMessageText, mentionAliases));
}

function shouldRequireMentionForMessage(messageType, parsedPost = null) {
  return true;
}

function buildDispatchEnvelope(data, {
  mentionAliases = [],
  botOpenId = '',
  recentTextInputs = null,
  recentAttachmentInputs = null,
} = {}) {
  const eventData = data || {};
  const message = eventData?.message || {};
  const chatID = String(message.chat_id || '').trim();
  const chatType = String(message.chat_type || '').trim().toLowerCase();
  const messageID = String(message.message_id || '').trim();
  const senderIdentity = extractEventSenderIdentity(eventData);
  const messageType = String(message.message_type || '').trim().toLowerCase();
  const now = Date.now();
  const conversationScope = buildConversationScope(chatID, chatType, senderIdentity, messageID);
  const parsedPost = messageType === 'post' ? parsePostContent(message.content || '') : null;
  const explicitBotMention = hasExplicitBotMentionInMessage(message, mentionAliases, botOpenId);
  const parsedText = messageType === 'text' ? parseMessageText(message.content || '') : '';
  const normalizedText = messageType === 'text'
    ? normalizeIncomingText(parsedText, message.mentions || [], mentionAliases)
    : '';
  const mentionRequired = shouldRequireMentionForMessage(messageType, parsedPost);
  const currentAttachmentBundle = extractAttachmentBundleFromMessage({
    messageType,
    rawContent: message.content || '',
    messageID,
    mentions: message.mentions || [],
    mentionAliases,
    timestamp: now,
  });

  let allowMentionCarry = false;
  let recentTextInput = null;
  if (recentTextInputs) {
    pruneRecentTextCarryState(recentTextInputs, now);
    if (messageType === 'text' && (shouldStoreTextForAttachmentCarry(normalizedText) || explicitBotMention)) {
      rememberRecentTextCarry(recentTextInputs, {
        chatID,
        chatType,
        senderIdentity,
        messageID,
        text: normalizedText,
        explicitBotMention,
        now,
      });
    } else if (isCarryEligibleMessageType(messageType)) {
      recentTextInput = getRecentTextCarry(recentTextInputs, {
        chatID,
        chatType,
        senderIdentity,
        messageID,
        now,
      });
      allowMentionCarry = Boolean(recentTextInput?.explicitBotMention) && mentionRequired;
    }
  }

  let recentAttachmentInput = null;
  if (recentAttachmentInputs) {
    pruneRecentAttachmentCarryState(recentAttachmentInputs, now);
    if (hasAttachmentBundleContent(currentAttachmentBundle)) {
      rememberRecentAttachmentCarry(recentAttachmentInputs, {
        chatID,
        chatType,
        senderIdentity,
        messageID,
        attachmentBundle: currentAttachmentBundle,
        now,
      });
    } else if (messageType === 'text' && (explicitBotMention || !isGroupChat(chatType))) {
      recentAttachmentInput = getRecentAttachmentCarry(recentAttachmentInputs, {
        chatID,
        chatType,
        senderIdentity,
        messageID,
        now,
      });
    }
  }

  return {
    taskKey: conversationScope.key || chatID || messageID || 'unknown',
    shouldSupersedeActiveTask: !isGroupChat(chatType)
      || explicitBotMention
      || allowMentionCarry
      || Boolean(recentTextInput)
      || Boolean(recentAttachmentInput),
    payload: {
      eventData,
      dispatchMeta: {
        explicitBotMention,
        allowMentionCarry,
        mentionRequired,
        allowTextCarry: Boolean(recentTextInput),
        recentText: recentTextInput?.text || '',
        recentTextMessageID: recentTextInput?.messageID || '',
        allowAttachmentCarry: Boolean(recentAttachmentInput),
        recentAttachments: recentAttachmentInput || null,
        receivedAt: now,
      },
    },
  };
}

function buildCarrySenderKey(senderIdentity = {}) {
  const normalized = normalizeSenderIdentity(senderIdentity);
  if (normalized.openId) return `open:${normalized.openId}`;
  if (normalized.userId) return `user:${normalized.userId}`;
  if (normalized.unionId) return `union:${normalized.unionId}`;
  const normalizedName = normalizeAliasText(normalized.displayName).toLowerCase();
  if (normalizedName) return `name:${normalizedName}`;
  return 'anonymous';
}

function buildRecentTextCarryKey(chatID, chatType, senderIdentity = {}, messageID = '') {
  const chat = String(chatID || '').trim();
  if (!chat) return '';
  const sender = buildCarrySenderKey(senderIdentity);
  if (!isGroupChat(chatType)) {
    return sender && sender !== 'anonymous' ? sender : chat;
  }
  return `${chat}:${sender || 'anonymous'}`;
}

function pruneRecentTextCarryState(stateMap, now = Date.now()) {
  if (!stateMap || typeof stateMap.size !== 'number' || stateMap.size === 0) return;
  for (const [key, value] of stateMap.entries()) {
    if (!value || now - value.timestamp > FEISHU_ATTACHMENT_TEXT_CARRY_WINDOW_MS) {
      stateMap.delete(key);
    }
  }
}

function shouldStoreTextForAttachmentCarry(text = '') {
  const normalized = compactText(String(text || ''), 4000).trim();
  if (!normalized) return false;
  if (/^\//.test(normalized)) return false;
  return true;
}

function rememberRecentTextCarry(stateMap, {
  chatID = '',
  chatType = '',
  senderIdentity = {},
  messageID = '',
  text = '',
  explicitBotMention = false,
  now = Date.now(),
} = {}) {
  const key = buildRecentTextCarryKey(chatID, chatType, senderIdentity, messageID);
  const normalizedText = compactText(String(text || ''), 4000).trim();
  const normalizedExplicitMention = Boolean(explicitBotMention);
  if (!key || (!normalizedText && !normalizedExplicitMention)) return;
  stateMap.set(key, {
    timestamp: now,
    messageID: String(messageID || '').trim(),
    text: normalizedText,
    explicitBotMention: normalizedExplicitMention,
  });
}

function getRecentTextCarry(stateMap, {
  chatID = '',
  chatType = '',
  senderIdentity = {},
  messageID = '',
  now = Date.now(),
} = {}) {
  const key = buildRecentTextCarryKey(chatID, chatType, senderIdentity, messageID);
  if (!key) return null;
  const cached = stateMap.get(key);
  if (!cached) return null;
  if (now - cached.timestamp > FEISHU_ATTACHMENT_TEXT_CARRY_WINDOW_MS) {
    stateMap.delete(key);
    return null;
  }
  return cached;
}

function consumeRecentTextCarry(stateMap, {
  chatID = '',
  chatType = '',
  senderIdentity = {},
  messageID = '',
} = {}) {
  const key = buildRecentTextCarryKey(chatID, chatType, senderIdentity, messageID);
  if (!key) return null;
  const cached = stateMap.get(key) || null;
  if (cached) stateMap.delete(key);
  return cached;
}

function pruneRecentAttachmentCarryState(stateMap, now = Date.now()) {
  if (!stateMap || typeof stateMap.size !== 'number' || stateMap.size === 0) return;
  for (const [key, entries] of stateMap.entries()) {
    const normalizedEntries = Array.isArray(entries)
      ? entries.filter((entry) => entry && now - Number(entry.timestamp || 0) <= FEISHU_ATTACHMENT_TEXT_CARRY_WINDOW_MS)
      : [];
    if (normalizedEntries.length === 0) {
      stateMap.delete(key);
      continue;
    }
    normalizedEntries.sort((left, right) => Number(left.timestamp || 0) - Number(right.timestamp || 0));
    stateMap.set(key, normalizedEntries);
  }
}

function rememberRecentAttachmentCarry(stateMap, {
  chatID = '',
  chatType = '',
  senderIdentity = {},
  messageID = '',
  attachmentBundle = null,
  now = Date.now(),
} = {}) {
  const key = buildRecentTextCarryKey(chatID, chatType, senderIdentity, messageID);
  const bundle = buildAttachmentBundle({
    ...(attachmentBundle || {}),
    messageID: attachmentBundle?.messageID || messageID,
    timestamp: now,
  });
  if (!key || !hasAttachmentBundleContent(bundle)) return;
  const existing = Array.isArray(stateMap.get(key)) ? stateMap.get(key) : [];
  const filtered = existing.filter((entry) => String(entry?.messageID || '').trim() !== bundle.messageID);
  filtered.push(bundle);
  filtered.sort((left, right) => Number(left.timestamp || 0) - Number(right.timestamp || 0));
  stateMap.set(key, filtered);
}

function getRecentAttachmentCarry(stateMap, {
  chatID = '',
  chatType = '',
  senderIdentity = {},
  messageID = '',
  now = Date.now(),
} = {}) {
  const key = buildRecentTextCarryKey(chatID, chatType, senderIdentity, messageID);
  if (!key) return null;
  const entries = Array.isArray(stateMap.get(key)) ? stateMap.get(key) : [];
  if (entries.length === 0) return null;
  const targetMessageID = String(messageID || '').trim();
  const matched = entries.filter((entry) => {
    const entryMessageID = String(entry?.messageID || '').trim();
    return entryMessageID && entryMessageID !== targetMessageID && now - Number(entry.timestamp || 0) <= FEISHU_ATTACHMENT_TEXT_CARRY_WINDOW_MS;
  });
  return mergeAttachmentBundles(matched);
}

function consumeRecentAttachmentCarry(stateMap, {
  chatID = '',
  chatType = '',
  senderIdentity = {},
  messageID = '',
  messageIDs = [],
} = {}) {
  const key = buildRecentTextCarryKey(chatID, chatType, senderIdentity, messageID);
  if (!key) return [];
  const entries = Array.isArray(stateMap.get(key)) ? stateMap.get(key) : [];
  if (entries.length === 0) return [];
  const wanted = new Set(
    uniqueStrings([
      messageID,
      ...(messageIDs || []),
    ])
  );
  if (wanted.size === 0) return [];
  const kept = [];
  const removed = [];
  for (const entry of entries) {
    const entryMessageID = String(entry?.messageID || '').trim();
    if (entryMessageID && wanted.has(entryMessageID)) removed.push(entry);
    else kept.push(entry);
  }
  if (kept.length > 0) stateMap.set(key, kept);
  else stateMap.delete(key);
  return removed;
}

function normalizeReplyText(prefix, text) {
  const plainText = String(text || '').trim();
  if (!plainText) return '';
  const cleanPrefix = String(prefix || '');
  return `${cleanPrefix}${plainText}`;
}

function compactText(raw, maxLength = 2000) {
  const text = String(raw || '').replace(/\r/g, '').trim();
  if (!text) return '';
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}\n...(已截断)`;
}

function sanitizeLocalFileName(rawName, fallback = 'attachment.bin') {
  const normalized = path.basename(String(rawName || '').trim() || fallback);
  const cleaned = normalized
    .replace(/[\u0000-\u001f]/g, '_')
    .replace(/[<>:"/\\|?*]/g, '_')
    .trim();
  if (!cleaned || cleaned === '.' || cleaned === '..') return fallback;
  return cleaned.slice(0, 180);
}

function buildDefaultFeishuWorkspaceDir(accountName = '') {
  const safeAccount = sanitizeLocalFileName(String(accountName || 'default').trim() || 'default', 'default');
  return path.join(FEISHU_WORKSPACE_ROOT, safeAccount);
}

function resolveFeishuWorkspaceConfig(config, accountName = '') {
  const workspaceConfig = config.workspace || {};
  const rawDir = getArg(
    '--workspace-dir',
    process.env.FEISHU_WORKSPACE_DIR
      || workspaceConfig.dir
      || config.workspace_dir
      || config.file_workspace_dir
      || ''
  );
  const dir = resolveOptionalPath(rawDir || buildDefaultFeishuWorkspaceDir(accountName), REPO_DIR);
  return {
    dir,
    incomingDir: path.join(dir, 'incoming'),
    outputDir: path.join(dir, 'outputs'),
    tempDir: path.join(dir, 'tmp'),
  };
}

function ensureFeishuWorkspaceDirs(workspace) {
  for (const dirPath of [workspace?.dir, workspace?.incomingDir, workspace?.outputDir, workspace?.tempDir]) {
    if (!dirPath) continue;
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function buildIncomingAttachmentDir(workspaceDir = '', accountName = '', messageType = '', messageID = '') {
  const safeType = sanitizeLocalFileName(String(messageType || 'attachment').trim() || 'attachment', 'attachment');
  const dateText = new Date().toISOString().slice(0, 10);
  const safeMessageID = sanitizeLocalFileName(String(messageID || '').trim() || `${Date.now()}`, 'message');
  const baseDir = workspaceDir ? path.resolve(workspaceDir) : buildDefaultFeishuWorkspaceDir(accountName);
  return path.join(baseDir, 'incoming', dateText, safeType, safeMessageID);
}

function buildUniqueFilePath(dirPath, rawName, fallback = 'attachment.bin') {
  const safeName = sanitizeLocalFileName(rawName, fallback);
  const ext = path.extname(safeName);
  const base = path.basename(safeName, ext) || 'attachment';
  let candidate = path.join(dirPath, safeName);
  let seq = 1;
  while (fs.existsSync(candidate)) {
    candidate = path.join(dirPath, `${base}-${seq}${ext}`);
    seq += 1;
  }
  return {
    filePath: candidate,
    fileName: path.basename(candidate),
  };
}

function formatDownloadRelativePath(filePath = '') {
  const resolved = path.resolve(String(filePath || ''));
  const relative = path.relative(os.homedir(), resolved);
  if (!relative || relative.startsWith('..')) return resolved;
  return relative.split(path.sep).join('/');
}

function formatBytes(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let size = value;
  let idx = 0;
  while (size >= 1024 && idx < units.length - 1) {
    size /= 1024;
    idx += 1;
  }
  const digits = size >= 100 || idx === 0 ? 0 : size >= 10 ? 1 : 2;
  return `${size.toFixed(digits)} ${units[idx]}`;
}

function resolveFeishuUploadFileType(filePath) {
  const ext = path.extname(String(filePath || '')).trim().toLowerCase();
  if (ext === '.pdf') return 'pdf';
  if (ext === '.doc' || ext === '.docx') return 'doc';
  if (ext === '.xls' || ext === '.xlsx' || ext === '.csv') return 'xls';
  if (ext === '.ppt' || ext === '.pptx' || ext === '.key') return 'ppt';
  if (ext === '.mp4' || ext === '.mov' || ext === '.m4v') return 'mp4';
  if (ext === '.opus') return 'opus';
  return 'stream';
}

function isFeishuMediaFilePath(filePath) {
  const ext = path.extname(String(filePath || '')).trim().toLowerCase();
  return ext === '.mp4' || ext === '.mov' || ext === '.m4v';
}

function resolveLocalFilePath(rawFilePath, cwd = '') {
  let raw = String(rawFilePath || '').trim();
  if (!raw) return '';
  raw = raw.replace(/^['"]+|['"]+$/g, '').trim();
  if (!raw) return '';
  return path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(cwd || process.cwd(), raw);
}

function extractMarkdownLinkTarget(rawTarget) {
  const target = String(rawTarget || '').trim();
  if (!target) return '';
  const angleWrapped = target.match(/^<([^>]+)>$/);
  if (angleWrapped) return String(angleWrapped[1] || '').trim();
  const plainTarget = target.match(/^(\S+?)(?:\s+["'][\s\S]*["'])?$/);
  return plainTarget ? String(plainTarget[1] || '').trim() : target;
}

function resolveLocalMarkdownResourcePath(rawTarget, cwd = '') {
  let target = extractMarkdownLinkTarget(rawTarget);
  if (!target) return '';

  if (/^file:\/\//i.test(target)) {
    target = target.replace(/^file:\/\//i, '');
    try {
      target = decodeURIComponent(target);
    } catch (_) {
      // ignore malformed URI sequences and keep the raw path
    }
    if (/^\/[A-Za-z]:[\\/]/.test(target)) {
      target = target.slice(1);
    }
  }

  if (/^(https?:|mailto:|data:|#)/i.test(target)) return '';
  if (/^[a-z][a-z0-9+.-]*:/i.test(target) && !/^file:/i.test(target)) return '';
  return resolveLocalFilePath(target, cwd);
}

function pushAttachmentCandidate(attachments, seen, type, targetPath) {
  const normalizedType = type === 'image' ? 'image' : 'file';
  const normalizedPath = String(targetPath || '').trim();
  if (!normalizedPath) return false;
  const dedupeKey = `${normalizedType}:${normalizedPath}`;
  if (seen.has(dedupeKey)) return false;
  seen.add(dedupeKey);
  attachments.push({
    type: normalizedType,
    path: normalizedPath,
  });
  return true;
}

function extractFeishuAttachmentDirectives(rawText) {
  const lines = String(rawText || '').replace(/\r/g, '').split('\n');
  const attachments = [];
  const keptLines = [];
  const seen = new Set();

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.endsWith(']]')) {
      if (trimmed.startsWith(FEISHU_SEND_FILE_DIRECTIVE_PREFIX)) {
        const payload = trimmed.slice(FEISHU_SEND_FILE_DIRECTIVE_PREFIX.length, -2).trim();
        const dedupeKey = `file:${payload}`;
        if (payload && !seen.has(dedupeKey)) {
          seen.add(dedupeKey);
          attachments.push({ type: 'file', path: payload });
        }
        continue;
      }
      if (trimmed.startsWith(FEISHU_SEND_IMAGE_DIRECTIVE_PREFIX)) {
        const payload = trimmed.slice(FEISHU_SEND_IMAGE_DIRECTIVE_PREFIX.length, -2).trim();
        const dedupeKey = `image:${payload}`;
        if (payload && !seen.has(dedupeKey)) {
          seen.add(dedupeKey);
          attachments.push({ type: 'image', path: payload });
        }
        continue;
      }
    }
    keptLines.push(line);
  }

  return {
    text: keptLines.join('\n').replace(/\n{3,}/g, '\n\n').trim(),
    attachments,
  };
}

function buildAttachmentSendResultText(sent = [], failed = []) {
  const lines = [];
  const sentImages = sent.filter((item) => item.type === 'image');
  const sentFiles = sent.filter((item) => item.type === 'file' || item.type === 'media');
  if (sentImages.length > 0) {
    lines.push(`[已发送图片] ${sentImages.map((item) => item.fileName).join('，')}`);
  }
  if (sentFiles.length > 0) {
    lines.push(`[已发送文件] ${sentFiles.map((item) => item.fileName).join('，')}`);
  }
  if (failed.length > 0) {
    lines.push(`[附件发送失败] ${failed.map((item) => `${item.fileName}：${item.error}`).join('；')}`);
  }
  return lines.join('\n').trim();
}

function buildAttachmentSendFailureReply(sent = [], failed = []) {
  if (failed.length === 0) return '';
  const details = failed.map((item) => `${item.fileName}（${item.error}）`).join('；');
  const sentCount = sent.length;
  if (sentCount === 0) {
    return compactText(`附件发送失败：${details}`, FEISHU_TEXT_CHUNK_LIMIT);
  }
  return compactText(`已发送 ${sentCount} 个附件；以下附件发送失败：${details}`, FEISHU_TEXT_CHUNK_LIMIT);
}

function buildDefaultAttachmentReply(attachments = []) {
  const imageCount = attachments.filter((item) => item.type === 'image').length;
  const fileCount = attachments.filter((item) => item.type === 'file' || item.type === 'media').length;
  if (imageCount > 0 && fileCount === 0) return '图片已发送，请查收。';
  if (fileCount > 0 && imageCount === 0) return '文件已发送，请查收。';
  if (imageCount > 0 || fileCount > 0) return '附件已发送，请查收。';
  return '';
}

function shouldSendLocalFilesForRequest(rawText = '') {
  const text = String(rawText || '').replace(/\s+/g, '').toLowerCase();
  if (!text) return false;
  return /(发我|发给我|给我发|把文件发|把附件发|附件|下载|导出|导给我|传给我|文件给我|要文件|sendmethefile|sendthefile|attachment|downloadfile|exportfile)/i.test(text);
}

function extractFeishuReplyResources(rawText, {
  cwd = '',
  preferFileAttachments = false,
} = {}) {
  const directivePlan = extractFeishuAttachmentDirectives(rawText);
  const attachments = [];
  const seen = new Set();

  for (const attachment of directivePlan.attachments) {
    const resolvedPath = resolveLocalFilePath(attachment.path, cwd) || String(attachment.path || '').trim();
    pushAttachmentCandidate(attachments, seen, attachment.type, resolvedPath);
  }

  const lines = String(directivePlan.text || '').replace(/\r/g, '').split('\n');
  const cleanedLines = [];
  let inCodeFence = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (/^```/.test(trimmed)) {
      inCodeFence = !inCodeFence;
      cleanedLines.push(line);
      continue;
    }

    if (inCodeFence) {
      cleanedLines.push(line);
      continue;
    }

    let nextLine = line;
    nextLine = nextLine.replace(/!\[([^\]]*)]\(([^)\n]+)\)/g, (full, alt, rawTarget) => {
      const localPath = resolveLocalMarkdownResourcePath(rawTarget, cwd);
      if (!localPath) return full;
      pushAttachmentCandidate(attachments, seen, 'image', localPath);
      const altText = String(alt || '').trim();
      if (!altText || /^(image|图片)$/i.test(altText)) return '';
      return altText;
    });
    nextLine = nextLine.replace(/\[([^\]]+)]\(([^)\n]+)\)/g, (full, label, rawTarget) => {
      const localPath = resolveLocalMarkdownResourcePath(rawTarget, cwd);
      if (!localPath) return full;
      const resourceType = isImageFilePath(localPath) ? 'image' : 'file';
      if (resourceType === 'image' || preferFileAttachments) {
        pushAttachmentCandidate(attachments, seen, resourceType, localPath);
      }
      const fallbackLabel = sanitizeLocalFileName(path.basename(localPath), '附件');
      const rawLabel = String(label || '').trim();
      const displayLabel = /^(?:~\/|\.\.?\/|\/)/.test(rawLabel) ? fallbackLabel : rawLabel;
      return displayLabel || fallbackLabel;
    });
    cleanedLines.push(nextLine);
  }

  return {
    text: cleanedLines
      .join('\n')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim(),
    attachments,
  };
}

function cleanMemoryText(raw) {
  let text = String(raw || '').replace(/\r/g, '\n');
  if (!text.trim()) return '';
  text = text.replace(/\[\[FEISHU_SEND_(?:FILE|IMAGE):[^\]]+]]/gi, ' ');
  text = text.replace(/```[\s\S]*?```/g, ' [代码] ');
  text = text.replace(/`[^`\n]+`/g, ' [代码] ');
  text = text.replace(/!\[([^\]]*)]\(([^)]+)\)/g, ' $1 ');
  text = text.replace(/\[([^\]]+)]\(([^)]+)\)/g, ' $1 ');
  text = text.replace(/(^|[\s(])((?:~\/|\.\.?\/|\/(?:[^\/\s)]+\/)+)[^\s)]+)/g, '$1<path>');
  text = text.replace(/https?:\/\/\S+/gi, '<url>');
  text = text.replace(/\s+/g, ' ').trim();
  return text;
}

function clampMemoryText(raw, maxLength = FEISHU_MEMORY_MAX_ITEM_CHARS) {
  return compactText(cleanMemoryText(raw), maxLength);
}

function normalizeMemoryKey(raw) {
  return cleanMemoryText(raw).toLowerCase();
}

function extractMemoryKeywords(raw) {
  const text = cleanMemoryText(raw);
  if (!text) return '';
  const matches = text.match(FEISHU_MEMORY_KEYWORD_PATTERN) || [];
  return uniqueStrings(matches.map((item) => String(item || '').toLowerCase())).slice(0, 12).join(',');
}

function normalizeMemoryScope(rawScope) {
  const scope = String(rawScope || '').trim();
  if (scope === FEISHU_MEMORY_SCOPE_PROFILE) return scope;
  if (scope === FEISHU_MEMORY_SCOPE_ROLE) return scope;
  return FEISHU_MEMORY_SCOPE_HISTORY;
}

function normalizeMemoryItem(rawItem, fallbackScope = FEISHU_MEMORY_SCOPE_HISTORY) {
  const base = rawItem && typeof rawItem === 'object' ? rawItem : {};
  const scope = normalizeMemoryScope(base.scope || fallbackScope);
  const content = clampMemoryText(base.content || base.summary, FEISHU_MEMORY_MAX_ITEM_CHARS);
  const summary = clampMemoryText(base.summary || base.content, FEISHU_MEMORY_MAX_ITEM_CHARS);
  if (!content && !summary) return null;
  const now = Date.now();
  const dedupeSeed = base.dedupeKey || `${scope}|${summary || content}`;
  return {
    scope,
    memoryType: clampMemoryText(base.memoryType || '', 40),
    content: content || summary,
    summary: summary || content,
    keywords: clampMemoryText(base.keywords || extractMemoryKeywords(`${summary} ${content}`), 120),
    source: clampMemoryText(base.source || '', 80),
    dedupeKey: normalizeMemoryKey(dedupeSeed),
    importance: asInt(base.importance, 70, 0, 100),
    confidence: asInt(base.confidence, 80, 0, 100),
    hitCount: asInt(base.hitCount, 1, 1, 1000000),
    createdAt: asInt(base.createdAt, now, 0, Number.MAX_SAFE_INTEGER),
    updatedAt: asInt(base.updatedAt, now, 0, Number.MAX_SAFE_INTEGER),
  };
}

function compareMemoryItems(a, b) {
  if ((a?.importance || 0) !== (b?.importance || 0)) return (b?.importance || 0) - (a?.importance || 0);
  if ((a?.hitCount || 0) !== (b?.hitCount || 0)) return (b?.hitCount || 0) - (a?.hitCount || 0);
  return (b?.updatedAt || 0) - (a?.updatedAt || 0);
}

function upsertMemoryItem(list, rawItem, limit) {
  const item = normalizeMemoryItem(rawItem, rawItem?.scope);
  if (!item) return null;
  const items = Array.isArray(list) ? list : [];
  const now = Date.now();
  const idx = items.findIndex((entry) => normalizeMemoryKey(entry?.dedupeKey || '') === item.dedupeKey);
  if (idx >= 0) {
    const prev = normalizeMemoryItem(items[idx], item.scope) || item;
    const mergedKeywords = uniqueStrings([
      ...String(prev.keywords || '').split(','),
      ...String(item.keywords || '').split(','),
    ].map((part) => part.trim()).filter(Boolean)).join(',');
    items[idx] = {
      ...prev,
      ...item,
      keywords: mergedKeywords,
      importance: Math.max(prev.importance || 0, item.importance || 0),
      confidence: Math.max(prev.confidence || 0, item.confidence || 0),
      hitCount: Math.max(1, (prev.hitCount || 1) + 1),
      createdAt: prev.createdAt || now,
      updatedAt: now,
    };
  } else {
    items.push({
      ...item,
      createdAt: item.createdAt || now,
      updatedAt: now,
    });
  }
  items.sort(compareMemoryItems);
  while (items.length > limit) items.pop();
  return idx >= 0 ? items[idx] : items[items.length - 1];
}

function normalizeRecentTurn(rawTurn) {
  const turn = rawTurn && typeof rawTurn === 'object' ? rawTurn : {};
  const role = String(turn.role || '').trim().toLowerCase() === 'assistant' ? 'assistant' : 'user';
  const text = clampMemoryText(turn.text, FEISHU_MEMORY_MAX_RECENT_TURN_CHARS);
  if (!text) return null;
  return {
    role,
    text,
    threadId: clampMemoryText(turn.threadId || '', 40),
    at: asInt(turn.at, Date.now(), 0, Number.MAX_SAFE_INTEGER),
  };
}

function pushRecentTurn(turns, rawTurn, limit = FEISHU_MEMORY_STORE_MAX_RECENT_TURNS) {
  const nextTurn = normalizeRecentTurn(rawTurn);
  if (!nextTurn) return null;
  const list = Array.isArray(turns) ? turns : [];
  const last = list[list.length - 1];
  if (last && last.role === nextTurn.role && last.text === nextTurn.text) {
    last.at = nextTurn.at;
    last.threadId = nextTurn.threadId || last.threadId;
    return last;
  }
  list.push(nextTurn);
  while (list.length > limit) list.shift();
  return nextTurn;
}

function normalizeLiveToolFact(rawFact) {
  const fact = rawFact && typeof rawFact === 'object' ? rawFact : { text: rawFact };
  const text = clampMemoryText(fact.text, FEISHU_MEMORY_MAX_LIVE_TOOL_FACT_CHARS);
  if (!text) return null;
  return {
    text,
    at: asInt(fact.at, Date.now(), 0, Number.MAX_SAFE_INTEGER),
  };
}

function pushLiveToolFact(facts, rawFact, limit = FEISHU_MEMORY_STORE_MAX_LIVE_TOOL_FACTS) {
  const nextFact = normalizeLiveToolFact(rawFact);
  if (!nextFact) return null;
  const list = Array.isArray(facts) ? facts : [];
  const last = list[list.length - 1];
  if (last && last.text === nextFact.text) {
    last.at = nextFact.at;
    return last;
  }
  list.push(nextFact);
  while (list.length > limit) list.shift();
  return nextFact;
}

function botMemoryStorePath(accountName) {
  const safeAccount = sanitizeLocalFileName(String(accountName || 'default').trim() || 'default', 'default');
  return path.join(FEISHU_MEMORY_DIR, `${safeAccount}.json`);
}

function createEmptyBotMemoryStore(accountName) {
  return {
    version: 1,
    accountName: String(accountName || 'default').trim() || 'default',
    updatedAt: Date.now(),
    profileFacts: [],
    roleMemoryItems: [],
    historyItems: [],
    recentTurns: [],
    liveToolFacts: [],
  };
}

function normalizeBotMemoryStore(accountName, rawStore) {
  const base = rawStore && typeof rawStore === 'object' ? rawStore : {};
  const empty = createEmptyBotMemoryStore(accountName);
  return {
    version: 1,
    accountName: String(base.accountName || empty.accountName).trim() || empty.accountName,
    updatedAt: asInt(base.updatedAt, Date.now(), 0, Number.MAX_SAFE_INTEGER),
    profileFacts: Array.isArray(base.profileFacts)
      ? base.profileFacts.map((item) => normalizeMemoryItem(item, FEISHU_MEMORY_SCOPE_PROFILE)).filter(Boolean).sort(compareMemoryItems).slice(0, FEISHU_MEMORY_STORE_MAX_PROFILE_FACTS)
      : [],
    roleMemoryItems: Array.isArray(base.roleMemoryItems)
      ? base.roleMemoryItems.map((item) => normalizeMemoryItem(item, FEISHU_MEMORY_SCOPE_ROLE)).filter(Boolean).sort(compareMemoryItems).slice(0, FEISHU_MEMORY_STORE_MAX_ROLE_FACTS)
      : [],
    historyItems: Array.isArray(base.historyItems)
      ? base.historyItems.map((item) => normalizeMemoryItem(item, FEISHU_MEMORY_SCOPE_HISTORY)).filter(Boolean).sort(compareMemoryItems).slice(0, FEISHU_MEMORY_STORE_MAX_HISTORY_ITEMS)
      : [],
    recentTurns: Array.isArray(base.recentTurns)
      ? base.recentTurns.map((item) => normalizeRecentTurn(item)).filter(Boolean).slice(-FEISHU_MEMORY_STORE_MAX_RECENT_TURNS)
      : [],
    liveToolFacts: Array.isArray(base.liveToolFacts)
      ? base.liveToolFacts.map((item) => normalizeLiveToolFact(item)).filter(Boolean).slice(-FEISHU_MEMORY_STORE_MAX_LIVE_TOOL_FACTS)
      : [],
  };
}

function syncRoleMemoryTextIntoStore(store, roleMemoryText = '') {
  const nextStore = normalizeBotMemoryStore(store?.accountName || 'default', store);
  const retained = nextStore.roleMemoryItems.filter((item) => item.source !== 'config_role_memory');
  nextStore.roleMemoryItems = retained;

  const lines = uniqueStrings(
    String(roleMemoryText || '')
      .replace(/\r/g, '\n')
      .split('\n')
      .map((line) => line.replace(/^\s*(?:[-*•]|\d+[\.\)、:：-])\s*/, ''))
      .map((line) => clampMemoryText(line, FEISHU_MEMORY_MAX_ITEM_CHARS))
      .filter(Boolean)
  );
  for (const line of lines) {
    upsertMemoryItem(nextStore.roleMemoryItems, {
      scope: FEISHU_MEMORY_SCOPE_ROLE,
      memoryType: 'role_memory',
      content: line,
      summary: line,
      source: 'config_role_memory',
      importance: 90,
      confidence: 95,
    }, FEISHU_MEMORY_STORE_MAX_ROLE_FACTS);
  }
  nextStore.roleMemoryItems.sort(compareMemoryItems);
  return nextStore;
}

function readBotMemoryStore(accountName, roleMemoryText = '') {
  const filePath = botMemoryStorePath(accountName);
  const loaded = readJsonIfExists(filePath) || createEmptyBotMemoryStore(accountName);
  const store = syncRoleMemoryTextIntoStore(normalizeBotMemoryStore(accountName, loaded), roleMemoryText);
  return { filePath, store };
}

function writeBotMemoryStore(accountName, store) {
  const filePath = botMemoryStorePath(accountName);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const normalized = normalizeBotMemoryStore(accountName, store);
  fs.writeFileSync(filePath, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
  return filePath;
}

const botMemoryWriteQueues = new Map();

function queueBotMemoryWrite(accountName, task) {
  const key = String(accountName || 'default').trim() || 'default';
  const previous = botMemoryWriteQueues.get(key) || Promise.resolve();
  const next = previous
    .catch(() => {})
    .then(task);
  const tracked = next.finally(() => {
    if (botMemoryWriteQueues.get(key) === tracked) {
      botMemoryWriteQueues.delete(key);
    }
  });
  botMemoryWriteQueues.set(key, tracked);
  return tracked;
}

function updateBotMemoryStore(accountName, roleMemoryText, updater) {
  return queueBotMemoryWrite(accountName, async () => {
    const loaded = readBotMemoryStore(accountName, roleMemoryText);
    const currentStore = loaded.store;
    const nextStore = typeof updater === 'function'
      ? await Promise.resolve(updater(currentStore))
      : currentStore;
    const normalized = syncRoleMemoryTextIntoStore(
      normalizeBotMemoryStore(accountName, nextStore || currentStore),
      roleMemoryText
    );
    normalized.updatedAt = Date.now();
    writeBotMemoryStore(accountName, normalized);
    return normalized;
  });
}

function buildRecentSummaryText(recentTurns = []) {
  const turns = Array.isArray(recentTurns) ? recentTurns.filter(Boolean).slice(-FEISHU_MEMORY_MAX_RECENT_TURNS) : [];
  if (turns.length === 0) return '';
  return turns
    .map((turn) => `${turn.role === 'assistant' ? '助手' : '用户'}：${clampMemoryText(turn.text, FEISHU_MEMORY_MAX_RECENT_TURN_CHARS)}`)
    .filter(Boolean)
    .join('\n');
}

function buildLiveToolFactsText(liveToolFacts = []) {
  const facts = Array.isArray(liveToolFacts) ? liveToolFacts.filter(Boolean).slice(-FEISHU_MEMORY_MAX_LIVE_TOOL_FACTS) : [];
  if (facts.length === 0) return '';
  return facts
    .map((fact) => clampMemoryText(fact.text, FEISHU_MEMORY_MAX_LIVE_TOOL_FACT_CHARS))
    .filter(Boolean)
    .join('\n');
}

function extractProfileFactCandidates(rawText = '') {
  const lines = String(rawText || '')
    .replace(/\r/g, '\n')
    .split('\n')
    .map((line) => clampMemoryText(line, FEISHU_MEMORY_MAX_ITEM_CHARS))
    .filter(Boolean);
  const facts = [];
  for (const line of lines) {
    if (line.length < 6) continue;
    if (/^\/(?:thread|threads|reset)\b/i.test(line)) continue;
    if (/^(?:图片|文件|附件)已发送，请查收/.test(line)) continue;
    if (
      /(喜欢|不喜欢|偏好|习惯|不要|记得|默认|以后|下次|直接|通过飞书|存储到本地|独立记忆|跨线程|共享记忆|附件|文件发我|图片发我|简洁|详细)/.test(line)
      || /^(?:我|用户).*(?:住在|在.*工作|在.*上班|来自|叫|习惯|喜欢|不喜欢|偏好)/.test(line)
    ) {
      facts.push(line);
    }
  }
  return uniqueStrings(facts).slice(0, 6);
}

function buildHistoryTurnSummary(userText = '', assistantText = '') {
  const user = clampMemoryText(userText, 110);
  const assistant = clampMemoryText(assistantText, 110);
  if (!user) return '';
  if (!assistant) return `用户：${user}`;
  const normalizedAssistant = /^(?:图片|文件|附件)已发送，请查收/.test(assistant)
    ? '已发送所需附件'
    : assistant;
  return compactText(`用户：${user}；助手：${normalizedAssistant}`, FEISHU_MEMORY_MAX_ITEM_CHARS);
}

function scoreMemoryItemForQuery(item, queryText = '') {
  const memory = normalizeMemoryItem(item, item?.scope);
  if (!memory) return 0;
  const haystack = `${memory.summary}\n${memory.content}\n${memory.keywords}`.toLowerCase();
  const normalizedQuery = cleanMemoryText(queryText).toLowerCase();
  const queryKeywords = uniqueStrings((normalizedQuery.match(FEISHU_MEMORY_KEYWORD_PATTERN) || []).map((part) => String(part || '').toLowerCase()));
  let score = (memory.importance || 0) + Math.min(18, memory.hitCount || 0);
  const ageMs = Math.max(0, Date.now() - (memory.updatedAt || 0));
  if (ageMs < 7 * 24 * 60 * 60 * 1000) score += 8;
  if (ageMs < 24 * 60 * 60 * 1000) score += 6;

  if (!normalizedQuery) return score;
  if (haystack.includes(normalizedQuery)) score += 40;
  for (const keyword of queryKeywords) {
    if (!keyword) continue;
    if (haystack.includes(keyword)) score += keyword.length >= 4 ? 18 : 10;
  }
  if (/(记得|上次|之前|前面|曾经|偏好|喜欢|不喜欢|习惯)/.test(normalizedQuery)) {
    score += 8;
  }
  return score;
}

function selectMemoryItems(items = [], queryText = '', limit = FEISHU_MEMORY_MAX_RENDERED_ITEMS, options = {}) {
  const { requireQuery = false, minScore = 0 } = options || {};
  const normalizedQuery = cleanMemoryText(queryText);
  if (requireQuery && !normalizedQuery) return [];
  const scored = (Array.isArray(items) ? items : [])
    .map((item) => ({ item, score: scoreMemoryItemForQuery(item, normalizedQuery) }))
    .filter((entry) => entry.score >= minScore)
    .sort((a, b) => {
      if (a.score !== b.score) return b.score - a.score;
      return compareMemoryItems(a.item, b.item);
    });
  return scored.slice(0, limit).map((entry) => entry.item);
}

function renderMemoryItems(items = [], limit = FEISHU_MEMORY_MAX_RENDERED_ITEMS, maxChars = FEISHU_MEMORY_MAX_SECTION_CHARS) {
  const lines = [];
  for (const item of (Array.isArray(items) ? items : []).slice(0, limit)) {
    const line = clampMemoryText(item?.summary || item?.content, FEISHU_MEMORY_MAX_ITEM_CHARS);
    if (!line) continue;
    const nextText = [...lines, line].join('\n');
    if (nextText.length > maxChars) break;
    lines.push(line);
  }
  return lines.join('\n');
}

function renderMemoryBundle(bundle) {
  const sections = [
    { name: FEISHU_MEMORY_SCOPE_PROFILE, content: bundle?.profileFacts || '' },
    { name: FEISHU_MEMORY_SCOPE_ROLE, content: bundle?.roleMemory || '' },
    { name: FEISHU_MEMORY_SECTION_RECENT_SUMMARY, content: bundle?.recentSummary || '' },
    { name: FEISHU_MEMORY_SECTION_ACTIVATED_HISTORY, content: bundle?.activatedHistory || '' },
    { name: FEISHU_MEMORY_SECTION_LIVE_TOOL_FACTS, content: bundle?.liveToolFacts || '' },
  ].filter((section) => String(section.content || '').trim());

  if (sections.length === 0) return '';
  const body = sections
    .map((section) => `[${section.name}]\n${section.content}\n[/${section.name}]`)
    .join('\n');
  return `${FEISHU_MEMORY_HEADER}\n${body}\n${FEISHU_MEMORY_FOOTER}`.trim();
}

function buildBotMemoryBundle(store, queryText = '') {
  const memoryStore = normalizeBotMemoryStore(store?.accountName || 'default', store);
  return {
    profileFacts: renderMemoryItems(
      selectMemoryItems(memoryStore.profileFacts, queryText, 6, { minScore: 0 }),
      6,
      FEISHU_MEMORY_MAX_SECTION_CHARS
    ),
    roleMemory: renderMemoryItems(
      selectMemoryItems(memoryStore.roleMemoryItems, queryText, 4, { minScore: 0 }),
      4,
      FEISHU_MEMORY_MAX_SECTION_CHARS
    ),
    recentSummary: compactText(buildRecentSummaryText(memoryStore.recentTurns), FEISHU_MEMORY_MAX_SECTION_CHARS),
    activatedHistory: renderMemoryItems(
      selectMemoryItems(memoryStore.historyItems, queryText, 6, { requireQuery: true, minScore: 78 }),
      6,
      FEISHU_MEMORY_MAX_SECTION_CHARS
    ),
    liveToolFacts: compactText(buildLiveToolFactsText(memoryStore.liveToolFacts), FEISHU_MEMORY_MAX_SECTION_CHARS),
  };
}

function buildBotMemoryBundleText(store, queryText = '') {
  return renderMemoryBundle(buildBotMemoryBundle(store, queryText));
}

function deriveMemoryLiveToolFacts({ sent = [], failed = [] } = {}) {
  const facts = [];
  const sentImages = (Array.isArray(sent) ? sent : []).filter((item) => item.type === 'image');
  const sentFiles = (Array.isArray(sent) ? sent : []).filter((item) => item.type === 'file' || item.type === 'media');
  if (sentImages.length > 0) {
    facts.push(`已发送图片：${sentImages.map((item) => item.fileName).join('，')}`);
  }
  if (sentFiles.length > 0) {
    facts.push(`已发送文件：${sentFiles.map((item) => item.fileName).join('，')}`);
  }
  if ((Array.isArray(failed) ? failed : []).length > 0) {
    facts.push(`附件发送失败：${failed.map((item) => item.fileName).join('，')}`);
  }
  return facts.map((fact) => clampMemoryText(fact, FEISHU_MEMORY_MAX_LIVE_TOOL_FACT_CHARS)).filter(Boolean);
}

function recordConversationIntoBotMemoryStore(store, {
  userText = '',
  assistantText = '',
  liveToolFacts = [],
  threadId = '',
} = {}) {
  const nextStore = normalizeBotMemoryStore(store?.accountName || 'default', store);

  if (userText) {
    pushRecentTurn(nextStore.recentTurns, {
      role: 'user',
      text: userText,
      threadId,
      at: Date.now(),
    });
  }
  if (assistantText) {
    pushRecentTurn(nextStore.recentTurns, {
      role: 'assistant',
      text: assistantText,
      threadId,
      at: Date.now(),
    });
  }

  const historySummary = buildHistoryTurnSummary(userText, assistantText);
  if (historySummary) {
    upsertMemoryItem(nextStore.historyItems, {
      scope: FEISHU_MEMORY_SCOPE_HISTORY,
      memoryType: 'history_fact',
      content: historySummary,
      summary: historySummary,
      source: 'conversation_turn',
      importance: 62,
      confidence: 82,
    }, FEISHU_MEMORY_STORE_MAX_HISTORY_ITEMS);
  }

  const profileFacts = extractProfileFactCandidates(userText);
  for (const fact of profileFacts) {
    const importance = /(通过飞书|存储到本地|默认|记得|不要|直接|独立记忆|跨线程|共享记忆)/.test(fact) ? 95 : 84;
    upsertMemoryItem(nextStore.profileFacts, {
      scope: FEISHU_MEMORY_SCOPE_PROFILE,
      memoryType: 'profile_fact',
      content: fact,
      summary: fact,
      source: 'conversation_profile',
      importance,
      confidence: 90,
    }, FEISHU_MEMORY_STORE_MAX_PROFILE_FACTS);
  }

  for (const fact of Array.isArray(liveToolFacts) ? liveToolFacts : []) {
    pushLiveToolFact(nextStore.liveToolFacts, { text: fact }, FEISHU_MEMORY_STORE_MAX_LIVE_TOOL_FACTS);
  }

  nextStore.updatedAt = Date.now();
  return nextStore;
}

function getHeaderValue(headers, targetKey) {
  const wanted = String(targetKey || '').trim().toLowerCase();
  if (!headers || !wanted) return '';
  if (typeof headers.get === 'function') {
    return String(headers.get(targetKey) || headers.get(wanted) || '').trim();
  }
  if (typeof headers === 'object') {
    for (const [key, value] of Object.entries(headers)) {
      if (String(key).trim().toLowerCase() !== wanted) continue;
      if (Array.isArray(value)) return String(value[0] || '').trim();
      return String(value || '').trim();
    }
  }
  return '';
}

function parseDispositionFileName(disposition = '') {
  const raw = String(disposition || '').trim();
  if (!raw) return '';
  const utf8Match = raw.match(/filename\*=UTF-8''([^;]+)/i);
  if (utf8Match && utf8Match[1]) {
    try {
      return sanitizeLocalFileName(decodeURIComponent(utf8Match[1]));
    } catch (_) {
      return sanitizeLocalFileName(utf8Match[1]);
    }
  }
  const plainMatch = raw.match(/filename="?([^";]+)"?/i);
  if (plainMatch && plainMatch[1]) {
    return sanitizeLocalFileName(plainMatch[1]);
  }
  return '';
}

function inferExtensionFromHeaders(headers, fallback = '.bin') {
  const contentType = getHeaderValue(headers, 'content-type').split(';')[0].trim().toLowerCase();
  if (contentType && CONTENT_TYPE_EXTENSION_MAP.has(contentType)) {
    return CONTENT_TYPE_EXTENSION_MAP.get(contentType);
  }
  const dispositionName = parseDispositionFileName(getHeaderValue(headers, 'content-disposition'));
  const ext = path.extname(dispositionName || '').trim().toLowerCase();
  return ext || fallback;
}

function formatDurationFromMs(durationMs) {
  const ms = Math.max(0, Number(durationMs) || 0);
  if (ms <= 0) return '';
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds} 秒`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (seconds === 0) return `${minutes} 分钟`;
  return `${minutes} 分 ${seconds} 秒`;
}

async function convertAudioToWav(ffmpegBin, inputPath, outputPath) {
  ensure(ffmpegBin, 'ffmpeg not configured');
  return new Promise((resolve, reject) => {
    const args = [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-i',
      inputPath,
      '-vn',
      '-ac',
      '1',
      '-ar',
      '16000',
      outputPath,
    ];
    const child = spawn(ffmpegBin, args, {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk || '');
    });
    child.on('error', (err) => {
      reject(new Error(`ffmpeg failed to start: ${err.message}`));
    });
    child.on('close', (code) => {
      if (code === 0 && fs.existsSync(outputPath)) {
        resolve(outputPath);
        return;
      }
      reject(new Error(`ffmpeg exited with code ${code || 0}${stderr.trim() ? `: ${stderr.trim()}` : ''}`));
    });
  });
}

async function ensureAudioReadyForTranscription(filePath, speech) {
  const rawPath = path.resolve(String(filePath || ''));
  ensure(fs.existsSync(rawPath), `audio file not found: ${rawPath}`);
  const ext = path.extname(rawPath).trim().toLowerCase();
  const knownMime = TRANSCRIPTION_MIME_BY_EXTENSION.get(ext);
  if (knownMime) {
    return { filePath: rawPath, mimeType: knownMime, converted: false };
  }

  ensure(
    speech.ffmpegBin,
    `语音消息当前格式 ${ext || '(unknown)'} 需要先转成 wav，但没有可用的 ffmpeg`
  );
  const outputPath = path.join(
    path.dirname(rawPath),
    `${path.basename(rawPath, path.extname(rawPath)) || 'voice'}-transcribe.wav`
  );
  await convertAudioToWav(speech.ffmpegBin, rawPath, outputPath);
  return {
    filePath: outputPath,
    mimeType: 'audio/wav',
    converted: true,
  };
}

async function requestOpenAITranscription({ speech, model, filePath, mimeType }) {
  ensure(speech.apiKey, 'speech api key is missing');
  const audioBuffer = fs.readFileSync(filePath);
  const form = new FormData();
  form.set('model', model);
  form.set('response_format', 'json');
  if (speech.language) {
    form.set('language', speech.language);
  }
  form.set('file', new Blob([audioBuffer], { type: mimeType || 'application/octet-stream' }), path.basename(filePath));

  const response = await fetch(`${speech.baseURL}/audio/transcriptions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${speech.apiKey}`,
    },
    body: form,
  });
  const raw = await response.text();
  let parsed = null;
  try {
    parsed = raw ? JSON.parse(raw) : null;
  } catch (_) {
    parsed = null;
  }

  if (!response.ok) {
    const detail = String(
      parsed?.error?.message
      || parsed?.message
      || raw
      || `HTTP ${response.status}`
    ).trim();
    const err = new Error(`audio transcription failed (${response.status}): ${detail}`);
    err.status = response.status;
    err.code = parsed?.error?.code || '';
    throw err;
  }

  const text = String(parsed?.text || raw || '').trim();
  ensure(text, 'audio transcription returned empty text');
  return text;
}

function shouldRetryTranscriptionWithFallbackModel(err) {
  const status = Number(err?.status || 0);
  const message = String(err?.message || '').toLowerCase();
  if (status === 404) return true;
  return /model/.test(message) && (/not found/.test(message) || /does not exist/.test(message) || /unsupported/.test(message));
}

async function transcribeAudioMessage(filePath, speech) {
  ensure(speech.enabled, '当前账号未启用语音转写');
  ensure(speech.apiKey, '缺少语音转写 API key，请配置 speech.api_key 或 codex.api_key');
  const prepared = await ensureAudioReadyForTranscription(filePath, speech);
  const modelCandidates = uniqueStrings([speech.model, 'whisper-1']);
  let lastError = null;

  for (const model of modelCandidates) {
    try {
      const text = await requestOpenAITranscription({
        speech,
        model,
        filePath: prepared.filePath,
        mimeType: prepared.mimeType,
      });
      return {
        text,
        model,
        converted: prepared.converted,
        preparedFilePath: prepared.filePath,
      };
    } catch (err) {
      lastError = err;
      if (model === 'whisper-1' || !shouldRetryTranscriptionWithFallbackModel(err)) {
        break;
      }
    }
  }

  throw lastError || new Error('audio transcription failed');
}

function formatProgressTimestamp(value = Date.now()) {
  return new Date(value).toLocaleString('zh-CN', { hour12: false });
}

function splitTextChunks(raw, maxLength = 900) {
  const text = String(raw || '').replace(/\r/g, '').trim();
  if (!text) return [];
  const max = Math.max(80, Number(maxLength) || 900);
  const chunks = [];
  for (const paragraph of text.split('\n')) {
    const normalized = paragraph.trim();
    if (!normalized) continue;
    let cursor = 0;
    while (cursor < normalized.length) {
      let end = Math.min(cursor + max, normalized.length);
      if (end < normalized.length) {
        const cut = normalized.lastIndexOf(' ', end);
        if (cut > cursor + Math.floor(max * 0.6)) end = cut;
      }
      if (end <= cursor) end = Math.min(cursor + max, normalized.length);
      chunks.push(normalized.slice(cursor, end).trim());
      cursor = end;
    }
  }
  return chunks;
}

function buildDocTextElement(content, style = null) {
  const payload = { content: String(content || '') };
  if (style && typeof style === 'object' && Object.keys(style).length > 0) {
    payload.text_element_style = style;
  }
  return { text_run: payload };
}

function buildDocTextElements(text, style = null) {
  return [buildDocTextElement(text, style)];
}

function buildDocTextBlockFromElements(elements, style = null) {
  return {
    block_type: FEISHU_DOCX_TEXT_BLOCK_TYPE,
    text: {
      ...(style && Object.keys(style).length > 0 ? { style } : {}),
      elements: Array.isArray(elements) ? elements.filter(Boolean) : [],
    },
  };
}

function buildDocHeadingBlock(level, text) {
  const content = normalizeProgressSnippet(text, 240);
  if (!content) return null;
  if (level === 2) {
    return {
      block_type: FEISHU_DOCX_HEADING2_BLOCK_TYPE,
      heading2: {
        elements: buildDocTextElements(content),
      },
    };
  }
  return {
    block_type: FEISHU_DOCX_HEADING3_BLOCK_TYPE,
    heading3: {
      elements: buildDocTextElements(content),
    },
  };
}

function buildDocTextBlocks(text, maxLength = 900) {
  return splitTextChunks(text, maxLength).map((chunk) => ({
    block_type: FEISHU_DOCX_TEXT_BLOCK_TYPE,
    text: {
      elements: buildDocTextElements(chunk),
    },
  }));
}

function buildDocKeyValueBlock(label, value, { inlineCode = false } = {}) {
  const safeLabel = normalizeProgressSnippet(label, 80);
  const safeValue = normalizeProgressDetailText(value, 1200);
  if (!safeLabel || !safeValue) return null;
  return buildDocTextBlockFromElements([
    buildDocTextElement(`${safeLabel}：`, { bold: true }),
    buildDocTextElement(safeValue, inlineCode ? { inline_code: true } : null),
  ]);
}

function splitRawTextChunks(raw, maxLength = 900) {
  const text = String(raw || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  if (!text) return [];
  const max = Math.max(120, Number(maxLength) || 900);
  const chunks = [];
  let cursor = 0;

  while (cursor < text.length) {
    let end = Math.min(cursor + max, text.length);
    if (end < text.length) {
      const newlineCut = text.lastIndexOf('\n', end);
      if (newlineCut >= cursor + Math.floor(max * 0.4)) {
        end = newlineCut + 1;
      }
    }
    if (end <= cursor) end = Math.min(cursor + max, text.length);
    chunks.push(text.slice(cursor, end));
    cursor = end;
  }

  return chunks.filter((chunk) => chunk.length > 0);
}

function buildDocRawTextBlocks(text, maxLength = 900) {
  return splitRawTextChunks(text, maxLength).map((chunk) => ({
    block_type: FEISHU_DOCX_TEXT_BLOCK_TYPE,
    text: {
      elements: buildDocTextElements(chunk),
    },
  }));
}

function buildDocCodeBlocks(text, maxLength = 900) {
  return splitRawTextChunks(text, maxLength).map((chunk) => ({
    block_type: FEISHU_DOCX_CODE_BLOCK_TYPE,
    code: {
      style: {
        wrap: true,
      },
      elements: buildDocTextElements(chunk),
    },
  }));
}

function makeDocProgressLineEntry(text, at = Date.now()) {
  const normalized = normalizeProgressSnippet(text, 500);
  if (!normalized) return null;
  return { kind: 'line', at, text: normalized };
}

function makeDocProgressDetailEntry(title, body, at = Date.now()) {
  const normalizedTitle = normalizeProgressSnippet(title, 200) || '进度事件';
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    const meta = Array.isArray(body.meta)
      ? body.meta
        .map((item) => {
          const label = normalizeProgressSnippet(item?.label, 80);
          const value = normalizeProgressDetailText(item?.value, 1200);
          if (!label || !value) return null;
          return {
            label,
            value,
            inlineCode: Boolean(item?.inlineCode),
          };
        })
        .filter(Boolean)
      : [];
    const sections = Array.isArray(body.sections)
      ? body.sections
        .map((item) => {
          const label = normalizeProgressSnippet(item?.label, 120);
          const content = normalizeProgressDetailText(item?.content, 16000);
          if (!content) return null;
          return {
            label,
            content,
            format: item?.format === 'code' ? 'code' : 'text',
          };
        })
        .filter(Boolean)
      : [];
    if (meta.length === 0 && sections.length === 0) return makeDocProgressLineEntry(normalizedTitle, at);
    return {
      kind: 'detail',
      at,
      title: normalizedTitle,
      meta,
      sections,
    };
  }
  const normalizedBody = normalizeProgressDetailText(body, 16000);
  if (!normalizedBody) return makeDocProgressLineEntry(normalizedTitle, at);
  return {
    kind: 'detail',
    at,
    title: normalizedTitle,
    meta: [],
    sections: [
      { label: '', content: normalizedBody, format: 'text' },
    ],
  };
}

function buildDocProgressEntryBlocks(entry) {
  if (!entry) return [];
  const timestamp = formatProgressTimestamp(entry.at || Date.now());
  if (entry.kind === 'detail') {
    const lines = [];
    const title = normalizeProgressSnippet(entry.title, 200) || '进度事件';
    lines.push(`[${timestamp}] ${title}`);

    for (const item of entry.meta || []) {
      const label = normalizeProgressSnippet(item?.label, 80);
      const value = normalizeProgressDetailText(item?.value, 1200);
      if (!label || !value) continue;
      lines.push(`${label}：${value}`);
    }

    for (const section of entry.sections || []) {
      const label = normalizeProgressSnippet(section?.label, 120);
      const content = normalizeProgressDetailText(section?.content, 16000);
      if (!content) continue;
      if (label) lines.push(`${label}：`);
      lines.push(content);
    }

    const body = normalizeProgressDetailText(entry.body, 16000);
    if (body) lines.push(body);
    return buildDocRawTextBlocks(lines.join('\n'), 1200);
  }

  const text = normalizeProgressSnippet(entry.text, 500);
  if (!text) return [];
  return buildDocRawTextBlocks(`[${timestamp}] ${text}`, 1200);
}

function normalizeCommandText(text) {
  let raw = String(text || '');
  if (!raw) return '';
  raw = raw.replace(/\u00a0/g, ' ');
  raw = raw.replace(/\u200b/g, '');
  raw = raw.trim();
  if (!raw) return '';
  raw = raw.replace(/^／+/, '/');
  raw = raw.replace(/[ \t]+/g, ' ');
  return raw;
}

function isResetCommand(text) {
  const x = normalizeCommandText(text).toLowerCase();
  return x === '/reset' || x === '清空上下文' || x === '重置上下文';
}

function parseThreadCommand(text) {
  const raw = normalizeCommandText(text);
  if (!raw) return null;

  if (/^\/threads$/i.test(raw)) return { type: 'list' };
  if (!/^\/thread(?:\s|$)/i.test(raw)) return null;

  if (/^\/thread(?:\s+help)?$/i.test(raw)) return { type: 'help' };
  if (/^\/thread\s+list$/i.test(raw)) return { type: 'list' };
  if (/^\/thread\s+current$/i.test(raw)) return { type: 'current' };

  const newMatch = raw.match(/^\/thread\s+new(?:\s+(.+))?$/i);
  if (newMatch) {
    return {
      type: 'new',
      name: String(newMatch[1] || '').trim(),
    };
  }

  const switchMatch = raw.match(/^\/thread\s+switch\s+(.+)$/i);
  if (switchMatch) {
    return {
      type: 'switch',
      target: String(switchMatch[1] || '').trim(),
    };
  }

  return { type: 'help' };
}

function parseCrossChatCommand(text) {
  const raw = normalizeCommandText(text);
  if (!raw) return null;

  if (!/^(?:\/xchat|\/跨会话|\/跨线程)(?:\s|$)/i.test(raw)) return null;
  if (/^(?:\/xchat|\/跨会话|\/跨线程)(?:\s+help)?$/i.test(raw)) return { type: 'help' };
  if (/^(?:\/xchat|\/跨会话|\/跨线程)\s+(?:list|列表)$/i.test(raw)) return { type: 'list' };

  const showMatch = raw.match(/^(?:\/xchat|\/跨会话|\/跨线程)\s+(?:show|view|查看)\s+(.+)$/i);
  if (showMatch) {
    return {
      type: 'show',
      target: String(showMatch[1] || '').trim(),
    };
  }

  return { type: 'help' };
}

function parseThingsCommand(text) {
  const raw = normalizeCommandText(text);
  if (!raw) return null;

  if (/^\/things$/i.test(raw)) {
    return { type: 'list', raw };
  }

  const createMatch = raw.match(/^\/things\s+new(?:\s+(.+))?$/i);
  if (createMatch) {
    const requirement = compactText(String(createMatch[1] || ''), 2000).trim();
    if (requirement) {
      return { type: 'create', raw, requirement };
    }
    return { type: 'ignore', raw, reason: 'missing_requirement' };
  }

  if (raw.includes('/things')) {
    return { type: 'ignore', raw, reason: 'non_command_match' };
  }

  return null;
}

function buildThingsCommandHint(command) {
  if (!command) return '';

  const lines = [
    '/things 最高优先级命令规则：',
    '1. 只有用户最新消息严格等于 /things，才表示显示所有事项列表。',
    '2. 只有用户最新消息以 /things new 开头，且 new 后面带了明确创建要求，才表示创建新事情。',
    '3. 其他任何消息，即使包含 /things 或 /things new，也都绝对不要当成事项命令，必须按普通消息继续处理。',
  ];

  if (command.type === 'list') {
    lines.push('当前判定：这是单独的 /things 命令，请按“显示所有事项列表”处理。');
  } else if (command.type === 'create') {
    lines.push(`当前判定：这是有效的 /things new 命令，请按“创建新事情”处理。创建要求：${command.requirement}`);
  } else {
    lines.push('当前判定：这条消息不符合 /things 命令格式，不要显示事项列表，也不要创建新事情。');
  }

  return lines.join('\n');
}

function buildThingsCommandGuardedUserText(userText, command) {
  const raw = compactText(String(userText || ''), 4000).trim() || '(空)';
  if (!command) return raw;

  if (command.type === 'ignore') {
    return [
      '系统补充说明：这条消息不是 /things 命令。',
      '绝对不要显示事项列表，绝对不要创建新事情，绝对不要把消息里的 /things 或 /things new 当成命令执行。',
      '如果用户是在讨论 /things 规则、引用命令字符串，或顺带提到它，就按普通自然语言需求处理。',
      '原始用户消息：',
      raw,
    ].join('\n');
  }

  if (command.type === 'list') {
    return [
      '系统补充说明：这条消息就是单独的 /things 命令。',
      '请按“显示所有事项列表”处理，不要把它理解成讨论命令规则。',
      '原始用户消息：',
      raw,
    ].join('\n');
  }

  if (command.type === 'create') {
    return [
      '系统补充说明：这条消息是有效的 /things new 命令。',
      '请按“创建新事情”处理，创建要求就是 new 后面的正文。',
      '原始用户消息：',
      raw,
    ].join('\n');
  }

  return raw;
}

function makeThread(threadId, name = '') {
  const threadName = String(name || '').trim() || `线程 ${threadId}`;
  return {
    id: threadId,
    name: threadName,
    codexThreadId: '',
    history: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

function hasThreadActivity(thread = null) {
  return Boolean(
    thread
    && (
      (Array.isArray(thread.history) && thread.history.length > 0)
      || String(thread.codexThreadId || '').trim()
    )
  );
}

function touchChatState(state, {
  chatID = '',
  chatType = '',
  actorKey = '',
  now = Date.now(),
} = {}) {
  if (!state || typeof state !== 'object') return state;
  if (chatID) state.chatID = String(chatID || '').trim();
  if (chatType) state.chatType = String(chatType || '').trim().toLowerCase();
  if (actorKey) state.actorKey = String(actorKey || '').trim();
  const normalizedNow = Number(now);
  if (Number.isFinite(normalizedNow) && normalizedNow > 0) {
    state.lastMessageAt = Math.max(Number(state.lastMessageAt || 0), normalizedNow);
    state.updatedAt = Math.max(Number(state.updatedAt || 0), normalizedNow);
  }
  return state;
}

function ensureChatState(chatStates, stateKey, meta = {}) {
  const cached = chatStates.get(stateKey);
  if (cached) {
    touchChatState(cached, meta);
    return cached;
  }

  const firstThread = makeThread('t1', '主线程');
  const state = {
    threads: new Map([[firstThread.id, firstThread]]),
    order: [firstThread.id],
    currentThreadId: firstThread.id,
    nextThreadSeq: 2,
    chatID: '',
    chatType: '',
    actorKey: '',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    lastMessageAt: 0,
  };
  touchChatState(state, meta);
  chatStates.set(stateKey, state);
  return state;
}

function getThreadTurnCount(thread) {
  if (!thread || !Array.isArray(thread.history)) return 0;
  return Math.ceil(thread.history.length / 2);
}

function getCurrentThread(state) {
  if (!state || !state.currentThreadId) return null;
  return state.threads.get(state.currentThreadId) || null;
}

function getMostRelevantThread(state) {
  if (!state || !(state.threads instanceof Map)) return null;
  const currentThread = getCurrentThread(state);
  if (hasThreadActivity(currentThread)) return currentThread;

  let best = null;
  for (const threadId of state.order || []) {
    const thread = state.threads.get(threadId);
    if (!hasThreadActivity(thread)) continue;
    if (!best || Number(thread.updatedAt || 0) > Number(best.updatedAt || 0)) {
      best = thread;
    }
  }
  return best;
}

function resolveThreadIdByTarget(state, target) {
  const raw = String(target || '').trim();
  if (!raw) return '';

  if (state.threads.has(raw)) return raw;
  if (/^\d+$/.test(raw)) {
    const mapped = `t${raw}`;
    if (state.threads.has(mapped)) return mapped;
  }

  const lower = raw.toLowerCase();
  const exactName = [];
  for (const threadId of state.order) {
    const t = state.threads.get(threadId);
    if (!t) continue;
    if (String(t.name || '').toLowerCase() === lower) exactName.push(threadId);
  }
  if (exactName.length === 1) return exactName[0];
  if (exactName.length > 1) return '__ambiguous__';

  const fuzzyName = [];
  for (const threadId of state.order) {
    const t = state.threads.get(threadId);
    if (!t) continue;
    if (String(t.name || '').toLowerCase().includes(lower)) fuzzyName.push(threadId);
  }
  if (fuzzyName.length === 1) return fuzzyName[0];
  if (fuzzyName.length > 1) return '__ambiguous__';

  return '';
}

function formatThreadHelp() {
  return [
    '线程命令：',
    '/threads',
    '/thread list',
    '/thread current',
    '/thread new [名称]',
    '/thread switch <线程ID或名称>',
    '/reset（清空当前线程上下文）',
  ].join('\n');
}

function formatThreadList(state) {
  const lines = ['线程列表：'];
  for (const threadId of state.order) {
    const t = state.threads.get(threadId);
    if (!t) continue;
    const marker = threadId === state.currentThreadId ? ' (当前)' : '';
    lines.push(`${threadId}${marker} · ${t.name} · ${getThreadTurnCount(t)} 轮`);
  }
  return lines.join('\n');
}

function handleThreadCommand(state, command) {
  if (!command) return { handled: false, reply: '' };

  if (command.type === 'help') {
    return { handled: true, reply: formatThreadHelp() };
  }

  if (command.type === 'list') {
    return { handled: true, reply: formatThreadList(state) };
  }

  if (command.type === 'current') {
    const current = getCurrentThread(state);
    if (!current) return { handled: true, reply: '当前线程不存在，请新建线程。' };
    return {
      handled: true,
      reply: `当前线程：${current.id} · ${current.name} · ${getThreadTurnCount(current)} 轮`,
    };
  }

  if (command.type === 'new') {
    const threadId = `t${state.nextThreadSeq}`;
    state.nextThreadSeq += 1;
    const thread = makeThread(threadId, command.name || '');
    state.threads.set(threadId, thread);
    state.order.push(threadId);
    state.currentThreadId = threadId;
    return {
      handled: true,
      reply: `已创建并切换到新线程：${thread.id} · ${thread.name}`,
    };
  }

  if (command.type === 'switch') {
    const resolved = resolveThreadIdByTarget(state, command.target);
    if (resolved === '__ambiguous__') {
      return {
        handled: true,
        reply: '匹配到多个线程，请用更精确的线程 ID 或完整名称。',
      };
    }
    if (!resolved) {
      return {
        handled: true,
        reply: `未找到线程：${command.target}`,
      };
    }
    state.currentThreadId = resolved;
    const current = getCurrentThread(state);
    return {
      handled: true,
      reply: `已切换到线程：${current.id} · ${current.name} · ${getThreadTurnCount(current)} 轮`,
    };
  }

  return { handled: false, reply: '' };
}

function registerActorChatState(actorChatIndex, actorKey = '', stateKey = '') {
  const normalizedActorKey = String(actorKey || '').trim();
  const normalizedStateKey = String(stateKey || '').trim();
  if (!normalizedActorKey || !normalizedStateKey) return;
  let stateKeys = actorChatIndex.get(normalizedActorKey);
  if (!(stateKeys instanceof Set)) {
    stateKeys = new Set();
    actorChatIndex.set(normalizedActorKey, stateKeys);
  }
  stateKeys.add(normalizedStateKey);
}

function shouldIncludeAccessibleThreadContext(userText = '', currentThread = null) {
  const normalized = compactText(String(userText || ''), 4000).trim();
  if (!normalized) return false;
  if (/继续|接着|续上|延续|刚才|上面|上个|那件事|这个事|那个事|群里|私聊|另一边|另一个会话/i.test(normalized)) {
    return true;
  }
  if (!hasThreadActivity(currentThread)) {
    return /^(?:改下|改一下|改成|照着|按刚才|按上面|按群里|照那个|就那个|就这个|接着弄|继续做)/i.test(normalized);
  }
  return false;
}

function summarizeThreadHistoryForAccess(thread = null, maxItems = 4) {
  const historyItems = Array.isArray(thread?.history)
    ? thread.history.slice(Math.max(0, thread.history.length - Math.max(2, Number(maxItems) || 4)))
    : [];
  const lines = [];
  for (const item of historyItems) {
    const role = String(item?.role || '').trim().toLowerCase();
    const text = compactText(String(item?.text || ''), 240).trim();
    if (!text) continue;
    lines.push(`${role === 'assistant' ? '助手' : '用户'}：${text}`);
  }
  return lines.join(' | ');
}

function buildAccessibleThreadContext(chatStates, actorChatIndex, {
  actorKey = '',
  currentStateKey = '',
  currentThread = null,
  userText = '',
  maxThreads = 2,
  maxHistoryItems = 4,
} = {}) {
  const normalizedActorKey = String(actorKey || '').trim();
  const normalizedStateKey = String(currentStateKey || '').trim();
  if (!normalizedActorKey) return { promptText: '', historyText: '', sources: [] };
  if (!shouldIncludeAccessibleThreadContext(userText, currentThread)) {
    return { promptText: '', historyText: '', sources: [] };
  }

  const stateKeys = actorChatIndex.get(normalizedActorKey);
  if (!(stateKeys instanceof Set) || stateKeys.size === 0) {
    return { promptText: '', historyText: '', sources: [] };
  }

  const candidates = [];
  for (const stateKey of stateKeys) {
    if (!stateKey || stateKey === normalizedStateKey) continue;
    const state = chatStates.get(stateKey);
    if (!state) continue;
    const thread = getMostRelevantThread(state);
    if (!hasThreadActivity(thread)) continue;
    candidates.push({
      stateKey,
      state,
      thread,
      updatedAt: Math.max(Number(thread.updatedAt || 0), Number(state.updatedAt || 0), Number(state.lastMessageAt || 0)),
    });
  }
  candidates.sort((left, right) => right.updatedAt - left.updatedAt);
  const selected = candidates.slice(0, Math.max(1, Number(maxThreads) || 2));
  if (selected.length === 0) {
    return { promptText: '', historyText: '', sources: [] };
  }

  const promptLines = ['同一位用户在其他会话中的可访问线程如下，仅供参考，不要把它们当成当前线程本身：'];
  const historyLines = [];
  const sources = [];

  for (const item of selected) {
    const chatLabel = item.state?.chatID || item.stateKey;
    const chatTypeLabel = buildCrossChatTypeLabel(item.state?.chatType || '');
    const threadName = String(item.thread?.name || item.thread?.id || '线程').trim();
    const threadId = String(item.thread?.id || '').trim();
    const historySummary = summarizeThreadHistoryForAccess(item.thread, maxHistoryItems);
    const header = `会话 ${chatLabel}（${chatTypeLabel}） · 线程 ${threadId || '(unknown)'} · ${threadName}`;
    promptLines.push(header);
    if (historySummary) promptLines.push(`最近对话：${historySummary}`);
    historyLines.push(historySummary ? `${header} · ${historySummary}` : header);
    sources.push({
      stateKey: item.stateKey,
      chatID: item.state?.chatID || '',
      chatType: item.state?.chatType || '',
      threadId,
      threadName,
    });
  }

  return {
    promptText: promptLines.join('\n'),
    historyText: compactText(historyLines.join('\n'), 4000),
    sources,
  };
}

function buildCrossChatHelpText() {
  return [
    '跨会话命令：',
    '/xchat list',
    '/xchat show <chat_id|序号|current>',
    '示例：/xchat show 1',
    '示例：/xchat show oc_xxx',
    '示例：/xchat show current',
  ].join('\n');
}

function getFeishuLogPath(accountName = '') {
  const safeAccount = sanitizeLocalFileName(String(accountName || 'default').trim() || 'default', 'default');
  return path.join(FEISHU_LOG_DIR, `${safeAccount}.log`);
}

function listRecentChatTargetsFromLogLines(lines = [], limit = FEISHU_CROSS_CHAT_LIST_LIMIT) {
  const events = [];
  let current = null;

  function commit() {
    if (!current?.chat_id) return;
    events.push({
      chatId: normalizeString(current.chat_id),
      chatType: normalizeString(current.chat_type || 'unknown') || 'unknown',
      scopeKind: normalizeString(current.chat_scope_kind),
      lastMessageType: normalizeString(current.message_type),
      lastMessageId: normalizeString(current.message_id),
    });
  }

  for (const line of Array.isArray(lines) ? lines : []) {
    if (line === 'FEISHU_EVENT') {
      commit();
      current = {};
      continue;
    }
    if (!current) continue;
    const parsed = parseKvLine(line);
    if (!parsed) continue;
    if (['chat_id', 'chat_type', 'chat_scope_kind', 'message_type', 'message_id'].includes(parsed.key)) {
      current[parsed.key] = parsed.value;
    }
  }
  commit();

  const results = [];
  const seen = new Set();
  for (let idx = events.length - 1; idx >= 0; idx -= 1) {
    const event = events[idx];
    if (!event.chatId || seen.has(event.chatId)) continue;
    seen.add(event.chatId);
    results.push(event);
    if (results.length >= Math.max(1, Number(limit) || FEISHU_CROSS_CHAT_LIST_LIMIT)) break;
  }
  return results;
}

function listRecentChatTargetsFromLog(accountName = '', limit = FEISHU_CROSS_CHAT_LIST_LIMIT) {
  const filePath = getFeishuLogPath(accountName);
  return listRecentChatTargetsFromLogLines(
    readLogTail(filePath, FEISHU_CROSS_CHAT_LOG_TAIL_LINES),
    limit
  );
}

function buildCrossChatTypeLabel(chatType = '') {
  const normalized = String(chatType || '').trim().toLowerCase();
  if (normalized === 'p2p') return '私聊';
  if (normalized === 'group') return '群聊';
  if (normalized) return normalized;
  return '未知会话';
}

function buildSenderLabel(identity = {}) {
  const normalized = normalizeSenderIdentity(identity);
  if (normalized.displayName) return normalized.displayName;
  if (normalized.openId) return `open_id=${normalized.openId}`;
  if (normalized.userId) return `user_id=${normalized.userId}`;
  if (normalized.unionId) return `union_id=${normalized.unionId}`;
  if (normalized.senderType === 'bot') return '机器人';
  if (normalized.senderType === 'user') return '用户';
  return '未知发件人';
}

function buildCrossChatMessageTypeLabel(messageType = '') {
  const normalized = String(messageType || '').trim().toLowerCase();
  if (normalized === 'text') return '文本';
  if (normalized === 'post') return '富文本';
  if (normalized === 'file') return '文件';
  if (normalized === 'audio') return '语音';
  if (normalized === 'image') return '图片';
  return normalized || '未知类型';
}

function formatCrossChatTimestamp(rawTimestamp) {
  const numeric = Number(rawTimestamp);
  if (!Number.isFinite(numeric) || numeric <= 0) return '';
  const value = numeric > 1e12 ? numeric : numeric * 1000;
  const date = new Date(value);
  const pad = (part) => String(part).padStart(2, '0');
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function normalizeCrossChatTargetTarget(rawTarget = '') {
  const raw = normalizeCommandText(rawTarget);
  if (!raw) return '';
  const chatIdMatch = raw.match(/(oc_[a-zA-Z0-9]+)/);
  return chatIdMatch ? chatIdMatch[1] : raw;
}

function resolveCrossChatTarget(target, recentTargets = [], currentChatID = '') {
  const normalized = normalizeCrossChatTargetTarget(target);
  const current = normalizeString(currentChatID);
  if (!normalized) return '';
  if (/^(?:current|当前)$/i.test(normalized)) return current;

  const candidates = [];
  const seen = new Set();
  const pushCandidate = (chatId) => {
    const value = normalizeString(chatId);
    if (!value || seen.has(value)) return;
    seen.add(value);
    candidates.push(value);
  };

  pushCandidate(current);
  for (const item of Array.isArray(recentTargets) ? recentTargets : []) {
    pushCandidate(item?.chatId);
  }

  if (/^\d+$/.test(normalized)) {
    const index = Number.parseInt(normalized, 10);
    if (index >= 1 && index <= candidates.length) return candidates[index - 1];
  }
  if (candidates.includes(normalized)) return normalized;

  const suffixMatches = candidates.filter((item) => item.endsWith(normalized));
  if (suffixMatches.length === 1) return suffixMatches[0];
  if (suffixMatches.length > 1) return '__ambiguous__';
  return '';
}

function summarizeCrossChatMessageItem(messageItem = {}) {
  const messageType = String(messageItem?.msg_type || messageItem?.message_type || '').trim().toLowerCase();
  const rawContent = String(messageItem?.body?.content || messageItem?.content || '').trim();
  const preview = compactText(
    summarizeFeishuMessageContent(messageType, rawContent) || `[${buildCrossChatMessageTypeLabel(messageType)}消息]`,
    FEISHU_CROSS_CHAT_PREVIEW_CHARS
  );
  const senderLabel = buildSenderLabel(extractMessageSenderIdentity(messageItem));
  const timestamp = extractMessageItemTimestamp(messageItem);
  const threadId = normalizeString(
    messageItem?.thread_id
      || messageItem?.threadId
      || messageItem?.root_id
      || messageItem?.rootId
      || ''
  );
  return {
    senderLabel,
    preview,
    messageTypeLabel: buildCrossChatMessageTypeLabel(messageType),
    timeLabel: formatCrossChatTimestamp(timestamp),
    threadId,
  };
}

function formatCrossChatListReply(recentTargets = [], currentChatID = '') {
  if (!Array.isArray(recentTargets) || recentTargets.length === 0) {
    return [
      '最近没有发现可查询的会话记录。',
      '当前实现会从本机机器人日志里找最近活跃 chat_id；如果机器人刚重启，或者最近没有经过其他会话，等有新消息后再试。',
    ].join('\n');
  }

  const lines = ['最近会话：'];
  recentTargets.forEach((target, index) => {
    const chatId = normalizeString(target?.chatId);
    const marker = chatId && chatId === normalizeString(currentChatID) ? '（当前）' : '';
    const detailParts = [
      buildCrossChatTypeLabel(target?.chatType),
      normalizeString(target?.scopeKind) ? `scope=${normalizeString(target.scopeKind)}` : '',
      normalizeString(target?.lastMessageType) ? `最后消息=${buildCrossChatMessageTypeLabel(target.lastMessageType)}` : '',
    ].filter(Boolean);
    lines.push(`${index + 1}. ${chatId}${marker}${detailParts.length > 0 ? ` · ${detailParts.join(' · ')}` : ''}`);
  });
  lines.push('查看详情：/xchat show <序号或chat_id>');
  return lines.join('\n');
}

function formatCrossChatShowReply({
  targetChatID = '',
  currentChatID = '',
  recentTargets = [],
  messageItems = [],
} = {}) {
  const lines = [`会话：${targetChatID}${targetChatID === normalizeString(currentChatID) ? '（当前）' : ''}`];
  const targetMeta = (Array.isArray(recentTargets) ? recentTargets : [])
    .find((item) => normalizeString(item?.chatId) === normalizeString(targetChatID));
  if (targetMeta) {
    const detailParts = [
      buildCrossChatTypeLabel(targetMeta.chatType),
      normalizeString(targetMeta.scopeKind) ? `scope=${normalizeString(targetMeta.scopeKind)}` : '',
    ].filter(Boolean);
    if (detailParts.length > 0) {
      lines.push(`类型：${detailParts.join(' · ')}`);
    }
  }

  const items = (Array.isArray(messageItems) ? messageItems : []).filter(Boolean).slice(0, FEISHU_CROSS_CHAT_MESSAGE_LIMIT).reverse();
  if (items.length === 0) {
    lines.push('最近没有取到可读消息。');
    return lines.join('\n');
  }

  lines.push('最近消息：');
  for (const item of items) {
    const summary = summarizeCrossChatMessageItem(item);
    const header = [
      summary.timeLabel,
      summary.senderLabel,
      summary.messageTypeLabel,
      summary.threadId ? `thread=${summary.threadId}` : '',
    ].filter(Boolean).join(' · ');
    if (header) lines.push(header);
    if (summary.preview) lines.push(summary.preview);
  }
  return lines.join('\n');
}

async function handleCrossChatCommand(client, {
  accountName = '',
  currentChatID = '',
  command = null,
} = {}) {
  if (!command) return { handled: false, reply: '', targetChatID: '' };

  const recentTargets = listRecentChatTargetsFromLog(accountName, FEISHU_CROSS_CHAT_LIST_LIMIT);
  if (command.type === 'help') {
    return {
      handled: true,
      reply: buildCrossChatHelpText(),
      targetChatID: '',
    };
  }
  if (command.type === 'list') {
    return {
      handled: true,
      reply: formatCrossChatListReply(recentTargets, currentChatID),
      targetChatID: '',
    };
  }
  if (command.type !== 'show') {
    return { handled: false, reply: '', targetChatID: '' };
  }

  const resolvedChatID = resolveCrossChatTarget(command.target, recentTargets, currentChatID);
  if (resolvedChatID === '__ambiguous__') {
    return {
      handled: true,
      reply: '匹配到多个会话，请直接贴完整 chat_id，或者先用 /xchat list 看序号。',
      targetChatID: '',
    };
  }
  if (!resolvedChatID) {
    return {
      handled: true,
      reply: `未找到会话：${command.target}\n先用 /xchat list 看最近会话。`,
      targetChatID: '',
    };
  }

  try {
    const messageItems = await fetchRecentMessagesFromChat(client, {
      chatID: resolvedChatID,
      limit: FEISHU_CROSS_CHAT_MESSAGE_LIMIT,
    });
    return {
      handled: true,
      reply: formatCrossChatShowReply({
        targetChatID: resolvedChatID,
        currentChatID,
        recentTargets,
        messageItems,
      }),
      targetChatID: resolvedChatID,
    };
  } catch (err) {
    console.error(`cross_chat_fetch=error chat_id=${resolvedChatID} ${describeFeishuApiError(err)}`);
    return {
      handled: true,
      reply: `读取会话 ${resolvedChatID} 失败：${describeFeishuApiError(err)}`,
      targetChatID: resolvedChatID,
    };
  }
}

function buildCodexThreadTitle({ botName = '', localThreadName = '', userText = '' }) {
  const botLabel = compactText(String(botName || '飞书机器人').replace(/\s+/g, ' '), 24);
  const threadLabel = compactText(String(localThreadName || '主线程').replace(/\s+/g, ' '), 18);
  const userLabel = compactText(String(userText || '').replace(/\s+/g, ' '), 42);
  return [botLabel, threadLabel, userLabel].filter(Boolean).join(' | ');
}

function renderPromptHistory(history = []) {
  const items = Array.isArray(history) ? history.slice(-8) : [];
  if (items.length === 0) return '';
  return items
    .map((item) => {
      const role = String(item?.role || '').trim().toLowerCase() === 'assistant' ? '助手' : '用户';
      const text = compactText(String(item?.text || '').trim(), 320);
      if (!text) return '';
      return `${role}：${text}`;
    })
    .filter(Boolean)
    .join('\n');
}

function buildFeishuReplyInstructions() {
  return [
    '回复要求：',
    '1. 直接输出给用户的最终回复正文，不要加空话，不要承诺稍后回复。',
    '2. 如果需要把本机图片发给用户，请单独占行输出 [[FEISHU_SEND_IMAGE:/绝对或相对路径]]。',
    '3. 如果用户明确要文件，请单独占行输出 [[FEISHU_SEND_FILE:/绝对或相对路径]]，不要只给本地链接。',
    '4. 除附件指令外，其他文字都会原样发送给飞书。',
    `5. 发送图片前请确认文件真实存在、格式受支持且不超过 ${formatBytes(FEISHU_IMAGE_UPLOAD_LIMIT)}。`,
    `6. 发送文件前请确认文件真实存在、不是目录且不超过 ${formatBytes(FEISHU_FILE_UPLOAD_LIMIT)}。`,
  ].join('\n');
}

function buildLocalModelReplyInstructions() {
  return [
    '回复要求：',
    '1. 直接输出给用户的最终回复正文，不要加空话，不要承诺稍后回复。',
    '2. 不要暴露思维链，不要输出 <think>、Thinking Process 或类似内容。',
    '3. 不要声称你已经读取了本机文件、执行了命令、查看了图片，除非这些信息已经明确写在用户消息文本里。',
    '4. 如果任务需要本机权限、命令执行、修改代码、调用 Skills、调用 MCP 或访问工作区，请不要自己编造执行结果。',
    '5. 遇到这类任务时，只输出一条委托指令，格式必须是：[[CODEX_DELEGATE: 给 codex 的明确任务说明]]。',
    '6. 如果当前信息不足，请直接说缺什么，并给出最简洁的下一步建议。',
  ].join('\n');
}

const cachedCodexStateDbPaths = new Map();

function resolveCodexStateDbPath(codexHome = '') {
  const resolvedCodexHome = path.resolve(codexHome || process.env.CODEX_HOME || path.join(os.homedir(), '.codex'));
  const cachedPath = cachedCodexStateDbPaths.get(resolvedCodexHome) || '';
  if (cachedPath && fs.existsSync(cachedPath)) {
    return cachedPath;
  }
  let candidates = [];
  try {
    candidates = fs.readdirSync(resolvedCodexHome)
      .filter((name) => /^state_\d+\.sqlite$/.test(name))
      .map((name) => path.join(resolvedCodexHome, name))
      .filter((fullPath) => fs.existsSync(fullPath));
  } catch (_) {
    candidates = [];
  }
  if (candidates.length === 0) return '';
  candidates.sort((a, b) => {
    try {
      return fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs;
    } catch (_) {
      return 0;
    }
  });
  const selectedPath = candidates[0] || '';
  if (selectedPath) cachedCodexStateDbPaths.set(resolvedCodexHome, selectedPath);
  return selectedPath;
}

function quoteSqliteString(value) {
  return `'${String(value || '').replace(/'/g, "''")}'`;
}

function syncCodexThreadTitle(threadId, threadTitle, codexHome = '') {
  const targetThreadId = String(threadId || '').trim();
  const nextTitle = String(threadTitle || '').trim();
  if (!targetThreadId || !nextTitle) return false;

  const dbPath = resolveCodexStateDbPath(codexHome);
  if (!dbPath) return false;

  const sql = [
    'UPDATE threads',
    `SET title = ${quoteSqliteString(nextTitle)},`,
    "    updated_at = CAST(strftime('%s','now') AS INTEGER)",
    `WHERE id = ${quoteSqliteString(targetThreadId)};`,
  ].join(' ');

  const result = spawnSync('sqlite3', [dbPath, sql], {
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    console.error(`codex_thread_title_sync=error thread_id=${targetThreadId} message=${compactText(result.stderr || result.stdout || 'sqlite3 failed', 400)}`);
    return false;
  }
  return true;
}

function readCodexThreadExecutionPolicy(threadId, codexHome = '') {
  const targetThreadId = String(threadId || '').trim();
  if (!targetThreadId) return null;

  const dbPath = resolveCodexStateDbPath(codexHome);
  if (!dbPath) return null;

  const columnsResult = spawnSync('sqlite3', ['-json', dbPath, 'PRAGMA table_info(threads);'], {
    encoding: 'utf8',
  });
  let hasProviderColumn = false;
  if (columnsResult.status === 0) {
    try {
      const columns = JSON.parse(String(columnsResult.stdout || '[]'));
      hasProviderColumn = Array.isArray(columns)
        && columns.some((column) => String(column?.name || '') === 'model_provider_id');
    } catch (_) {
      hasProviderColumn = false;
    }
  }

  const selectedColumns = hasProviderColumn
    ? 'sandbox_policy, approval_mode, model_provider_id'
    : 'sandbox_policy, approval_mode';
  const sql = [
    `SELECT ${selectedColumns}`,
    'FROM threads',
    `WHERE id = ${quoteSqliteString(targetThreadId)}`,
    'LIMIT 1;',
  ].join(' ');
  const result = spawnSync('sqlite3', ['-json', dbPath, sql], {
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    console.error(`codex_thread_policy=error thread_id=${targetThreadId} message=${compactText(result.stderr || result.stdout || 'sqlite3 failed', 400)}`);
    return null;
  }

  let rows = [];
  try {
    rows = JSON.parse(String(result.stdout || '[]'));
  } catch (_) {
    rows = [];
  }
  const row = Array.isArray(rows) ? rows[0] : null;
  if (!row) return null;

  let sandboxType = '';
  try {
    const parsed = typeof row.sandbox_policy === 'string'
      ? JSON.parse(row.sandbox_policy)
      : row.sandbox_policy;
    sandboxType = String(parsed?.type || '').trim();
  } catch (_) {
    sandboxType = '';
  }

  return {
    sandboxType,
    approvalMode: String(row.approval_mode || '').trim(),
    provider: String(row.model_provider_id || '').trim(),
  };
}

function shouldResumeCodexThread(existingPolicy, activeCodex = {}) {
  if (!existingPolicy) {
    return { ok: false, reason: 'missing_policy' };
  }

  const expectedSandboxType = String(activeCodex.sandbox || '').trim();
  const expectedApprovalMode = String(activeCodex.approvalPolicy || '').trim();
  if (expectedSandboxType && existingPolicy.sandboxType && existingPolicy.sandboxType !== expectedSandboxType) {
    return { ok: false, reason: 'sandbox_mismatch' };
  }
  if (expectedApprovalMode && existingPolicy.approvalMode && existingPolicy.approvalMode !== expectedApprovalMode) {
    return { ok: false, reason: 'approval_mismatch' };
  }

  const runtimeProvider = activeCodex.runtimeProvider || deriveCodexRuntimeProvider(activeCodex);
  const expectedProvider = String(runtimeProvider.provider || '').trim().toLowerCase();
  const policyProvider = String(existingPolicy.provider || '').trim().toLowerCase();
  if (expectedProvider && policyProvider && expectedProvider !== policyProvider) {
    return { ok: false, reason: 'provider_mismatch' };
  }

  return { ok: true, reason: '' };
}

function buildCodexPrompt({
  systemPrompt,
  history,
  userText,
  imageCount = 0,
  cwd = '',
  addDirs = [],
  fileWorkspaceDir = '',
  threadTitle = '',
  forceExecution = false,
  memoryBundleText = '',
  thingsCommandHint = '',
}) {
  const lines = [];
  const message = compactText(String(userText || ''), 2400);
  const renderedHistory = renderPromptHistory(history);
  if (forceExecution) {
    lines.push(FORCE_EXECUTE_CODE_TASK_PROMPT);
    lines.push('');
  }
  lines.push(systemPrompt || DEFAULT_CODEX_SYSTEM_PROMPT);
  if (threadTitle) {
    lines.push('');
    lines.push(`当前线程：${threadTitle}`);
  }
  lines.push('');
  lines.push(`当前工作目录：${cwd || process.cwd()}`);
  if (fileWorkspaceDir) {
    lines.push(`机器人文件工作目录：${fileWorkspaceDir}`);
    lines.push('生成文件、整理附件或需要返回本地文件时，优先保存到机器人文件工作目录；发送附件指令请使用绝对路径。');
  }
  if (Array.isArray(addDirs) && addDirs.length > 0) {
    lines.push(`额外可访问目录：${addDirs.join(' | ')}`);
  }
  if (memoryBundleText) {
    lines.push('');
    lines.push('本地记忆（按机器人独立存储，跨线程共享）：');
    lines.push(memoryBundleText);
  }
  if (thingsCommandHint) {
    lines.push('');
    lines.push(thingsCommandHint);
  }
  lines.push('');
  lines.push('当前线程近期上下文：');
  lines.push(renderedHistory || '(无)');
  lines.push('');
  lines.push('用户最新消息：');
  lines.push(message || '(空)');
  if (imageCount > 0) {
    lines.push(`附加图片：${imageCount} 张（请结合图片内容回答）。`);
  }
  lines.push('');
  lines.push(buildFeishuReplyInstructions());
  if (cwd) {
    lines.push('如果用户发送了文件或图片，消息正文里会给出本地下载路径；需要时请直接读取这些本地文件。');
  }
  return lines.join('\n').trim();
}

function buildLocalModelPrompt({
  systemPrompt,
  history,
  userText,
  imageCount = 0,
  memoryBundleText = '',
}) {
  const lines = [];
  const message = compactText(String(userText || ''), 2400);
  const renderedHistory = renderPromptHistory(history);
  lines.push(systemPrompt || DEFAULT_LOCAL_MODEL_SYSTEM_PROMPT);
  if (memoryBundleText) {
    lines.push('');
    lines.push('本地记忆（按机器人独立存储，跨线程共享）：');
    lines.push(memoryBundleText);
  }
  lines.push('');
  lines.push('当前线程近期上下文：');
  lines.push(renderedHistory || '(无)');
  lines.push('');
  lines.push('用户最新消息：');
  lines.push(message || '(空)');
  if (imageCount > 0) {
    lines.push(`附加图片：${imageCount} 张（当前本地模型接入只支持文本，不要假装看过图片内容）。`);
  }
  lines.push('');
  lines.push(buildLocalModelReplyInstructions());
  return lines.join('\n').trim();
}

function buildCodexResumePrompt({
  userText,
  imageCount = 0,
  fileWorkspaceDir = '',
  forceExecution = false,
  memoryBundleText = '',
  thingsCommandHint = '',
}) {
  const lines = [];
  const message = compactText(String(userText || ''), 2400);
  if (forceExecution) {
    lines.push(FORCE_EXECUTE_CODE_TASK_PROMPT);
    lines.push('');
  }
  lines.push('继续当前线程，直接回复用户。');
  if (fileWorkspaceDir) {
    lines.push('');
    lines.push(`机器人文件工作目录：${fileWorkspaceDir}`);
    lines.push('生成文件、整理附件或需要返回本地文件时，优先保存到机器人文件工作目录；发送附件指令请使用绝对路径。');
  }
  if (memoryBundleText) {
    lines.push('');
    lines.push('本地记忆（按机器人独立存储，跨线程共享）：');
    lines.push(memoryBundleText);
  }
  if (thingsCommandHint) {
    lines.push('');
    lines.push(thingsCommandHint);
  }
  lines.push('');
  lines.push('用户最新消息：');
  lines.push(message || '(空)');
  if (imageCount > 0) {
    lines.push(`附加图片：${imageCount} 张（请结合图片内容回答）。`);
  }
  lines.push('');
  lines.push(buildFeishuReplyInstructions());
  return lines.join('\n').trim();
}

function shouldForceCodexExecution(rawText = '') {
  const text = String(rawText || '').trim();
  if (!text) return false;
  if (/\.(c|cc|cpp|h|hpp|m|mm|swift|go|py|js|jsx|ts|tsx|java|kt|rb|rs|php|sh|json|ya?ml|toml|sql|md)\b/i.test(text)) {
    return true;
  }
  if (/`[^`\n]+`/.test(text)) return true;
  return /(改代码|改程序|修改代码|修代码|修一下|修复|修正|排查|定位问题|找原因|加个|增加|补上|实现|支持|处理一下|优化|重构|删掉|删除|替换|更新配置|改配置|写脚本|脚本|命令|编译|构建|打包|部署|发布|刷机|烧录|固件|接口|版本号|回滚|迁移|测试一下|bug|fix|debug|implement|refactor|patch|compile|build|deploy|release|rollback|hotfix|config|firmware)/i.test(text);
}

function shouldBypassCodexSandbox(sandbox, approvalPolicy) {
  return String(sandbox || '').trim() === 'danger-full-access'
    && String(approvalPolicy || '').trim() === 'never';
}

function extractCodexDelegateDirective(rawText) {
  const text = String(rawText || '').trim();
  if (!text) {
    return {
      hasDirective: false,
      delegatedPrompt: '',
      remainingText: '',
    };
  }

  const blockPattern = /\[\[CODEX_DELEGATE\]\]([\s\S]*?)\[\[\/CODEX_DELEGATE\]\]/i;
  const blockMatch = text.match(blockPattern);
  if (blockMatch) {
    return {
      hasDirective: true,
      delegatedPrompt: String(blockMatch[1] || '').trim(),
      remainingText: text.replace(blockMatch[0], '').trim(),
    };
  }

  const inlinePattern = /\[\[CODEX_DELEGATE:\s*([\s\S]*?)\s*\]\]/i;
  const inlineMatch = text.match(inlinePattern);
  if (inlineMatch) {
    return {
      hasDirective: true,
      delegatedPrompt: String(inlineMatch[1] || '').trim(),
      remainingText: text.replace(inlineMatch[0], '').trim(),
    };
  }

  return {
    hasDirective: false,
    delegatedPrompt: '',
    remainingText: text,
  };
}

async function runCodexExec(params) {
  const releaseLock = await acquireCodexExecLock('codex-json');
  try {
    return await runCodexExecUnlocked(params);
  } finally {
    releaseLock();
  }
}

function runCodexExecUnlocked({
  bin,
  model,
  reasoningEffort,
  profile,
  home = '',
  cwd,
  addDirs = [],
  sandbox,
  approvalPolicy,
  apiKey = '',
  prompt,
  imagePaths = [],
  resumeSessionId = '',
  onSpawn = null,
  onEvent = null,
}) {
  return new Promise((resolve, reject) => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-codex-'));
    const outputFile = path.join(tempDir, 'last-message.txt');
    let settled = false;

    const resumeId = String(resumeSessionId || '').trim();
    const bypassSandbox = shouldBypassCodexSandbox(sandbox, approvalPolicy);
    const args = resumeId
      ? ['exec', 'resume', '--skip-git-repo-check', '--json']
      : ['exec', '--skip-git-repo-check', '--json'];

    if (bypassSandbox) args.push('--dangerously-bypass-approvals-and-sandbox');
    if (model) args.push('-m', model);
    if (reasoningEffort) args.push('-c', `model_reasoning_effort=\"${reasoningEffort}\"`);
    if (!resumeId && profile) args.push('-p', profile);
    if (!resumeId && cwd) args.push('-C', cwd);
    if (!resumeId) {
      for (const dir of addDirs || []) {
        if (!String(dir || '').trim()) continue;
        args.push('--add-dir', dir);
      }
    }
    if (!resumeId && sandbox && !bypassSandbox) args.push('-s', sandbox);
    if (approvalPolicy && !bypassSandbox) args.push('-c', `approval_policy=\"${approvalPolicy}\"`);
    for (const imagePath of imagePaths || []) {
      if (!String(imagePath || '').trim()) continue;
      args.push('-i', imagePath);
    }
    args.push('--output-last-message', outputFile);
    if (resumeId) args.push(resumeId);
    args.push('-');

    const childEnv = { ...process.env };
    childEnv.HOME = process.env.HOME || os.homedir();
    childEnv.CODEX_HOME = String(home || '').trim() || process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
    const resolvedApiKey = String(apiKey || '').trim();
    if (resolvedApiKey) {
      childEnv.OPENAI_API_KEY = resolvedApiKey;
      childEnv.CODEX_API_KEY = resolvedApiKey;
    } else {
      delete childEnv.OPENAI_API_KEY;
      delete childEnv.CODEX_API_KEY;
    }

    const child = spawn(bin, args, {
      cwd: cwd || process.cwd(),
      env: childEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    if (typeof onSpawn === 'function') {
      try {
        onSpawn(child);
      } catch (_) {
        // ignore spawn hook errors
      }
    }

    let stderr = '';
    let stdout = '';
    let stdoutJsonBuffer = '';
    let observedThreadId = resumeId;
    let lastAgentMessageText = '';

    function cleanupTempDir() {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }

    function settleReject(err) {
      if (settled) return;
      settled = true;
      cleanupTempDir();
      reject(err);
    }

    function settleResolve(result) {
      if (settled) return;
      settled = true;
      cleanupTempDir();
      resolve(result);
    }

    function emitEvent(evt) {
      if (!onEvent) return;
      try {
        onEvent(evt);
      } catch (_) {
        // ignore progress callback errors
      }
    }

    function flushJsonLine(line) {
      const trimmed = String(line || '').trim();
      if (!trimmed) return;
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed?.type === 'thread.started' && parsed?.thread_id) {
          observedThreadId = String(parsed.thread_id || '').trim() || observedThreadId;
        }
        const agentMessageText = extractCodexAgentMessageText(parsed);
        if (agentMessageText) {
          lastAgentMessageText = agentMessageText;
        }
        emitEvent(parsed);
      } catch (_) {
        emitEvent({ type: 'raw', text: trimmed });
      }
    }

    child.stdout.on('data', (buf) => {
      const chunk = String(buf || '');
      if (!chunk) return;
      stdout = `${stdout}${chunk}`;
      if (stdout.length > 4000) stdout = stdout.slice(-4000);
      stdoutJsonBuffer = `${stdoutJsonBuffer}${chunk}`;
      let idx = stdoutJsonBuffer.indexOf('\n');
      while (idx >= 0) {
        const line = stdoutJsonBuffer.slice(0, idx);
        stdoutJsonBuffer = stdoutJsonBuffer.slice(idx + 1);
        flushJsonLine(line);
        idx = stdoutJsonBuffer.indexOf('\n');
      }
    });

    child.stderr.on('data', (buf) => {
      const chunk = String(buf || '');
      if (!chunk) return;
      stderr = `${stderr}${chunk}`;
      if (stderr.length > 4000) stderr = stderr.slice(-4000);
    });

    child.on('error', (err) => {
      settleReject(new Error(`codex spawn failed: ${err.message}`));
    });

    child.on('close', async (code, signal) => {
      if (settled) return;
      if (stdoutJsonBuffer.trim()) flushJsonLine(stdoutJsonBuffer.trim());

      try {
        const reply = await waitForNonEmptyFile(outputFile);
        if (String(reply || '').trim()) {
          settleResolve({
            reply,
            threadId: observedThreadId,
          });
          return;
        }
        if (lastAgentMessageText) {
          settleResolve({
            reply: lastAgentMessageText,
            threadId: observedThreadId,
          });
          return;
        }
        if (code !== 0) {
          const details = extractCodexErrorSummary(stderr, stdout)
            || compactText(stderr || stdout || `exit=${code}, signal=${signal || ''}`, 1200);
          settleReject(new Error(`codex exec failed: ${details}`));
          return;
        }
        settleReject(new Error('codex returned empty reply'));
      } catch (err) {
        if (lastAgentMessageText) {
          settleResolve({
            reply: lastAgentMessageText,
            threadId: observedThreadId,
          });
          return;
        }
        if (code !== 0) {
          const details = extractCodexErrorSummary(stderr, stdout)
            || compactText(stderr || stdout || `exit=${code}, signal=${signal || ''}`, 1200);
          settleReject(new Error(`codex exec failed: ${details}`));
          return;
        }
        settleReject(new Error(`read codex output failed: ${err.message}`));
      }
    });

    child.stdin.on('error', (err) => {
      const code = String(err?.code || '').trim();
      if (code === 'EPIPE' || code === 'ERR_STREAM_DESTROYED') {
        stderr = compactText(
          [stderr, `stdin ${code}: ${err.message}`].filter(Boolean).join('\n'),
          4000
        );
        return;
      }
      settleReject(new Error(`codex stdin failed: ${err.message}`));
    });

    try {
      child.stdin.end(prompt);
    } catch (err) {
      const code = String(err?.code || '').trim();
      if (code === 'EPIPE' || code === 'ERR_STREAM_DESTROYED') {
        stderr = compactText(
          [stderr, `stdin ${code}: ${err.message}`].filter(Boolean).join('\n'),
          4000
        );
      } else {
        settleReject(new Error(`codex stdin failed: ${err.message}`));
      }
    }
  });
}

function extractCodexAgentMessageText(event = null) {
  if (!event || typeof event !== 'object') return '';
  if (event.type === 'agent_message' && event.text) {
    return String(event.text || '');
  }
  const item = event.item;
  if (event.type === 'item.completed' && item?.type === 'agent_message' && item?.text) {
    return String(item.text || '');
  }
  return '';
}

function extractCodexJsonErrorMessages(rawText = '') {
  const messages = [];
  for (const line of String(rawText || '').replace(/\r/g, '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.startsWith('{')) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed?.type === 'error' && parsed?.message) {
        messages.push(String(parsed.message || '').trim());
      } else if (parsed?.type === 'turn.failed' && parsed?.error?.message) {
        messages.push(String(parsed.error.message || '').trim());
      }
    } catch (_) {
      // Ignore non-JSON log lines.
    }
  }
  return messages.filter(Boolean);
}

function isCodexAuthenticationErrorText(rawText = '') {
  const text = String(rawText || '');
  if (!text) return false;
  return [
    /refresh token has already been used/i,
    /access token could not be refreshed/i,
    /authentication token is expired/i,
    /token_expired/i,
    /401 Unauthorized/i,
  ].some((pattern) => pattern.test(text));
}

function extractCodexErrorSummary(...parts) {
  const combined = parts
    .map((part) => String(part || ''))
    .filter(Boolean)
    .join('\n')
    .replace(/\r/g, '\n');
  if (!combined.trim()) return '';

  const jsonMessages = extractCodexJsonErrorMessages(combined);
  const candidates = [
    ...jsonMessages,
    ...combined.split('\n').map((line) => line.trim()).filter(Boolean),
  ];

  const authCandidate = candidates.find((line) => isCodexAuthenticationErrorText(line));
  if (authCandidate) {
    return `Codex 登录态失效：${compactText(authCandidate, 500)}`;
  }

  const errorCandidate = candidates.find((line) => {
    const lower = line.toLowerCase();
    if (lower.startsWith('202') && (lower.includes(' warn ') || lower.includes(' error '))) return true;
    if (lower.includes('error') || lower.includes('failed') || lower.includes('unauthorized')) return true;
    return false;
  });
  if (errorCandidate) return compactText(errorCandidate, 600);

  return compactText(combined, 600);
}

function shouldRetryCodexExecError(err) {
  const text = String(err?.message || '').trim();
  if (!text) return false;
  if (isCodexAuthenticationErrorText(text)) return false;
  return [
    'codex returned empty reply',
    'no last agent message',
    'failed to refresh available models',
    'timeout waiting for child process to exit',
    'migration 21 was previously applied but is missing',
  ].some((fragment) => text.includes(fragment));
}

function parseCodexPlainExecOutput(rawText = '') {
  const lines = String(rawText || '')
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.trimEnd());
  const nonEmpty = lines.filter((line) => line.trim().length > 0);
  if (nonEmpty.length === 0) return '';

  const assistantMarkerIndex = nonEmpty.findIndex((line) => line.trim().toLowerCase() === 'assistant');
  if (assistantMarkerIndex >= 0) {
    const tokenIndexAfterAssistant = nonEmpty
      .slice(assistantMarkerIndex + 1)
      .findIndex((line) => line.trim().toLowerCase() === 'tokens used');
    const assistantEndIndex = tokenIndexAfterAssistant >= 0
      ? assistantMarkerIndex + 1 + tokenIndexAfterAssistant
      : nonEmpty.length;
    const afterAssistant = nonEmpty
      .slice(assistantMarkerIndex + 1, assistantEndIndex)
      .filter((line) => {
        const trimmed = line.trim();
        if (!trimmed) return false;
        const lower = trimmed.toLowerCase();
        if (lower.startsWith('202') && lower.includes(' warn ')) return false;
        if (lower.startsWith('mcp: ')) return false;
        if (lower.startsWith('mcp startup:')) return false;
        if (lower.startsWith('warning:')) return false;
        return true;
      });
    const assistantBody = afterAssistant.join('\n').trim();
    if (assistantBody) return assistantBody;
  }

  const tokenIndex = nonEmpty.findIndex((line) => line.trim().toLowerCase() === 'tokens used');
  const candidateLines = tokenIndex >= 0 ? nonEmpty.slice(0, tokenIndex) : nonEmpty.slice();
  let anchor = -1;
  for (let index = candidateLines.length - 1; index >= 0; index -= 1) {
    if (candidateLines[index].trim().toLowerCase() === 'codex') {
      anchor = index;
      break;
    }
  }
  const body = anchor >= 0 ? candidateLines.slice(anchor + 1) : candidateLines;
  return body.join('\n').trim();
}

function summarizeCodexExecFailure(err, codex = {}) {
  const rawMessage = String(err?.message || '未知错误').trim();
  const runtimeProvider = codex.runtimeProvider || deriveCodexRuntimeProvider(codex);
  const providerLabel = runtimeProvider.providerName || runtimeProvider.provider || 'current';
  const summaryLines = [
    `Codex 执行失败。当前配置：provider=${providerLabel}, model=${codex.model || '(default)'}, approval=${codex.approvalPolicy || '(default)'}, sandbox=${codex.sandbox || '(default)'}`,
  ];
  if (runtimeProvider.providerBaseUrl) {
    summaryLines.push(`provider_base_url=${runtimeProvider.providerBaseUrl}`);
  }

  const normalized = rawMessage.replace(/\r/g, '\n');
  const directErrorSummary = extractCodexErrorSummary(normalized);
  if (directErrorSummary) {
    summaryLines.push(`底层错误：${compactText(directErrorSummary, 600)}`);
    return compactText(summaryLines.join('\n'), 1000);
  }

  const firstErrorLine = normalized
    .split('\n')
    .map((line) => line.trim())
    .find((line) => {
      if (!line) return false;
      const lower = line.toLowerCase();
      if (lower.startsWith('openai codex v')) return false;
      if (line === '--------') return false;
      if (lower.startsWith('workdir:')) return false;
      if (lower.startsWith('model:')) return false;
      if (lower.startsWith('provider:')) return false;
      if (lower.startsWith('approval:')) return false;
      if (lower.startsWith('sandbox:')) return false;
      if (lower.startsWith('reasoning effort:')) return false;
      if (lower.startsWith('reasoning summaries:')) return false;
      if (lower.startsWith('session id:')) return false;
      if (lower === 'user') return false;
      return true;
    }) || '';

  if (firstErrorLine) {
    summaryLines.push(`底层错误：${compactText(firstErrorLine, 600)}`);
  } else if (rawMessage) {
    summaryLines.push(`底层错误：${compactText(rawMessage, 600)}`);
  }

  return compactText(summaryLines.join('\n'), 1000);
}

function wrapCodexExecFailure(err, codex = {}, prefix = 'codex exec failed') {
  const summary = summarizeCodexExecFailure(err, codex);
  const wrapped = new Error(`${prefix}: ${summary}`);
  wrapped.cause = err;
  wrapped.userVisibleSummary = summary;
  return wrapped;
}

function createIsolatedCodexHome(sourceHome) {
  const resolvedSourceHome = resolveOptionalDir(sourceHome);
  if (!resolvedSourceHome || !fs.existsSync(resolvedSourceHome)) return '';
  const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-codex-home-'));
  copyDirFilteredSync(resolvedSourceHome, isolatedHome, {
    skipNames: new Set([
      'state_5.sqlite',
      'state_5.sqlite-shm',
      'state_5.sqlite-wal',
      'logs_2.sqlite',
      'logs_2.sqlite-shm',
      'logs_2.sqlite-wal',
    ]),
    skipRelativePrefixes: ['log', 'tmp', 'shell_snapshots'],
  });
  const sourceAuthPath = path.join(resolvedSourceHome, 'auth.json');
  const isolatedAuthPath = path.join(isolatedHome, 'auth.json');
  if (fs.existsSync(sourceAuthPath)) {
    try {
      fs.rmSync(isolatedAuthPath, { force: true });
      fs.symlinkSync(sourceAuthPath, isolatedAuthPath);
    } catch (_) {
      // If symlinking fails, keep the copied home; the caller will surface any auth issue.
    }
  }
  return isolatedHome;
}

function ensureCodexHomeReady(configuredHome) {
  const resolvedHome = resolveOptionalDir(configuredHome);
  if (!resolvedHome) return '';
  if (fs.existsSync(resolvedHome)) return resolvedHome;

  const defaultHome = path.join(os.homedir(), '.codex');
  if (!fs.existsSync(defaultHome)) {
    ensureDirSync(resolvedHome);
    return resolvedHome;
  }

  copyDirFilteredSync(defaultHome, resolvedHome, {
    skipNames: new Set([
      'state_5.sqlite',
      'state_5.sqlite-shm',
      'state_5.sqlite-wal',
      'logs_2.sqlite',
      'logs_2.sqlite-shm',
      'logs_2.sqlite-wal',
    ]),
    skipRelativePrefixes: ['log', 'tmp', 'shell_snapshots'],
  });
  return resolvedHome;
}

async function runCodexExecPlainText(params) {
  const releaseLock = await acquireCodexExecLock('codex-plain');
  try {
    return await runCodexExecPlainTextUnlocked(params);
  } finally {
    releaseLock();
  }
}

function runCodexExecPlainTextUnlocked({
  bin,
  model,
  reasoningEffort,
  profile,
  home = '',
  cwd,
  addDirs = [],
  sandbox,
  approvalPolicy,
  apiKey = '',
  prompt,
  imagePaths = [],
  codex = null,
}) {
  return new Promise((resolve, reject) => {
    const bypassSandbox = shouldBypassCodexSandbox(sandbox, approvalPolicy);
    const args = ['exec', '--skip-git-repo-check'];
    if (bypassSandbox) args.push('--dangerously-bypass-approvals-and-sandbox');
    if (model) args.push('-m', model);
    if (reasoningEffort) args.push('-c', `model_reasoning_effort=\"${reasoningEffort}\"`);
    if (profile) args.push('-p', profile);
    if (cwd) args.push('-C', cwd);
    for (const dir of addDirs || []) {
      if (!String(dir || '').trim()) continue;
      args.push('--add-dir', dir);
    }
    if (sandbox && !bypassSandbox) args.push('-s', sandbox);
    if (approvalPolicy && !bypassSandbox) args.push('-c', `approval_policy=\"${approvalPolicy}\"`);
    for (const imagePath of imagePaths || []) {
      if (!String(imagePath || '').trim()) continue;
      args.push('-i', imagePath);
    }
    args.push('-');

    const childEnv = { ...process.env };
    childEnv.HOME = process.env.HOME || os.homedir();
    childEnv.CODEX_HOME = String(home || '').trim() || process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
    const resolvedApiKey = String(apiKey || '').trim();
    if (resolvedApiKey) {
      childEnv.OPENAI_API_KEY = resolvedApiKey;
      childEnv.CODEX_API_KEY = resolvedApiKey;
    } else {
      delete childEnv.OPENAI_API_KEY;
      delete childEnv.CODEX_API_KEY;
    }

    const child = spawn(bin, args, {
      cwd: cwd || process.cwd(),
      env: childEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (buf) => {
      stdout = `${stdout}${String(buf || '')}`;
      if (stdout.length > 20000) stdout = stdout.slice(-20000);
    });
    child.stderr.on('data', (buf) => {
      stderr = `${stderr}${String(buf || '')}`;
      if (stderr.length > 12000) stderr = stderr.slice(-12000);
    });
    child.on('error', (err) => {
      reject(wrapCodexExecFailure(new Error(`codex plain spawn failed: ${err.message}`), codex || {
        home,
        model,
        sandbox,
        approvalPolicy,
      }, 'codex plain exec failed'));
    });
    child.on('close', (code, signal) => {
      if (code !== 0) {
        const details = extractCodexErrorSummary(stderr, stdout)
          || compactText(stderr || stdout || `exit=${code}, signal=${signal || ''}`, 1200);
        reject(wrapCodexExecFailure(new Error(`codex plain exec failed: ${details}`), codex || {
          home,
          model,
          sandbox,
          approvalPolicy,
        }, 'codex plain exec failed'));
        return;
      }
      const parsedReply = parseCodexPlainExecOutput(stdout);
      if (parsedReply) {
        resolve({ reply: parsedReply, threadId: '' });
        return;
      }
      const details = compactText(stderr || stdout || `exit=${code}, signal=${signal || ''}`, 1200);
      reject(wrapCodexExecFailure(new Error(`codex plain exec failed: ${details}`), codex || {
        home,
        model,
        sandbox,
        approvalPolicy,
      }, 'codex plain exec failed'));
    });
    child.stdin.end(prompt);
  });
}

async function generateCodexReply({
  codex,
  history,
  userText,
  imagePaths = [],
  sessionId = '',
  threadTitle = '',
  fileWorkspaceDir = '',
  forceExecution = false,
  memoryBundleText = '',
  thingsCommandHint = '',
  onSpawn = null,
  onProgressEvent = null,
  throwIfCancelled = null,
}) {
  let resolvedSessionId = String(sessionId || '').trim();
  const activeCodex = selectCodexConfigForUserText(codex, userText);
  if (activeCodex?.activeModelRoute) {
    const route = activeCodex.activeModelRoute;
    console.log(
      `codex_model_route=${route.name} matched=${JSON.stringify(route.matchedKeyword || '')} model=${route.model || '(default)'} reasoning_effort=${route.reasoningEffort || '(default)'}`
    );
  }
  const imageCount = Array.isArray(imagePaths) ? imagePaths.length : 0;
  const ensureNotCancelled = typeof throwIfCancelled === 'function'
    ? throwIfCancelled
    : () => {};
  const runExec = async ({ prompt, resumeSessionId = '' }) => {
    ensureNotCancelled();
    return runCodexExec({
      bin: activeCodex.bin,
      model: activeCodex.model,
      reasoningEffort: activeCodex.reasoningEffort,
      profile: activeCodex.profile,
      home: activeCodex.home,
      cwd: activeCodex.cwd,
      addDirs: activeCodex.addDirs,
      apiKey: activeCodex.apiKey,
      sandbox: activeCodex.sandbox,
      approvalPolicy: activeCodex.approvalPolicy,
      prompt,
      imagePaths,
      resumeSessionId,
      onSpawn,
      onEvent: onProgressEvent,
    });
  };

  const runExecWithRecovery = async ({ prompt, resumeSessionId = '' }) => {
    try {
      const result = await runExec({ prompt, resumeSessionId });
      if (String(result?.reply || '').trim()) return result;
      throw new Error('codex returned empty reply');
    } catch (err) {
      if (!shouldRetryCodexExecError(err)) throw err;
      ensureNotCancelled();
      const sourceHome = activeCodex.home || process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
      const isolatedHome = createIsolatedCodexHome(sourceHome);
      if (!isolatedHome) throw err;
      console.error(
        `codex_exec_retry reason=${JSON.stringify(compactText(String(err.message || ''), 240))} isolated_home=${isolatedHome}`
      );
      try {
        const retryResult = await runCodexExec({
          bin: activeCodex.bin,
          model: activeCodex.model,
          reasoningEffort: activeCodex.reasoningEffort,
          profile: activeCodex.profile,
          home: isolatedHome,
          cwd: activeCodex.cwd,
          addDirs: activeCodex.addDirs,
          apiKey: activeCodex.apiKey,
          sandbox: activeCodex.sandbox,
          approvalPolicy: activeCodex.approvalPolicy,
          prompt,
          imagePaths,
          resumeSessionId: '',
          onSpawn,
          onEvent: onProgressEvent,
        });
        if (String(retryResult?.reply || '').trim()) {
          return retryResult;
        }
        throw new Error('codex returned empty reply');
      } catch (retryErr) {
        ensureNotCancelled();
        console.error(
          `codex_exec_plain_retry reason=${JSON.stringify(compactText(String(retryErr.message || ''), 240))} isolated_home=${isolatedHome}`
        );
        try {
          return await runCodexExecPlainText({
            bin: activeCodex.bin,
            model: activeCodex.model,
            reasoningEffort: activeCodex.reasoningEffort,
            profile: activeCodex.profile,
            home: isolatedHome,
            cwd: activeCodex.cwd,
            addDirs: activeCodex.addDirs,
            apiKey: activeCodex.apiKey,
            sandbox: activeCodex.sandbox,
            approvalPolicy: activeCodex.approvalPolicy,
            prompt,
            imagePaths,
            codex: activeCodex,
          });
        } finally {
          removePathSync(isolatedHome);
        }
      }
    }
  };

  if (resolvedSessionId) {
    const existingPolicy = readCodexThreadExecutionPolicy(resolvedSessionId, activeCodex.home);
    const resumeDecision = shouldResumeCodexThread(existingPolicy, activeCodex);
    if (!resumeDecision.ok) {
      const expectedProvider = activeCodex?.runtimeProvider?.provider || '';
      console.log(`codex_resume_skip thread_id=${resolvedSessionId} reason=${resumeDecision.reason} existing_sandbox=${existingPolicy?.sandboxType || '(unknown)'} existing_approval=${existingPolicy?.approvalMode || '(unknown)'} existing_provider=${existingPolicy?.provider || '(unknown)'} expected_sandbox=${activeCodex.sandbox || '(none)'} expected_approval=${activeCodex.approvalPolicy || '(none)'} expected_provider=${expectedProvider || '(none)'}`);
      resolvedSessionId = '';
    }
  }

  if (resolvedSessionId) {
    try {
      const resumed = await runExec({
        prompt: buildCodexResumePrompt({
          userText,
          imageCount,
          fileWorkspaceDir,
          forceExecution,
          memoryBundleText,
          thingsCommandHint,
        }),
        resumeSessionId: resolvedSessionId,
      });
      return {
        reply: String(resumed?.reply || ''),
        threadId: String(resumed?.threadId || resolvedSessionId),
      };
    } catch (err) {
      ensureNotCancelled();
      console.error(`codex_resume=error thread_id=${resolvedSessionId} message=${err.message}`);
    }
  }

  ensureNotCancelled();
  const fresh = await runExecWithRecovery({
    prompt: buildCodexPrompt({
      systemPrompt: activeCodex.systemPrompt,
      history,
      userText,
      imageCount,
      cwd: activeCodex.cwd,
      addDirs: activeCodex.addDirs,
      fileWorkspaceDir,
      threadTitle,
      forceExecution,
      memoryBundleText,
      thingsCommandHint,
    }),
  });

  return {
    reply: String(fresh?.reply || ''),
    threadId: String(fresh?.threadId || ''),
  };
}

function runLocalModelPrompt({
  localModel,
  prompt,
}) {
  return new Promise((resolve, reject) => {
    const scriptPath = String(localModel?.promptScript || '').trim();
    if (!scriptPath) {
      reject(new Error('local model prompt_script missing'));
      return;
    }

    const childEnv = {
      ...process.env,
      MAX_KV_SIZE: String(localModel.maxKvSize || 1024),
      MAX_TOKENS: String(localModel.maxTokens || 384),
      TEMP: String(localModel.temp ?? 0.2),
      SYSTEM_PROMPT: String(localModel.systemPrompt || DEFAULT_LOCAL_MODEL_SYSTEM_PROMPT),
    };
    if (String(localModel.model || '').trim()) {
      childEnv.MODEL = String(localModel.model || '').trim();
    }

    const child = spawn('/bin/bash', [scriptPath, String(prompt || '')], {
      cwd: localModel.cwd || process.cwd(),
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (buf) => {
      stdout = `${stdout}${String(buf || '')}`;
      if (stdout.length > 24000) stdout = stdout.slice(-24000);
    });

    child.stderr.on('data', (buf) => {
      stderr = `${stderr}${String(buf || '')}`;
      if (stderr.length > 8000) stderr = stderr.slice(-8000);
    });

    child.on('error', (err) => {
      reject(new Error(`local model spawn failed: ${err.message}`));
    });

    child.on('close', (code, signal) => {
      if (code !== 0) {
        const details = compactText(stderr || stdout || `exit=${code}, signal=${signal || ''}`, 1200);
        reject(new Error(`local model prompt failed: ${details}`));
        return;
      }
      resolve(String(stdout || ''));
    });
  });
}

async function generateLocalModelReply({
  localModel,
  history,
  userText,
  imagePaths = [],
  memoryBundleText = '',
}) {
  const reply = await requestLocalModelReply({
    localModel,
    history,
    userText,
    imagePaths,
    memoryBundleText,
  });
  return {
    reply: String(reply || ''),
  };
}

async function requestLocalModelServer({
  localModel,
  messages,
}) {
  const baseUrl = String(localModel?.serverBaseUrl || '').trim().replace(/\/+$/, '');
  if (!baseUrl) {
    throw new Error('local model server_base_url missing');
  }
  if (typeof fetch !== 'function') {
    throw new Error('global fetch is not available in this node runtime');
  }
  const controller = new AbortController();
  const timeoutMs = Number(localModel?.requestTimeoutMs || 180000);
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const body = {
      messages,
      temperature: Number(localModel?.temp ?? 0.2),
      max_tokens: Number(localModel?.maxTokens || 256),
      stream: false,
      chat_template_kwargs: {
        enable_thinking: false,
      },
    };
    if (String(localModel?.model || '').trim()) {
      body.model = String(localModel.model || '').trim();
    }
    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    const raw = await response.text();
    let data = null;
    try {
      data = raw ? JSON.parse(raw) : null;
    } catch (_) {
      data = null;
    }
    if (!response.ok) {
      throw new Error(`status=${response.status} body=${compactText(raw || '', 800)}`);
    }
    const choice = Array.isArray(data?.choices) ? data.choices[0] : null;
    const message = choice?.message || {};
    const content = message?.content;
    if (typeof content === 'string' && content.trim()) {
      return content.trim();
    }
    if (Array.isArray(content)) {
      const text = content
        .map((item) => {
          if (typeof item === 'string') return item;
          if (item && typeof item.text === 'string') return item.text;
          if (item && typeof item.content === 'string') return item.content;
          return '';
        })
        .join('')
        .trim();
      if (text) return text;
    }
    throw new Error('local model server returned empty content');
  } catch (err) {
    if (String(err?.name || '') === 'AbortError') {
      throw new Error(`local model server timed out after ${timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function requestLocalModelReply({
  localModel,
  history,
  userText,
  imagePaths = [],
  memoryBundleText = '',
}) {
  const messages = [];
  if (localModel.systemPrompt) {
    messages.push({ role: 'system', content: localModel.systemPrompt });
  }
  if (memoryBundleText) {
    messages.push({
      role: 'system',
      content: `本地记忆（按机器人独立存储，跨线程共享）：\n${memoryBundleText}`,
    });
  }
  for (const item of history || []) {
    const role = String(item?.role || '').trim().toLowerCase() === 'assistant' ? 'assistant' : 'user';
    const text = compactText(String(item?.text || '').trim(), 2400);
    if (!text) continue;
    messages.push({ role, content: text });
  }
  const userLines = [compactText(String(userText || '').trim(), 2400) || '(空)'];
  if (Array.isArray(imagePaths) && imagePaths.length > 0) {
    userLines.push(`附加图片：${imagePaths.length} 张（当前本地模型接入只支持文本，不要假装看过图片内容）。`);
  }
  messages.push({
    role: 'user',
    content: userLines.join('\n'),
  });

  if (String(localModel.serverBaseUrl || '').trim()) {
    try {
      return await requestLocalModelServer({
        localModel,
        messages,
      });
    } catch (err) {
      console.error(`local_model_server=error message=${err.message}`);
      if (!String(localModel.promptScript || '').trim()) {
        throw err;
      }
    }
  }

  const prompt = buildLocalModelPrompt({
    systemPrompt: localModel.systemPrompt,
    history,
    userText,
    imageCount: Array.isArray(imagePaths) ? imagePaths.length : 0,
    memoryBundleText,
  });
  return runLocalModelPrompt({
    localModel,
    prompt,
  });
}

function shouldDelegateToCodexInLocalModel(rawText = '') {
  const text = String(rawText || '').trim();
  if (!text) return false;
  if (/^\/codex\b/i.test(text)) return true;
  if (/(调用\s*codex|用\s*codex|交给\s*codex|让\s*codex|run\s+codex|use\s+codex)/i.test(text)) {
    return true;
  }
  if (/(skills?\b|skill\b|mcp\b|本机|工作区|workspace|终端|shell|命令行|读文件|读取文件|打开文件|目录|文件夹|运行命令|执行命令|调用工具|工具调用)/i.test(text)) {
    return true;
  }
  return shouldForceCodexExecution(text);
}

function extractFirstJsonObject(rawText) {
  const text = String(rawText || '').trim();
  if (!text) return null;

  const candidates = [];
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch?.[1]) {
    candidates.push(fenceMatch[1].trim());
  }
  candidates.push(text);

  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidates.push(text.slice(firstBrace, lastBrace + 1));
  }

  for (const candidate of uniqueStrings(candidates.filter(Boolean))) {
    try {
      return JSON.parse(candidate);
    } catch (_) {
      // keep trying
    }
  }
  return null;
}

function buildScheduledTaskIntentJudgePrompt({ text, pending = null, tasksSummary = '' }) {
  const lines = [
    '你是一个严格的意图分类器，只判断用户这条消息现在是否在管理“定时任务”。',
    '可识别意图只有：create、list、run_now、enable、disable、update_time、update_target。',
    '定时任务既可能是“昨日店铺报告”，也可能是“运行某个 skill 的定时任务”。',
    '如果用户是在继续别的正常任务、纠正误匹配、表示“都不是/不是这个意思/继续刚才任务/不用管定时任务”，就判定 should_handle=false；如果当前有 pending，请同时 exit_pending=true。',
    '如果拿不准，也返回 should_handle=false。',
    '只输出单行 JSON，不要解释，不要 markdown。',
    'JSON 结构：{"should_handle":boolean,"intent":"create|list|run_now|enable|disable|update_time|update_target|continue|unknown","confidence":0-1,"exit_pending":boolean}',
    '',
    `当前 pending：${pending ? safeJsonStringify(pending, 1200) : '(none)'}`,
    '现有任务：',
    tasksSummary || '(none)',
    '',
    '用户消息：',
    compactText(String(text || ''), 1200) || '(empty)',
  ];
  return lines.join('\n');
}

async function judgeScheduledTaskIntentWithCodex(codex, payload = {}) {
  const prompt = buildScheduledTaskIntentJudgePrompt(payload);
  const result = await runCodexExec({
    bin: codex.bin,
    model: codex.model,
    reasoningEffort: 'low',
    profile: codex.profile,
    cwd: codex.cwd,
    addDirs: codex.addDirs,
    sandbox: codex.sandbox,
    approvalPolicy: codex.approvalPolicy,
    apiKey: codex.apiKey,
    prompt,
    imagePaths: [],
  });
  const parsed = extractFirstJsonObject(result?.reply || '');
  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`intent judge returned non-json: ${compactText(result?.reply || '', 200)}`);
  }
  return parsed;
}

function buildBusyTargetKeysFromIncomingMessage({
  channelType = 'feishu',
  chatID = '',
  chatType = '',
  threadID = '',
  senderOpenID = '',
}) {
  if (normalizeChannelType(channelType) !== 'feishu') return [];
  const keys = [];
  const chat = normalizeString(chatID);
  const thread = normalizeString(threadID);
  const sender = normalizeString(senderOpenID);

  if (chat) {
    keys.push(`feishu:chat:${chat}`);
    if (thread) {
      keys.push(`feishu:thread:${chat}:${thread}`);
    }
  }
  if (!isGroupChat(chatType) && sender) {
    keys.push(`feishu:user:${sender}`);
  }
  return uniqueStrings(keys);
}

function buildBusyTargetKeysFromTaskTarget(task = {}) {
  if (normalizeChannelType(task.channel_type || task.channelType) !== 'feishu') return [];
  const targetType = normalizeTargetType(task.target_type || task.targetType);
  const targetID = normalizeString(task.target_id || task.targetId);
  const threadID = normalizeString(task.thread_id || task.threadId);
  if (!targetType || !targetID) return [];
  if (targetType === 'user') return [`feishu:user:${targetID}`];
  if (targetType === 'thread') {
    return uniqueStrings([
      `feishu:chat:${targetID}`,
      threadID ? `feishu:thread:${targetID}:${threadID}` : '',
    ].filter(Boolean));
  }
  if (targetType === 'session' || targetType === 'chat') {
    return [`feishu:chat:${targetID}`];
  }
  return [];
}

function markBusyTargetKeys(busyMap, keys = []) {
  const activeKeys = uniqueStrings((Array.isArray(keys) ? keys : []).filter(Boolean));
  for (const key of activeKeys) {
    busyMap.set(key, Number(busyMap.get(key) || 0) + 1);
  }
  return () => {
    for (const key of activeKeys) {
      const next = Number(busyMap.get(key) || 0) - 1;
      if (next > 0) busyMap.set(key, next);
      else busyMap.delete(key);
    }
  };
}

async function sendTextReply(client, chatID, text) {
  return client.im.v1.message.create({
    params: {
      receive_id_type: 'chat_id',
    },
    data: {
      receive_id: chatID,
      content: JSON.stringify({ text }),
      msg_type: 'text',
    },
  });
}

async function sendMarkdownCardReply(client, chatID, markdown) {
  const safeMarkdown = String(markdown || '').replace(/\r/g, '').trim();
  ensure(safeMarkdown, 'markdown reply is empty');
  const card = {
    config: {
      wide_screen_mode: true,
      enable_forward: true,
    },
    elements: [
      {
        tag: 'markdown',
        content: safeMarkdown,
      },
    ],
  };
  return client.im.v1.message.create({
    params: {
      receive_id_type: 'chat_id',
    },
    data: {
      receive_id: chatID,
      content: JSON.stringify(card),
      msg_type: 'interactive',
    },
  });
}

async function sendFileReply(client, chatID, fileKey) {
  return client.im.v1.message.create({
    params: {
      receive_id_type: 'chat_id',
    },
    data: {
      receive_id: chatID,
      content: JSON.stringify({ file_key: fileKey }),
      msg_type: 'file',
    },
  });
}

async function sendImageReply(client, chatID, imageKey) {
  return client.im.v1.message.create({
    params: {
      receive_id_type: 'chat_id',
    },
    data: {
      receive_id: chatID,
      content: JSON.stringify({ image_key: imageKey }),
      msg_type: 'image',
    },
  });
}

async function sendMediaReply(client, chatID, {
  fileKey = '',
  imageKey = '',
  fileName = '',
  duration = 0,
} = {}) {
  return client.im.v1.message.create({
    params: {
      receive_id_type: 'chat_id',
    },
    data: {
      receive_id: chatID,
      content: JSON.stringify({
        file_key: String(fileKey || '').trim(),
        image_key: String(imageKey || '').trim(),
        file_name: sanitizeLocalFileName(fileName, 'video.mp4'),
        duration: Math.max(0, Number(duration) || 0),
      }),
      msg_type: 'media',
    },
  });
}

async function uploadLocalFileToFeishu(client, localPath, options = {}) {
  const resolvedPath = path.resolve(String(localPath || ''));
  ensure(fs.existsSync(resolvedPath), `file not found: ${resolvedPath}`);
  const stat = fs.statSync(resolvedPath);
  ensure(stat.isFile(), `not a file: ${resolvedPath}`);
  ensure(stat.size > 0, `file is empty: ${resolvedPath}`);
  ensure(stat.size <= FEISHU_FILE_UPLOAD_LIMIT, `file too large: ${path.basename(resolvedPath)} (${formatBytes(stat.size)} > ${formatBytes(FEISHU_FILE_UPLOAD_LIMIT)})`);
  const requestedFileType = normalizeString(options?.forceFileType).toLowerCase();
  const fileType = requestedFileType || resolveFeishuUploadFileType(resolvedPath);

  const uploaded = await client.im.v1.file.create({
    data: {
      file_type: fileType,
      file_name: sanitizeLocalFileName(path.basename(resolvedPath)),
      file: fs.createReadStream(resolvedPath),
    },
  });
  const fileKey = String(uploaded?.file_key || '').trim();
  ensure(fileKey, `upload returned empty file_key: ${resolvedPath}`);
  return {
    fileKey,
    fileName: sanitizeLocalFileName(path.basename(resolvedPath)),
    localPath: resolvedPath,
    size: stat.size,
    uploadFileType: fileType,
  };
}

async function extractVideoPosterFrame(ffmpegBin, inputPath, outputPath) {
  ensure(ffmpegBin, 'ffmpeg not configured for video preview extraction');
  return new Promise((resolve, reject) => {
    const args = [
      '-y',
      '-i',
      inputPath,
      '-frames:v',
      '1',
      '-update',
      'true',
      outputPath,
    ];
    const child = spawn(ffmpegBin, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk || '');
    });
    child.on('error', (err) => {
      reject(new Error(`ffmpeg failed to start: ${err.message}`));
    });
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`ffmpeg exited with code ${code || 0}${stderr.trim() ? `: ${stderr.trim()}` : ''}`));
        return;
      }
      try {
        const stat = fs.statSync(outputPath);
        if (!stat.isFile() || stat.size <= 0) {
          reject(new Error(`ffmpeg output missing: ${outputPath}`));
          return;
        }
      } catch (err) {
        reject(new Error(`ffmpeg output missing: ${outputPath}`));
        return;
      }
      resolve();
    });
  });
}

async function uploadLocalImageToFeishu(client, localPath) {
  const resolvedPath = path.resolve(String(localPath || ''));
  ensure(fs.existsSync(resolvedPath), `file not found: ${resolvedPath}`);
  const stat = fs.statSync(resolvedPath);
  ensure(stat.isFile(), `not a file: ${resolvedPath}`);
  ensure(stat.size > 0, `file is empty: ${path.basename(resolvedPath)}`);
  ensure(stat.size <= FEISHU_IMAGE_UPLOAD_LIMIT, `image too large: ${path.basename(resolvedPath)} (${formatBytes(stat.size)} > ${formatBytes(FEISHU_IMAGE_UPLOAD_LIMIT)})`);
  ensure(isImageFilePath(resolvedPath), `unsupported image extension: ${path.extname(resolvedPath) || '(none)'}`);

  const uploaded = await client.im.v1.image.create({
    data: {
      image_type: 'message',
      image: fs.createReadStream(resolvedPath),
    },
  });
  const imageKey = String(uploaded?.image_key || '').trim();
  ensure(imageKey, `upload returned empty image_key: ${resolvedPath}`);
  return {
    imageKey,
    fileName: sanitizeLocalFileName(path.basename(resolvedPath)),
    localPath: resolvedPath,
    size: stat.size,
  };
}

async function uploadLocalMediaToFeishu(client, localPath, ffmpegBin) {
  const uploadedFile = await uploadLocalFileToFeishu(client, localPath);
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-media-'));
  const thumbPath = path.join(tempDir, `${path.parse(uploadedFile.fileName).name}.png`);
  try {
    await extractVideoPosterFrame(ffmpegBin, uploadedFile.localPath, thumbPath);
    const uploadedImage = await uploadLocalImageToFeishu(client, thumbPath);
    return {
      ...uploadedFile,
      imageKey: uploadedImage.imageKey,
      thumbnailPath: thumbPath,
      duration: 0,
    };
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function sendRequestedAttachments(client, chatID, attachments = [], cwd = '', shouldContinue = null, options = {}) {
  const sent = [];
  const failed = [];
  const ffmpegBin = String(options?.ffmpegBin || '').trim();

  for (const attachment of attachments || []) {
    if (typeof shouldContinue === 'function' && !shouldContinue()) {
      break;
    }
    const requestedType = attachment?.type === 'image'
      ? 'image'
      : attachment?.type === 'media'
        ? 'media'
        : 'file';
    const rawPath = attachment?.path || '';
    const resolvedPath = resolveLocalFilePath(rawPath, cwd);
    const fileName = sanitizeLocalFileName(path.basename(resolvedPath || rawPath || 'attachment.bin'));
    if (!resolvedPath) {
      failed.push({ type: requestedType, fileName, error: '路径为空' });
      continue;
    }

    if (requestedType === 'image') {
      try {
        const uploaded = await uploadLocalImageToFeishu(client, resolvedPath);
        await sendImageReply(client, chatID, uploaded.imageKey);
        sent.push({
          ...uploaded,
          type: 'image',
        });
        continue;
      } catch (imageErr) {
        console.error(`reply_image=error path=${resolvedPath} message=${imageErr.message}`);
        try {
          const uploaded = await uploadLocalFileToFeishu(client, resolvedPath);
          await sendFileReply(client, chatID, uploaded.fileKey);
          sent.push({
            ...uploaded,
            type: 'file',
          });
          continue;
        } catch (fileErr) {
          console.error(`reply_image_fallback_file=error path=${resolvedPath} message=${fileErr.message}`);
          failed.push({
            type: requestedType,
            fileName,
            localPath: resolvedPath,
            error: `${imageErr.message}; 回退文件发送也失败：${fileErr.message}`,
          });
          continue;
        }
      }
    }

    try {
      // `[[FEISHU_SEND_FILE:...]]` means "send as file". For videos, upload them as
      // generic stream files so Feishu accepts `msg_type=file` consistently.
      const shouldSendAsMedia = requestedType === 'media' && isFeishuMediaFilePath(resolvedPath);
      if (shouldSendAsMedia) {
        const uploaded = await uploadLocalMediaToFeishu(client, resolvedPath, ffmpegBin);
        await sendMediaReply(client, chatID, uploaded);
        sent.push({
          ...uploaded,
          type: 'media',
        });
        continue;
      }
      const uploaded = await uploadLocalFileToFeishu(client, resolvedPath, {
        forceFileType: requestedType === 'file' && isFeishuMediaFilePath(resolvedPath) ? 'stream' : '',
      });
      await sendFileReply(client, chatID, uploaded.fileKey);
      sent.push({
        ...uploaded,
        type: 'file',
      });
    } catch (err) {
      console.error(`reply_file=error path=${resolvedPath} message=${err.message}`);
      failed.push({ type: requestedType, fileName, localPath: resolvedPath, error: err.message });
    }
  }

  return { sent, failed };
}

async function updateTextMessage(client, messageID, text) {
  return client.im.v1.message.update({
    path: {
      message_id: messageID,
    },
    data: {
      msg_type: 'text',
      content: JSON.stringify({ text }),
    },
  });
}

async function recallMessage(client, messageID) {
  return client.im.v1.message.delete({
    path: {
      message_id: messageID,
    },
  });
}

function splitTextForFeishu(text, maxLength = FEISHU_TEXT_CHUNK_LIMIT) {
  const raw = String(text || '').replace(/\r/g, '');
  if (!raw) return [];
  const max = Math.max(500, Number(maxLength) || FEISHU_TEXT_CHUNK_LIMIT);
  const chunks = [];
  let cursor = 0;

  while (cursor < raw.length) {
    let end = Math.min(cursor + max, raw.length);
    if (end < raw.length) {
      const newlineCut = raw.lastIndexOf('\n', end);
      if (newlineCut > cursor + Math.floor(max * 0.6)) {
        end = newlineCut + 1;
      }
    }
    if (end <= cursor) end = Math.min(cursor + max, raw.length);
    chunks.push(raw.slice(cursor, end));
    cursor = end;
  }

  return chunks;
}

function shouldRenderFeishuMarkdown(rawText) {
  const text = String(rawText || '').replace(/\r/g, '').trim();
  if (!text) return false;
  if (text.includes('```')) return true;
  if (/`[^`\n]+`/.test(text)) return true;
  if (/\[[^\]]+\]\([^)]+\)/.test(text)) return true;
  if (/(\*\*|__|~~).+?\1/.test(text)) return true;

  const lines = text.split('\n');
  let structuralHits = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line) continue;
    if (/^#{1,6}\s/.test(line)) return true;
    if (/^>\s+/.test(line)) return true;
    if (/^\s*[-*+]\s+/.test(line)) structuralHits += 1;
    if (/^\s*\d+\.\s+/.test(line)) structuralHits += 1;
    if (line.includes('|') && i + 1 < lines.length && /^\s*\|?[\s:-]+\|[\s|:-]*$/.test(lines[i + 1].trim())) {
      return true;
    }
  }
  return structuralHits >= 2;
}

async function sendRenderedReply(client, chatID, rawText, {
  shouldContinue = null,
  logTag = 'reply',
  preferMarkdown = true,
} = {}) {
  const normalized = String(rawText || '').replace(/\r/g, '').trim();
  if (!normalized) return 0;

  const renderMarkdown = preferMarkdown && shouldRenderFeishuMarkdown(normalized);
  const chunkLimit = renderMarkdown ? FEISHU_MARKDOWN_CARD_CHUNK_LIMIT : FEISHU_TEXT_CHUNK_LIMIT;
  const chunks = splitTextForFeishu(normalized, chunkLimit);
  let sent = 0;
  for (let idx = 0; idx < chunks.length; idx += 1) {
    const chunk = chunks[idx];
    if (typeof shouldContinue === 'function' && !shouldContinue()) break;
    if (!chunk) continue;
    if (renderMarkdown) {
      try {
        await sendMarkdownCardReply(client, chatID, chunk);
        sent += 1;
        continue;
      } catch (err) {
        console.error(`${logTag}_markdown=error part=${idx + 1}/${chunks.length} message=${err.message}`);
      }
    }
    await sendTextReply(client, chatID, chunk);
    sent += 1;
  }
  return sent;
}

async function sendCodexReplyPassthrough(client, chatID, rawText, shouldContinue = null) {
  return sendRenderedReply(client, chatID, rawText, {
    shouldContinue,
    logTag: 'reply',
    preferMarkdown: true,
  });
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function makeTaskCancelledError(reason = 'cancelled') {
  const err = new Error(`task cancelled: ${reason}`);
  err.code = 'TASK_CANCELLED';
  err.cancelled = true;
  err.reason = reason;
  return err;
}

function isTaskCancelledError(err) {
  return Boolean(err && (err.cancelled || err.code === 'TASK_CANCELLED'));
}

async function sendTextReplySafe(client, chatID, text, logTag = 'reply') {
  try {
    await sendTextReply(client, chatID, text);
    return true;
  } catch (err) {
    console.error(`${logTag}=error message=${err.message}`);
    return false;
  }
}

async function sendTextReplyWithMessageIdSafe(client, chatID, text, logTag = 'reply') {
  try {
    const created = await sendTextReply(client, chatID, text);
    return String(created?.data?.message_id || '').trim();
  } catch (err) {
    console.error(`${logTag}=error message=${err.message}`);
    return '';
  }
}

async function recallMessageSafe(client, messageID, logTag = 'message_recall') {
  const target = String(messageID || '').trim();
  if (!target) return false;
  try {
    await recallMessage(client, target);
    return true;
  } catch (err) {
    console.error(`${logTag}=error message_id=${target} message=${err.message}`);
    return false;
  }
}

function createSilentProgressReporter() {
  return {
    async start() {
      return true;
    },
    push() {},
    recordEvent() {},
    async finalizeReply() {
      return false;
    },
    async complete() {
      return true;
    },
    async fail() {
      return true;
    },
    async recordFinalReply() {
      return false;
    },
    async abort() {
      return true;
    },
  };
}

async function appendDocTextBlocks(client, documentID, blocks) {
  const children = Array.isArray(blocks) ? blocks.filter(Boolean) : [];
  if (children.length === 0) return [];
  const retryDelays = [900, 2200];
  for (let attempt = 0; attempt <= retryDelays.length; attempt += 1) {
    try {
      const created = await client.docx.documentBlockChildren.create({
        path: {
          document_id: documentID,
          // Feishu docx uses the document root block id equal to document_id.
          block_id: documentID,
        },
        data: {
          children,
        },
      });
      return Array.isArray(created?.data?.children) ? created.data.children : [];
    } catch (err) {
      if (attempt >= retryDelays.length || !isRetryableFeishuDocWriteError(err)) {
        throw err;
      }
      await sleep(retryDelays[attempt]);
    }
  }
  return [];
}

async function patchDocTextBlock(client, documentID, blockID, text) {
  if (!documentID || !blockID) return null;
  const retryDelays = [900, 2200];
  for (let attempt = 0; attempt <= retryDelays.length; attempt += 1) {
    try {
      return await client.docx.documentBlock.patch({
        path: {
          document_id: documentID,
          block_id: blockID,
        },
        data: {
          update_text_elements: {
            elements: buildDocTextElements(text),
          },
        },
      });
    } catch (err) {
      if (attempt >= retryDelays.length || !isRetryableFeishuDocWriteError(err)) {
        throw err;
      }
      await sleep(retryDelays[attempt]);
    }
  }
  return null;
}

async function queryDocURL(client, documentID) {
  if (!documentID) return '';
  try {
    const meta = await client.drive.meta.batchQuery({
      data: {
        request_docs: [
          {
            doc_token: documentID,
            doc_type: 'docx',
          },
        ],
        with_url: true,
      },
    });
    return String(meta?.data?.metas?.[0]?.url || '').trim();
  } catch (err) {
    console.error(`progress_doc_url=error document_id=${documentID} message=${err.message}`);
    return '';
  }
}

async function shareDocWithChat(client, documentID, chatID) {
  if (!documentID || !chatID) return false;
  try {
    await client.drive.permissionMember.batchCreate({
      path: {
        token: documentID,
      },
      params: {
        type: 'docx',
        need_notification: false,
      },
      data: {
        members: [
          {
            member_type: 'openchat',
            member_id: chatID,
            perm: 'view',
            type: 'chat',
          },
        ],
      },
    });
    return true;
  } catch (err) {
    console.error(`progress_doc_share_chat=error document_id=${documentID} chat_id=${chatID} message=${err.message}`);
    return false;
  }
}

async function patchDocLinkScope(client, documentID, linkScope) {
  const scope = String(linkScope || '').trim().toLowerCase();
  if (!documentID || !scope || scope === 'closed') return false;

  const data = scope === 'anyone'
    ? { share_entity: 'anyone', link_share_entity: 'anyone_readable' }
    : { share_entity: 'same_tenant', link_share_entity: 'tenant_readable' };

  try {
    await client.drive.permissionPublic.patch({
      path: {
        token: documentID,
      },
      params: {
        type: 'docx',
      },
      data,
    });
    return true;
  } catch (err) {
    console.error(`progress_doc_share_link=error document_id=${documentID} scope=${scope} message=${err.message}`);
    return false;
  }
}

function createDocProgressReporter({
  client,
  chatID,
  initialMessage,
  userText,
  progressConfig,
  minUpdateIntervalMs = 1200,
  fallbackFactory,
}) {
  const intro = compactText(String(initialMessage || '').trim() || '已接收，开始执行。', 1200);
  const progressDoc = progressConfig?.doc || {};
  const minInterval = Math.max(5000, Number(minUpdateIntervalMs) || 1200);
  const startedAt = Date.now();
  const stepHistory = [];
  const pendingEntries = [];

  let documentID = '';
  let documentURL = '';
  let statusBlockID = '';
  let fallbackReporter = null;
  let flushTimer = null;
  let queue = Promise.resolve();
  let closed = false;
  let linkAnnounced = false;
  let linkMessageID = '';
  let lastStatusText = '';
  let lastFlushAt = 0;
  let fallbackNoticeSent = false;

  function runSerial(task) {
    const next = queue
      .catch(() => {})
      .then(task);
    queue = next.catch(() => {});
    return next;
  }

  function clearTimers() {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
  }

  function renderStatus(state = '运行中') {
    const elapsedSec = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
    const latestStep = stepHistory[stepHistory.length - 1] || intro;
    return compactText(`状态：${state}｜耗时：${elapsedSec}s｜最新：${latestStep}`, 900);
  }

  function trackStep(stepText) {
    const normalized = normalizeProgressSnippet(stepText, 120);
    if (!normalized || closed) return { normalized: '', changed: false };
    const changed = stepHistory[stepHistory.length - 1] !== normalized;
    if (changed) {
      stepHistory.push(normalized);
    }
    return { normalized, changed };
  }

  function queueEntries(entries, state = '运行中') {
    if (closed || fallbackReporter) return;
    const nextEntries = (Array.isArray(entries) ? entries : [entries]).filter(Boolean);
    if (nextEntries.length === 0) return;
    pendingEntries.push(...nextEntries);
    if (Date.now() - lastFlushAt >= minInterval) {
      runSerial(async () => {
        await flushPending(state);
      });
      return;
    }
    scheduleFlush();
  }

  async function activateFallback(reason, err) {
    if (!fallbackFactory) return null;
    if (!fallbackReporter) {
      clearTimers();
      fallbackReporter = fallbackFactory();
      const failure = classifyFeishuDocFailure(err);
      console.error(
        `progress_doc_fallback=enabled reason=${reason || failure.logReason} type=${failure.type}${failure.permissions.length ? ` permissions=${failure.permissions.join(',')}` : ''}${err ? ` ${describeFeishuApiError(err)}` : ''}`
      );
      await fallbackReporter.start();
      if (!fallbackNoticeSent && failure.userNotice) {
        fallbackNoticeSent = true;
        await sendTextReplySafe(client, chatID, failure.userNotice, 'progress_doc_fallback_notice');
      }
      for (const step of stepHistory) {
        fallbackReporter.push(step);
      }
    }
    return fallbackReporter;
  }

  async function ensureDoc() {
    if (documentID) return true;
    if (fallbackReporter) return false;

    try {
      const created = await client.docx.document.create({
        data: {
          title: `${progressDoc.titlePrefix || 'Codex 任务进度'} ${formatProgressTimestamp(startedAt)}`,
        },
      });
      documentID = String(created?.data?.document?.document_id || '').trim();
      ensure(documentID, 'progress doc create returned empty document_id');

      const initialBlocks = [
        ...buildDocTextBlocks(renderStatus('运行中')),
        buildDocHeadingBlock(2, '任务概览'),
        buildDocKeyValueBlock('开始时间', formatProgressTimestamp(startedAt)),
        ...(progressDoc.includeUserMessage
          ? [
            buildDocHeadingBlock(2, '用户消息'),
            ...buildDocTextBlocks(compactText(userText, 3000)),
          ]
          : []),
        buildDocHeadingBlock(2, '进度日志'),
        ...buildDocProgressEntryBlocks(makeDocProgressLineEntry(intro, startedAt)),
      ].filter(Boolean);
      const appended = await appendDocTextBlocks(client, documentID, initialBlocks);
      statusBlockID = String(appended?.[0]?.block_id || '').trim();
      lastStatusText = renderStatus('运行中');
      lastFlushAt = Date.now();

      if (progressDoc.shareToChat) {
        await shareDocWithChat(client, documentID, chatID);
      }
      await patchDocLinkScope(client, documentID, progressDoc.linkScope);
      documentURL = await queryDocURL(client, documentID);

      if (!linkAnnounced) {
        const linkText = documentURL
          ? `进度文档：${documentURL}\n后续过程会持续写入该文档。`
          : `进度文档已创建，文档 ID：${documentID}\n后续过程会持续写入该文档。`;
        const sentLinkMessageID = await sendTextReplyWithMessageIdSafe(client, chatID, linkText, 'progress_doc_link');
        if (sentLinkMessageID) {
          linkMessageID = sentLinkMessageID;
          linkAnnounced = true;
        }
      }
      return true;
    } catch (err) {
      console.error(`progress_doc_init=error chat_id=${chatID} ${describeFeishuApiError(err)}`);
      await activateFallback('doc_init_failed', err);
      return false;
    }
  }

  async function updateStatus(state) {
    if (!documentID || !statusBlockID) return false;
    const nextStatus = renderStatus(state);
    if (nextStatus === lastStatusText) return true;
    try {
      await patchDocTextBlock(client, documentID, statusBlockID, nextStatus);
      lastStatusText = nextStatus;
      return true;
    } catch (err) {
      console.error(`progress_doc_status=error document_id=${documentID} ${describeFeishuApiError(err)}`);
      await activateFallback('doc_status_failed', err);
      return false;
    }
  }

  async function flushPending(state = '运行中') {
    if (fallbackReporter) return true;
    const ok = await ensureDoc();
    if (!ok) return false;
    if (fallbackReporter) return true;

    await updateStatus(state);
    if (fallbackReporter) return true;

    if (pendingEntries.length > 0) {
      const entries = pendingEntries.splice(0, pendingEntries.length);
      try {
        const blocks = entries.flatMap((entry) => buildDocProgressEntryBlocks(entry));
        await appendDocTextBlocks(client, documentID, blocks);
      } catch (err) {
        console.error(`progress_doc_append=error document_id=${documentID} ${describeFeishuApiError(err)}`);
        await activateFallback('doc_append_failed', err);
        return false;
      }
    }

    lastFlushAt = Date.now();
    return true;
  }

  function scheduleFlush() {
    if (closed || fallbackReporter) return;
    if (flushTimer) return;
    const elapsed = Date.now() - lastFlushAt;
    const waitMs = Math.max(0, minInterval - elapsed);
    flushTimer = setTimeout(() => {
      flushTimer = null;
      if (closed || fallbackReporter) return;
      runSerial(async () => {
        await flushPending('运行中');
      });
    }, waitMs);
  }

  async function appendStandaloneLines(lines, state) {
    if (fallbackReporter) return true;
    for (const line of lines || []) {
      const entry = makeDocProgressLineEntry(line);
      if (entry) pendingEntries.push(entry);
    }
    return flushPending(state);
  }

  async function recallLinkMessage(reason = '') {
    if (!linkMessageID) return false;
    const target = linkMessageID;
    const recalled = await recallMessageSafe(client, target, 'progress_doc_link_recall');
    if (recalled) {
      linkMessageID = '';
      console.log(`progress_doc_link_recall=ok message_id=${target}${reason ? ` reason=${reason}` : ''}`);
    }
    return recalled;
  }

  return {
    async start() {
      await runSerial(async () => {
        const ok = await ensureDoc();
        if (!ok && fallbackReporter) return;
      });
    },
    push(stepText) {
      const { normalized, changed } = trackStep(stepText);
      if (!normalized || !changed) return;
      if (fallbackReporter) {
        fallbackReporter.push(normalized);
        return;
      }
      const entry = makeDocProgressLineEntry(normalized);
      if (!entry) return;
      queueEntries(entry, '运行中');
    },
    recordEvent(event) {
      if (closed) return;
      const formatted = formatCodexProgressEventForDoc(event);
      const { normalized: summary } = trackStep(formatted?.summary || '');
      if (fallbackReporter) {
        if (summary) fallbackReporter.push(summary);
        return;
      }

      let entry = null;
      if (formatted?.entry?.kind === 'detail') {
        entry = makeDocProgressDetailEntry(formatted.entry.title, {
          meta: formatted.entry.meta,
          sections: formatted.entry.sections,
          body: formatted.entry.body,
        });
      } else if (formatted?.entry?.kind === 'line') {
        entry = makeDocProgressLineEntry(formatted.entry.text || summary);
      } else if (summary) {
        entry = makeDocProgressLineEntry(summary);
      }
      if (!entry) return;
      queueEntries(entry, '运行中');
    },
    async finalizeReply(finalReplyText) {
      const reply = compactText(String(finalReplyText || '').trim(), 12000);
      if (!reply) return false;
      if (fallbackReporter) return false;
      return runSerial(async () => {
        return appendStandaloneLines(['最终回复：', reply], '已完成');
      });
    },
    async complete(note = '执行完成，回复见下条消息。') {
      if (closed) return false;
      closed = true;
      clearTimers();
      await queue.catch(() => {});

      if (fallbackReporter) {
        const ok = await fallbackReporter.complete(note);
        await recallLinkMessage('complete');
        return ok;
      }
      const ok = await runSerial(async () => {
        const ok = await appendStandaloneLines([normalizeProgressSnippet(note, 200) || '执行完成。'], '已完成');
        if (!ok && fallbackReporter) {
          return fallbackReporter.complete(note);
        }
        return ok;
      });
      await recallLinkMessage('complete');
      return ok;
    },
    async fail(note = '处理失败。') {
      if (closed) return false;
      closed = true;
      clearTimers();
      await queue.catch(() => {});

      if (fallbackReporter) {
        const ok = await fallbackReporter.fail(note);
        await recallLinkMessage('fail');
        return ok;
      }
      const ok = await runSerial(async () => {
        const ok = await appendStandaloneLines([normalizeProgressSnippet(note, 200) || '处理失败。'], '失败');
        if (!ok && fallbackReporter) {
          return fallbackReporter.fail(note);
        }
        return ok;
      });
      await recallLinkMessage('fail');
      return ok;
    },
    async recordFinalReply(finalReplyText) {
      if (!progressDoc.writeFinalReply) return false;
      const reply = String(finalReplyText || '').trim();
      if (!reply) return false;
      if (fallbackReporter) return false;
      const entry = makeDocProgressDetailEntry('最终回复', {
        sections: [
          { label: '回复正文', content: reply, format: 'text' },
        ],
      });
      return runSerial(async () => {
        if (entry) queueEntries(entry, '已完成');
        return flushPending('已完成');
      });
    },
    async abort() {
      closed = true;
      clearTimers();
      await queue.catch(() => {});
      if (fallbackReporter && typeof fallbackReporter.abort === 'function') {
        await fallbackReporter.abort();
      }
      await recallLinkMessage('abort');
      return true;
    },
  };
}

function createProgressReporter({
  client,
  chatID,
  initialMessage,
  userText = '',
  progressConfig = {},
  minUpdateIntervalMs = 700,
}) {
  return createDocProgressReporter({
    client,
    chatID,
    initialMessage,
    userText,
    progressConfig,
    minUpdateIntervalMs: Math.max(2000, minUpdateIntervalMs),
    fallbackFactory: () => createSilentProgressReporter(),
  });
}

async function downloadImageToDownloads(client, {
  accountName = '',
  workspaceDir = '',
  messageID = '',
  imageKey = '',
  fileName = '',
} = {}) {
  const resource = await client.im.v1.messageResource.get({
    params: {
      type: 'image',
    },
    path: {
      message_id: messageID,
      file_key: imageKey,
    },
  });
  const dirPath = buildIncomingAttachmentDir(workspaceDir, accountName, 'image', messageID);
  fs.mkdirSync(dirPath, { recursive: true });
  const ext = inferExtensionFromHeaders(resource.headers, '.jpg');
  const preferredName = fileName
    ? `${path.basename(String(fileName || '').trim(), path.extname(String(fileName || '').trim())) || 'image'}${ext}`
    : `image-${messageID || Date.now()}${ext}`;
  const { filePath, fileName: storedFileName } = buildUniqueFilePath(
    dirPath,
    preferredName,
    `image-${Date.now()}${ext}`
  );
  await resource.writeFile(filePath);
  return {
    filePath,
    fileName: storedFileName,
    relativePath: formatDownloadRelativePath(filePath),
  };
}

async function getMessageItemSafe(client, messageID, logTag = 'message_get') {
  const target = String(messageID || '').trim();
  if (!target) return null;
  try {
    const response = await client.im.v1.message.get({
      params: {
        user_id_type: 'open_id',
      },
      path: {
        message_id: target,
      },
    });
    const items = Array.isArray(response?.data?.items) ? response.data.items : [];
    return items[0] || null;
  } catch (err) {
    console.error(`${logTag}=error message_id=${target} message=${err.message}`);
    return null;
  }
}

async function fetchRecentMessagesFromChat(client, {
  chatID = '',
  limit = FEISHU_CROSS_CHAT_MESSAGE_LIMIT,
} = {}) {
  const targetChatID = String(chatID || '').trim();
  if (!client || !targetChatID) return [];
  const response = await client.im.v1.message.list({
    params: {
      container_id_type: 'chat',
      container_id: targetChatID,
      sort_type: 'ByCreateTimeDesc',
      page_size: Math.max(1, Math.min(20, Number(limit) || FEISHU_CROSS_CHAT_MESSAGE_LIMIT)),
    },
  });
  return Array.isArray(response?.data?.items) ? response.data.items : [];
}

async function downloadFileToDownloads(client, {
  accountName = '',
  workspaceDir = '',
  messageID = '',
  fileKey = '',
  fileName = '',
} = {}) {
  const resource = await client.im.v1.messageResource.get({
    params: {
      type: 'file',
    },
    path: {
      message_id: messageID,
      file_key: fileKey,
    },
  });
  const dirPath = buildIncomingAttachmentDir(workspaceDir, accountName, 'file', messageID);
  fs.mkdirSync(dirPath, { recursive: true });
  const fallbackExt = inferExtensionFromHeaders(resource.headers, path.extname(fileName || '') || '.bin');
  const { filePath, fileName: storedFileName } = buildUniqueFilePath(
    dirPath,
    fileName || `attachment-${messageID || Date.now()}${fallbackExt}`,
    `attachment-${Date.now()}${fallbackExt}`
  );
  await resource.writeFile(filePath);
  return {
    filePath,
    fileName: storedFileName,
    relativePath: formatDownloadRelativePath(filePath),
  };
}

async function downloadAudioToTempFile(client, messageID, fileKey) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-audio-'));
  const resource = await client.im.v1.messageResource.get({
    params: {
      type: 'audio',
    },
    path: {
      message_id: messageID,
      file_key: fileKey,
    },
  });
  const ext = inferExtensionFromHeaders(resource.headers, '.opus');
  const filePath = path.join(
    tempDir,
    `voice-${Date.now()}-${Math.random().toString(16).slice(2)}${ext}`
  );
  await resource.writeFile(filePath);
  return { tempDir, filePath, extension: ext };
}

async function sendTextReplyWithFakeStream(client, chatID, text, fakeStream) {
  const finalText = String(text || '').trim();
  if (!finalText) return;

  if (!fakeStream?.enabled) {
    await sendTextReply(client, chatID, finalText);
    return;
  }

  if (finalText.length <= 1) {
    await sendTextReply(client, chatID, finalText);
    return;
  }

  const effectiveStep = Math.max(
    1,
    Math.max(fakeStream.chunkChars || 1, Math.ceil(finalText.length / Math.max(fakeStream.maxUpdates || 1, 1)))
  );

  const firstChunk = finalText.slice(0, effectiveStep);
  const created = await sendTextReply(client, chatID, firstChunk);
  const messageID = String(created?.data?.message_id || '').trim();
  if (!messageID) return;

  for (let i = effectiveStep; i < finalText.length; i += effectiveStep) {
    const next = finalText.slice(0, Math.min(finalText.length, i + effectiveStep));
    await sleep(fakeStream.intervalMs || 120);
    try {
      await updateTextMessage(client, messageID, next);
    } catch (err) {
      console.error(`fake_stream_update=error message_id=${messageID} message=${err.message}`);
      break;
    }
  }
}

async function addTypingIndicatorSafe(client, messageID, emoji = 'Typing') {
  try {
    const response = await client.im.v1.messageReaction.create({
      path: { message_id: messageID },
      data: {
        reaction_type: { emoji_type: emoji },
      },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const reactionID = response?.data?.reaction_id || null;
    return { messageID, reactionID };
  } catch (err) {
    console.error(`typing_add=error message_id=${messageID} message=${err.message}`);
    return { messageID, reactionID: null };
  }
}

async function removeTypingIndicatorSafe(client, state) {
  if (!state || !state.messageID || !state.reactionID) return;
  try {
    await client.im.v1.messageReaction.delete({
      path: {
        message_id: state.messageID,
        reaction_id: state.reactionID,
      },
    });
  } catch (err) {
    console.error(`typing_remove=error message_id=${state.messageID} message=${err.message}`);
  }
}

function enqueueByChat(chatQueues, chatID, task) {
  const prev = chatQueues.get(chatID) || Promise.resolve();
  const next = prev
    .catch(() => {})
    .then(task)
    .catch((err) => {
      console.error(`chat_queue_error chat_id=${chatID} message=${err.message}`);
    })
    .finally(() => {
      if (chatQueues.get(chatID) === next) chatQueues.delete(chatID);
    });
  chatQueues.set(chatID, next);
}

function createChatTaskControl(taskKey) {
  let cancelled = false;
  let cancelReason = '';
  let codexChild = null;
  let killTimer = null;
  const cancelHooks = [];

  function killCodexChild() {
    if (!codexChild) return;
    try {
      if (codexChild.exitCode === null && !codexChild.killed) {
        codexChild.kill('SIGTERM');
      }
    } catch (_) {
      // ignore kill errors
    }
    if (!killTimer) {
      killTimer = setTimeout(() => {
        try {
          if (codexChild && codexChild.exitCode === null && !codexChild.killed) {
            codexChild.kill('SIGKILL');
          }
        } catch (_) {
          // ignore kill errors
        }
      }, 1500);
      if (typeof killTimer.unref === 'function') killTimer.unref();
    }
  }

  return {
    taskKey,
    get cancelReason() {
      return cancelReason;
    },
    isCancelled() {
      return cancelled;
    },
    throwIfCancelled() {
      if (cancelled) throw makeTaskCancelledError(cancelReason);
    },
    onCancel(hook) {
      if (typeof hook !== 'function') return;
      cancelHooks.push(hook);
      if (cancelled) {
        Promise.resolve()
          .then(() => hook(cancelReason))
          .catch((err) => {
            console.error(`task_cancel_hook=error task_key=${taskKey} message=${err.message}`);
          });
      }
    },
    attachCodexChild(child) {
      codexChild = child || null;
      if (cancelled) {
        killCodexChild();
      }
      if (codexChild) {
        codexChild.once('close', () => {
          if (killTimer) {
            clearTimeout(killTimer);
            killTimer = null;
          }
        });
      }
    },
    async cancel(reason = 'superseded') {
      if (cancelled) return false;
      cancelled = true;
      cancelReason = String(reason || 'cancelled');
      killCodexChild();
      await Promise.allSettled(
        cancelHooks.map((hook) => Promise.resolve().then(() => hook(cancelReason)))
      );
      return true;
    },
  };
}

function dispatchLatestByChat(chatRunners, taskKey, data, handler, options = {}) {
  const shouldSupersede = typeof options.shouldSupersede === 'function'
    ? options.shouldSupersede
    : () => true;
  let runner = chatRunners.get(taskKey);
  if (!runner) {
    runner = {
      activeTask: null,
      pendingQueue: [],
      draining: false,
    };
    chatRunners.set(taskKey, runner);
  }

  if (runner.activeTask) {
    if (shouldSupersede(runner.activeTask, data)) {
      runner.pendingQueue = [data];
      console.log(`chat_task_supersede task_key=${taskKey}`);
      void runner.activeTask.cancel('superseded_by_new_message');
    } else {
      runner.pendingQueue.push(data);
      console.log(`chat_task_queue task_key=${taskKey}`);
    }
    return;
  }

  runner.pendingQueue.push(data);
  if (runner.draining) return;

  runner.draining = true;
  void (async () => {
    try {
      while (runner.pendingQueue.length > 0) {
        const nextData = runner.pendingQueue.shift();
        const taskControl = createChatTaskControl(taskKey);
        runner.activeTask = taskControl;
        try {
          await handler(nextData, taskControl);
        } catch (err) {
          if (!isTaskCancelledError(err)) {
            console.error(`chat_task_error task_key=${taskKey} message=${err.message}`);
          }
        } finally {
          runner.activeTask = null;
        }
      }
    } finally {
      runner.draining = false;
      if (!runner.activeTask && runner.pendingQueue.length === 0) {
        chatRunners.delete(taskKey);
      }
    }
  })();
}

async function main() {
  ensure(lark, 'missing dependency @larksuiteoapi/node-sdk; run: npm install');
  const talkNormalPrompt = loadTalkNormalPromptMeta();

  const account = (getArg('--account', '') || process.env.FEISHU_ACCOUNT || 'default').trim();
  const configDir = path.resolve(getArg('--config-dir', path.resolve(__dirname, '..', 'config', 'feishu')));
  const { accountName, config, configPath } = loadFeishuConfig(account, configDir);

  const dryRunValue = getArg('--dry-run', '');
  const dryRun = process.argv.includes('--dry-run') || asBool(dryRunValue, false);

  const domainInput = (getArg('--domain', '') || process.env.FEISHU_DOMAIN || config.domain || 'feishu').trim();
  const domain = resolveDomain(domainInput);
  const autoReply = asBool(getArg('--auto-reply', process.env.FEISHU_AUTO_REPLY || config.auto_reply), true);
  const ignoreSelf = asBool(getArg('--ignore-self', process.env.FEISHU_IGNORE_SELF_MESSAGES || config.ignore_self_messages), true);
  const botName = String(getArg('--bot-name', process.env.FEISHU_BOT_NAME || config.bot_name || '')).trim();
  const replyPrefix = getArg('--reply-prefix', process.env.FEISHU_REPLY_PREFIX || config.reply_prefix || '');
  const replyMode = resolveReplyMode(config);
  const progress = resolveProgressConfig(config);
  const typing = resolveTypingConfig(config);
  const mentionConfig = resolveMentionConfig(config);
  const fakeStream = resolveFakeStreamConfig(config);
  const personalProxy = resolvePersonalProxyConfig(config, accountName);
  const workspace = resolveFeishuWorkspaceConfig(config, accountName);

  const creds = resolveCredentials(config);
  const codex = resolveCodexConfig(config);
  const localModel = resolveLocalModelConfig(config);
  const memory = resolveMemoryConfig(config);
  const speech = resolveSpeechConfig(config, codex);
  const dailyReport = resolveDailyStoreReportConfig(config, accountName);
  const codexDetect = detectCodex(codex.bin);
  const localModelDetect = detectLocalModel(localModel);
  const activeSystemPrompt = replyMode === 'local_model' ? localModel.systemPrompt : codex.systemPrompt;
  const mentionAliases = resolveMentionAliases({
    botName,
    explicitAliases: config.mention_aliases,
    replyPrefix,
    systemPrompt: activeSystemPrompt,
    progressTitlePrefix: progress.doc.titlePrefix,
  });

  if (dryRun) {
    console.log('FEISHU_WS_DRY_RUN');
    console.log(`account=${accountName}`);
    if (configPath) console.log(`config=${configPath}`);
    console.log(`domain=${domain.label}`);
    console.log(`app_id_found=${creds.appId.value ? 'true' : 'false'}`);
    if (creds.appId.source) console.log(`app_id_source=${creds.appId.source}`);
    console.log(`app_secret_found=${creds.appSecret.value ? 'true' : 'false'}`);
    if (creds.appSecret.source) console.log(`app_secret_source=${creds.appSecret.source}`);
    console.log(`encrypt_key_found=${creds.encryptKey.value ? 'true' : 'false'}`);
    if (creds.encryptKey.source) console.log(`encrypt_key_source=${creds.encryptKey.source}`);
    console.log(`verification_token_found=${creds.verificationToken.value ? 'true' : 'false'}`);
    if (creds.verificationToken.source) console.log(`verification_token_source=${creds.verificationToken.source}`);
    console.log(`bot_open_id_found=${creds.botOpenId.value ? 'true' : 'false'}`);
    if (creds.botOpenId.source) console.log(`bot_open_id_source=${creds.botOpenId.source}`);
    console.log(`bot_open_id_autodetect=${mentionConfig.requireMention ? 'enabled' : 'not_needed'}`);
    console.log(`auto_reply=${autoReply ? 'true' : 'false'}`);
    console.log(`ignore_self=${ignoreSelf ? 'true' : 'false'}`);
    console.log(`bot_name=${botName || '(none)'}`);
    console.log(`require_mention=${mentionConfig.requireMention ? 'true' : 'false'}`);
    console.log(`require_mention_group_only=${mentionConfig.groupOnly ? 'true' : 'false'}`);
    console.log(`mention_aliases=${mentionAliases.length > 0 ? mentionAliases.join(' | ') : '(none)'}`);
    console.log(`reply_mode=${replyMode}`);
    console.log(`reply_prefix=${String(replyPrefix)}`);
    console.log(`workspace_dir=${workspace.dir}`);
    console.log(`workspace_incoming_dir=${workspace.incomingDir}`);
    console.log(`workspace_output_dir=${workspace.outputDir}`);
    console.log(`workspace_temp_dir=${workspace.tempDir}`);
    console.log(`typing_indicator=${typing.enabled ? 'true' : 'false'}`);
    console.log(`typing_emoji=${typing.emoji}`);
    console.log(`fake_stream=${fakeStream.enabled ? 'true' : 'false'}`);
    console.log(`fake_stream_interval_ms=${fakeStream.intervalMs}`);
    console.log(`fake_stream_chunk_chars=${fakeStream.chunkChars}`);
    console.log(`fake_stream_max_updates=${fakeStream.maxUpdates}`);
    const personalProxyOwner = personalProxy.enabled ? readPersonalProxyOwner(accountName) : {};
    const personalProxyPending = personalProxy.enabled
      ? prunePersonalProxyPendingStore(accountName, readPersonalProxyPendingStore(accountName))
      : { requests: {} };
    console.log(`personal_proxy_enabled=${personalProxy.enabled ? 'true' : 'false'}`);
    console.log(`personal_proxy_owner_bound=${isPersonalProxyOwnerBound(personalProxyOwner) ? 'true' : 'false'}`);
    console.log(`personal_proxy_owner_bind_command=${personalProxy.ownerBindCommand}`);
    console.log(`personal_proxy_sensitivity_mode=${personalProxy.sensitivityMode}`);
    console.log(`personal_proxy_approval_ttl_minutes=${personalProxy.approvalTtlMinutes}`);
    console.log(`personal_proxy_pending=${Object.keys(personalProxyPending.requests || {}).length}`);
    console.log(`progress_notice=${progress.enabled ? 'true' : 'false'}`);
    console.log(`progress_message=${progress.message}`);
    console.log(`progress_mode=${progress.mode}`);
    if (progress.mode === 'doc') {
      console.log(`progress_doc_title_prefix=${progress.doc.titlePrefix}`);
      console.log(`progress_doc_share_to_chat=${progress.doc.shareToChat ? 'true' : 'false'}`);
      console.log(`progress_doc_link_scope=${progress.doc.linkScope}`);
      console.log(`progress_doc_include_user_message=${progress.doc.includeUserMessage ? 'true' : 'false'}`);
      console.log(`progress_doc_write_final_reply=${progress.doc.writeFinalReply ? 'true' : 'false'}`);
    }
    console.log(`codex_bin=${codex.bin}`);
    console.log(`codex_found=${codexDetect.found ? 'true' : 'false'}`);
    if (codexDetect.version) console.log(`codex_version=${codexDetect.version}`);
    console.log(`codex_api_key_found=${codex.apiKey ? 'true' : 'false'}`);
    if (codex.apiKeySource) console.log(`codex_api_key_source=${codex.apiKeySource}`);
    console.log(`codex_model=${codex.model || '(default)'}`);
    console.log(`codex_reasoning_effort=${codex.reasoningEffort || '(default)'}`);
    printCodexModelRouteConfig(codex);
    console.log(`codex_profile=${codex.profile || '(default)'}`);
    console.log(`codex_home=${codex.home || process.env.CODEX_HOME || path.join(os.homedir(), '.codex')}`);
    if (codex.runtimeProvider?.provider) console.log(`codex_provider=${codex.runtimeProvider.provider}`);
    if (codex.runtimeProvider?.providerName) console.log(`codex_provider_name=${codex.runtimeProvider.providerName}`);
    if (codex.runtimeProvider?.providerBaseUrl) console.log(`codex_provider_base_url=${codex.runtimeProvider.providerBaseUrl}`);
    if (codex.homeProviderSync) {
      console.log(`codex_home_provider_sync=${codex.homeProviderSync.reason || (codex.homeProviderSync.changed ? 'synced' : 'unknown')}`);
    }
    if (codex.homeAuthSync) {
      console.log(`codex_home_auth_sync=${codex.homeAuthSync.reason || (codex.homeAuthSync.changed ? 'synced' : 'unknown')}`);
    }
    console.log(`codex_cwd=${codex.cwd || process.cwd()}`);
    console.log(`codex_add_dirs=${codex.addDirs.length > 0 ? codex.addDirs.join(' | ') : '(none)'}`);
    console.log(`codex_sandbox=${codex.sandbox}`);
    console.log(`codex_approval_policy=${codex.approvalPolicy}`);
    console.log(`codex_bypass_sandbox=${shouldBypassCodexSandbox(codex.sandbox, codex.approvalPolicy) ? 'true' : 'false'}`);
    console.log(`codex_timeout_sec=${codex.timeoutSec || '(disabled)'}`);
    console.log(`codex_history_turns=${codex.historyTurns}`);
    console.log(`local_model_cwd=${localModel.cwd || '(missing)'}`);
    console.log(`local_model_cwd_found=${localModelDetect.cwdFound ? 'true' : 'false'}`);
    console.log(`local_model_server_base_url=${localModel.serverBaseUrl || '(none)'}`);
    console.log(`local_model_server_configured=${localModelDetect.serverConfigured ? 'true' : 'false'}`);
    console.log(`local_model_prompt_script=${localModel.promptScript || '(missing)'}`);
    console.log(`local_model_prompt_script_found=${localModelDetect.promptScriptFound ? 'true' : 'false'}`);
    console.log(`local_model_ready=${localModelDetect.ready ? 'true' : 'false'}`);
    console.log(`local_model_model=${localModel.model || '(script default)'}`);
    console.log(`local_model_max_kv_size=${localModel.maxKvSize}`);
    console.log(`local_model_max_tokens=${localModel.maxTokens}`);
    console.log(`local_model_temp=${localModel.temp}`);
    console.log(`local_model_request_timeout_ms=${localModel.requestTimeoutMs}`);
    console.log(`local_model_history_turns=${localModel.historyTurns}`);
    console.log(`memory_enabled=${memory.enabled ? 'true' : 'false'}`);
    console.log(`memory_role_memory_chars=${memory.roleMemory.length}`);
    if (memory.enabled) console.log(`memory_store=${botMemoryStorePath(accountName)}`);
    console.log(`speech_enabled=${speech.enabled ? 'true' : 'false'}`);
    console.log(`speech_api_key_found=${speech.apiKey ? 'true' : 'false'}`);
    if (speech.apiKeySource) console.log(`speech_api_key_source=${speech.apiKeySource}`);
    console.log(`speech_model=${speech.model}`);
    console.log(`speech_language=${speech.language || '(auto)'}`);
    console.log(`speech_base_url=${speech.baseURL}`);
    console.log(`speech_ffmpeg_bin=${speech.ffmpegBin || '(not found)'}`);
    if (speech.ffmpegVersion) console.log(`speech_ffmpeg_version=${speech.ffmpegVersion}`);
    console.log(`daily_report_enabled=${dailyReport.enabled ? 'true' : 'false'}`);
    if (dailyReport.enabled) {
      console.log(`daily_report_chat_id=${dailyReport.chatId || '(missing)'}`);
      console.log(`daily_report_schedule=${dailyReport.schedule.label}`);
      console.log(`daily_report_timezone=${dailyReport.timeZone}`);
      console.log(`daily_report_store_base_url=${dailyReport.store.baseUrl || '(missing)'}`);
      console.log(`daily_report_store_email=${dailyReport.store.email || '(missing)'}`);
      console.log(`daily_report_store_password_found=${dailyReport.store.password ? 'true' : 'false'}`);
    }
    return;
  }

  ensure(creds.appId.value, `feishu app_id not found for account "${accountName}"`);
  ensure(creds.appSecret.value, `feishu app_secret not found for account "${accountName}"`);
  if (replyMode === 'codex') {
    ensure(codexDetect.found, `codex binary not found: ${codex.bin}`);
  }
  if (replyMode === 'local_model') {
    ensure(localModelDetect.cwdFound, `local model cwd not found: ${localModel.cwd || '(missing)'}`);
    ensure(localModelDetect.promptScriptFound, `local model prompt script not found: ${localModel.promptScript || '(missing)'}`);
  }
  ensureFeishuWorkspaceDirs(workspace);

  const baseConfig = {
    appId: creds.appId.value,
    appSecret: creds.appSecret.value,
    domain: domain.value,
  };
  const client = new lark.Client(baseConfig);
  const busyTargetCounts = new Map();
  const scheduledJobManager = createScheduledJobManager({
    accountName,
    runtimeDir: FEISHU_RUNTIME_DIR,
    config,
    codex,
    feishuDomain: domain.label,
    feishuCreds: {
      appId: creds.appId.value,
      appSecret: creds.appSecret.value,
      botOpenId: creds.botOpenId.value,
    },
    log: (line) => {
      console.log(line);
    },
    intentJudge: async (payload) => {
      return judgeScheduledTaskIntentWithCodex(codex, payload);
    },
    isTargetBusy: (task) => {
      const keys = buildBusyTargetKeysFromTaskTarget(task);
      return keys.some((key) => Number(busyTargetCounts.get(key) || 0) > 0);
    },
  });
  scheduledJobManager.start();

  const chatStates = new Map();
  const actorChatIndex = new Map();
  const chatRunners = new Map();
  const recentTextInputs = new Map();
  const recentAttachmentInputs = new Map();

  function dispatchApprovedPersonalProxyRequest(request, decision = 'approve_once') {
    const approvedPayload = clonePlainObject(request?.payload || {});
    approvedPayload.dispatchMeta = {
      ...(approvedPayload.dispatchMeta || {}),
      personalProxyApproved: true,
      personalProxyApprovalID: normalizeString(request?.approval_id),
      personalProxyApprovalDecision: normalizeString(decision),
    };
    const taskKey = normalizeString(request?.task_key)
      || normalizeString(approvedPayload.dispatchMeta.taskKey)
      || normalizeString(request?.chat_id)
      || normalizeString(request?.message_id)
      || 'personal_proxy_approved';
    dispatchLatestByChat(
      chatRunners,
      taskKey,
      approvedPayload,
      handleMessageEvent,
      {
        shouldSupersede: () => false,
      }
    );
    console.log(`personal_proxy_approved_dispatch approval_id=${request?.approval_id || '(unknown)'} task_key=${taskKey}`);
  }

  async function handleMessageEvent(data, taskControl = createChatTaskControl('')) {
    const eventData = data?.eventData || data || {};
    const dispatchMeta = data?.dispatchMeta || {};
    const senderIdentity = extractEventSenderIdentity(eventData);
    const senderOpenID = senderIdentity.openId || '';
    const senderType = senderIdentity.senderType || '';
    const message = eventData?.message || {};
    const chatID = message.chat_id || '';
    const chatType = String(message.chat_type || '').trim().toLowerCase();
    const messageID = message.message_id || '';
    const rootID = message.root_id || '';
    const parentID = message.parent_id || '';
    const messageThreadID = message.thread_id || '';
    const messageType = message.message_type || '';
    const mentions = Array.isArray(message.mentions) ? message.mentions : [];
    const parsedText = messageType === 'text' ? parseMessageText(message.content || '') : '';
    const parsedFile = messageType === 'file'
      ? parseFileMessageContent(message.content || '')
      : { fileKey: '', fileName: '', fileSize: 0, text: '' };
    const parsedAudio = messageType === 'audio' ? parseAudioMessageContent(message.content || '') : { fileKey: '', durationMs: 0 };
    const parsedPost = messageType === 'post'
      ? parsePostContent(message.content || '')
      : { text: '', imageKeys: [], fileAttachments: [] };
    const normalizedMessageText = messageType === 'post' ? parsedPost.text : parsedText;
    const textMentionAlias = detectTextualBotMention(normalizedMessageText, mentionAliases);
    const mentionMatchedByText = Boolean(textMentionAlias);
    const conversationScope = buildConversationScope(chatID, chatType, senderIdentity, messageID);
    const mentionCandidate = mentions.length > 0
      ? reconcileBotOpenIdFromMentions({
        accountName,
        creds,
        mentions,
        mentionAliases,
      })
      : null;
    const mentionMatchedByMentionName = Boolean(mentionCandidate);
    const botMentioned = isBotMentioned(mentions, creds.botOpenId.value);
    const text = normalizeIncomingText(normalizedMessageText, mentions, mentionAliases);
    const now = Date.now();
    const imageKeys = [];
    if (messageType === 'image') {
      const imageKey = parseImageKey(message.content || '');
      if (imageKey) imageKeys.push(imageKey);
    }
    if (messageType === 'post' && Array.isArray(parsedPost.imageKeys)) {
      imageKeys.push(...parsedPost.imageKeys);
    }
    const normalizedImageKeys = uniqueStrings(imageKeys);
    const groupChat = isGroupChat(chatType);
    const mentionMatchedByCarry = Boolean(dispatchMeta.allowMentionCarry);

    console.log('FEISHU_EVENT');
    console.log('event=im.message.receive_v1');
    console.log(`chat_id=${chatID}`);
    console.log(`chat_type=${chatType || '(unknown)'}`);
    if (conversationScope.key) {
      console.log(`chat_scope=${conversationScope.key}`);
      console.log(`chat_scope_kind=${conversationScope.kind}`);
      if (conversationScope.actorKey) {
        console.log(`chat_scope_actor=${conversationScope.actorKey}`);
      }
    }
    console.log(`message_id=${messageID}`);
    console.log(`message_type=${messageType}`);
    console.log(`sender_type=${senderType}`);
    if (mentionMatchedByMentionName && !botMentioned) {
      console.log(`mention_fallback=mention_name alias=${mentionCandidate?.name || '(unknown)'}`);
    }
    if (mentionMatchedByText && !botMentioned) {
      console.log(`mention_fallback=text_alias alias=${textMentionAlias}`);
    }
    if (mentionMatchedByCarry) {
      console.log(`mention_fallback=recent_text_pair message_id=${dispatchMeta.recentTextMessageID || '(unknown)'}`);
    }

    if (!chatID) {
      console.log('skip_reason=missing_chat_id');
      return;
    }
    if (ignoreSelf && senderType && senderType !== 'user') {
      console.log('skip_reason=non_user_sender');
      return;
    }
    if (ignoreSelf && senderOpenID && creds.botOpenId.value && senderOpenID === creds.botOpenId.value) {
      console.log('skip_reason=self_open_id');
      return;
    }
    if (!autoReply) {
      console.log('skip_reason=auto_reply_disabled');
      return;
    }
    if (messageType !== 'text' && messageType !== 'image' && messageType !== 'post' && messageType !== 'file' && messageType !== 'audio') {
      console.log('skip_reason=unsupported_message_type');
      return;
    }
    const mentionRequired = dispatchMeta.mentionRequired !== false;
    const mentionGateActive = mentionConfig.requireMention && mentionRequired && (!mentionConfig.groupOnly || groupChat);
    if (mentionGateActive && !botMentioned && !mentionMatchedByMentionName && !mentionMatchedByText && !mentionMatchedByCarry) {
      console.log('skip_reason=require_mention_not_met');
      console.log(`mention_count=${mentions.length}`);
      console.log(`text_has_at=${/[@＠]/.test(String(normalizedMessageText || '')) ? 'true' : 'false'}`);
      return;
    }
    const incomingText = compactText(text, 4000).trim();
    if (messageType === 'text') {
      const crossChatCommand = parseCrossChatCommand(incomingText);
      if (crossChatCommand) {
        const result = await handleCrossChatCommand(client, {
          accountName,
          currentChatID: chatID,
          command: crossChatCommand,
        });
        if (result.handled) {
          await sendRenderedReply(client, chatID, result.reply, {
            logTag: 'cross_chat_reply',
            preferMarkdown: false,
          });
          console.log(`reply=ok mode=cross_chat_command target=${result.targetChatID || '(none)'}`);
          return;
        }
      }
    }
    const quotedMessageIDsFromEvent = extractQuotedMessageIdsFromRawContent(message.content || '');
    const fallbackQuotedParentID = parentID && (!messageThreadID || parentID !== rootID) ? parentID : '';
    const currentMessageItem = (quotedMessageIDsFromEvent.length > 0 || fallbackQuotedParentID)
      ? await getMessageItemSafe(client, messageID, 'current_message_get')
      : null;
    const quotedMessageID = uniqueStrings([
      ...quotedMessageIDsFromEvent,
      ...extractQuotedMessageIdsFromRawContent(currentMessageItem?.body?.content || ''),
      String(currentMessageItem?.upper_message_id || '').trim(),
      String(fallbackQuotedParentID || '').trim(),
    ]).filter((id) => id && id !== messageID)[0] || '';
    const quotedMessageItem = quotedMessageID
      ? await getMessageItemSafe(client, quotedMessageID, 'quoted_message_get')
      : null;
    const quotedMessageContext = quotedMessageItem
      ? buildQuotedMessageContextBlock(quotedMessageItem)
      : { promptText: '', historyText: '' };

    const currentAttachmentBundle = extractAttachmentBundleFromMessage({
      messageType,
      rawContent: message.content || '',
      messageID,
      mentions,
      mentionAliases,
      timestamp: now,
    });
    if (messageType === 'file' && !hasAttachmentBundleContent(currentAttachmentBundle)) {
      console.log('skip_reason=missing_file_key');
      await sendTextReplySafe(client, chatID, '文件接收失败，请重新发送。', 'file_download_reply');
      return;
    }
    if (messageType === 'image' && !hasAttachmentBundleContent(currentAttachmentBundle)) {
      console.log('skip_reason=missing_image_key');
      await sendTextReplySafe(client, chatID, '图片接收失败，请重新发送。', 'image_download_reply');
      return;
    }
    if (messageType === 'audio' && !hasAttachmentBundleContent(currentAttachmentBundle)) {
      console.log('skip_reason=missing_audio_key');
      await sendTextReplySafe(client, chatID, '语音接收失败，请重新发送。', 'audio_download_reply');
      return;
    }
    const quotedAttachmentBundle = quotedMessageItem
      ? extractAttachmentBundleFromMessageItem(quotedMessageItem, { mentionAliases, timestamp: now })
      : null;
    const recentAttachmentBundle = dispatchMeta.allowAttachmentCarry
      ? dispatchMeta.recentAttachments || null
      : null;
    let historyAttachmentBundle = null;
    let attachmentSelection = selectAttachmentSource({
      currentAttachmentBundle,
      quotedAttachmentBundle,
      recentAttachmentBundle,
    });
    if (!attachmentSelection.source && messageType === 'text' && groupChat) {
      historyAttachmentBundle = await fetchRecentAttachmentBundleFromChatHistory(client, {
        chatID,
        currentMessageID: messageID,
        currentMessageItem,
        currentSenderIdentity: senderIdentity,
        mentionAliases,
        logTag: 'attachment_history_lookup',
      });
      attachmentSelection = selectAttachmentSource({
        currentAttachmentBundle,
        quotedAttachmentBundle,
        recentAttachmentBundle,
        historyAttachmentBundle,
      });
    }

    const tempPathsToCleanup = [];
    const imageAttachments = [];
    const imagePaths = [];
    const fileAttachments = [];
    const audioTranscripts = [];
    const incomingAttachmentFacts = [];
    let userText = '';
    let historyUserText = '';
    let usedRecentTextCarry = false;
    let usedRecentAttachmentCarry = false;
    let consumeCurrentAttachmentCarry = false;

    const carriedText = dispatchMeta.allowTextCarry
      ? compactText(String(dispatchMeta.recentText || ''), 4000).trim()
      : '';
    const selectedAttachmentBundle = attachmentSelection.bundle;
    const attachmentSource = attachmentSelection.source;
    if (attachmentSource) {
      console.log(`attachment_source=${attachmentSource}`);
      if (Array.isArray(selectedAttachmentBundle?.sourceMessageIDs) && selectedAttachmentBundle.sourceMessageIDs.length > 0) {
        console.log(`attachment_source_message_ids=${selectedAttachmentBundle.sourceMessageIDs.join(',')}`);
      }
    }

    const fileDescriptors = Array.isArray(selectedAttachmentBundle?.fileItems)
      ? selectedAttachmentBundle.fileItems
      : [];
    const imageDescriptorCandidates = Array.isArray(selectedAttachmentBundle?.imageItems)
      ? selectedAttachmentBundle.imageItems
      : [];
    const audioDescriptors = Array.isArray(selectedAttachmentBundle?.audioItems)
      ? selectedAttachmentBundle.audioItems
      : [];
    const attachmentTextParts = Array.isArray(selectedAttachmentBundle?.textSegments)
      ? selectedAttachmentBundle.textSegments
      : [];

    const imageDescriptors = [];
    const seenImageDescriptors = new Set();
    for (const descriptor of imageDescriptorCandidates) {
      const sourceMessageID = String(descriptor?.messageID || '').trim();
      const imageKey = String(descriptor?.imageKey || '').trim();
      const dedupeKey = `${sourceMessageID}:${imageKey}`;
      if (!sourceMessageID || !imageKey || seenImageDescriptors.has(dedupeKey)) continue;
      seenImageDescriptors.add(dedupeKey);
      imageDescriptors.push({ messageID: sourceMessageID, imageKey });
    }

    let attachmentFailureReply = '';

    if (fileDescriptors.length > 0) {
      for (const descriptor of fileDescriptors) {
        try {
          const downloaded = await downloadFileToDownloads(client, {
            accountName,
            workspaceDir: workspace.dir,
            messageID: descriptor.messageID,
            fileKey: descriptor.fileKey,
            fileName: descriptor.fileName,
          });
          fileAttachments.push({
            fileName: downloaded.fileName,
            filePath: downloaded.filePath,
            relativePath: downloaded.relativePath,
            fileSize: Number(descriptor.fileSize) || 0,
          });
          incomingAttachmentFacts.push(`已接收文件：${downloaded.fileName}，保存在 ${downloaded.relativePath}`);
        } catch (err) {
          console.error(
            `file_download=error source=${attachmentSource || 'current_message_attachment'} message_id=${descriptor.messageID} key=${descriptor.fileKey} message=${err.message}`
          );
        }
      }
      if (fileAttachments.length === 0) {
        attachmentFailureReply = '文件下载失败，请稍后重试。';
      }
    }

    const acceptedImageDescriptors = imageDescriptors.slice(0, MAX_IMAGE_INPUTS);
    const ignoredImages = Math.max(0, imageDescriptors.length - acceptedImageDescriptors.length);
    if (acceptedImageDescriptors.length > 0) {
      for (let index = 0; index < acceptedImageDescriptors.length; index += 1) {
        const descriptor = acceptedImageDescriptors[index];
        try {
          const downloaded = await downloadImageToDownloads(client, {
            accountName,
            workspaceDir: workspace.dir,
            messageID: descriptor.messageID,
            imageKey: descriptor.imageKey,
            fileName: `image-${index + 1}.jpg`,
          });
          imageAttachments.push(downloaded);
          imagePaths.push(downloaded.filePath);
          incomingAttachmentFacts.push(`已接收图片：${downloaded.fileName}，保存在 ${downloaded.relativePath}`);
        } catch (err) {
          console.error(
            `image_download=error source=${attachmentSource || 'current_message_attachment'} message_id=${descriptor.messageID} key=${descriptor.imageKey} message=${err.message}`
          );
        }
      }
      if (imagePaths.length === 0 && !attachmentFailureReply) {
        attachmentFailureReply = '图片接收失败，请稍后重试。';
      }
    }

    if (audioDescriptors.length > 0) {
      for (const descriptor of audioDescriptors) {
        let downloadedAudio = null;
        try {
          downloadedAudio = await downloadAudioToTempFile(client, descriptor.messageID, descriptor.fileKey);
          tempPathsToCleanup.push(downloadedAudio.tempDir);
        } catch (err) {
          console.error(
            `audio_download=error source=${attachmentSource || 'current_message_attachment'} message_id=${descriptor.messageID} key=${descriptor.fileKey} message=${err.message}`
          );
          if (!attachmentFailureReply) attachmentFailureReply = '语音下载失败，请稍后重试。';
          continue;
        }

        try {
          const transcript = await transcribeAudioMessage(downloadedAudio.filePath, speech);
          const durationText = formatDurationFromMs(descriptor.durationMs);
          audioTranscripts.push({
            text: transcript.text,
            durationText,
          });
          incomingAttachmentFacts.push(`已转写语音消息${durationText ? `（${durationText}）` : ''}`);
        } catch (err) {
          console.error(`audio_transcription=error path=${downloadedAudio.filePath} message=${err.message}`);
          const missingFfmpeg = !speech.ffmpegBin
            && /ffmpeg/i.test(String(err.message || ''));
          if (!attachmentFailureReply) {
            attachmentFailureReply = missingFfmpeg
              ? '当前环境缺少语音转码能力，请保留 bundled ffmpeg-static 或安装 ffmpeg 后重试。'
              : '语音转写失败，请检查 speech.api_key / 网络后重试。';
          }
        }
      }
    }

    if (hasAttachmentBundleContent(selectedAttachmentBundle)) {
      const attachmentTextSegments = uniqueStrings([incomingText, ...attachmentTextParts].filter(Boolean));
      if (attachmentTextSegments.length === 0 && carriedText) {
        attachmentTextSegments.push(carriedText);
        usedRecentTextCarry = true;
      }

      if (fileAttachments.length === 0 && imagePaths.length === 0 && audioTranscripts.length === 0) {
        await sendTextReplySafe(client, chatID, attachmentFailureReply || '附件处理失败，请稍后重试。', 'attachment_download_reply');
        return;
      }

      const attachmentSummaryParts = [];
      if (fileAttachments.length > 0) attachmentSummaryParts.push(`${fileAttachments.length} 个文件`);
      if (imagePaths.length > 0) attachmentSummaryParts.push(`${imagePaths.length} 张图片`);
      if (audioTranscripts.length > 0) attachmentSummaryParts.push(`${audioTranscripts.length} 条语音`);

      const lines = [`用户发送了 ${attachmentSummaryParts.join('、')}。`];
      if (attachmentSource === 'quoted_attachment') {
        lines.push('这些附件来自用户当前消息引用/回复的上一条消息，请结合本条消息一起理解。');
      } else if (attachmentSource === 'recent_attachment_pair') {
        lines.push('这些附件来自同一位用户刚刚在当前会话里发送的上一批消息，请与本条 @ 一起理解。');
      }
      if (attachmentTextSegments.length > 0) {
        lines.push('用户补充的文字：');
        lines.push(attachmentTextSegments.join('\n'));
      }
      if (imagePaths.length > 0) {
        lines.push('请结合图片内容一起处理：');
        for (const image of imageAttachments) {
          lines.push(`图片保存路径：${image.filePath}`);
          lines.push(`下载文件夹位置：${image.relativePath}`);
        }
      }
      if (fileAttachments.length > 0) {
        lines.push('如需使用文件内容，请直接读取这些本地文件：');
        for (const file of fileAttachments) {
          lines.push(`文件名：${file.fileName}`);
          if (file.fileSize > 0) lines.push(`文件大小：${formatBytes(file.fileSize)}`);
          lines.push(`本地下载路径：${file.filePath}`);
          lines.push(`下载文件夹位置：${file.relativePath}`);
        }
      }
      if (audioTranscripts.length > 0) {
        lines.push('下面是语音转写结果（可能存在少量识别误差）：');
        for (let index = 0; index < audioTranscripts.length; index += 1) {
          const transcript = audioTranscripts[index];
          const prefix = transcript.durationText
            ? `语音 ${index + 1}（${transcript.durationText}）：`
            : `语音 ${index + 1}：`;
          lines.push(prefix);
          lines.push(transcript.text);
        }
      }
      if (ignoredImages > 0) {
        lines.push(`注意：同一批附件中额外 ${ignoredImages} 张图片已忽略。`);
      }
      userText = lines.join('\n');

      const fileSummary = fileAttachments.map((item) => item.fileName).filter(Boolean).join('，');
      const fileSavedPaths = fileAttachments.map((item) => item.relativePath).filter(Boolean);
      const imageSavedPaths = imageAttachments.map((item) => item.relativePath).filter(Boolean);
      const audioSummary = audioTranscripts
        .map((item) => item.durationText ? `${item.durationText}` : '语音')
        .join('，');
      const historyParts = [`[附件消息${attachmentSource ? ` ${attachmentSource}` : ''}]`];
      if (fileAttachments.length > 0) historyParts.push(fileSummary || `${fileAttachments.length} 个文件`);
      if (imagePaths.length > 0) historyParts.push(`图片 ${imagePaths.length} 张`);
      if (audioTranscripts.length > 0) historyParts.push(audioSummary ? `语音 ${audioSummary}` : `语音 ${audioTranscripts.length} 条`);
      if (attachmentTextSegments.length > 0) historyParts.push(`文本：${attachmentTextSegments.join(' / ')}`);
      if (fileSavedPaths.length > 0) historyParts.push(`文件位置：${fileSavedPaths.join('，')}`);
      if (imageSavedPaths.length > 0) historyParts.push(`图片位置：${imageSavedPaths.join('，')}`);
      if (audioTranscripts.length > 0) {
        historyParts.push(`转写：${audioTranscripts.map((item) => item.text).join(' / ')}`);
      }
      if (ignoredImages > 0) historyParts.push(`忽略图片 ${ignoredImages} 张`);
      historyUserText = compactText(historyParts.join(' + '), 4000);

      if (attachmentSource === 'recent_attachment_pair') {
        usedRecentAttachmentCarry = true;
      }
      if (attachmentSource === 'current_message_attachment') {
        consumeCurrentAttachmentCarry = true;
      }
    } else {
      userText = incomingText;
      if (!userText) {
        console.log('skip_reason=empty_text');
        return;
      }
      historyUserText = userText;
    }

    const personalProxyCommand = messageType === 'text'
      ? parsePersonalProxyCommand(incomingText, personalProxy)
      : null;
    if (personalProxyCommand) {
      const commandResult = await handlePersonalProxyCommand({
        client,
        accountName,
        personalProxy,
        command: personalProxyCommand,
        senderIdentity,
        chatID,
        chatType,
        messageID,
        dispatchApprovedRequest: dispatchApprovedPersonalProxyRequest,
      });
      if (commandResult.handled) {
        console.log(`reply=ok mode=personal_proxy_command type=${personalProxyCommand.type}`);
        return;
      }
    }

    registerActorChatState(actorChatIndex, conversationScope.actorKey, conversationScope.stateKey || chatID);
    const chatState = ensureChatState(chatStates, conversationScope.stateKey || chatID, {
      chatID,
      chatType,
      actorKey: conversationScope.actorKey,
      now,
    });
    if (messageType === 'text') {
      const taskCommandResult = await scheduledJobManager.handleUserText(incomingText, {
        accountName,
        channelType: 'feishu',
        scopeKey: conversationScope.stateKey || chatID,
        chatID,
        senderOpenId: senderOpenID,
        messageID,
        rootId: rootID,
        parentId: parentID,
        threadId: messageThreadID || rootID,
        createdBy: senderOpenID,
      });
      if (taskCommandResult?.handled) {
        if (taskCommandResult.reply) {
          await sendTextReplySafe(client, chatID, taskCommandResult.reply, 'scheduled_task_reply');
        }
        console.log('reply=ok mode=scheduled_task');
        return;
      }
      if (taskCommandResult?.passthroughText) {
        userText = compactText(String(taskCommandResult.passthroughText || ''), 4000).trim() || userText;
        historyUserText = userText;
      }

      const threadCommand = parseThreadCommand(userText);
      if (threadCommand) {
        const result = handleThreadCommand(chatState, threadCommand);
        if (result.handled) {
          await sendTextReplySafe(client, chatID, result.reply, 'thread_reply');
          console.log(`thread_state total=${chatState.order.length} current=${chatState.currentThreadId}`);
          console.log(`reply=ok mode=thread_command thread=${chatState.currentThreadId}`);
          return;
        }
      }

      if (isResetCommand(userText)) {
        const currentThread = getCurrentThread(chatState);
        if (!currentThread) {
          await sendTextReplySafe(client, chatID, '当前线程不存在，请先用 /thread new 创建。', 'reset_reply');
          console.log('reply=ok mode=reset_missing_thread');
          return;
        }
        currentThread.history = [];
        currentThread.codexThreadId = '';
        currentThread.updatedAt = Date.now();
        await sendTextReplySafe(
          client,
          chatID,
          `已清空当前线程上下文：${currentThread.id} · ${currentThread.name}`,
          'reset_reply'
        );
        console.log(`reply=ok mode=reset thread=${currentThread.id}`);
        return;
      }
    }

    const accessibleThreadContext = buildAccessibleThreadContext(chatStates, actorChatIndex, {
      actorKey: conversationScope.actorKey,
      currentStateKey: conversationScope.stateKey || chatID,
      currentThread: getCurrentThread(chatState),
      userText: historyUserText || userText,
    });
    if (accessibleThreadContext.sources.length > 0) {
      console.log(
        `cross_thread_access=enabled actor=${conversationScope.actorKey || '(none)'} sources=${accessibleThreadContext.sources.map((item) => `${item.chatID || item.stateKey}:${item.threadId || '(thread)'}`).join(',')}`
      );
    }
    const recentChatContext = groupChat
      ? await fetchRecentChatContextFromChatHistory(client, {
        chatID,
        currentMessageID: messageID,
        currentMessageItem,
        logTag: 'chat_context_lookup',
      })
      : { promptText: '', historyText: '', count: 0 };
    if (recentChatContext.count > 0) {
      console.log(`chat_context=enabled messages=${recentChatContext.count}`);
    }

    if (usedRecentTextCarry) {
      consumeRecentTextCarry(recentTextInputs, {
        chatID,
        chatType,
        senderIdentity,
        messageID: dispatchMeta.recentTextMessageID || '',
      });
    }
    if (usedRecentAttachmentCarry) {
      consumeRecentAttachmentCarry(recentAttachmentInputs, {
        chatID,
        chatType,
        senderIdentity,
        messageIDs: selectedAttachmentBundle?.sourceMessageIDs || [],
      });
    }
    if (consumeCurrentAttachmentCarry) {
      consumeRecentAttachmentCarry(recentAttachmentInputs, {
        chatID,
        chatType,
        senderIdentity,
        messageIDs: currentAttachmentBundle?.sourceMessageIDs || [],
      });
    }

    const personalProxyReviewText = compactText(
      [
        historyUserText,
        accessibleThreadContext.historyText ? `[其他会话线程]\n${accessibleThreadContext.historyText}` : '',
        recentChatContext.historyText ? `[当前群最近聊天]\n${recentChatContext.historyText}` : '',
      ].filter(Boolean).join('\n'),
      4000
    );

    const senderSummary = buildSenderIdentitySummary(senderIdentity, { includeType: true });
    if (senderSummary || quotedMessageContext.promptText || recentChatContext.promptText) {
      const promptContextBlocks = [];
      if (accessibleThreadContext.promptText) promptContextBlocks.push(accessibleThreadContext.promptText);
      if (recentChatContext.promptText) promptContextBlocks.push(recentChatContext.promptText);
      if (senderSummary) promptContextBlocks.push(`当前发件人：${senderSummary}`);
      if (quotedMessageContext.promptText) promptContextBlocks.push(quotedMessageContext.promptText);
      promptContextBlocks.push(userText);
      userText = promptContextBlocks.filter(Boolean).join('\n\n');
    } else if (accessibleThreadContext.promptText) {
      userText = [accessibleThreadContext.promptText, userText].filter(Boolean).join('\n\n');
    }
    historyUserText = compactText(
      [
        accessibleThreadContext.historyText ? `[其他会话线程]\n${accessibleThreadContext.historyText}` : '',
        recentChatContext.historyText ? `[当前群最近聊天]\n${recentChatContext.historyText}` : '',
        senderSummary ? `[发件人] ${senderSummary}` : '',
        historyUserText,
        quotedMessageContext.historyText,
      ].filter(Boolean).join('\n'),
      4000
    );

    const personalProxyGate = await maybeGatePersonalProxyRequest({
      client,
      accountName,
      personalProxy,
      payload: data,
      taskKey: dispatchMeta.taskKey || conversationScope.key || chatID || messageID,
      chatID,
      chatType,
      messageID,
      senderIdentity,
      userText: personalProxyReviewText || userText,
      historyUserText: personalProxyReviewText || historyUserText,
      hasAttachments: hasAttachmentBundleContent(selectedAttachmentBundle),
    });
    if (personalProxyGate.handled) {
      console.log(`reply=ok mode=personal_proxy_gate approval_id=${personalProxyGate.approvalID || '(none)'}`);
      return;
    }

    const releaseBusyTargets = markBusyTargetKeys(
      busyTargetCounts,
      buildBusyTargetKeysFromIncomingMessage({
        channelType: 'feishu',
        chatID,
        chatType,
        threadID: messageThreadID || rootID,
        senderOpenID,
      })
    );
    const parsedThingsCommand = messageType === 'text' ? parseThingsCommand(incomingText) : null;
    if (parsedThingsCommand) {
      console.log(
        `things_command_guard=${parsedThingsCommand.type} reason=${parsedThingsCommand.reason || 'matched'} text=${compactText(incomingText, 160)}`
      );
    }

    const memoryBundleText = replyMode === 'codex' && memory.enabled
      ? buildBotMemoryBundleText(
        readBotMemoryStore(accountName, memory.roleMemory).store,
        historyUserText || userText
      )
      : '';
    const thingsCommandHint = replyMode === 'codex' && messageType === 'text'
      ? buildThingsCommandHint(parsedThingsCommand)
      : '';
    const guardedUserText = replyMode === 'codex' && messageType === 'text'
      ? buildThingsCommandGuardedUserText(userText, parsedThingsCommand)
      : userText;

    const progressReporter = replyMode === 'codex' && progress.enabled
      ? createProgressReporter({
        client,
        chatID,
        initialMessage: progress.message,
        userText,
        progressConfig: progress,
      })
      : null;
    taskControl.onCancel(async () => {
      if (progressReporter && typeof progressReporter.abort === 'function') {
        await progressReporter.abort();
      }
    });
    const typingState = typing.enabled && messageID
      ? await addTypingIndicatorSafe(client, messageID, typing.emoji)
      : null;
    taskControl.onCancel(async () => {
      if (typingState) {
        await removeTypingIndicatorSafe(client, typingState);
      }
    });

    try {
      taskControl.throwIfCancelled();
      if (progressReporter) {
        await progressReporter.start();
      } else if (progress.enabled) {
        await sendTextReplySafe(client, chatID, progress.message, 'progress_notice');
        console.log('progress_notice=sent');
      }
      taskControl.throwIfCancelled();

      let replyText = '';
      let memoryLiveToolFacts = [];
      if (replyMode === 'codex') {
        const currentThread = getCurrentThread(chatState);
        if (!currentThread) {
          throw new Error('current thread not found');
        }
        const history = currentThread.history || [];
        const forceExecution = shouldForceCodexExecution(historyUserText || userText);
        console.log(`codex_force_execution=${forceExecution ? 'true' : 'false'}`);
        const codexThreadTitle = buildCodexThreadTitle({
          botName: botName || accountName,
          localThreadName: currentThread.name || currentThread.id,
          userText: historyUserText || userText,
        });
        const codexReply = await generateCodexReply({
          codex,
          history,
          userText: guardedUserText,
          imagePaths,
          sessionId: currentThread.codexThreadId,
          threadTitle: codexThreadTitle,
          fileWorkspaceDir: workspace.dir,
          forceExecution,
          memoryBundleText,
          thingsCommandHint,
          throwIfCancelled: () => taskControl.throwIfCancelled(),
          onSpawn: (child) => {
            taskControl.attachCodexChild(child);
          },
          onProgressEvent: (event) => {
            if (taskControl.isCancelled()) return;
            if (!progressReporter) return;
            if (typeof progressReporter.recordEvent === 'function') {
              progressReporter.recordEvent(event);
              return;
            }
            const stepText = formatCodexProgressEvent(event);
            if (!stepText) return;
            progressReporter.push(stepText);
          },
        });
        taskControl.throwIfCancelled();
        replyText = codexReply.reply;
        if (codexReply.threadId) {
          currentThread.codexThreadId = codexReply.threadId;
          const synced = syncCodexThreadTitle(codexReply.threadId, codexThreadTitle, codex.home);
          console.log(`codex_thread_title_sync=${synced ? 'ok' : 'skip'} thread_id=${codexReply.threadId}`);
          console.log(`codex_thread_id=${codexReply.threadId} chat_id=${chatID} bot=${JSON.stringify(botName || accountName)} local_thread=${currentThread.id}`);
        }
      } else if (replyMode === 'local_model') {
        const currentThread = getCurrentThread(chatState);
        if (!currentThread) {
          throw new Error('current thread not found');
        }
        const history = currentThread.history || [];
        const forceExecution = shouldDelegateToCodexInLocalModel(historyUserText || userText);
        console.log(`local_model_force_codex=${forceExecution ? 'true' : 'false'}`);
        if (forceExecution) {
          const codexThreadTitle = buildCodexThreadTitle({
            botName: botName || accountName,
            localThreadName: currentThread.name || currentThread.id,
            userText: historyUserText || userText,
          });
          const codexReply = await generateCodexReply({
            codex,
            history,
            userText: guardedUserText,
            imagePaths,
            sessionId: currentThread.codexThreadId,
            threadTitle: codexThreadTitle,
            fileWorkspaceDir: workspace.dir,
            forceExecution: true,
            memoryBundleText,
            thingsCommandHint,
            throwIfCancelled: () => taskControl.throwIfCancelled(),
            onSpawn: (child) => {
              taskControl.attachCodexChild(child);
            },
            onProgressEvent: (event) => {
              if (taskControl.isCancelled()) return;
              if (!progressReporter) return;
              if (typeof progressReporter.recordEvent === 'function') {
                progressReporter.recordEvent(event);
                return;
              }
              const stepText = formatCodexProgressEvent(event);
              if (!stepText) return;
              progressReporter.push(stepText);
            },
          });
          taskControl.throwIfCancelled();
          replyText = codexReply.reply;
          if (codexReply.threadId) {
            currentThread.codexThreadId = codexReply.threadId;
            const synced = syncCodexThreadTitle(codexReply.threadId, codexThreadTitle, codex.home);
            console.log(`codex_thread_title_sync=${synced ? 'ok' : 'skip'} thread_id=${codexReply.threadId}`);
            console.log(`codex_thread_id=${codexReply.threadId} chat_id=${chatID} bot=${JSON.stringify(botName || accountName)} local_thread=${currentThread.id}`);
          }
        } else {
          const localModelReply = await generateLocalModelReply({
            localModel,
            history,
            userText: guardedUserText,
            imagePaths,
            memoryBundleText,
          });
          taskControl.throwIfCancelled();
          const delegateDecision = extractCodexDelegateDirective(localModelReply.reply);
          if (delegateDecision.hasDirective) {
            const delegatedPrompt = delegateDecision.delegatedPrompt || guardedUserText;
            console.log(`local_model_delegate_to_codex=true delegated_prompt_chars=${delegatedPrompt.length}`);
            const codexThreadTitle = buildCodexThreadTitle({
              botName: botName || accountName,
              localThreadName: currentThread.name || currentThread.id,
              userText: historyUserText || userText,
            });
            const codexReply = await generateCodexReply({
              codex,
              history,
              userText: delegatedPrompt,
              imagePaths,
              sessionId: currentThread.codexThreadId,
              threadTitle: codexThreadTitle,
              fileWorkspaceDir: workspace.dir,
              forceExecution: true,
              memoryBundleText,
              thingsCommandHint,
              throwIfCancelled: () => taskControl.throwIfCancelled(),
              onSpawn: (child) => {
                taskControl.attachCodexChild(child);
              },
              onProgressEvent: (event) => {
                if (taskControl.isCancelled()) return;
                if (!progressReporter) return;
                if (typeof progressReporter.recordEvent === 'function') {
                  progressReporter.recordEvent(event);
                  return;
                }
                const stepText = formatCodexProgressEvent(event);
                if (!stepText) return;
                progressReporter.push(stepText);
              },
            });
            taskControl.throwIfCancelled();
            replyText = codexReply.reply;
            if (codexReply.threadId) {
              currentThread.codexThreadId = codexReply.threadId;
              const synced = syncCodexThreadTitle(codexReply.threadId, codexThreadTitle, codex.home);
              console.log(`codex_thread_title_sync=${synced ? 'ok' : 'skip'} thread_id=${codexReply.threadId}`);
              console.log(`codex_thread_id=${codexReply.threadId} chat_id=${chatID} bot=${JSON.stringify(botName || accountName)} local_thread=${currentThread.id}`);
            }
          } else {
            replyText = localModelReply.reply;
          }
        }
      } else {
        replyText = normalizeReplyText(replyPrefix, userText);
      }
      const codexRawReply = String(replyText || '').replace(/\r/g, '');
      if (replyMode === 'codex') {
        const attachmentPlan = extractFeishuReplyResources(codexRawReply, {
          cwd: codex.cwd || process.cwd(),
          preferFileAttachments: shouldSendLocalFilesForRequest(historyUserText || userText),
        });
        let userReplyText = attachmentPlan.text;
        if (!userReplyText.trim() && attachmentPlan.attachments.length === 0) {
          throw new Error('codex returned empty reply');
        }
        taskControl.throwIfCancelled();
        if (userReplyText) {
          await sendCodexReplyPassthrough(client, chatID, userReplyText, () => !taskControl.isCancelled());
        }
        taskControl.throwIfCancelled();
        const attachmentSendResult = await sendRequestedAttachments(
          client,
          chatID,
          attachmentPlan.attachments,
          codex.cwd || process.cwd(),
          () => !taskControl.isCancelled(),
          { ffmpegBin: speech.ffmpegBin }
        );
        memoryLiveToolFacts = [
          ...incomingAttachmentFacts,
          ...deriveMemoryLiveToolFacts(attachmentSendResult),
        ];
        taskControl.throwIfCancelled();
        if (!userReplyText && attachmentSendResult.sent.length > 0) {
          userReplyText = buildDefaultAttachmentReply(attachmentSendResult.sent);
          if (userReplyText) {
            await sendCodexReplyPassthrough(client, chatID, userReplyText, () => !taskControl.isCancelled());
          }
        }
        const attachmentFailureReply = buildAttachmentSendFailureReply(attachmentSendResult.sent, attachmentSendResult.failed);
        if (attachmentFailureReply) {
          await sendTextReplySafe(client, chatID, attachmentFailureReply, 'reply_attachment_notice');
        }
        const finalReplyForLog = [userReplyText, buildAttachmentSendResultText(attachmentSendResult.sent, attachmentSendResult.failed)]
          .filter(Boolean)
          .join('\n')
          .trim();
        if (progressReporter) {
          await progressReporter.complete('执行完成，回复见下条消息。');
          await progressReporter.recordFinalReply(finalReplyForLog || userReplyText || codexRawReply);
        }
        replyText = finalReplyForLog || userReplyText;
      } else {
        const echoReply = compactText(codexRawReply, FEISHU_TEXT_CHUNK_LIMIT).trim();
        if (!echoReply) {
          throw new Error(`${replyMode} reply empty`);
        }
        if (fakeStream.enabled && !shouldRenderFeishuMarkdown(echoReply)) {
          await sendTextReplyWithFakeStream(client, chatID, echoReply, fakeStream);
        } else {
          await sendRenderedReply(client, chatID, echoReply, {
            logTag: 'reply',
            preferMarkdown: true,
          });
        }
      }
      if (memory.enabled) {
        const activeMemoryThread = getCurrentThread(chatState);
        const storedMemory = await updateBotMemoryStore(accountName, memory.roleMemory, (store) => {
          return recordConversationIntoBotMemoryStore(store, {
            userText: historyUserText || userText,
            assistantText: replyText || codexRawReply,
            liveToolFacts: memoryLiveToolFacts.length > 0 ? memoryLiveToolFacts : incomingAttachmentFacts,
            threadId: activeMemoryThread?.id || '',
          });
        });
        console.log(
          `memory_bundle=updated account=${accountName} profile=${storedMemory.profileFacts.length} role=${storedMemory.roleMemoryItems.length} history=${storedMemory.historyItems.length}`
        );
      }
      if ((replyMode === 'codex' && codex.historyTurns > 0) || (replyMode === 'local_model' && localModel.historyTurns > 0)) {
        const currentThread = getCurrentThread(chatState);
        if (!currentThread) {
          throw new Error('current thread not found after reply');
        }
        const replyForHistory = compactText(String(replyText || codexRawReply || ''), 4000).trim();
        const oldHistory = currentThread.history || [];
        const nextHistory = [
          ...oldHistory,
          { role: 'user', text: historyUserText },
          { role: 'assistant', text: replyForHistory },
        ];
        const maxItems = (replyMode === 'local_model' ? localModel.historyTurns : codex.historyTurns) * 2;
        while (nextHistory.length > maxItems) nextHistory.shift();
        currentThread.history = nextHistory;
        currentThread.updatedAt = Date.now();
      }

      const activeThread = getCurrentThread(chatState);
      console.log(`reply=ok mode=${replyMode} thread=${activeThread ? activeThread.id : ''}`);
    } catch (err) {
      if (taskControl.isCancelled() || isTaskCancelledError(err)) {
        const currentThread = getCurrentThread(chatState);
        if (currentThread) {
          currentThread.codexThreadId = '';
          currentThread.updatedAt = Date.now();
        }
        console.log(`reply=cancelled mode=${replyMode} reason=${taskControl.cancelReason || err.reason || err.message}`);
        return;
      }
      const userVisibleError = replyMode === 'codex'
        ? String(err?.userVisibleSummary || summarizeCodexExecFailure(err, codex))
        : `处理失败：${compactText(String(err.message || '未知错误'), 1000)}`;
      console.error(`reply=error mode=${replyMode} message=${err.message}`);
      if (progressReporter) {
        await progressReporter.fail(userVisibleError);
      }
      await sendTextReplySafe(
        client,
        chatID,
        userVisibleError,
        'reply_error_notice'
      );
    } finally {
      releaseBusyTargets();
      if (typingState) {
        await removeTypingIndicatorSafe(client, typingState);
      }
      for (const tempPath of tempPathsToCleanup) {
        try {
          fs.rmSync(tempPath, { recursive: true, force: true });
        } catch (_) {
          // ignore cleanup errors
        }
      }
    }
  }

  const eventDispatcher = new lark.EventDispatcher({
    encryptKey: creds.encryptKey.value || undefined,
    verificationToken: creds.verificationToken.value || undefined,
    loggerLevel: lark.LoggerLevel.info,
  }).register({
    'im.message.receive_v1': (data) => {
      const rawMessage = data?.message || {};
      const rawChatID = String(rawMessage.chat_id || '').trim();
      const rawChatType = String(rawMessage.chat_type || '').trim().toLowerCase();
      const rawMessageID = String(rawMessage.message_id || '').trim();
      const rawSenderIdentity = extractEventSenderIdentity(data);
      const rawMessageType = String(rawMessage.message_type || '').trim().toLowerCase();
      const rawScope = buildConversationScope(rawChatID, rawChatType, rawSenderIdentity, rawMessageID);
      const rawText = rawMessageType === 'text' ? normalizeIncomingText(parseMessageText(rawMessage.content || ''), rawMessage.mentions || [], mentionAliases) : '';
      const shouldQueueScheduledTaskMessage = rawMessageType === 'text'
        && scheduledJobManager.shouldQueueMessage(rawText, {
          scopeKey: rawScope.stateKey || rawChatID,
          chatID: rawChatID,
        });
      const dispatchEnvelope = buildDispatchEnvelope(data, {
        mentionAliases,
        botOpenId: creds.botOpenId.value,
        recentTextInputs,
        recentAttachmentInputs,
      });
      dispatchEnvelope.payload.dispatchMeta.taskKey = dispatchEnvelope.taskKey;
      dispatchLatestByChat(
        chatRunners,
        dispatchEnvelope.taskKey,
        dispatchEnvelope.payload,
        handleMessageEvent,
        {
          shouldSupersede: () => shouldQueueScheduledTaskMessage ? false : dispatchEnvelope.shouldSupersedeActiveTask,
        }
      );
    },
    'card.action.trigger': async (data) => {
      const action = extractPersonalProxyCardAction(data);
      if (!action) {
        return {
          toast: {
            type: 'info',
            content: `这不是 ${personalProxyBotLabel(personalProxy)} 的隐私审批卡片。`,
          },
        };
      }
      const result = await decidePersonalProxyApproval({
        client,
        accountName,
        personalProxy,
        approvalID: action.approvalID,
        decision: action.decision,
        actorIdentity: action.actorIdentity,
        approvalCardMessageID: action.approvalCardMessageID,
        source: 'card_action',
        dispatchApprovedRequest: dispatchApprovedPersonalProxyRequest,
      });
      return {
        toast: {
          type: result.ok ? 'success' : 'warning',
          content: result.message,
        },
      };
    },
  });

  const wsClient = patchWsClientTlsBypass(new lark.WSClient({
    ...baseConfig,
    agent: process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0'
      ? new https.Agent({ rejectUnauthorized: false })
      : undefined,
    autoReconnect: true,
    loggerLevel: lark.LoggerLevel.info,
  }));

  let stopping = false;
  function stop(signal) {
    if (stopping) return;
    stopping = true;
    console.log(`FEISHU_WS_STOP signal=${signal}`);
    scheduledJobManager.stop();
    wsClient.close({ force: true });
    setTimeout(() => process.exit(0), 50);
  }

  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));

  await wsClient.start({ eventDispatcher });
  console.log('FEISHU_WS_BOT_RUNNING');
  console.log(`account=${accountName}`);
  if (configPath) console.log(`config=${configPath}`);
  console.log(`domain=${domain.label}`);
  console.log(`auto_reply=${autoReply ? 'true' : 'false'}`);
  console.log(`ignore_self=${ignoreSelf ? 'true' : 'false'}`);
  console.log(`bot_name=${botName || '(none)'}`);
  console.log(`require_mention=${mentionConfig.requireMention ? 'true' : 'false'}`);
  console.log(`require_mention_group_only=${mentionConfig.groupOnly ? 'true' : 'false'}`);
  console.log(`bot_open_id_autodetect=${mentionConfig.requireMention ? 'enabled' : 'not_needed'}`);
  console.log(`mention_aliases=${mentionAliases.length > 0 ? mentionAliases.join(' | ') : '(none)'}`);
  console.log(`reply_mode=${replyMode}`);
  console.log(`workspace_dir=${workspace.dir}`);
  console.log(`workspace_incoming_dir=${workspace.incomingDir}`);
  console.log(`workspace_output_dir=${workspace.outputDir}`);
  console.log(`workspace_temp_dir=${workspace.tempDir}`);
  console.log(`typing_indicator=${typing.enabled ? 'true' : 'false'}`);
  console.log(`fake_stream=${fakeStream.enabled ? 'true' : 'false'}`);
  const startupPersonalProxyOwner = personalProxy.enabled ? readPersonalProxyOwner(accountName) : {};
  console.log(`personal_proxy_enabled=${personalProxy.enabled ? 'true' : 'false'}`);
  console.log(`personal_proxy_owner_bound=${isPersonalProxyOwnerBound(startupPersonalProxyOwner) ? 'true' : 'false'}`);
  console.log(`personal_proxy_owner_bind_command=${personalProxy.ownerBindCommand}`);
  console.log(`local_model_cwd=${localModel.cwd || '(missing)'}`);
  console.log(`local_model_server_base_url=${localModel.serverBaseUrl || '(none)'}`);
  console.log(`local_model_prompt_script=${localModel.promptScript || '(missing)'}`);
  console.log(`local_model_history_turns=${localModel.historyTurns}`);
  console.log(`progress_notice=${progress.enabled ? 'true' : 'false'}`);
  console.log(`progress_mode=${progress.mode}`);
  if (progress.mode === 'doc') {
    console.log(`progress_doc_title_prefix=${progress.doc.titlePrefix}`);
    console.log(`progress_doc_share_to_chat=${progress.doc.shareToChat ? 'true' : 'false'}`);
    console.log(`progress_doc_link_scope=${progress.doc.linkScope}`);
    console.log(`progress_doc_include_user_message=${progress.doc.includeUserMessage ? 'true' : 'false'}`);
    console.log(`progress_doc_write_final_reply=${progress.doc.writeFinalReply ? 'true' : 'false'}`);
  }
  if (replyMode === 'codex') {
    if (codexDetect.version) console.log(`codex_version=${codexDetect.version}`);
    console.log(`codex_bin=${codex.bin}`);
    console.log(`codex_model=${codex.model || '(default)'}`);
    console.log(`codex_reasoning_effort=${codex.reasoningEffort || '(default)'}`);
    printCodexModelRouteConfig(codex);
    console.log(`codex_profile=${codex.profile || '(default)'}`);
    console.log(`codex_home=${codex.home || process.env.CODEX_HOME || path.join(os.homedir(), '.codex')}`);
    console.log(`codex_cwd=${codex.cwd || process.cwd()}`);
    console.log(`codex_add_dirs=${codex.addDirs.length > 0 ? codex.addDirs.join(' | ') : '(none)'}`);
  console.log(`codex_sandbox=${codex.sandbox}`);
  console.log(`codex_approval_policy=${codex.approvalPolicy}`);
  console.log(`codex_bypass_sandbox=${shouldBypassCodexSandbox(codex.sandbox, codex.approvalPolicy) ? 'true' : 'false'}`);
  console.log(`codex_timeout_sec=${codex.timeoutSec || '(disabled)'}`);
  console.log(`codex_history_turns=${codex.historyTurns}`);
  }
  console.log(`talk_normal_prompt_loaded=${talkNormalPrompt.loaded ? 'true' : 'false'}`);
  if (talkNormalPrompt.loaded) console.log(`talk_normal_prompt_path=${talkNormalPrompt.path}`);
  console.log(`memory_enabled=${memory.enabled ? 'true' : 'false'}`);
  console.log(`memory_role_memory_chars=${memory.roleMemory.length}`);
  if (memory.enabled) console.log(`memory_store=${botMemoryStorePath(accountName)}`);
  console.log(`speech_enabled=${speech.enabled ? 'true' : 'false'}`);
  console.log(`speech_model=${speech.model}`);
  console.log(`speech_language=${speech.language || '(auto)'}`);
  console.log(`speech_base_url=${speech.baseURL}`);
  console.log(`speech_api_key_found=${speech.apiKey ? 'true' : 'false'}`);
  if (speech.apiKeySource) console.log(`speech_api_key_source=${speech.apiKeySource}`);
  console.log(`speech_ffmpeg_bin=${speech.ffmpegBin || '(not found)'}`);
  if (speech.ffmpegVersion) console.log(`speech_ffmpeg_version=${speech.ffmpegVersion}`);
}

module.exports = {
  main,
  __test__: {
    FEISHU_ATTACHMENT_TEXT_CARRY_WINDOW_MS,
    buildAttachmentBundle,
    hasAttachmentBundleContent,
    parseCrossChatCommand,
    listRecentChatTargetsFromLogLines,
    resolveCrossChatTarget,
    summarizeCrossChatMessageItem,
    formatCrossChatListReply,
    buildConversationScope,
    ensureChatState,
    registerActorChatState,
    buildAccessibleThreadContext,
    shouldIncludeAccessibleThreadContext,
    hasThreadActivity,
    getMostRelevantThread,
    getCurrentThread,
    handleThreadCommand,
    extractAttachmentBundleFromMessage,
    extractAttachmentBundleFromMessageItem,
    extractMessageItemTimestamp,
    mergeAttachmentBundles,
    findRecentAttachmentBundleFromMessageItems,
    buildRecentChatContextFromMessageItems,
    selectAttachmentSource,
    buildDispatchEnvelope,
    rememberRecentTextCarry,
    getRecentTextCarry,
    consumeRecentTextCarry,
    pruneRecentTextCarryState,
    rememberRecentAttachmentCarry,
    getRecentAttachmentCarry,
    consumeRecentAttachmentCarry,
    pruneRecentAttachmentCarryState,
    resolvePersonalProxyConfig,
    parsePersonalProxyCommand,
    classifyPersonalProxySensitivity,
    personalProxyOwnerMatches,
    personalProxyGrantKey,
    buildPersonalProxyApprovalCard,
    extractPersonalProxyCardAction,
    extractSystemPromptAliases,
    resolveProgressConfig,
    parseCodexPlainExecOutput,
    extractCodexErrorSummary,
    isCodexAuthenticationErrorText,
    shouldRetryCodexExecError,
  },
};

if (require.main === module) {
  main().catch((err) => {
    console.error('ERROR:', err.message);
    process.exit(1);
  });
}
