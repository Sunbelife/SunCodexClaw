const test = require('node:test');
const assert = require('node:assert/strict');

const {
  formatCrossChatListReply,
  listRecentChatTargetsFromLogLines,
  parseCrossChatCommand,
  resolveCrossChatTarget,
  summarizeCrossChatMessageItem,
} = require('../tools/feishu_ws_bot.js').__test__;

test('parseCrossChatCommand supports list and show aliases', () => {
  assert.deepEqual(parseCrossChatCommand('/xchat list'), { type: 'list' });
  assert.deepEqual(parseCrossChatCommand('/跨线程 查看 2'), { type: 'show', target: '2' });
  assert.deepEqual(parseCrossChatCommand('/跨会话'), { type: 'help' });
  assert.equal(parseCrossChatCommand('普通消息'), null);
});

test('listRecentChatTargetsFromLogLines keeps latest unique chats first', () => {
  const lines = [
    'FEISHU_EVENT',
    'chat_id=oc_old',
    'chat_type=group',
    'message_type=text',
    'FEISHU_EVENT',
    'chat_id=oc_new',
    'chat_type=p2p',
    'message_type=image',
    'FEISHU_EVENT',
    'chat_id=oc_old',
    'chat_type=group',
    'message_type=file',
  ];
  assert.deepEqual(
    listRecentChatTargetsFromLogLines(lines, 8),
    [
      {
        chatId: 'oc_old',
        chatType: 'group',
        scopeKind: '',
        lastMessageType: 'file',
        lastMessageId: '',
      },
      {
        chatId: 'oc_new',
        chatType: 'p2p',
        scopeKind: '',
        lastMessageType: 'image',
        lastMessageId: '',
      },
    ]
  );
});

test('resolveCrossChatTarget supports current index and suffix lookup', () => {
  const recentTargets = [
    { chatId: 'oc_current' },
    { chatId: 'oc_abc123' },
    { chatId: 'oc_xyz999' },
  ];
  assert.equal(resolveCrossChatTarget('current', recentTargets, 'oc_current'), 'oc_current');
  assert.equal(resolveCrossChatTarget('2', recentTargets, 'oc_current'), 'oc_abc123');
  assert.equal(resolveCrossChatTarget('999', recentTargets, 'oc_current'), 'oc_xyz999');
  assert.equal(resolveCrossChatTarget('missing', recentTargets, 'oc_current'), '');
});

test('summarizeCrossChatMessageItem renders sender and content preview', () => {
  const summary = summarizeCrossChatMessageItem({
    msg_type: 'text',
    body: {
      content: JSON.stringify({ text: '群里的一条消息' }),
    },
    sender: {
      name: '张三',
      sender_type: 'user',
    },
    create_time: String(Date.UTC(2026, 3, 25, 2, 30, 0)),
    thread_id: 'omt-thread-1',
  });

  assert.equal(summary.senderLabel, '张三');
  assert.equal(summary.messageTypeLabel, '文本');
  assert.equal(summary.preview, '群里的一条消息');
  assert.equal(summary.threadId, 'omt-thread-1');
});

test('formatCrossChatListReply marks current chat', () => {
  const text = formatCrossChatListReply([
    { chatId: 'oc_current', chatType: 'group', scopeKind: 'group', lastMessageType: 'text' },
    { chatId: 'oc_other', chatType: 'p2p', scopeKind: '', lastMessageType: 'image' },
  ], 'oc_current');

  assert.match(text, /oc_current（当前）/);
  assert.match(text, /oc_other/);
});
