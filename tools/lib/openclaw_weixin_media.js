const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const DEFAULT_BASE_URL = 'https://ilinkai.weixin.qq.com';
const CDN_BASE_URL = 'https://novac2c.cdn.weixin.qq.com/c2c';
const DEFAULT_API_TIMEOUT_MS = 15_000;
const IMAGE_ITEM_TYPE = 2;
const FILE_ITEM_TYPE = 4;
const MESSAGE_TYPE_BOT = 2;

const EXTENSION_TO_MIME = {
  '.pdf': 'application/pdf',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.txt': 'text/plain',
  '.csv': 'text/csv',
  '.zip': 'application/zip',
  '.tar': 'application/x-tar',
  '.gz': 'application/gzip',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
};

const MIME_TO_EXTENSION = {
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/bmp': '.bmp',
  'application/pdf': '.pdf',
  'application/zip': '.zip',
  'application/x-tar': '.tar',
  'application/gzip': '.gz',
  'text/plain': '.txt',
  'text/csv': '.csv',
};

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

function buildPostHeaders({ token = '', body = '', routeTag = '' }) {
  const headers = {
    'Content-Type': 'application/json',
    AuthorizationType: 'ilink_bot_token',
    'Content-Length': String(Buffer.byteLength(body, 'utf8')),
    'X-WECHAT-UIN': randomWechatUin(),
    ...buildRouteHeaders(routeTag),
  };
  const normalizedToken = normalizeString(token);
  if (normalizedToken) headers.Authorization = `Bearer ${normalizedToken}`;
  return headers;
}

async function postJson({ baseUrl, endpoint, body, token = '', timeoutMs = DEFAULT_API_TIMEOUT_MS, routeTag = '' }) {
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
    return rawText ? JSON.parse(rawText) : {};
  } finally {
    clearTimeout(timer);
  }
}

function getMimeFromFilename(filename) {
  const ext = path.extname(String(filename || '')).toLowerCase();
  return EXTENSION_TO_MIME[ext] || 'application/octet-stream';
}

function getExtensionFromMime(mimeType) {
  const ct = String(mimeType || '').split(';')[0].trim().toLowerCase();
  return MIME_TO_EXTENSION[ct] || '.bin';
}

function guessImageExtensionFromBuffer(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return '.jpg';
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return '.png';
  if (buffer.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return '.jpg';
  if (buffer.subarray(0, 6).toString('ascii') === 'GIF87a' || buffer.subarray(0, 6).toString('ascii') === 'GIF89a') return '.gif';
  if (buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') return '.webp';
  if (buffer.subarray(0, 2).toString('ascii') === 'BM') return '.bmp';
  return '.jpg';
}

function encryptAesEcb(plaintext, key) {
  const cipher = crypto.createCipheriv('aes-128-ecb', key, null);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}

function decryptAesEcb(ciphertext, key) {
  const decipher = crypto.createDecipheriv('aes-128-ecb', key, null);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

function aesEcbPaddedSize(plaintextSize) {
  return Math.ceil((Number(plaintextSize || 0) + 1) / 16) * 16;
}

function buildCdnUploadUrl({ cdnBaseUrl, uploadParam, filekey }) {
  return `${cdnBaseUrl}/upload?encrypted_query_param=${encodeURIComponent(uploadParam)}&filekey=${encodeURIComponent(filekey)}`;
}

function buildCdnDownloadUrl(encryptedQueryParam, cdnBaseUrl) {
  return `${cdnBaseUrl}/download?encrypted_query_param=${encodeURIComponent(encryptedQueryParam)}`;
}

async function uploadBufferToCdn({ buffer, uploadParam, filekey, cdnBaseUrl, aeskey }) {
  ensureFetchAvailable();
  const ciphertext = encryptAesEcb(buffer, aeskey);
  const cdnUrl = buildCdnUploadUrl({ cdnBaseUrl, uploadParam, filekey });
  const response = await fetch(cdnUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: new Uint8Array(ciphertext),
  });
  if (response.status >= 400) {
    const errMsg = response.headers.get('x-error-message') || await response.text();
    throw new Error(`cdn upload ${response.status}: ${errMsg}`);
  }
  const downloadParam = response.headers.get('x-encrypted-param');
  if (!downloadParam) {
    throw new Error('cdn upload response missing x-encrypted-param');
  }
  return { downloadParam };
}

async function getUploadUrl({ baseUrl, token, routeTag, toUserId, rawsize, rawfilemd5, filesize, filekey, mediaType, aeskey }) {
  const response = await postJson({
    baseUrl,
    endpoint: 'ilink/bot/getuploadurl',
    token,
    routeTag,
    body: {
      filekey,
      media_type: mediaType,
      to_user_id: toUserId,
      rawsize,
      rawfilemd5,
      filesize,
      no_need_thumb: true,
      aeskey,
      base_info: {},
    },
  });
  assertWeixinOkResponse(response, 'getuploadurl');
  return response;
}

async function uploadMediaToWeixin({ filePath, toUserId, baseUrl, token, routeTag, cdnBaseUrl, mediaType }) {
  const plaintext = await fsp.readFile(filePath);
  const rawsize = plaintext.length;
  const rawfilemd5 = crypto.createHash('md5').update(plaintext).digest('hex');
  const filesize = aesEcbPaddedSize(rawsize);
  const filekey = crypto.randomBytes(16).toString('hex');
  const aeskey = crypto.randomBytes(16);
  const uploadUrlResp = await getUploadUrl({
    baseUrl,
    token,
    routeTag,
    toUserId,
    rawsize,
    rawfilemd5,
    filesize,
    filekey,
    mediaType,
    aeskey: aeskey.toString('hex'),
  });
  if (!uploadUrlResp.upload_param) {
    throw new Error('getuploadurl returned no upload_param');
  }
  const { downloadParam } = await uploadBufferToCdn({
    buffer: plaintext,
    uploadParam: uploadUrlResp.upload_param,
    filekey,
    cdnBaseUrl,
    aeskey,
  });
  return {
    filekey,
    downloadEncryptedQueryParam: downloadParam,
    aeskeyHex: aeskey.toString('hex'),
    fileSize: rawsize,
    fileSizeCiphertext: filesize,
  };
}

async function sendMessageBody({ baseUrl, token, routeTag, message }) {
  const response = await postJson({
    baseUrl,
    endpoint: 'ilink/bot/sendmessage',
    token,
    routeTag,
    body: {
      msg: message,
      base_info: {},
    },
  });
  assertWeixinOkResponse(response, 'sendmessage');
}

function generateClientId() {
  return `suncodexclaw-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
}

async function sendMessageItems({ baseUrl, token, routeTag, to, contextToken, items, text = '' }) {
  const queue = [];
  if (text) {
    queue.push({
      type: 1,
      text_item: { text },
    });
  }
  queue.push(...items);

  let lastClientId = '';
  for (const item of queue) {
    lastClientId = generateClientId();
    await sendMessageBody({
      baseUrl,
      token,
      routeTag,
      message: {
        from_user_id: '',
        to_user_id: to,
        client_id: lastClientId,
        message_type: MESSAGE_TYPE_BOT,
        message_state: 2,
        item_list: [item],
        context_token: contextToken,
      },
    });
  }
  return { messageId: lastClientId };
}

async function sendWeixinMediaFile({ baseUrl, token, routeTag = '', to, contextToken, filePath, text = '', cdnBaseUrl = CDN_BASE_URL }) {
  const resolvedPath = path.resolve(filePath);
  const mime = getMimeFromFilename(resolvedPath);
  const uploaded = await uploadMediaToWeixin({
    filePath: resolvedPath,
    toUserId: to,
    baseUrl,
    token,
    routeTag,
    cdnBaseUrl,
    mediaType: mime.startsWith('image/') ? 1 : 3,
  });

  if (mime.startsWith('image/')) {
    return sendMessageItems({
      baseUrl,
      token,
      routeTag,
      to,
      contextToken,
      text,
      items: [{
        type: IMAGE_ITEM_TYPE,
        image_item: {
          media: {
            encrypt_query_param: uploaded.downloadEncryptedQueryParam,
            aes_key: Buffer.from(uploaded.aeskeyHex, 'hex').toString('base64'),
            encrypt_type: 1,
          },
          mid_size: uploaded.fileSizeCiphertext,
        },
      }],
    });
  }

  return sendMessageItems({
    baseUrl,
    token,
    routeTag,
    to,
    contextToken,
    text,
    items: [{
      type: FILE_ITEM_TYPE,
      file_item: {
        media: {
          encrypt_query_param: uploaded.downloadEncryptedQueryParam,
          aes_key: Buffer.from(uploaded.aeskeyHex, 'hex').toString('base64'),
          encrypt_type: 1,
        },
        file_name: path.basename(resolvedPath),
        len: String(uploaded.fileSize),
      },
    }],
  });
}

async function fetchCdnBytes(url, label) {
  ensureFetchAvailable();
  const response = await fetch(url);
  if (!response.ok) {
    const body = await response.text().catch(() => '(unreadable)');
    throw new Error(`${label}: cdn download ${response.status} ${response.statusText} body=${body}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

function parseAesKey(aesKeyBase64, label) {
  const decoded = Buffer.from(aesKeyBase64, 'base64');
  if (decoded.length === 16) return decoded;
  if (decoded.length === 32 && /^[0-9a-fA-F]{32}$/.test(decoded.toString('ascii'))) {
    return Buffer.from(decoded.toString('ascii'), 'hex');
  }
  throw new Error(`${label}: invalid aes_key length ${decoded.length}`);
}

async function downloadAndDecryptBuffer(encryptedQueryParam, aesKeyBase64, cdnBaseUrl, label) {
  const key = parseAesKey(aesKeyBase64, label);
  const url = buildCdnDownloadUrl(encryptedQueryParam, cdnBaseUrl);
  const encrypted = await fetchCdnBytes(url, label);
  return decryptAesEcb(encrypted, key);
}

async function saveBuffer(buffer, filePath) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, buffer);
}

async function downloadWeixinAttachments({ message, destDir, cdnBaseUrl = CDN_BASE_URL }) {
  const attachments = [];
  const items = Array.isArray(message?.item_list) ? message.item_list : [];
  for (const [index, item] of items.entries()) {
    if (Number(item?.type) === IMAGE_ITEM_TYPE && item?.image_item?.media?.encrypt_query_param) {
      const aesKeyBase64 = item?.image_item?.aeskey
        ? Buffer.from(String(item.image_item.aeskey), 'hex').toString('base64')
        : normalizeString(item?.image_item?.media?.aes_key);
      const buffer = aesKeyBase64
        ? await downloadAndDecryptBuffer(item.image_item.media.encrypt_query_param, aesKeyBase64, cdnBaseUrl, `image_${index}`)
        : await fetchCdnBytes(buildCdnDownloadUrl(item.image_item.media.encrypt_query_param, cdnBaseUrl), `image_${index}`);
      const ext = guessImageExtensionFromBuffer(buffer);
      const filePath = path.join(destDir, `${Date.now()}_${index}${ext}`);
      await saveBuffer(buffer, filePath);
      attachments.push({
        type: 'image',
        path: filePath,
        summary: `图片：${filePath}`,
      });
    } else if (Number(item?.type) === FILE_ITEM_TYPE && item?.file_item?.media?.encrypt_query_param && item?.file_item?.media?.aes_key) {
      const buffer = await downloadAndDecryptBuffer(
        item.file_item.media.encrypt_query_param,
        item.file_item.media.aes_key,
        cdnBaseUrl,
        `file_${index}`
      );
      const fileName = normalizeString(item?.file_item?.file_name) || `file_${Date.now()}_${index}${getExtensionFromMime(getMimeFromFilename('file.bin'))}`;
      const safeName = fileName.replace(/[\\/]/g, '_');
      const filePath = path.join(destDir, safeName);
      await saveBuffer(buffer, filePath);
      attachments.push({
        type: 'file',
        path: filePath,
        summary: `文件：${filePath}`,
      });
    }
  }
  return attachments;
}

module.exports = {
  CDN_BASE_URL,
  downloadWeixinAttachments,
  getMimeFromFilename,
  sendWeixinMediaFile,
};
