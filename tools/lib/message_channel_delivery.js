const {
  asPlainObject,
  createFeishuClient,
  ensure,
  normalizeString,
  splitTextForFeishu,
} = require('./studio_runtime_support');

const WECOM_DEFAULT_BASE_URL = 'https://qyapi.weixin.qq.com';
const FEISHU_TEXT_CHUNK_LIMIT = 4000;
const wecomTokenCache = new Map();

function normalizeChannelType(value) {
  const raw = normalizeString(value).toLowerCase();
  if (raw === 'wecom' || raw === 'work_wechat' || raw === 'workwechat') return 'wecom';
  return 'feishu';
}

function normalizeTargetType(value) {
  const raw = normalizeString(value).toLowerCase();
  if (raw === 'user') return 'user';
  if (raw === 'thread') return 'thread';
  if (raw === 'chat') return 'chat';
  if (raw === 'session') return 'session';
  return 'session';
}

function normalizeMessageType(value) {
  const raw = normalizeString(value).toLowerCase();
  if (raw === 'card' || raw === 'interactive') return 'card';
  if (raw === 'markdown' || raw === 'md') return 'markdown';
  if (raw === 'text') return 'text';
  return 'text';
}

function pickValue(...values) {
  for (const value of values) {
    const normalized = normalizeString(value);
    if (normalized) return normalized;
  }
  return '';
}

function normalizeNamedTarget(channelType, alias, value) {
  const raw = asPlainObject(value);
  const targetType = normalizeTargetType(raw.target_type || raw.targetType || 'session');
  const targetId = pickValue(raw.target_id, raw.targetId, raw.chat_id, raw.chatId, raw.user_id, raw.userId);
  if (!targetId) return null;
  return {
    alias: normalizeString(alias),
    label: pickValue(raw.label, raw.name, alias),
    channelType: normalizeChannelType(raw.channel_type || raw.channelType || channelType),
    targetType,
    targetId,
    threadId: pickValue(raw.thread_id, raw.threadId),
    receiveIdType: pickValue(raw.receive_id_type, raw.receiveIdType),
    messageId: pickValue(raw.message_id, raw.messageId),
  };
}

function normalizeNamedTargets(section, channelType) {
  const root = asPlainObject(section);
  const items = [];
  for (const [alias, value] of Object.entries(root)) {
    const normalized = normalizeNamedTarget(channelType, alias, value);
    if (!normalized) continue;
    items.push(normalized);
  }
  return items.sort((a, b) => String(b.alias || '').length - String(a.alias || '').length);
}

function resolveOutboundChannelConfig(config = {}, { feishuDomain = 'feishu', feishuCreds = {} } = {}) {
  const root = asPlainObject(config.outbound_channels || config.delivery_channels || {});
  const namedRoot = asPlainObject(root.named_targets || root.targets);
  const wecomRoot = asPlainObject(root.wecom);
  return {
    feishu: {
      domain: feishuDomain,
      creds: {
        appId: normalizeString(feishuCreds.appId),
        appSecret: normalizeString(feishuCreds.appSecret),
        botOpenId: normalizeString(feishuCreds.botOpenId),
      },
    },
    wecom: {
      baseUrl: pickValue(wecomRoot.base_url, wecomRoot.baseUrl, WECOM_DEFAULT_BASE_URL) || WECOM_DEFAULT_BASE_URL,
      corpId: pickValue(wecomRoot.corp_id, wecomRoot.corpId),
      agentId: pickValue(wecomRoot.agent_id, wecomRoot.agentId),
      secret: pickValue(wecomRoot.secret, wecomRoot.corp_secret, wecomRoot.corpSecret),
    },
    namedTargets: [
      ...normalizeNamedTargets(namedRoot.feishu, 'feishu'),
      ...normalizeNamedTargets(namedRoot.wecom, 'wecom'),
    ],
  };
}

function createMessageChannelRuntime(config = {}, options = {}) {
  return {
    config: resolveOutboundChannelConfig(config, options),
    clients: {
      feishu: null,
    },
  };
}

function getNamedTargetMatches(runtime, text, { preferredChannelType = '' } = {}) {
  const normalizedText = normalizeString(text);
  if (!normalizedText) return [];
  const preferred = normalizeChannelType(preferredChannelType || 'feishu');
  const matches = [];
  for (const target of runtime?.config?.namedTargets || []) {
    if (!target?.alias) continue;
    if (!normalizedText.includes(target.alias)) continue;
    matches.push({
      ...target,
      score: target.alias.length + (target.channelType === preferred ? 100 : 0),
    });
  }
  matches.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return String(a.alias || '').localeCompare(String(b.alias || ''), 'zh-CN');
  });
  return matches;
}

function getFeishuClient(runtime) {
  if (runtime.clients.feishu) return runtime.clients.feishu;
  runtime.clients.feishu = createFeishuClient({
    domain: runtime.config.feishu.domain,
    creds: runtime.config.feishu.creds,
  });
  return runtime.clients.feishu;
}

async function requestJson(url, { method = 'GET', headers = {}, body } = {}) {
  ensure(typeof fetch === 'function', 'global fetch is unavailable in current Node.js runtime');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  try {
    const response = await fetch(url, {
      method,
      headers,
      body,
      signal: controller.signal,
    });
    const raw = await response.text();
    let data = {};
    try {
      data = raw ? JSON.parse(raw) : {};
    } catch (err) {
      throw new Error(`invalid json from ${url}: ${raw.slice(0, 240)}`);
    }
    if (!response.ok) {
      const detail = normalizeString(data.errmsg || data.msg || data.message || raw || response.statusText);
      throw new Error(`${response.status} ${detail}`.trim());
    }
    return data;
  } finally {
    clearTimeout(timeout);
  }
}

async function getWecomAccessToken(runtime) {
  const wecom = asPlainObject(runtime?.config?.wecom);
  ensure(wecom.corpId, 'wecom corp_id is required');
  ensure(wecom.secret, 'wecom secret is required');
  const cacheKey = `${wecom.baseUrl}|${wecom.corpId}|${wecom.secret}`;
  const cached = wecomTokenCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now() + 60 * 1000) {
    return cached.token;
  }

  const search = new URLSearchParams({
    corpid: wecom.corpId,
    corpsecret: wecom.secret,
  });
  const payload = await requestJson(`${wecom.baseUrl.replace(/\/+$/, '')}/cgi-bin/gettoken?${search.toString()}`);
  const token = normalizeString(payload.access_token);
  ensure(token, 'wecom gettoken returned empty access_token');
  const expiresIn = Math.max(300, Number(payload.expires_in || 7200));
  wecomTokenCache.set(cacheKey, {
    token,
    expiresAt: Date.now() + expiresIn * 1000,
  });
  return token;
}

async function sendFeishuText(runtime, payload) {
  const client = getFeishuClient(runtime);
  const targetType = normalizeTargetType(payload.targetType);
  const messageType = normalizeMessageType(payload.messageType);
  ensure(messageType === 'text', `unsupported feishu message_type: ${payload.messageType}`);
  const receiveId = normalizeString(payload.targetId);
  const threadId = pickValue(payload.threadId, payload.targetId);
  const textChunks = splitTextForFeishu(payload.content, FEISHU_TEXT_CHUNK_LIMIT);
  const messageIds = [];

  for (const chunk of textChunks) {
    if (!chunk) continue;
    let response = null;
    if (targetType === 'user') {
      response = await client.im.v1.message.create({
        params: {
          receive_id_type: normalizeString(payload.receiveIdType) || 'open_id',
        },
        data: {
          receive_id: receiveId,
          content: JSON.stringify({ text: chunk }),
          msg_type: 'text',
        },
      });
    } else if (targetType === 'thread') {
      ensure(threadId, 'feishu thread target requires thread_id');
      response = await client.im.v1.message.create({
        params: {
          receive_id_type: 'thread_id',
        },
        data: {
          receive_id: threadId,
          content: JSON.stringify({ text: chunk }),
          msg_type: 'text',
        },
      });
    } else {
      ensure(receiveId, 'feishu chat target requires target_id');
      response = await client.im.v1.message.create({
        params: {
          receive_id_type: 'chat_id',
        },
        data: {
          receive_id: receiveId,
          content: JSON.stringify({ text: chunk }),
          msg_type: 'text',
        },
      });
    }
    const messageId = normalizeString(response?.data?.message_id);
    if (messageId) messageIds.push(messageId);
  }

  return {
    channelType: 'feishu',
    messageIds,
    count: messageIds.length,
  };
}

function splitMarkdownChunks(content, maxLength = FEISHU_TEXT_CHUNK_LIMIT) {
  const raw = String(content || '').replace(/\r/g, '').trim();
  if (!raw) return [];
  const max = Math.max(1000, Number(maxLength) || FEISHU_TEXT_CHUNK_LIMIT);
  if (raw.length <= max) return [raw];

  const lines = raw.split('\n');
  const chunks = [];
  let buffer = [];
  let length = 0;

  function flush() {
    if (!buffer.length) return;
    chunks.push(buffer.join('\n').trim());
    buffer = [];
    length = 0;
  }

  for (const line of lines) {
    const nextLength = length + line.length + 1;
    if (buffer.length && nextLength > max) {
      flush();
    }
    if (line.length > max) {
      flush();
      for (const part of splitTextForFeishu(line, max)) {
        if (part.trim()) chunks.push(part.trim());
      }
      continue;
    }
    buffer.push(line);
    length += line.length + 1;
  }
  flush();
  return chunks;
}

async function sendFeishuMarkdown(runtime, payload) {
  const client = getFeishuClient(runtime);
  const targetType = normalizeTargetType(payload.targetType);
  const messageType = normalizeMessageType(payload.messageType);
  ensure(messageType === 'markdown', `unsupported feishu message_type: ${payload.messageType}`);
  const receiveId = normalizeString(payload.targetId);
  const threadId = pickValue(payload.threadId, payload.targetId);
  const chunks = splitMarkdownChunks(payload.content, FEISHU_TEXT_CHUNK_LIMIT);
  const messageIds = [];

  for (const chunk of chunks) {
    if (!chunk) continue;
    const card = {
      config: {
        wide_screen_mode: true,
        enable_forward: true,
      },
      elements: [
        {
          tag: 'markdown',
          content: chunk,
        },
      ],
    };
    let response = null;
    if (targetType === 'user') {
      response = await client.im.v1.message.create({
        params: {
          receive_id_type: normalizeString(payload.receiveIdType) || 'open_id',
        },
        data: {
          receive_id: receiveId,
          content: JSON.stringify(card),
          msg_type: 'interactive',
        },
      });
    } else if (targetType === 'thread') {
      ensure(threadId, 'feishu thread target requires thread_id');
      response = await client.im.v1.message.create({
        params: {
          receive_id_type: 'thread_id',
        },
        data: {
          receive_id: threadId,
          content: JSON.stringify(card),
          msg_type: 'interactive',
        },
      });
    } else {
      ensure(receiveId, 'feishu chat target requires target_id');
      response = await client.im.v1.message.create({
        params: {
          receive_id_type: 'chat_id',
        },
        data: {
          receive_id: receiveId,
          content: JSON.stringify(card),
          msg_type: 'interactive',
        },
      });
    }
    const messageId = normalizeString(response?.data?.message_id);
    if (messageId) messageIds.push(messageId);
  }

  return {
    channelType: 'feishu',
    messageIds,
    count: messageIds.length,
  };
}

async function sendFeishuCard(runtime, payload) {
  const client = getFeishuClient(runtime);
  const targetType = normalizeTargetType(payload.targetType);
  const messageType = normalizeMessageType(payload.messageType);
  ensure(messageType === 'card', `unsupported feishu message_type: ${payload.messageType}`);
  const receiveId = normalizeString(payload.targetId);
  const threadId = pickValue(payload.threadId, payload.targetId);
  const card = typeof payload.content === 'string'
    ? JSON.parse(payload.content)
    : asPlainObject(payload.content);
  ensure(card && typeof card === 'object' && !Array.isArray(card), 'feishu card payload must be an object');
  ensure(Array.isArray(card.elements) && card.elements.length > 0, 'feishu card payload requires elements');
  const messageIds = [];

  let response = null;
  if (targetType === 'user') {
    response = await client.im.v1.message.create({
      params: {
        receive_id_type: normalizeString(payload.receiveIdType) || 'open_id',
      },
      data: {
        receive_id: receiveId,
        content: JSON.stringify(card),
        msg_type: 'interactive',
      },
    });
  } else if (targetType === 'thread') {
    ensure(threadId, 'feishu thread target requires thread_id');
    response = await client.im.v1.message.create({
      params: {
        receive_id_type: 'thread_id',
      },
      data: {
        receive_id: threadId,
        content: JSON.stringify(card),
        msg_type: 'interactive',
      },
    });
  } else {
    ensure(receiveId, 'feishu chat target requires target_id');
    response = await client.im.v1.message.create({
      params: {
        receive_id_type: 'chat_id',
      },
      data: {
        receive_id: receiveId,
        content: JSON.stringify(card),
        msg_type: 'interactive',
      },
    });
  }
  const messageId = normalizeString(response?.data?.message_id);
  if (messageId) messageIds.push(messageId);
  return {
    channelType: 'feishu',
    messageIds,
    count: messageIds.length,
  };
}

async function sendWecomText(runtime, payload) {
  const wecom = asPlainObject(runtime?.config?.wecom);
  ensure(wecom.agentId, 'wecom agent_id is required');
  const targetType = normalizeTargetType(payload.targetType);
  const messageType = normalizeMessageType(payload.messageType);
  ensure(messageType === 'text', `unsupported wecom message_type: ${payload.messageType}`);
  const token = await getWecomAccessToken(runtime);
  const body = {
    msgtype: 'text',
    agentid: Number(wecom.agentId),
    text: {
      content: String(payload.content || ''),
    },
    safe: 0,
    enable_duplicate_check: 0,
  };

  if (targetType === 'user') {
    body.touser = normalizeString(payload.targetId);
    ensure(body.touser, 'wecom user target requires target_id');
  } else {
    body.chatid = normalizeString(payload.targetId);
    ensure(body.chatid, 'wecom chat target requires target_id');
  }

  const response = await requestJson(
    `${wecom.baseUrl.replace(/\/+$/, '')}/cgi-bin/message/send?access_token=${encodeURIComponent(token)}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    }
  );
  if (Number(response.errcode || 0) !== 0) {
    throw new Error(`wecom send failed: ${response.errcode} ${normalizeString(response.errmsg || 'unknown error')}`.trim());
  }
  return {
    channelType: 'wecom',
    messageIds: [normalizeString(response.msgid || response.invaliduser || '')].filter(Boolean),
    count: 1,
  };
}

async function sendWecomMarkdown(runtime, payload) {
  const wecom = asPlainObject(runtime?.config?.wecom);
  ensure(wecom.agentId, 'wecom agent_id is required');
  const targetType = normalizeTargetType(payload.targetType);
  const messageType = normalizeMessageType(payload.messageType);
  ensure(messageType === 'markdown', `unsupported wecom message_type: ${payload.messageType}`);
  const token = await getWecomAccessToken(runtime);
  const chunks = splitMarkdownChunks(payload.content, FEISHU_TEXT_CHUNK_LIMIT);
  const messageIds = [];

  for (const chunk of chunks) {
    if (!chunk) continue;
    const body = {
      msgtype: 'markdown',
      agentid: Number(wecom.agentId),
      markdown: {
        content: String(chunk || ''),
      },
      safe: 0,
      enable_duplicate_check: 0,
    };

    if (targetType === 'user') {
      body.touser = normalizeString(payload.targetId);
      ensure(body.touser, 'wecom user target requires target_id');
    } else {
      body.chatid = normalizeString(payload.targetId);
      ensure(body.chatid, 'wecom chat target requires target_id');
    }

    const response = await requestJson(
      `${wecom.baseUrl.replace(/\/+$/, '')}/cgi-bin/message/send?access_token=${encodeURIComponent(token)}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      }
    );
    if (Number(response.errcode || 0) !== 0) {
      throw new Error(`wecom send failed: ${response.errcode} ${normalizeString(response.errmsg || 'unknown error')}`.trim());
    }
    const messageId = normalizeString(response.msgid || response.invaliduser || '');
    if (messageId) messageIds.push(messageId);
  }

  return {
    channelType: 'wecom',
    messageIds,
    count: messageIds.length,
  };
}

async function sendUnifiedMessage(runtime, payload = {}) {
  const channelType = normalizeChannelType(payload.channelType || payload.channel_type || 'feishu');
  const request = {
    channelType,
    targetType: normalizeTargetType(payload.targetType || payload.target_type || 'session'),
    targetId: pickValue(payload.targetId, payload.target_id),
    threadId: pickValue(payload.threadId, payload.thread_id),
    receiveIdType: pickValue(payload.receiveIdType, payload.receive_id_type),
    messageType: normalizeMessageType(payload.messageType || payload.message_type || 'text'),
    content: payload.content,
  };
  if (request.messageType === 'card') {
    ensure(request.content && (typeof request.content === 'object' || normalizeString(request.content)), 'message content is required');
  } else {
    ensure(String(request.content || '').trim(), 'message content is required');
  }
  if (channelType === 'wecom') {
    if (request.messageType === 'markdown') {
      return sendWecomMarkdown(runtime, request);
    }
    return sendWecomText(runtime, request);
  }
  if (request.messageType === 'card') {
    return sendFeishuCard(runtime, request);
  }
  if (request.messageType === 'markdown') {
    return sendFeishuMarkdown(runtime, request);
  }
  return sendFeishuText(runtime, request);
}

module.exports = {
  createMessageChannelRuntime,
  getNamedTargetMatches,
  normalizeChannelType,
  normalizeTargetType,
  resolveOutboundChannelConfig,
  sendUnifiedMessage,
};
