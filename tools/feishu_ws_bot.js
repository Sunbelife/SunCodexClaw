#!/usr/bin/env node
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const {
  deepMerge,
  readConfigEntry,
  resolveSecretsFile,
  upsertConfigEntry,
} = require('./lib/local_secret_store');

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
const MAX_IMAGE_INPUTS = 6;
const FEISHU_TEXT_CHUNK_LIMIT = 4000;
const FEISHU_FILE_UPLOAD_LIMIT = 30 * 1024 * 1024;
const FEISHU_IMAGE_UPLOAD_LIMIT = 10 * 1024 * 1024;
const FEISHU_SEND_FILE_DIRECTIVE_PREFIX = '[[FEISHU_SEND_FILE:';
const FEISHU_SEND_IMAGE_DIRECTIVE_PREFIX = '[[FEISHU_SEND_IMAGE:';
const FEISHU_GROUP_MENTION_CARRY_WINDOW_MS = 2 * 60 * 1000;
const FEISHU_DOCX_TEXT_BLOCK_TYPE = 2;
const FEISHU_DOCX_HEADING2_BLOCK_TYPE = 4;
const FEISHU_DOCX_HEADING3_BLOCK_TYPE = 5;
const FEISHU_DOCX_CODE_BLOCK_TYPE = 14;
const VALID_CODEX_SANDBOXES = new Set(['read-only', 'workspace-write', 'danger-full-access']);
const VALID_CODEX_APPROVAL_POLICIES = new Set(['untrusted', 'on-failure', 'on-request', 'never']);
const VALID_PROGRESS_MODES = new Set(['message', 'doc']);
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

function pickValue(candidates) {
  for (const [source, raw] of candidates) {
    const value = String(raw || '').trim();
    if (!value) continue;
    return { value, source };
  }
  return { value: '', source: '' };
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
  if (raw === 'codex' || raw === 'echo') return raw;
  throw new Error(`invalid reply_mode "${raw}", expected codex | echo`);
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

  const rawMode = String(
    getArg('--progress-mode', process.env.FEISHU_PROGRESS_MODE || progress.mode || 'message')
  ).trim().toLowerCase();
  const mode = VALID_PROGRESS_MODES.has(rawMode) ? rawMode : 'message';

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
    mode,
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

function resolveCodexConfig(config) {
  const codexConfig = config.codex || {};
  const apiKey = pickValue([
    ['cli', getArg('--codex-api-key', '')],
    ['env', process.env.CODEX_API_KEY || ''],
    ['env_openai', process.env.OPENAI_API_KEY || ''],
    ['config', codexConfig.api_key || ''],
  ]);
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
  const addDirs = resolveOptionalDirList(
    getArg('--codex-add-dirs', process.env.FEISHU_CODEX_ADD_DIRS || codexConfig.add_dirs || codexConfig.addDirs || '')
  ).filter((dir) => dir !== cwd);

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
    cwd,
    addDirs,
    // Intentionally disable execution timeout: wait until the task exits naturally.
    timeoutSec: 0,
    historyTurns: asInt(getArg('--history-turns', process.env.FEISHU_HISTORY_TURNS || codexConfig.history_turns), 6, 0, 20),
    systemPrompt: String(getArg('--system-prompt', process.env.FEISHU_CODEX_SYSTEM_PROMPT || codexConfig.system_prompt || DEFAULT_CODEX_SYSTEM_PROMPT)).trim(),
    apiKey: apiKey.value,
    apiKeySource: apiKey.source,
    sandbox,
    approvalPolicy,
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
  if (!content) return { fileKey: '', fileName: '', fileSize: 0 };
  try {
    const parsed = JSON.parse(content);
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
    return {
      fileKey,
      fileName,
      fileSize: Number.isFinite(rawSize) ? rawSize : 0,
    };
  } catch (_) {
    return { fileKey: '', fileName: '', fileSize: 0 };
  }
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

  for (const match of text.matchAll(/[“"]([^”"\n]{1,80})[”"]/g)) {
    if (match[1]) aliases.push(match[1]);
  }

  const firstLine = text.split(/\r?\n/, 1)[0] || '';
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
  if (!content) return { text: '', imageKeys: [] };
  try {
    const parsed = JSON.parse(content);
    const post = parsed?.post || parsed;
    const localeEntries = Object.values(post || {});
    const preferred = post?.zh_cn || post?.en_us || localeEntries[0] || {};
    const blocks = Array.isArray(preferred?.content) ? preferred.content : [];
    const textParts = [];
    const imageKeys = [];

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
        }
      }
    }

    return {
      text: textParts.join('\n').trim(),
      imageKeys: uniqueStrings(imageKeys),
    };
  } catch (_) {
    return { text: '', imageKeys: [] };
  }
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

function buildMentionCarryKey(chatID, senderOpenID) {
  const chat = String(chatID || '').trim();
  const sender = String(senderOpenID || '').trim();
  if (!chat || !sender) return '';
  return `${chat}:${sender}`;
}

function pruneMentionCarryState(stateMap, now = Date.now()) {
  if (!stateMap || typeof stateMap.size !== 'number' || stateMap.size === 0) return;
  for (const [key, value] of stateMap.entries()) {
    if (!value || now - value.timestamp > FEISHU_GROUP_MENTION_CARRY_WINDOW_MS) {
      stateMap.delete(key);
    }
  }
}

function rememberRecentMention(stateMap, chatID, senderOpenID, alias = '', now = Date.now()) {
  const key = buildMentionCarryKey(chatID, senderOpenID);
  if (!key) return;
  stateMap.set(key, {
    timestamp: now,
    alias: String(alias || '').trim(),
  });
}

function getRecentMentionState(stateMap, chatID, senderOpenID, now = Date.now()) {
  const key = buildMentionCarryKey(chatID, senderOpenID);
  if (!key) return null;
  const cached = stateMap.get(key);
  if (!cached) return null;
  if (now - cached.timestamp > FEISHU_GROUP_MENTION_CARRY_WINDOW_MS) {
    stateMap.delete(key);
    return null;
  }
  return cached;
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

function resolveLocalFilePath(rawFilePath, cwd = '') {
  let raw = String(rawFilePath || '').trim();
  if (!raw) return '';
  raw = raw.replace(/^['"]+|['"]+$/g, '').trim();
  if (!raw) return '';
  return path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(cwd || process.cwd(), raw);
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
  const sentFiles = sent.filter((item) => item.type === 'file');
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
  const fileCount = attachments.filter((item) => item.type === 'file').length;
  if (imageCount > 0 && fileCount === 0) return '图片已发送，请查收。';
  if (fileCount > 0 && imageCount === 0) return '文件已发送，请查收。';
  if (imageCount > 0 || fileCount > 0) return '附件已发送，请查收。';
  return '';
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
    const blocks = [];
    const heading = buildDocHeadingBlock(3, `[${timestamp}] ${entry.title}`);
    if (heading) blocks.push(heading);
    for (const item of entry.meta || []) {
      const block = buildDocKeyValueBlock(item.label, item.value, { inlineCode: item.inlineCode });
      if (block) blocks.push(block);
    }
    for (const section of entry.sections || []) {
      if (section.label) {
        const labelBlock = buildDocTextBlockFromElements([
          buildDocTextElement(`${section.label}：`, { bold: true }),
        ]);
        blocks.push(labelBlock);
      }
      const contentBlocks = section.format === 'code'
        ? buildDocCodeBlocks(section.content)
        : buildDocTextBlocks(section.content);
      blocks.push(...contentBlocks);
    }
    return blocks;
  }
  return [
    buildDocTextBlockFromElements([
      buildDocTextElement(`[${timestamp}] `, { bold: true }),
      buildDocTextElement(entry.text),
    ]),
  ];
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

function ensureChatState(chatStates, chatID) {
  const cached = chatStates.get(chatID);
  if (cached) return cached;

  const firstThread = makeThread('t1', '主线程');
  const state = {
    threads: new Map([[firstThread.id, firstThread]]),
    order: [firstThread.id],
    currentThreadId: firstThread.id,
    nextThreadSeq: 2,
  };
  chatStates.set(chatID, state);
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

function buildCodexThreadTitle({ botName = '', localThreadName = '', userText = '' }) {
  const botLabel = compactText(String(botName || '飞书机器人').replace(/\s+/g, ' '), 24);
  const threadLabel = compactText(String(localThreadName || '主线程').replace(/\s+/g, ' '), 18);
  const userLabel = compactText(String(userText || '').replace(/\s+/g, ' '), 42);
  return [botLabel, threadLabel, userLabel].filter(Boolean).join(' | ');
}

let cachedCodexStateDbPath = '';

function resolveCodexStateDbPath() {
  if (cachedCodexStateDbPath && fs.existsSync(cachedCodexStateDbPath)) {
    return cachedCodexStateDbPath;
  }
  const codexHome = path.resolve(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'));
  let candidates = [];
  try {
    candidates = fs.readdirSync(codexHome)
      .filter((name) => /^state_\d+\.sqlite$/.test(name))
      .map((name) => path.join(codexHome, name))
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
  cachedCodexStateDbPath = candidates[0] || '';
  return cachedCodexStateDbPath;
}

function quoteSqliteString(value) {
  return `'${String(value || '').replace(/'/g, "''")}'`;
}

function syncCodexThreadTitle(threadId, threadTitle) {
  const targetThreadId = String(threadId || '').trim();
  const nextTitle = String(threadTitle || '').trim();
  if (!targetThreadId || !nextTitle) return false;

  const dbPath = resolveCodexStateDbPath();
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

function readCodexThreadExecutionPolicy(threadId) {
  const targetThreadId = String(threadId || '').trim();
  if (!targetThreadId) return null;

  const dbPath = resolveCodexStateDbPath();
  if (!dbPath) return null;

  const sql = [
    'SELECT sandbox_policy, approval_mode',
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
  };
}

function buildCodexPrompt({
  systemPrompt,
  history,
  userText,
  imageCount = 0,
  cwd = '',
  addDirs = [],
  threadTitle = '',
}) {
  const lines = [];
  const title = String(threadTitle || '').trim();
  if (title) {
    lines.push(title);
    lines.push('');
  }
  lines.push(systemPrompt || DEFAULT_CODEX_SYSTEM_PROMPT);
  lines.push('');
  lines.push(`当前工作目录：${cwd || process.cwd()}`);
  if (Array.isArray(addDirs) && addDirs.length > 0) {
    lines.push('额外可访问工作目录：');
    for (const dir of addDirs) {
      lines.push(`- ${dir}`);
    }
  }
  lines.push('');
  lines.push('对话上下文（按时间顺序，可能为空）：');
  if (!history || history.length === 0) {
    lines.push('(无)');
  } else {
    for (const item of history) {
      const roleLabel = item.role === 'assistant' ? '助手' : '用户';
      lines.push(`[${roleLabel}] ${compactText(item.text, 1200)}`);
    }
  }
  lines.push('');
  lines.push('用户最新消息：');
  lines.push(compactText(userText, 2000));
  if (imageCount > 0) {
    lines.push(`附加图片：${imageCount} 张（请结合图片内容回答）。`);
  }
  lines.push('');
  lines.push('请直接输出给用户的最终回复正文，不要加“好的/收到”等空话，不要复述用户原文。');
  lines.push('禁止输出“稍后回复/几分钟后回复/晚点再回复”这类承诺。无法完成就直接说明卡点和下一步。');
  lines.push('如果 SSH、curl、nc 或其他网络命令失败，不要直接归因于“当前会话不能联网”或“网络策略拦截”。先报告原始报错，再用更小的连通性探测复核后再下结论。');
  lines.push(`如果你需要机器人把本机图片直接发给用户，请在回复中单独占行输出：${FEISHU_SEND_IMAGE_DIRECTIVE_PREFIX}/绝对或相对路径]]`);
  lines.push(`如果你需要机器人把本机文件直接发给用户，请在回复中单独占行输出：${FEISHU_SEND_FILE_DIRECTIVE_PREFIX}/绝对或相对路径]]`);
  lines.push('可以输出多行，每行一个附件。除这些指令外，其他文字都会作为正常回复发送给用户。');
  lines.push(`发送图片前请确认文件真实存在、格式受支持，且大小不超过 ${formatBytes(FEISHU_IMAGE_UPLOAD_LIMIT)}。`);
  lines.push(`发送文件前请确认文件真实存在、不是目录，且大小不超过 ${formatBytes(FEISHU_FILE_UPLOAD_LIMIT)}。`);
  lines.push('如果用户发送了文件，消息正文里会给出本地临时文件路径；需要时请直接读取该文件。');
  return lines.join('\n');
}

function buildCodexResumePrompt({ userText, imageCount = 0 }) {
  const lines = [];
  lines.push('继续当前线程。下面是用户最新消息，请直接回复用户。');
  lines.push('');
  lines.push('用户最新消息：');
  lines.push(compactText(userText, 2000));
  if (imageCount > 0) {
    lines.push(`附加图片：${imageCount} 张（请结合图片内容回答）。`);
  }
  lines.push('');
  lines.push('请直接输出给用户的最终回复正文，不要加“好的/收到”等空话，不要复述用户原文。');
  lines.push('禁止输出“稍后回复/几分钟后回复/晚点再回复”这类承诺。无法完成就直接说明卡点和下一步。');
  lines.push('如果 SSH、curl、nc 或其他网络命令失败，不要直接归因于“当前会话不能联网”或“网络策略拦截”。先报告原始报错，再用更小的连通性探测复核后再下结论。');
  lines.push(`如果你需要机器人把本机图片直接发给用户，请在回复中单独占行输出：${FEISHU_SEND_IMAGE_DIRECTIVE_PREFIX}/绝对或相对路径]]`);
  lines.push(`如果你需要机器人把本机文件直接发给用户，请在回复中单独占行输出：${FEISHU_SEND_FILE_DIRECTIVE_PREFIX}/绝对或相对路径]]`);
  lines.push('可以输出多行，每行一个附件。除这些指令外，其他文字都会作为正常回复发送给用户。');
  return lines.join('\n');
}

function shouldBypassCodexSandbox(sandbox, approvalPolicy) {
  return String(sandbox || '').trim() === 'danger-full-access'
    && String(approvalPolicy || '').trim() === 'never';
}

function runCodexExec({
  bin,
  model,
  reasoningEffort,
  profile,
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
    const resolvedApiKey = String(apiKey || '').trim();
    if (resolvedApiKey) {
      childEnv.OPENAI_API_KEY = resolvedApiKey;
      childEnv.CODEX_API_KEY = resolvedApiKey;
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
      fs.rmSync(tempDir, { recursive: true, force: true });
      reject(new Error(`codex spawn failed: ${err.message}`));
    });

    child.on('close', (code, signal) => {
      if (stdoutJsonBuffer.trim()) flushJsonLine(stdoutJsonBuffer.trim());

      if (code !== 0) {
        const details = compactText(stderr || stdout || `exit=${code}, signal=${signal || ''}`, 1200);
        fs.rmSync(tempDir, { recursive: true, force: true });
        reject(new Error(`codex exec failed: ${details}`));
        return;
      }

      try {
        const reply = fs.readFileSync(outputFile, 'utf8');
        fs.rmSync(tempDir, { recursive: true, force: true });
        resolve({
          reply,
          threadId: observedThreadId,
        });
      } catch (err) {
        fs.rmSync(tempDir, { recursive: true, force: true });
        reject(new Error(`read codex output failed: ${err.message}`));
      }
    });

    child.stdin.write(prompt);
    child.stdin.end();
  });
}

async function generateCodexReply({
  codex,
  history,
  userText,
  imagePaths = [],
  sessionId = '',
  threadTitle = '',
  onSpawn = null,
  onProgressEvent = null,
}) {
  let resolvedSessionId = String(sessionId || '').trim();
  const imageCount = Array.isArray(imagePaths) ? imagePaths.length : 0;
  const runExec = async ({ prompt, resumeSessionId = '' }) => {
    return runCodexExec({
      bin: codex.bin,
      model: codex.model,
      reasoningEffort: codex.reasoningEffort,
      profile: codex.profile,
      cwd: codex.cwd,
      addDirs: codex.addDirs,
      apiKey: codex.apiKey,
      sandbox: codex.sandbox,
      approvalPolicy: codex.approvalPolicy,
      prompt,
      imagePaths,
      resumeSessionId,
      onSpawn,
      onEvent: onProgressEvent,
    });
  };

  if (resolvedSessionId) {
    const existingPolicy = readCodexThreadExecutionPolicy(resolvedSessionId);
    const expectedSandboxType = String(codex.sandbox || '').trim();
    const expectedApprovalMode = String(codex.approvalPolicy || '').trim();
    if (
      !existingPolicy
      || (expectedSandboxType && existingPolicy.sandboxType && existingPolicy.sandboxType !== expectedSandboxType)
      || (expectedApprovalMode && existingPolicy.approvalMode && existingPolicy.approvalMode !== expectedApprovalMode)
    ) {
      console.log(`codex_resume_skip thread_id=${resolvedSessionId} reason=policy_mismatch existing_sandbox=${existingPolicy?.sandboxType || '(unknown)'} existing_approval=${existingPolicy?.approvalMode || '(unknown)'} expected_sandbox=${expectedSandboxType || '(none)'} expected_approval=${expectedApprovalMode || '(none)'}`);
      resolvedSessionId = '';
    }
  }

  if (resolvedSessionId) {
    try {
      const resumed = await runExec({
        prompt: buildCodexResumePrompt({ userText, imageCount }),
        resumeSessionId: resolvedSessionId,
      });
      return {
        reply: String(resumed?.reply || ''),
        threadId: String(resumed?.threadId || resolvedSessionId),
      };
    } catch (err) {
      console.error(`codex_resume=error thread_id=${resolvedSessionId} message=${err.message}`);
    }
  }

  const fresh = await runExec({
    prompt: buildCodexPrompt({
      systemPrompt: codex.systemPrompt,
      history,
      userText,
      imageCount,
      cwd: codex.cwd,
      addDirs: codex.addDirs,
      threadTitle,
    }),
  });

  return {
    reply: String(fresh?.reply || ''),
    threadId: String(fresh?.threadId || ''),
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

async function uploadLocalFileToFeishu(client, localPath) {
  const resolvedPath = path.resolve(String(localPath || ''));
  ensure(fs.existsSync(resolvedPath), `file not found: ${resolvedPath}`);
  const stat = fs.statSync(resolvedPath);
  ensure(stat.isFile(), `not a file: ${resolvedPath}`);
  ensure(stat.size > 0, `file is empty: ${resolvedPath}`);
  ensure(stat.size <= FEISHU_FILE_UPLOAD_LIMIT, `file too large: ${path.basename(resolvedPath)} (${formatBytes(stat.size)} > ${formatBytes(FEISHU_FILE_UPLOAD_LIMIT)})`);

  const uploaded = await client.im.v1.file.create({
    data: {
      file_type: resolveFeishuUploadFileType(resolvedPath),
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
  };
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

async function sendRequestedAttachments(client, chatID, attachments = [], cwd = '', shouldContinue = null) {
  const sent = [];
  const failed = [];

  for (const attachment of attachments || []) {
    if (typeof shouldContinue === 'function' && !shouldContinue()) {
      break;
    }
    const requestedType = attachment?.type === 'image' ? 'image' : 'file';
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
      const uploaded = await uploadLocalFileToFeishu(client, resolvedPath);
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

async function sendCodexReplyPassthrough(client, chatID, rawText, shouldContinue = null) {
  const chunks = splitTextForFeishu(rawText, FEISHU_TEXT_CHUNK_LIMIT);
  let sent = 0;
  for (const chunk of chunks) {
    if (typeof shouldContinue === 'function' && !shouldContinue()) break;
    if (!chunk) continue;
    await sendTextReply(client, chatID, chunk);
    sent += 1;
  }
  return sent;
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

function createMessageProgressReporter({ client, chatID, initialMessage, minUpdateIntervalMs = 700 }) {
  const intro = compactText(String(initialMessage || '').trim() || '已接收，开始执行。', 1200);
  const minInterval = Math.max(300, Number(minUpdateIntervalMs) || 1000);
  const steps = [];
  const startedAt = Date.now();

  let messageID = '';
  let lastRendered = '';
  let closed = false;
  let lastUpdateAt = 0;
  let flushTimer = null;
  let queue = Promise.resolve();

  function runSerial(task) {
    const next = queue
      .catch(() => {})
      .then(task);
    queue = next.catch(() => {});
    return next;
  }

  function render(extraLine = '') {
    const elapsedSec = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
    const lines = [intro, '', `运行中：${elapsedSec}s`];
    if (steps.length > 0) {
      lines.push(`当前步骤：${steps[steps.length - 1]}`);
      lines.push('');
      lines.push('步骤记录：');
      for (let i = 0; i < steps.length; i += 1) {
        lines.push(`${i + 1}. ${steps[i]}`);
      }
    }
    if (extraLine) {
      lines.push('');
      lines.push(extraLine);
    }
    return compactText(lines.join('\n'), 4000).trim();
  }

  async function createNewProgressMessage(text, reason = '') {
    try {
      const created = await sendTextReply(client, chatID, text);
      const newID = String(created?.data?.message_id || '').trim();
      if (!newID) return false;
      messageID = newID;
      lastRendered = text;
      lastUpdateAt = Date.now();
      if (reason) console.log(`progress_rollover=ok reason=${reason}`);
      return true;
    } catch (err) {
      console.error(`progress_rollover=error reason=${reason} message=${err.message}`);
      return false;
    }
  }

  async function ensureMessage() {
    if (messageID) return true;
    return createNewProgressMessage(intro, 'init');
  }

  async function applyText(nextText, logTag = 'progress_apply') {
    const target = compactText(String(nextText || '').trim(), 4000);
    if (!target) return false;
    if (target === lastRendered) return true;

    const ok = await ensureMessage();
    if (!ok || !messageID) return false;

    try {
      await updateTextMessage(client, messageID, target);
      lastRendered = target;
      lastUpdateAt = Date.now();
      return true;
    } catch (err) {
      if (isMessageEditLimitError(err)) {
        return createNewProgressMessage(target, 'platform_edit_limit');
      }
      console.error(`${logTag}=error message=${err.message}`);
      return false;
    }
  }

  function clearTimers() {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
  }

  function scheduleFlush() {
    if (closed) return;
    if (flushTimer) return;
    const elapsed = Date.now() - lastUpdateAt;
    const waitMs = Math.max(0, minInterval - elapsed);
    flushTimer = setTimeout(() => {
      flushTimer = null;
      if (closed) return;
      runSerial(async () => {
        await applyText(render(), 'progress_flush');
      });
    }, waitMs);
  }

  function pushStep(stepText) {
    if (closed) return;
    const normalized = normalizeProgressSnippet(stepText, 120);
    if (!normalized) return;
    if (steps[steps.length - 1] === normalized) return;
    steps.push(normalized);
    while (steps.length > 10) steps.shift();
    if (Date.now() - lastUpdateAt >= minInterval) {
      runSerial(async () => {
        await applyText(render(), 'progress_push');
      });
      return;
    }
    scheduleFlush();
  }

  return {
    async start() {
      await runSerial(async () => {
        await ensureMessage();
      });
    },
    push(stepText) {
      pushStep(stepText);
    },
    recordEvent(event) {
      const stepText = formatCodexProgressEvent(event);
      if (!stepText) return;
      pushStep(stepText);
    },
    async finalizeReply(finalReplyText) {
      if (closed) return false;
      closed = true;
      clearTimers();
      await queue.catch(() => {});

      const finalText = compactText(String(finalReplyText || '').trim(), 4000);
      if (!finalText) return false;
      return runSerial(async () => applyText(finalText, 'progress_finalize'));
    },
    async complete(note = '执行完成，回复见下条消息。') {
      if (closed) return false;
      closed = true;
      clearTimers();
      await queue.catch(() => {});

      const doneNote = normalizeProgressSnippet(note, 160) || '执行完成。';
      return runSerial(async () => applyText(render(doneNote), 'progress_complete'));
    },
    async fail(note = '处理失败。') {
      if (closed) return false;
      closed = true;
      clearTimers();
      await queue.catch(() => {});

      const failText = render(normalizeProgressSnippet(note, 160) || '处理失败。');
      return runSerial(async () => applyText(failText, 'progress_fail'));
    },
    async recordFinalReply() {
      return false;
    },
    async abort() {
      closed = true;
      clearTimers();
      await queue.catch(() => {});
      if (!messageID) return true;
      const target = messageID;
      messageID = '';
      return recallMessageSafe(client, target, 'progress_message_recall');
    },
  };
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
}

async function patchDocTextBlock(client, documentID, blockID, text) {
  if (!documentID || !blockID) return null;
  return client.docx.documentBlock.patch({
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
  const minInterval = Math.max(500, Number(minUpdateIntervalMs) || 1200);
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
      await fallbackReporter.start();
      for (const step of stepHistory) {
        fallbackReporter.push(step);
      }
      if (reason) {
        console.error(`progress_doc_fallback=enabled reason=${reason}${err ? ` message=${err.message}` : ''}`);
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
      console.error(`progress_doc_init=error chat_id=${chatID} message=${err.message}`);
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
      console.error(`progress_doc_status=error document_id=${documentID} message=${err.message}`);
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
        console.error(`progress_doc_append=error document_id=${documentID} message=${err.message}`);
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
  const messageFactory = () => createMessageProgressReporter({
    client,
    chatID,
    initialMessage,
    minUpdateIntervalMs,
  });
  if (progressConfig?.mode === 'doc') {
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
  return messageFactory();
}

async function downloadImageToTempFile(client, messageID, imageKey) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-image-'));
  const filePath = path.join(
    tempDir,
    `${Date.now()}-${Math.random().toString(16).slice(2)}.jpg`
  );
  const resource = await client.im.v1.messageResource.get({
    params: {
      type: 'image',
    },
    path: {
      message_id: messageID,
      file_key: imageKey,
    },
  });
  await resource.writeFile(filePath);
  return { tempDir, filePath };
}

async function downloadFileToTempFile(client, messageID, fileKey, fileName = '') {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-file-'));
  const safeName = sanitizeLocalFileName(fileName, `attachment-${Date.now()}.bin`);
  const filePath = path.join(tempDir, safeName);
  const resource = await client.im.v1.messageResource.get({
    params: {
      type: 'file',
    },
    path: {
      message_id: messageID,
      file_key: fileKey,
    },
  });
  await resource.writeFile(filePath);
  return { tempDir, filePath, fileName: safeName };
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

function createChatTaskControl(chatID) {
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
    chatID,
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
            console.error(`task_cancel_hook=error chat_id=${chatID} message=${err.message}`);
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

function dispatchLatestByChat(chatRunners, chatID, data, handler) {
  let runner = chatRunners.get(chatID);
  if (!runner) {
    runner = {
      activeTask: null,
      pendingData: null,
      draining: false,
    };
    chatRunners.set(chatID, runner);
  }

  runner.pendingData = data;
  if (runner.activeTask) {
    console.log(`chat_task_supersede chat_id=${chatID}`);
    void runner.activeTask.cancel('superseded_by_new_message');
    return;
  }
  if (runner.draining) return;

  runner.draining = true;
  void (async () => {
    try {
      while (runner.pendingData) {
        const nextData = runner.pendingData;
        runner.pendingData = null;
        const taskControl = createChatTaskControl(chatID);
        runner.activeTask = taskControl;
        try {
          await handler(nextData, taskControl);
        } catch (err) {
          if (!isTaskCancelledError(err)) {
            console.error(`chat_task_error chat_id=${chatID} message=${err.message}`);
          }
        } finally {
          runner.activeTask = null;
        }
      }
    } finally {
      runner.draining = false;
      if (!runner.activeTask && !runner.pendingData) {
        chatRunners.delete(chatID);
      }
    }
  })();
}

async function main() {
  ensure(lark, 'missing dependency @larksuiteoapi/node-sdk; run: npm install');

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

  const creds = resolveCredentials(config);
  const codex = resolveCodexConfig(config);
  const speech = resolveSpeechConfig(config, codex);
  const codexDetect = detectCodex(codex.bin);
  const mentionAliases = resolveMentionAliases({
    botName,
    explicitAliases: config.mention_aliases,
    replyPrefix,
    systemPrompt: codex.systemPrompt,
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
    console.log(`typing_indicator=${typing.enabled ? 'true' : 'false'}`);
    console.log(`typing_emoji=${typing.emoji}`);
    console.log(`fake_stream=${fakeStream.enabled ? 'true' : 'false'}`);
    console.log(`fake_stream_interval_ms=${fakeStream.intervalMs}`);
    console.log(`fake_stream_chunk_chars=${fakeStream.chunkChars}`);
    console.log(`fake_stream_max_updates=${fakeStream.maxUpdates}`);
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
    console.log(`codex_profile=${codex.profile || '(default)'}`);
    console.log(`codex_cwd=${codex.cwd || process.cwd()}`);
    console.log(`codex_add_dirs=${codex.addDirs.length > 0 ? codex.addDirs.join(' | ') : '(none)'}`);
    console.log(`codex_sandbox=${codex.sandbox}`);
    console.log(`codex_approval_policy=${codex.approvalPolicy}`);
    console.log(`codex_bypass_sandbox=${shouldBypassCodexSandbox(codex.sandbox, codex.approvalPolicy) ? 'true' : 'false'}`);
    console.log(`codex_timeout_sec=${codex.timeoutSec || '(disabled)'}`);
    console.log(`codex_history_turns=${codex.historyTurns}`);
    console.log(`speech_enabled=${speech.enabled ? 'true' : 'false'}`);
    console.log(`speech_api_key_found=${speech.apiKey ? 'true' : 'false'}`);
    if (speech.apiKeySource) console.log(`speech_api_key_source=${speech.apiKeySource}`);
    console.log(`speech_model=${speech.model}`);
    console.log(`speech_language=${speech.language || '(auto)'}`);
    console.log(`speech_base_url=${speech.baseURL}`);
    console.log(`speech_ffmpeg_bin=${speech.ffmpegBin || '(not found)'}`);
    if (speech.ffmpegVersion) console.log(`speech_ffmpeg_version=${speech.ffmpegVersion}`);
    return;
  }

  ensure(creds.appId.value, `feishu app_id not found for account "${accountName}"`);
  ensure(creds.appSecret.value, `feishu app_secret not found for account "${accountName}"`);
  if (replyMode === 'codex') {
    ensure(codexDetect.found, `codex binary not found: ${codex.bin}`);
  }

  const baseConfig = {
    appId: creds.appId.value,
    appSecret: creds.appSecret.value,
    domain: domain.value,
  };
  const client = new lark.Client(baseConfig);

  const chatStates = new Map();
  const chatRunners = new Map();
  const recentMentionedSenders = new Map();

  async function handleMessageEvent(data, taskControl = createChatTaskControl('')) {
    const eventData = data || {};
    const senderOpenID = eventData?.sender?.sender_id?.open_id || '';
    const senderType = eventData?.sender?.sender_type || '';
    const message = eventData?.message || {};
    const chatID = message.chat_id || '';
    const chatType = String(message.chat_type || '').trim().toLowerCase();
    const messageID = message.message_id || '';
    const messageType = message.message_type || '';
    const mentions = Array.isArray(message.mentions) ? message.mentions : [];
    const parsedText = messageType === 'text' ? parseMessageText(message.content || '') : '';
    const parsedFile = messageType === 'file' ? parseFileMessageContent(message.content || '') : { fileKey: '', fileName: '', fileSize: 0 };
    const parsedAudio = messageType === 'audio' ? parseAudioMessageContent(message.content || '') : { fileKey: '', durationMs: 0 };
    const parsedPost = messageType === 'post' ? parsePostContent(message.content || '') : { text: '', imageKeys: [] };
    const normalizedMessageText = messageType === 'post' ? parsedPost.text : parsedText;
    const textMentionAlias = detectTextualBotMention(normalizedMessageText, mentionAliases);
    const mentionMatchedByText = Boolean(textMentionAlias);
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
    pruneMentionCarryState(recentMentionedSenders, now);
    const recentMentionState = groupChat && !botMentioned && !mentionMatchedByMentionName && !mentionMatchedByText
      ? getRecentMentionState(recentMentionedSenders, chatID, senderOpenID, now)
      : null;
    const mentionMatchedByCarry = Boolean(
      recentMentionState && (messageType === 'file' || messageType === 'image' || messageType === 'post' || messageType === 'audio')
    );

    console.log('FEISHU_EVENT');
    console.log('event=im.message.receive_v1');
    console.log(`chat_id=${chatID}`);
    console.log(`chat_type=${chatType || '(unknown)'}`);
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
      console.log(`mention_fallback=recent_sender_window age_ms=${now - recentMentionState.timestamp}`);
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
    const mentionGateActive = mentionConfig.requireMention && (!mentionConfig.groupOnly || groupChat);
    if (mentionGateActive && !botMentioned && !mentionMatchedByMentionName && !mentionMatchedByText && !mentionMatchedByCarry) {
      console.log('skip_reason=require_mention_not_met');
      console.log(`mention_count=${mentions.length}`);
      console.log(`text_has_at=${/[@＠]/.test(String(normalizedMessageText || '')) ? 'true' : 'false'}`);
      return;
    }
    if (groupChat && senderOpenID && (botMentioned || mentionMatchedByMentionName || mentionMatchedByText)) {
      rememberRecentMention(recentMentionedSenders, chatID, senderOpenID, textMentionAlias, now);
    }

    const tempPathsToCleanup = [];
    const imagePaths = [];
    const fileAttachments = [];
    let userText = '';
    let historyUserText = '';

    const incomingText = compactText(text, 4000).trim();
    if (messageType === 'file') {
      if (!parsedFile.fileKey) {
        console.log('skip_reason=missing_file_key');
        await sendTextReplySafe(client, chatID, '文件接收失败，请重新发送。', 'file_download_reply');
        return;
      }
      try {
        const downloaded = await downloadFileToTempFile(client, messageID, parsedFile.fileKey, parsedFile.fileName);
        fileAttachments.push({
          fileName: downloaded.fileName,
          filePath: downloaded.filePath,
          fileSize: parsedFile.fileSize,
        });
        tempPathsToCleanup.push(downloaded.tempDir);
      } catch (err) {
        console.error(`file_download=error key=${parsedFile.fileKey} message=${err.message}`);
        await sendTextReplySafe(client, chatID, '文件下载失败，请稍后重试。', 'file_download_reply');
        return;
      }

      const file = fileAttachments[0];
      const lines = [];
      if (incomingText) {
        lines.push(`用户发送了 1 个文件，并附带文字：${incomingText}`);
      } else {
        lines.push('用户发送了 1 个文件，请先读取文件内容再回答。');
      }
      lines.push(`文件名：${file.fileName}`);
      if (file.fileSize > 0) lines.push(`文件大小：${formatBytes(file.fileSize)}`);
      lines.push(`本地临时路径：${file.filePath}`);
      lines.push('如需使用文件内容，请直接读取该本地文件。');
      userText = lines.join('\n');
      historyUserText = incomingText
        ? `[文件消息] ${file.fileName} + 文本：${incomingText}`
        : `[文件消息] ${file.fileName}`;
    } else if (messageType === 'audio') {
      if (!parsedAudio.fileKey) {
        console.log('skip_reason=missing_audio_key');
        await sendTextReplySafe(client, chatID, '语音接收失败，请重新发送。', 'audio_download_reply');
        return;
      }

      let downloadedAudio = null;
      try {
        downloadedAudio = await downloadAudioToTempFile(client, messageID, parsedAudio.fileKey);
        tempPathsToCleanup.push(downloadedAudio.tempDir);
      } catch (err) {
        console.error(`audio_download=error key=${parsedAudio.fileKey} message=${err.message}`);
        await sendTextReplySafe(client, chatID, '语音下载失败，请稍后重试。', 'audio_download_reply');
        return;
      }

      let transcript = null;
      try {
        transcript = await transcribeAudioMessage(downloadedAudio.filePath, speech);
      } catch (err) {
        console.error(`audio_transcription=error path=${downloadedAudio.filePath} message=${err.message}`);
        const missingFfmpeg = !speech.ffmpegBin
          && /ffmpeg/i.test(String(err.message || ''));
        const detail = missingFfmpeg
          ? '当前环境缺少语音转码能力，请保留 bundled ffmpeg-static 或安装 ffmpeg 后重试。'
          : '语音转写失败，请检查 speech.api_key / 网络后重试。';
        await sendTextReplySafe(client, chatID, detail, 'audio_transcription_reply');
        return;
      }

      const durationText = formatDurationFromMs(parsedAudio.durationMs);
      const voiceLines = [];
      if (durationText) voiceLines.push(`用户发送了 1 条语音消息，时长约 ${durationText}。`);
      else voiceLines.push('用户发送了 1 条语音消息。');
      voiceLines.push('下面是语音转写结果（可能存在少量识别误差）：');
      voiceLines.push(transcript.text);
      voiceLines.push('请基于语音内容直接回答用户。');
      userText = voiceLines.join('\n');
      historyUserText = compactText(
        `[语音消息${durationText ? ` ${durationText}` : ''}] ${transcript.text}`,
        4000
      );
    } else if (normalizedImageKeys.length === 0) {
      userText = incomingText;
      if (!userText) {
        console.log('skip_reason=empty_text');
        return;
      }
      historyUserText = userText;
    } else {
      const acceptedImageKeys = normalizedImageKeys.slice(0, MAX_IMAGE_INPUTS);
      const ignoredImages = Math.max(0, normalizedImageKeys.length - acceptedImageKeys.length);

      for (const imageKey of acceptedImageKeys) {
        try {
          const downloaded = await downloadImageToTempFile(client, messageID, imageKey);
          imagePaths.push(downloaded.filePath);
          tempPathsToCleanup.push(downloaded.tempDir);
        } catch (err) {
          console.error(`image_download=error key=${imageKey} message=${err.message}`);
        }
      }

      if (imagePaths.length === 0) {
        await sendTextReplySafe(client, chatID, '图片接收失败，请稍后重试。', 'image_download_reply');
        return;
      }

      if (incomingText) {
        userText = [
          `用户发送了 ${imagePaths.length} 张图片，并附带文字：`,
          incomingText,
          '请结合文字和图片内容回答。',
        ].join('\n');
        historyUserText = `[图片消息 ${imagePaths.length} 张 + 文本] ${incomingText}`;
      } else {
        userText = `用户发送了 ${imagePaths.length} 张图片，请直接分析图片内容并给出有帮助的回复。`;
        historyUserText = `[图片消息] 用户发送了 ${imagePaths.length} 张图片`;
      }
      if (ignoredImages > 0) {
        userText = `${userText}\n注意：同一条消息中额外 ${ignoredImages} 张图片已忽略。`;
      }
    }

    const chatState = ensureChatState(chatStates, chatID);
    if (messageType === 'text') {
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
      if (replyMode === 'codex') {
        const currentThread = getCurrentThread(chatState);
        if (!currentThread) {
          throw new Error('current thread not found');
        }
        const history = currentThread.history || [];
        const codexThreadTitle = buildCodexThreadTitle({
          botName: botName || accountName,
          localThreadName: currentThread.name || currentThread.id,
          userText: historyUserText || userText,
        });
        const codexReply = await generateCodexReply({
          codex,
          history,
          userText,
          imagePaths,
          sessionId: currentThread.codexThreadId,
          threadTitle: codexThreadTitle,
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
          const synced = syncCodexThreadTitle(codexReply.threadId, codexThreadTitle);
          console.log(`codex_thread_title_sync=${synced ? 'ok' : 'skip'} thread_id=${codexReply.threadId}`);
          console.log(`codex_thread_id=${codexReply.threadId} chat_id=${chatID} bot=${JSON.stringify(botName || accountName)} local_thread=${currentThread.id}`);
        }
      } else {
        replyText = normalizeReplyText(replyPrefix, userText);
      }
      const codexRawReply = String(replyText || '').replace(/\r/g, '');
      if (replyMode === 'codex') {
        const attachmentPlan = extractFeishuAttachmentDirectives(codexRawReply);
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
          () => !taskControl.isCancelled()
        );
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
          throw new Error('echo reply empty');
        }
        if (fakeStream.enabled) {
          await sendTextReplyWithFakeStream(client, chatID, echoReply, fakeStream);
        } else {
          await sendTextReply(client, chatID, echoReply);
        }
      }
      if (replyMode === 'codex' && codex.historyTurns > 0) {
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
        const maxItems = codex.historyTurns * 2;
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
      console.error(`reply=error mode=${replyMode} message=${err.message}`);
      if (progressReporter) {
        await progressReporter.fail(`处理失败：${err.message}`);
      }
    } finally {
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
      const chatID = data?.message?.chat_id || 'unknown';
      dispatchLatestByChat(chatRunners, chatID, data, handleMessageEvent);
    },
  });

  const wsClient = new lark.WSClient({
    ...baseConfig,
    autoReconnect: true,
    loggerLevel: lark.LoggerLevel.info,
  });

  let stopping = false;
  function stop(signal) {
    if (stopping) return;
    stopping = true;
    console.log(`FEISHU_WS_STOP signal=${signal}`);
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
  console.log(`typing_indicator=${typing.enabled ? 'true' : 'false'}`);
  console.log(`fake_stream=${fakeStream.enabled ? 'true' : 'false'}`);
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
    console.log(`codex_profile=${codex.profile || '(default)'}`);
    console.log(`codex_cwd=${codex.cwd || process.cwd()}`);
    console.log(`codex_add_dirs=${codex.addDirs.length > 0 ? codex.addDirs.join(' | ') : '(none)'}`);
  console.log(`codex_sandbox=${codex.sandbox}`);
  console.log(`codex_approval_policy=${codex.approvalPolicy}`);
  console.log(`codex_bypass_sandbox=${shouldBypassCodexSandbox(codex.sandbox, codex.approvalPolicy) ? 'true' : 'false'}`);
  console.log(`codex_timeout_sec=${codex.timeoutSec || '(disabled)'}`);
  console.log(`codex_history_turns=${codex.historyTurns}`);
  }
  console.log(`speech_enabled=${speech.enabled ? 'true' : 'false'}`);
  console.log(`speech_model=${speech.model}`);
  console.log(`speech_language=${speech.language || '(auto)'}`);
  console.log(`speech_base_url=${speech.baseURL}`);
  console.log(`speech_api_key_found=${speech.apiKey ? 'true' : 'false'}`);
  if (speech.apiKeySource) console.log(`speech_api_key_source=${speech.apiKeySource}`);
  console.log(`speech_ffmpeg_bin=${speech.ffmpegBin || '(not found)'}`);
  if (speech.ffmpegVersion) console.log(`speech_ffmpeg_version=${speech.ffmpegVersion}`);
}

main().catch((err) => {
  console.error('ERROR:', err.message);
  process.exit(1);
});
