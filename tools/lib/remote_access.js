const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CONNECTION_TOKEN_PREFIX = 'scc1_';
const RELAY_CONNECTION_TOKEN_PREFIX = 'scc2_';
const DEFAULT_REMOTE_PORT = 8732;
const DEFAULT_SCOPES = ['bots:read', 'chat:write'];

function normalizeString(value) {
  return String(value || '').trim();
}

function uniqueStrings(values = []) {
  return Array.from(new Set((Array.isArray(values) ? values : [])
    .map((value) => normalizeString(value))
    .filter(Boolean)));
}

function defaultGatewayConfigPath(repoDir = path.resolve(__dirname, '..', '..')) {
  return process.env.SCC_REMOTE_CONFIG
    ? path.resolve(process.env.SCC_REMOTE_CONFIG)
    : path.join(repoDir, '.runtime', 'remote_gateway', 'config.json');
}

function defaultCliConfigPath() {
  if (process.env.SCC_CLI_CONFIG) return path.resolve(process.env.SCC_CLI_CONFIG);
  const configRoot = process.env.XDG_CONFIG_HOME
    ? path.resolve(process.env.XDG_CONFIG_HOME)
    : path.join(os.homedir(), '.config');
  return path.join(configRoot, 'suncodexclaw', 'cli.json');
}

function nowIso() {
  return new Date().toISOString();
}

function createId(prefix = '') {
  return `${prefix}${crypto.randomBytes(9).toString('base64url')}`;
}

function createSecret() {
  return crypto.randomBytes(32).toString('base64url');
}

function hashSecret(secret) {
  return crypto.createHash('sha256').update(normalizeString(secret), 'utf8').digest('hex');
}

function normalizeConnectUrl(value) {
  const raw = normalizeString(value).replace(/\/+$/g, '');
  if (!raw) return '';
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`invalid connection URL: ${raw}`);
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('connection URL must use http:// or https://');
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('connection URL must not contain credentials, query, or fragment');
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/g, '');
  return parsed.toString().replace(/\/+$/g, '');
}

function normalizeRelayUrl(value) {
  const raw = normalizeString(value).replace(/\/+$/g, '');
  if (!raw) return '';
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`invalid relay URL: ${raw}`);
  }
  if (parsed.protocol === 'http:') parsed.protocol = 'ws:';
  if (parsed.protocol === 'https:') parsed.protocol = 'wss:';
  if (!['ws:', 'wss:'].includes(parsed.protocol)) {
    throw new Error('relay URL must use ws:// or wss://');
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('relay URL must not contain credentials, query, or fragment');
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/g, '');
  return parsed.toString().replace(/\/+$/g, '');
}

function normalizeTokenRecord(record = {}) {
  return {
    id: normalizeString(record.id) || createId('tok_'),
    clientId: normalizeString(record.clientId || record.client_id) || createId('client_'),
    name: normalizeString(record.name) || 'CLI client',
    secretHash: normalizeString(record.secretHash || record.secret_hash),
    encryptionKey: normalizeString(record.encryptionKey || record.encryption_key),
    scopes: uniqueStrings(record.scopes).length ? uniqueStrings(record.scopes) : [...DEFAULT_SCOPES],
    createdAt: normalizeString(record.createdAt || record.created_at) || nowIso(),
    lastUsedAt: normalizeString(record.lastUsedAt || record.last_used_at),
    revokedAt: normalizeString(record.revokedAt || record.revoked_at),
  };
}

function normalizeGatewayConfig(config = {}) {
  const port = Number(config.port);
  return {
    version: 2,
    machineId: normalizeString(config.machineId || config.machine_id) || createId('machine_'),
    machineName: normalizeString(config.machineName || config.machine_name) || os.hostname(),
    bindHost: normalizeString(config.bindHost || config.bind_host) || '127.0.0.1',
    port: Number.isInteger(port) && port > 0 && port <= 65535 ? port : DEFAULT_REMOTE_PORT,
    connectUrl: normalizeConnectUrl(config.connectUrl || config.connect_url || `http://127.0.0.1:${DEFAULT_REMOTE_PORT}`),
    relayUrl: normalizeRelayUrl(config.relayUrl || config.relay_url),
    machineSecret: normalizeString(config.machineSecret || config.machine_secret),
    registrationKey: normalizeString(config.registrationKey || config.registration_key),
    tokens: Array.isArray(config.tokens) ? config.tokens.map(normalizeTokenRecord) : [],
    createdAt: normalizeString(config.createdAt || config.created_at) || nowIso(),
    updatedAt: normalizeString(config.updatedAt || config.updated_at) || nowIso(),
  };
}

function readJson(filePath, fallback = null) {
  if (!fs.existsSync(filePath)) return fallback;
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writePrivateJson(filePath, value) {
  const parent = path.dirname(filePath);
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(parent, 0o700);
  } catch (_) {
    // Windows and some mounted filesystems do not support POSIX modes.
  }
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tempPath, filePath);
  try {
    fs.chmodSync(filePath, 0o600);
  } catch (_) {
    // Best effort on non-POSIX systems.
  }
}

function loadGatewayConfig(filePath = defaultGatewayConfigPath(), { required = true } = {}) {
  const loaded = readJson(filePath, null);
  if (!loaded) {
    if (!required) return null;
    throw new Error(`remote gateway is not configured: ${filePath}\nRun: npm run remote:setup`);
  }
  return normalizeGatewayConfig(loaded);
}

function saveGatewayConfig(config, filePath = defaultGatewayConfigPath()) {
  const normalized = normalizeGatewayConfig({ ...config, updatedAt: nowIso() });
  writePrivateJson(filePath, normalized);
  return normalized;
}

function createAccessToken(config, options = {}) {
  const normalized = normalizeGatewayConfig(config);
  const secret = createSecret();
  const encryptionKey = createSecret();
  const record = normalizeTokenRecord({
    id: createId('tok_'),
    clientId: createId('client_'),
    name: normalizeString(options.name) || 'CLI client',
    secretHash: hashSecret(secret),
    encryptionKey,
    scopes: uniqueStrings(options.scopes).length ? uniqueStrings(options.scopes) : DEFAULT_SCOPES,
    createdAt: nowIso(),
  });
  normalized.tokens.push(record);
  normalized.updatedAt = nowIso();
  return { config: normalized, record, secret, encryptionKey };
}

function encodeConnectionToken({ url, secret, machineId = '', machineName = '', tokenId = '' }) {
  const payload = {
    v: 1,
    u: normalizeConnectUrl(url),
    s: normalizeString(secret),
    m: normalizeString(machineId),
    n: normalizeString(machineName),
    t: normalizeString(tokenId),
  };
  if (!payload.u || !payload.s) throw new Error('connection URL and secret are required');
  return `${CONNECTION_TOKEN_PREFIX}${Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')}`;
}

function encodeRelayConnectionToken({ relayUrl, encryptionKey, machineId = '', machineName = '', tokenId = '', clientId = '' }) {
  const payload = {
    v: 2,
    r: normalizeRelayUrl(relayUrl),
    k: normalizeString(encryptionKey),
    m: normalizeString(machineId),
    n: normalizeString(machineName),
    t: normalizeString(tokenId),
    c: normalizeString(clientId),
  };
  if (!payload.r || !payload.k || !payload.m || !payload.c) {
    throw new Error('relay URL, encryption key, machine id, and client id are required');
  }
  return `${RELAY_CONNECTION_TOKEN_PREFIX}${Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')}`;
}

function decodeConnectionToken(value) {
  const token = normalizeString(value);
  const isRelay = token.startsWith(RELAY_CONNECTION_TOKEN_PREFIX);
  const isDirect = token.startsWith(CONNECTION_TOKEN_PREFIX);
  if (!isRelay && !isDirect) {
    throw new Error(`invalid connection token: expected ${RELAY_CONNECTION_TOKEN_PREFIX}… or ${CONNECTION_TOKEN_PREFIX}…`);
  }
  const prefix = isRelay ? RELAY_CONNECTION_TOKEN_PREFIX : CONNECTION_TOKEN_PREFIX;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(token.slice(prefix.length), 'base64url').toString('utf8'));
  } catch {
    throw new Error('invalid connection token payload');
  }
  if (isRelay) {
    if (payload?.v !== 2) throw new Error('unsupported relay connection token version');
    const decoded = {
      version: 2,
      transport: 'relay',
      relayUrl: normalizeRelayUrl(payload.r),
      encryptionKey: normalizeString(payload.k),
      machineId: normalizeString(payload.m),
      machineName: normalizeString(payload.n),
      tokenId: normalizeString(payload.t),
      clientId: normalizeString(payload.c),
    };
    if (!decoded.relayUrl || !decoded.encryptionKey || !decoded.machineId || !decoded.clientId) {
      throw new Error('relay connection token is incomplete');
    }
    return decoded;
  }
  if (payload?.v !== 1) throw new Error('unsupported direct connection token version');
  const decoded = {
    version: 1,
    transport: 'direct',
    url: normalizeConnectUrl(payload.u),
    secret: normalizeString(payload.s),
    machineId: normalizeString(payload.m),
    machineName: normalizeString(payload.n),
    tokenId: normalizeString(payload.t),
  };
  if (!decoded.url || !decoded.secret) throw new Error('connection token is incomplete');
  return decoded;
}

function secretsMatch(secret, expectedHash) {
  const actual = Buffer.from(hashSecret(secret), 'hex');
  const expected = Buffer.from(normalizeString(expectedHash), 'hex');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function findAccessToken(config, secret) {
  const tokens = Array.isArray(config?.tokens) ? config.tokens : [];
  return tokens.find((token) => !token.revokedAt && (
    secretsMatch(secret, token.secretHash)
    || (token.encryptionKey && constantStringMatch(secret, token.encryptionKey))
  )) || null;
}

function constantStringMatch(actualValue, expectedValue) {
  const actual = Buffer.from(normalizeString(actualValue), 'utf8');
  const expected = Buffer.from(normalizeString(expectedValue), 'utf8');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function findAccessTokenByClientId(config, clientId, { includeRevoked = false } = {}) {
  const target = normalizeString(clientId);
  const tokens = Array.isArray(config?.tokens) ? config.tokens : [];
  return tokens.find((token) => token.clientId === target && (includeRevoked || !token.revokedAt)) || null;
}

function buildEnvelopeAad(context = {}) {
  return Buffer.from([
    'suncodexclaw-relay-v1',
    normalizeString(context.machineId),
    normalizeString(context.clientId),
    normalizeString(context.requestId),
    normalizeString(context.direction),
  ].join('\n'), 'utf8');
}

function decodeEncryptionKey(value) {
  const key = Buffer.from(normalizeString(value), 'base64url');
  if (key.length !== 32) throw new Error('invalid relay encryption key');
  return key;
}

function encryptRelayPayload(encryptionKey, payload, context = {}) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', decodeEncryptionKey(encryptionKey), iv);
  cipher.setAAD(buildEnvelopeAad(context));
  const plaintext = Buffer.from(JSON.stringify(payload), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    v: 1,
    iv: iv.toString('base64url'),
    ciphertext: ciphertext.toString('base64url'),
    tag: cipher.getAuthTag().toString('base64url'),
  };
}

function decryptRelayPayload(encryptionKey, envelope, context = {}) {
  if (!envelope || envelope.v !== 1) throw new Error('unsupported encrypted envelope');
  const iv = Buffer.from(normalizeString(envelope.iv), 'base64url');
  const ciphertext = Buffer.from(normalizeString(envelope.ciphertext), 'base64url');
  const tag = Buffer.from(normalizeString(envelope.tag), 'base64url');
  if (iv.length !== 12 || tag.length !== 16 || ciphertext.length > 2 * 1024 * 1024) {
    throw new Error('invalid encrypted envelope');
  }
  const decipher = crypto.createDecipheriv('aes-256-gcm', decodeEncryptionKey(encryptionKey), iv);
  decipher.setAAD(buildEnvelopeAad(context));
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return JSON.parse(plaintext.toString('utf8'));
}

function tokenHasScope(token, scope) {
  return Boolean(token && Array.isArray(token.scopes) && token.scopes.includes(scope));
}

function normalizeCliConfig(config = {}) {
  const machines = {};
  for (const [alias, value] of Object.entries(config.machines || {})) {
    const safeAlias = normalizeString(alias);
    if (!safeAlias || !value || typeof value !== 'object') continue;
    try {
      machines[safeAlias] = {
        alias: safeAlias,
        transport: normalizeString(value.transport) || (value.relayUrl || value.relay_url ? 'relay' : 'direct'),
        url: normalizeConnectUrl(value.url),
        secret: normalizeString(value.secret),
        relayUrl: normalizeRelayUrl(value.relayUrl || value.relay_url),
        clientId: normalizeString(value.clientId || value.client_id),
        encryptionKey: normalizeString(value.encryptionKey || value.encryption_key),
        machineId: normalizeString(value.machineId || value.machine_id),
        machineName: normalizeString(value.machineName || value.machine_name),
        tokenId: normalizeString(value.tokenId || value.token_id),
        addedAt: normalizeString(value.addedAt || value.added_at) || nowIso(),
      };
    } catch (_) {
      // Ignore damaged entries while keeping the rest of the CLI config usable.
    }
  }
  const requestedDefault = normalizeString(config.defaultMachine || config.default_machine);
  return {
    version: 1,
    defaultMachine: machines[requestedDefault] ? requestedDefault : Object.keys(machines)[0] || '',
    machines,
  };
}

function loadCliConfig(filePath = defaultCliConfigPath()) {
  return normalizeCliConfig(readJson(filePath, {}));
}

function saveCliConfig(config, filePath = defaultCliConfigPath()) {
  const normalized = normalizeCliConfig(config);
  writePrivateJson(filePath, normalized);
  return normalized;
}

module.exports = {
  CONNECTION_TOKEN_PREFIX,
  RELAY_CONNECTION_TOKEN_PREFIX,
  DEFAULT_REMOTE_PORT,
  DEFAULT_SCOPES,
  createAccessToken,
  createSecret,
  decodeConnectionToken,
  decryptRelayPayload,
  defaultCliConfigPath,
  defaultGatewayConfigPath,
  encodeConnectionToken,
  encodeRelayConnectionToken,
  encryptRelayPayload,
  findAccessToken,
  findAccessTokenByClientId,
  hashSecret,
  loadCliConfig,
  loadGatewayConfig,
  normalizeCliConfig,
  normalizeConnectUrl,
  normalizeGatewayConfig,
  normalizeRelayUrl,
  saveCliConfig,
  saveGatewayConfig,
  tokenHasScope,
  writePrivateJson,
};
