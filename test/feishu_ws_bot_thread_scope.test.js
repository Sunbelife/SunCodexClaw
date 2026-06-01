const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildDispatchEnvelope,
  buildConversationScope,
  buildAccessibleThreadContext,
  ensureChatState,
  getCurrentThread,
  handleThreadCommand,
  registerActorChatState,
} = require('../tools/feishu_ws_bot.js').__test__;

test('same sender keeps chat-scoped threads but shares one actor key across group and p2p chats', () => {
  const senderIdentity = {
    openId: 'ou_user_1',
    senderType: 'user',
  };

  const groupScope = buildConversationScope('oc_group_1', 'group', senderIdentity, 'msg-group');
  const p2pScope = buildConversationScope('oc_p2p_1', 'p2p', senderIdentity, 'msg-p2p');

  assert.equal(groupScope.kind, 'group_chat');
  assert.equal(p2pScope.kind, 'p2p');
  assert.notEqual(groupScope.stateKey, p2pScope.stateKey);
  assert.notEqual(groupScope.key, p2pScope.key);
  assert.equal(groupScope.actorKey, p2pScope.actorKey);
});

test('different senders in the same group share chat scope but keep separate actor keys', () => {
  const aliceScope = buildConversationScope('oc_group_1', 'group', {
    openId: 'ou_alice',
    senderType: 'user',
  });
  const bobScope = buildConversationScope('oc_group_1', 'group', {
    openId: 'ou_bob',
    senderType: 'user',
  });

  assert.equal(aliceScope.stateKey, bobScope.stateKey);
  assert.equal(aliceScope.key, bobScope.key);
  assert.notEqual(aliceScope.actorKey, bobScope.actorKey);
});

test('missing sender identity falls back to chat-scoped threads', () => {
  const groupScope = buildConversationScope('oc_group_1', 'group', {
    senderType: 'user',
  });
  const p2pScope = buildConversationScope('oc_p2p_1', 'p2p', {
    senderType: 'user',
  });

  assert.equal(groupScope.kind, 'group_chat');
  assert.equal(groupScope.stateKey, 'oc_group_1');
  assert.equal(p2pScope.kind, 'p2p');
  assert.equal(p2pScope.stateKey, 'oc_p2p_1');
});

test('thread state stays isolated between group and p2p chats for the same sender', () => {
  const chatStates = new Map();
  const senderIdentity = {
    openId: 'ou_user_1',
    senderType: 'user',
  };
  const groupScope = buildConversationScope('oc_group_1', 'group', senderIdentity, 'msg-group');
  const p2pScope = buildConversationScope('oc_p2p_1', 'p2p', senderIdentity, 'msg-p2p');

  const groupState = ensureChatState(chatStates, groupScope.stateKey);
  const createResult = handleThreadCommand(groupState, {
    type: 'new',
    name: '合同跟进',
  });

  assert.equal(createResult.handled, true);
  assert.equal(groupState.currentThreadId, 't2');

  const p2pState = ensureChatState(chatStates, p2pScope.stateKey);
  assert.notEqual(p2pState, groupState);

  const currentThread = getCurrentThread(p2pState);
  assert.ok(currentThread);
  assert.equal(currentThread.id, 't1');
  assert.equal(currentThread.name, '主线程');
});

test('dispatch envelopes keep independent task keys across chats for the same sender', () => {
  const sender = {
    name: '老孙',
    sender_id: {
      open_id: 'ou_user_1',
    },
    sender_type: 'user',
  };
  const groupEnvelope = buildDispatchEnvelope({
    sender,
    message: {
      chat_id: 'oc_group_1',
      chat_type: 'group',
      message_id: 'msg-group',
      message_type: 'text',
      content: JSON.stringify({ text: '@机器人 群里先开个头' }),
      mentions: [],
    },
  }, {
    mentionAliases: ['机器人'],
    recentTextInputs: new Map(),
    recentAttachmentInputs: new Map(),
  });
  const p2pEnvelope = buildDispatchEnvelope({
    sender,
    message: {
      chat_id: 'oc_p2p_1',
      chat_type: 'p2p',
      message_id: 'msg-p2p',
      message_type: 'text',
      content: JSON.stringify({ text: '私聊继续' }),
      mentions: [],
    },
  }, {
    mentionAliases: ['机器人'],
    recentTextInputs: new Map(),
    recentAttachmentInputs: new Map(),
  });

  assert.notEqual(groupEnvelope.taskKey, p2pEnvelope.taskKey);
});

test('accessible thread context reads sibling chat threads for the same sender', () => {
  const chatStates = new Map();
  const actorChatIndex = new Map();
  const actorKey = 'actor:open:ou_user_1';
  const groupState = ensureChatState(chatStates, 'oc_group_1', {
    chatID: 'oc_group_1',
    chatType: 'group',
    actorKey,
    now: 1_000,
  });
  handleThreadCommand(groupState, {
    type: 'new',
    name: '合同跟进',
  });
  const groupThread = getCurrentThread(groupState);
  groupThread.history = [
    { role: 'user', text: '把合同改成 10 台机器' },
    { role: 'assistant', text: '好的，我先按这个方向改。' },
  ];
  groupThread.updatedAt = 2_000;
  registerActorChatState(actorChatIndex, actorKey, 'oc_group_1');

  const p2pState = ensureChatState(chatStates, 'oc_p2p_1', {
    chatID: 'oc_p2p_1',
    chatType: 'p2p',
    actorKey,
    now: 3_000,
  });
  registerActorChatState(actorChatIndex, actorKey, 'oc_p2p_1');

  const context = buildAccessibleThreadContext(chatStates, actorChatIndex, {
    actorKey,
    currentStateKey: 'oc_p2p_1',
    currentThread: getCurrentThread(p2pState),
    userText: '继续刚才群里的那个事',
  });

  assert.match(context.promptText, /oc_group_1/);
  assert.match(context.promptText, /合同跟进/);
  assert.match(context.promptText, /把合同改成 10 台机器/);
  assert.equal(context.sources.length, 1);
});
