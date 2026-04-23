const fs = require('fs');
const os = require('os');
const path = require('path');
const { randomBytes } = require('crypto');

const {
  asPlainObject,
  compactText,
  ensure,
  normalizeString,
  runCodexExec,
} = require('./studio_runtime_support');
const {
  buildDailyStoreReport,
  renderDailyStoreReportFeishuCard,
  renderDailyStoreReportMarkdown,
  renderDailyStoreReportText,
  resolveDailyStoreReportConfig,
} = require('./daily_store_report');
const {
  createMessageChannelRuntime,
  getNamedTargetMatches,
  normalizeChannelType,
  normalizeTargetType,
  sendUnifiedMessage,
} = require('./message_channel_delivery');

const TASK_TYPE_DAILY_STORE_REPORT = 'daily_store_report';
const TASK_TYPE_SKILL_RUN = 'skill_run';
const DEFAULT_TASK_TYPE = TASK_TYPE_DAILY_STORE_REPORT;
const DEFAULT_TIMEZONE = 'Asia/Shanghai';
const DEFAULT_SCHEDULE = '08:00';
const STORE_DIR = 'scheduled_jobs';
const LEGACY_STORE_DIR = 'scheduled_report_tasks';
const RUN_LOCK_DIR = 'scheduled_job_run_locks';
const RUN_LOCK_STALE_MS = 30 * 60 * 1000;
const RETRY_DELAYS_MS = [60 * 1000, 5 * 60 * 1000, 15 * 60 * 1000];
const SUPPORTED_TASK_TYPES = new Set([TASK_TYPE_DAILY_STORE_REPORT, TASK_TYPE_SKILL_RUN]);
const DEFAULT_BUSY_POLICY = 'queue_after_current';
const CODEX_HOME = normalizeString(process.env.CODEX_HOME) || path.join(os.homedir(), '.codex');
const DEFAULT_SKILLS_ROOT = path.join(CODEX_HOME, 'skills');
const DEFAULT_DAILY_REPORT_SKILL = 'store-daily-report';

function asBool(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
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

function addDaysYmd(ymd, delta) {
  const base = new Date(`${ymd}T00:00:00Z`);
  base.setUTCDate(base.getUTCDate() + delta);
  return base.toISOString().slice(0, 10);
}

function buildTimestampForSchedule(ymd, scheduleTime, timeZone = DEFAULT_TIMEZONE) {
  const safeYmd = normalizeString(ymd);
  const safeSchedule = normalizeString(scheduleTime || DEFAULT_SCHEDULE) || DEFAULT_SCHEDULE;
  if (timeZone !== DEFAULT_TIMEZONE) {
    return Date.parse(`${safeYmd}T${safeSchedule}:00+08:00`);
  }
  return Date.parse(`${safeYmd}T${safeSchedule}:00+08:00`);
}

function normalizeScheduleTime(rawValue) {
  const text = normalizeString(rawValue || DEFAULT_SCHEDULE) || DEFAULT_SCHEDULE;
  const match = text.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return DEFAULT_SCHEDULE;
  const hour = Math.max(0, Math.min(23, Number.parseInt(match[1], 10)));
  const minute = Math.max(0, Math.min(59, Number.parseInt(match[2], 10)));
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function parseChineseScheduleTime(text) {
  const raw = normalizeString(text);
  if (!raw) return '';

  const colonMatch = raw.match(/(\d{1,2})\s*[:：]\s*(\d{1,2})/);
  let hour = null;
  let minute = 0;
  if (colonMatch) {
    hour = Number.parseInt(colonMatch[1], 10);
    minute = Number.parseInt(colonMatch[2], 10);
  } else {
    const pointHalfMatch = raw.match(/(\d{1,2})\s*点\s*半/);
    if (pointHalfMatch) {
      hour = Number.parseInt(pointHalfMatch[1], 10);
      minute = 30;
    } else {
      const pointMatch = raw.match(/(\d{1,2})\s*点(?:\s*(\d{1,2})\s*分?)?/);
      if (pointMatch) {
        hour = Number.parseInt(pointMatch[1], 10);
        minute = Number.parseInt(pointMatch[2] || '0', 10);
      }
    }
  }

  if (!Number.isFinite(hour) || hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    return '';
  }

  if (/(凌晨)/.test(raw)) {
    if (hour === 12) hour = 0;
  } else if (/(早上|早晨|上午)/.test(raw)) {
    if (hour === 12) hour = 0;
  } else if (/(中午)/.test(raw)) {
    if (hour >= 1 && hour <= 10) hour += 12;
  } else if (/(下午|晚上|傍晚|晚间|今晚)/.test(raw)) {
    if (hour >= 1 && hour <= 11) hour += 12;
  }

  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function parseTimeCommand(text) {
  const raw = normalizeString(text);
  if (!raw) return { matched: false, body: '' };
  const match = raw.match(/^\/time(?:\s+(.*))?$/i);
  if (!match) return { matched: false, body: '' };
  return {
    matched: true,
    body: normalizeString(match[1] || ''),
  };
}

function nowIso() {
  return new Date().toISOString();
}

function shortId(value) {
  const text = normalizeString(value);
  if (!text) return '(empty)';
  if (text.length <= 12) return text;
  return `${text.slice(0, 6)}...${text.slice(-4)}`;
}

function taskStorePath(runtimeDir, accountName) {
  return path.join(runtimeDir, STORE_DIR, `${accountName}.json`);
}

function legacyTaskStorePath(runtimeDir, accountName) {
  return path.join(runtimeDir, LEGACY_STORE_DIR, `${accountName}.json`);
}

function safePathSegment(value) {
  const text = normalizeString(value).replace(/[^A-Za-z0-9._-]+/g, '_');
  return text || 'unknown';
}

function taskRunLockPath(runtimeDir, accountName, taskId, runKey) {
  return path.join(
    runtimeDir,
    RUN_LOCK_DIR,
    `${safePathSegment(accountName)}__${safePathSegment(taskId)}__${safePathSegment(runKey)}.json`
  );
}

function readRunLock(filePath) {
  try {
    return asPlainObject(JSON.parse(fs.readFileSync(filePath, 'utf8')));
  } catch (_) {
    return {};
  }
}

function acquireAutoRunLock(runtimeDir, accountName, taskId, runKey) {
  const filePath = taskRunLockPath(runtimeDir, accountName, taskId, runKey);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const payload = {
    status: 'running',
    account_name: accountName,
    task_id: taskId,
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
    return acquireAutoRunLock(runtimeDir, accountName, taskId, runKey);
  }
}

function markAutoRunLockSent(lock, receiptId = '') {
  if (!lock?.acquired || !lock.filePath) return;
  const current = readRunLock(lock.filePath);
  const next = {
    ...current,
    status: 'sent',
    receipt_id: normalizeString(receiptId),
    updated_at: nowIso(),
  };
  fs.writeFileSync(lock.filePath, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
}

function releaseAutoRunLock(lock) {
  if (!lock?.acquired || !lock.filePath) return;
  try {
    fs.unlinkSync(lock.filePath);
  } catch (_) {
    // best effort
  }
}

function readTaskStore(filePath, fallbackFilePath = '') {
  const candidates = [filePath, fallbackFilePath].filter(Boolean);
  for (const candidate of candidates) {
    try {
      if (!fs.existsSync(candidate)) continue;
      const parsed = JSON.parse(fs.readFileSync(candidate, 'utf8'));
      return asPlainObject(parsed);
    } catch (_) {
      // keep trying next candidate
    }
  }
  return { version: 1, tasks: [] };
}

function writeTaskStore(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function normalizeTaskType(value) {
  const raw = normalizeString(value).toLowerCase();
  if (raw === TASK_TYPE_DAILY_STORE_REPORT || raw === 'daily_report') return TASK_TYPE_DAILY_STORE_REPORT;
  if (raw === TASK_TYPE_SKILL_RUN || raw === 'skill' || raw === 'scheduled_skill') return TASK_TYPE_SKILL_RUN;
  return '';
}

function normalizeBusyPolicy(value) {
  const raw = normalizeString(value).toLowerCase();
  if (raw === 'queue_after_current' || raw === 'queue') return 'queue_after_current';
  if (raw === 'run_immediately' || raw === 'immediate') return 'run_immediately';
  return DEFAULT_BUSY_POLICY;
}

function expandHomePath(rawPath) {
  const text = normalizeString(rawPath);
  if (!text) return '';
  if (text === '~') return os.homedir();
  if (text.startsWith('~/')) return path.join(os.homedir(), text.slice(2));
  return text;
}

function listSkills(skillsRoot = DEFAULT_SKILLS_ROOT) {
  const entries = [];
  const root = normalizeString(skillsRoot) || DEFAULT_SKILLS_ROOT;

  function visit(dirPath) {
    if (!fs.existsSync(dirPath)) return;
    let items = [];
    try {
      items = fs.readdirSync(dirPath, { withFileTypes: true });
    } catch (_) {
      return;
    }
    for (const item of items) {
      if (!item.isDirectory()) continue;
      const childPath = path.join(dirPath, item.name);
      if (item.name === '.system') {
        visit(childPath);
        continue;
      }
      const skillFile = path.join(childPath, 'SKILL.md');
      if (fs.existsSync(skillFile)) {
        entries.push({
          name: item.name,
          path: skillFile,
        });
      }
    }
  }

  visit(root);
  entries.sort((a, b) => String(b.name || '').length - String(a.name || '').length);
  return entries;
}

function findSkillByName(name, skillsRoot = DEFAULT_SKILLS_ROOT) {
  const wanted = normalizeString(name).toLowerCase();
  if (!wanted) return null;
  const skills = listSkills(skillsRoot);
  return skills.find((item) => String(item.name || '').toLowerCase() === wanted) || null;
}

function resolveDefaultDailyReportSkill(skillsRoot = DEFAULT_SKILLS_ROOT) {
  return findSkillByName(DEFAULT_DAILY_REPORT_SKILL, skillsRoot);
}

function resolveSkillReference(text, { skillsRoot = DEFAULT_SKILLS_ROOT } = {}) {
  const raw = normalizeString(text);
  if (!raw) {
    return {
      skillRef: '',
      skillPath: '',
      source: '',
    };
  }

  const pathMatch = raw.match(/((?:~|\/)[^\s"'`]+\/SKILL\.md)/);
  if (pathMatch?.[1]) {
    const resolved = path.resolve(expandHomePath(pathMatch[1]));
    if (fs.existsSync(resolved)) {
      return {
        skillRef: path.basename(path.dirname(resolved)),
        skillPath: resolved,
        source: 'path',
      };
    }
  }

  for (const match of raw.matchAll(/\$([A-Za-z0-9._-]+)/g)) {
    const found = findSkillByName(match[1], skillsRoot);
    if (found) {
      return {
        skillRef: found.name,
        skillPath: found.path,
        source: 'dollar',
      };
    }
  }

  const labeledMatch = raw.match(/(?:skill|技能)\s*[:：]?\s*([A-Za-z0-9._-]+)/i);
  if (labeledMatch?.[1]) {
    const found = findSkillByName(labeledMatch[1], skillsRoot);
    if (found) {
      return {
        skillRef: found.name,
        skillPath: found.path,
        source: 'label',
      };
    }
  }

  if (/(运行|执行|触发|调用)/.test(raw)) {
    for (const item of listSkills(skillsRoot)) {
      const pattern = new RegExp(`(^|[\\s"'“”‘’（）()【】\\[\\],，。.!?:：;；])${escapeRegExp(item.name)}($|[\\s"'“”‘’（）()【】\\[\\],，。.!?:：;；])`, 'i');
      if (pattern.test(raw)) {
        return {
          skillRef: item.name,
          skillPath: item.path,
          source: 'name',
        };
      }
    }
  }

  return {
    skillRef: '',
    skillPath: '',
    source: '',
  };
}

function maybeReferencesSkill(text) {
  const raw = normalizeString(text);
  if (!raw) return false;
  return /\$[A-Za-z0-9._-]+/.test(raw) || /SKILL\.md/i.test(raw) || /(skill|技能)/i.test(raw);
}

function hasDailyTaskKeywords(text) {
  return /(昨日店铺报告|店铺报告|日报任务|日报)/.test(normalizeString(text));
}

function inferTaskTypeFromText(text, skillReference) {
  if (hasDailyTaskKeywords(text)) return TASK_TYPE_DAILY_STORE_REPORT;
  if (normalizeString(skillReference?.skillPath || skillReference?.skillRef) || maybeReferencesSkill(text)) {
    return TASK_TYPE_SKILL_RUN;
  }
  return '';
}

function computeNextRunAt(task, now = new Date()) {
  const timeZone = normalizeString(task.timezone || DEFAULT_TIMEZONE) || DEFAULT_TIMEZONE;
  const scheduleTime = normalizeScheduleTime(task.schedule_time || DEFAULT_SCHEDULE);
  const today = buildYmd(now, timeZone);
  const todayTs = buildTimestampForSchedule(today, scheduleTime, timeZone);
  const nowMs = now instanceof Date ? now.getTime() : Date.now();
  if (nowMs < todayTs) return todayTs;
  const tomorrow = addDaysYmd(today, 1);
  return buildTimestampForSchedule(tomorrow, scheduleTime, timeZone);
}

function normalizeTask(task = {}, defaults = {}) {
  const merged = { ...defaults, ...asPlainObject(task) };
  const normalizedType = normalizeTaskType(
    merged.task_type || merged.taskType || merged.executor_type || merged.executorType || DEFAULT_TASK_TYPE
  ) || DEFAULT_TASK_TYPE;
  const createdAt = normalizeString(merged.created_at) || nowIso();
  const updatedAt = normalizeString(merged.updated_at) || createdAt;
  const generatedId = normalizedType === TASK_TYPE_SKILL_RUN
    ? `sjt_${randomBytes(4).toString('hex')}`
    : `drt_${randomBytes(4).toString('hex')}`;
  const normalized = {
    task_id: normalizeString(merged.task_id || merged.job_id || merged.jobId) || generatedId,
    task_type: normalizedType,
    executor_type: normalizedType,
    title: normalizeString(merged.title || merged.name || merged.display_name || merged.displayName),
    enabled: asBool(merged.enabled, true),
    schedule_time: normalizeScheduleTime(merged.schedule_time || merged.scheduleTime || DEFAULT_SCHEDULE),
    timezone: normalizeString(merged.timezone || DEFAULT_TIMEZONE) || DEFAULT_TIMEZONE,
    channel_type: normalizeChannelType(merged.channel_type || merged.channelType || 'feishu'),
    target_type: normalizeTargetType(merged.target_type || merged.targetType || 'session'),
    target_id: normalizeString(merged.target_id || merged.targetId),
    thread_id: normalizeString(merged.thread_id || merged.threadId),
    target_label: normalizeString(merged.target_label || merged.targetLabel),
    created_by: normalizeString(merged.created_by || merged.createdBy),
    created_at: createdAt,
    updated_at: updatedAt,
    last_run_at: normalizeString(merged.last_run_at || merged.lastRunAt),
    next_run_at: Number(merged.next_run_at || merged.nextRunAt || 0),
    last_status: normalizeString(merged.last_status || merged.lastStatus),
    last_error: normalizeString(merged.last_error || merged.lastError),
    last_error_at: normalizeString(merged.last_error_at || merged.lastErrorAt),
    last_receipt_id: normalizeString(merged.last_receipt_id || merged.lastReceiptId),
    last_manual_run_at: normalizeString(merged.last_manual_run_at || merged.lastManualRunAt),
    last_auto_run_key: normalizeString(merged.last_auto_run_key || merged.lastAutoRunKey),
    last_auto_exhausted_key: normalizeString(merged.last_auto_exhausted_key || merged.lastAutoExhaustedKey),
    retry_after_at: Number(merged.retry_after_at || merged.retryAfterAt || 0),
    retry_count: Number(merged.retry_count || merged.retryCount || 0),
    source: normalizeString(merged.source || 'managed'),
    busy_policy: normalizeBusyPolicy(merged.busy_policy || merged.busyPolicy),
    skill_ref: normalizeString(merged.skill_ref || merged.skillRef),
    skill_path: normalizeString(merged.skill_path || merged.skillPath),
    prompt_text: normalizeString(
      merged.prompt_text || merged.promptText || merged.job_prompt || merged.jobPrompt || merged.request_text || merged.requestText
    ),
    cwd: normalizeString(merged.cwd),
  };
  if (!normalized.title) {
    normalized.title = normalized.task_type === TASK_TYPE_DAILY_STORE_REPORT
      ? '昨日店铺报告'
      : (normalized.skill_ref ? `技能任务 / $${normalized.skill_ref}` : '技能定时任务');
  }
  if (!normalized.next_run_at) {
    normalized.next_run_at = computeNextRunAt(normalized);
  }
  return normalized;
}

function isLegacyDailyReportTask(task = {}) {
  const source = normalizeString(task.source);
  const taskId = normalizeString(task.task_id);
  return source === 'legacy_config' || /^legacy_daily_store_report_/i.test(taskId);
}

function hasSameDelivery(task = {}, other = {}) {
  return normalizeString(task.task_type || DEFAULT_TASK_TYPE) === normalizeString(other.task_type || DEFAULT_TASK_TYPE)
    && normalizeScheduleTime(task.schedule_time || DEFAULT_SCHEDULE) === normalizeScheduleTime(other.schedule_time || DEFAULT_SCHEDULE)
    && normalizeString(task.timezone || DEFAULT_TIMEZONE) === normalizeString(other.timezone || DEFAULT_TIMEZONE)
    && normalizeChannelType(task.channel_type || 'feishu') === normalizeChannelType(other.channel_type || 'feishu')
    && normalizeTargetType(task.target_type || 'session') === normalizeTargetType(other.target_type || 'session')
    && normalizeString(task.target_id) === normalizeString(other.target_id)
    && normalizeString(task.thread_id) === normalizeString(other.thread_id);
}

function normalizeTaskStore(value = {}, legacyTask = null) {
  const parsed = asPlainObject(value);
  const rawTasks = Array.isArray(parsed.tasks) ? parsed.tasks : [];
  let tasks = rawTasks
    .map((task) => normalizeTask(task))
    .filter((task) => SUPPORTED_TASK_TYPES.has(task.task_type));

  if (!legacyTask) {
    tasks = tasks.filter((task) => !isLegacyDailyReportTask(task));
  } else {
    const hasManagedEquivalent = tasks.some((task) => !isLegacyDailyReportTask(task) && hasSameDelivery(task, legacyTask));
    if (hasManagedEquivalent) {
      tasks = tasks.filter((task) => !isLegacyDailyReportTask(task));
    }
  }

  if (legacyTask && !tasks.some((task) => !isLegacyDailyReportTask(task) && hasSameDelivery(task, legacyTask))) {
    const index = tasks.findIndex((task) => task.task_id === legacyTask.task_id);
    if (index < 0) {
      tasks.unshift(normalizeTask(legacyTask));
    } else {
      tasks[index] = normalizeTask({
        ...tasks[index],
        ...legacyTask,
      });
    }
  }

  tasks.sort((a, b) => {
    if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
    if (a.schedule_time !== b.schedule_time) return String(a.schedule_time).localeCompare(String(b.schedule_time));
    return String(a.task_id).localeCompare(String(b.task_id));
  });

  return {
    version: 1,
    updated_at: normalizeString(parsed.updated_at) || nowIso(),
    tasks,
  };
}

function buildLegacyTask(dailyReportConfig, accountName) {
  if (!dailyReportConfig?.enabled || !dailyReportConfig?.chatId) return null;
  return {
    task_id: `legacy_daily_store_report_${accountName}`,
    task_type: TASK_TYPE_DAILY_STORE_REPORT,
    title: '昨日店铺报告',
    enabled: true,
    schedule_time: normalizeScheduleTime(dailyReportConfig.schedule?.label || DEFAULT_SCHEDULE),
    timezone: normalizeString(dailyReportConfig.timeZone || DEFAULT_TIMEZONE) || DEFAULT_TIMEZONE,
    channel_type: 'feishu',
    target_type: 'session',
    target_id: normalizeString(dailyReportConfig.chatId),
    thread_id: '',
    target_label: 'legacy daily_report.chat_id',
    created_by: 'legacy_config',
    source: 'legacy_config',
  };
}

function formatDateTime(value, timeZone = DEFAULT_TIMEZONE) {
  const ts = Number(value || 0);
  if (!Number.isFinite(ts) || ts <= 0) return '未计划';
  return new Date(ts).toLocaleString('zh-CN', {
    timeZone,
    hour12: false,
  });
}

function describeTaskTarget(task) {
  const channel = task.channel_type === 'wecom' ? '企业微信' : '飞书';
  const typeMap = {
    user: '用户',
    session: '会话',
    chat: '群聊',
    thread: '线程',
  };
  const typeLabel = typeMap[task.target_type] || task.target_type;
  const label = normalizeString(task.target_label) || shortId(task.target_id);
  const thread = normalizeString(task.thread_id);
  if (task.target_type === 'thread' && thread) {
    return `${channel} / ${typeLabel} / ${label} / thread=${shortId(thread)}`;
  }
  return `${channel} / ${typeLabel} / ${label}`;
}

function describeTaskType(task) {
  if (normalizeString(task.task_type) === TASK_TYPE_SKILL_RUN) {
    const explicitTitle = normalizeString(task.title);
    if (explicitTitle && explicitTitle !== '技能定时任务') return explicitTitle;
    const skillName = normalizeString(task.skill_ref) || path.basename(path.dirname(normalizeString(task.skill_path) || '/SKILL.md'));
    return skillName ? `技能任务 / $${skillName}` : '技能定时任务';
  }
  return '昨日店铺报告';
}

function formatTaskLine(task) {
  const status = task.enabled ? '已开启' : '已关闭';
  const lastStatus = task.last_status || 'idle';
  const lines = [
    `${task.task_id} [${status}]`,
    `类型：${describeTaskType(task)}`,
    `时间：每天 ${task.schedule_time} (${task.timezone})`,
    `发送到：${describeTaskTarget(task)}`,
  ];
  if (task.task_type === TASK_TYPE_SKILL_RUN) {
    if (normalizeString(task.skill_path)) lines.push(`Skill：${task.skill_path}`);
    if (normalizeString(task.cwd)) lines.push(`工作目录：${task.cwd}`);
    if (normalizeString(task.prompt_text)) lines.push(`要求：${compactText(task.prompt_text, 160)}`);
  }
  lines.push(`下次执行：${formatDateTime(task.next_run_at, task.timezone)}`);
  lines.push(`最近状态：${lastStatus}${task.last_error ? `；错误：${compactText(task.last_error, 80)}` : ''}`);
  return lines.join('\n');
}

function formatTaskList(tasks = []) {
  if (!Array.isArray(tasks) || tasks.length === 0) {
    return '当前没有定时任务。';
  }
  const lines = ['当前定时任务：'];
  tasks.forEach((task, index) => {
    lines.push('');
    lines.push(`${index + 1}. ${formatTaskLine(task)}`);
  });
  return lines.join('\n');
}

function buildCreateConfirmation(task) {
  const lines = [
    `将创建 1 个“${describeTaskType(task)}”任务，请确认：`,
    `时间：每天 ${task.schedule_time} (${task.timezone})`,
    `发送到：${describeTaskTarget(task)}`,
  ];
  if (task.task_type === TASK_TYPE_SKILL_RUN) {
    if (normalizeString(task.skill_path)) lines.push(`Skill：${task.skill_path}`);
    if (normalizeString(task.cwd)) lines.push(`工作目录：${task.cwd}`);
    if (normalizeString(task.prompt_text)) lines.push(`要求：${compactText(task.prompt_text, 200)}`);
  }
  lines.push(`创建人：${task.created_by || '当前用户'}`);
  lines.push('回复“确认”继续，回复“取消”放弃。');
  return lines.join('\n');
}

function isAffirmative(text) {
  return /^(确认|确定|是|好的|好|可以|行|继续|确认创建)$/i.test(normalizeString(text));
}

function isCancelText(text) {
  return /^(取消|不用了|算了|停止创建|别创建了)$/i.test(normalizeString(text));
}

function isExitTaskRoutingText(text) {
  const raw = normalizeString(text);
  if (!raw) return false;
  return /(两个都不是|都不是|不是这个|不是这个意思|不要这个|别匹配这个|停止匹配|退出匹配|退出这个|不用管日报|别管日报|不用管定时任务|这不是在说日报|这不是在说定时任务|没有定时任务要管理|继续刚才|继续原来的|继续执行|继续处理|继续你刚才|你继续|按我刚说的做)/.test(raw);
}

function looksLikeScheduledTaskText(text) {
  const raw = normalizeString(text);
  if (!raw) return false;
  if (parseTaskId(raw)) return true;
  if (hasDailyTaskKeywords(raw)) return true;
  if (maybeReferencesSkill(raw)) return true;
  return /(每天|每日|定时|计划任务|立即执行|重新开启|停掉|停止|关闭|暂停|改成|改到|发送目标|改发|查看任务|有哪些任务)/.test(raw)
    && /(任务|日报|skill|技能|运行|执行|发送|推送)/i.test(raw);
}

function detectIntent(text) {
  const raw = normalizeString(text);
  if (!raw) return '';
  if (/(有哪些|查看|列出|看看|当前).*(定时任务|任务|日报|skill|技能)/i.test(raw)) return 'list';
  if (parseTaskId(raw) && /(现在|马上|立即|立刻|执行一次|跑一次|发一份)/.test(raw)) return 'run_now';
  if (/(现在|马上|立即|立刻).*(发|运行|执行)|执行一次|发一份|跑一次/.test(raw) && (looksLikeScheduledTaskText(raw) || /(这个任务|这个定时任务)/.test(raw))) return 'run_now';
  if ((/(每天|每日|定时)/.test(raw) && /(发|推送|发送|运行|执行|触发|调用)/.test(raw) && (hasDailyTaskKeywords(raw) || maybeReferencesSkill(raw)))) return 'create';
  if (parseTaskId(raw) && /(重新开启|重新打开|恢复|启用|打开)/.test(raw)) return 'enable';
  if (/(重新开启|重新打开|恢复|启用|打开)/.test(raw) && /(日报|任务|skill|技能|这个)/i.test(raw)) return 'enable';
  if (parseTaskId(raw) && /(停掉|停止|关闭|暂停|停用)/.test(raw)) return 'disable';
  if (/(停掉|停止|关闭|暂停|停用)/.test(raw) && /(日报|任务|skill|技能|这个)/i.test(raw)) return 'disable';
  if (parseTaskId(raw) && /(改成|改到|改为|调整到|修改成|时间改成|时间改到)/.test(raw) && parseChineseScheduleTime(raw)) return 'update_time';
  if (/(改成|改到|改为|调整到|修改成|时间改成|时间改到)/.test(raw) && parseChineseScheduleTime(raw)) return 'update_time';
  if (parseTaskId(raw) && (/改发|发送目标|改到|改给|改发给|改发到/.test(raw) || /发到.*(飞书|企业微信|线程|会话|群)/.test(raw))) return 'update_target';
  if ((/改发|发送目标|改到|改给|改发给|改发到/.test(raw) || /发到.*(飞书|企业微信|线程|会话|群)/.test(raw)) && /(日报|任务|skill|技能|这个)/i.test(raw)) return 'update_target';
  return '';
}

function parseTaskId(text) {
  const match = normalizeString(text).match(/\b(?:drt_[a-z0-9_-]+|sjt_[a-z0-9_-]+|legacy_daily_store_report_[a-z0-9_-]+)\b/i);
  return match ? match[0] : '';
}

function buildCurrentUserTarget(context) {
  const senderOpenId = normalizeString(context.senderOpenId);
  if (!senderOpenId) return null;
  return {
    channel_type: 'feishu',
    target_type: 'user',
    target_id: senderOpenId,
    thread_id: '',
    target_label: '当前飞书用户',
  };
}

function buildCurrentSessionTarget(context) {
  const chatID = normalizeString(context.chatID);
  if (!chatID) return null;
  return {
    channel_type: 'feishu',
    target_type: 'session',
    target_id: chatID,
    thread_id: '',
    target_label: '当前飞书会话',
  };
}

function buildCurrentThreadTarget(context) {
  const threadID = normalizeString(context.threadId || context.rootId);
  const chatID = normalizeString(context.chatID);
  if (!threadID || !chatID) return null;
  return {
    channel_type: 'feishu',
    target_type: 'thread',
    target_id: chatID,
    thread_id: threadID,
    target_label: '当前飞书线程',
  };
}

function resolveTargetFromText(text, context, channelRuntime) {
  const raw = normalizeString(text);
  if (!raw) return { target: null, needFollowUp: false };

  if (/(发给我|给我发|发我|给我)/.test(raw)) {
    const currentUser = buildCurrentUserTarget(context);
    return {
      target: currentUser,
      needFollowUp: !currentUser,
      followUp: currentUser ? '' : '我没拿到当前发送人的飞书用户 ID，请在飞书里重新发起，或直接指定目标。',
    };
  }

  if (/(这个|当前)(飞书)?线程/.test(raw)) {
    const currentThread = buildCurrentThreadTarget(context);
    return {
      target: currentThread,
      needFollowUp: !currentThread,
      followUp: currentThread ? '' : '当前这条消息不在飞书线程里，暂时不能直接绑定“这个线程”。你可以改成“这个飞书会话”，或者在目标线程里再发一次。',
    };
  }

  if (/(这个|当前)(飞书)?(会话|聊天|群|对话)|发到这里/.test(raw)) {
    const currentSession = buildCurrentSessionTarget(context);
    return {
      target: currentSession,
      needFollowUp: !currentSession,
      followUp: currentSession ? '' : '我没拿到当前飞书会话 ID，请重新在目标会话里发起。',
    };
  }

  const preferredChannelType = /企业微信/.test(raw) ? 'wecom' : (/飞书/.test(raw) ? 'feishu' : '');
  const matches = getNamedTargetMatches(channelRuntime, raw, { preferredChannelType });
  if (matches.length > 0) {
    const target = matches[0];
    return {
      target: {
        channel_type: target.channelType,
        target_type: target.targetType,
        target_id: target.targetId,
        thread_id: target.threadId,
        target_label: target.label || target.alias,
      },
      needFollowUp: false,
      followUp: '',
    };
  }

  if (/企业微信/.test(raw)) {
    return {
      target: null,
      needFollowUp: true,
      followUp: '我还没在配置里找到这个企业微信发送目标。请先在 `outbound_channels.named_targets.wecom` 里配好别名，再告诉我要发到哪个目标。',
    };
  }

  return {
    target: null,
    needFollowUp: false,
    followUp: '',
  };
}

function buildTargetKey(target = {}) {
  return [
    normalizeChannelType(target.channel_type),
    normalizeTargetType(target.target_type),
    normalizeString(target.target_id),
    normalizeString(target.thread_id),
  ].join('|');
}

function mergeDraftWithText(draft, text, context, channelRuntime, options = {}) {
  const next = { ...asPlainObject(draft) };
  const scheduleTime = parseChineseScheduleTime(text);
  if (scheduleTime) next.schedule_time = scheduleTime;
  if (!next.timezone) next.timezone = DEFAULT_TIMEZONE;

  const targetResult = resolveTargetFromText(text, context, channelRuntime);
  if (targetResult.target) {
    next.channel_type = targetResult.target.channel_type;
    next.target_type = targetResult.target.target_type;
    next.target_id = targetResult.target.target_id;
    next.thread_id = targetResult.target.thread_id;
    next.target_label = targetResult.target.target_label;
  }

  const skillReference = resolveSkillReference(text, { skillsRoot: options.skillsRoot });
  const inferredType = inferTaskTypeFromText(text, skillReference);
  if (inferredType) {
    next.task_type = inferredType;
    next.executor_type = inferredType;
  }
  if (skillReference.skillPath) {
    next.skill_ref = skillReference.skillRef;
    next.skill_path = skillReference.skillPath;
    if (!normalizeString(next.title)) {
      next.title = `技能任务 / $${skillReference.skillRef}`;
    }
  }
  if (next.task_type === TASK_TYPE_DAILY_STORE_REPORT && !normalizeString(next.title)) {
    next.title = '昨日店铺报告';
  }
  if (next.task_type === TASK_TYPE_DAILY_STORE_REPORT && !normalizeString(next.skill_path)) {
    const defaultDailySkill = resolveDefaultDailyReportSkill(options.skillsRoot);
    if (defaultDailySkill) {
      next.task_type = TASK_TYPE_SKILL_RUN;
      next.executor_type = TASK_TYPE_SKILL_RUN;
      next.skill_ref = defaultDailySkill.name;
      next.skill_path = defaultDailySkill.path;
      next.title = '昨日店铺报告';
    }
  }
  if (next.task_type === TASK_TYPE_SKILL_RUN && !normalizeString(next.prompt_text)) {
    next.prompt_text = compactText(normalizeString(text), 1200);
  }
  if (!normalizeString(next.cwd) && normalizeString(options.defaultCwd)) {
    next.cwd = normalizeString(options.defaultCwd);
  }

  return {
    draft: next,
    targetResult,
    skillReference,
  };
}

function collectMissingCreateFields(draft) {
  const missing = [];
  if (!normalizeString(draft.task_type)) missing.push('task_type');
  if (!normalizeString(draft.schedule_time)) missing.push('time');
  if (!normalizeString(draft.channel_type) || !normalizeString(draft.target_id)) missing.push('target');
  if (normalizeString(draft.task_type) === TASK_TYPE_SKILL_RUN && !normalizeString(draft.skill_path)) missing.push('skill');
  return missing;
}

function buildMissingFieldPrompt(missing, draft = {}) {
  if (missing.includes('task_type')) {
    return '你要定时做什么？可以直接说“昨日店铺报告”，或者发 `$skill-name` / `/absolute/path/SKILL.md`。';
  }
  if (missing.includes('skill')) {
    return '要运行哪个 skill？请直接发 `$skill-name`，或者给我 `SKILL.md` 的绝对路径。';
  }
  if (missing.includes('time')) {
    return normalizeString(draft.task_type) === TASK_TYPE_DAILY_STORE_REPORT
      ? '这个日报要每天几点发送？比如“每天早上 8 点”。'
      : '这个定时任务要每天几点运行？比如“每天早上 8 点”。';
  }
  if (missing.includes('target')) {
    return '这个任务要发到哪里？你可以说“给我”“这个飞书会话”“这个线程”，或者配置好的企业微信目标别名。';
  }
  return '还差一点信息，请继续补充。';
}

function selectTaskCandidates(tasks, text, intent, context, channelRuntime, options = {}) {
  let candidates = Array.isArray(tasks) ? tasks.slice() : [];
  const taskId = parseTaskId(text);
  if (taskId) {
    candidates = candidates.filter((task) => task.task_id === taskId);
  }

  const scheduleTime = parseChineseScheduleTime(text);
  if (scheduleTime) {
    candidates = candidates.filter((task) => task.schedule_time === scheduleTime);
  }

  const targetResult = resolveTargetFromText(text, context, channelRuntime);
  if (targetResult.target) {
    const wantedTargetKey = buildTargetKey(targetResult.target);
    candidates = candidates.filter((task) => buildTargetKey(task) === wantedTargetKey);
  }

  const skillReference = resolveSkillReference(text, { skillsRoot: options.skillsRoot });
  if (normalizeString(skillReference.skillPath)) {
    candidates = candidates.filter((task) => {
      return normalizeString(task.skill_path) === skillReference.skillPath
        || normalizeString(task.skill_ref).toLowerCase() === normalizeString(skillReference.skillRef).toLowerCase();
    });
  }

  const inferredType = inferTaskTypeFromText(text, skillReference);
  if (inferredType) {
    candidates = candidates.filter((task) => normalizeString(task.task_type) === inferredType);
  }

  if (intent === 'enable') {
    const disabled = candidates.filter((task) => !task.enabled);
    if (disabled.length > 0) candidates = disabled;
  }
  if (intent === 'disable') {
    const enabled = candidates.filter((task) => task.enabled);
    if (enabled.length > 0) candidates = enabled;
  }
  return candidates;
}

function findTargetTaskOrPrompt(tasks, text, intent, context, channelRuntime, options = {}) {
  const candidates = selectTaskCandidates(tasks, text, intent, context, channelRuntime, options);
  if (candidates.length === 1) {
    return { task: candidates[0], prompt: '' };
  }
  if (candidates.length === 0) {
    if (Array.isArray(tasks) && tasks.length === 1) {
      return { task: tasks[0], prompt: '' };
    }
    return { task: null, prompt: '我没定位到对应的定时任务。你可以先说“我当前有哪些定时任务”，然后带上任务 ID 再操作。' };
  }
  return {
    task: null,
    prompt: [
      '我匹配到了多个定时任务，请回复任务 ID 再继续：',
      ...candidates.map((task) => `${task.task_id}：每天 ${task.schedule_time} -> ${describeTaskType(task)} -> ${describeTaskTarget(task)}`),
    ].join('\n'),
    candidates,
  };
}

function summarizeIntentJudgeTasks(tasks = []) {
  return (Array.isArray(tasks) ? tasks : [])
    .slice(0, 6)
    .map((task) => `${task.task_id} | ${task.enabled ? 'enabled' : 'disabled'} | ${describeTaskType(task)} | ${task.schedule_time} | ${describeTaskTarget(task)}`)
    .join('\n');
}

function normalizeIntentJudgeResult(result, fallbackIntent = '') {
  if (!result || typeof result !== 'object') {
    return {
      shouldHandle: Boolean(fallbackIntent),
      intent: fallbackIntent,
      exitPending: false,
      confidence: fallbackIntent ? 1 : 0,
      source: 'heuristic',
    };
  }

  const normalizedIntent = normalizeString(result.intent || fallbackIntent);
  const shouldHandle = asBool(result.shouldHandle, Boolean(normalizedIntent));
  const exitPending = asBool(result.exitPending, false) || normalizedIntent === 'continue' || normalizedIntent === 'pass_through';
  const confidenceRaw = Number(result.confidence);
  const confidence = Number.isFinite(confidenceRaw)
    ? Math.max(0, Math.min(1, confidenceRaw))
    : (shouldHandle ? 1 : 0);

  return {
    shouldHandle: shouldHandle && !exitPending,
    intent: shouldHandle && !exitPending ? normalizedIntent : '',
    exitPending,
    confidence,
    source: normalizeString(result.source || 'model') || 'model',
  };
}

function formatActionResult(prefix, task) {
  return `${prefix}\n\n${formatTaskLine(task)}`;
}

function ensureStoreConfigReady(reportSourceConfig) {
  ensure(reportSourceConfig?.store?.baseUrl, '日报数据源未配置：daily_report.store.base_url');
  ensure(reportSourceConfig?.store?.email, '日报数据源未配置：daily_report.store.email');
  ensure(reportSourceConfig?.store?.password, '日报数据源未配置：daily_report.store.password');
}

function escapeRegExp(text) {
  return String(text || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function shouldRenderMarkdown(rawText) {
  const text = String(rawText || '').replace(/\r/g, '').trim();
  if (!text) return false;
  if (text.includes('```')) return true;
  if (/`[^`\n]+`/.test(text)) return true;
  if (/\[[^\]]+\]\([^)]+\)/.test(text)) return true;
  if (/(\*\*|__|~~).+?\1/.test(text)) return true;
  const lines = text.split('\n');
  let structuralHits = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (/^#{1,6}\s/.test(trimmed)) return true;
    if (/^>\s+/.test(trimmed)) return true;
    if (/^\s*[-*+]\s+/.test(trimmed)) structuralHits += 1;
    if (/^\s*\d+\.\s+/.test(trimmed)) structuralHits += 1;
  }
  return structuralHits >= 2;
}

function extractFirstJsonObject(rawText) {
  const text = String(rawText || '').trim();
  if (!text) return null;

  const candidates = [];
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch?.[1]) {
    candidates.push(fenceMatch[1].trim());
  }
  candidates.push(text);

  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidates.push(text.slice(firstBrace, lastBrace + 1));
  }

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch (_) {
      // keep trying
    }
  }
  return null;
}

function buildSkillTaskPrompt(task, executionContext = {}) {
  const lines = [
    '你正在执行一个由飞书/企业微信机器人触发的定时任务。',
    '请直接完成任务并输出最终要发送给用户的正文，不要解释内部实现。',
    '默认使用简体中文。',
  ];

  const taskId = normalizeString(task.task_id);
  if (taskId) lines.push(`任务 ID：${taskId}`);

  const accountName = normalizeString(executionContext.accountName);
  if (accountName) lines.push(`当前机器人账号：${accountName}`);

  lines.push(`本次触发方式：${executionContext.manual ? '手动立即执行' : '定时自动执行'}`);
  lines.push(`目标渠道：${normalizeChannelType(task.channel_type || executionContext.channelType || 'feishu')}`);

  const reportDate = normalizeString(executionContext.reportDate);
  if (reportDate) {
    lines.push(`如果任务需要“报告日期”，本次请使用：${reportDate}`);
  }

  const skillRef = normalizeString(task.skill_ref);
  const skillPath = normalizeString(task.skill_path);
  if (skillRef) {
    lines.push(`请优先使用技能 $${skillRef}。`);
  }
  if (skillPath) {
    lines.push(`技能文件路径：${skillPath}`);
  }

  const cwd = normalizeString(task.cwd);
  if (cwd) {
    lines.push(`当前工作目录：${cwd}`);
  }

  if (normalizeString(task.prompt_text)) {
    lines.push('');
    lines.push('用户在创建该定时任务时的原始要求：');
    lines.push(task.prompt_text);
    lines.push('注意：里面可能包含“几点执行”“发到哪里”这类调度描述，请忽略调度描述，只完成真正的业务任务。');
  } else {
    lines.push('');
    lines.push('请运行该 skill 的默认流程，并给出简洁明确的结果。');
  }

  lines.push('');
  lines.push('如果你要返回结构化消息，可以输出单行 JSON：{"message_type":"text|markdown","content":"..."}。');
  lines.push('否则直接输出最终正文。');
  return lines.join('\n');
}

function parseScheduledSkillReply(rawReply, channelType = 'feishu') {
  const parsed = extractFirstJsonObject(rawReply);
  if (parsed && typeof parsed === 'object') {
    const messageType = normalizeString(parsed.message_type || parsed.messageType).toLowerCase();
    const content = parsed.content;
    if ((messageType === 'text' || messageType === 'markdown') && normalizeString(content)) {
      return {
        messageType,
        content: String(content),
      };
    }
    if (messageType === 'card' && normalizeChannelType(channelType) === 'feishu' && content && typeof content === 'object') {
      return {
        messageType: 'card',
        content,
      };
    }
  }

  const text = String(rawReply || '').replace(/\r/g, '').trim();
  ensure(text, 'scheduled skill returned empty reply');
  return {
    messageType: shouldRenderMarkdown(text) ? 'markdown' : 'text',
    content: text,
  };
}

function createScheduledJobManager({
  accountName,
  runtimeDir,
  config = {},
  codex = {},
  skillsRoot = '',
  feishuDomain = 'feishu',
  feishuCreds = {},
  intentJudge = null,
  isTargetBusy = null,
  busyRetryDelayMs = 30 * 1000,
  log = () => {},
  skillTaskExecutor = null,
  messageSender = null,
}) {
  const reportSourceConfig = resolveDailyStoreReportConfig(config, accountName);
  const channelRuntime = createMessageChannelRuntime(config, {
    feishuDomain,
    feishuCreds,
  });
  const resolvedSkillsRoot = normalizeString(skillsRoot) || DEFAULT_SKILLS_ROOT;
  const legacyTask = buildLegacyTask(reportSourceConfig, accountName);
  const storePath = taskStorePath(runtimeDir, accountName);
  const fallbackStorePath = legacyTaskStorePath(runtimeDir, accountName);
  let store = normalizeTaskStore(readTaskStore(storePath, fallbackStorePath), legacyTask);
  const pendingByScope = new Map();
  const runningTasks = new Set();
  let timer = null;

  function maybeUpgradeManagedDailyReportTasks() {
    refreshStore();
    const defaultDailySkill = resolveDefaultDailyReportSkill(resolvedSkillsRoot);
    if (!defaultDailySkill) return store.tasks.slice();
    let changed = false;
    const nextTasks = store.tasks.map((task) => {
      if (task.task_type !== TASK_TYPE_DAILY_STORE_REPORT) return task;
      if (isLegacyDailyReportTask(task)) return task;
      changed = true;
      return normalizeTask({
        ...task,
        task_type: TASK_TYPE_SKILL_RUN,
        executor_type: TASK_TYPE_SKILL_RUN,
        title: normalizeString(task.title) || '昨日店铺报告',
        skill_ref: defaultDailySkill.name,
        skill_path: defaultDailySkill.path,
        prompt_text: normalizeString(task.prompt_text) || '生成昨日店铺报告，并输出适合当前渠道直接发送给用户的最终内容。',
        updated_at: nowIso(),
      });
    });
    if (changed) {
      store = normalizeTaskStore({
        ...store,
        tasks: nextTasks,
      }, legacyTask);
      persistStore();
    }
    return store.tasks.slice();
  }

  function persistStore() {
    store.updated_at = nowIso();
    writeTaskStore(storePath, store);
  }

  function refreshStore() {
    store = normalizeTaskStore(readTaskStore(storePath, fallbackStorePath), legacyTask);
    return store;
  }

  function getPendingState(scopeKey) {
    const key = normalizeString(scopeKey);
    if (!key) return null;
    return pendingByScope.get(key) || null;
  }

  function clearPendingState(scopeKey) {
    const key = normalizeString(scopeKey);
    if (!key) return;
    pendingByScope.delete(key);
  }

  function listTasks() {
    refreshStore();
    return store.tasks.slice();
  }

  function getTaskById(taskId) {
    refreshStore();
    return store.tasks.find((task) => task.task_id === taskId) || null;
  }

  function upsertTask(task) {
    const normalized = normalizeTask(task);
    const idx = store.tasks.findIndex((item) => item.task_id === normalized.task_id);
    if (idx >= 0) store.tasks[idx] = normalized;
    else store.tasks.push(normalized);
    store.tasks = normalizeTaskStore(store, legacyTask).tasks;
    persistStore();
    return normalized;
  }

  function createTask(input) {
    const nextTask = normalizeTask({
      ...input,
      created_at: nowIso(),
      updated_at: nowIso(),
      last_status: 'created',
      source: 'managed',
    });
    return upsertTask(nextTask);
  }

  function updateTask(taskId, patch) {
    const current = getTaskById(taskId);
    ensure(current, `task not found: ${taskId}`);
    return upsertTask({
      ...current,
      ...patch,
      updated_at: nowIso(),
      next_run_at: patch.next_run_at || computeNextRunAt({ ...current, ...patch }),
    });
  }

  function realignTasksOnStart(now = new Date()) {
    refreshStore();
    const nowMs = now instanceof Date ? now.getTime() : Date.now();
    let changed = false;
    const nextTasks = store.tasks.map((task) => {
      if (!task.enabled) return task;
      if (Number(task.retry_after_at || 0) > nowMs) return task;
      if (Number(task.next_run_at || 0) > nowMs) return task;
      changed = true;
      return normalizeTask({
        ...task,
        retry_after_at: 0,
        retry_count: 0,
        next_run_at: computeNextRunAt(task, now),
        updated_at: nowIso(),
        last_status: task.last_status === 'retrying' || task.last_status === 'waiting_for_idle'
          ? 'scheduled'
          : task.last_status,
      });
    });

    if (changed || !fs.existsSync(storePath)) {
      store = normalizeTaskStore({
        ...store,
        tasks: nextTasks,
      }, legacyTask);
      persistStore();
    }
    return store.tasks.slice();
  }

  function shouldDeferBecauseBusy(task) {
    if (normalizeBusyPolicy(task.busy_policy) === 'run_immediately') return false;
    if (typeof isTargetBusy !== 'function') return false;
    try {
      return Boolean(isTargetBusy(task));
    } catch (err) {
      log(`scheduled_job=busy_check_error account=${accountName} task_id=${task.task_id} message=${compactText(err.message, 160)}`);
      return false;
    }
  }

  async function judgeHandlingIntent(raw, pending, context) {
    const fallbackIntent = detectIntent(raw);
    if (isExitTaskRoutingText(raw)) {
      return {
        shouldHandle: false,
        intent: '',
        exitPending: true,
        confidence: 1,
        source: 'rule',
      };
    }

    const shouldUseJudge = Boolean(intentJudge)
      && (
        Boolean(pending)
        || looksLikeScheduledTaskText(raw)
      );

    if (!shouldUseJudge) {
      return {
        shouldHandle: Boolean(fallbackIntent),
        intent: fallbackIntent,
        exitPending: false,
        confidence: fallbackIntent ? 1 : 0,
        source: 'heuristic',
      };
    }

    try {
      const judged = await intentJudge({
        accountName,
        text: raw,
        context,
        pending: pending
          ? {
            kind: pending.kind,
            intent: pending.intent,
            resume_text: pending.resume_text || '',
            candidates: Array.isArray(pending.candidates)
              ? pending.candidates.map((task) => ({
                task_id: task.task_id,
                task_type: task.task_type,
                schedule_time: task.schedule_time,
                enabled: task.enabled,
                title: describeTaskType(task),
                target: describeTaskTarget(task),
              }))
              : [],
          }
          : null,
        tasksSummary: summarizeIntentJudgeTasks(listTasks()),
        supportedIntents: ['create', 'list', 'run_now', 'enable', 'disable', 'update_time', 'update_target'],
      });
      return normalizeIntentJudgeResult(judged, fallbackIntent);
    } catch (err) {
      log(`scheduled_job=intent_judge_error account=${accountName} message=${compactText(err.message, 160)}`);
      return {
        shouldHandle: Boolean(fallbackIntent),
        intent: fallbackIntent,
        exitPending: false,
        confidence: fallbackIntent ? 1 : 0,
        source: 'heuristic_fallback',
      };
    }
  }

  async function buildDailyReportContent(task, reportDate) {
    ensureStoreConfigReady(reportSourceConfig);
    const report = await buildDailyStoreReport(
      {
        ...reportSourceConfig,
        timeZone: normalizeString(task.timezone || reportSourceConfig.timeZone || DEFAULT_TIMEZONE) || DEFAULT_TIMEZONE,
      },
      reportDate
    );
    if (normalizeChannelType(task.channel_type) === 'wecom') {
      return {
        messageType: 'markdown',
        content: renderDailyStoreReportMarkdown(report, { channelType: 'wecom' }),
      };
    }
    return {
      messageType: 'card',
      content: renderDailyStoreReportFeishuCard(report),
      fallbackText: renderDailyStoreReportText(report),
    };
  }

  async function runSkillTask(taskLike, options = {}) {
    if (typeof skillTaskExecutor === 'function') {
      return skillTaskExecutor(taskLike, {
        codex,
        channelRuntime,
        skillsRoot: resolvedSkillsRoot,
        executionContext: {
          accountName,
          channelType: taskLike.channel_type,
          manual: Boolean(options.manual),
          reportDate: normalizeString(options.reportDate),
        },
      });
    }

    ensure(normalizeString(taskLike.skill_path || taskLike.skill_ref), 'skill task missing skill reference');
    ensure(normalizeString(codex.bin), 'codex task executor not configured');
    const reply = await runCodexExec({
      bin: codex.bin,
      model: codex.model,
      reasoningEffort: codex.reasoningEffort,
      profile: codex.profile,
      cwd: normalizeString(taskLike.cwd) || codex.cwd,
      addDirs: codex.addDirs || [],
      sandbox: codex.sandbox,
      approvalPolicy: codex.approvalPolicy,
      apiKey: codex.apiKey,
      prompt: buildSkillTaskPrompt(taskLike, {
        accountName,
        channelType: taskLike.channel_type,
        manual: Boolean(options.manual),
        reportDate: normalizeString(options.reportDate),
      }),
      resumeSessionId: '',
    });
    return parseScheduledSkillReply(reply?.reply || '', taskLike.channel_type);
  }

  async function buildDeliveryPayload(taskLike, options = {}) {
    if (normalizeString(taskLike.task_type) === TASK_TYPE_SKILL_RUN) {
      return runSkillTask(taskLike, options);
    }

    const today = buildYmd(new Date(), taskLike.timezone);
    const reportDate = normalizeString(options.reportDate) || addDaysYmd(today, -1);
    return buildDailyReportContent(taskLike, reportDate);
  }

  async function deliverTaskLike(taskLike, options = {}) {
    const payload = await buildDeliveryPayload(taskLike, options);
    const request = {
      channelType: taskLike.channel_type,
      targetType: taskLike.target_type,
      targetId: taskLike.target_id,
      threadId: taskLike.thread_id,
      messageType: payload.messageType || 'text',
      content: payload.content,
    };
    const receipt = typeof messageSender === 'function'
      ? await messageSender(request, { task: taskLike, payload, channelRuntime })
      : await sendUnifiedMessage(channelRuntime, request);
    return {
      payload,
      receipt,
    };
  }

  async function executeTask(taskId, options = {}) {
    const task = getTaskById(taskId);
    ensure(task, `task not found: ${taskId}`);
    if (runningTasks.has(taskId)) {
      return {
        ok: false,
        status: 'running',
        task,
      };
    }

    const manual = Boolean(options.manual);
    const now = new Date();
    const today = buildYmd(now, task.timezone);
    const reportDate = normalizeString(options.reportDate) || addDaysYmd(today, -1);
    if (!manual && normalizeString(task.last_auto_run_key) === today) {
      log(`scheduled_job=skip_duplicate account=${accountName} task_id=${taskId} run_key=${today} reason=already_sent`);
      return {
        ok: true,
        status: 'already_sent',
        task,
      };
    }
    const autoRunLock = manual ? null : acquireAutoRunLock(runtimeDir, accountName, taskId, today);
    if (!manual && !autoRunLock.acquired) {
      log(`scheduled_job=skip_duplicate account=${accountName} task_id=${taskId} run_key=${today} reason=${autoRunLock.reason || 'locked'}`);
      return {
        ok: true,
        status: 'already_sent',
        task,
      };
    }
    runningTasks.add(taskId);
    log(`scheduled_job=run account=${accountName} task_id=${taskId} task_type=${task.task_type} manual=${manual ? 'true' : 'false'} report_date=${reportDate}`);
    let deliveredSuccessfully = false;

    try {
      const delivered = await deliverTaskLike(task, {
        ...options,
        reportDate,
      });
      deliveredSuccessfully = true;
      const receiptId = Array.isArray(delivered?.receipt?.messageIds) ? normalizeString(delivered.receipt.messageIds[0]) : '';
      if (!manual) {
        markAutoRunLockSent(autoRunLock, receiptId);
      }
      const nextTask = {
        ...task,
        updated_at: nowIso(),
        last_run_at: nowIso(),
        last_status: manual ? 'manual_sent' : 'sent',
        last_error: '',
        last_error_at: '',
        last_receipt_id: receiptId,
        retry_after_at: 0,
        retry_count: 0,
        next_run_at: computeNextRunAt(task, now),
      };
      if (manual) {
        nextTask.last_manual_run_at = nextTask.last_run_at;
      } else {
        nextTask.last_auto_run_key = today;
        nextTask.last_auto_exhausted_key = '';
      }
      const updated = upsertTask(nextTask);
      log(`scheduled_job=sent account=${accountName} task_id=${taskId} task_type=${updated.task_type} channel=${updated.channel_type} target=${updated.target_type}:${shortId(updated.target_id)}`);
      return {
        ok: true,
        status: updated.last_status,
        task: updated,
      };
    } catch (err) {
      if (!manual && !deliveredSuccessfully) {
        releaseAutoRunLock(autoRunLock);
      }
      const retryCount = manual ? 0 : Number(task.retry_count || 0) + 1;
      const retryDelay = RETRY_DELAYS_MS[Math.min(retryCount - 1, RETRY_DELAYS_MS.length - 1)] || 0;
      const exhausted = !manual && retryCount >= RETRY_DELAYS_MS.length;
      const nextTask = {
        ...task,
        updated_at: nowIso(),
        last_status: exhausted ? 'error' : (manual ? 'manual_error' : 'retrying'),
        last_error: normalizeString(err.message || String(err)),
        last_error_at: nowIso(),
        retry_count: manual ? 0 : retryCount,
        retry_after_at: exhausted || manual ? 0 : Date.now() + retryDelay,
        next_run_at: exhausted || manual ? computeNextRunAt(task, now) : Date.now() + retryDelay,
      };
      if (manual) {
        nextTask.last_manual_run_at = nowIso();
      } else if (exhausted) {
        nextTask.last_auto_exhausted_key = today;
      }
      const updated = upsertTask(nextTask);
      log(`scheduled_job=error account=${accountName} task_id=${taskId} task_type=${task.task_type} exhausted=${exhausted ? 'true' : 'false'} message=${compactText(err.message, 200)}`);
      return {
        ok: false,
        status: updated.last_status,
        error: err,
        task: updated,
      };
    } finally {
      runningTasks.delete(taskId);
    }
  }

  async function executeOneOff(taskInput, options = {}) {
    const tempTask = normalizeTask({
      task_id: normalizeString(taskInput.task_type) === TASK_TYPE_SKILL_RUN
        ? `adhoc_skill_${randomBytes(4).toString('hex')}`
        : `adhoc_daily_${randomBytes(4).toString('hex')}`,
      schedule_time: normalizeScheduleTime(taskInput.schedule_time || DEFAULT_SCHEDULE),
      timezone: taskInput.timezone || DEFAULT_TIMEZONE,
      channel_type: taskInput.channel_type,
      target_type: taskInput.target_type,
      target_id: taskInput.target_id,
      thread_id: taskInput.thread_id,
      target_label: taskInput.target_label,
      created_by: options.createdBy || '',
      enabled: false,
      task_type: taskInput.task_type || DEFAULT_TASK_TYPE,
      executor_type: taskInput.task_type || DEFAULT_TASK_TYPE,
      title: taskInput.title,
      skill_ref: taskInput.skill_ref,
      skill_path: taskInput.skill_path,
      prompt_text: taskInput.prompt_text,
      cwd: taskInput.cwd || codex.cwd,
    });
    const today = buildYmd(new Date(), tempTask.timezone);
    const reportDate = addDaysYmd(today, -1);
    log(`scheduled_job=adhoc account=${accountName} task_type=${tempTask.task_type} channel=${tempTask.channel_type} target=${tempTask.target_type}:${shortId(tempTask.target_id)}`);
    await deliverTaskLike(tempTask, {
      ...options,
      reportDate,
    });
    return tempTask;
  }

  async function tick() {
    refreshStore();
    const nowMs = Date.now();
    for (const task of store.tasks) {
      if (!task.enabled) continue;
      if (runningTasks.has(task.task_id)) continue;
      if (Number(task.retry_after_at || 0) > nowMs) continue;
      if (Number(task.next_run_at || 0) > nowMs) continue;
      if (shouldDeferBecauseBusy(task)) {
        const deferredUntil = nowMs + Math.max(15 * 1000, Number(busyRetryDelayMs) || 30 * 1000);
        if (
          normalizeString(task.last_status) !== 'waiting_for_idle'
          || Number(task.next_run_at || 0) !== deferredUntil
        ) {
          updateTask(task.task_id, {
            last_status: 'waiting_for_idle',
            next_run_at: deferredUntil,
            retry_after_at: 0,
          });
          log(`scheduled_job=deferred account=${accountName} task_id=${task.task_id} reason=busy_target until=${new Date(deferredUntil).toISOString()}`);
        }
        continue;
      }
      await executeTask(task.task_id, { manual: false });
    }
  }

  function start() {
    if (timer) return;
    maybeUpgradeManagedDailyReportTasks();
    realignTasksOnStart();
    if (legacyTask && store.tasks.some((task) => isLegacyDailyReportTask(task))) {
      persistStore();
    }
    void tick().catch((err) => {
      log(`scheduled_job=tick_error account=${accountName} message=${compactText(err.message, 200)}`);
    });
    timer = setInterval(() => {
      void tick().catch((err) => {
        log(`scheduled_job=tick_error account=${accountName} message=${compactText(err.message, 200)}`);
      });
    }, 30 * 1000);
  }

  function stop() {
    if (!timer) return;
    clearInterval(timer);
    timer = null;
  }

  async function handleUserText(text, context = {}) {
    const rawInput = normalizeString(text);
    const scopeKey = normalizeString(context.scopeKey || context.chatID || 'default') || 'default';
    const originalPending = getPendingState(scopeKey);
    const timeCommand = parseTimeCommand(rawInput);
    const raw = originalPending ? rawInput : (timeCommand.matched ? timeCommand.body : rawInput);
    const nextIntent = detectIntent(raw);

    if (originalPending && isCancelText(raw)) {
      clearPendingState(scopeKey);
      return { handled: true, reply: '已取消当前定时任务操作。' };
    }

    if (originalPending && originalPending.kind === 'confirm_create' && isAffirmative(raw)) {
      const created = createTask(originalPending.draft);
      clearPendingState(scopeKey);
      return {
        handled: true,
        reply: formatActionResult('定时任务已创建。', created),
      };
    }

    if (originalPending && originalPending.kind === 'pick_task') {
      const chosenTaskId = parseTaskId(raw) || (() => {
        const match = raw.match(/^\s*(\d+)\s*$/);
        if (!match) return '';
        const index = Number.parseInt(match[1], 10) - 1;
        const candidate = originalPending.candidates[index];
        return candidate ? candidate.task_id : '';
      })();
      if (chosenTaskId) {
        clearPendingState(scopeKey);
        const currentText = `${originalPending.intent} ${chosenTaskId}`;
        return handleUserText(currentText, context);
      }
    }

    const routingDecision = await judgeHandlingIntent(raw, originalPending, context);
    const shouldKeepPendingAsFollowUp = Boolean(
      originalPending
      && raw
      && !isExitTaskRoutingText(raw)
      && ['collect_create', 'confirm_create', 'pick_task'].includes(originalPending.kind)
    );
    if (
      originalPending
      && (
        routingDecision.exitPending
        || (routingDecision.source === 'model' && !routingDecision.shouldHandle)
        || (!routingDecision.shouldHandle && !nextIntent)
      )
      && !shouldKeepPendingAsFollowUp
    ) {
      clearPendingState(scopeKey);
      return {
        handled: false,
        reply: '',
        passthroughText: isExitTaskRoutingText(raw)
          ? (normalizeString(originalPending.resume_text) || raw)
          : raw,
      };
    }

    if (!originalPending && !timeCommand.matched) {
      return { handled: false, reply: '', passthroughText: rawInput };
    }

    if (!originalPending && !routingDecision.shouldHandle) {
      return { handled: false, reply: '', passthroughText: raw };
    }

    if (
      originalPending
      && nextIntent
      && !(originalPending.kind === 'collect_create' && nextIntent === 'create')
      && !(originalPending.kind === 'confirm_create' && isAffirmative(raw))
    ) {
      clearPendingState(scopeKey);
    }

    const pending = getPendingState(scopeKey);
    const intent = normalizeString(routingDecision.intent || nextIntent);

    if (pending && pending.kind === 'confirm_create') {
      if (isAffirmative(raw)) {
        const created = createTask(pending.draft);
        clearPendingState(scopeKey);
        return {
          handled: true,
          reply: formatActionResult('定时任务已创建。', created),
        };
      }
      if (raw) {
        const merged = mergeDraftWithText(pending.draft, raw, context, channelRuntime, {
          skillsRoot: resolvedSkillsRoot,
          defaultCwd: codex.cwd,
        });
        const missing = collectMissingCreateFields(merged.draft);
        if (missing.length > 0) {
          pendingByScope.set(scopeKey, {
            kind: 'collect_create',
            draft: merged.draft,
            resume_text: pending.resume_text || raw,
          });
          return {
            handled: true,
            reply: merged.targetResult.needFollowUp ? merged.targetResult.followUp : buildMissingFieldPrompt(missing, merged.draft),
          };
        }
        pendingByScope.set(scopeKey, {
          kind: 'confirm_create',
          draft: merged.draft,
          resume_text: pending.resume_text || raw,
        });
        return {
          handled: true,
          reply: buildCreateConfirmation(merged.draft),
        };
      }
    }

    if (pending && pending.kind === 'collect_create') {
      const merged = mergeDraftWithText(pending.draft, raw, context, channelRuntime, {
        skillsRoot: resolvedSkillsRoot,
        defaultCwd: codex.cwd,
      });
      const missing = collectMissingCreateFields(merged.draft);
      if (missing.length > 0) {
        pendingByScope.set(scopeKey, {
          kind: 'collect_create',
          draft: merged.draft,
          resume_text: pending.resume_text || raw,
        });
        return {
          handled: true,
          reply: merged.targetResult.needFollowUp ? merged.targetResult.followUp : buildMissingFieldPrompt(missing, merged.draft),
        };
      }
      pendingByScope.set(scopeKey, {
        kind: 'confirm_create',
        draft: merged.draft,
        resume_text: pending.resume_text || raw,
      });
      return {
        handled: true,
        reply: buildCreateConfirmation(merged.draft),
      };
    }

    if (pending && pending.kind === 'pick_task') {
      const chosenTaskId = parseTaskId(raw) || (() => {
        const match = raw.match(/^\s*(\d+)\s*$/);
        if (!match) return '';
        const index = Number.parseInt(match[1], 10) - 1;
        const candidate = pending.candidates[index];
        return candidate ? candidate.task_id : '';
      })();
      if (!chosenTaskId) {
        return {
          handled: true,
          reply: '请直接回复任务 ID，或者回复列表里的序号。',
        };
      }
      clearPendingState(scopeKey);
      const currentText = `${pending.intent} ${chosenTaskId}`;
      return handleUserText(currentText, context);
    }

    if (!intent || !looksLikeScheduledTaskText(raw)) {
      return { handled: false, reply: '' };
    }

    if (intent === 'list') {
      return {
        handled: true,
        reply: formatTaskList(listTasks()),
      };
    }

    if (intent === 'create') {
      const merged = mergeDraftWithText(
        {
          timezone: DEFAULT_TIMEZONE,
          created_by: normalizeString(context.createdBy || context.senderOpenId || ''),
          cwd: codex.cwd,
        },
        raw,
        context,
        channelRuntime,
        {
          skillsRoot: resolvedSkillsRoot,
          defaultCwd: codex.cwd,
        }
      );
      const missing = collectMissingCreateFields(merged.draft);
      if (missing.length > 0) {
        pendingByScope.set(scopeKey, {
          kind: 'collect_create',
          draft: merged.draft,
          resume_text: raw,
        });
        return {
          handled: true,
          reply: merged.targetResult.needFollowUp ? merged.targetResult.followUp : buildMissingFieldPrompt(missing, merged.draft),
        };
      }
      pendingByScope.set(scopeKey, {
        kind: 'confirm_create',
        draft: merged.draft,
        resume_text: raw,
      });
      return {
        handled: true,
        reply: buildCreateConfirmation(merged.draft),
      };
    }

    if (intent === 'run_now') {
      const tasks = listTasks();
      const matched = findTargetTaskOrPrompt(tasks, raw, intent, context, channelRuntime, {
        skillsRoot: resolvedSkillsRoot,
      });
      if (matched.task) {
        const result = await executeTask(matched.task.task_id, { manual: true });
        if (result.ok) {
          return {
            handled: true,
            reply: formatActionResult('已立即执行一次定时任务。', result.task),
          };
        }
        return {
          handled: true,
          reply: `立即执行失败：${compactText(result.error?.message || result.task?.last_error || 'unknown error', 200)}`,
        };
      }

      const merged = mergeDraftWithText(
        {
          timezone: DEFAULT_TIMEZONE,
          created_by: normalizeString(context.createdBy || context.senderOpenId || ''),
          cwd: codex.cwd,
        },
        raw,
        context,
        channelRuntime,
        {
          skillsRoot: resolvedSkillsRoot,
          defaultCwd: codex.cwd,
        }
      );
      if (!normalizeString(merged.draft.channel_type) || !normalizeString(merged.draft.target_id)) {
        const currentSession = buildCurrentSessionTarget(context);
        if (currentSession) {
          merged.draft.channel_type = currentSession.channel_type;
          merged.draft.target_type = currentSession.target_type;
          merged.draft.target_id = currentSession.target_id;
          merged.draft.thread_id = currentSession.thread_id;
          merged.draft.target_label = currentSession.target_label;
        }
      }
      const missing = collectMissingCreateFields(merged.draft).filter((item) => item !== 'time');
      if (missing.length > 0) {
        return {
          handled: true,
          reply: merged.targetResult.needFollowUp ? merged.targetResult.followUp : buildMissingFieldPrompt(missing, merged.draft),
        };
      }
      try {
        const executedTask = await executeOneOff(merged.draft, {
          createdBy: normalizeString(context.createdBy || context.senderOpenId || ''),
        });
        return {
          handled: true,
          reply: `已立即执行 1 次：${describeTaskType(executedTask)}，发送到 ${describeTaskTarget(executedTask)}。`,
        };
      } catch (err) {
        return {
          handled: true,
          reply: `立即执行失败：${compactText(err.message, 200)}`,
        };
      }
    }

    const tasks = listTasks();
    const matched = findTargetTaskOrPrompt(tasks, raw, intent, context, channelRuntime, {
      skillsRoot: resolvedSkillsRoot,
    });
    if (!matched.task) {
      if (Array.isArray(matched.candidates) && matched.candidates.length > 1) {
        pendingByScope.set(scopeKey, {
          kind: 'pick_task',
          intent,
          candidates: matched.candidates,
          resume_text: raw,
        });
      }
      return {
        handled: true,
        reply: matched.prompt,
      };
    }

    if (intent === 'disable') {
      const updated = updateTask(matched.task.task_id, {
        enabled: false,
        last_status: 'disabled',
      });
      return {
        handled: true,
        reply: formatActionResult('定时任务已关闭。', updated),
      };
    }

    if (intent === 'enable') {
      const updated = updateTask(matched.task.task_id, {
        enabled: true,
        last_status: 'enabled',
        next_run_at: computeNextRunAt(matched.task),
        last_auto_exhausted_key: '',
      });
      return {
        handled: true,
        reply: formatActionResult('定时任务已重新开启。', updated),
      };
    }

    if (intent === 'update_time') {
      const scheduleTime = parseChineseScheduleTime(raw);
      if (!scheduleTime) {
        return {
          handled: true,
          reply: '我没识别出新的执行时间。你可以说“把这个任务改成早上 9 点”。',
        };
      }
      const updated = updateTask(matched.task.task_id, {
        schedule_time: scheduleTime,
        last_status: 'time_updated',
      });
      return {
        handled: true,
        reply: formatActionResult('定时任务时间已更新。', updated),
      };
    }

    if (intent === 'update_target') {
      const targetResult = resolveTargetFromText(raw, context, channelRuntime);
      if (!targetResult.target) {
        return {
          handled: true,
          reply: targetResult.followUp || '我没识别出新的发送目标。你可以说“改发到这个飞书会话”或“改发到企业微信客服群”。',
        };
      }
      const updated = updateTask(matched.task.task_id, {
        channel_type: targetResult.target.channel_type,
        target_type: targetResult.target.target_type,
        target_id: targetResult.target.target_id,
        thread_id: targetResult.target.thread_id,
        target_label: targetResult.target.target_label,
        last_status: 'target_updated',
      });
      return {
        handled: true,
        reply: formatActionResult('定时任务发送目标已更新。', updated),
      };
    }

    return { handled: false, reply: '' };
  }

  return {
    channelRuntime,
    getSkillsRoot: () => resolvedSkillsRoot,
    getStorePath: () => storePath,
    listTasks,
    getTaskById,
    createTask,
    updateTask,
    executeTask,
    executeOneOff,
    handleUserText,
    hasPendingScope: (scopeKey) => Boolean(getPendingState(scopeKey)),
    shouldQueueMessage(text, context = {}) {
      const raw = normalizeString(text);
      const scopeKey = normalizeString(context.scopeKey || context.chatID || 'default') || 'default';
      if (getPendingState(scopeKey)) return true;
      return parseTimeCommand(raw).matched;
    },
    start,
    stop,
  };
}

module.exports = {
  createDailyReportTaskManager: createScheduledJobManager,
  createScheduledJobManager,
  formatTaskList,
  taskStorePath,
};
