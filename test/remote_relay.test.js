const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createRelayServer } = require('../tools/remote_relay');
const { createRemoteGatewayServer, startRelayHostLoop } = require('../tools/remote_gateway');
const { apiRequest } = require('../tools/scc_cli');
const {
  createAccessToken,
  loadGatewayConfig,
  normalizeGatewayConfig,
  saveGatewayConfig,
} = require('../tools/lib/remote_access');

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address()));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

function fakeBridgeSource() {
  return `
const command = process.argv[2] || '';
const account = process.argv[3] || '';
let raw = '';
process.stdin.on('data', (chunk) => { raw += String(chunk); });
process.stdin.on('end', () => {
  const payload = raw.trim() ? JSON.parse(raw) : {};
  if (command === 'summary') {
    process.stdout.write(JSON.stringify({ accounts: [{
      account: 'assistant', displayName: '中继机器人', status: { state: 'running' },
      activity: { state: 'idle', label: '空闲' }, boot: { codexModel: 'gpt-relay' },
      editor: { api_key: 'must-never-cross-relay' }
    }] }));
    return;
  }
  const thread = {
    id: 'studio-relay', name: 'Relay 会话', source: 'remote_cli', status: 'idle',
    history: command === 'thread-send'
      ? [{ role: 'user', text: payload.text }, { role: 'assistant', text: '中继回答' }]
      : []
  };
  if (command === 'threads') process.stdout.write(JSON.stringify({ ok: true, account, threads: [thread] }));
  else if (command === 'thread-create') process.stdout.write(JSON.stringify({ ok: true, account, threads: [thread], thread }));
  else if (command === 'thread-send') process.stdout.write(JSON.stringify({ ok: true, account, threads: [thread], thread, reply: '中继回答' }));
  else process.exitCode = 2;
});
`;
}

test('CLI and host exchange encrypted robot messages through an outbound-only relay', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scc-relay-e2e-'));
  const registryPath = path.join(tempDir, 'registry.json');
  const configPath = path.join(tempDir, 'gateway.json');
  const bridgeScript = path.join(tempDir, 'fake_bridge.js');
  fs.writeFileSync(bridgeScript, fakeBridgeSource(), 'utf8');

  const relay = createRelayServer({ registryPath, registrationKey: 'relay-registration-secret' });
  const relayAddress = await listen(relay);
  const relayUrl = `ws://127.0.0.1:${relayAddress.port}`;
  const issued = createAccessToken(normalizeGatewayConfig({
    machineId: 'machine_relay_test',
    machineName: 'Relay 测试电脑',
    machineSecret: 'host-machine-secret',
    registrationKey: 'relay-registration-secret',
    relayUrl,
    connectUrl: 'http://127.0.0.1:8732',
  }), { name: 'relay test CLI' });
  saveGatewayConfig(issued.config, configPath);

  const gateway = createRemoteGatewayServer({
    configPath,
    auditLog: path.join(tempDir, 'audit.jsonl'),
    bridgeScript,
    repoDir: tempDir,
  });
  const gatewayAddress = await listen(gateway);
  const hostLoop = startRelayHostLoop({
    configPath,
    localBaseUrl: `http://127.0.0.1:${gatewayAddress.port}`,
    log: () => {},
  });
  const machine = {
    alias: 'relay-test',
    transport: 'relay',
    relayUrl,
    machineId: issued.config.machineId,
    machineName: issued.config.machineName,
    clientId: issued.record.clientId,
    encryptionKey: issued.encryptionKey,
  };

  try {
    let bots;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        bots = await apiRequest(machine, '/v1/bots');
        break;
      } catch (error) {
        if (!/离线|offline/i.test(error.message) || attempt === 19) throw error;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    assert.equal(bots.bots[0].account, 'assistant');
    assert.equal(bots.bots[0].model, 'gpt-relay');
    assert.equal(JSON.stringify(bots).includes('must-never-cross-relay'), false);

    const created = await apiRequest(machine, '/v1/bots/assistant/threads', {
      method: 'POST', body: { name: 'Relay 会话' },
    });
    assert.equal(created.thread.id, 'studio-relay');
    const sent = await apiRequest(machine, '/v1/bots/assistant/threads/studio-relay/messages', {
      method: 'POST', body: { text: '只在两端出现的消息' },
    });
    assert.equal(sent.reply, '中继回答');

    const revokedConfig = loadGatewayConfig(configPath);
    revokedConfig.tokens[0].revokedAt = new Date().toISOString();
    saveGatewayConfig(revokedConfig, configPath);
    await assert.rejects(
      apiRequest(machine, '/v1/bots'),
      /unauthorized/i,
    );

    const registryRaw = fs.readFileSync(registryPath, 'utf8');
    assert.equal(registryRaw.includes('host-machine-secret'), false);
    assert.equal(registryRaw.includes('只在两端出现的消息'), false);
    assert.equal(registryRaw.includes(issued.encryptionKey), false);
  } finally {
    hostLoop.stop();
    for (const ws of relay.sccState.clientSockets.values()) ws.close();
    for (const ws of relay.sccState.hostSockets.values()) ws.close();
    await close(gateway);
    await close(relay);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
