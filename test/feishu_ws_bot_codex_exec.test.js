const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildAudioResourceTypeCandidates,
  buildCodexExecLockScope,
  extractBotInfoFromResponse,
  extractCodexAgentMessage,
  extractCodexAgentMessageText,
  extractCodexErrorSummary,
  extractSpeechTranscriptionText,
  extractSystemPromptAliases,
  formatLocalDateFolder,
  isCodexObservableWorkEvent,
  isCodexAuthenticationErrorText,
  isTodooRemoteSpeechProvider,
  isNonSubstantiveCodexExecutionResult,
  isTrivialCodexExecutionReply,
  mergeCodexExecutionGuardrailPrompt,
  normalizeFeishuDisplayText,
  parseCodexPlainExecOutput,
  resolveChatRecordPath,
  resolveCodexExecLockDir,
  resolveFeishuApiBaseUrl,
  resolveSpeechConfig,
  safeChatRecordPathSegment,
  shouldRenderFeishuMarkdown,
  shouldForceCodexExecution,
  shouldRetryCodexExecError,
  isMissingSpeechApiKeyError,
  parseCodexModelCommand,
  buildCodexModelStatus,
  appendCodexModelStatusFooter,
} = require('../tools/feishu_ws_bot.js').__test__;

test('bot info response parser extracts bot open id from supported shapes', () => {
  assert.deepEqual(
    extractBotInfoFromResponse({ data: { open_id: 'ou_bot_1', name: '新机器人' } }),
    { openId: 'ou_bot_1', name: '新机器人' }
  );
  assert.deepEqual(
    extractBotInfoFromResponse({ data: { bot: { open_id: 'ou_bot_2', name: '测试机器人' } } }),
    { openId: 'ou_bot_2', name: '测试机器人' }
  );
  assert.deepEqual(
    extractBotInfoFromResponse({ data: { bot_info: { botOpenId: 'ou_bot_3', botName: '示例助理' } } }),
    { openId: 'ou_bot_3', name: '示例助理' }
  );
});

test('Feishu API base URL resolves SDK enum and string domains', () => {
  assert.equal(resolveFeishuApiBaseUrl(0), 'https://open.feishu.cn');
  assert.equal(resolveFeishuApiBaseUrl(1), 'https://open.larksuite.com');
  assert.equal(resolveFeishuApiBaseUrl('feishu'), 'https://open.feishu.cn');
  assert.equal(resolveFeishuApiBaseUrl('https://open.example.com/'), 'https://open.example.com');
});

test('Feishu voice resource type candidates handle file_v3 audio keys', () => {
  assert.deepEqual(
    buildAudioResourceTypeCandidates('file_v3_0013e_abc'),
    ['file', 'audio']
  );
  assert.deepEqual(
    buildAudioResourceTypeCandidates('audio_abc'),
    ['audio', 'file']
  );
});

test('missing speech API key errors are user-actionable', () => {
  assert.equal(isMissingSpeechApiKeyError(new Error('缺少语音转写 API key，请配置 speech.api_key')), true);
  assert.equal(isMissingSpeechApiKeyError(new Error('audio transcription failed (500): timeout')), false);
});

test('remote speech provider can run without OpenAI key', () => {
  const speech = resolveSpeechConfig({
    speech: {
      enabled: true,
      provider: 'todoo_remote',
      transcription_url: 'https://api.example.com/v1/audio/transcriptions',
      api_key: '',
    },
  }, { apiKey: '' });

  assert.equal(speech.provider, 'todoo_remote');
  assert.equal(speech.apiKey, '');
  assert.equal(speech.transcriptionURL, 'https://api.example.com/v1/audio/transcriptions');
  assert.equal(isTodooRemoteSpeechProvider(speech.provider), true);
});

test('remote transcription payload text is extracted from supported fields', () => {
  assert.equal(extractSpeechTranscriptionText({
    provider: 'doubao_speech',
    raw_text: '原文',
    polished_text: '润色文本',
    transcription: '最终文本',
  }), '最终文本');
  assert.equal(extractSpeechTranscriptionText({
    data: {
      utterances: [
        { text: '第一句' },
        { content: '第二句' },
      ],
    },
  }), '第一句第二句');
});

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

test('chat records are stored by safe bot name and local date folder', () => {
  const date = new Date('2026-06-26T03:04:05+08:00');
  const recordPath = resolveChatRecordPath({
    botName: '示例店铺｜AI 助手',
    accountName: 'bot-demo',
    date,
  });

  assert.equal(formatLocalDateFolder(date), '2026-06-26');
  assert.equal(safeChatRecordPathSegment('a/b:c*?d"e<f>g|h'), 'a_b_c__d_e_f_g_h');
  assert.match(recordPath, /Chatlog/);
  assert.match(recordPath, /示例店铺｜AI 助手/);
  assert.match(recordPath, /2026-06-26/);
  assert.match(recordPath, /chat\.jsonl$/);
});

test('codex progress commentary is not treated as a final reply', () => {
  const progress = {
    type: 'agent_message',
    phase: 'commentary',
    text: '我开始跑真正的验证了。',
  };
  const final = {
    type: 'agent_message',
    text: '验证完成，构建通过。',
  };

  assert.deepEqual(extractCodexAgentMessage(progress), {
    text: '我开始跑真正的验证了。',
    isProgress: true,
  });
  assert.equal(extractCodexAgentMessageText(progress), '');
  assert.deepEqual(extractCodexAgentMessage(final), {
    text: '验证完成，构建通过。',
    isProgress: false,
  });
  assert.equal(extractCodexAgentMessageText(final), '验证完成，构建通过。');
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

test('ops-style inspection requests force codex execution', () => {
  assert.equal(shouldForceCodexExecution('你看下聊天记录，为什么土豆子管家不干活'), true);
  assert.equal(shouldForceCodexExecution('检查一下飞书机器人回复为什么中断'), true);
  assert.equal(shouldForceCodexExecution('今天吃什么'), false);
});

test('execution guardrail is appended once to codex system prompts', () => {
  const prompt = mergeCodexExecutionGuardrailPrompt('你是土豆子管家。');
  assert.match(prompt, /飞书执行规则/);
  assert.match(prompt, /不要只回复/);
  assert.equal(mergeCodexExecutionGuardrailPrompt(prompt), prompt);
});

test('codex model switch only accepts /model commands', () => {
  assert.equal(parseCodexModelCommand('切到 terra 5.6 high ultra'), null);
  assert.equal(parseCodexModelCommand('当前模型是什么'), null);

  assert.deepEqual(
    parseCodexModelCommand('/model switch gpt-5.6 sol ultra standard'),
    {
      type: 'set',
      model: 'gpt-5.6-sol',
      reasoningEffort: 'xhigh',
      serviceTier: 'default',
      sourceText: '/model switch gpt-5.6 sol ultra standard',
      matchedText: '/modelswitchgpt-5.6solultrastandard',
    }
  );
  assert.deepEqual(
    parseCodexModelCommand('/model switch terra 5.6 high ultra'),
    {
      type: 'set',
      model: 'gpt-5.6-terra',
      reasoningEffort: 'xhigh',
      serviceTier: 'priority',
      sourceText: '/model switch terra 5.6 high ultra',
      matchedText: '/modelswitchterra5.6highultra',
    }
  );
  assert.deepEqual(parseCodexModelCommand('/model'), { type: 'status' });

  const status = buildCodexModelStatus({
    model: 'gpt-5.6-sol',
    reasoningEffort: 'xhigh',
    serviceTier: 'default',
  });
  assert.equal(status.line, '当前模型：gpt-5.6-sol｜强度：ultra/xhigh｜速度：standard/default');
  assert.equal(
    appendCodexModelStatusFooter('好了', status),
    '好了\n\n当前模型：gpt-5.6-sol｜强度：ultra/xhigh｜速度：standard/default'
  );
  assert.equal(
    appendCodexModelStatusFooter(appendCodexModelStatusFooter('好了', status), status),
    '好了\n\n当前模型：gpt-5.6-sol｜强度：ultra/xhigh｜速度：standard/default'
  );
});

test('standalone URL code spans are sent as plain links for Feishu', () => {
  const reply = [
    '正确地址：',
    '`https://example.com/tools/demo/`',
  ].join('\n');

  assert.equal(
    normalizeFeishuDisplayText(reply),
    [
      '正确地址：',
      'https://example.com/tools/demo/',
    ].join('\n')
  );
  assert.equal(shouldRenderFeishuMarkdown(reply), false);
});

test('real inline code still keeps markdown rendering', () => {
  const reply = '运行 `npm test` 就行。';

  assert.equal(normalizeFeishuDisplayText(reply), reply);
  assert.equal(shouldRenderFeishuMarkdown(reply), true);
});

test('trivial execution replies are blocked unless codex observed real work', () => {
  assert.equal(isTrivialCodexExecutionReply('好的'), true);
  assert.equal(isTrivialCodexExecutionReply('我查到原因：Codex 线程续接失败，已经重启。'), false);

  assert.equal(isCodexObservableWorkEvent({
    type: 'item.completed',
    item: { type: 'command_execution' },
  }), true);
  assert.equal(isCodexObservableWorkEvent({
    type: 'item.completed',
    item: { type: 'agent_message' },
  }), false);

  assert.equal(isNonSubstantiveCodexExecutionResult({
    reply: '收到',
    forceExecution: true,
    workEventCount: 0,
  }), true);
  assert.equal(isNonSubstantiveCodexExecutionResult({
    reply: '收到',
    forceExecution: true,
    workEventCount: 1,
  }), false);
  assert.equal(isNonSubstantiveCodexExecutionResult({
    reply: '收到',
    forceExecution: false,
    workEventCount: 0,
  }), false);
});

test('codex exec locks stay per workspace and separate across workspaces', () => {
  const sharedScope = buildCodexExecLockScope({
    cwd: '/Users/example/Code/_feishu_workspaces/bot-a',
    home: '/Users/example/.codex-bot-a',
    profile: 'default',
  });
  const retryScope = buildCodexExecLockScope({
    cwd: '/Users/example/Code/_feishu_workspaces/bot-a',
    home: '/tmp/codex-isolated-123',
    profile: 'default',
  });
  const otherScope = buildCodexExecLockScope({
    cwd: '/Users/example/Code/_feishu_workspaces/bot-b',
    home: '/Users/example/.codex-bot-b',
    profile: 'default',
  });

  assert.equal(sharedScope, '/Users/example/Code/_feishu_workspaces/bot-a');
  assert.equal(retryScope, sharedScope);
  assert.notEqual(otherScope, sharedScope);

  const sharedJsonLock = resolveCodexExecLockDir({
    label: 'codex-json',
    cwd: '/Users/example/Code/_feishu_workspaces/bot-a',
    home: '/Users/example/.codex-bot-a',
  });
  const retryJsonLock = resolveCodexExecLockDir({
    label: 'codex-json',
    cwd: '/Users/example/Code/_feishu_workspaces/bot-a',
    home: '/tmp/codex-isolated-123',
  });
  const otherJsonLock = resolveCodexExecLockDir({
    label: 'codex-json',
    cwd: '/Users/example/Code/_feishu_workspaces/bot-b',
    home: '/Users/example/.codex-bot-b',
  });

  assert.equal(sharedJsonLock, retryJsonLock);
  assert.notEqual(sharedJsonLock, otherJsonLock);
  assert.match(sharedJsonLock, /codex-json-/);
});
