#!/usr/bin/env node
const readline = require('readline');
const { WebSocket } = require('ws');
const {
  decodeConnectionToken,
  decryptRelayPayload,
  defaultCliConfigPath,
  loadCliConfig,
  encryptRelayPayload,
  saveCliConfig,
} = require('./lib/remote_access');

const relayClients = new Map();

function normalizeString(value) {
  return String(value || '').trim();
}

function takeOption(args, names, fallback = '') {
  for (const name of names) {
    const index = args.indexOf(name);
    if (index >= 0) {
      const value = index + 1 < args.length ? args[index + 1] : '';
      args.splice(index, value ? 2 : 1);
      return value || fallback;
    }
  }
  return fallback;
}

function takeFlag(args, names) {
  for (const name of names) {
    const index = args.indexOf(name);
    if (index >= 0) {
      args.splice(index, 1);
      return true;
    }
  }
  return false;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(error) {
  return normalizeString(error?.message || error) || 'unknown error';
}

function isTrustedHttpUrl(rawUrl) {
  const url = new URL(rawUrl);
  if (url.protocol === 'https:') return true;
  const host = url.hostname.toLowerCase();
  if (['127.0.0.1', 'localhost', '::1'].includes(host)) return true;
  if (host.endsWith('.ts.net')) return true;
  const parts = host.split('.').map(Number);
  if (parts.length !== 4 || !parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)) return false;
  if (parts[0] === 10 || parts[0] === 127 || parts[0] === 192 && parts[1] === 168) return true;
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
  if (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) return true;
  return false;
}

function isTrustedRelayUrl(rawUrl) {
  const url = new URL(rawUrl);
  if (url.protocol === 'wss:') return true;
  if (url.protocol !== 'ws:') return false;
  return ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(url.hostname.toLowerCase());
}

function relayWebSocketUrl(relayUrl, endpoint, params = {}) {
  const url = new URL(relayUrl);
  const basePath = url.pathname.replace(/\/+$/g, '');
  url.pathname = `${basePath}${endpoint.startsWith('/') ? endpoint : `/${endpoint}`}`;
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, normalizeString(value));
  return url.toString();
}

class RelayRpcClient {
  constructor(machine) {
    this.machine = machine;
    this.socket = null;
    this.connectPromise = null;
    this.pending = new Map();
    this.idleTimer = null;
  }

  scheduleIdleClose() {
    if (this.pending.size || !this.socket || this.socket.readyState !== WebSocket.OPEN || this.idleTimer) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (!this.pending.size && this.socket?.readyState === WebSocket.OPEN) {
        this.socket.close(1000, 'CLI request complete');
      }
    }, 100);
  }

  async connect() {
    if (this.socket?.readyState === WebSocket.OPEN) return;
    if (this.connectPromise) return this.connectPromise;
    this.connectPromise = new Promise((resolve, reject) => {
      const url = relayWebSocketUrl(this.machine.relayUrl, '/v1/client', {
        machineId: this.machine.machineId,
        clientId: this.machine.clientId,
      });
      const ws = new WebSocket(url, { handshakeTimeout: 15000, maxPayload: 3 * 1024 * 1024 });
      this.socket = ws;
      let settled = false;
      ws.on('open', () => {
        settled = true;
        resolve();
      });
      ws.on('message', (raw) => this.handleMessage(raw));
      ws.on('error', (error) => {
        if (!settled) reject(new Error(`消息中继连接失败：${error.message}`));
      });
      ws.on('close', () => {
        if (this.idleTimer) clearTimeout(this.idleTimer);
        this.idleTimer = null;
        if (this.socket === ws) this.socket = null;
        if (!settled) reject(new Error('消息中继连接已关闭'));
        for (const pending of this.pending.values()) pending.reject(new Error('消息中继连接已断开'));
        this.pending.clear();
      });
    }).finally(() => {
      this.connectPromise = null;
    });
    return this.connectPromise;
  }

  handleMessage(raw) {
    let frame;
    try {
      frame = JSON.parse(String(raw || ''));
    } catch (_) {
      return;
    }
    if (frame.type === 'relay_state') {
      this.machineOnline = Boolean(frame.online);
      return;
    }
    const pending = this.pending.get(normalizeString(frame.requestId));
    if (!pending) return;
    if (frame.type === 'rpc_error') {
      this.pending.delete(frame.requestId);
      pending.reject(new Error(frame.error === 'machine_offline' ? '目标电脑当前离线' : `中继拒绝请求：${frame.error || 'unknown'}`));
      this.scheduleIdleClose();
      return;
    }
    if (frame.type !== 'rpc_response') return;
    try {
      const result = decryptRelayPayload(this.machine.encryptionKey, frame.envelope, {
        machineId: this.machine.machineId,
        clientId: this.machine.clientId,
        requestId: frame.requestId,
        direction: 'response',
      });
      this.pending.delete(frame.requestId);
      pending.resolve(result);
      this.scheduleIdleClose();
    } catch (_) {
      this.pending.delete(frame.requestId);
      pending.reject(new Error('无法验证远程电脑的加密响应'));
      this.scheduleIdleClose();
    }
  }

  async request(apiPath, options = {}) {
    await this.connect();
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    const requestId = `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
    const envelope = encryptRelayPayload(this.machine.encryptionKey, {
      method: options.method || 'GET',
      path: apiPath,
      ...(options.body === undefined ? {} : { body: options.body }),
    }, {
      machineId: this.machine.machineId,
      clientId: this.machine.clientId,
      requestId,
      direction: 'request',
    });
    return new Promise((resolve, reject) => {
      let timer = null;
      const cleanup = () => {
        if (timer) clearTimeout(timer);
        options.signal?.removeEventListener?.('abort', onAbort);
      };
      const wrappedResolve = (value) => { cleanup(); resolve(value); };
      const wrappedReject = (error) => { cleanup(); reject(error); };
      const onAbort = () => {
        this.pending.delete(requestId);
        wrappedReject(new Error('连接超时'));
        this.scheduleIdleClose();
      };
      this.pending.set(requestId, { resolve: wrappedResolve, reject: wrappedReject });
      if (options.signal) {
        if (options.signal.aborted) {
          onAbort();
          return;
        }
        options.signal.addEventListener('abort', onAbort, { once: true });
      }
      const timeoutMs = Number(options.timeoutMs || 0);
      if (timeoutMs > 0) timer = setTimeout(onAbort, timeoutMs);
      this.socket.send(JSON.stringify({
        type: 'rpc_request',
        machineId: this.machine.machineId,
        clientId: this.machine.clientId,
        requestId,
        envelope,
      }), (error) => {
        if (error) {
          this.pending.delete(requestId);
          wrappedReject(error);
          this.scheduleIdleClose();
        }
      });
    });
  }
}

function relayClientFor(machine) {
  const key = [machine.relayUrl, machine.machineId, machine.clientId].join('|');
  if (!relayClients.has(key)) relayClients.set(key, new RelayRpcClient(machine));
  return relayClients.get(key);
}

async function apiRequest(machine, apiPath, options = {}) {
  if (machine.transport === 'relay' || machine.relayUrl) {
    const result = await relayClientFor(machine).request(apiPath, options);
    const payload = result?.body || {};
    if (Number(result?.status) < 200 || Number(result?.status) >= 300 || payload.ok === false) {
      const error = new Error(payload.error || `HTTP ${result?.status || 500}`);
      error.statusCode = Number(result?.status) || 500;
      throw error;
    }
    return payload;
  }
  const url = `${machine.url.replace(/\/+$/g, '')}${apiPath}`;
  const headers = {
    accept: 'application/json',
    authorization: `Bearer ${machine.secret}`,
    ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
  };
  let response;
  try {
    response = await fetch(url, {
      method: options.method || 'GET',
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: options.signal,
    });
  } catch (error) {
    throw new Error(`无法连接 ${machine.alias || machine.machineName || machine.url} (${machine.url})：${errorMessage(error)}`);
  }
  const raw = await response.text();
  let payload;
  try {
    payload = raw ? JSON.parse(raw) : {};
  } catch (_) {
    throw new Error(`远程端返回了无效响应（HTTP ${response.status}）`);
  }
  if (!response.ok || payload.ok === false) {
    const error = new Error(payload.error || `HTTP ${response.status}`);
    error.statusCode = response.status;
    throw error;
  }
  return payload;
}

function resolveMachine(config, requestedAlias = '') {
  const aliases = Object.keys(config.machines || {});
  const alias = normalizeString(requestedAlias || config.defaultMachine || (aliases.length === 1 ? aliases[0] : ''));
  if (!alias) throw new Error('还没有选择电脑。先运行：scc machine add <别名> <连接token>');
  const machine = config.machines[alias];
  if (!machine) throw new Error(`没有找到电脑：${alias}`);
  return { ...machine, alias };
}

function validateAlias(alias) {
  const value = normalizeString(alias);
  if (!value || value.length > 64 || /[\s/\\]/u.test(value)) {
    throw new Error('电脑别名不能为空，且不能包含空格、/ 或 \\');
  }
  return value;
}

async function addMachine(args, configPath) {
  const alias = validateAlias(args[0]);
  const connectionToken = normalizeString(args[1]);
  if (!connectionToken) throw new Error('缺少连接 token');
  const decoded = decodeConnectionToken(connectionToken);
  const allowInsecure = takeFlag(args, ['--allow-insecure']);
  if (decoded.transport === 'direct' && !allowInsecure && !isTrustedHttpUrl(decoded.url)) {
    throw new Error('拒绝通过公网明文 HTTP 发送控制 token。请使用 HTTPS、Tailscale 地址，或明确添加 --allow-insecure');
  }
  if (decoded.transport === 'relay' && !allowInsecure && !isTrustedRelayUrl(decoded.relayUrl)) {
    throw new Error('拒绝连接未加密的公网消息中继；请使用 wss://，本机测试除外');
  }
  const candidate = {
    alias,
    transport: decoded.transport,
    url: decoded.url,
    secret: decoded.secret,
    relayUrl: decoded.relayUrl,
    clientId: decoded.clientId,
    encryptionKey: decoded.encryptionKey,
    machineId: decoded.machineId,
    machineName: decoded.machineName,
    tokenId: decoded.tokenId,
    addedAt: new Date().toISOString(),
  };
  const verified = await apiRequest(candidate, '/v1/machine');
  if (candidate.machineId && verified.machine?.id && candidate.machineId !== verified.machine.id) {
    throw new Error('连接 token 与远程电脑身份不匹配');
  }
  const config = loadCliConfig(configPath);
  config.machines[alias] = {
    ...candidate,
    machineId: verified.machine?.id || candidate.machineId,
    machineName: verified.machine?.name || candidate.machineName || alias,
  };
  if (!config.defaultMachine) config.defaultMachine = alias;
  saveCliConfig(config, configPath);
  const endpoint = decoded.transport === 'relay' ? decoded.relayUrl : decoded.url;
  process.stdout.write(`已添加：${alias} → ${config.machines[alias].machineName} (${decoded.transport}: ${endpoint})\n`);
  if (config.defaultMachine === alias) process.stdout.write(`当前默认电脑：${alias}\n`);
}

async function listMachines(configPath) {
  const config = loadCliConfig(configPath);
  const aliases = Object.keys(config.machines);
  if (!aliases.length) {
    process.stdout.write('还没有添加电脑。\n');
    return;
  }
  const rows = await Promise.all(aliases.map(async (alias) => {
    const machine = { ...config.machines[alias], alias };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    try {
      const result = await apiRequest(machine, '/v1/machine', { signal: controller.signal });
      return { alias, machine, online: true, remote: result.machine || {} };
    } catch (error) {
      return { alias, machine, online: false, error: errorMessage(error) };
    } finally {
      clearTimeout(timer);
    }
  }));
  process.stdout.write('DEFAULT\tALIAS\tMACHINE\tSTATUS\tURL\n');
  for (const row of rows) {
    process.stdout.write([
      config.defaultMachine === row.alias ? '*' : '',
      row.alias,
      row.remote?.name || row.machine.machineName || '-',
      row.online ? 'online' : 'offline',
      row.machine.transport === 'relay' ? row.machine.relayUrl : row.machine.url,
    ].join('\t') + '\n');
  }
}

function useMachine(alias, configPath) {
  const selected = validateAlias(alias);
  const config = loadCliConfig(configPath);
  if (!config.machines[selected]) throw new Error(`没有找到电脑：${selected}`);
  config.defaultMachine = selected;
  saveCliConfig(config, configPath);
  process.stdout.write(`默认电脑已切换为：${selected}\n`);
}

function removeMachine(alias, configPath) {
  const selected = validateAlias(alias);
  const config = loadCliConfig(configPath);
  if (!config.machines[selected]) throw new Error(`没有找到电脑：${selected}`);
  delete config.machines[selected];
  if (config.defaultMachine === selected) config.defaultMachine = Object.keys(config.machines)[0] || '';
  saveCliConfig(config, configPath);
  process.stdout.write(`已从本机 CLI 移除：${selected}\n`);
}

async function listBots(machine) {
  const payload = await apiRequest(machine, '/v1/bots');
  const bots = Array.isArray(payload.bots) ? payload.bots : [];
  if (!bots.length) {
    process.stdout.write('这台电脑没有配置机器人。\n');
    return;
  }
  process.stdout.write('ACCOUNT\tNAME\tSTATE\tMODEL\tACTIVITY\n');
  for (const bot of bots) {
    process.stdout.write([
      bot.account,
      bot.displayName || '-',
      bot.state || '-',
      bot.model || '-',
      bot.activity?.label || '-',
    ].join('\t') + '\n');
  }
}

async function listThreads(machine, account) {
  const bot = normalizeString(account);
  if (!bot) throw new Error('缺少机器人账号，例如：scc thread list assistant');
  const payload = await apiRequest(machine, `/v1/bots/${encodeURIComponent(bot)}/threads`);
  const threads = Array.isArray(payload.threads) ? payload.threads : [];
  if (!threads.length) {
    process.stdout.write('这个机器人还没有 CLI 会话。\n');
    return [];
  }
  process.stdout.write('ID\tSTATUS\tUPDATED\tNAME\tPREVIEW\n');
  for (const thread of threads) {
    process.stdout.write([
      thread.id,
      thread.status || '-',
      thread.updatedAt || '-',
      thread.name || '-',
      normalizeString(thread.lastReplyPreview).replace(/\s+/g, ' ').slice(0, 80) || '-',
    ].join('\t') + '\n');
  }
  return threads;
}

async function createThread(machine, account, name = '') {
  const bot = normalizeString(account);
  if (!bot) throw new Error('缺少机器人账号');
  const payload = await apiRequest(machine, `/v1/bots/${encodeURIComponent(bot)}/threads`, {
    method: 'POST',
    body: { name: normalizeString(name) || 'CLI 会话' },
  });
  const thread = payload.thread;
  if (!thread?.id) throw new Error('远程端没有返回会话 ID');
  return thread;
}

function printProgressItem(item) {
  if (item.role === 'progress') process.stdout.write(`  · ${item.text}\n`);
  if (item.role === 'error') process.stdout.write(`  ! ${item.text}\n`);
}

async function sendMessageWithProgress(machine, account, thread, text) {
  const endpoint = `/v1/bots/${encodeURIComponent(account)}/threads/${encodeURIComponent(thread.id)}`;
  let knownHistoryLength = Array.isArray(thread.history) ? thread.history.length : 0;
  let finished = false;
  const sendPromise = apiRequest(machine, `${endpoint}/messages`, {
    method: 'POST',
    body: { text },
  });

  const pollPromise = (async () => {
    while (!finished) {
      await delay(850);
      if (finished) break;
      try {
        const snapshot = await apiRequest(machine, endpoint);
        const history = Array.isArray(snapshot.thread?.history) ? snapshot.thread.history : [];
        for (const item of history.slice(knownHistoryLength)) printProgressItem(item);
        knownHistoryLength = history.length;
      } catch (_) {
        // A transient polling failure should not cancel the task request.
      }
    }
  })();

  try {
    const result = await sendPromise;
    finished = true;
    await pollPromise;
    const finalThread = result.thread || thread;
    const history = Array.isArray(finalThread.history) ? finalThread.history : [];
    for (const item of history.slice(knownHistoryLength)) printProgressItem(item);
    const reply = normalizeString(result.reply || finalThread.lastReplyPreview);
    process.stdout.write(`\n${reply || '(机器人没有返回文本)'}\n`);
    return finalThread;
  } catch (error) {
    finished = true;
    await pollPromise;
    throw error;
  }
}

async function askOnce(machine, account, text, options = {}) {
  const bot = normalizeString(account);
  const message = normalizeString(text);
  if (!bot || !message) throw new Error('用法：scc ask <机器人账号> <消息>');
  let thread;
  if (options.threadId) {
    const payload = await apiRequest(machine, `/v1/bots/${encodeURIComponent(bot)}/threads/${encodeURIComponent(options.threadId)}`);
    thread = payload.thread;
  } else {
    thread = await createThread(machine, bot, options.name || 'CLI 单次任务');
  }
  return sendMessageWithProgress(machine, bot, thread, message);
}

async function interactiveChat(machine, account, options = {}) {
  const bot = normalizeString(account);
  if (!bot) throw new Error('用法：scc chat <机器人账号>');
  let thread;
  if (options.threadId) {
    const payload = await apiRequest(machine, `/v1/bots/${encodeURIComponent(bot)}/threads/${encodeURIComponent(options.threadId)}`);
    thread = payload.thread;
  } else {
    thread = await createThread(machine, bot, options.name || `CLI ${new Date().toLocaleString()}`);
  }
  process.stdout.write(`已连接 ${machine.alias}/${bot}，会话 ${thread.id}\n`);
  process.stdout.write('输入 /exit 退出。\n\n');
  const terminal = readline.createInterface({ input: process.stdin, output: process.stdout });
  const question = (prompt) => new Promise((resolve) => terminal.question(prompt, resolve));
  try {
    while (true) {
      const text = normalizeString(await question(`${machine.alias}/${bot}> `));
      if (!text) continue;
      if (['/exit', '/quit', 'exit', 'quit'].includes(text.toLowerCase())) break;
      try {
        thread = await sendMessageWithProgress(machine, bot, thread, text);
        process.stdout.write('\n');
      } catch (error) {
        process.stderr.write(`发送失败：${errorMessage(error)}\n`);
      }
    }
  } finally {
    terminal.close();
  }
}

function printUsage() {
  process.stdout.write(`SunCodexClaw CLI\n\n`);
  process.stdout.write(`电脑管理：\n`);
  process.stdout.write(`  scc machine add <别名> <连接token>\n`);
  process.stdout.write(`  scc machine list\n`);
  process.stdout.write(`  scc machine use <别名>\n`);
  process.stdout.write(`  scc machine remove <别名>\n\n`);
  process.stdout.write(`机器人：\n`);
  process.stdout.write(`  scc [-m 电脑别名] bot list\n`);
  process.stdout.write(`  scc [-m 电脑别名] thread list <机器人账号>\n`);
  process.stdout.write(`  scc [-m 电脑别名] thread new <机器人账号> [名称]\n`);
  process.stdout.write(`  scc [-m 电脑别名] ask <机器人账号> <消息> [--thread ID]\n`);
  process.stdout.write(`  scc [-m 电脑别名] chat <机器人账号> [--thread ID]\n`);
}

async function main() {
  const args = process.argv.slice(2);
  const configPath = defaultCliConfigPath();
  const requestedMachine = takeOption(args, ['--machine', '-m']);
  const threadId = takeOption(args, ['--thread']);
  const threadName = takeOption(args, ['--name']);
  const command = normalizeString(args.shift() || 'help');

  if (command === 'machine') {
    const action = normalizeString(args.shift() || 'list');
    if (action === 'add') await addMachine(args, configPath);
    else if (action === 'list' || action === 'ls') await listMachines(configPath);
    else if (action === 'use') useMachine(args[0], configPath);
    else if (action === 'remove' || action === 'rm') removeMachine(args[0], configPath);
    else throw new Error(`未知 machine 命令：${action}`);
    return;
  }

  if (command === 'help' || command === '--help' || command === '-h') {
    printUsage();
    return;
  }

  const config = loadCliConfig(configPath);
  const machine = resolveMachine(config, requestedMachine);
  if (command === 'bot') {
    const action = normalizeString(args.shift() || 'list');
    if (action !== 'list' && action !== 'ls') throw new Error(`未知 bot 命令：${action}`);
    await listBots(machine);
    return;
  }
  if (command === 'thread') {
    const action = normalizeString(args.shift() || 'list');
    if (action === 'list' || action === 'ls') await listThreads(machine, args[0]);
    else if (action === 'new' || action === 'create') {
      const thread = await createThread(machine, args[0], args.slice(1).join(' ') || threadName);
      process.stdout.write(`${thread.id}\t${thread.name}\n`);
    } else throw new Error(`未知 thread 命令：${action}`);
    return;
  }
  if (command === 'ask') {
    await askOnce(machine, args.shift(), args.join(' '), { threadId, name: threadName });
    return;
  }
  if (command === 'chat') {
    await interactiveChat(machine, args[0], { threadId, name: threadName });
    return;
  }
  throw new Error(`未知命令：${command}`);
}

module.exports = {
  apiRequest,
  isTrustedHttpUrl,
  isTrustedRelayUrl,
  RelayRpcClient,
  resolveMachine,
  validateAlias,
};

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${errorMessage(error)}\n`);
    process.exit(1);
  });
}
