const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  buildChatlogConversationThreads,
  buildChatlogSummary,
  buildMcpSummary,
  parseMcpServersFromToml,
  renderDashboardHtml,
} = require('../tools/agent_gateway_dashboard');

test('dashboard renders a local Agent Gateway page', () => {
  const html = renderDashboardHtml();

  assert.match(html, /SunCodexClaw 控制台/);
  assert.match(html, /Agent Gateway/);
  assert.match(html, /Vue\.createApp/);
  assert.match(html, /\/api\/summary/);
  assert.match(html, /\/api\/mcp/);
  assert.match(html, /\/api\/threads\//);
  assert.match(html, /sendDashboardMessage/);
  assert.match(html, /messageClass/);
  assert.match(html, /机器人线程/);
  assert.match(html, /chatlogThreads/);
  assert.match(html, /threadMeta/);
  assert.match(html, /飞书历史只读/);
  assert.match(html, /当前机器人/);
  assert.match(html, /全部 MCP 配置/);
});

test('dashboard summarizes Chatlog folders by bot and day', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-dashboard-chatlog-'));
  try {
    const logDir = path.join(tempDir, '测试机器人', '2026-07-02');
    fs.mkdirSync(logDir, { recursive: true });
    fs.writeFileSync(
      path.join(logDir, 'chat.jsonl'),
      [
        JSON.stringify({ direction: 'in', text: '你好' }),
        JSON.stringify({ direction: 'out', text: '在' }),
      ].join('\n') + '\n',
      'utf8'
    );

    const summary = buildChatlogSummary(tempDir);
    assert.equal(summary.botCount, 1);
    assert.equal(summary.bots[0].botName, '测试机器人');
    assert.equal(summary.bots[0].totalMessages, 2);
    assert.equal(summary.bots[0].days[0].date, '2026-07-02');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('dashboard rebuilds Feishu Chatlog conversations as per-bot threads', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-dashboard-chatlog-threads-'));
  try {
    const logDir = path.join(tempDir, '测试机器人', '2026-07-02');
    fs.mkdirSync(logDir, { recursive: true });
    fs.writeFileSync(
      path.join(logDir, 'chat.jsonl'),
      [
        JSON.stringify({
          ts: '2026-07-02T01:00:00.000Z',
          account: 'bot-demo',
          bot_name: '测试机器人',
          chat_id: 'oc_demo',
          chat_type: 'p2p',
          chat_scope: 'oc_demo',
          direction: 'in',
          event: 'message_received',
          message_type: 'text',
          sender: { displayName: '测试用户', openId: 'ou_demo', senderType: 'user' },
          text: '帮我看看今天的订单',
        }),
        JSON.stringify({
          ts: '2026-07-02T01:00:04.000Z',
          account: 'bot-demo',
          bot_name: '测试机器人',
          chat_id: 'oc_demo',
          chat_type: 'p2p',
          chat_scope: 'oc_demo',
          direction: 'out',
          event: 'reply',
          message_type: 'text',
          thread_id: 't1',
          text: '我来查。',
        }),
      ].join('\n') + '\n',
      'utf8'
    );

    const summary = buildChatlogConversationThreads(tempDir, {
      bridgeAccounts: [{ account: 'bot-demo', displayName: '测试机器人' }],
    });
    assert.equal(summary.totalThreads, 1);
    assert.equal(summary.accounts['bot-demo'].length, 1);
    const thread = summary.accounts['bot-demo'][0];
    assert.equal(thread.source, 'feishu_chatlog');
    assert.equal(thread.platformLabel, '飞书私聊');
    assert.equal(thread.initiator, '测试用户');
    assert.equal(thread.startedAt, '2026-07-02T01:00:00.000Z');
    assert.equal(thread.messageCount, 2);
    assert.deepEqual(thread.history.map((item) => item.role), ['user', 'assistant']);
    assert.match(thread.preview, /我来查/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('dashboard parses MCP servers from Codex TOML without exposing env values', () => {
  const servers = parseMcpServersFromToml(`
[mcp_servers.store-admin]
command = "node"
args = ["/tmp/store-admin-mcp/server.mjs"]

[mcp_servers.store-admin.env]
STORE_TOKEN = "secret-value"

[mcp_servers.node_repl]
command = "/Applications/Codex.app/Contents/Resources/cua_node/bin/node_repl"
args = []
`, '/tmp/config.toml');

  assert.equal(servers.length, 2);
  assert.deepEqual(servers.map((server) => server.name), ['node_repl', 'store-admin']);
  assert.equal(servers[1].command, 'node');
  assert.deepEqual(servers[1].args, ['/tmp/store-admin-mcp/server.mjs']);
  assert.deepEqual(servers[1].envKeys, ['STORE_TOKEN']);
  assert.equal(JSON.stringify(servers).includes('secret-value'), false);
});

test('dashboard summarizes MCP configs by Codex home', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-dashboard-mcp-'));
  try {
    const codexHome = path.join(tempDir, '.codex-fei-demo');
    const mcpDir = path.join(tempDir, 'store-admin-mcp');
    fs.mkdirSync(codexHome, { recursive: true });
    fs.mkdirSync(mcpDir, { recursive: true });
    fs.writeFileSync(path.join(mcpDir, 'server.mjs'), 'export {};\n', 'utf8');
    fs.writeFileSync(
      path.join(mcpDir, 'package.json'),
      JSON.stringify({ name: 'store-admin-mcp', version: '1.2.3' }),
      'utf8'
    );
    fs.writeFileSync(
      path.join(codexHome, 'config.toml'),
      [
        '[mcp_servers.store-admin]',
        'command = "node"',
        `args = ["${path.join(mcpDir, 'server.mjs')}"]`,
      ].join('\n'),
      'utf8'
    );

    const summary = buildMcpSummary(tempDir);
    assert.equal(summary.homeCount, 1);
    assert.equal(summary.serverCount, 1);
    assert.equal(summary.uniqueServerCount, 1);
    assert.equal(summary.uniqueServers[0].name, 'store-admin');
    assert.equal(summary.uniqueServers[0].configuredHomeCount, 1);
    assert.equal(summary.homes[0].servers[0].exists, true);
    assert.equal(summary.homes[0].servers[0].packageName, 'store-admin-mcp');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
