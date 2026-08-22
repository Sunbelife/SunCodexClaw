const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createRemoteGatewayServer } = require('../tools/remote_gateway');
const {
  createAccessToken,
  normalizeGatewayConfig,
  saveGatewayConfig,
} = require('../tools/lib/remote_access');
const { isTrustedHttpUrl } = require('../tools/scc_cli');

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address()));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

test('remote gateway authenticates, hides local secrets, and supports CLI conversations', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scc-remote-gateway-'));
  const configPath = path.join(tempDir, 'config.json');
  const auditLog = path.join(tempDir, 'audit.jsonl');
  const bridgeScript = path.join(tempDir, 'fake_bridge.js');
  fs.writeFileSync(bridgeScript, `
const command = process.argv[2] || '';
const account = process.argv[3] || '';
let raw = '';
process.stdin.on('data', (chunk) => { raw += String(chunk); });
process.stdin.on('end', () => {
  const payload = raw.trim() ? JSON.parse(raw) : {};
  if (command === 'summary') {
    process.stdout.write(JSON.stringify({ accounts: [{
      account: 'assistant',
      displayName: '助手机器人',
      status: { state: 'running', pid: 123, logPath: '/secret/log' },
      activity: { state: 'idle', label: '空闲', detail: '等待消息' },
      boot: { codexModel: 'gpt-test', codexCwd: '/secret/workspace' },
      editor: { app_secret: 'never-return-this' }
    }] }));
    return;
  }
  const thread = {
    id: 'studio-demo', name: 'CLI 会话', source: 'remote_cli', status: 'idle',
    history: command === 'thread-send'
      ? [{ role: 'user', text: payload.text }, { role: 'assistant', text: '远程回答' }]
      : []
  };
  const localThread = {
    id: 'studio-local-secret', name: '本机后台会话', source: 'studio', status: 'idle',
    history: [{ role: 'user', text: '不应暴露给远程 CLI' }]
  };
  if (command === 'threads') process.stdout.write(JSON.stringify({ ok: true, account, threads: [thread, localThread] }));
  else if (command === 'thread-create') process.stdout.write(JSON.stringify({ ok: true, account, threads: [thread], thread }));
  else if (command === 'thread-send') process.stdout.write(JSON.stringify({ ok: true, account, threads: [thread], thread, reply: '远程回答' }));
  else process.exitCode = 2;
});
`, 'utf8');

  const issued = createAccessToken(normalizeGatewayConfig({
    machineId: 'machine_test',
    machineName: '测试电脑',
    connectUrl: 'http://127.0.0.1:8732',
  }), { name: 'test client' });
  saveGatewayConfig(issued.config, configPath);
  const server = createRemoteGatewayServer({
    configPath,
    auditLog,
    bridgeScript,
    repoDir: tempDir,
  });

  try {
    const address = await listen(server);
    const base = `http://127.0.0.1:${address.port}`;
    const unauthorized = await fetch(`${base}/v1/bots`);
    assert.equal(unauthorized.status, 401);

    const headers = { authorization: `Bearer ${issued.secret}`, 'content-type': 'application/json' };
    const botsResponse = await fetch(`${base}/v1/bots`, { headers });
    assert.equal(botsResponse.status, 200);
    const bots = await botsResponse.json();
    assert.equal(bots.bots[0].account, 'assistant');
    assert.equal(bots.bots[0].model, 'gpt-test');
    assert.equal(JSON.stringify(bots).includes('never-return-this'), false);
    assert.equal(JSON.stringify(bots).includes('/secret/'), false);

    const createResponse = await fetch(`${base}/v1/bots/assistant/threads`, {
      method: 'POST', headers, body: JSON.stringify({ name: '远程会话' }),
    });
    assert.equal(createResponse.status, 200);
    const created = await createResponse.json();
    assert.equal(created.thread.source, 'remote_cli');

    const threadsResponse = await fetch(`${base}/v1/bots/assistant/threads`, { headers });
    const threads = await threadsResponse.json();
    assert.deepEqual(threads.threads.map((thread) => thread.id), ['studio-demo']);
    assert.equal(JSON.stringify(threads).includes('不应暴露'), false);

    const sendResponse = await fetch(`${base}/v1/bots/assistant/threads/studio-demo/messages`, {
      method: 'POST', headers, body: JSON.stringify({ text: '你好' }),
    });
    assert.equal(sendResponse.status, 200);
    const sent = await sendResponse.json();
    assert.equal(sent.reply, '远程回答');
    assert.equal(sent.thread.history[1].text, '远程回答');

    const forbiddenLocalThread = await fetch(`${base}/v1/bots/assistant/threads/studio-local-secret`, { headers });
    assert.equal(forbiddenLocalThread.status, 404);

    assert.match(fs.readFileSync(auditLog, 'utf8'), /"tokenId"/);
    assert.equal(fs.readFileSync(auditLog, 'utf8').includes('你好'), false);
  } finally {
    await close(server);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('CLI accepts private and Tailscale HTTP endpoints but rejects public plaintext HTTP', () => {
  assert.equal(isTrustedHttpUrl('http://127.0.0.1:8732'), true);
  assert.equal(isTrustedHttpUrl('http://100.100.20.30:8732'), true);
  assert.equal(isTrustedHttpUrl('http://machine.example.ts.net:8732'), true);
  assert.equal(isTrustedHttpUrl('https://gateway.example.com'), true);
  assert.equal(isTrustedHttpUrl('http://203.0.113.7:8732'), false);
});
