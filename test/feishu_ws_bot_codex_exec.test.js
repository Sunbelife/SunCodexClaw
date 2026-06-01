const test = require('node:test');
const assert = require('node:assert/strict');

const {
  extractCodexErrorSummary,
  extractSystemPromptAliases,
  isCodexAuthenticationErrorText,
  parseCodexPlainExecOutput,
  shouldRetryCodexExecError,
} = require('../tools/feishu_ws_bot.js').__test__;

test('codex auth failures are detected and not retried with stale token copies', () => {
  const message = 'Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again.';

  assert.equal(isCodexAuthenticationErrorText(message), true);
  assert.equal(shouldRetryCodexExecError(new Error(`codex exec failed: ${message}`)), false);
});

test('codex json error events surface the real auth error', () => {
  const raw = [
    '{"type":"thread.started","thread_id":"t1"}',
    '{"type":"error","message":"Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again."}',
    '{"type":"turn.failed","error":{"message":"Provided authentication token is expired. Please try signing in again."}}',
  ].join('\n');

  const summary = extractCodexErrorSummary(raw);

  assert.match(summary, /Codex 登录态失效/);
  assert.match(summary, /refresh token was already used|authentication token is expired/);
});

test('plain codex parser keeps assistant body and drops CLI framing', () => {
  const output = [
    'OpenAI Codex v0.131.0',
    '--------',
    'assistant',
    '修好了，已经重启。',
    'tokens used',
    '123',
  ].join('\n');

  assert.equal(parseCodexPlainExecOutput(output), '修好了，已经重启。');
});

test('system prompt aliases ignore quoted talk-normal rules after the identity block', () => {
  const aliases = extractSystemPromptAliases([
    '你是“Todoo 管家”，通过飞书和用户交流。',
    '请直接回答。',
    '',
    'Do not use "Hope this helps" or "In summary".',
  ].join('\n'));

  assert.deepEqual(aliases, ['Todoo 管家', 'Todoo 管家']);
});
