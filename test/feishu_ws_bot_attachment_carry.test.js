const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');

const {
  FEISHU_ATTACHMENT_TEXT_CARRY_WINDOW_MS,
  buildAttachmentBundle,
  buildRecentChatContextFromMessageItems,
  buildDispatchEnvelope,
  extractAttachmentBundleFromMessageItem,
  findRecentAttachmentBundleFromMessageItems,
  normalizeFeishuResourceDownloadError,
  resolveLiveRecentAttachmentBundle,
  selectAttachmentSource,
} = require('../tools/feishu_ws_bot.js').__test__;

function withFakeNow(timestamp, fn) {
  const originalNow = Date.now;
  Date.now = () => timestamp;
  try {
    return fn();
  } finally {
    Date.now = originalNow;
  }
}

function makeEvent({
  messageID,
  messageType,
  content,
  chatID = 'chat-1',
  chatType = 'group',
  senderOpenID = 'ou_user_1',
  senderUserID = '',
  senderUnionID = '',
  senderName = '',
  mentions = [],
} = {}) {
  return {
    sender: {
      name: senderName,
      sender_id: {
        open_id: senderOpenID,
        user_id: senderUserID,
        union_id: senderUnionID,
      },
      sender_type: 'user',
    },
    message: {
      chat_id: chatID,
      chat_type: chatType,
      message_id: messageID,
      message_type: messageType,
      content,
      mentions,
    },
  };
}

test('group image before mention can be paired as recent attachment', () => {
  const recentTextInputs = new Map();
  const recentAttachmentInputs = new Map();

  withFakeNow(1_000, () => {
    buildDispatchEnvelope(
      makeEvent({
        messageID: 'img-1',
        messageType: 'image',
        content: JSON.stringify({ image_key: 'imgk-1' }),
      }),
      {
        mentionAliases: ['机器人'],
        recentTextInputs,
        recentAttachmentInputs,
      }
    );
  });

  const envelope = withFakeNow(2_000, () => {
    return buildDispatchEnvelope(
      makeEvent({
        messageID: 'txt-1',
        messageType: 'text',
        content: JSON.stringify({ text: '@机器人 看一下这张图' }),
      }),
      {
        mentionAliases: ['机器人'],
        recentTextInputs,
        recentAttachmentInputs,
      }
    );
  });

  assert.equal(envelope.payload.dispatchMeta.allowAttachmentCarry, true);
  assert.deepEqual(
    envelope.payload.dispatchMeta.recentAttachments.imageItems.map((item) => item.imageKey),
    ['imgk-1']
  );
});

test('group file before mention can be paired as recent attachment', () => {
  const recentTextInputs = new Map();
  const recentAttachmentInputs = new Map();

  withFakeNow(1_000, () => {
    buildDispatchEnvelope(
      makeEvent({
        messageID: 'file-1',
        messageType: 'file',
        content: JSON.stringify({
          file_key: 'filek-1',
          file_name: 'report.pdf',
          file_size: 1024,
        }),
      }),
      {
        mentionAliases: ['机器人'],
        recentTextInputs,
        recentAttachmentInputs,
      }
    );
  });

  const envelope = withFakeNow(2_000, () => {
    return buildDispatchEnvelope(
      makeEvent({
        messageID: 'txt-1',
        messageType: 'text',
        content: JSON.stringify({ text: '@机器人 帮我看这个文件' }),
      }),
      {
        mentionAliases: ['机器人'],
        recentTextInputs,
        recentAttachmentInputs,
      }
    );
  });

  assert.equal(envelope.payload.dispatchMeta.allowAttachmentCarry, true);
  assert.deepEqual(
    envelope.payload.dispatchMeta.recentAttachments.fileItems.map((item) => item.fileKey),
    ['filek-1']
  );
});

test('group attachment carry still works when sender ids are missing', () => {
  const recentTextInputs = new Map();
  const recentAttachmentInputs = new Map();

  withFakeNow(1_000, () => {
    buildDispatchEnvelope(
      makeEvent({
        messageID: 'file-1',
        messageType: 'file',
        senderOpenID: '',
        senderUserID: '',
        senderUnionID: '',
        senderName: '',
        content: JSON.stringify({
          file_key: 'filek-1',
          file_name: 'report.pdf',
        }),
      }),
      {
        mentionAliases: ['机器人'],
        recentTextInputs,
        recentAttachmentInputs,
      }
    );
  });

  const envelope = withFakeNow(2_000, () => {
    return buildDispatchEnvelope(
      makeEvent({
        messageID: 'txt-1',
        messageType: 'text',
        senderOpenID: '',
        senderUserID: '',
        senderUnionID: '',
        senderName: '',
        content: JSON.stringify({ text: '@机器人 帮我看这个文件' }),
      }),
      {
        mentionAliases: ['机器人'],
        recentTextInputs,
        recentAttachmentInputs,
      }
    );
  });

  assert.equal(envelope.payload.dispatchMeta.allowAttachmentCarry, true);
  assert.deepEqual(
    envelope.payload.dispatchMeta.recentAttachments.fileItems.map((item) => item.fileKey),
    ['filek-1']
  );
});

test('multiple recent attachments are merged in chronological order', () => {
  const recentTextInputs = new Map();
  const recentAttachmentInputs = new Map();

  withFakeNow(1_000, () => {
    buildDispatchEnvelope(
      makeEvent({
        messageID: 'img-1',
        messageType: 'image',
        content: JSON.stringify({ image_key: 'imgk-1' }),
      }),
      {
        mentionAliases: ['机器人'],
        recentTextInputs,
        recentAttachmentInputs,
      }
    );
  });

  withFakeNow(2_000, () => {
    buildDispatchEnvelope(
      makeEvent({
        messageID: 'file-1',
        messageType: 'file',
        content: JSON.stringify({
          file_key: 'filek-1',
          file_name: 'notes.txt',
          text: '文件说明',
        }),
      }),
      {
        mentionAliases: ['机器人'],
        recentTextInputs,
        recentAttachmentInputs,
      }
    );
  });

  const envelope = withFakeNow(2_500, () => {
    return buildDispatchEnvelope(
      makeEvent({
        messageID: 'txt-1',
        messageType: 'text',
        content: JSON.stringify({ text: '@机器人 一起看一下' }),
      }),
      {
        mentionAliases: ['机器人'],
        recentTextInputs,
        recentAttachmentInputs,
      }
    );
  });

  assert.equal(envelope.payload.dispatchMeta.allowAttachmentCarry, true);
  assert.deepEqual(
    envelope.payload.dispatchMeta.recentAttachments.sourceMessageIDs,
    ['img-1', 'file-1']
  );
  assert.deepEqual(
    envelope.payload.dispatchMeta.recentAttachments.textSegments,
    ['文件说明']
  );
});

test('attachments older than carry window are not paired', () => {
  const recentTextInputs = new Map();
  const recentAttachmentInputs = new Map();

  withFakeNow(1_000, () => {
    buildDispatchEnvelope(
      makeEvent({
        messageID: 'img-1',
        messageType: 'image',
        content: JSON.stringify({ image_key: 'imgk-1' }),
      }),
      {
        mentionAliases: ['机器人'],
        recentTextInputs,
        recentAttachmentInputs,
      }
    );
  });

  const envelope = withFakeNow(1_000 + FEISHU_ATTACHMENT_TEXT_CARRY_WINDOW_MS + 1, () => {
    return buildDispatchEnvelope(
      makeEvent({
        messageID: 'txt-1',
        messageType: 'text',
        content: JSON.stringify({ text: '@机器人 看一下' }),
      }),
      {
        mentionAliases: ['机器人'],
        recentTextInputs,
        recentAttachmentInputs,
      }
    );
  });

  assert.equal(envelope.payload.dispatchMeta.allowAttachmentCarry, false);
  assert.equal(envelope.payload.dispatchMeta.recentAttachments, null);
});

test('attachments do not cross between different senders', () => {
  const recentTextInputs = new Map();
  const recentAttachmentInputs = new Map();

  withFakeNow(1_000, () => {
    buildDispatchEnvelope(
      makeEvent({
        messageID: 'img-1',
        messageType: 'image',
        senderOpenID: 'ou_user_1',
        content: JSON.stringify({ image_key: 'imgk-1' }),
      }),
      {
        mentionAliases: ['机器人'],
        recentTextInputs,
        recentAttachmentInputs,
      }
    );
  });

  const envelope = withFakeNow(2_000, () => {
    return buildDispatchEnvelope(
      makeEvent({
        messageID: 'txt-1',
        messageType: 'text',
        senderOpenID: 'ou_user_2',
        content: JSON.stringify({ text: '@机器人 看一下' }),
      }),
      {
        mentionAliases: ['机器人'],
        recentTextInputs,
        recentAttachmentInputs,
      }
    );
  });

  assert.equal(envelope.payload.dispatchMeta.allowAttachmentCarry, false);
  assert.equal(envelope.payload.dispatchMeta.recentAttachments, null);
});

test('quoted attachment is preferred over recent attachment carry', () => {
  const quotedAttachmentBundle = extractAttachmentBundleFromMessageItem(
    {
      message_id: 'quoted-1',
      msg_type: 'file',
      body: {
        content: JSON.stringify({
          file_key: 'filek-quoted',
          file_name: 'quoted.txt',
        }),
      },
    },
    { mentionAliases: ['机器人'], timestamp: 3_000 }
  );
  const recentAttachmentBundle = buildAttachmentBundle({
    messageType: 'image',
    messageID: 'recent-1',
    timestamp: 2_000,
    imageItems: [{ messageID: 'recent-1', imageKey: 'imgk-recent' }],
  });

  const selection = selectAttachmentSource({
    currentAttachmentBundle: null,
    quotedAttachmentBundle,
    recentAttachmentBundle,
  });

  assert.equal(selection.source, 'quoted_attachment');
  assert.deepEqual(
    selection.bundle.fileItems.map((item) => item.fileKey),
    ['filek-quoted']
  );
});

test('captured recent attachment is ignored after its live carry is consumed', () => {
  const capturedBundle = buildAttachmentBundle({
    messageType: 'file',
    messageID: 'file-1',
    timestamp: 1_000,
    fileItems: [{ messageID: 'file-1', fileKey: 'filek-1', fileName: 'report.zip' }],
  });

  assert.deepEqual(
    resolveLiveRecentAttachmentBundle(capturedBundle, capturedBundle)?.sourceMessageIDs,
    ['file-1']
  );
  assert.equal(resolveLiveRecentAttachmentBundle(capturedBundle, null), null);
});

test('Feishu oversized resource errors are normalized from streamed API bodies', async () => {
  const original = new Error('Request failed with status code 400');
  original.response = {
    status: 400,
    data: Readable.from([
      JSON.stringify({
        code: 234037,
        msg: 'Downloaded file size exceeds limit.',
      }),
    ]),
  };

  const normalized = await normalizeFeishuResourceDownloadError(original);

  assert.equal(normalized.feishuApiCode, '234037');
  assert.equal(normalized.feishuResourceFailure, 'file_size_exceeds_limit');
  assert.match(normalized.message, /Downloaded file size exceeds limit/);
});

test('history fallback can recover a missed file event from recent chat messages', () => {
  const historyBundle = findRecentAttachmentBundleFromMessageItems(
    [
      {
        message_id: 'bot-later',
        msg_type: 'text',
        create_time: '21000',
        sender: {
          id: 'cli_bot',
          id_type: 'app_id',
          sender_type: 'app',
        },
        body: {
          content: JSON.stringify({ text: 'bot reply' }),
        },
      },
      {
        message_id: 'txt-1',
        msg_type: 'text',
        create_time: '20000',
        sender: {
          id: 'ou_user_1',
          id_type: 'open_id',
          sender_type: 'user',
        },
        body: {
          content: JSON.stringify({ text: '@机器人 帮我看一下' }),
        },
      },
      {
        message_id: 'file-1',
        msg_type: 'file',
        create_time: '19000',
        sender: {
          id: 'ou_user_1',
          id_type: 'open_id',
          sender_type: 'user',
        },
        body: {
          content: JSON.stringify({
            file_key: 'filek-1',
            file_name: 'contract.docx',
          }),
        },
      },
      {
        message_id: 'file-too-old',
        msg_type: 'file',
        create_time: String(20000 - FEISHU_ATTACHMENT_TEXT_CARRY_WINDOW_MS - 1),
        sender: {
          id: 'ou_user_1',
          id_type: 'open_id',
          sender_type: 'user',
        },
        body: {
          content: JSON.stringify({
            file_key: 'filek-old',
            file_name: 'old.docx',
          }),
        },
      },
    ],
    {
      currentMessageID: 'txt-1',
      currentSenderIdentity: { openId: 'ou_user_1', senderType: 'user' },
      mentionAliases: ['机器人'],
      currentMessageTimestamp: 20000,
    }
  );

  assert.ok(historyBundle);
  assert.deepEqual(
    historyBundle.fileItems.map((item) => item.fileKey),
    ['filek-1']
  );
});

test('recent group chat context includes prior text and file summaries', () => {
  const context = buildRecentChatContextFromMessageItems(
    [
      {
        message_id: 'current',
        msg_type: 'text',
        create_time: '3000',
        sender: {
          id: 'ou_user_1',
          id_type: 'open_id',
          sender_type: 'user',
          name: '老孙',
        },
        body: {
          content: JSON.stringify({ text: '@机器人 总结一下上面' }),
        },
      },
      {
        message_id: 'file-1',
        msg_type: 'file',
        create_time: '2000',
        sender: {
          id: 'ou_user_2',
          id_type: 'open_id',
          sender_type: 'user',
          name: '同事',
        },
        body: {
          content: JSON.stringify({
            file_key: 'filek-1',
            file_name: 'quote.xlsx',
          }),
        },
      },
      {
        message_id: 'txt-1',
        msg_type: 'text',
        create_time: '1000',
        sender: {
          id: 'ou_user_1',
          id_type: 'open_id',
          sender_type: 'user',
          name: '老孙',
        },
        body: {
          content: JSON.stringify({ text: '先看一下报价表' }),
        },
      },
    ],
    {
      currentMessageID: 'current',
      currentMessageTimestamp: 3000,
    }
  );

  assert.equal(context.count, 2);
  assert.match(context.promptText, /先看一下报价表/);
  assert.match(context.promptText, /文件：quote\.xlsx/);
  assert.doesNotMatch(context.promptText, /总结一下上面/);
});

test('history fallback does not cross senders', () => {
  const historyBundle = findRecentAttachmentBundleFromMessageItems(
    [
      {
        message_id: 'txt-1',
        msg_type: 'text',
        create_time: '3000',
        sender: {
          id: 'ou_user_2',
          id_type: 'open_id',
          sender_type: 'user',
        },
        body: {
          content: JSON.stringify({ text: '@机器人 帮我看一下' }),
        },
      },
      {
        message_id: 'file-1',
        msg_type: 'file',
        create_time: '2500',
        sender: {
          id: 'ou_user_1',
          id_type: 'open_id',
          sender_type: 'user',
        },
        body: {
          content: JSON.stringify({
            file_key: 'filek-1',
            file_name: 'contract.docx',
          }),
        },
      },
    ],
    {
      currentMessageID: 'txt-1',
      currentSenderIdentity: { openId: 'ou_user_2', senderType: 'user' },
      mentionAliases: ['机器人'],
      currentMessageTimestamp: 3000,
    }
  );

  assert.equal(historyBundle, null);
});

test('history attachment source is selected after current quoted and recent sources', () => {
  const historyAttachmentBundle = buildAttachmentBundle({
    messageType: 'file',
    messageID: 'history-1',
    timestamp: 2_000,
    fileItems: [{ messageID: 'history-1', fileKey: 'filek-history', fileName: 'history.txt' }],
  });

  const selection = selectAttachmentSource({
    currentAttachmentBundle: null,
    quotedAttachmentBundle: null,
    recentAttachmentBundle: null,
    historyAttachmentBundle,
  });

  assert.equal(selection.source, 'history_attachment_pair');
  assert.deepEqual(
    selection.bundle.fileItems.map((item) => item.fileKey),
    ['filek-history']
  );
});

test('existing text before attachment carry still works', () => {
  const recentTextInputs = new Map();
  const recentAttachmentInputs = new Map();

  withFakeNow(1_000, () => {
    buildDispatchEnvelope(
      makeEvent({
        messageID: 'txt-1',
        messageType: 'text',
        content: JSON.stringify({ text: '@机器人 帮我看看这张图' }),
      }),
      {
        mentionAliases: ['机器人'],
        recentTextInputs,
        recentAttachmentInputs,
      }
    );
  });

  const envelope = withFakeNow(2_000, () => {
    return buildDispatchEnvelope(
      makeEvent({
        messageID: 'img-1',
        messageType: 'image',
        content: JSON.stringify({ image_key: 'imgk-1' }),
      }),
      {
        mentionAliases: ['机器人'],
        recentTextInputs,
        recentAttachmentInputs,
      }
    );
  });

  assert.equal(envelope.payload.dispatchMeta.allowTextCarry, true);
  assert.equal(envelope.payload.dispatchMeta.recentTextMessageID, 'txt-1');
  assert.equal(envelope.payload.dispatchMeta.recentText, '帮我看看这张图');
});

test('text before attachment carry still works when sender ids are missing', () => {
  const recentTextInputs = new Map();
  const recentAttachmentInputs = new Map();

  withFakeNow(1_000, () => {
    buildDispatchEnvelope(
      makeEvent({
        messageID: 'txt-1',
        messageType: 'text',
        senderOpenID: '',
        senderUserID: '',
        senderUnionID: '',
        senderName: '',
        content: JSON.stringify({ text: '@机器人 帮我看看这张图' }),
      }),
      {
        mentionAliases: ['机器人'],
        recentTextInputs,
        recentAttachmentInputs,
      }
    );
  });

  const envelope = withFakeNow(2_000, () => {
    return buildDispatchEnvelope(
      makeEvent({
        messageID: 'img-1',
        messageType: 'image',
        senderOpenID: '',
        senderUserID: '',
        senderUnionID: '',
        senderName: '',
        content: JSON.stringify({ image_key: 'imgk-1' }),
      }),
      {
        mentionAliases: ['机器人'],
        recentTextInputs,
        recentAttachmentInputs,
      }
    );
  });

  assert.equal(envelope.payload.dispatchMeta.allowTextCarry, true);
  assert.equal(envelope.payload.dispatchMeta.recentTextMessageID, 'txt-1');
  assert.equal(envelope.payload.dispatchMeta.recentText, '帮我看看这张图');
});

test('plain text remains unaffected when there is no attachment carry', () => {
  const envelope = withFakeNow(1_000, () => {
    return buildDispatchEnvelope(
      makeEvent({
        messageID: 'txt-1',
        messageType: 'text',
        content: JSON.stringify({ text: '普通文本消息' }),
      }),
      {
        mentionAliases: ['机器人'],
        recentTextInputs: new Map(),
        recentAttachmentInputs: new Map(),
      }
    );
  });

  assert.equal(envelope.payload.dispatchMeta.allowTextCarry, false);
  assert.equal(envelope.payload.dispatchMeta.allowAttachmentCarry, false);
  assert.equal(envelope.payload.dispatchMeta.recentAttachments, null);
});

test('p2p plain follow-up supersedes active work so the latest instruction wins', () => {
  const envelope = withFakeNow(1_000, () => {
    return buildDispatchEnvelope(
      makeEvent({
        messageID: 'txt-1',
        messageType: 'text',
        chatType: 'p2p',
        content: JSON.stringify({ text: '这是新的补充，以这条为准' }),
      }),
      {
        mentionAliases: ['机器人'],
        recentTextInputs: new Map(),
        recentAttachmentInputs: new Map(),
      }
    );
  });

  assert.equal(envelope.shouldSupersedeActiveTask, true);
});

test('p2p attachment companion still supersedes so file and text merge into one task', () => {
  const recentTextInputs = new Map();
  const recentAttachmentInputs = new Map();

  withFakeNow(1_000, () => {
    buildDispatchEnvelope(
      makeEvent({
        messageID: 'file-1',
        messageType: 'file',
        chatType: 'p2p',
        content: JSON.stringify({
          file_key: 'filek-1',
          file_name: 'report.pdf',
          file_size: 1024,
        }),
      }),
      {
        mentionAliases: ['机器人'],
        recentTextInputs,
        recentAttachmentInputs,
      }
    );
  });

  const envelope = withFakeNow(2_000, () => {
    return buildDispatchEnvelope(
      makeEvent({
        messageID: 'txt-1',
        messageType: 'text',
        chatType: 'p2p',
        content: JSON.stringify({ text: '帮我看这个文件' }),
      }),
      {
        mentionAliases: ['机器人'],
        recentTextInputs,
        recentAttachmentInputs,
      }
    );
  });

  assert.equal(envelope.payload.dispatchMeta.allowAttachmentCarry, true);
  assert.equal(envelope.shouldSupersedeActiveTask, true);
});
