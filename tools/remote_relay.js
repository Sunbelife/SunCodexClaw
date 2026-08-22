#!/usr/bin/env node
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { WebSocket, WebSocketServer } = require('ws');
const { hashSecret, writePrivateJson } = require('./lib/remote_access');

const REPO_DIR = path.resolve(__dirname, '..');
const DEFAULT_PORT = 8782;
const MAX_FRAME_BYTES = 3 * 1024 * 1024;
const MAX_CLIENTS_PER_IP = 24;

function normalizeString(value) {
  return String(value || '').trim();
}

function getArg(flag, fallback = '') {
  const index = process.argv.indexOf(flag);
  return index >= 0 && index + 1 < process.argv.length ? process.argv[index + 1] : fallback;
}

function defaultRegistryPath() {
  return process.env.SCC_RELAY_REGISTRY
    ? path.resolve(process.env.SCC_RELAY_REGISTRY)
    : path.join(REPO_DIR, '.runtime', 'relay', 'registry.json');
}

function readRegistry(filePath) {
  if (!fs.existsSync(filePath)) return { version: 1, machines: {} };
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return {
      version: 1,
      machines: parsed?.machines && typeof parsed.machines === 'object' ? parsed.machines : {},
    };
  } catch (error) {
    throw new Error(`invalid relay registry ${filePath}: ${error.message}`);
  }
}

function saveRegistry(registry, filePath) {
  writePrivateJson(filePath, { version: 1, machines: registry.machines || {} });
}

function safeId(value, maxLength = 120) {
  const text = normalizeString(value);
  return text.length <= maxLength && /^[A-Za-z0-9_-]+$/.test(text) ? text : '';
}

function bearerSecret(req) {
  const match = normalizeString(req.headers.authorization).match(/^Bearer\s+(.+)$/i);
  return match ? normalizeString(match[1]) : '';
}

function constantTextMatch(actualValue, expectedValue) {
  const actual = Buffer.from(normalizeString(actualValue), 'utf8');
  const expected = Buffer.from(normalizeString(expectedValue), 'utf8');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function rejectUpgrade(socket, status = 401, message = 'Unauthorized') {
  socket.write(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

function sendJson(res, status, payload) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(`${JSON.stringify(payload)}\n`);
}

function remoteIp(req) {
  const forwarded = normalizeString(req.headers['x-forwarded-for']).split(',')[0].trim();
  return forwarded || normalizeString(req.socket.remoteAddress) || 'unknown';
}

function parseFrame(raw) {
  const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw || '');
  if (Buffer.byteLength(text, 'utf8') > MAX_FRAME_BYTES) throw new Error('frame too large');
  const frame = JSON.parse(text);
  if (!frame || typeof frame !== 'object' || Array.isArray(frame)) throw new Error('invalid frame');
  return frame;
}

function isEncryptedEnvelope(value) {
  return Boolean(value
    && value.v === 1
    && normalizeString(value.iv)
    && normalizeString(value.ciphertext)
    && normalizeString(value.tag));
}

function createRelayServer(options = {}) {
  const registryPath = options.registryPath || defaultRegistryPath();
  const registrationKey = normalizeString(options.registrationKey ?? process.env.SCC_RELAY_REGISTRATION_KEY);
  const hostSockets = new Map();
  const clientSockets = new Map();
  const clientsByMachine = new Map();
  const connectionCountsByIp = new Map();
  const hostWss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });
  const clientWss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });

  const server = http.createServer((req, res) => {
    const requestUrl = new URL(req.url || '/', 'http://127.0.0.1');
    if (req.method === 'GET' && requestUrl.pathname === '/healthz') {
      sendJson(res, 200, {
        ok: true,
        service: 'suncodexclaw-relay',
        onlineMachines: hostSockets.size,
        connectedClients: clientSockets.size,
      });
      return;
    }
    sendJson(res, 404, { ok: false, error: 'not found' });
  });

  function notifyMachineState(machineId, online) {
    const ids = clientsByMachine.get(machineId) || new Set();
    for (const routeId of ids) {
      const client = clientSockets.get(routeId);
      if (client?.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify({ type: 'relay_state', machineId, online }));
      }
    }
  }

  function releaseClient(ws) {
    const { routeId, machineId, ip } = ws.sccMeta || {};
    if (routeId) clientSockets.delete(routeId);
    if (machineId && clientsByMachine.has(machineId)) {
      const ids = clientsByMachine.get(machineId);
      ids.delete(routeId);
      if (!ids.size) clientsByMachine.delete(machineId);
    }
    if (ip) {
      const next = Math.max(0, (connectionCountsByIp.get(ip) || 1) - 1);
      if (next) connectionCountsByIp.set(ip, next);
      else connectionCountsByIp.delete(ip);
    }
  }

  hostWss.on('connection', (ws, req, meta) => {
    ws.isAlive = true;
    ws.sccMeta = meta;
    const previous = hostSockets.get(meta.machineId);
    if (previous && previous !== ws) previous.close(4001, 'replaced by a newer host connection');
    hostSockets.set(meta.machineId, ws);
    notifyMachineState(meta.machineId, true);

    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('message', (raw) => {
      try {
        const frame = parseFrame(raw);
        if (!['rpc_response', 'rpc_error'].includes(frame.type)) return;
        const routeId = safeId(frame.routeId);
        const clientId = safeId(frame.clientId);
        const requestId = safeId(frame.requestId);
        const client = clientSockets.get(routeId);
        if (!client || client.readyState !== WebSocket.OPEN) return;
        if (client.sccMeta.machineId !== meta.machineId || client.sccMeta.clientId !== clientId) return;
        if (!requestId) return;
        if (frame.type === 'rpc_error') {
          client.send(JSON.stringify({
            type: 'rpc_error',
            requestId,
            error: normalizeString(frame.error) || 'host_rejected_request',
          }));
          return;
        }
        if (!isEncryptedEnvelope(frame.envelope)) return;
        client.send(JSON.stringify({
          type: 'rpc_response',
          machineId: meta.machineId,
          clientId,
          requestId,
          envelope: frame.envelope,
        }));
      } catch (_) {
        ws.close(1008, 'invalid host frame');
      }
    });
    ws.on('close', () => {
      if (hostSockets.get(meta.machineId) === ws) {
        hostSockets.delete(meta.machineId);
        notifyMachineState(meta.machineId, false);
      }
    });
  });

  clientWss.on('connection', (ws, req, meta) => {
    ws.isAlive = true;
    ws.sccMeta = { ...meta, messageWindowStartedAt: Date.now(), messageCount: 0 };
    clientSockets.set(meta.routeId, ws);
    if (!clientsByMachine.has(meta.machineId)) clientsByMachine.set(meta.machineId, new Set());
    clientsByMachine.get(meta.machineId).add(meta.routeId);
    ws.send(JSON.stringify({
      type: 'relay_state',
      machineId: meta.machineId,
      online: hostSockets.get(meta.machineId)?.readyState === WebSocket.OPEN,
    }));

    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('message', (raw) => {
      try {
        const now = Date.now();
        if (now - ws.sccMeta.messageWindowStartedAt >= 60000) {
          ws.sccMeta.messageWindowStartedAt = now;
          ws.sccMeta.messageCount = 0;
        }
        ws.sccMeta.messageCount += 1;
        if (ws.sccMeta.messageCount > 120) {
          ws.close(1013, 'client rate limit exceeded');
          return;
        }
        const frame = parseFrame(raw);
        const requestId = safeId(frame.requestId);
        if (frame.type !== 'rpc_request'
          || frame.machineId !== meta.machineId
          || frame.clientId !== meta.clientId
          || !requestId
          || !isEncryptedEnvelope(frame.envelope)) {
          throw new Error('invalid client frame');
        }
        const host = hostSockets.get(meta.machineId);
        if (!host || host.readyState !== WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'rpc_error', requestId, error: 'machine_offline' }));
          return;
        }
        host.send(JSON.stringify({
          type: 'rpc_request',
          routeId: meta.routeId,
          machineId: meta.machineId,
          clientId: meta.clientId,
          requestId,
          envelope: frame.envelope,
        }));
      } catch (_) {
        ws.close(1008, 'invalid client frame');
      }
    });
    ws.on('close', () => releaseClient(ws));
  });

  server.on('upgrade', (req, socket, head) => {
    let requestUrl;
    try {
      requestUrl = new URL(req.url || '/', 'http://127.0.0.1');
    } catch (_) {
      rejectUpgrade(socket, 400, 'Bad Request');
      return;
    }

    if (requestUrl.pathname === '/v1/host') {
      const machineId = safeId(requestUrl.searchParams.get('machineId'));
      const secret = bearerSecret(req);
      if (!machineId || !secret) {
        rejectUpgrade(socket);
        return;
      }
      const registry = readRegistry(registryPath);
      const existing = registry.machines[machineId];
      if (existing) {
        if (!constantTextMatch(hashSecret(secret), existing.secretHash)) {
          rejectUpgrade(socket);
          return;
        }
      } else {
        const providedRegistrationKey = normalizeString(req.headers['x-scc-registration-key']);
        if (registrationKey && !constantTextMatch(providedRegistrationKey, registrationKey)) {
          rejectUpgrade(socket, 403, 'Forbidden');
          return;
        }
        registry.machines[machineId] = {
          secretHash: hashSecret(secret),
          createdAt: new Date().toISOString(),
        };
        saveRegistry(registry, registryPath);
      }
      hostWss.handleUpgrade(req, socket, head, (ws) => {
        hostWss.emit('connection', ws, req, { machineId });
      });
      return;
    }

    if (requestUrl.pathname === '/v1/client') {
      const machineId = safeId(requestUrl.searchParams.get('machineId'));
      const clientId = safeId(requestUrl.searchParams.get('clientId'));
      const ip = remoteIp(req);
      if (!machineId || !clientId || (connectionCountsByIp.get(ip) || 0) >= MAX_CLIENTS_PER_IP) {
        rejectUpgrade(socket, 429, 'Too Many Requests');
        return;
      }
      connectionCountsByIp.set(ip, (connectionCountsByIp.get(ip) || 0) + 1);
      const routeId = `route_${crypto.randomBytes(12).toString('base64url')}`;
      clientWss.handleUpgrade(req, socket, head, (ws) => {
        clientWss.emit('connection', ws, req, { machineId, clientId, routeId, ip });
      });
      return;
    }
    rejectUpgrade(socket, 404, 'Not Found');
  });

  const heartbeat = setInterval(() => {
    for (const ws of [...hostSockets.values(), ...clientSockets.values()]) {
      if (ws.isAlive === false) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }, 25000);
  heartbeat.unref();

  server.on('close', () => {
    clearInterval(heartbeat);
    for (const ws of [...hostSockets.values(), ...clientSockets.values()]) ws.close(1001, 'relay shutting down');
  });

  server.sccState = { hostSockets, clientSockets, registryPath };
  return server;
}

function printUsage() {
  process.stdout.write('SunCodexClaw zero-knowledge relay\n\n');
  process.stdout.write('  node tools/remote_relay.js start [--host 127.0.0.1] [--port 8782] [--registry PATH]\n');
  process.stdout.write('  Environment: SCC_RELAY_REGISTRATION_KEY=<host registration secret>\n');
}

function main() {
  const command = normalizeString(process.argv[2] || 'help');
  if (command === 'help' || process.argv.includes('--help') || process.argv.includes('-h')) {
    printUsage();
    return;
  }
  if (command !== 'start') throw new Error(`unknown command: ${command}`);
  const host = normalizeString(getArg('--host', process.env.SCC_RELAY_HOST || '127.0.0.1')) || '127.0.0.1';
  const port = Number(getArg('--port', process.env.SCC_RELAY_PORT || DEFAULT_PORT)) || DEFAULT_PORT;
  const registryPath = path.resolve(getArg('--registry', defaultRegistryPath()));
  const server = createRelayServer({ registryPath });
  server.listen(port, host, () => {
    process.stdout.write(`SCC_RELAY_RUNNING ws://${host}:${port} registry=${registryPath}\n`);
  });
  const shutdown = () => server.close(() => process.exit(0));
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

module.exports = {
  createRelayServer,
  readRegistry,
  safeId,
};

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error.message || String(error)}\n`);
    process.exit(1);
  }
}
