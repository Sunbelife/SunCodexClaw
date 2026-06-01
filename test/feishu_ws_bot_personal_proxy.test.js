const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildPersonalProxyApprovalCard,
  classifyPersonalProxySensitivity,
  extractPersonalProxyCardAction,
  parsePersonalProxyCommand,
  personalProxyGrantKey,
  personalProxyOwnerMatches,
  resolvePersonalProxyConfig,
} = require('../tools/feishu_ws_bot.js').__test__;

test('personal proxy config is opt-in and reads 9B settings', () => {
  const config = {
    personal_proxy: {
      enabled: true,
      owner_bind_command: '/proxy bind-owner',
      sensitivity_mode: 'conservative',
      approval_ttl_minutes: 30,
    },
  };
  const proxy = resolvePersonalProxyConfig(config, 'fei-qwen-local');
  assert.equal(proxy.enabled, true);
  assert.equal(proxy.ownerBindCommand, '/proxy bind-owner');
  assert.equal(proxy.sensitivityMode, 'conservative');
  assert.equal(proxy.approvalTtlMinutes, 30);
  assert.equal(resolvePersonalProxyConfig({}, 'fei-prd').enabled, false);
});

test('personal proxy command parser supports bind and approval fallbacks', () => {
  const proxy = { ownerBindCommand: '/proxy bind-owner' };
  assert.deepEqual(parsePersonalProxyCommand('/proxy bind-owner', proxy), { type: 'bind_owner' });
  assert.deepEqual(parsePersonalProxyCommand('/proxy approve pp_123', proxy), {
    type: 'approve_once',
    approvalID: 'pp_123',
  });
  assert.deepEqual(parsePersonalProxyCommand('/proxy approve-session pp_123', proxy), {
    type: 'approve_session',
    approvalID: 'pp_123',
  });
  assert.deepEqual(parsePersonalProxyCommand('/proxy deny pp_123', proxy), {
    type: 'deny',
    approvalID: 'pp_123',
  });
  assert.equal(parsePersonalProxyCommand('hello', proxy), null);
});

test('conservative sensitivity catches private business and code requests', () => {
  const sensitive = classifyPersonalProxySensitivity('查一下老孙店后台订单、客户信息和仓库代码');
  assert.equal(sensitive.sensitive, true);
  assert.ok(sensitive.labels.includes('finance'));
  assert.ok(sensitive.labels.includes('customer'));
  assert.ok(sensitive.labels.includes('code'));

  const ordinary = classifyPersonalProxySensitivity('你是谁，今天能帮什么');
  assert.equal(ordinary.sensitive, false);
});

test('owner matching accepts bound open id and rejects other users', () => {
  const owner = {
    openId: 'ou_owner',
    userId: 'user_owner',
    chatID: 'oc_owner',
    chatType: 'p2p',
  };
  assert.equal(personalProxyOwnerMatches(owner, { openId: 'ou_owner', senderType: 'user' }), true);
  assert.equal(personalProxyOwnerMatches(owner, { openId: 'ou_other', senderType: 'user' }), false);
  assert.equal(personalProxyOwnerMatches(owner, {}, 'oc_owner'), true);
});

test('session grant key is scoped by chat, sender, and sensitivity labels', () => {
  const one = personalProxyGrantKey({
    chatID: 'oc_1',
    senderIdentity: { openId: 'ou_user' },
    sensitivity: { labels: ['code', 'finance'] },
  });
  const two = personalProxyGrantKey({
    chatID: 'oc_1',
    senderIdentity: { openId: 'ou_user' },
    sensitivity: { labels: ['finance', 'code'] },
  });
  const otherSender = personalProxyGrantKey({
    chatID: 'oc_1',
    senderIdentity: { openId: 'ou_other' },
    sensitivity: { labels: ['code', 'finance'] },
  });
  assert.equal(one, two);
  assert.notEqual(one, otherSender);
});

test('card action extractor recognizes personal proxy approval cards', () => {
  const action = extractPersonalProxyCardAction({
    action: {
      value: {
        kind: 'personal_proxy_approval',
        approval_id: 'pp_123',
        decision: 'approve_once',
      },
    },
    operator: {
      open_id: 'ou_owner',
      user_id: 'user_owner',
    },
  });
  assert.equal(action.approvalID, 'pp_123');
  assert.equal(action.decision, 'approve_once');
  assert.equal(action.actorIdentity.openId, 'ou_owner');
});

test('card action extractor reads top-level callback identities', () => {
  const action = extractPersonalProxyCardAction({
    event: {
      action: {
        value: JSON.stringify({
          kind: 'personal_proxy_approval',
          approval_id: 'pp_456',
          decision: 'deny',
        }),
      },
      open_message_id: 'om_card_1',
      open_id: 'ou_owner',
      user_id: 'user_owner',
    },
  });
  assert.equal(action.approvalID, 'pp_456');
  assert.equal(action.decision, 'deny');
  assert.equal(action.approvalCardMessageID, 'om_card_1');
  assert.equal(action.actorIdentity.openId, 'ou_owner');
});

test('approval card is shared-updateable and becomes read-only after decision', () => {
  const request = {
    approval_id: 'pp_card_1',
    chat_id: 'oc_source',
    sender: { openId: 'ou_sender' },
    sensitivity: { reasons: ['可能涉及客户信息'] },
    user_text_preview: '查一下客户订单',
  };
  const pending = buildPersonalProxyApprovalCard(request, { botName: '老孙的呆子助理' });
  assert.equal(pending.config.update_multi, true);
  assert.ok(pending.elements.some((element) => element.tag === 'action'));

  const approved = buildPersonalProxyApprovalCard(request, { botName: '老孙的呆子助理' }, {
    status: 'approve_once',
    actorIdentity: { openId: 'ou_owner' },
    decidedAt: 1710000000000,
  });
  assert.equal(approved.config.update_multi, true);
  assert.equal(approved.header.template, 'green');
  assert.match(JSON.stringify(approved), /已允许一次/);
  assert.equal(approved.elements.some((element) => element.tag === 'action'), false);
});
