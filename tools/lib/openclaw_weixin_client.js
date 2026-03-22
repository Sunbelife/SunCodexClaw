const crypto = require('crypto');

const DEFAULT_BASE_URL = 'https://ilinkai.weixin.qq.com';
const DEFAULT_BOT_TYPE = '3';
const DEFAULT_LONG_POLL_TIMEOUT_MS = 35_000;
const DEFAULT_API_TIMEOUT_MS = 15_000;
const DEFAULT_CONFIG_TIMEOUT_MS = 10_000;
const DEFAULT_QR_POLL_TIMEOUT_MS = 35_000;
const WEIXIN_TEXT_CHUNK_LIMIT = 4000;

const MESSAGE_TYPE_USER = 1;
const MESSAGE_TYPE_BOT = 2;
const MESSAGE_ITEM_TYPE_TEXT = 1;
const MESSAGE_ITEM_TYPE_IMAGE = 2;
const MESSAGE_ITEM_TYPE_VOICE = 3;
const MESSAGE_ITEM_TYPE_FILE = 4;
const MESSAGE_ITEM_TYPE_VIDEO = 5;

function normalizeString(value) {
  return String(value || '').trim();
}

function assertWeixinOkResponse(payload, label) {
  const hasErrcode = payload && Object.prototype.hasOwnProperty.call(payload, 'errcode');
  const hasRet = payload && Object.prototype.hasOwnProperty.call(payload, 'ret');
  const code = hasErrcode
    ? Number(payload.errcode)
    : hasRet
      ? Number(payload.ret)
      : 0;
  if (Number.isNaN(code) || code === 0) return;
  const message = normalizeString(payload?.errmsg) || `errcode=${code}`;
  throw new Error(`${label} failed: ${message}`);
}

function ensureFetchAvailable() {
  if (typeof fetch !== 'function') {
    throw new Error('当前 Node.js 环境没有全局 fetch，请升级到 Node.js 18+');
  }
}

function ensureTrailingSlash(url) {
  const raw = normalizeString(url) || DEFAULT_BASE_URL;
  return raw.endsWith('/') ? raw : `${raw}/`;
}

function buildRouteHeaders(routeTag) {
  const tag = normalizeString(routeTag);
  return tag ? { SKRouteTag: tag } : {};
}

function randomWechatUin() {
  const uint32 = crypto.randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(uint32), 'utf8').toString('base64');
}

function generateClientId() {
  return `suncodexclaw-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
}

function buildPostHeaders({ token = '', body = '', routeTag = '' }) {
  const headers = {
    'Content-Type': 'application/json',
    AuthorizationType: 'ilink_bot_token',
    'Content-Length': String(Buffer.byteLength(body, 'utf8')),
    'X-WECHAT-UIN': randomWechatUin(),
    ...buildRouteHeaders(routeTag),
  };
  const normalizedToken = normalizeString(token);
  if (normalizedToken) {
    headers.Authorization = `Bearer ${normalizedToken}`;
  }
  return headers;
}

async function postJson({ baseUrl, endpoint, body, token = '', timeoutMs, routeTag = '' }) {
  ensureFetchAvailable();
  const url = new URL(endpoint, ensureTrailingSlash(baseUrl));
  const rawBody = JSON.stringify(body || {});
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url.toString(), {
      method: 'POST',
      headers: buildPostHeaders({ token, body: rawBody, routeTag }),
      body: rawBody,
      signal: controller.signal,
    });
    const rawText = await response.text();
    if (!response.ok) {
      throw new Error(`${endpoint} ${response.status}: ${rawText}`);
    }
    if (!rawText) return {};
    return JSON.parse(rawText);
  } finally {
    clearTimeout(timer);
  }
}

async function getJson({ url, headers = {}, timeoutMs }) {
  ensureFetchAvailable();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers,
      signal: controller.signal,
    });
    const rawText = await response.text();
    if (!response.ok) {
      throw new Error(`GET ${url} ${response.status}: ${rawText}`);
    }
    if (!rawText) return {};
    return JSON.parse(rawText);
  } finally {
    clearTimeout(timer);
  }
}

async function getUpdates({
  baseUrl = DEFAULT_BASE_URL,
  token = '',
  cursor = '',
  timeoutMs = DEFAULT_LONG_POLL_TIMEOUT_MS,
  routeTag = '',
}) {
  try {
    return await postJson({
      baseUrl,
      endpoint: 'ilink/bot/getupdates',
      token,
      timeoutMs,
      routeTag,
      body: {
        get_updates_buf: normalizeString(cursor),
        base_info: {},
      },
    });
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      return { ret: 0, msgs: [], get_updates_buf: normalizeString(cursor) };
    }
    throw err;
  }
}

async function sendWeixinText({
  baseUrl = DEFAULT_BASE_URL,
  token = '',
  to,
  text,
  contextToken,
  timeoutMs = DEFAULT_API_TIMEOUT_MS,
  routeTag = '',
}) {
  const target = normalizeString(to);
  const replyText = String(text || '');
  const normalizedContextToken = normalizeString(contextToken);
  if (!target) throw new Error('缺少 to_user_id，无法发送微信回复');
  if (!normalizedContextToken) throw new Error('缺少 context_token，无法发送微信回复');

  const clientId = generateClientId();
  const response = await postJson({
    baseUrl,
    endpoint: 'ilink/bot/sendmessage',
    token,
    timeoutMs,
    routeTag,
    body: {
      msg: {
        from_user_id: '',
        to_user_id: target,
        client_id: clientId,
        message_type: MESSAGE_TYPE_BOT,
        message_state: 2,
        item_list: replyText
          ? [{ type: MESSAGE_ITEM_TYPE_TEXT, text_item: { text: replyText } }]
          : [],
        context_token: normalizedContextToken,
      },
      base_info: {},
    },
  });
  assertWeixinOkResponse(response, 'sendmessage');
  return { messageId: clientId };
}

async function getTypingTicket({
  baseUrl = DEFAULT_BASE_URL,
  token = '',
  ilinkUserId,
  contextToken = '',
  timeoutMs = DEFAULT_CONFIG_TIMEOUT_MS,
  routeTag = '',
}) {
  const response = await postJson({
    baseUrl,
    endpoint: 'ilink/bot/getconfig',
    token,
    timeoutMs,
    routeTag,
    body: {
      ilink_user_id: normalizeString(ilinkUserId),
      context_token: normalizeString(contextToken) || undefined,
      base_info: {},
    },
  });
  assertWeixinOkResponse(response, 'getconfig');
  return normalizeString(response.typing_ticket);
}

async function sendTypingStatus({
  baseUrl = DEFAULT_BASE_URL,
  token = '',
  ilinkUserId,
  typingTicket,
  status = 1,
  timeoutMs = DEFAULT_CONFIG_TIMEOUT_MS,
  routeTag = '',
}) {
  if (!normalizeString(ilinkUserId) || !normalizeString(typingTicket)) return;
  const response = await postJson({
    baseUrl,
    endpoint: 'ilink/bot/sendtyping',
    token,
    timeoutMs,
    routeTag,
    body: {
      ilink_user_id: normalizeString(ilinkUserId),
      typing_ticket: normalizeString(typingTicket),
      status,
      base_info: {},
    },
  });
  assertWeixinOkResponse(response, 'sendtyping');
}

async function fetchLoginQr({
  baseUrl = DEFAULT_BASE_URL,
  botType = DEFAULT_BOT_TYPE,
  routeTag = '',
  timeoutMs = DEFAULT_API_TIMEOUT_MS,
}) {
  const url = new URL(
    `ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(normalizeString(botType) || DEFAULT_BOT_TYPE)}`,
    ensureTrailingSlash(baseUrl)
  );
  const response = await getJson({
    url: url.toString(),
    headers: buildRouteHeaders(routeTag),
    timeoutMs,
  });
  return {
    qrcode: normalizeString(response.qrcode),
    qrcodeUrl: normalizeString(response.qrcode_img_content),
  };
}

async function pollLoginStatus({
  baseUrl = DEFAULT_BASE_URL,
  qrcode,
  routeTag = '',
  timeoutMs = DEFAULT_QR_POLL_TIMEOUT_MS,
}) {
  const url = new URL(
    `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(normalizeString(qrcode))}`,
    ensureTrailingSlash(baseUrl)
  );
  try {
    const response = await getJson({
      url: url.toString(),
      headers: {
        'iLink-App-ClientVersion': '1',
        ...buildRouteHeaders(routeTag),
      },
      timeoutMs,
    });
    return {
      status: normalizeString(response.status) || 'wait',
      botToken: normalizeString(response.bot_token),
      accountId: normalizeString(response.ilink_bot_id),
      baseUrl: normalizeString(response.baseurl),
      userId: normalizeString(response.ilink_user_id),
    };
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      return { status: 'wait', botToken: '', accountId: '', baseUrl: '', userId: '' };
    }
    throw err;
  }
}

function splitTextForWeixin(text, maxLength = WEIXIN_TEXT_CHUNK_LIMIT) {
  const raw = String(text || '').replace(/\r/g, '');
  if (!raw) return [];
  const max = Math.max(200, Number(maxLength) || WEIXIN_TEXT_CHUNK_LIMIT);
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

function extractInboundText(message) {
  const pieces = [];
  for (const item of message?.item_list || []) {
    const type = Number(item?.type);
    if (type === MESSAGE_ITEM_TYPE_TEXT && normalizeString(item?.text_item?.text)) {
      pieces.push(normalizeString(item.text_item.text));
      continue;
    }
    if (type === MESSAGE_ITEM_TYPE_VOICE && normalizeString(item?.voice_item?.text)) {
      pieces.push(normalizeString(item.voice_item.text));
    }
  }
  return pieces.join('\n').trim();
}

function hasUnsupportedInboundMedia(message) {
  return (message?.item_list || []).some((item) => {
    const type = Number(item?.type);
    if (type === MESSAGE_ITEM_TYPE_TEXT) return false;
    if (type === MESSAGE_ITEM_TYPE_VOICE && normalizeString(item?.voice_item?.text)) return false;
    return [
      MESSAGE_ITEM_TYPE_IMAGE,
      MESSAGE_ITEM_TYPE_VOICE,
      MESSAGE_ITEM_TYPE_FILE,
      MESSAGE_ITEM_TYPE_VIDEO,
    ].includes(type);
  });
}

function shouldHandleInboundMessage(message) {
  return Number(message?.message_type) === MESSAGE_TYPE_USER && Boolean(normalizeString(message?.from_user_id));
}

module.exports = {
  DEFAULT_API_TIMEOUT_MS,
  DEFAULT_BASE_URL,
  DEFAULT_BOT_TYPE,
  DEFAULT_CONFIG_TIMEOUT_MS,
  DEFAULT_LONG_POLL_TIMEOUT_MS,
  DEFAULT_QR_POLL_TIMEOUT_MS,
  MESSAGE_TYPE_USER,
  WEIXIN_TEXT_CHUNK_LIMIT,
  extractInboundText,
  fetchLoginQr,
  getTypingTicket,
  getUpdates,
  hasUnsupportedInboundMedia,
  normalizeString,
  pollLoginStatus,
  sendTypingStatus,
  sendWeixinText,
  shouldHandleInboundMessage,
  splitTextForWeixin,
};
