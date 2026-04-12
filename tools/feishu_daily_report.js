#!/usr/bin/env node
const {
  readConfigEntry,
} = require('./lib/local_secret_store');
const {
  createFeishuClient,
  ensure,
  resolveCredentials,
  sendCodexReplyPassthrough,
} = require('./lib/studio_runtime_support');
const {
  buildDailyStoreReport,
  renderDailyStoreReportFeishuCard,
  renderDailyStoreReportMarkdown,
  renderDailyStoreReportText,
  resolveDailyStoreReportConfig,
} = require('./lib/daily_store_report');

function getArg(flag, fallback = '') {
  const idx = process.argv.indexOf(flag);
  if (idx >= 0 && idx + 1 < process.argv.length) return process.argv[idx + 1];
  return fallback;
}

function buildDefaultReportDate() {
  const now = new Date();
  const shifted = new Date(now.getTime() + 8 * 60 * 60 * 1000 - 24 * 60 * 60 * 1000);
  return shifted.toISOString().slice(0, 10);
}

function renderReportPayload(report, { channel = 'feishu', format = 'text' } = {}) {
  const normalizedChannel = String(channel || 'feishu').trim().toLowerCase() || 'feishu';
  const normalizedFormat = String(format || 'text').trim().toLowerCase() || 'text';

  if (normalizedFormat === 'card') {
    return {
      messageType: 'card',
      content: renderDailyStoreReportFeishuCard(report),
      fallbackText: renderDailyStoreReportText(report),
    };
  }

  if (normalizedFormat === 'markdown') {
    return {
      messageType: 'markdown',
      content: renderDailyStoreReportMarkdown(report, { channelType: normalizedChannel }),
    };
  }

  return {
    messageType: 'text',
    content: renderDailyStoreReportText(report),
  };
}

async function main() {
  const account = getArg('--account', process.env.FEISHU_ACCOUNT || 'default').trim() || 'default';
  const date = getArg('--date', '').trim();
  const channel = getArg('--channel', 'feishu').trim() || 'feishu';
  const format = getArg('--format', '').trim();
  const emitJson = process.argv.includes('--json');
  const shouldSend = process.argv.includes('--send');

  const config = readConfigEntry('feishu', account, {});
  const dailyReport = resolveDailyStoreReportConfig(config, account);
  ensure(dailyReport.store.baseUrl, `daily_report.store.base_url is required for account "${account}"`);
  ensure(dailyReport.store.email, `daily_report.store.email is required for account "${account}"`);
  ensure(dailyReport.store.password, `daily_report.store.password is required for account "${account}"`);

  const reportDate = date || buildDefaultReportDate();

  const report = await buildDailyStoreReport(dailyReport, reportDate);
  const payload = renderReportPayload(report, {
    channel,
    format: format || (String(channel).trim().toLowerCase() === 'wecom' ? 'markdown' : 'card'),
  });

  if (emitJson) {
    process.stdout.write(`${JSON.stringify({
      message_type: payload.messageType,
      content: payload.content,
      fallback_text: payload.fallbackText || '',
    })}\n`);
    return;
  }

  if (!shouldSend) {
    if (payload.messageType === 'card') {
      process.stdout.write(`${JSON.stringify(payload.content, null, 2)}\n`);
    } else {
      process.stdout.write(`${String(payload.content || '').trim()}\n`);
    }
    return;
  }

  ensure(dailyReport.chatId, `daily_report.chat_id is required for account "${account}"`);
  const creds = resolveCredentials(config);
  const client = createFeishuClient({
    domain: config.domain || 'feishu',
    creds: {
      appId: creds.appId.value,
      appSecret: creds.appSecret.value,
      botOpenId: creds.botOpenId.value,
    },
  });
  const text = payload.messageType === 'text'
    ? payload.content
    : (payload.fallbackText || renderDailyStoreReportText(report));
  await sendCodexReplyPassthrough(client, dailyReport.chatId, text);
  process.stdout.write(`sent daily report to ${dailyReport.chatId} for ${reportDate}\n`);
}

main().catch((err) => {
  process.stderr.write(`${err.message || String(err)}\n`);
  process.exit(1);
});
