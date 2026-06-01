#!/usr/bin/env node
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const { readConfigEntry } = require('./lib/local_secret_store');
const {
  createMessageChannelRuntime,
  sendUnifiedMessage,
} = require('./lib/message_channel_delivery');
const {
  asPlainObject,
  compactText,
  ensure,
  normalizeString,
  resolveCredentials,
} = require('./lib/studio_runtime_support');

const DEFAULT_ACCOUNT = 'fei-cxp';
const DEFAULT_TIMEZONE = 'Asia/Shanghai';
const DEFAULT_SCHEDULE = '08:00';
const REPO_DIR = path.resolve(__dirname, '..');
const NOOTAG_REPO_DIR = path.resolve(REPO_DIR, '..', 'nooTag_MP_Weixin_Bot');
const DEFAULT_SYNC_RESULT_FILE = path.join(
  NOOTAG_REPO_DIR,
  '.runtime',
  'topic_sync',
  'changxianpai_daily_topic_last_result.json'
);
const DEFAULT_SYNC_CONFIG_FILE = path.join(
  NOOTAG_REPO_DIR,
  'config',
  'feishu_task',
  'changxianpai_daily_topic_sync.json'
);
const DEFAULT_SYNC_STATE_FILE = path.join(
  NOOTAG_REPO_DIR,
  '.runtime',
  'topic_sync',
  'changxianpai_daily_topic_state.json'
);
const DEFAULT_BRIEF_SENT_STATE_FILE = path.join(
  REPO_DIR,
  '.runtime',
  'feishu',
  'changxianpai_morning_brief_sent_state.json'
);
const RUN_LOCK_DIR = path.join(REPO_DIR, '.runtime', 'feishu', 'scheduled_job_run_locks');
const RUN_LOCK_STALE_MS = 30 * 60 * 1000;

function getArg(argv, flag, fallback = '') {
  const idx = argv.indexOf(flag);
  if (idx >= 0 && idx + 1 < argv.length) return argv[idx + 1];
  return fallback;
}

function hasFlag(argv, flag) {
  return argv.includes(flag);
}

function nowIso() {
  return new Date().toISOString();
}

function cleanCardText(value) {
  return normalizeString(value)
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

function parseJsonObject(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (_) {
    const first = raw.indexOf('{');
    const last = raw.lastIndexOf('}');
    if (first >= 0 && last > first) {
      return JSON.parse(raw.slice(first, last + 1));
    }
    return null;
  }
}

function normalizeSourceLabel(value) {
  const raw = cleanCardText(value);
  if (!raw) return '';
  const map = {
    apple_newsroom: 'Apple Newsroom',
    apple_developer_news: 'Apple Developer',
    google_news_apple_zh: 'Google News 聚合',
    sync_created: '本轮新增',
    sync_selected: '本轮同步',
    sync_dry_run: '本轮候选',
    sync_empty: '本轮无新增',
    sync_refresh_failed: '本轮抓取失败',
    sync_stale: '本轮结果过期',
    state_fallback: '最近已同步',
  };
  return map[raw] || raw;
}

function buildTodayYmd(timeZone = DEFAULT_TIMEZONE) {
  return formatYmdFromDate(new Date(), timeZone);
}

function formatYmdFromDate(date, timeZone = DEFAULT_TIMEZONE) {
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

function buildYmdFromIso(value, timeZone = DEFAULT_TIMEZONE) {
  const raw = normalizeString(value);
  if (!raw) return '';
  const ts = Date.parse(raw);
  if (!Number.isFinite(ts)) return '';
  return formatYmdFromDate(new Date(ts), timeZone);
}

function safePathSegment(value) {
  const text = normalizeString(value).replace(/[^A-Za-z0-9._-]+/g, '_');
  return text || 'unknown';
}

function runLockPath(accountName, runKey) {
  return path.join(
    RUN_LOCK_DIR,
    `${safePathSegment(accountName)}__changxianpai_morning_brief__${safePathSegment(runKey)}.json`
  );
}

function readRunLock(filePath) {
  try {
    return asPlainObject(JSON.parse(fs.readFileSync(filePath, 'utf8')));
  } catch (_) {
    return {};
  }
}

function acquireRunLock(accountName, runKey) {
  const filePath = runLockPath(accountName, runKey);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const payload = {
    status: 'running',
    account_name: accountName,
    run_key: runKey,
    pid: process.pid,
    created_at: nowIso(),
    updated_at: nowIso(),
  };
  try {
    fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
    });
    return { acquired: true, filePath };
  } catch (err) {
    if (err?.code !== 'EEXIST') throw err;
    const current = readRunLock(filePath);
    if (normalizeString(current.status) === 'sent') {
      return { acquired: false, filePath, reason: 'sent' };
    }
    const createdAt = Date.parse(normalizeString(current.created_at || current.updated_at));
    const stale = !Number.isFinite(createdAt) || Date.now() - createdAt > RUN_LOCK_STALE_MS;
    if (!stale) {
      return { acquired: false, filePath, reason: normalizeString(current.status) || 'locked' };
    }
    try {
      fs.unlinkSync(filePath);
    } catch (_) {
      return { acquired: false, filePath, reason: 'locked' };
    }
    return acquireRunLock(accountName, runKey);
  }
}

function markRunLockSent(lock, messageId = '') {
  if (!lock?.acquired || !lock.filePath) return;
  const current = readRunLock(lock.filePath);
  const next = {
    ...current,
    status: 'sent',
    message_id: normalizeString(messageId),
    updated_at: nowIso(),
  };
  fs.writeFileSync(lock.filePath, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
}

function releaseRunLock(lock) {
  if (!lock?.acquired || !lock.filePath) return;
  try {
    fs.unlinkSync(lock.filePath);
  } catch (_) {
    // best effort
  }
}

function readMaybeJson(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  const raw = fs.readFileSync(filePath, 'utf8').trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (_) {
    const first = raw.indexOf('{');
    const last = raw.lastIndexOf('}');
    if (first >= 0 && last > first) {
      return JSON.parse(raw.slice(first, last + 1));
    }
    throw _;
  }
}

function buildSummaryFingerprint(value) {
  const raw = normalizeString(value).toLowerCase();
  if (!raw) return '';
  let hash = 2166136261;
  for (let i = 0; i < raw.length; i += 1) {
    hash ^= raw.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function loadSentState(filePath) {
  const parsed = asPlainObject(readMaybeJson(filePath) || {});
  return {
    sent_summary_keys: Array.isArray(parsed.sent_summary_keys) ? parsed.sent_summary_keys.filter(Boolean) : [],
    sent_map: asPlainObject(parsed.sent_map),
    last_sent_at: normalizeString(parsed.last_sent_at),
  };
}

function saveSentState(filePath, state, limit = 200) {
  if (!filePath) return;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const keys = Array.isArray(state.sent_summary_keys) ? state.sent_summary_keys.filter(Boolean).slice(0, limit) : [];
  const sentMap = asPlainObject(state.sent_map);
  const nextMap = {};
  for (const key of keys) {
    if (sentMap[key]) nextMap[key] = sentMap[key];
  }
  const body = {
    sent_summary_keys: keys,
    sent_map: nextMap,
    last_sent_at: normalizeString(state.last_sent_at),
  };
  fs.writeFileSync(filePath, `${JSON.stringify(body, null, 2)}\n`, 'utf8');
}

function markTopicsSent(sentState, topics, now = nowIso()) {
  sentState.sent_summary_keys = Array.isArray(sentState.sent_summary_keys) ? sentState.sent_summary_keys : [];
  sentState.sent_map = asPlainObject(sentState.sent_map);
  for (const topic of topics) {
    const key = buildSummaryFingerprint(topic.summary);
    if (!key) continue;
    sentState.sent_summary_keys = [key, ...sentState.sent_summary_keys.filter((item) => item !== key)];
    sentState.sent_map[key] = {
      summary: normalizeString(topic.summary),
      source: normalizeString(topic.source),
      link: normalizeString(topic.link),
      sent_at: now,
    };
  }
  sentState.last_sent_at = now;
}

function resolveMorningBriefConfig(accountName) {
  const config = readConfigEntry('feishu', accountName, {});
  const raw = asPlainObject(config.morning_brief);
  return {
    accountName,
    enabled: raw.enabled !== false,
    runTopicSync: raw.run_topic_sync !== false,
    chatId: normalizeString(raw.chat_id || raw.chatId),
    chatName: normalizeString(raw.chat_name || raw.chatName),
    timeZone: normalizeString(raw.timezone || DEFAULT_TIMEZONE) || DEFAULT_TIMEZONE,
    schedule: normalizeString(raw.schedule || DEFAULT_SCHEDULE) || DEFAULT_SCHEDULE,
    syncConfigFile: normalizeString(raw.sync_config_file || raw.syncConfigFile) || DEFAULT_SYNC_CONFIG_FILE,
    syncResultFile: normalizeString(raw.sync_result_file || raw.syncResultFile) || DEFAULT_SYNC_RESULT_FILE,
    syncStateFile: normalizeString(raw.sync_state_file || raw.syncStateFile) || DEFAULT_SYNC_STATE_FILE,
    sentStateFile: normalizeString(raw.sent_state_file || raw.sentStateFile) || DEFAULT_BRIEF_SENT_STATE_FILE,
    feishuConfig: config,
  };
}

function splitDescription(description) {
  const rawLines = String(description || '')
    .split('\n')
    .map((line) => cleanCardText(line))
    .filter(Boolean);
  const outline = [];
  const sources = [];
  let inSources = false;
  for (const line of rawLines) {
    if (line === '大纲：') continue;
    if (line === '参考信源：') {
      inSources = true;
      continue;
    }
    if (inSources) {
      sources.push(line.replace(/^-+\s*/, ''));
    } else {
      outline.push(line.replace(/^\d+\.\s*/, ''));
    }
  }
  return { outline, sources };
}

function normalizeTopicEntry(entry = {}) {
  const value = asPlainObject(entry);
  const description = String(value.description || '')
    .split('\n')
    .map((line) => cleanCardText(line))
    .filter(Boolean)
    .join('\n');
  const parsed = splitDescription(description);
  return {
    summary: cleanCardText(value.summary),
    description,
    outline: parsed.outline,
    sources: parsed.sources,
    source: normalizeSourceLabel(value.source),
    publishedAt: normalizeString(value.published_at || value.publishedAt),
    link: normalizeString(value.link),
  };
}

function loadTopicsFromSyncResultPayload(payload = {}) {
  const parsed = asPlainObject(payload);
  const isDryRun = parsed.dry_run === true;
  const created = Array.isArray(parsed.created) ? parsed.created.map(normalizeTopicEntry).filter((item) => item.summary) : [];
  if (created.length > 0) {
    return {
      source: isDryRun ? 'sync_dry_run' : 'sync_created',
      ranAt: normalizeString(parsed.ran_at || parsed.ranAt),
      topics: created.slice(0, 3),
    };
  }
  const selected = Array.isArray(parsed.selected_entries)
    ? parsed.selected_entries.map(normalizeTopicEntry).filter((item) => item.summary)
    : [];
  if (selected.length > 0) {
    return {
      source: isDryRun ? 'sync_dry_run' : 'sync_selected',
      ranAt: normalizeString(parsed.ran_at || parsed.ranAt),
      topics: selected.slice(0, 3),
    };
  }
  return { source: 'sync_empty', ranAt: normalizeString(parsed.ran_at || parsed.ranAt), topics: [] };
}

function loadTopicsFromSyncResult(filePath) {
  return loadTopicsFromSyncResultPayload(readMaybeJson(filePath) || {});
}

function loadTopicsFromState(filePath) {
  const parsed = asPlainObject(readMaybeJson(filePath) || {});
  const keys = Array.isArray(parsed.processed_keys) ? parsed.processed_keys : [];
  const map = asPlainObject(parsed.processed_map);
  const topics = [];
  for (const key of keys) {
    const item = asPlainObject(map[key]);
    const summary = normalizeString(item.summary);
    if (!summary) continue;
    topics.push({
      summary,
      description: '',
      outline: ['已同步到「选题库」，可直接按任务详情继续写。'],
      sources: [normalizeString(item.link)],
      source: normalizeSourceLabel(item.source),
      publishedAt: normalizeString(item.processed_at),
      link: normalizeString(item.link),
    });
    if (topics.length >= 3) break;
  }
  return {
    source: 'state_fallback',
    ranAt: normalizeString(parsed.last_run_at),
    topics,
  };
}

function loadBriefTopics(config, options = {}) {
  const fromSync = loadTopicsFromSyncResult(config.syncResultFile);
  const fromState = loadTopicsFromState(config.syncStateFile);
  const reportDate = normalizeString(options.reportDate || buildTodayYmd(config.timeZone));
  const requireFreshSync = options.requireFreshSync === true;
  const syncDate = buildYmdFromIso(fromSync.ranAt, config.timeZone);
  const stateDate = buildYmdFromIso(fromState.ranAt, config.timeZone);
  if (requireFreshSync) {
    if (syncDate && syncDate === reportDate) {
      return fromSync;
    }
    return {
      source: options.syncRefresh?.ok === false ? 'sync_refresh_failed' : 'sync_stale',
      ranAt: fromSync.ranAt,
      topics: [],
    };
  }
  if (syncDate && syncDate === reportDate && fromSync.topics.length > 0) return fromSync;
  if (stateDate && stateDate === reportDate && fromState.topics.length > 0) return fromState;
  if (fromSync.topics.length === 0 && fromState.topics.length > 0 && stateDate === reportDate) {
    return fromState;
  }
  return {
    source: 'sync_stale',
    ranAt: fromSync.ranAt || fromState.ranAt,
    topics: [],
  };
}

function refreshTopicSyncSnapshot(config) {
  if (!config.runTopicSync) {
    return { ok: true, skipped: true, reason: 'disabled' };
  }
  const syncScriptPath = path.join(NOOTAG_REPO_DIR, 'tools', 'changxianpai_daily_topic_sync.js');
  if (!fs.existsSync(syncScriptPath)) {
    return { ok: false, error: `topic sync script not found: ${syncScriptPath}` };
  }
  const args = [syncScriptPath, '--account', config.accountName, '--config', config.syncConfigFile, '--json'];
  const res = spawnSync(process.execPath, args, {
    cwd: NOOTAG_REPO_DIR,
    env: {
      ...process.env,
      NODE_TLS_REJECT_UNAUTHORIZED: process.env.NODE_TLS_REJECT_UNAUTHORIZED || '0',
    },
    encoding: 'utf8',
    timeout: 5 * 60 * 1000,
  });
  if (res.error) {
    return { ok: false, error: res.error.message || String(res.error) };
  }
  if (Number(res.status || 0) !== 0) {
    return {
      ok: false,
      error: normalizeString(res.stderr || res.stdout) || `exit status ${res.status}`,
    };
  }
  const output = normalizeString(res.stdout);
  if (!output) return { ok: true, parsed: null };
  const parsed = parseJsonObject(output);
  return parsed ? { ok: true, parsed, raw: output } : { ok: true, parsed: null, raw: output };
}

async function buildFeedOnlyBriefTopics(config) {
  const syncScriptPath = path.join(NOOTAG_REPO_DIR, 'tools', 'changxianpai_daily_topic_sync.js');
  if (!fs.existsSync(syncScriptPath)) {
    return { ok: false, error: `topic sync script not found: ${syncScriptPath}` };
  }

  const syncModule = require(syncScriptPath);
  const syncConfig = syncModule.loadSyncConfig(config.syncConfigFile);
  const state = syncModule.loadState(config.syncStateFile);
  const stateIndex = syncModule.buildStateIndex(state);
  const sentState = loadSentState(config.sentStateFile);
  const nowTs = Date.now();
  const now = nowIso();
  const maxNewTasks = Math.max(0, Number(syncConfig.max_new_tasks || 3));

  const feedResults = await Promise.all(
    syncConfig.sources.map(async (sourceMeta) => {
      try {
        const items = await syncModule.fetchFeedItems(sourceMeta);
        return { sourceMeta, items, error: '' };
      } catch (err) {
        return { sourceMeta, items: [], error: err.message };
      }
    })
  );

  const allFeedItems = syncModule.dedupeFeedItems(
    syncModule.filterFeedItems(
      feedResults.flatMap((entry) => entry.items),
      syncConfig,
      nowTs
    )
  );
  const rankedItems = syncModule.rankFeedItems(allFeedItems);
  const seenStateKeys = new Set(stateIndex.itemKeys);
  const seenTitleKeys = new Set(stateIndex.titleKeys);
  const seenSummaryKeys = new Set(stateIndex.summaryKeys);
  for (const key of sentState.sent_summary_keys) {
    if (key) seenSummaryKeys.add(key);
  }
  const selected = [];
  const selectedThirdPartySources = new Set();

  for (const item of rankedItems) {
    if (selected.length >= maxNewTasks) break;
    const itemTitleKey = syncModule.buildItemTitleKey(item);
    if (seenStateKeys.has(item.itemKey)) continue;
    if (itemTitleKey && seenTitleKeys.has(itemTitleKey)) continue;
    if (item.feedId === 'google_news_apple_zh' && selectedThirdPartySources.has(item.sourceName)) continue;
    const summary = syncModule.buildTopicTitle(item);
    if (!summary) continue;
    const summaryKey = syncModule.buildSummaryKey(summary) || buildSummaryFingerprint(summary);
    if (summaryKey && seenSummaryKeys.has(summaryKey)) continue;
    selected.push({
      summary,
      description: syncModule.buildDescription(item, summary),
      source: item.sourceName,
      published_at: normalizeString(item.publishedAt) || (Number.isFinite(item.publishedTs) ? new Date(item.publishedTs).toISOString() : ''),
      link: normalizeString(item.link),
      dry_run: true,
    });
    if (item.feedId === 'google_news_apple_zh') {
      selectedThirdPartySources.add(item.sourceName);
    }
    seenStateKeys.add(item.itemKey);
    if (itemTitleKey) seenTitleKeys.add(itemTitleKey);
    if (summaryKey) seenSummaryKeys.add(summaryKey);
  }

  return {
    ok: true,
    parsed: {
      ok: true,
      dry_run: true,
      config: config.syncConfigFile,
      created: selected,
      selected_entries: selected,
      created_count: selected.length,
      feed_errors: feedResults
        .filter((entry) => entry.error)
        .map((entry) => ({ source: entry.sourceMeta.id, error: entry.error })),
      ran_at: now,
      skipped_count: Math.max(0, rankedItems.length - selected.length),
      state_file: config.syncStateFile,
      last_result_file: config.syncResultFile,
    },
  };
}

function buildTopicMarkdown(topic, index) {
  const lines = [`**${index + 1}. ${topic.summary}**`];
  if (topic.outline.length > 0) {
    lines.push('内容介绍：');
    lines.push(topic.outline.slice(0, 3).map((line, i) => `${i + 1}. ${cleanCardText(line)}`).join('\n'));
  } else if (topic.description) {
    lines.push('内容介绍：');
    lines.push(cleanCardText(topic.description));
  }
  const sourceBits = [];
  if (topic.source) sourceBits.push(`来源：${topic.source}`);
  if (topic.link) sourceBits.push(`[查看信源](${topic.link})`);
  if (sourceBits.length > 0) {
    lines.push(sourceBits.join(' · '));
  }
  return lines.join('\n');
}

function buildCardPayload({ config, briefTopics, isTest = false, reportDate = buildTodayYmd(config.timeZone) }) {
  const headerTitle = isTest
    ? `尝鲜派早报｜${reportDate}｜测试`
    : `尝鲜派早报｜${reportDate}`;
  const topicCount = briefTopics.topics.length;
  let intro = '今天还没有新增可写选题，我会继续跟进苹果公开信源。';
  if (topicCount > 0) {
    intro = briefTopics.source === 'sync_dry_run'
      ? `选题库同步失败，先发今天的候选日报，共 **${topicCount}** 条。`
      : `今天可看的苹果选题有 **${topicCount}** 条，已同步到「选题库」。`;
  } else if (briefTopics.source === 'sync_refresh_failed') {
    intro = '今早抓取最新苹果信源失败，这次没有复用旧选题。';
  } else if (briefTopics.source === 'sync_stale') {
    intro = '今早还没有拿到当日同步结果，这次没有复用旧选题。';
  }

  const elements = [
    {
      tag: 'markdown',
      content: `${intro}\n${config.chatName ? `目标群：${config.chatName}` : ''}`.trim(),
    },
  ];

  if (topicCount > 0) {
    elements.push({ tag: 'hr' });
    for (let i = 0; i < briefTopics.topics.length; i += 1) {
      elements.push({
        tag: 'markdown',
        content: buildTopicMarkdown(briefTopics.topics[i], i),
      });
      if (i < briefTopics.topics.length - 1) {
        elements.push({ tag: 'hr' });
      }
    }
  }

  elements.push({
    tag: 'note',
    elements: [
      {
        tag: 'plain_text',
        content: `同步来源：${normalizeSourceLabel(briefTopics.source)}｜最近同步：${briefTopics.ranAt || '未知'}`,
      },
    ],
  });

  return {
    config: {
      wide_screen_mode: true,
      enable_forward: true,
    },
    header: {
      template: 'blue',
      title: {
        tag: 'plain_text',
        content: headerTitle,
      },
    },
    elements,
  };
}

async function main(argv = process.argv.slice(2)) {
  const account = normalizeString(getArg(argv, '--account', DEFAULT_ACCOUNT)) || DEFAULT_ACCOUNT;
  const emitJson = hasFlag(argv, '--json');
  const shouldSend = hasFlag(argv, '--send');
  const forceRefreshSync = hasFlag(argv, '--refresh-sync');
  const allowDuplicate = hasFlag(argv, '--allow-duplicate');
  const isTest = hasFlag(argv, '--test');
  const overrideChatId = normalizeString(getArg(argv, '--chat-id', ''));
  const overrideSyncResult = normalizeString(getArg(argv, '--sync-result', ''));
  const overrideSyncState = normalizeString(getArg(argv, '--sync-state', ''));
  const overrideSentState = normalizeString(getArg(argv, '--sent-state', ''));

  const config = resolveMorningBriefConfig(account);
  if (overrideChatId) config.chatId = overrideChatId;
  if (overrideSyncResult) config.syncResultFile = overrideSyncResult;
  if (overrideSyncState) config.syncStateFile = overrideSyncState;
  if (overrideSentState) config.sentStateFile = overrideSentState;
  const reportDate = buildTodayYmd(config.timeZone);

  let syncRefresh = { ok: true, skipped: true, reason: 'not_requested' };
  let syncPreview = { ok: true, skipped: true, reason: 'not_requested' };
  if (shouldSend || forceRefreshSync) {
    syncRefresh = refreshTopicSyncSnapshot(config);
    if (!syncRefresh.ok) {
      syncPreview = await buildFeedOnlyBriefTopics(config);
    }
  }

  const livePreview = syncRefresh.ok && syncRefresh.parsed
    ? loadTopicsFromSyncResultPayload(syncRefresh.parsed)
    : syncPreview.ok && syncPreview.parsed
      ? loadTopicsFromSyncResultPayload(syncPreview.parsed)
      : null;
  const briefTopics = livePreview || loadBriefTopics(config, {
    reportDate,
    requireFreshSync: shouldSend || forceRefreshSync,
    syncRefresh,
  });
  const card = buildCardPayload({ config, briefTopics, isTest, reportDate });
  const summary = {
    ok: true,
    account,
    chat_id: config.chatId,
    chat_name: config.chatName,
    report_date: reportDate,
    source: normalizeSourceLabel(briefTopics.source),
    sync_refresh: syncRefresh,
    sync_preview: syncPreview,
    sync_config_file: config.syncConfigFile,
    sync_result_file: config.syncResultFile,
    sync_state_file: config.syncStateFile,
    sent_state_file: config.sentStateFile,
    topic_count: briefTopics.topics.length,
    topics: briefTopics.topics.map((topic) => ({
      summary: topic.summary,
      source: topic.source,
      link: topic.link,
    })),
    card,
  };

  if (emitJson && !shouldSend) {
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    return;
  }

  if (!shouldSend) {
    process.stdout.write(`${JSON.stringify(card, null, 2)}\n`);
    return;
  }

  ensure(config.enabled, `morning_brief is disabled for account "${account}"`);
  ensure(config.chatId, `morning_brief.chat_id is required for account "${account}"`);
  const runKey = buildTodayYmd(config.timeZone);
  const lock = allowDuplicate ? null : acquireRunLock(account, runKey);
  if (lock && !lock.acquired) {
    process.stdout.write(`skip duplicate morning brief for ${account} on ${runKey} (${lock.reason || 'locked'})\n`);
    return;
  }

  const runtime = createMessageChannelRuntime(config.feishuConfig, {
    feishuDomain: config.feishuConfig.domain || 'feishu',
    feishuCreds: resolveCredentials(config.feishuConfig),
  });

  try {
    const receipt = await sendUnifiedMessage(runtime, {
      channelType: 'feishu',
      targetType: 'chat',
      targetId: config.chatId,
      messageType: 'card',
      content: card,
    });
    const messageId = Array.isArray(receipt?.messageIds) && receipt.messageIds.length > 0
      ? normalizeString(receipt.messageIds[0])
      : '';
    if (briefTopics.topics.length > 0) {
      const sentState = loadSentState(config.sentStateFile);
      markTopicsSent(sentState, briefTopics.topics);
      saveSentState(config.sentStateFile, sentState);
    }
    if (lock) markRunLockSent(lock, messageId);
    process.stdout.write(`${JSON.stringify({ ...summary, message_id: messageId, sent: true }, null, 2)}\n`);
  } catch (err) {
    if (lock) releaseRunLock(lock);
    throw err;
  }
}

module.exports = {
  buildCardPayload,
  buildTodayYmd,
  buildYmdFromIso,
  loadBriefTopics,
  loadTopicsFromSyncResult,
};

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`${err.message || String(err)}\n`);
    process.exit(1);
  });
}
