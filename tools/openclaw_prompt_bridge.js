#!/usr/bin/env node

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, execFileSync } = require('child_process');

function extractLastJsonObject(text) {
  const source = String(text || '').trim();
  if (!source) return null;
  const candidates = [];
  const fenceMatches = source.match(/```(?:json)?\s*([\s\S]*?)```/gi) || [];
  for (const match of fenceMatches) {
    const inner = match.replace(/^```(?:json)?\s*/i, '').replace(/```$/i, '').trim();
    if (inner) candidates.push(inner);
  }
  const lines = source.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i].trim();
    if (line.startsWith('{') && line.endsWith('}')) candidates.push(line);
  }
  const firstBrace = source.indexOf('{');
  const lastBrace = source.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidates.push(source.slice(firstBrace, lastBrace + 1));
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

function extractPayloadText(payload) {
  if (!payload || typeof payload !== 'object') return '';
  const payloads = Array.isArray(payload.payloads) ? payload.payloads : [];
  const texts = [];
  for (const item of payloads) {
    const text = typeof item?.text === 'string' ? item.text.trim() : '';
    if (text) texts.push(text);
  }
  if (texts.length > 0) return texts.join('\n').trim();

  const candidates = [
    payload.output_text,
    payload.reply,
    payload.text,
    payload.message,
    payload?.result?.output_text,
    payload?.result?.reply,
    payload?.result?.text,
    payload?.error?.message,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  }
  return '';
}

function compactText(text, maxChars = 2000) {
  const value = String(text || '').replace(/\r/g, '\n').trim();
  if (!value) return '';
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}...`;
}

function parseNodeVersion(rawVersion) {
  const [majorRaw = '0', minorRaw = '0', patchRaw = '0'] = String(rawVersion || '').trim().replace(/^v/i, '').split('.');
  return {
    major: Number(majorRaw) || 0,
    minor: Number(minorRaw) || 0,
    patch: Number(patchRaw) || 0,
  };
}

function isSupportedNodeVersion(rawVersion) {
  const parsed = parseNodeVersion(rawVersion);
  if (parsed.major !== 22) return parsed.major > 22;
  if (parsed.minor !== 14) return parsed.minor > 14;
  return parsed.patch >= 0;
}

function isExecutableFile(filePath) {
  if (!filePath) return false;
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch (_) {
    return false;
  }
}

function getNodeVersionForBin(nodeBin) {
  if (!isExecutableFile(nodeBin)) return '';
  try {
    return String(
      execFileSync(nodeBin, ['-p', 'process.versions.node'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 5000,
      }) || ''
    ).trim();
  } catch (_) {
    return '';
  }
}

function resolveNodeBin() {
  const homeDir = os.homedir();
  const candidates = [
    process.env.OPENCLAW_NODE_BIN,
    '/opt/homebrew/bin/node',
    process.execPath,
    path.join(homeDir, '.local', 'bin', 'node'),
    path.join(homeDir, '.local', 'lib', 'node-v22.13.1-darwin-arm64', 'bin', 'node'),
    '/usr/local/bin/node',
  ].filter(Boolean);

  for (const candidate of candidates) {
    const version = getNodeVersionForBin(candidate);
    if (version && isSupportedNodeVersion(version)) {
      return { bin: candidate, version };
    }
  }
  return { bin: '', version: '' };
}

function resolveOpenClawBin() {
  const homeDir = os.homedir();
  const candidates = [
    process.env.OPENCLAW_BIN,
    path.join(homeDir, '.local', 'bin', 'openclaw'),
    path.join(homeDir, '.local', 'lib', 'node-v22.13.1-darwin-arm64', 'bin', 'openclaw'),
    'openclaw',
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (!candidate.includes(path.sep)) return candidate;
    if (isExecutableFile(candidate)) return candidate;
  }
  return 'openclaw';
}

const prompt = String(process.argv.slice(2).join(' ') || '').trim();
if (!prompt) {
  console.error('openclaw prompt missing');
  process.exit(1);
}

const resolvedNode = resolveNodeBin();
if (!resolvedNode.bin) {
  console.error('openclaw requires Node.js >= 22.14.0, but no supported node binary was found');
  process.exit(1);
}

const openclawBin = resolveOpenClawBin();
const agentId = String(process.env.OPENCLAW_AGENT_ID || 'daizi').trim() || 'daizi';
const timeoutSeconds = Math.max(30, Number(process.env.OPENCLAW_TIMEOUT_SECONDS || 240) || 240);
const sessionId = `feishu-${agentId}-${Date.now().toString(36)}-${process.pid.toString(36)}`;
const args = [
  'agent',
  '--local',
  '--agent',
  agentId,
  '--session-id',
  sessionId,
  '--message',
  prompt,
  '--json',
  '--timeout',
  String(timeoutSeconds),
  '--thinking',
  'off',
];

const childEnv = {
  ...process.env,
  PATH: uniquePathParts([
    path.dirname(resolvedNode.bin),
    process.env.PATH || '',
  ]),
};

function uniquePathParts(parts) {
  const seen = new Set();
  return parts
    .flatMap((item) => String(item || '').split(path.delimiter))
    .map((item) => item.trim())
    .filter((item) => {
      if (!item || seen.has(item)) return false;
      seen.add(item);
      return true;
    })
    .join(path.delimiter);
}

execFile(openclawBin, args, {
  encoding: 'utf8',
  env: childEnv,
  maxBuffer: 10 * 1024 * 1024,
}, (error, stdout, stderr) => {
  const combined = `${stdout || ''}\n${stderr || ''}`.trim();
  const payload = extractLastJsonObject(combined);
  const replyText = extractPayloadText(payload);
  if (replyText) {
    process.stdout.write(`${replyText}\n`);
    process.exit(0);
    return;
  }
  if (payload) {
    process.stdout.write(`${compactText(JSON.stringify(payload), 2000)}\n`);
    process.exit(0);
    return;
  }
  if (combined) {
    const trimmed = compactText(combined, 2000);
    if (trimmed) {
      process.stdout.write(`${trimmed}\n`);
      process.exit(0);
      return;
    }
  }
  if (error) {
    console.error(error.message || 'openclaw prompt failed');
    process.exit(1);
    return;
  }
  process.stdout.write('\n');
});
