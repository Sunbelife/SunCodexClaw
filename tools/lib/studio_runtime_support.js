const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { mergeTalkNormalPrompt } = require('./talk_normal_prompt');

let lark = null;
try {
  lark = require('@larksuiteoapi/node-sdk');
} catch (_) {
  lark = null;
}

const DEFAULT_CODEX_SYSTEM_PROMPT = [
  '你是“飞书 Codex 助手”，通过飞书和用户交流。',
  '请直接回答用户问题，不要复述用户原话。',
].join('\n');

const FEISHU_TEXT_CHUNK_LIMIT = 4000;

function ensure(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function asPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value;
}

function normalizeString(value) {
  return String(value || '').trim();
}

function normalizeStringList(value) {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeString(item)).filter(Boolean);
  }
  return String(value || '')
    .split(/[\r\n,]/)
    .map((item) => normalizeString(item))
    .filter(Boolean);
}

function asInt(value, fallback, min, max) {
  const raw = Number(value);
  if (!Number.isFinite(raw)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(raw)));
}

function compactText(value, maxLength = 320) {
  const text = normalizeString(value).replace(/\s+/g, ' ');
  if (!text) return '';
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 3))}...`;
}

function readTextFileIfExists(filePath) {
  const target = normalizeString(filePath);
  if (!target) return '';
  try {
    return fs.readFileSync(target, 'utf8');
  } catch (_) {
    return '';
  }
}

function writeTextFileIfChanged(filePath, nextContent) {
  const target = normalizeString(filePath);
  if (!target) return false;
  const normalizedNext = String(nextContent || '');
  const previous = readTextFileIfExists(target);
  if (previous === normalizedNext) return false;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, normalizedNext, 'utf8');
  return true;
}

function readCodexAuthSummary(codexHome = '') {
  const resolvedHome = normalizeString(codexHome)
    ? path.resolve(codexHome)
    : path.join(os.homedir(), '.codex');
  const authPath = path.join(resolvedHome, 'auth.json');
  const authText = readTextFileIfExists(authPath);
  const summary = {
    home: resolvedHome,
    authPath,
    exists: Boolean(authText),
    authMode: '',
    openaiApiKey: '',
    hasTokens: false,
  };
  if (!authText) return summary;

  try {
    const parsed = JSON.parse(authText);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return summary;
    summary.authMode = normalizeString(parsed.auth_mode);
    summary.openaiApiKey = normalizeString(parsed.OPENAI_API_KEY);
    summary.hasTokens = Boolean(parsed.tokens && typeof parsed.tokens === 'object');
  } catch (_) {
    return summary;
  }
  return summary;
}

function escapeRegExp(rawText) {
  return String(rawText || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseSimpleTomlValue(rawValue) {
  const text = String(rawValue || '').trim();
  if (!text) return '';
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    return text.slice(1, -1);
  }
  return text;
}

function readCodexHomeConfigSummary(codexHome = '') {
  const resolvedHome = normalizeString(codexHome)
    ? path.resolve(codexHome)
    : path.join(os.homedir(), '.codex');
  const configPath = path.join(resolvedHome, 'config.toml');
  const configText = readTextFileIfExists(configPath);
  const summary = {
    home: resolvedHome,
    configPath,
    exists: Boolean(configText),
    modelProvider: '',
    providerName: '',
    providerBaseUrl: '',
  };
  if (!configText) return summary;

  const providerMatch = configText.match(/^\s*model_provider\s*=\s*(.+)\s*$/m);
  summary.modelProvider = parseSimpleTomlValue(providerMatch?.[1] || '');
  if (!summary.modelProvider) return summary;

  const providerPattern = new RegExp(
    `^\\s*\\[model_providers\\.${escapeRegExp(summary.modelProvider)}\\]\\s*$([\\s\\S]*?)(?=^\\s*\\[[^\\]]+\\]\\s*$|$)`,
    'm'
  );
  const sectionMatch = configText.match(providerPattern);
  const sectionText = sectionMatch?.[1] || '';
  if (!sectionText) return summary;

  const providerNameMatch = sectionText.match(/^\s*name\s*=\s*(.+)\s*$/m);
  const providerBaseUrlMatch = sectionText.match(/^\s*base_url\s*=\s*(.+)\s*$/m);
  summary.providerName = parseSimpleTomlValue(providerNameMatch?.[1] || '');
  summary.providerBaseUrl = parseSimpleTomlValue(providerBaseUrlMatch?.[1] || '');
  return summary;
}

function deriveCodexRuntimeProvider(codex = {}) {
  const homeSummary = readCodexHomeConfigSummary(codex.home || process.env.CODEX_HOME || path.join(os.homedir(), '.codex'));
  const provider = homeSummary.modelProvider || normalizeString(process.env.FEISHU_CODEX_PROVIDER || process.env.CODEX_MODEL_PROVIDER);
  const providerName = homeSummary.providerName || provider;
  return {
    provider,
    providerName,
    providerBaseUrl: homeSummary.providerBaseUrl,
    codexHome: homeSummary.home,
    configPath: homeSummary.configPath,
  };
}

function selectCodexApiKey(codex = {}) {
  const runtimeProvider = deriveCodexRuntimeProvider(codex);
  const provider = normalizeString(runtimeProvider.provider).toLowerCase();
  const primaryAuth = readCodexAuthSummary(runtimeProvider.codexHome || codex.home || '');
  const defaultAuthHome = path.join(os.homedir(), '.codex');
  const fallbackAuth = path.resolve(primaryAuth.home || '') === path.resolve(defaultAuthHome)
    ? { openaiApiKey: '' }
    : readCodexAuthSummary(defaultAuthHome);
  const candidates = [];

  if (provider === 'zerochat') {
    candidates.push(['env_zerochat', process.env.ZEROCHAT_API_KEY || '']);
    candidates.push(['env_openai', process.env.OPENAI_API_KEY || '']);
    candidates.push(['env_codex', process.env.CODEX_API_KEY || '']);
  } else {
    candidates.push(['env_openai', process.env.OPENAI_API_KEY || '']);
    candidates.push(['env_codex', process.env.CODEX_API_KEY || '']);
    candidates.push(['auth_home', primaryAuth.openaiApiKey || '']);
    candidates.push(['auth_default', fallbackAuth.openaiApiKey || '']);
  }
  candidates.push(['config', codex.api_key || codex.apiKey || '']);

  for (const [source, raw] of candidates) {
    const value = normalizeString(raw);
    if (!value) continue;
    return {
      value,
      source,
      runtimeProvider,
    };
  }
  return {
    value: '',
    source: '',
    runtimeProvider,
  };
}

function syncCodexHomeProviderConfig(configuredHome) {
  const targetHome = normalizeString(configuredHome) ? path.resolve(configuredHome) : '';
  if (!targetHome) return { changed: false, skipped: true, reason: 'home_missing' };

  const defaultHome = path.join(os.homedir(), '.codex');
  const sourceConfigPath = path.join(defaultHome, 'config.toml');
  const targetConfigPath = path.join(targetHome, 'config.toml');
  if (path.resolve(sourceConfigPath) === path.resolve(targetConfigPath)) {
    return { changed: false, skipped: true, reason: 'same_config' };
  }

  const sourceText = readTextFileIfExists(sourceConfigPath);
  const targetText = readTextFileIfExists(targetConfigPath);
  if (!sourceText || !targetText) {
    return {
      changed: false,
      skipped: true,
      reason: !sourceText ? 'source_config_missing' : 'target_config_missing',
    };
  }

  const sourceProviderMatch = sourceText.match(/^\s*model_provider\s*=\s*(.+)\s*$/m);
  const sourceProvider = parseSimpleTomlValue(sourceProviderMatch?.[1] || '');
  if (!sourceProvider) {
    let nextText = targetText;
    nextText = nextText.replace(/^\s*model_provider\s*=.*\n?/gm, '');
    nextText = nextText.replace(/^\s*\[model_providers\.[^\]]+\]\s*$[\s\S]*?(?=^\s*\[[^\]]+\]\s*$|$)/gm, '');
    nextText = nextText.replace(/^(?:\s*(?:name|base_url|wire_api|requires_openai_auth)\s*=.*\n)+/m, '');
    nextText = nextText.replace(/\n{3,}/g, '\n\n').trim();
    if (nextText) nextText = `${nextText}\n`;
    const changed = writeTextFileIfChanged(targetConfigPath, nextText);
    return {
      changed,
      skipped: false,
      reason: changed ? 'cleared_stale_provider' : 'provider_already_cleared',
      targetConfigPath,
    };
  }

  const sourceSectionPattern = new RegExp(
    `^\\s*\\[model_providers\\.${escapeRegExp(sourceProvider)}\\]\\s*$([\\s\\S]*?)(?=^\\s*\\[[^\\]]+\\]\\s*$|$)`,
    'm'
  );
  const sourceSectionMatch = sourceText.match(sourceSectionPattern);
  if (!sourceSectionMatch) {
    return { changed: false, skipped: true, reason: 'source_provider_section_missing' };
  }

  let nextText = targetText;
  if (/^\s*model_provider\s*=.*$/m.test(nextText)) {
    nextText = nextText.replace(/^\s*model_provider\s*=.*$/m, `model_provider = "${sourceProvider}"`);
  } else {
    nextText = `model_provider = "${sourceProvider}"\n${nextText}`;
  }

  const targetSectionPattern = new RegExp(
    `^\\s*\\[model_providers\\.${escapeRegExp(sourceProvider)}\\]\\s*$([\\s\\S]*?)(?=^\\s*\\[[^\\]]+\\]\\s*$|$)`,
    'm'
  );
  if (targetSectionPattern.test(nextText)) {
    nextText = nextText.replace(targetSectionPattern, sourceSectionMatch[0].trimEnd());
  } else {
    nextText = `${nextText.trimEnd()}\n\n${sourceSectionMatch[0].trimEnd()}\n`;
  }
  nextText = nextText.replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';

  const changed = writeTextFileIfChanged(targetConfigPath, nextText);
  return {
    changed,
    skipped: false,
    reason: changed ? 'synced' : 'already_current',
    sourceProvider,
    targetConfigPath,
  };
}

function syncCodexHomeAuth(configuredHome) {
  const targetHome = normalizeString(configuredHome) ? path.resolve(configuredHome) : '';
  if (!targetHome) return { changed: false, skipped: true, reason: 'home_missing' };

  const defaultHome = path.join(os.homedir(), '.codex');
  const sourceAuthPath = path.join(defaultHome, 'auth.json');
  const targetAuthPath = path.join(targetHome, 'auth.json');
  if (path.resolve(sourceAuthPath) === path.resolve(targetAuthPath)) {
    return { changed: false, skipped: true, reason: 'same_auth' };
  }

  const sourceText = readTextFileIfExists(sourceAuthPath);
  if (!sourceText) {
    return { changed: false, skipped: true, reason: 'source_auth_missing' };
  }

  let sourceJson;
  try {
    sourceJson = JSON.parse(sourceText);
  } catch (_) {
    return { changed: false, skipped: true, reason: 'source_auth_invalid' };
  }

  if (!sourceJson || typeof sourceJson !== 'object' || Array.isArray(sourceJson)) {
    return { changed: false, skipped: true, reason: 'source_auth_invalid' };
  }

  const sourceOpenaiApiKey = normalizeString(sourceJson.OPENAI_API_KEY);
  const sourceTokens = sourceJson.tokens && typeof sourceJson.tokens === 'object' ? sourceJson.tokens : null;
  if (!sourceOpenaiApiKey && !sourceTokens) {
    return { changed: false, skipped: true, reason: 'source_auth_empty' };
  }

  let targetJson = {};
  const targetText = readTextFileIfExists(targetAuthPath);
  if (targetText) {
    try {
      const parsed = JSON.parse(targetText);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        targetJson = parsed;
      }
    } catch (_) {
      targetJson = {};
    }
  }

  const nextJson = { ...targetJson };
  if (sourceOpenaiApiKey) nextJson.OPENAI_API_KEY = sourceOpenaiApiKey;
  else delete nextJson.OPENAI_API_KEY;
  if (sourceTokens) {
    nextJson.tokens = sourceTokens;
  }
  if (sourceJson.auth_mode) {
    nextJson.auth_mode = sourceJson.auth_mode;
  }
  if (sourceJson.last_refresh) {
    nextJson.last_refresh = sourceJson.last_refresh;
  }
  if (sourceJson.auth_mode && sourceJson.auth_mode !== 'apikey') {
    delete nextJson.OPENAI_API_KEY;
  }

  const nextText = `${JSON.stringify(nextJson, null, 2)}\n`;
  const changed = writeTextFileIfChanged(targetAuthPath, nextText);
  return {
    changed,
    skipped: false,
    reason: changed ? 'synced' : 'already_current',
    targetAuthPath,
  };
}

function summarizeCodexExecFailure(err, codex = {}) {
  const rawMessage = String(err?.message || '未知错误').trim();
  const runtimeProvider = codex.runtimeProvider || deriveCodexRuntimeProvider(codex);
  const providerLabel = runtimeProvider.providerName || runtimeProvider.provider || 'current';
  const lines = [
    `Codex 执行失败。当前配置：provider=${providerLabel}, model=${codex.model || '(default)'}, approval=${codex.approvalPolicy || '(default)'}, sandbox=${codex.sandbox || '(default)'}`,
  ];
  if (runtimeProvider.providerBaseUrl) {
    lines.push(`provider_base_url=${runtimeProvider.providerBaseUrl}`);
  }

  const firstErrorLine = rawMessage
    .replace(/\r/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .find((line) => {
      if (!line) return false;
      const lower = line.toLowerCase();
      if (lower.startsWith('openai codex v')) return false;
      if (line === '--------') return false;
      if (lower.startsWith('workdir:')) return false;
      if (lower.startsWith('model:')) return false;
      if (lower.startsWith('provider:')) return false;
      if (lower.startsWith('approval:')) return false;
      if (lower.startsWith('sandbox:')) return false;
      if (lower.startsWith('reasoning effort:')) return false;
      if (lower.startsWith('reasoning summaries:')) return false;
      if (lower.startsWith('session id:')) return false;
      if (lower === 'user') return false;
      return true;
    }) || '';

  if (firstErrorLine) {
    lines.push(`底层错误：${compactText(firstErrorLine, 600)}`);
  } else if (rawMessage) {
    lines.push(`底层错误：${compactText(rawMessage, 600)}`);
  }
  return compactText(lines.join('\n'), 1000);
}

function detectBinary(bin, versionArgs = ['-version']) {
  const raw = normalizeString(bin);
  if (!raw) return { found: false, version: '' };
  try {
    const run = spawnSync(raw, versionArgs, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (run.error || run.status !== 0) {
      return { found: false, version: '' };
    }
    const version = String(run.stdout || run.stderr || '').trim().split(/\r?\n/)[0] || '';
    return { found: true, version };
  } catch (_) {
    return { found: false, version: '' };
  }
}

function resolveDomain(domainValue) {
  const raw = normalizeString(domainValue || 'feishu');
  if (!raw || raw.toLowerCase() === 'feishu') {
    ensure(lark, 'missing dependency @larksuiteoapi/node-sdk');
    return { value: lark.Domain.Feishu, label: 'feishu' };
  }
  if (raw.toLowerCase() === 'lark') {
    ensure(lark, 'missing dependency @larksuiteoapi/node-sdk');
    return { value: lark.Domain.Lark, label: 'lark' };
  }
  if (/^https?:\/\/\S+$/i.test(raw)) {
    return { value: raw.replace(/\/+$/, ''), label: raw.replace(/\/+$/, '') };
  }
  throw new Error(`invalid domain "${raw}", expected feishu | lark | https://open.xxx.com`);
}

function resolveCredentials(config = {}) {
  return {
    appId: normalizeString(config.app_id),
    appSecret: normalizeString(config.app_secret),
    botOpenId: normalizeString(config.bot_open_id),
  };
}

function resolveCodexConfig(config = {}) {
  const codex = asPlainObject(config.codex);
  const cwd = normalizeString(codex.cwd);
  const home = normalizeString(codex.home);
  const homeProviderSync = syncCodexHomeProviderConfig(home);
  const homeAuthSync = syncCodexHomeAuth(home);
  const cliLikeCodex = {
    home,
    api_key: normalizeString(codex.api_key),
    apiKey: normalizeString(codex.api_key),
  };
  const selectedApiKey = selectCodexApiKey(cliLikeCodex);
  return {
    bin: normalizeString(codex.bin || 'codex') || 'codex',
    model: normalizeString(codex.model || 'gpt-5.6-sol'),
    reasoningEffort: normalizeString(codex.reasoning_effort || 'xhigh'),
    serviceTier: normalizeString(codex.service_tier || codex.serviceTier || 'default'),
    profile: normalizeString(codex.profile),
    home,
    cwd,
    addDirs: normalizeStringList(codex.add_dirs).filter((dir) => dir !== cwd),
    historyTurns: asInt(codex.history_turns, 6, 0, 20),
    systemPrompt: mergeTalkNormalPrompt(
      normalizeString(codex.system_prompt),
      DEFAULT_CODEX_SYSTEM_PROMPT
    ),
    apiKey: selectedApiKey.value,
    apiKeySource: selectedApiKey.source,
    runtimeProvider: selectedApiKey.runtimeProvider,
    homeProviderSync,
    homeAuthSync,
    sandbox: normalizeString(codex.sandbox || 'danger-full-access') || 'danger-full-access',
    approvalPolicy: normalizeString(codex.approval_policy || 'never') || 'never',
  };
}

function buildCodexPrompt({
  systemPrompt = '',
  history = [],
  userText = '',
  cwd = '',
  addDirs = [],
  threadTitle = '',
  agentGatewayHint = '',
}) {
  const lines = [];
  const title = normalizeString(threadTitle);
  if (title) {
    lines.push(title);
    lines.push('');
  }
  lines.push(systemPrompt || DEFAULT_CODEX_SYSTEM_PROMPT);
  lines.push('');
  lines.push(`当前工作目录：${cwd || process.cwd()}`);
  if (Array.isArray(addDirs) && addDirs.length > 0) {
    lines.push('额外可访问工作目录：');
    for (const dir of addDirs) {
      lines.push(`- ${dir}`);
    }
  }
  const routeHint = normalizeString(agentGatewayHint);
  if (routeHint) {
    lines.push('');
    lines.push(routeHint);
  }
  lines.push('');
  lines.push('对话上下文（按时间顺序，可能为空）：');
  if (!history || history.length === 0) {
    lines.push('(无)');
  } else {
    for (const item of history) {
      const roleLabel = item.role === 'assistant' ? '助手' : '用户';
      lines.push(`[${roleLabel}] ${compactText(item.text, 1200)}`);
    }
  }
  lines.push('');
  lines.push('用户最新消息：');
  lines.push(compactText(userText, 2400));
  lines.push('');
  lines.push('请直接输出给用户的最终回复正文，不要加“好的/收到”等空话，不要复述用户原话。');
  lines.push('禁止输出“稍后回复/几分钟后回复/晚点再回复”这类承诺。无法完成就直接说明卡点和下一步。');
  return lines.join('\n');
}

function buildCodexResumePrompt({ userText = '', agentGatewayHint = '' }) {
  const lines = [
    '继续当前线程。下面是用户最新消息，请直接回复用户。',
    '',
  ];
  const routeHint = normalizeString(agentGatewayHint);
  if (routeHint) {
    lines.push(routeHint);
    lines.push('');
  }
  lines.push(
    '用户最新消息：',
    compactText(userText, 2400),
    '',
    '请直接输出给用户的最终回复正文，不要加“好的/收到”等空话，不要复述用户原话。',
    '禁止输出“稍后回复/几分钟后回复/晚点再回复”这类承诺。无法完成就直接说明卡点和下一步。'
  );
  return lines.join('\n');
}

function shouldBypassCodexSandbox(sandbox, approvalPolicy) {
  return normalizeString(sandbox) === 'danger-full-access'
    && normalizeString(approvalPolicy) === 'never';
}

function runCodexExec({
  bin,
  model,
  reasoningEffort,
  serviceTier,
  profile,
  home,
  cwd,
  addDirs = [],
  sandbox,
  approvalPolicy,
  apiKey = '',
  prompt,
  resumeSessionId = '',
  onProgressEvent = null,
}) {
  return new Promise((resolve, reject) => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-codex-'));
    const outputFile = path.join(tempDir, 'last-message.txt');
    const resumeId = normalizeString(resumeSessionId);
    const bypassSandbox = shouldBypassCodexSandbox(sandbox, approvalPolicy);
    const args = resumeId
      ? ['exec', 'resume', '--skip-git-repo-check', '--json']
      : ['exec', '--skip-git-repo-check', '--json'];

    if (bypassSandbox) args.push('--dangerously-bypass-approvals-and-sandbox');
    if (model) args.push('-m', model);
    if (reasoningEffort) args.push('-c', `model_reasoning_effort=\"${reasoningEffort}\"`);
    if (serviceTier) args.push('-c', `service_tier=\"${serviceTier}\"`);
    if (!resumeId && profile) args.push('-p', profile);
    if (!resumeId && cwd) args.push('-C', cwd);
    if (!resumeId) {
      for (const dir of addDirs || []) {
        if (!normalizeString(dir)) continue;
        args.push('--add-dir', dir);
      }
    }
    if (!resumeId && sandbox && !bypassSandbox) args.push('-s', sandbox);
    if (approvalPolicy && !bypassSandbox) args.push('-c', `approval_policy=\"${approvalPolicy}\"`);
    args.push('--output-last-message', outputFile);
    if (resumeId) args.push(resumeId);
    args.push('-');

    const childEnv = { ...process.env };
    childEnv.HOME = process.env.HOME || os.homedir();
    childEnv.CODEX_HOME = normalizeString(home) || process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
    if (normalizeString(apiKey)) {
      childEnv.OPENAI_API_KEY = apiKey;
      childEnv.CODEX_API_KEY = apiKey;
    }

    const child = spawn(bin, args, {
      cwd: cwd || process.cwd(),
      env: childEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let jsonBuffer = '';
    let observedThreadId = resumeId;

    function emitProgressEvent(event) {
      if (typeof onProgressEvent !== 'function') return;
      try {
        onProgressEvent(event);
      } catch (_) {
        // Progress callbacks are best-effort and must not break execution.
      }
    }

    child.stdout.on('data', (buf) => {
      const chunk = String(buf || '');
      stdout = `${stdout}${chunk}`;
      if (stdout.length > 4000) stdout = stdout.slice(-4000);
      jsonBuffer = `${jsonBuffer}${chunk}`;

      let idx = jsonBuffer.indexOf('\n');
      while (idx >= 0) {
        const line = jsonBuffer.slice(0, idx).trim();
        jsonBuffer = jsonBuffer.slice(idx + 1);
        if (line) {
          try {
            const parsed = JSON.parse(line);
            if (parsed?.type === 'thread.started' && parsed?.thread_id) {
              observedThreadId = normalizeString(parsed.thread_id) || observedThreadId;
            }
            emitProgressEvent(parsed);
          } catch (_) {
            emitProgressEvent({ type: 'raw', text: line });
          }
        }
        idx = jsonBuffer.indexOf('\n');
      }
    });

    child.stderr.on('data', (buf) => {
      const chunk = String(buf || '');
      stderr = `${stderr}${chunk}`;
      if (stderr.length > 4000) stderr = stderr.slice(-4000);
    });

    child.on('error', (err) => {
      fs.rmSync(tempDir, { recursive: true, force: true });
      reject(new Error(`codex spawn failed: ${err.message}`));
    });

    child.on('close', (code, signal) => {
      if (code !== 0) {
        const detail = compactText(stderr || stdout || `exit=${code}, signal=${signal || ''}`, 1200);
        fs.rmSync(tempDir, { recursive: true, force: true });
        reject(new Error(`codex exec failed: ${detail}`));
        return;
      }

      try {
        const reply = fs.readFileSync(outputFile, 'utf8');
        fs.rmSync(tempDir, { recursive: true, force: true });
        resolve({
          reply,
          threadId: observedThreadId,
        });
      } catch (err) {
        fs.rmSync(tempDir, { recursive: true, force: true });
        reject(new Error(`read codex output failed: ${err.message}`));
      }
    });

    child.stdin.write(prompt);
    child.stdin.end();
  });
}

async function generateCodexReply({
  codex,
  history = [],
  userText = '',
  sessionId = '',
  threadTitle = '',
  agentGatewayHint = '',
  onProgressEvent = null,
}) {
  const resumeId = normalizeString(sessionId);
  if (resumeId) {
    try {
      const resumed = await runCodexExec({
        ...codex,
        prompt: buildCodexResumePrompt({ userText, agentGatewayHint }),
        resumeSessionId: resumeId,
        onProgressEvent,
      });
      return {
        reply: normalizeString(resumed.reply) ? String(resumed.reply) : '',
        threadId: normalizeString(resumed.threadId || resumeId),
      };
    } catch (_) {
      // fall through to a fresh session
    }
  }

  const fresh = await runCodexExec({
    ...codex,
    prompt: buildCodexPrompt({
      systemPrompt: codex.systemPrompt,
      history,
      userText,
      cwd: codex.cwd,
      addDirs: codex.addDirs,
      threadTitle,
      agentGatewayHint,
    }),
    onProgressEvent,
  });
  return {
    reply: normalizeString(fresh.reply) ? String(fresh.reply) : '',
    threadId: normalizeString(fresh.threadId),
  };
}

function splitTextForFeishu(text, maxLength = FEISHU_TEXT_CHUNK_LIMIT) {
  const raw = String(text || '').replace(/\r/g, '');
  if (!raw) return [];
  const max = Math.max(500, Number(maxLength) || FEISHU_TEXT_CHUNK_LIMIT);
  const chunks = [];
  let cursor = 0;

  while (cursor < raw.length) {
    let end = Math.min(cursor + max, raw.length);
    if (end < raw.length) {
      const newlineCut = raw.lastIndexOf('\n', end);
      if (newlineCut > cursor + Math.floor(max * 0.6)) {
        end = newlineCut + 1;
      }
    }
    if (end <= cursor) end = Math.min(cursor + max, raw.length);
    chunks.push(raw.slice(cursor, end));
    cursor = end;
  }

  return chunks;
}

function createFeishuClient({ domain, creds }) {
  ensure(lark, 'missing dependency @larksuiteoapi/node-sdk');
  ensure(normalizeString(creds?.appId), 'feishu app_id is required');
  ensure(normalizeString(creds?.appSecret), 'feishu app_secret is required');
  const resolvedDomain = resolveDomain(domain);
  return new lark.Client({
    appId: creds.appId,
    appSecret: creds.appSecret,
    disableTokenCache: false,
    domain: resolvedDomain.value,
  });
}

async function sendTextReply(client, chatID, text) {
  return client.im.v1.message.create({
    params: {
      receive_id_type: 'chat_id',
    },
    data: {
      receive_id: chatID,
      content: JSON.stringify({ text }),
      msg_type: 'text',
    },
  });
}

async function sendCodexReplyPassthrough(client, chatID, rawText) {
  const chunks = splitTextForFeishu(rawText, FEISHU_TEXT_CHUNK_LIMIT);
  let sentChunks = 0;
  for (const chunk of chunks) {
    if (!chunk) continue;
    await sendTextReply(client, chatID, chunk);
    sentChunks += 1;
  }
  return sentChunks;
}

function checkCodexEnvironment({ bin = 'codex', cwd = process.cwd(), apiKey = '' } = {}) {
  const resolvedBin = normalizeString(bin || 'codex') || 'codex';
  const binary = detectBinary(resolvedBin, ['--version']);
  if (!binary.found) {
    return {
      ok: false,
      status: 'error',
      summary: 'Codex 未安装或不可执行',
      hint: '先安装或修复 Codex CLI，再继续配置机器人。',
      codexBin: resolvedBin,
      codexVersion: '',
      binary: {
        passed: false,
        label: 'CLI 检测失败',
        detail: `未找到可执行文件：${resolvedBin}`,
        raw: [],
      },
      login: {
        passed: false,
        label: '登录态未知',
        detail: 'Codex CLI 未就绪，无法检测登录态。',
        raw: [],
      },
      connectivity: {
        passed: false,
        label: '连通性未检测',
        detail: 'Codex CLI 未就绪，无法发起最小请求。',
        raw: [],
      },
    };
  }

  const env = { ...process.env };
  env.HOME = process.env.HOME || os.homedir();
  if (normalizeString(apiKey)) {
    env.OPENAI_API_KEY = apiKey;
    env.CODEX_API_KEY = apiKey;
  }

  const loginRun = spawnSync(resolvedBin, ['login', 'status'], {
    encoding: 'utf8',
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const loginOutput = `${loginRun.stdout || ''}\n${loginRun.stderr || ''}`.trim();
  const loginPassed = loginRun.status === 0 && loginOutput.length > 0;

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-codex-health-'));
  const outputFile = path.join(tempDir, 'last-message.txt');
  const connectivityArgs = [
    'exec',
    '--skip-git-repo-check',
    '--cd',
    cwd || process.cwd(),
    '--sandbox',
    'read-only',
    '--output-last-message',
    outputFile,
    'Reply with exactly OK.',
  ];
  const connectivityRun = spawnSync(resolvedBin, connectivityArgs, {
    encoding: 'utf8',
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let connectivityReply = '';
  if (fs.existsSync(outputFile)) {
    connectivityReply = normalizeString(fs.readFileSync(outputFile, 'utf8'));
  }
  fs.rmSync(tempDir, { recursive: true, force: true });

  const connectivityOutput = `${connectivityRun.stdout || ''}\n${connectivityRun.stderr || ''}`.trim();
  const connectivityPassed = connectivityRun.status === 0 && connectivityReply.toUpperCase() === 'OK';

  const ok = binary.found && connectivityPassed;
  return {
    ok,
    status: ok ? 'ready' : 'error',
    summary: ok ? 'Codex 已就绪' : 'Codex 还不能稳定执行任务',
    hint: ok
      ? '可以继续创建机器人并配置工作目录。'
      : '先解决 Codex 安装、登录态或连通性问题，再继续配置机器人。',
    codexBin: resolvedBin,
    codexVersion: binary.version,
    binary: {
      passed: true,
      label: 'CLI 已找到',
      detail: binary.version || resolvedBin,
      raw: binary.version ? [binary.version] : [],
    },
    login: {
      passed: loginPassed,
      label: loginPassed ? '登录态可用' : '登录态不可用',
      detail: loginPassed ? compactText(loginOutput, 160) : compactText(loginOutput || '未检测到可用登录态', 160),
      raw: loginOutput ? loginOutput.split(/\r?\n/).filter(Boolean) : [],
    },
    connectivity: {
      passed: connectivityPassed,
      label: connectivityPassed ? '最小请求通过' : '最小请求失败',
      detail: connectivityPassed
        ? `Codex 返回：${connectivityReply}`
        : compactText(connectivityOutput || connectivityReply || '未拿到有效回复', 160),
      raw: connectivityOutput ? connectivityOutput.split(/\r?\n/).filter(Boolean).slice(-12) : [],
    },
  };
}

module.exports = {
  DEFAULT_CODEX_SYSTEM_PROMPT,
  FEISHU_TEXT_CHUNK_LIMIT,
  asPlainObject,
  checkCodexEnvironment,
  compactText,
  createFeishuClient,
  detectBinary,
  deriveCodexRuntimeProvider,
  ensure,
  generateCodexReply,
  normalizeString,
  normalizeStringList,
  resolveCodexConfig,
  resolveCredentials,
  resolveDomain,
  runCodexExec,
  sendCodexReplyPassthrough,
  splitTextForFeishu,
  summarizeCodexExecFailure,
};
