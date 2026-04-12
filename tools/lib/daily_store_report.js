const fs = require('fs');
const path = require('path');
const {
  asPlainObject,
  compactText,
  ensure,
  normalizeString,
} = require('./studio_runtime_support');

const DEFAULT_TIMEZONE = 'Asia/Shanghai';
const DEFAULT_SCHEDULE = '08:00';
const DEFAULT_STATE_DIR = 'daily_report_state';
const MAX_PAGINATION_PAGES = 200;
const PAGE_SIZE = 100;
const RETRY_DELAY_MS = 15 * 60 * 1000;

const TOPIC_RULES = [
  {
    label: '商品咨询',
    keywords: ['商品', '链接', '下单', '价格', '多少钱', '有货', '库存', '版本', '区别', '型号', '颜色', '土豆子', '焕新'],
  },
  {
    label: '维修售后',
    keywords: ['维修', '售后', '返修', '寄修', '进度', '退款', '退货', '换货', '保修', '检测', '耳机'],
  },
  {
    label: '发货订单',
    keywords: ['发货', '物流', '快递', '单号', '订单', '签收', '收货', '催', '什么时候发', '多久发'],
  },
  {
    label: '服务续费',
    keywords: ['续费', '4g', '流量', '云端', 'ai', '激活', '服务'],
  },
];

function asBool(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function asInt(value, fallback = 0, min = 0, max = 59) {
  const num = Number.parseInt(String(value || '').trim(), 10);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(min, Math.min(max, num));
}

function formatMoney(value) {
  const num = Number(value || 0);
  if (!Number.isFinite(num)) return '0';
  return String(Number(num.toFixed(2)));
}

function presentProductName(name) {
  const raw = normalizeString(name);
  if (!raw) return '未知商品';
  return raw
    .replace(/^第三方\s+/, '')
    .replace(/｜.*$/, '')
    .trim();
}

function presentSkuName(name) {
  const raw = normalizeString(name);
  if (!raw) return '默认SKU';
  return raw.trim();
}

function buildSalesDetailLine(detail = {}) {
  return `- 产品：${detail.productName || '未知商品'}；SKU：${detail.skuName || '默认SKU'}；销量：${Number(detail.quantity || 0)} 个；销售额：${formatMoney(detail.amount)} 元。`;
}

function escapeMarkdownCell(value) {
  return String(value || '')
    .replace(/\|/g, '\\|')
    .replace(/\r?\n/g, ' ')
    .trim();
}

function sortSalesDetails(details = []) {
  return details.slice().sort((a, b) => {
    if (Number(b.quantity || 0) !== Number(a.quantity || 0)) return Number(b.quantity || 0) - Number(a.quantity || 0);
    if (Number(b.amount || 0) !== Number(a.amount || 0)) return Number(b.amount || 0) - Number(a.amount || 0);
    const productCompare = String(a.productName || '').localeCompare(String(b.productName || ''), 'zh-CN');
    if (productCompare !== 0) return productCompare;
    return String(a.skuName || '').localeCompare(String(b.skuName || ''), 'zh-CN');
  });
}

function buildYmd(date, timeZone = DEFAULT_TIMEZONE) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const parts = fmt.formatToParts(date);
  const map = {};
  for (const part of parts) {
    if (part.type !== 'literal') map[part.type] = part.value;
  }
  return `${map.year}-${map.month}-${map.day}`;
}

function buildHm(date, timeZone = DEFAULT_TIMEZONE) {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const parts = fmt.formatToParts(date);
  const map = {};
  for (const part of parts) {
    if (part.type !== 'literal') map[part.type] = part.value;
  }
  return {
    hour: Number.parseInt(map.hour || '0', 10),
    minute: Number.parseInt(map.minute || '0', 10),
  };
}

function addDaysYmd(ymd, delta) {
  const base = new Date(`${ymd}T00:00:00Z`);
  base.setUTCDate(base.getUTCDate() + delta);
  return base.toISOString().slice(0, 10);
}

function resolveSchedule(rawValue) {
  const text = normalizeString(rawValue || DEFAULT_SCHEDULE);
  const match = text.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) {
    return { hour: 8, minute: 0, label: DEFAULT_SCHEDULE };
  }
  const hour = asInt(match[1], 8, 0, 23);
  const minute = asInt(match[2], 0, 0, 59);
  return {
    hour,
    minute,
    label: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`,
  };
}

function resolveDailyStoreReportConfig(config = {}, accountName = '') {
  const raw = asPlainObject(config.daily_report);
  const store = asPlainObject(raw.store);
  const schedule = resolveSchedule(raw.schedule);
  const timeZone = normalizeString(raw.timezone || DEFAULT_TIMEZONE) || DEFAULT_TIMEZONE;
  return {
    accountName,
    enabled: asBool(raw.enabled, false),
    chatId: normalizeString(raw.chat_id || raw.chatId),
    timeZone,
    schedule,
    store: {
      baseUrl: normalizeString(store.base_url || store.baseUrl),
      loginPath: normalizeString(store.login_path || store.loginPath || '/api/login') || '/api/login',
      email: normalizeString(store.email),
      password: String(store.password || '').trim(),
    },
  };
}

function buildDateRange(reportDate, timeZone = DEFAULT_TIMEZONE) {
  if (timeZone !== DEFAULT_TIMEZONE) {
    throw new Error(`unsupported daily_report timezone: ${timeZone}`);
  }
  const start = new Date(`${reportDate}T00:00:00+08:00`);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return {
    start,
    end,
    startTs: Math.floor(start.getTime() / 1000),
    endTs: Math.floor(end.getTime() / 1000),
  };
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
    const text = await response.text();
    let data = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch (err) {
      throw new Error(`invalid json from ${url}: ${compactText(text, 240)}`);
    }
    if (!response.ok) {
      const message = normalizeString(data?.message || data?.msg || text || response.statusText);
      throw new Error(`${response.status} ${message}`.trim());
    }
    return data;
  } finally {
    clearTimeout(timeout);
  }
}

async function loginStoreAdmin(storeConfig) {
  ensure(storeConfig.baseUrl, 'daily_report.store.base_url is required');
  ensure(storeConfig.email, 'daily_report.store.email is required');
  ensure(storeConfig.password, 'daily_report.store.password is required');

  const baseUrl = storeConfig.baseUrl.replace(/\/+$/, '');
  const data = await requestJson(`${baseUrl}${storeConfig.loginPath}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      email: storeConfig.email,
      password: storeConfig.password,
    }),
  });
  const token = normalizeString(data.token);
  ensure(token, 'store admin login returned empty token');
  return {
    baseUrl,
    token,
  };
}

async function fetchPaginatedList(session, routePath, params = {}) {
  const baseUrl = session.baseUrl.replace(/\/+$/, '');
  const out = [];
  for (let page = 1; page <= MAX_PAGINATION_PAGES; page += 1) {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(params || {})) {
      if (value === undefined || value === null || value === '') continue;
      search.set(key, String(value));
    }
    search.set('page', String(page));
    search.set('page_size', String(PAGE_SIZE));
    const url = `${baseUrl}${routePath}?${search.toString()}`;
    const payload = await requestJson(url, {
      headers: {
        Token: session.token,
      },
    });
    const items = Array.isArray(payload.data) ? payload.data : [];
    out.push(...items);

    const lastPage = Number.parseInt(String(payload?.pagination?.last_page || ''), 10);
    if (!items.length) break;
    if (Number.isFinite(lastPage) && lastPage > 0 && page >= lastPage) break;
    if (!Number.isFinite(lastPage) && items.length < PAGE_SIZE) break;
  }
  return out;
}

async function fetchRecentOrdersForRange(session, range) {
  const baseUrl = session.baseUrl.replace(/\/+$/, '');
  const out = [];
  for (let page = 1; page <= MAX_PAGINATION_PAGES; page += 1) {
    const url = `${baseUrl}/api/admin/orders?page=${page}&page_size=${PAGE_SIZE}`;
    const payload = await requestJson(url, {
      headers: {
        Token: session.token,
      },
    });
    const items = Array.isArray(payload.data) ? payload.data : [];
    out.push(...items);

    const lastPage = Number.parseInt(String(payload?.pagination?.last_page || ''), 10);
    if (!items.length) break;

    const hasRelevant = items.some((item) => {
      const paidAt = Number(item?.paid_at || 0);
      return Number.isFinite(paidAt) && paidAt >= range.startTs && paidAt < range.endTs;
    });
    const newestCreatedAt = Number(items[0]?.created_at || 0);
    const allPaidBeforeRange = items.every((item) => {
      const paidAt = Number(item?.paid_at || 0);
      return !Number.isFinite(paidAt) || paidAt < range.startTs;
    });

    if (!hasRelevant && allPaidBeforeRange && Number.isFinite(newestCreatedAt) && newestCreatedAt > 0 && newestCreatedAt < range.startTs) {
      break;
    }

    if (Number.isFinite(lastPage) && lastPage > 0 && page >= lastPage) break;
    if (!Number.isFinite(lastPage) && items.length < PAGE_SIZE) break;
  }
  return out;
}

function computeSnapshotAmount(snapshot) {
  const qty = Number(snapshot?.quantity || 0);
  if (!Number.isFinite(qty) || qty <= 0) return 0;
  const skuPrice = Number(snapshot?.sku_price || 0);
  const adjustment = Number(snapshot?.adjustment || 0);
  const discountAmount = Number(snapshot?.discount_amount || 0);
  const perDiscount = qty > 0 ? discountAmount / qty : 0;
  const unitAmount = skuPrice - perDiscount + adjustment;
  return Number((unitAmount * qty).toFixed(2));
}

async function buildDailySalesSummaryFromOrders(session, range) {
  const orders = await fetchRecentOrdersForRange(session, range);
  const scopedOrders = [];
  for (const item of orders) {
    const paidAt = Number(item?.paid_at || 0);
    const orderStatus = Number(item?.order_status || 0);
    if (!Number.isFinite(paidAt) || paidAt < range.startTs || paidAt >= range.endTs) continue;
    if (orderStatus === 7000) continue;
    scopedOrders.push(item);
  }

  let revenue = 0;
  let totalQuantity = 0;
  const productStats = new Map();
  const detailStats = new Map();
  let potatoQuantity = 0;
  let potatoAmount = 0;

  for (const order of scopedOrders) {
    revenue += Number(order?.payment_amount || 0);
    for (const snapshot of order?.product_snapshots || []) {
      const rawName = normalizeString(snapshot?.product_name);
      if (!rawName) continue;
      const name = presentProductName(rawName);
      const skuName = presentSkuName(snapshot?.product_sku_name || snapshot?.sku_name);
      const quantity = Number(snapshot?.quantity || 0);
      if (!Number.isFinite(quantity) || quantity <= 0) continue;
      const amount = computeSnapshotAmount(snapshot);
      totalQuantity += quantity;

      const current = productStats.get(name) || { name, quantity: 0, amount: 0 };
      current.quantity += quantity;
      current.amount = Number((current.amount + amount).toFixed(2));
      productStats.set(name, current);

      const detailKey = `${name}\u0000${skuName}`;
      const detail = detailStats.get(detailKey) || {
        productName: name,
        skuName,
        quantity: 0,
        amount: 0,
      };
      detail.quantity += quantity;
      detail.amount = Number((detail.amount + amount).toFixed(2));
      detailStats.set(detailKey, detail);

      if (rawName.includes('土豆子')) {
        potatoQuantity += quantity;
        potatoAmount = Number((potatoAmount + amount).toFixed(2));
      }
    }
  }

  const rankedProducts = Array.from(productStats.values());
  rankedProducts.sort((a, b) => {
    if (b.quantity !== a.quantity) return b.quantity - a.quantity;
    if (b.amount !== a.amount) return b.amount - a.amount;
    return a.name.localeCompare(b.name, 'zh-CN');
  });
  const topByQuantity = rankedProducts[0] || { name: '无', quantity: 0, amount: 0 };

  const topByAmount = Array.from(productStats.values()).sort((a, b) => {
    if (b.amount !== a.amount) return b.amount - a.amount;
    if (b.quantity !== a.quantity) return b.quantity - a.quantity;
    return a.name.localeCompare(b.name, 'zh-CN');
  })[0] || { name: '无', quantity: 0, amount: 0 };

  return {
    scopedOrders,
    revenue: Number(revenue.toFixed(2)),
    totalQuantity,
    topByQuantity,
    topByAmount,
    details: sortSalesDetails(Array.from(detailStats.values())),
    potato: {
      name: '土豆子',
      quantity: potatoQuantity,
      amount: Number(potatoAmount.toFixed(2)),
    },
  };
}

function classifyTopic(text) {
  const content = normalizeString(text).toLowerCase();
  if (!content) return '其他问题';

  let bestLabel = '其他问题';
  let bestScore = 0;
  for (const rule of TOPIC_RULES) {
    let score = 0;
    for (const keyword of rule.keywords) {
      if (!keyword) continue;
      if (content.includes(String(keyword).toLowerCase())) score += 1;
    }
    if (score > bestScore) {
      bestScore = score;
      bestLabel = rule.label;
    }
  }
  return bestLabel;
}

async function buildDailyStoreReportFallback(config, reportDate) {
  const ymd = normalizeString(reportDate);
  ensure(/^\d{4}-\d{2}-\d{2}$/.test(ymd), 'report date must be YYYY-MM-DD');

  const range = buildDateRange(ymd, config.timeZone);
  const session = await loginStoreAdmin(config.store);
  const salesSummary = await buildDailySalesSummaryFromOrders(session, range);
  const scopedOrders = salesSummary.scopedOrders;

  const afterSalesList = await fetchPaginatedList(session, '/api/admin/after_sales', {
    'created_at[start]': range.startTs,
    'created_at[end]': range.endTs - 1,
  });
  const afterSalesStats = await requestJson(`${session.baseUrl}/api/admin/after_sales/statistics`, {
    headers: { Token: session.token },
  });

  const messageUsers = [];
  let lastCreatedAt = '';
  let lastId = '';
  for (let i = 0; i < MAX_PAGINATION_PAGES; i += 1) {
    const search = new URLSearchParams();
    search.set('limit', String(PAGE_SIZE));
    if (lastCreatedAt) {
      search.set('last_created_at', lastCreatedAt);
      search.set('last_id', lastId);
    }
    const payload = await requestJson(`${session.baseUrl}/api/admin/messages/users?${search.toString()}`, {
      headers: { Token: session.token },
    });
    const data = Array.isArray(payload.data) ? payload.data : [];
    if (!data.length) break;
    messageUsers.push(...data);
    const last = data[data.length - 1] || {};
    lastCreatedAt = String(last.created_at || '');
    lastId = String(last.id || '');
    if (data.length < PAGE_SIZE) break;
  }

  const activeConversations = messageUsers.filter((item) => {
    const createdAt = Number(item?.created_at || 0);
    return Number.isFinite(createdAt) && createdAt >= range.startTs && createdAt < range.endTs;
  });

  const topicCounter = new Map();
  for (const item of activeConversations) {
    const topic = classifyTopic(item?.preview_content || item?.content || '');
    topicCounter.set(topic, (topicCounter.get(topic) || 0) + 1);
  }
  const topicSummary = Array.from(topicCounter.entries())
    .sort((a, b) => {
      if (b[1] !== a[1]) return b[1] - a[1];
      return a[0].localeCompare(b[0], 'zh-CN');
    })
    .slice(0, 3)
    .map(([label]) => label);

  const pendingReply = await requestJson(`${session.baseUrl}/api/admin/messages/pending_count`, {
    headers: { Token: session.token },
  });

  return {
    date: ymd,
    scope: {
      startTs: range.startTs,
      endTs: range.endTs,
    },
    sales: {
      revenue: salesSummary.revenue,
      orderCount: scopedOrders.length,
      totalQuantity: salesSummary.totalQuantity,
      topByQuantity: salesSummary.topByQuantity,
      topByAmount: salesSummary.topByAmount,
      potato: salesSummary.potato,
      details: salesSummary.details,
    },
    afterSales: {
      newCount: afterSalesList.length,
      activeCount: Number(afterSalesStats.in_dispute || 0),
      pendingReturn: Number(afterSalesStats.pending_return || 0),
      pendingExchange: Number(afterSalesStats.pending_exchange || 0),
    },
    customerService: {
      activeConversations: activeConversations.length,
      topics: topicSummary,
      pendingReplyCount: Number(pendingReply.count || 0),
    },
  };
}

async function buildDailyStoreReport(config, reportDate) {
  const ymd = normalizeString(reportDate);
  ensure(/^\d{4}-\d{2}-\d{2}$/.test(ymd), 'report date must be YYYY-MM-DD');

  const session = await loginStoreAdmin(config.store);
  try {
    const search = new URLSearchParams();
    search.set('date', ymd);
    const payload = await requestJson(`${session.baseUrl}/api/admin/reports/daily_store?${search.toString()}`, {
      headers: { Token: session.token },
    });
    if (payload && typeof payload === 'object' && payload.sales && payload.after_sales && payload.customer_service) {
      const sales = asPlainObject(payload.sales);
      const afterSales = asPlainObject(payload.after_sales);
      const customerService = asPlainObject(payload.customer_service);
      let details = Array.isArray(sales.details)
        ? sales.details.map((item) => ({
            productName: normalizeString(item?.productName || item?.product_name) || '未知商品',
            skuName: presentSkuName(item?.skuName || item?.sku_name),
            quantity: Number(item?.quantity || 0),
            amount: Number(item?.amount || 0),
          }))
        : [];
      let totalQuantity = Number(sales.totalQuantity || sales.total_quantity || 0);
      if (!details.length || !Number.isFinite(totalQuantity) || totalQuantity <= 0) {
        const range = buildDateRange(ymd, config.timeZone);
        const salesSummary = await buildDailySalesSummaryFromOrders(session, range);
        if (!details.length) details = salesSummary.details;
        if (!Number.isFinite(totalQuantity) || totalQuantity <= 0) totalQuantity = salesSummary.totalQuantity;
      }
      details = sortSalesDetails(details);
      return {
        date: payload.date || ymd,
        sales: {
          revenue: Number(sales.revenue || 0),
          orderCount: Number(sales.orderCount || sales.order_count || 0),
          totalQuantity,
          topByQuantity: asPlainObject(sales.topByQuantity || sales.top_by_quantity),
          topByAmount: asPlainObject(sales.topByAmount || sales.top_by_amount),
          potato: asPlainObject(sales.potato),
          details,
        },
        afterSales: {
          newCount: Number(afterSales.newCount || afterSales.new_count || 0),
          activeCount: Number(afterSales.activeCount || afterSales.active_count || 0),
          pendingReturn: Number(afterSales.pendingReturn || afterSales.pending_return || 0),
          pendingExchange: Number(afterSales.pendingExchange || afterSales.pending_exchange || 0),
        },
        customerService: {
          activeConversations: Number(customerService.activeConversations || customerService.active_conversations || 0),
          pendingReplyCount: Number(customerService.pendingReplyCount || customerService.pending_reply_count || 0),
          topics: Array.isArray(customerService.topics) ? customerService.topics : [],
        },
        text: payload.text || '',
      };
    }
  } catch (_) {
    // fall back to the older client-side aggregation path until the new API is deployed everywhere.
  }

  return buildDailyStoreReportFallback(config, ymd);
}

function renderDailyStoreReportText(report) {
  const hasStructuredReport = report && report.sales && report.afterSales && report.customerService;
  if (normalizeString(report?.text) && !hasStructuredReport) {
    return normalizeString(report.text).replace(/\r/g, '');
  }
  const topByQuantity = report?.sales?.topByQuantity || {};
  const topByAmount = report?.sales?.topByAmount || {};
  const potato = report?.sales?.potato || {};
  const salesDetails = Array.isArray(report?.sales?.details) ? sortSalesDetails(report.sales.details) : [];
  const afterSales = report?.afterSales || {};
  const customerService = report?.customerService || {};

  let satisfaction = '目前系统暂无独立的客户满意度评分字段；';
  if (Number(customerService.pendingReplyCount || 0) > 0) {
    satisfaction += ` 当前还有 ${customerService.pendingReplyCount} 个待回复会话，今天要优先跟进。`;
  } else {
    satisfaction += ' 当前没有待回复积压，整体客服反馈稳定。';
  }

  let topicsLine = '主要问题暂未识别出集中类型。';
  if (Array.isArray(customerService.topics) && customerService.topics.length > 0) {
    topicsLine = `咨询内容主要集中在${customerService.topics.join('、')}。`;
  }

  const sameTopProduct = normalizeString(topByQuantity.name) && normalizeString(topByQuantity.name) === normalizeString(topByAmount.name);
  const salesSummaryLines = sameTopProduct
    ? [
        `2. 昨日按销量和销售额统计，最高的商品都是「${topByQuantity.name || '无'}」，共售出 ${Number(topByQuantity.quantity || 0)} 个，销售额 ${formatMoney(topByQuantity.amount)} 元。`,
        `其中，土豆子昨日共售出 ${Number(potato.quantity || 0)} 个，销售额 ${formatMoney(potato.amount)} 元。`,
      ]
    : [
        `2. 按销量统计，昨日销量最高的商品为「${topByQuantity.name || '无'}」，共售出 ${Number(topByQuantity.quantity || 0)} 个，销售额 ${formatMoney(topByQuantity.amount)} 元。`,
        `按销售额统计，昨日销售额最高的商品为「${topByAmount.name || '无'}」，共售出 ${Number(topByAmount.quantity || 0)} 个，销售额 ${formatMoney(topByAmount.amount)} 元。`,
        `其中，土豆子昨日共售出 ${Number(potato.quantity || 0)} 个，销售额 ${formatMoney(potato.amount)} 元。`,
      ];
  const salesDetailLines = salesDetails.length > 0
    ? [
        '3. 昨日销售量明细：',
        ...salesDetails.map((detail) => buildSalesDetailLine(detail)),
        `总计：昨日共售出 ${Number(report?.sales?.totalQuantity || 0)} 个，销售额 ${formatMoney(report?.sales?.revenue)} 元。`,
      ]
    : [
        '3. 昨日销售量明细：暂无销售。',
        `总计：昨日共售出 ${Number(report?.sales?.totalQuantity || 0)} 个，销售额 ${formatMoney(report?.sales?.revenue)} 元。`,
      ];

  return [
    `【${report.date} 店铺正式日报】`,
    `1. 昨日店铺销售额为 ${formatMoney(report?.sales?.revenue)} 元。`,
    '',
    ...salesSummaryLines,
    '',
    ...salesDetailLines,
    '',
    `4. 昨日新增售后 ${Number(afterSales.newCount || 0)} 个。`,
    `截至目前，仍在处理中的售后共 ${Number(afterSales.activeCount || 0)} 个，其中退货中 ${Number(afterSales.pendingReturn || 0)} 个，换货中 ${Number(afterSales.pendingExchange || 0)} 个。`,
    '',
    `5. 昨日客服共有 ${Number(customerService.activeConversations || 0)} 个活跃会话。`,
    topicsLine,
    satisfaction,
  ].join('\n');
}

function renderDailyStoreReportMarkdown(report, { channelType = 'feishu' } = {}) {
  const normalizedChannel = normalizeString(channelType).toLowerCase() || 'feishu';
  const topByQuantity = report?.sales?.topByQuantity || {};
  const topByAmount = report?.sales?.topByAmount || {};
  const potato = report?.sales?.potato || {};
  const salesDetails = Array.isArray(report?.sales?.details) ? sortSalesDetails(report.sales.details) : [];
  const afterSales = report?.afterSales || {};
  const customerService = report?.customerService || {};
  const reportDate = report?.date || '';
  const totalQuantity = Number(report?.sales?.totalQuantity || 0);
  const totalRevenue = formatMoney(report?.sales?.revenue);
  const topics = Array.isArray(customerService.topics) && customerService.topics.length > 0
    ? customerService.topics.join('、')
    : '暂无集中问题';
  const pendingReplyCount = Number(customerService.pendingReplyCount || 0);
  const sameTopProduct = normalizeString(topByQuantity.name) && normalizeString(topByQuantity.name) === normalizeString(topByAmount.name);

  const lines = [
    `# 📊 ${reportDate} 店铺正式日报`,
    '',
    '## 💰 销售总览',
    `- **昨日销售额**：\`${totalRevenue} 元\``,
    `- **昨日总销量**：\`${totalQuantity} 个\``,
  ];

  if (sameTopProduct) {
    lines.push(`- **销量 / 销售额冠军**：**${topByQuantity.name || '无'}** · \`${Number(topByQuantity.quantity || 0)} 个\` · \`${formatMoney(topByQuantity.amount)} 元\``);
  } else {
    lines.push(`- **销量冠军**：**${topByQuantity.name || '无'}** · \`${Number(topByQuantity.quantity || 0)} 个\` · \`${formatMoney(topByQuantity.amount)} 元\``);
    lines.push(`- **销售额冠军**：**${topByAmount.name || '无'}** · \`${Number(topByAmount.quantity || 0)} 个\` · \`${formatMoney(topByAmount.amount)} 元\``);
  }
  lines.push(`- **土豆子合计**：\`${Number(potato.quantity || 0)} 个\` · \`${formatMoney(potato.amount)} 元\``);
  lines.push('');
  lines.push('## 📦 销售明细');
  if (salesDetails.length > 0) {
    if (normalizedChannel === 'feishu') {
      lines.push('| 产品 | SKU | 销量 | 销售额 |');
      lines.push('| --- | --- | ---: | ---: |');
      for (const detail of salesDetails) {
        lines.push(`| ${escapeMarkdownCell(detail.productName || '未知商品')} | ${escapeMarkdownCell(detail.skuName || '默认SKU')} | ${Number(detail.quantity || 0)} | ${formatMoney(detail.amount)} 元 |`);
      }
      lines.push(`| **总计** |  | **${totalQuantity}** | **${totalRevenue} 元** |`);
    } else {
      for (const detail of salesDetails) {
        lines.push(`- **${detail.productName || '未知商品'}** · \`${detail.skuName || '默认SKU'}\` · 销量 \`${Number(detail.quantity || 0)} 个\` · 销售额 \`${formatMoney(detail.amount)} 元\``);
      }
      lines.push(`- **总计**：\`${totalQuantity} 个\` · \`${totalRevenue} 元\``);
    }
  } else {
    lines.push('- 暂无销售明细');
    lines.push(`- **总计**：\`${totalQuantity} 个\` · \`${totalRevenue} 元\``);
  }
  lines.push('');
  lines.push('## 🛠️ 售后');
  lines.push(`- **昨日新增售后**：\`${Number(afterSales.newCount || 0)} 个\``);
  lines.push(`- **处理中售后**：\`${Number(afterSales.activeCount || 0)} 个\``);
  lines.push(`- **退货中**：\`${Number(afterSales.pendingReturn || 0)} 个\``);
  lines.push(`- **换货中**：\`${Number(afterSales.pendingExchange || 0)} 个\``);
  lines.push('');
  lines.push('## 💬 客服');
  lines.push(`- **活跃会话**：\`${Number(customerService.activeConversations || 0)} 个\``);
  lines.push(`- **主要咨询**：${topics}`);
  if (pendingReplyCount > 0) {
    lines.push(`- **待回复**：\`${pendingReplyCount} 个\`，今天要优先跟进`);
  } else {
    lines.push('- **待回复**：`0 个`，当前没有积压');
  }
  lines.push('- **满意度说明**：目前系统暂无独立的客户满意度评分字段');
  return lines.join('\n');
}

function buildFeishuCardField(label, value, { short = true } = {}) {
  return {
    is_short: short,
    text: {
      tag: 'lark_md',
      content: `**${label}**\n${String(value || '').trim() || '-'}`,
    },
  };
}

function buildFeishuCardTile(title, lines = [], { short = true, emoji = '' } = {}) {
  const safeTitle = String(title || '').trim() || '-';
  const body = Array.isArray(lines) ? lines.filter(Boolean).join('\n') : String(lines || '').trim();
  return {
    is_short: short,
    text: {
      tag: 'lark_md',
      content: `${emoji ? `${emoji} ` : ''}**${safeTitle}**\n${body || '-'}`,
    },
  };
}

function chunkList(items = [], size = 4) {
  const chunks = [];
  const limit = Math.max(1, Number(size) || 4);
  for (let i = 0; i < items.length; i += limit) {
    chunks.push(items.slice(i, i + limit));
  }
  return chunks;
}

function renderDailyStoreReportFeishuCard(report) {
  const topByQuantity = report?.sales?.topByQuantity || {};
  const topByAmount = report?.sales?.topByAmount || {};
  const potato = report?.sales?.potato || {};
  const salesDetails = Array.isArray(report?.sales?.details) ? sortSalesDetails(report.sales.details) : [];
  const afterSales = report?.afterSales || {};
  const customerService = report?.customerService || {};
  const reportDate = report?.date || '';
  const totalQuantity = Number(report?.sales?.totalQuantity || 0);
  const totalRevenue = `${formatMoney(report?.sales?.revenue)} 元`;
  const activeConversations = Number(customerService.activeConversations || 0);
  const pendingReplyCount = Number(customerService.pendingReplyCount || 0);
  const topics = Array.isArray(customerService.topics) && customerService.topics.length > 0
    ? customerService.topics.join('、')
    : '暂无集中问题';
  const sameTopProduct = normalizeString(topByQuantity.name) && normalizeString(topByQuantity.name) === normalizeString(topByAmount.name);
  const championValue = sameTopProduct
    ? `**${topByQuantity.name || '无'}**\n${Number(topByQuantity.quantity || 0)} 个 · ${formatMoney(topByQuantity.amount)} 元`
    : `销量冠军：**${topByQuantity.name || '无'}**\n销售额冠军：**${topByAmount.name || '无'}**`;
  const pendingReplyValue = pendingReplyCount > 0
    ? `${pendingReplyCount} 个，今天优先跟进`
    : '0 个，当前没有积压';

  const elements = [
    {
      tag: 'note',
      elements: [
        {
          tag: 'lark_md',
          content: '✨ **核心看板**',
        },
        {
          tag: 'lark_md',
          content: `更新日期：${reportDate}`,
        },
      ],
    },
    {
      tag: 'div',
      fields: [
        buildFeishuCardTile('昨日销售额', [`${totalRevenue}`], { emoji: '💰' }),
        buildFeishuCardTile('昨日总销量', [`${totalQuantity} 个`], { emoji: '📦' }),
        buildFeishuCardTile('活跃会话', [`${activeConversations} 个`], { emoji: '💬' }),
        buildFeishuCardTile('待回复', [pendingReplyValue], { emoji: pendingReplyCount > 0 ? '🚨' : '✅' }),
      ],
    },
    {
      tag: 'div',
      text: {
        tag: 'lark_md',
        content: `🏆 **明星商品**\n${championValue}\n\n🥔 **土豆子合计**：${Number(potato.quantity || 0)} 个 · ${formatMoney(potato.amount)} 元`,
      },
    },
    {
      tag: 'hr',
    },
    {
      tag: 'div',
      text: {
        tag: 'lark_md',
        content: '🧾 **商品销售明细**',
      },
    },
  ];

  if (salesDetails.length > 0) {
    let rank = 1;
    for (const group of chunkList(salesDetails, 2)) {
      elements.push({
        tag: 'div',
        fields: group.map((detail) => {
          const tile = buildFeishuCardTile(
            `${rank}. ${detail.productName || '未知商品'}`,
            [
              `SKU：${detail.skuName || '默认SKU'}`,
              `销量：${Number(detail.quantity || 0)} 个`,
              `销售额：${formatMoney(detail.amount)} 元`,
            ],
            { short: true, emoji: '📦' }
          );
          rank += 1;
          return tile;
        }),
      });
    }
  } else {
    elements.push({
      tag: 'div',
      text: {
        tag: 'lark_md',
        content: '暂无销售明细',
      },
    });
  }

  elements.push(
    {
      tag: 'note',
      elements: [
        {
          tag: 'lark_md',
          content: `📌 **销售总计**：${totalQuantity} 个 ｜ ${totalRevenue}`,
        },
      ],
    },
    {
      tag: 'hr',
    },
    {
      tag: 'div',
      fields: [
        buildFeishuCardTile('昨日新增售后', [`${Number(afterSales.newCount || 0)} 个`], { emoji: '🛠️' }),
        buildFeishuCardTile('处理中售后', [`${Number(afterSales.activeCount || 0)} 个`], { emoji: '📍' }),
        buildFeishuCardTile('退货中', [`${Number(afterSales.pendingReturn || 0)} 个`], { emoji: '↩️' }),
        buildFeishuCardTile('换货中', [`${Number(afterSales.pendingExchange || 0)} 个`], { emoji: '🔁' }),
      ],
    },
    {
      tag: 'hr',
    },
    {
      tag: 'div',
      fields: [
        buildFeishuCardTile('主要咨询', [topics], { short: false, emoji: '💬' }),
        buildFeishuCardTile('满意度说明', ['目前系统暂无独立的客户满意度评分字段'], { short: false, emoji: '📝' }),
      ],
    },
    {
      tag: 'note',
      elements: [
        {
          tag: 'lark_md',
          content: pendingReplyCount > 0
            ? `🚨 **今日重点**：还有 ${pendingReplyCount} 个待回复会话，建议优先跟进。`
            : '✅ **今日重点**：当前没有待回复积压，可按节奏处理新会话。',
        },
      ],
    },
  );

  return {
    config: {
      wide_screen_mode: true,
      enable_forward: true,
    },
    header: {
      template: 'blue',
      title: {
        tag: 'plain_text',
        content: `📊 ${reportDate} 店铺正式日报`,
      },
    },
    elements,
  };
}

function buildStatePath(runtimeDir, accountName) {
  return path.join(runtimeDir, DEFAULT_STATE_DIR, `${accountName}.json`);
}

function readState(statePath) {
  try {
    if (!fs.existsSync(statePath)) return {};
    return JSON.parse(fs.readFileSync(statePath, 'utf8'));
  } catch (_) {
    return {};
  }
}

function writeState(statePath, value) {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function createDailyStoreReportScheduler({
  accountName,
  runtimeDir,
  config,
  sendReport,
  log = () => {},
}) {
  const statePath = buildStatePath(runtimeDir, accountName);
  let timer = null;
  let running = false;
  let retryAfter = 0;

  async function maybeRun() {
    if (!config.enabled) return false;
    if (running) return false;

    const now = new Date();
    const nowYmd = buildYmd(now, config.timeZone);
    const nowHm = buildHm(now, config.timeZone);
    const due = nowHm.hour > config.schedule.hour
      || (nowHm.hour === config.schedule.hour && nowHm.minute >= config.schedule.minute);
    if (!due) return false;

    const state = readState(statePath);
    if (state.last_run_date === nowYmd) return false;
    if (retryAfter > Date.now()) return false;

    running = true;
    try {
      const reportDate = addDaysYmd(nowYmd, -1);
      const report = await buildDailyStoreReport(config, reportDate);
      const text = renderDailyStoreReportText(report);
      await sendReport({
        runDate: nowYmd,
        reportDate,
        report,
        text,
      });
      writeState(statePath, {
        last_run_date: nowYmd,
        last_report_date: reportDate,
        sent_at: new Date().toISOString(),
      });
      retryAfter = 0;
      log(`daily_report=sent account=${accountName} run_date=${nowYmd} report_date=${reportDate}`);
      return true;
    } catch (err) {
      retryAfter = Date.now() + RETRY_DELAY_MS;
      log(`daily_report=error account=${accountName} message=${err.message}`);
      return false;
    } finally {
      running = false;
    }
  }

  function start() {
    if (!config.enabled) return;
    void maybeRun();
    timer = setInterval(() => {
      void maybeRun();
    }, 60 * 1000);
  }

  function stop() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  return {
    start,
    stop,
    buildDailyStoreReport: (reportDate) => buildDailyStoreReport(config, reportDate),
    renderDailyStoreReportText,
  };
}

module.exports = {
  buildDailyStoreReport,
  createDailyStoreReportScheduler,
  renderDailyStoreReportFeishuCard,
  renderDailyStoreReportMarkdown,
  renderDailyStoreReportText,
  resolveDailyStoreReportConfig,
};
