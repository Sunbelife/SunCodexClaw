const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

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
  return {
    bin: normalizeString(codex.bin || 'codex') || 'codex',
    model: normalizeString(codex.model),
    reasoningEffort: normalizeString(codex.reasoning_effort),
    profile: normalizeString(codex.profile),
    cwd,
    addDirs: normalizeStringList(codex.add_dirs).filter((dir) => dir !== cwd),
    historyTurns: asInt(codex.history_turns, 6, 0, 20),
    systemPrompt: normalizeString(codex.system_prompt) || DEFAULT_CODEX_SYSTEM_PROMPT,
    apiKey: normalizeString(codex.api_key),
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

function buildCodexResumePrompt({ userText = '' }) {
  return [
    '继续当前线程。下面是用户最新消息，请直接回复用户。',
    '',
    '用户最新消息：',
    compactText(userText, 2400),
    '',
    '请直接输出给用户的最终回复正文，不要加“好的/收到”等空话，不要复述用户原话。',
    '禁止输出“稍后回复/几分钟后回复/晚点再回复”这类承诺。无法完成就直接说明卡点和下一步。',
  ].join('\n');
}

function shouldBypassCodexSandbox(sandbox, approvalPolicy) {
  return normalizeString(sandbox) === 'danger-full-access'
    && normalizeString(approvalPolicy) === 'never';
}

function runCodexExec({
  bin,
  model,
  reasoningEffort,
  profile,
  cwd,
  addDirs = [],
  sandbox,
  approvalPolicy,
  apiKey = '',
  prompt,
  resumeSessionId = '',
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
          } catch (_) {
            // ignore non-json lines
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
}) {
  const resumeId = normalizeString(sessionId);
  if (resumeId) {
    try {
      const resumed = await runCodexExec({
        ...codex,
        prompt: buildCodexResumePrompt({ userText }),
        resumeSessionId: resumeId,
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
    }),
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
  ensure,
  generateCodexReply,
  normalizeString,
  normalizeStringList,
  resolveCodexConfig,
  resolveCredentials,
  resolveDomain,
  sendCodexReplyPassthrough,
  splitTextForFeishu,
};
