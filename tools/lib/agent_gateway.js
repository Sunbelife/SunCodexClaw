const DEFAULT_STORE_CONTEXT_KEYWORDS = [
  '店铺',
  '商店',
  '商城',
  '小店',
  '后台',
  '管理后台',
  '订单',
  '客户',
  '会员',
  '商品',
  '库存',
  '仓库',
  '发货',
  '退款',
  '售后',
  '优惠券',
  '运费',
  '支付',
  '营收',
  '营业额',
  '销售额',
  'store',
  'store-admin',
  'admin',
];

const DEFAULT_STORE_ACTION_KEYWORDS = [
  '查',
  '看',
  '找',
  '统计',
  '导出',
  '下载',
  '发给我',
  '处理',
  '改',
  '修改',
  '更新',
  '上架',
  '下架',
  '补货',
  '发货',
  '退款',
  '取消',
  '创建',
  '同步',
  '刷新',
  '配置',
  '核对',
  '验证',
];

const DEFAULT_CODING_KEYWORDS = [
  '代码',
  '程序',
  '项目',
  '仓库',
  '文件',
  '脚本',
  '接口',
  '编译',
  '构建',
  '打包',
  '部署',
  '发布',
  '测试',
  '修复',
  '排查',
  '重构',
  '实现',
  'bug',
  'fix',
  'debug',
  'implement',
  'refactor',
  'build',
  'deploy',
];

function normalizeString(value) {
  return String(value || '').trim();
}

function asBool(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  const text = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on', 'enabled', 'enable'].includes(text)) return true;
  if (['0', 'false', 'no', 'n', 'off', 'disabled', 'disable'].includes(text)) return false;
  return fallback;
}

function uniqueStrings(items = []) {
  const seen = new Set();
  const result = [];
  for (const item of items || []) {
    const value = normalizeString(item);
    if (!value || seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

function normalizeKeywordList(value) {
  if (Array.isArray(value)) return uniqueStrings(value);
  const text = normalizeString(value);
  if (!text) return [];
  return uniqueStrings(text.split(/[\n,，、|]+/g));
}

function normalizeMatchText(value) {
  return normalizeString(value).toLowerCase().replace(/\s+/g, '');
}

function findMatchedKeyword(text, keywords = []) {
  const normalizedText = normalizeMatchText(text);
  if (!normalizedText) return '';
  for (const keyword of keywords || []) {
    const normalizedKeyword = normalizeMatchText(keyword);
    if (!normalizedKeyword) continue;
    if (normalizedText.includes(normalizedKeyword)) return keyword;
  }
  return '';
}

function resolveAgentGatewayConfig(config = {}) {
  const raw = config.agent_gateway || config.agentGateway || {};
  const storeOpsRaw = raw.store_ops || raw.storeOps || {};
  const codingRaw = raw.coding || {};
  const dashboardRaw = raw.dashboard || {};

  const storeContextKeywords = uniqueStrings([
    ...DEFAULT_STORE_CONTEXT_KEYWORDS,
    ...normalizeKeywordList(storeOpsRaw.context_keywords || storeOpsRaw.contextKeywords || storeOpsRaw.keywords),
  ]);
  const storeActionKeywords = uniqueStrings([
    ...DEFAULT_STORE_ACTION_KEYWORDS,
    ...normalizeKeywordList(storeOpsRaw.action_keywords || storeOpsRaw.actionKeywords || storeOpsRaw.actions),
  ]);
  const codingKeywords = uniqueStrings([
    ...DEFAULT_CODING_KEYWORDS,
    ...normalizeKeywordList(codingRaw.keywords),
  ]);

  return {
    enabled: asBool(raw.enabled, true),
    mode: normalizeString(raw.mode || 'codex_first') || 'codex_first',
    chatlogFirst: asBool(raw.chatlog_first || raw.chatlogFirst, true),
    normalChatExecutor: normalizeString(raw.normal_chat_executor || raw.normalChatExecutor || 'codex_cli') || 'codex_cli',
    codingExecutor: normalizeString(raw.coding_executor || raw.codingExecutor || 'codex') || 'codex',
    storeOps: {
      enabled: asBool(storeOpsRaw.enabled, true),
      preferMcp: asBool(storeOpsRaw.prefer_mcp || storeOpsRaw.preferMcp, true),
      requireMcpFirst: asBool(storeOpsRaw.require_mcp_first || storeOpsRaw.requireMcpFirst, true),
      contextKeywords: storeContextKeywords,
      actionKeywords: storeActionKeywords,
      mcpName: normalizeString(storeOpsRaw.mcp_name || storeOpsRaw.mcpName || '店铺 MCP') || '店铺 MCP',
      fallbackPolicy: normalizeString(storeOpsRaw.fallback_policy || storeOpsRaw.fallbackPolicy || 'explain_unavailable') || 'explain_unavailable',
    },
    coding: {
      enabled: asBool(codingRaw.enabled, true),
      keywords: codingKeywords,
      alwaysCodex: asBool(codingRaw.always_codex || codingRaw.alwaysCodex, true),
    },
    dashboard: {
      enabled: asBool(dashboardRaw.enabled, true),
      host: normalizeString(dashboardRaw.host || '127.0.0.1') || '127.0.0.1',
      port: Number.isFinite(Number(dashboardRaw.port)) ? Number(dashboardRaw.port) : 8731,
    },
  };
}

function classifyAgentGatewayRequest(text = '', gateway = resolveAgentGatewayConfig()) {
  const userText = normalizeString(text);
  if (!gateway?.enabled || !userText) {
    return {
      intent: 'normal_chat',
      route: 'codex_cli',
      matchedKeyword: '',
      requiresExecution: false,
      confidence: 0,
    };
  }

  const storeContextKeyword = gateway.storeOps?.enabled
    ? findMatchedKeyword(userText, gateway.storeOps.contextKeywords)
    : '';
  const storeActionKeyword = storeContextKeyword
    ? findMatchedKeyword(userText, gateway.storeOps.actionKeywords)
    : '';
  if (storeContextKeyword && storeActionKeyword) {
    return {
      intent: 'store_ops',
      route: gateway.storeOps.preferMcp ? 'mcp_first' : 'codex_cli',
      matchedKeyword: storeContextKeyword,
      matchedActionKeyword: storeActionKeyword,
      requiresExecution: true,
      confidence: 0.86,
    };
  }

  const codingKeyword = gateway.coding?.enabled
    ? findMatchedKeyword(userText, gateway.coding.keywords)
    : '';
  if (codingKeyword) {
    return {
      intent: 'coding_task',
      route: gateway.coding.alwaysCodex ? 'codex_long_task' : 'codex_cli',
      matchedKeyword: codingKeyword,
      requiresExecution: true,
      confidence: 0.72,
    };
  }

  return {
    intent: 'normal_chat',
    route: gateway.normalChatExecutor || 'codex_cli',
    matchedKeyword: '',
    requiresExecution: false,
    confidence: 0.4,
  };
}

function buildAgentGatewayCodexHint(route = {}, gateway = resolveAgentGatewayConfig()) {
  if (!gateway?.enabled || !route || route.intent === 'normal_chat') return '';
  const lines = [
    'Agent Gateway 路由提示：',
    `intent=${route.intent}`,
    `route=${route.route}`,
  ];

  if (route.intent === 'store_ops') {
    lines.push(`命中店铺关键词：${route.matchedKeyword || '(unknown)'}`);
    lines.push(`命中操作关键词：${route.matchedActionKeyword || '(unknown)'}`);
    lines.push(`店铺工具优先级：${gateway.storeOps.mcpName} 优先。`);
    if (gateway.storeOps.requireMcpFirst) {
      lines.push('如果任务需要查询、修改或核对店铺真实数据，必须先尝试使用已配置的店铺 MCP/店铺 skill，不要先靠猜测、浏览器绕路或手写接口拼凑。');
    } else if (gateway.storeOps.preferMcp) {
      lines.push('如果任务需要店铺真实数据，优先使用店铺 MCP/店铺 skill。');
    }
    lines.push('MCP 或 skill 不可用时，请明确说明不可用原因和你已尝试的路径，不要编造订单、客户、商品、库存或财务数据。');
    lines.push('拿到工具结果后再回复用户，回复里只保留关键结论和必要明细。');
  } else if (route.intent === 'coding_task') {
    lines.push(`命中工程关键词：${route.matchedKeyword || '(unknown)'}`);
    lines.push('代码/工程任务必须由 Codex 实际执行：先查看文件或运行必要命令，再给结果；不要只口头答应。');
  }

  return lines.join('\n');
}

function summarizeAgentGatewayRoute(route = {}) {
  const intent = normalizeString(route.intent || 'normal_chat');
  const routeName = normalizeString(route.route || 'codex_cli');
  const matched = normalizeString(route.matchedKeyword);
  const action = normalizeString(route.matchedActionKeyword);
  return [
    `intent=${intent}`,
    `route=${routeName}`,
    matched ? `matched=${JSON.stringify(matched)}` : '',
    action ? `action=${JSON.stringify(action)}` : '',
    route.requiresExecution ? 'requires_execution=true' : 'requires_execution=false',
  ].filter(Boolean).join(' ');
}

module.exports = {
  DEFAULT_CODING_KEYWORDS,
  DEFAULT_STORE_ACTION_KEYWORDS,
  DEFAULT_STORE_CONTEXT_KEYWORDS,
  buildAgentGatewayCodexHint,
  classifyAgentGatewayRequest,
  findMatchedKeyword,
  normalizeKeywordList,
  resolveAgentGatewayConfig,
  summarizeAgentGatewayRoute,
};
