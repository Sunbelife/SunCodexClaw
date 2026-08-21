const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildAgentGatewayCodexHint,
  classifyAgentGatewayRequest,
  resolveAgentGatewayConfig,
  summarizeAgentGatewayRoute,
} = require('../tools/lib/agent_gateway');

test('agent gateway routes store operations to MCP first', () => {
  const gateway = resolveAgentGatewayConfig({});
  const route = classifyAgentGatewayRequest('查一下店铺今天订单和客户信息', gateway);

  assert.equal(route.intent, 'store_ops');
  assert.equal(route.route, 'mcp_first');
  assert.equal(route.requiresExecution, true);
  assert.match(route.matchedKeyword, /店铺|订单|客户/);

  const hint = buildAgentGatewayCodexHint(route, gateway);
  assert.match(hint, /店铺工具优先级/);
  assert.match(hint, /MCP/);
  assert.match(hint, /不要编造/);
});

test('agent gateway keeps ordinary chat lightweight', () => {
  const gateway = resolveAgentGatewayConfig({});
  const route = classifyAgentGatewayRequest('今天晚上吃什么比较好', gateway);

  assert.equal(route.intent, 'normal_chat');
  assert.equal(route.route, 'codex_cli');
  assert.equal(route.requiresExecution, false);
  assert.equal(buildAgentGatewayCodexHint(route, gateway), '');
});

test('agent gateway accepts custom store MCP config', () => {
  const gateway = resolveAgentGatewayConfig({
    agent_gateway: {
      store_ops: {
        mcp_name: 'store-admin-mcp',
        context_keywords: ['供货商'],
        action_keywords: ['盘点'],
      },
    },
  });
  const route = classifyAgentGatewayRequest('帮我盘点一下供货商库存', gateway);
  const hint = buildAgentGatewayCodexHint(route, gateway);

  assert.equal(route.intent, 'store_ops');
  assert.match(hint, /store-admin-mcp/);
  assert.match(summarizeAgentGatewayRoute(route), /requires_execution=true/);
});
