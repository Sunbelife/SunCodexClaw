const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  createAccessToken,
  decodeConnectionToken,
  decryptRelayPayload,
  encodeConnectionToken,
  encodeRelayConnectionToken,
  encryptRelayPayload,
  findAccessToken,
  loadCliConfig,
  normalizeGatewayConfig,
  saveCliConfig,
  saveGatewayConfig,
} = require('../tools/lib/remote_access');

test('connection token carries the endpoint and authenticates without exposing a stored secret', () => {
  const initial = normalizeGatewayConfig({
    machineId: 'machine_demo',
    machineName: '演示电脑',
    connectUrl: 'http://100.90.80.70:8732',
  });
  const issued = createAccessToken(initial, { name: '旅行电脑' });
  const bundle = encodeConnectionToken({
    url: issued.config.connectUrl,
    secret: issued.secret,
    machineId: issued.config.machineId,
    machineName: issued.config.machineName,
    tokenId: issued.record.id,
  });
  const decoded = decodeConnectionToken(bundle);

  assert.match(bundle, /^scc1_/);
  assert.equal(decoded.url, 'http://100.90.80.70:8732');
  assert.equal(decoded.machineId, 'machine_demo');
  assert.equal(findAccessToken(issued.config, decoded.secret).id, issued.record.id);
  assert.equal(JSON.stringify(issued.config).includes(decoded.secret), false);
});

test('gateway and CLI configs are saved as private JSON files', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scc-remote-access-'));
  try {
    const gatewayPath = path.join(tempDir, 'gateway', 'config.json');
    const cliPath = path.join(tempDir, 'cli', 'config.json');
    saveGatewayConfig({ machineName: 'host', connectUrl: 'http://127.0.0.1:8732' }, gatewayPath);
    saveCliConfig({
      defaultMachine: 'host',
      machines: {
        host: { url: 'http://127.0.0.1:8732', secret: 'demo-secret' },
      },
    }, cliPath);

    assert.equal(fs.statSync(gatewayPath).mode & 0o777, 0o600);
    assert.equal(fs.statSync(cliPath).mode & 0o777, 0o600);
    assert.equal(loadCliConfig(cliPath).machines.host.secret, 'demo-secret');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('relay token and encrypted envelopes keep RPC content end to end encrypted', () => {
  const issued = createAccessToken(normalizeGatewayConfig({
    machineId: 'machine_relay',
    machineName: '中继电脑',
    relayUrl: 'wss://relay.example.com',
  }), { name: 'remote CLI' });
  const token = encodeRelayConnectionToken({
    relayUrl: issued.config.relayUrl,
    encryptionKey: issued.encryptionKey,
    machineId: issued.config.machineId,
    machineName: issued.config.machineName,
    tokenId: issued.record.id,
    clientId: issued.record.clientId,
  });
  const decoded = decodeConnectionToken(token);
  const context = {
    machineId: decoded.machineId,
    clientId: decoded.clientId,
    requestId: 'req_demo',
    direction: 'request',
  };
  const envelope = encryptRelayPayload(decoded.encryptionKey, {
    method: 'POST', path: '/v1/bots/assistant/messages', body: { text: '私密任务正文' },
  }, context);

  assert.match(token, /^scc2_/);
  assert.equal(decoded.transport, 'relay');
  assert.equal(decoded.relayUrl, 'wss://relay.example.com');
  assert.equal(JSON.stringify(envelope).includes('私密任务正文'), false);
  assert.equal(decryptRelayPayload(decoded.encryptionKey, envelope, context).body.text, '私密任务正文');
  assert.throws(() => decryptRelayPayload(decoded.encryptionKey, envelope, { ...context, requestId: 'req_changed' }));
});
