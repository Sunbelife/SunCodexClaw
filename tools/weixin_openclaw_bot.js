#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const {
  deepMerge,
  readConfigEntry,
  resolveSecretsFile,
  upsertConfigEntry,
} = require('./lib/local_secret_store');
const {
  compactText,
  ensure,
  generateCodexReply,
  normalizeString,
  resolveCodexConfig,
} = require('./lib/studio_runtime_support');
const {
  downloadWeixinAttachments,
  getMimeFromFilename,
  sendWeixinMediaFile,
} = require('./lib/openclaw_weixin_media');
const {
  DEFAULT_BASE_URL,
  DEFAULT_BOT_TYPE,
  DEFAULT_LONG_POLL_TIMEOUT_MS,
  DEFAULT_QR_POLL_TIMEOUT_MS,
  extractInboundText,
  fetchLoginQr,
  getTypingTicket,
  getUpdates,
  hasUnsupportedInboundMedia,
  pollLoginStatus,
  sendTypingStatus,
  sendWeixinText,
  shouldHandleInboundMessage,
  splitTextForWeixin,
} = require('./lib/openclaw_weixin_client');

const REPO_DIR = path.resolve(__dirname, '..');
const DEFAULT_CONFIG_DIR = path.join(REPO_DIR, 'config', 'weixin_openclaw');
const RUNTIME_DIR = path.join(REPO_DIR, '.runtime', 'weixin_openclaw');
const DEFAULT_CODEX_SYSTEM_PROMPT = [
  '你是“微信 Codex 助手”，通过微信和用户交流。',
  '请直接回答用户问题，不要复述用户原话。',
  '如果信息不足，先给最可执行的下一步，再明确缺少什么。',
  '不要承诺“稍后回复”或“几分钟后回复”；必须在当前这一条里给出可执行结果，或明确失败原因。',
  '默认使用简体中文，除非用户明确要求其他语言。',
].join('\n');
const SESSION_EXPIRED_ERRCODE = -14;
const WEIXIN_SEND_FILE_DIRECTIVE_PREFIX = '[[WEIXIN_SEND_FILE:';
const WEIXIN_SEND_IMAGE_DIRECTIVE_PREFIX = '[[WEIXIN_SEND_IMAGE:';

function getArg(flag, fallback = '') {
  const idx = process.argv.indexOf(flag);
  if (idx >= 0 && idx + 1 < process.argv.length) return process.argv[idx + 1];
  return fallback;
}

function hasFlag(flag) {
  return process.argv.includes(flag);
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readJsonIfExists(filePath) {
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function resolveOptionalDir(raw) {
  const value = normalizeString(raw);
  return value ? path.resolve(value) : '';
}

function resolveOptionalDirList(value) {
  const parts = Array.isArray(value)
    ? value
    : String(value || '').split(new RegExp(`[\\n,${path.delimiter.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}]`, 'g'));
  const output = [];
  for (const part of parts) {
    const resolved = resolveOptionalDir(part);
    if (!resolved || output.includes(resolved)) continue;
    output.push(resolved);
  }
  return output;
}

function loadWeixinConfig(accountName, configDir) {
  const defaultPath = path.resolve(configDir, 'default.json');
  const defaultConfig = deepMerge(
    readJsonIfExists(defaultPath) || {},
    readConfigEntry('weixin_openclaw', 'default', {})
  );
  const chosen = normalizeString(accountName) || 'default';
  if (chosen === 'default') {
    return {
      accountName: chosen,
      config: defaultConfig,
      configPath: fs.existsSync(defaultPath) ? defaultPath : resolveSecretsFile(),
    };
  }

  const accountPath = path.resolve(configDir, `${chosen}.json`);
  const accountConfig = readJsonIfExists(accountPath);
  const yamlConfig = readConfigEntry('weixin_openclaw', chosen, {});
  ensure(
    accountConfig || Object.keys(yamlConfig).length > 0 || Object.keys(defaultConfig).length > 0,
    `weixin_openclaw config not found: ${accountPath}`
  );
  return {
    accountName: chosen,
    config: deepMerge(defaultConfig, accountConfig || {}, yamlConfig),
    configPath: fs.existsSync(accountPath) ? accountPath : resolveSecretsFile(),
  };
}

function resolveWeixinRuntimeConfig(config) {
  const codexRaw = { ...(config.codex || {}) };
  codexRaw.cwd = resolveOptionalDir(codexRaw.cwd);
  codexRaw.add_dirs = resolveOptionalDirList(codexRaw.add_dirs || codexRaw.addDirs || []);
  if (!normalizeString(codexRaw.system_prompt)) {
    codexRaw.system_prompt = DEFAULT_CODEX_SYSTEM_PROMPT;
  }
  if (!String(codexRaw.system_prompt || '').includes(WEIXIN_SEND_IMAGE_DIRECTIVE_PREFIX)) {
    codexRaw.system_prompt = [
      String(codexRaw.system_prompt || '').trim(),
      '微信回复要求：',
      `1. 如果需要把本机图片发给用户，请单独占行输出 ${WEIXIN_SEND_IMAGE_DIRECTIVE_PREFIX}/绝对或相对路径]]。`,
      `2. 如果需要把本机文件发给用户，请单独占行输出 ${WEIXIN_SEND_FILE_DIRECTIVE_PREFIX}/绝对或相对路径]]。`,
      '3. 除附件指令外，其他文字都会原样发送给微信用户。',
    ].filter(Boolean).join('\n');
  }

  return {
    botName: normalizeString(config.bot_name) || '微信 Codex 助手',
    baseUrl: normalizeString(process.env.WEIXIN_OPENCLAW_BASE_URL || config.base_url) || DEFAULT_BASE_URL,
    token: normalizeString(process.env.WEIXIN_OPENCLAW_TOKEN || config.token),
    routeTag: normalizeString(process.env.WEIXIN_OPENCLAW_ROUTE_TAG || config.route_tag),
    accountId: normalizeString(config.account_id),
    userId: normalizeString(config.user_id),
    botType: normalizeString(config.bot_type) || DEFAULT_BOT_TYPE,
    autoReply: asBool(process.env.WEIXIN_OPENCLAW_AUTO_REPLY || config.auto_reply, true),
    typingNotice: asBool(process.env.WEIXIN_OPENCLAW_TYPING_NOTICE || config.typing_notice, true),
    unsupportedMediaReply:
      normalizeString(config.unsupported_media_reply)
      || '当前接入版支持文本、图片、文件；语音和视频还没接完。',
    longPollTimeoutMs: asInt(
      process.env.WEIXIN_OPENCLAW_LONG_POLL_TIMEOUT_MS || config.long_poll_timeout_ms,
      DEFAULT_LONG_POLL_TIMEOUT_MS,
      5000,
      60_000
    ),
    qrPollTimeoutMs: asInt(
      process.env.WEIXIN_OPENCLAW_QR_POLL_TIMEOUT_MS || config.qr_poll_timeout_ms,
      DEFAULT_QR_POLL_TIMEOUT_MS,
      5000,
      60_000
    ),
    retryDelayMs: asInt(
      process.env.WEIXIN_OPENCLAW_RETRY_DELAY_MS || config.retry_delay_ms,
      3000,
      500,
      60_000
    ),
    loginTimeoutMs: asInt(
      process.env.WEIXIN_OPENCLAW_LOGIN_TIMEOUT_MS || config.login_timeout_ms,
      8 * 60_000,
      10_000,
      30 * 60_000
    ),
    codex: resolveCodexConfig({ codex: codexRaw }),
  };
}

function resolveLocalFilePath(raw, cwd = '') {
  let value = String(raw || '').trim();
  if (!value) return '';
  value = value.replace(/^['"]+|['"]+$/g, '').trim();
  if (!value) return '';
  return path.isAbsolute(value) ? path.resolve(value) : path.resolve(cwd || process.cwd(), value);
}

function extractWeixinAttachmentDirectives(rawText, cwd = '') {
  const lines = String(rawText || '').replace(/\r/g, '').split('\n');
  const attachments = [];
  const keptLines = [];
  const seen = new Set();
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.endsWith(']]') && trimmed.startsWith(WEIXIN_SEND_FILE_DIRECTIVE_PREFIX)) {
      const payload = trimmed.slice(WEIXIN_SEND_FILE_DIRECTIVE_PREFIX.length, -2).trim();
      const resolvedPath = resolveLocalFilePath(payload, cwd);
      if (resolvedPath && !seen.has(`file:${resolvedPath}`)) {
        seen.add(`file:${resolvedPath}`);
        attachments.push({ type: 'file', path: resolvedPath });
      }
      continue;
    }
    if (trimmed.endsWith(']]') && trimmed.startsWith(WEIXIN_SEND_IMAGE_DIRECTIVE_PREFIX)) {
      const payload = trimmed.slice(WEIXIN_SEND_IMAGE_DIRECTIVE_PREFIX.length, -2).trim();
      const resolvedPath = resolveLocalFilePath(payload, cwd);
      if (resolvedPath && !seen.has(`image:${resolvedPath}`)) {
        seen.add(`image:${resolvedPath}`);
        attachments.push({ type: 'image', path: resolvedPath });
      }
      continue;
    }
    keptLines.push(line);
  }
  return {
    text: keptLines.join('\n').replace(/\n{3,}/g, '\n\n').trim(),
    attachments,
  };
}

function buildDefaultAttachmentReply(attachments = []) {
  const imageCount = attachments.filter((item) => item.type === 'image').length;
  const fileCount = attachments.filter((item) => item.type === 'file').length;
  if (imageCount > 0 && fileCount === 0) return '图片已发送，请查收。';
  if (fileCount > 0 && imageCount === 0) return '文件已发送，请查收。';
  if (fileCount > 0 || imageCount > 0) return '图片和文件已发送，请查收。';
  return '';
}

function buildAttachmentSendFailureReply(sent = [], failed = []) {
  if (failed.length === 0) return '';
  const details = failed.map((item) => `${path.basename(item.path)}（${item.error}）`).join('；');
  if (sent.length === 0) {
    return compactText(`附件发送失败：${details}`, 4000);
  }
  return compactText(`部分附件发送失败：${details}`, 4000);
}

async function sendWeixinAttachments(config, userId, contextToken, attachments) {
  const sent = [];
  const failed = [];
  for (const attachment of attachments) {
    try {
      if (!fs.existsSync(attachment.path)) {
        throw new Error('文件不存在');
      }
      await sendWeixinMediaFile({
        baseUrl: config.baseUrl,
        token: config.token,
        routeTag: config.routeTag,
        to: userId,
        contextToken,
        filePath: attachment.path,
      });
      sent.push(attachment);
    } catch (err) {
      failed.push({
        ...attachment,
        error: compactText(err?.message || String(err), 180),
      });
    }
  }
  return { sent, failed };
}

function buildInboundUserText(textBody, downloadedAttachments = []) {
  const lines = [];
  if (textBody) lines.push(textBody);
  if (downloadedAttachments.length > 0) {
    if (!textBody) lines.push('用户发送了附件。');
    lines.push('');
    lines.push('用户还发送了这些附件，已下载到本地：');
    for (const attachment of downloadedAttachments) {
      lines.push(`- ${attachment.summary}`);
    }
  }
  return lines.join('\n').trim();
}

function resolveRuntimePaths(accountName) {
  const safeAccount = normalizeString(accountName) || 'default';
  const accountDir = path.join(RUNTIME_DIR, safeAccount);
  return {
    accountDir,
    stateFile: path.join(accountDir, 'state.json'),
  };
}

function normalizePeerState(peer) {
  if (!peer || typeof peer !== 'object' || Array.isArray(peer)) {
    return {
      codexThreadId: '',
      contextToken: '',
      history: [],
      lastInboundAt: 0,
    };
  }
  return {
    codexThreadId: normalizeString(peer.codexThreadId),
    contextToken: normalizeString(peer.contextToken),
    history: Array.isArray(peer.history)
      ? peer.history
        .filter((item) => item && typeof item === 'object')
        .map((item) => ({
          role: item.role === 'assistant' ? 'assistant' : 'user',
          text: String(item.text || ''),
        }))
      : [],
    lastInboundAt: Number(peer.lastInboundAt) || 0,
  };
}

function loadState(paths) {
  const existing = readJsonIfExists(paths.stateFile);
  const peers = {};
  for (const [peerId, value] of Object.entries(existing?.peers || {})) {
    peers[peerId] = normalizePeerState(value);
  }
  return {
    syncCursor: normalizeString(existing?.syncCursor),
    peers,
  };
}

function saveState(paths, state) {
  fs.mkdirSync(paths.accountDir, { recursive: true });
  fs.writeFileSync(paths.stateFile, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

function trimHistory(history, historyTurns) {
  const maxItems = Math.max(0, Number(historyTurns || 0)) * 2;
  if (!maxItems) return [];
  return history.slice(-maxItems);
}

function upsertHistory(peerState, userText, assistantText, historyTurns) {
  peerState.history = trimHistory([
    ...peerState.history,
    { role: 'user', text: String(userText || '') },
    { role: 'assistant', text: String(assistantText || '') },
  ], historyTurns);
}

async function sendReplyChunks(config, userId, contextToken, rawText) {
  const chunks = splitTextForWeixin(rawText);
  if (chunks.length === 0) return;
  for (const chunk of chunks) {
    await sendWeixinText({
      baseUrl: config.baseUrl,
      token: config.token,
      routeTag: config.routeTag,
      to: userId,
      text: chunk,
      contextToken,
    });
  }
}

async function startTypingIfPossible(config, userId, contextToken, ticketCache) {
  if (!config.typingNotice) return null;
  const cacheKey = `${userId}::${contextToken}`;
  let typingTicket = normalizeString(ticketCache.get(cacheKey));
  if (!typingTicket) {
    typingTicket = await getTypingTicket({
      baseUrl: config.baseUrl,
      token: config.token,
      routeTag: config.routeTag,
      ilinkUserId: userId,
      contextToken,
    }).catch(() => '');
    if (typingTicket) ticketCache.set(cacheKey, typingTicket);
  }
  if (!typingTicket) return null;
  await sendTypingStatus({
    baseUrl: config.baseUrl,
    token: config.token,
    routeTag: config.routeTag,
    ilinkUserId: userId,
    typingTicket,
    status: 1,
  }).catch(() => {});
  return { userId, typingTicket };
}

async function stopTypingIfPossible(config, typingState) {
  if (!typingState?.typingTicket || !typingState?.userId) return;
  await sendTypingStatus({
    baseUrl: config.baseUrl,
    token: config.token,
    routeTag: config.routeTag,
    ilinkUserId: typingState.userId,
    typingTicket: typingState.typingTicket,
    status: 2,
  }).catch(() => {});
}

function buildThreadTitle(userId) {
  return `微信线程 | ${userId}`;
}

async function handleInboundMessage({
  message,
  state,
  config,
  dryRun = false,
  ticketCache,
  paths,
}) {
  const userId = normalizeString(message?.from_user_id);
  if (!userId) return false;

  const peerState = normalizePeerState(state.peers[userId]);
  state.peers[userId] = peerState;

  const contextToken = normalizeString(message?.context_token) || peerState.contextToken;
  const textBody = extractInboundText(message);
  const downloadedAttachments = dryRun
    ? []
    : await downloadWeixinAttachments({
      message,
      destDir: path.join(paths.accountDir, 'inbound'),
    }).catch((err) => {
      console.error(`weixin_media_download_error=${compactText(err?.message || String(err), 240)}`);
      return [];
    });
  peerState.contextToken = contextToken || peerState.contextToken;
  peerState.lastInboundAt = Date.now();

  if (!contextToken) {
    console.warn(`weixin_context_missing from=${userId}`);
    return false;
  }

  const userText = buildInboundUserText(textBody, downloadedAttachments);
  if (!userText) return false;
  if (!config.autoReply) return false;

  console.log(`weixin_inbound from=${userId} text=${JSON.stringify(compactText(userText, 160))} attachments=${downloadedAttachments.length}`);
  if (dryRun) return true;

  const typingState = await startTypingIfPossible(config, userId, contextToken, ticketCache);
  try {
    const codexReply = await generateCodexReply({
      codex: config.codex,
      history: peerState.history,
      userText,
      sessionId: peerState.codexThreadId,
      threadTitle: buildThreadTitle(userId),
    });
    const replyPlan = extractWeixinAttachmentDirectives(codexReply.reply, config.codex.cwd || process.cwd());
    let replyText = normalizeString(replyPlan.text);
    if (!replyText && replyPlan.attachments.length === 0) {
      replyText = '我收到这条消息了，但这次没有生成可以发送的正文。';
    }
    if (replyText) {
      await sendReplyChunks(config, userId, contextToken, replyText);
    }
    const attachmentSendResult = await sendWeixinAttachments(config, userId, contextToken, replyPlan.attachments);
    if (!replyText && attachmentSendResult.sent.length > 0) {
      replyText = buildDefaultAttachmentReply(attachmentSendResult.sent);
      if (replyText) {
        await sendReplyChunks(config, userId, contextToken, replyText);
      }
    }
    const attachmentFailureReply = buildAttachmentSendFailureReply(attachmentSendResult.sent, attachmentSendResult.failed);
    if (attachmentFailureReply) {
      await sendReplyChunks(config, userId, contextToken, attachmentFailureReply);
    }
    peerState.codexThreadId = normalizeString(codexReply.threadId) || peerState.codexThreadId;
    const historyReplyText = [replyText]
      .filter(Boolean)
      .join('\n')
      .trim();
    upsertHistory(peerState, userText, historyReplyText, config.codex.historyTurns);
    return true;
  } catch (err) {
    const messageText = `处理失败：${compactText(err?.message || String(err), 240)}`;
    await sendReplyChunks(config, userId, contextToken, messageText).catch(() => {});
    return false;
  } finally {
    await stopTypingIfPossible(config, typingState);
  }
}

function printQrHint(qrcodeUrl) {
  console.log(`二维码链接：${qrcodeUrl}`);
  try {
    // Optional dependency. When unavailable, the URL is still enough to complete login.
    // eslint-disable-next-line global-require, import/no-extraneous-dependencies
    const qrcodeTerminal = require('qrcode-terminal');
    qrcodeTerminal.generate(qrcodeUrl, { small: true });
  } catch (_) {
    console.log('当前环境未安装 qrcode-terminal，已输出二维码链接。');
  }
}

async function runLoginFlow(accountName, config) {
  const qr = await fetchLoginQr({
    baseUrl: config.baseUrl,
    botType: config.botType,
    routeTag: config.routeTag,
  });
  ensure(qr.qrcode && qr.qrcodeUrl, '没有拿到可用二维码');
  printQrHint(qr.qrcodeUrl);

  if (hasFlag('--no-wait')) {
    console.log('已输出二维码，稍后重新执行登录命令继续等待确认。');
    return;
  }

  const deadline = Date.now() + config.loginTimeoutMs;
  let scannedPrinted = false;
  while (Date.now() < deadline) {
    const status = await pollLoginStatus({
      baseUrl: config.baseUrl,
      qrcode: qr.qrcode,
      routeTag: config.routeTag,
      timeoutMs: config.qrPollTimeoutMs,
    });
    if (status.status === 'wait') {
      process.stdout.write('.');
      continue;
    }
    if (status.status === 'scaned') {
      if (!scannedPrinted) {
        scannedPrinted = true;
        process.stdout.write('\n已扫码，等微信里确认授权...\n');
      }
      continue;
    }
    if (status.status === 'confirmed' && status.botToken) {
      process.stdout.write('\n');
      const saved = upsertConfigEntry('weixin_openclaw', accountName, {
        token: status.botToken,
        base_url: status.baseUrl || config.baseUrl,
        account_id: status.accountId || config.accountId,
        user_id: status.userId || config.userId,
        bot_type: config.botType,
        route_tag: config.routeTag,
      });
      console.log(`微信接入已保存：${saved.filePath}`);
      if (status.accountId) console.log(`account_id=${status.accountId}`);
      if (status.userId) console.log(`user_id=${status.userId}`);
      return;
    }
    if (status.status === 'expired') {
      throw new Error('二维码已过期，请重新执行登录');
    }
  }
  throw new Error('登录超时，请重新执行登录');
}

async function pollOnce({ state, paths, config, dryRun, ticketCache }) {
  const response = await getUpdates({
    baseUrl: config.baseUrl,
    token: config.token,
    routeTag: config.routeTag,
    cursor: state.syncCursor,
    timeoutMs: config.longPollTimeoutMs,
  });

  if (Number(response?.errcode) === SESSION_EXPIRED_ERRCODE) {
    throw new Error('微信会话已失效，需要重新扫码登录');
  }
  if (normalizeString(response?.get_updates_buf)) {
    state.syncCursor = normalizeString(response.get_updates_buf);
  }

  let changed = false;
  for (const message of response?.msgs || []) {
    if (!shouldHandleInboundMessage(message)) continue;
    const handled = await handleInboundMessage({
      message,
      state,
      config,
      dryRun,
      ticketCache,
      paths,
    });
    changed = changed || handled;
  }

  if (changed || normalizeString(response?.get_updates_buf)) {
    saveState(paths, state);
  }
}

function printHelp() {
  console.log([
    '用法: node tools/weixin_openclaw_bot.js [选项]',
    '',
    '选项:',
    '  --account <name>        配置账号名，默认 default',
    '  --config-dir <dir>      配置目录，默认 config/weixin_openclaw',
    '  --login                 发起微信扫码登录并写回 secrets',
    '  --no-wait               配合 --login 使用，只输出二维码不等待确认',
    '  --once                  只轮询一轮消息后退出',
    '  --dry-run               只打印收到的消息，不真正调用 Codex 和回复',
    '  --help                  显示帮助',
  ].join('\n'));
}

async function main() {
  if (hasFlag('--help') || hasFlag('-h')) {
    printHelp();
    return;
  }

  const accountName = normalizeString(getArg('--account', 'default')) || 'default';
  const configDir = path.resolve(getArg('--config-dir', DEFAULT_CONFIG_DIR));
  const dryRun = hasFlag('--dry-run');
  const runOnce = hasFlag('--once');

  const loaded = loadWeixinConfig(accountName, configDir);
  const config = resolveWeixinRuntimeConfig(loaded.config);
  const paths = resolveRuntimePaths(accountName);
  const state = loadState(paths);

  console.log(`weixin_account=${accountName}`);
  console.log(`weixin_config_path=${loaded.configPath}`);
  console.log(`weixin_base_url=${config.baseUrl}`);
  console.log(`weixin_token_found=${config.token ? 'true' : 'false'}`);
  console.log(`codex_cwd=${config.codex.cwd || process.cwd()}`);

  if (hasFlag('--login')) {
    await runLoginFlow(accountName, config);
    return;
  }

  ensure(config.token, '缺少微信 token，请先运行 --login 完成扫码');

  const ticketCache = new Map();
  do {
    try {
      await pollOnce({
        state,
        paths,
        config,
        dryRun,
        ticketCache,
      });
    } catch (err) {
      console.error(`weixin_poll_error=${compactText(err?.message || String(err), 300)}`);
      if (runOnce) throw err;
      await sleep(config.retryDelayMs);
    }
    if (runOnce) break;
  } while (true);
}

main().catch((err) => {
  console.error(err?.stack || err?.message || String(err));
  process.exit(1);
});
