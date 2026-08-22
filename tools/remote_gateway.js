#!/usr/bin/env node
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { WebSocket } = require('ws');
const {
  DEFAULT_REMOTE_PORT,
  createAccessToken,
  createSecret,
  decryptRelayPayload,
  defaultGatewayConfigPath,
  encodeConnectionToken,
  encodeRelayConnectionToken,
  encryptRelayPayload,
  findAccessToken,
  findAccessTokenByClientId,
  loadGatewayConfig,
  normalizeConnectUrl,
  normalizeGatewayConfig,
  normalizeRelayUrl,
  saveGatewayConfig,
  tokenHasScope,
} = require('./lib/remote_access');

const REPO_DIR = path.resolve(__dirname, '..');
const BRIDGE_SCRIPT = path.join(REPO_DIR, 'tools', 'feishu_desktop_bridge.js');
const PACKAGE = require(path.join(REPO_DIR, 'package.json'));
const NODE_BIN = process.execPath || 'node';
const AUDIT_LOG = path.join(REPO_DIR, '.runtime', 'remote_gateway', 'audit.jsonl');
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_CONCURRENT_CHAT_REQUESTS = 4;

function normalizeString(value) {
  return String(value || '').trim();
}

function getArg(flag, fallback = '') {
  const index = process.argv.indexOf(flag);
  return index >= 0 && index + 1 < process.argv.length ? process.argv[index + 1] : fallback;
}

function hasFlag(flag) {
  return process.argv.includes(flag);
}

function jsonLine(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function runBridge(command, account = '', payload = null, options = {}) {
  const bridgeScript = options.bridgeScript || BRIDGE_SCRIPT;
  const repoDir = options.repoDir || REPO_DIR;
  const nodeBin = options.nodeBin || NODE_BIN;
  return new Promise((resolve) => {
    const args = [bridgeScript, command];
    if (account) args.push(account);
    const child = spawn(nodeBin, args, {
      cwd: repoDir,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk || '');
      if (stdout.length > 16 * 1024 * 1024) stdout = stdout.slice(-16 * 1024 * 1024);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk || '');
      if (stderr.length > 4 * 1024 * 1024) stderr = stderr.slice(-4 * 1024 * 1024);
    });
    child.on('error', (error) => {
      resolve({ ok: false, exitCode: 1, error: `bridge failed to start: ${error.message}` });
    });
    child.on('close', (code) => {
      const combined = `${stdout}\n${stderr}`.trim();
      if (code !== 0) {
        resolve({ ok: false, exitCode: code || 1, error: combined || `${command} failed` });
        return;
      }
      try {
        resolve(JSON.parse(stdout || '{}'));
      } catch (_) {
        resolve({ ok: false, exitCode: 1, error: combined || 'bridge returned invalid JSON' });
      }
    });
    child.stdin.end(payload ? `${JSON.stringify(payload)}\n` : '');
  });
}

function sendJson(res, value, status = 200) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  });
  res.end(`${JSON.stringify(value)}\n`);
}

function readJsonBody(req, limitBytes = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    let raw = '';
    let rejected = false;
    req.on('data', (chunk) => {
      if (rejected) return;
      raw += String(chunk || '');
      if (Buffer.byteLength(raw, 'utf8') > limitBytes) {
        rejected = true;
        reject(Object.assign(new Error('request body too large'), { statusCode: 413 }));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (rejected) return;
      if (!raw.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(Object.assign(new Error(`invalid JSON body: ${error.message}`), { statusCode: 400 }));
      }
    });
    req.on('error', (error) => {
      if (!rejected) reject(error);
    });
  });
}

function bearerSecret(req) {
  const header = normalizeString(req.headers.authorization);
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? normalizeString(match[1]) : '';
}

function safeMachine(config) {
  return {
    id: config.machineId,
    name: config.machineName,
    version: PACKAGE.version,
    platform: process.platform,
    hostname: os.hostname(),
  };
}

function safeBot(bot = {}) {
  return {
    account: normalizeString(bot.account),
    displayName: normalizeString(bot.displayName || bot.account),
    state: normalizeString(bot.status?.state || 'unknown'),
    activity: bot.activity && typeof bot.activity === 'object'
      ? {
        state: normalizeString(bot.activity.state),
        label: normalizeString(bot.activity.label),
      }
      : {},
    model: normalizeString(bot.boot?.codexModel),
  };
}

function safeHistoryItem(item = {}) {
  return {
    role: normalizeString(item.role),
    text: normalizeString(item.text),
    at: normalizeString(item.at),
  };
}

function safeThread(thread = {}) {
  return {
    id: normalizeString(thread.id),
    name: normalizeString(thread.name),
    source: normalizeString(thread.source || 'studio'),
    status: normalizeString(thread.status),
    lastError: normalizeString(thread.lastError || thread.last_error),
    lastReplyPreview: normalizeString(thread.lastReplyPreview || thread.last_reply_preview),
    createdAt: normalizeString(thread.createdAt || thread.created_at),
    updatedAt: normalizeString(thread.updatedAt || thread.updated_at),
    turnCount: Number(thread.turnCount || 0) || 0,
    history: Array.isArray(thread.history) ? thread.history.map(safeHistoryItem) : [],
  };
}

function isRemoteCliThread(thread = {}) {
  return normalizeString(thread.source).toLowerCase() === 'remote_cli';
}

function safeThreadEnvelope(result = {}, activeThread = null) {
  return {
    ok: result.ok !== false,
    account: normalizeString(result.account),
    threads: Array.isArray(result.threads) ? result.threads.filter(isRemoteCliThread).map(safeThread) : [],
    thread: activeThread && isRemoteCliThread(activeThread)
      ? safeThread(activeThread)
      : (result.thread && isRemoteCliThread(result.thread) ? safeThread(result.thread) : null),
  };
}

function appendAudit(entry, auditLog = AUDIT_LOG) {
  try {
    fs.mkdirSync(path.dirname(auditLog), { recursive: true, mode: 0o700 });
    fs.appendFileSync(auditLog, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
  } catch (_) {
    // Audit failures must not crash the remote gateway, but remain visible in stderr.
    process.stderr.write('remote_gateway audit write failed\n');
  }
}

function decodePathSegments(pathname) {
  return pathname.split('/').filter(Boolean).map((part) => decodeURIComponent(part));
}

function createRemoteGatewayHandler(options = {}) {
  const configPath = options.configPath || defaultGatewayConfigPath(options.repoDir || REPO_DIR);
  const bridgeOptions = {
    bridgeScript: options.bridgeScript || BRIDGE_SCRIPT,
    repoDir: options.repoDir || REPO_DIR,
    nodeBin: options.nodeBin || NODE_BIN,
  };
  const auditLog = options.auditLog || AUDIT_LOG;
  const activeThreads = new Set();
  let activeChatRequests = 0;

  async function getBots() {
    const result = await runBridge('summary', '', null, bridgeOptions);
    if (result.ok === false) throw Object.assign(new Error(result.error || 'could not list bots'), { statusCode: 500 });
    return Array.isArray(result.accounts) ? result.accounts.map(safeBot) : [];
  }

  async function requireKnownAccount(account) {
    const bots = await getBots();
    if (!bots.some((bot) => bot.account === account)) {
      throw Object.assign(new Error(`bot not found: ${account}`), { statusCode: 404 });
    }
    return bots;
  }

  async function requireRemoteThread(account, threadId) {
    const result = await runBridge('threads', account, null, bridgeOptions);
    if (result.ok === false) throw Object.assign(new Error(result.error || 'could not read thread'), { statusCode: 500 });
    const thread = (result.threads || []).find((item) => item.id === threadId && isRemoteCliThread(item));
    if (!thread) throw Object.assign(new Error(`remote CLI thread not found: ${threadId}`), { statusCode: 404 });
    return thread;
  }

  return async function handleRemoteGatewayRequest(req, res) {
    const requestStartedAt = Date.now();
    const requestUrl = new URL(req.url || '/', 'http://127.0.0.1');
    if (req.method === 'GET' && requestUrl.pathname === '/healthz') {
      sendJson(res, { ok: true, service: 'suncodexclaw-remote-gateway' });
      return;
    }
    if (!requestUrl.pathname.startsWith('/v1/')) {
      sendJson(res, { ok: false, error: 'not found' }, 404);
      return;
    }

    const config = loadGatewayConfig(configPath);
    const secret = bearerSecret(req);
    const accessToken = secret ? findAccessToken(config, secret) : null;
    if (!accessToken) {
      appendAudit({
        tokenId: '',
        method: req.method,
        path: requestUrl.pathname,
        remoteAddress: normalizeString(req.socket.remoteAddress),
        status: 401,
      }, auditLog);
      sendJson(res, { ok: false, error: 'unauthorized' }, 401);
      return;
    }

    let responseStatus = 200;
    try {
      const segments = decodePathSegments(requestUrl.pathname);
      if (req.method === 'GET' && segments.length === 2 && segments[1] === 'machine') {
        if (!tokenHasScope(accessToken, 'bots:read')) throw Object.assign(new Error('forbidden'), { statusCode: 403 });
        sendJson(res, { ok: true, machine: safeMachine(config) });
        return;
      }

      if (req.method === 'GET' && segments.length === 2 && segments[1] === 'bots') {
        if (!tokenHasScope(accessToken, 'bots:read')) throw Object.assign(new Error('forbidden'), { statusCode: 403 });
        const bots = await getBots();
        sendJson(res, { ok: true, machine: safeMachine(config), bots });
        return;
      }

      if (segments.length >= 4 && segments[1] === 'bots' && segments[3] === 'threads') {
        const account = normalizeString(segments[2]);
        if (!account) throw Object.assign(new Error('account is required'), { statusCode: 400 });
        await requireKnownAccount(account);

        if (req.method === 'GET' && segments.length === 4) {
          if (!tokenHasScope(accessToken, 'bots:read')) throw Object.assign(new Error('forbidden'), { statusCode: 403 });
          const result = await runBridge('threads', account, null, bridgeOptions);
          if (result.ok === false) throw Object.assign(new Error(result.error || 'could not list threads'), { statusCode: 500 });
          sendJson(res, safeThreadEnvelope(result));
          return;
        }

        if (req.method === 'POST' && segments.length === 4) {
          if (!tokenHasScope(accessToken, 'chat:write')) throw Object.assign(new Error('forbidden'), { statusCode: 403 });
          const body = await readJsonBody(req);
          const result = await runBridge('thread-create', account, {
            name: normalizeString(body.name) || 'CLI 会话',
            source: 'remote_cli',
          }, bridgeOptions);
          if (result.ok === false) throw Object.assign(new Error(result.error || 'could not create thread'), { statusCode: 500 });
          sendJson(res, safeThreadEnvelope(result));
          return;
        }

        const threadId = normalizeString(segments[4]);
        if (req.method === 'GET' && segments.length === 5) {
          if (!tokenHasScope(accessToken, 'bots:read')) throw Object.assign(new Error('forbidden'), { statusCode: 403 });
          const thread = await requireRemoteThread(account, threadId);
          sendJson(res, { ok: true, account, thread: safeThread(thread) });
          return;
        }

        if (req.method === 'POST' && segments.length === 6 && segments[5] === 'messages') {
          if (!tokenHasScope(accessToken, 'chat:write')) throw Object.assign(new Error('forbidden'), { statusCode: 403 });
          await requireRemoteThread(account, threadId);
          const body = await readJsonBody(req);
          const text = normalizeString(body.text);
          if (!text) throw Object.assign(new Error('text is required'), { statusCode: 400 });
          if (text.length > 200000) throw Object.assign(new Error('message is too long'), { statusCode: 413 });
          const lockKey = `${account}:${threadId}`;
          if (activeThreads.has(lockKey)) {
            throw Object.assign(new Error('this thread is already running a task'), { statusCode: 409 });
          }
          if (activeChatRequests >= MAX_CONCURRENT_CHAT_REQUESTS) {
            throw Object.assign(new Error('too many active remote tasks'), { statusCode: 429 });
          }
          activeThreads.add(lockKey);
          activeChatRequests += 1;
          try {
            const result = await runBridge('thread-send', account, {
              thread_id: threadId,
              text,
              deliver: 'remote_cli',
            }, bridgeOptions);
            if (result.ok === false) throw Object.assign(new Error(result.error || 'message failed'), { statusCode: 500 });
            sendJson(res, {
              ...safeThreadEnvelope(result, result.thread),
              reply: normalizeString(result.reply),
              route: result.agentGatewayRoute || null,
            });
            return;
          } finally {
            activeThreads.delete(lockKey);
            activeChatRequests -= 1;
          }
        }
      }

      throw Object.assign(new Error('not found'), { statusCode: 404 });
    } catch (error) {
      responseStatus = Number(error.statusCode) || 500;
      sendJson(res, { ok: false, error: error.message || String(error) }, responseStatus);
    } finally {
      appendAudit({
        tokenId: accessToken.id,
        tokenName: accessToken.name,
        method: req.method,
        path: requestUrl.pathname,
        remoteAddress: normalizeString(req.socket.remoteAddress),
        status: responseStatus,
        durationMs: Date.now() - requestStartedAt,
      }, auditLog);
    }
  };
}

function createRemoteGatewayServer(options = {}) {
  const server = http.createServer(createRemoteGatewayHandler(options));
  server.requestTimeout = 0;
  server.headersTimeout = 30000;
  return server;
}

function relayWebSocketUrl(relayUrl, endpoint, params = {}) {
  const url = new URL(normalizeRelayUrl(relayUrl));
  const basePath = url.pathname.replace(/\/+$/g, '');
  url.pathname = `${basePath}${endpoint.startsWith('/') ? endpoint : `/${endpoint}`}`;
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, normalizeString(value));
  return url.toString();
}

function validRelayRpcRequest(payload = {}) {
  const method = normalizeString(payload.method).toUpperCase();
  const apiPath = normalizeString(payload.path);
  return ['GET', 'POST'].includes(method)
    && /^\/v1\/[A-Za-z0-9_./%-]+$/.test(apiPath)
    && !apiPath.includes('..')
    && (payload.body === undefined || (payload.body && typeof payload.body === 'object' && !Array.isArray(payload.body)));
}

async function handleRelayRpcFrame(frame, options = {}) {
  const configPath = options.configPath || defaultGatewayConfigPath(options.repoDir || REPO_DIR);
  const localBaseUrl = normalizeString(options.localBaseUrl);
  const config = loadGatewayConfig(configPath);
  const token = findAccessTokenByClientId(config, frame.clientId, { includeRevoked: true });
  if (!token?.encryptionKey) throw new Error('unknown relay client');
  const context = {
    machineId: config.machineId,
    clientId: token.clientId,
    requestId: frame.requestId,
    direction: 'request',
  };
  const request = decryptRelayPayload(token.encryptionKey, frame.envelope, context);
  let status = 400;
  let body = { ok: false, error: 'invalid relay request' };
  if (validRelayRpcRequest(request)) {
    try {
      const response = await fetch(`${localBaseUrl}${request.path}`, {
        method: normalizeString(request.method).toUpperCase(),
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${token.encryptionKey}`,
          ...(request.body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: request.body === undefined ? undefined : JSON.stringify(request.body),
      });
      status = response.status;
      const raw = await response.text();
      try {
        body = raw ? JSON.parse(raw) : {};
      } catch (_) {
        body = { ok: false, error: 'local gateway returned invalid JSON' };
        status = 502;
      }
    } catch (error) {
      status = 502;
      body = { ok: false, error: `local gateway unavailable: ${error.message}` };
    }
  }
  return {
    type: 'rpc_response',
    routeId: frame.routeId,
    machineId: config.machineId,
    clientId: token.clientId,
    requestId: frame.requestId,
    envelope: encryptRelayPayload(token.encryptionKey, { status, body }, {
      ...context,
      direction: 'response',
    }),
  };
}

function startRelayHostLoop(options = {}) {
  const configPath = options.configPath || defaultGatewayConfigPath(options.repoDir || REPO_DIR);
  const localBaseUrl = normalizeString(options.localBaseUrl);
  const log = typeof options.log === 'function' ? options.log : (message) => process.stdout.write(`${message}\n`);
  let stopped = false;
  let socket = null;
  let reconnectTimer = null;
  let retryDelay = 1000;

  function scheduleReconnect() {
    if (stopped || reconnectTimer) return;
    const waitMs = Math.min(30000, retryDelay) + Math.floor(Math.random() * 400);
    retryDelay = Math.min(30000, retryDelay * 2);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, waitMs);
    reconnectTimer.unref?.();
  }

  function connect() {
    if (stopped) return;
    const config = loadGatewayConfig(configPath);
    if (!config.relayUrl || !config.machineSecret) {
      log('SCC_RELAY_HOST_DISABLED relay URL or machine secret is missing');
      return;
    }
    const url = relayWebSocketUrl(config.relayUrl, '/v1/host', { machineId: config.machineId });
    socket = new WebSocket(url, {
      headers: {
        authorization: `Bearer ${config.machineSecret}`,
        ...(config.registrationKey ? { 'x-scc-registration-key': config.registrationKey } : {}),
      },
      handshakeTimeout: 15000,
      maxPayload: 3 * 1024 * 1024,
    });
    socket.on('open', () => {
      retryDelay = 1000;
      log(`SCC_RELAY_HOST_CONNECTED relay=${config.relayUrl} machine=${config.machineName}`);
    });
    socket.on('message', (raw) => {
      let frame;
      try {
        frame = JSON.parse(String(raw || ''));
      } catch (_) {
        return;
      }
      if (frame?.type !== 'rpc_request') return;
      handleRelayRpcFrame(frame, { configPath, localBaseUrl }).then((responseFrame) => {
        if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(responseFrame));
      }).catch((error) => {
        if (socket?.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({
            type: 'rpc_error',
            routeId: frame.routeId,
            clientId: frame.clientId,
            requestId: frame.requestId,
            error: error.message === 'unknown relay client' ? 'unauthorized_client' : 'invalid_encrypted_request',
          }));
        }
      });
    });
    socket.on('error', (error) => {
      log(`SCC_RELAY_HOST_ERROR ${error.message}`);
    });
    socket.on('close', () => {
      socket = null;
      if (!stopped) {
        log('SCC_RELAY_HOST_DISCONNECTED reconnecting=true');
        scheduleReconnect();
      }
    });
  }

  connect();
  return {
    stop() {
      stopped = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = null;
      if (socket && socket.readyState < WebSocket.CLOSING) socket.close(1000, 'host stopping');
    },
  };
}

function isTailscaleIpv4(value) {
  const parts = normalizeString(value).split('.').map(Number);
  return parts.length === 4
    && parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)
    && parts[0] === 100
    && parts[1] >= 64
    && parts[1] <= 127;
}

function detectTailscaleIpv4() {
  const interfaces = os.networkInterfaces();
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries || []) {
      if (entry.family === 'IPv4' && isTailscaleIpv4(entry.address)) return entry.address;
    }
  }
  return '';
}

function setupGateway(configPath = defaultGatewayConfigPath()) {
  const existing = loadGatewayConfig(configPath, { required: false });
  const requestedPort = Number(getArg('--port', existing?.port || DEFAULT_REMOTE_PORT));
  const port = Number.isInteger(requestedPort) && requestedPort > 0 && requestedPort <= 65535
    ? requestedPort
    : DEFAULT_REMOTE_PORT;
  const requestedUrl = normalizeString(getArg('--url', ''));
  const requestedHost = normalizeString(getArg('--host', ''));
  const requestedRelay = normalizeString(getArg('--relay', process.env.SCC_RELAY_URL || ''));
  const relayUrl = hasFlag('--direct') ? '' : normalizeRelayUrl(requestedRelay || existing?.relayUrl || '');
  const tailscaleIp = detectTailscaleIpv4();
  let bindHost = requestedHost;
  let connectUrl = requestedUrl;

  if (relayUrl) {
    bindHost = requestedHost || '127.0.0.1';
    connectUrl = `http://127.0.0.1:${port}`;
  } else if (!bindHost && !connectUrl && tailscaleIp) {
    bindHost = tailscaleIp;
    connectUrl = `http://${tailscaleIp}:${port}`;
  }
  if (!bindHost) bindHost = existing?.bindHost || '127.0.0.1';
  if (!connectUrl) connectUrl = existing?.connectUrl || `http://${bindHost === '0.0.0.0' ? '127.0.0.1' : bindHost}:${port}`;
  connectUrl = normalizeConnectUrl(connectUrl);

  let config = normalizeGatewayConfig({
    ...(existing || {}),
    machineName: normalizeString(getArg('--machine-name', '')) || existing?.machineName || os.hostname(),
    bindHost,
    port,
    connectUrl,
    relayUrl,
    machineSecret: existing?.machineSecret || createSecret(),
    registrationKey: normalizeString(getArg('--registration-key', '')) || existing?.registrationKey || '',
  });
  const issued = createAccessToken(config, { name: normalizeString(getArg('--name', '')) || 'first CLI' });
  config = saveGatewayConfig(issued.config, configPath);
  const connectionToken = config.relayUrl
    ? encodeRelayConnectionToken({
      relayUrl: config.relayUrl,
      encryptionKey: issued.encryptionKey,
      machineId: config.machineId,
      machineName: config.machineName,
      tokenId: issued.record.id,
      clientId: issued.record.clientId,
    })
    : encodeConnectionToken({
      url: config.connectUrl,
      secret: issued.secret,
      machineId: config.machineId,
      machineName: config.machineName,
      tokenId: issued.record.id,
    });

  jsonLine({
    ok: true,
    configPath,
    machine: safeMachine(config),
    bindHost: config.bindHost,
    port: config.port,
    transport: config.relayUrl ? 'relay' : 'direct',
    relayUrl: config.relayUrl,
    connectUrl: config.connectUrl,
    tokenId: issued.record.id,
    tokenName: issued.record.name,
    connectionToken,
    networkReady: Boolean(config.relayUrl) || !['127.0.0.1', 'localhost', '::1'].includes(new URL(config.connectUrl).hostname),
    warning: config.relayUrl || tailscaleIp || requestedUrl
      ? ''
      : 'No relay, Tailscale address, or public tunnel URL was configured. This direct token works only on this computer.',
  });
}

function createPairingToken(configPath = defaultGatewayConfigPath()) {
  let config = loadGatewayConfig(configPath);
  const requestedUrl = normalizeString(getArg('--url', ''));
  if (requestedUrl) config.connectUrl = normalizeConnectUrl(requestedUrl);
  const issued = createAccessToken(config, { name: normalizeString(getArg('--name', '')) || 'CLI client' });
  config = saveGatewayConfig(issued.config, configPath);
  const connectionToken = config.relayUrl
    ? encodeRelayConnectionToken({
      relayUrl: config.relayUrl,
      encryptionKey: issued.encryptionKey,
      machineId: config.machineId,
      machineName: config.machineName,
      tokenId: issued.record.id,
      clientId: issued.record.clientId,
    })
    : encodeConnectionToken({
      url: config.connectUrl,
      secret: issued.secret,
      machineId: config.machineId,
      machineName: config.machineName,
      tokenId: issued.record.id,
    });
  jsonLine({
    ok: true,
    tokenId: issued.record.id,
    tokenName: issued.record.name,
    transport: config.relayUrl ? 'relay' : 'direct',
    relayUrl: config.relayUrl,
    connectUrl: config.connectUrl,
    connectionToken,
  });
}

function listTokens(configPath = defaultGatewayConfigPath()) {
  const config = loadGatewayConfig(configPath);
  jsonLine({
    ok: true,
    machine: safeMachine(config),
    connectUrl: config.connectUrl,
    relayUrl: config.relayUrl,
    transport: config.relayUrl ? 'relay' : 'direct',
    tokens: config.tokens.map((token) => ({
      id: token.id,
      clientId: token.clientId,
      name: token.name,
      scopes: token.scopes,
      createdAt: token.createdAt,
      lastUsedAt: token.lastUsedAt,
      revokedAt: token.revokedAt,
    })),
  });
}

function revokeToken(configPath = defaultGatewayConfigPath()) {
  const tokenId = normalizeString(getArg('--id', process.argv[3] || ''));
  if (!tokenId) throw new Error('token id is required: remote:token:revoke -- --id tok_xxx');
  const config = loadGatewayConfig(configPath);
  const token = config.tokens.find((item) => item.id === tokenId);
  if (!token) throw new Error(`token not found: ${tokenId}`);
  token.revokedAt = new Date().toISOString();
  saveGatewayConfig(config, configPath);
  jsonLine({ ok: true, tokenId, revokedAt: token.revokedAt });
}

function printStatus(configPath = defaultGatewayConfigPath()) {
  const config = loadGatewayConfig(configPath);
  jsonLine({
    ok: true,
    configPath,
    machine: safeMachine(config),
    bindHost: config.bindHost,
    port: config.port,
    connectUrl: config.connectUrl,
    relayUrl: config.relayUrl,
    transport: config.relayUrl ? 'relay' : 'direct',
    activeTokens: config.tokens.filter((token) => !token.revokedAt).length,
    revokedTokens: config.tokens.filter((token) => token.revokedAt).length,
  });
}

function printUsage() {
  process.stdout.write(`SunCodexClaw remote gateway\n\n`);
  process.stdout.write(`  node tools/remote_gateway.js setup --relay wss://relay.example.com [--registration-key KEY] [--machine-name NAME]\n`);
  process.stdout.write(`  node tools/remote_gateway.js setup --direct [--host IP] [--port 8732] [--url URL]\n`);
  process.stdout.write(`  node tools/remote_gateway.js start\n`);
  process.stdout.write(`  node tools/remote_gateway.js pair [--name CLIENT] [--url URL]\n`);
  process.stdout.write(`  node tools/remote_gateway.js token-list\n`);
  process.stdout.write(`  node tools/remote_gateway.js token-revoke --id tok_xxx\n`);
  process.stdout.write(`  node tools/remote_gateway.js status\n`);
}

async function main() {
  const command = normalizeString(process.argv[2] || 'help');
  const configPath = defaultGatewayConfigPath();
  if (command === 'setup') {
    setupGateway(configPath);
    return;
  }
  if (command === 'pair') {
    createPairingToken(configPath);
    return;
  }
  if (command === 'token-list') {
    listTokens(configPath);
    return;
  }
  if (command === 'token-revoke') {
    revokeToken(configPath);
    return;
  }
  if (command === 'status') {
    printStatus(configPath);
    return;
  }
  if (command === 'start') {
    const config = loadGatewayConfig(configPath);
    const host = normalizeString(getArg('--host', process.env.SCC_REMOTE_HOST || config.bindHost)) || config.bindHost;
    const port = Number(getArg('--port', process.env.SCC_REMOTE_PORT || config.port)) || config.port;
    const server = createRemoteGatewayServer({ configPath });
    let relayHostLoop = null;
    server.listen(port, host, () => {
      process.stdout.write(`SCC_REMOTE_GATEWAY_RUNNING http://${host}:${port} machine=${config.machineName}\n`);
      if (config.relayUrl) {
        const localBaseUrl = `http://127.0.0.1:${port}`;
        relayHostLoop = startRelayHostLoop({ configPath, localBaseUrl });
      }
    });
    const shutdown = () => {
      relayHostLoop?.stop();
      server.close(() => process.exit(0));
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    return;
  }
  if (command === 'help' || hasFlag('--help') || hasFlag('-h')) {
    printUsage();
    return;
  }
  throw new Error(`unknown command: ${command}`);
}

module.exports = {
  createRemoteGatewayHandler,
  createRemoteGatewayServer,
  detectTailscaleIpv4,
  handleRelayRpcFrame,
  isTailscaleIpv4,
  relayWebSocketUrl,
  runBridge,
  safeBot,
  safeThread,
  startRelayHostLoop,
};

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error.message || String(error)}\n`);
    process.exit(1);
  });
}
