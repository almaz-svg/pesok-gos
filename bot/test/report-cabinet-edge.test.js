import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DATA_MODE = 'api';
process.env.API_BASE_URL = 'http://cabinet-api.test/api';
const { createBot } = await import('../src/bot.js');

function report(overrides = {}) {
  return {
    id: 'REP-1',
    telegramUserId: '101',
    status: 'signal_received',
    createdAt: '2026-09-20T12:00:00Z',
    updatedAt: '2026-09-25T12:00:00Z',
    description: 'Excavation near the road',
    lat: 51.1693,
    lon: 71.4492,
    telegramFileId: 'saved-photo',
    ...overrides,
  };
}

function backend(t, respond) {
  const requests = t.mock.method(globalThis, 'fetch', respond);
  t.after(() => {
    for (const { arguments: [url, options] } of requests.mock.calls) {
      assert.equal(url, 'http://cabinet-api.test/api/reports?telegramUserId=101');
      assert.equal(options.method || 'GET', 'GET');
    }
  });
  return requests;
}

function conversation() {
  const bot = createBot('test-token', { apiRoot: 'http://127.0.0.1:1' }, { preferences: { getLanguage: async () => 'ru' } });
  bot.botInfo = { id: 1, is_bot: true, first_name: 'Test', username: 'test_bot' };
  bot.catch(error => { throw error; });
  const replies = [];
  const photos = [];
  const user = { id: 101, is_bot: false, first_name: 'Test' };
  const chat = { id: 101, type: 'private' };
  let updateId = 0;
  let answeredCallbacks = 0;
  bot.context.reply = async (text, extra) => { replies.push({ text, extra }); };
  bot.context.replyWithPhoto = async (photo, extra) => { photos.push({ photo, extra }); };
  bot.context.answerCbQuery = async () => { answeredCallbacks += 1; };
  return {
    replies, photos,
    get answeredCallbacks() { return answeredCallbacks; },
    async openCabinet() {
      await bot.handleUpdate({ update_id: ++updateId, message: {
        message_id: updateId, date: 0, chat, from: user, text: '/reports',
        entities: [{ type: 'bot_command', offset: 0, length: 8 }],
      } });
    },
    async click(data) {
      await bot.handleUpdate({ update_id: ++updateId, callback_query: {
        id: String(updateId), from: user, chat_instance: 'test', data,
        message: { message_id: 1, date: 0, chat, text: 'Cabinet' },
      } });
    },
  };
}

function buttons(reply) {
  return reply?.extra?.reply_markup?.inline_keyboard?.flat() || [];
}

function callback(reply, data) {
  const button = buttons(reply).find(item => item.callback_data === data);
  assert.ok(button, `Expected a usable ${data} button`);
  return button.callback_data;
}

test('a failed API request recovers through the returned retry button', async t => {
  let unavailable = true;
  const requests = backend(t, async () => unavailable
    ? Response.json({ error: { message: 'Backend temporarily unavailable' } }, { status: 503 })
    : Response.json({ reports: [report()] }));
  const chat = conversation();

  await chat.openCabinet();
  const failure = chat.replies.at(-1);
  assert.match(failure.text, /temporarily unavailable/);
  assert.ok(!buttons(failure).some(button => button.callback_data?.startsWith('reports:open:')));
  const retry = callback(failure, 'reports:page:0');

  unavailable = false;
  await chat.click(retry);
  assert.equal(chat.replies.length, 2);
  assert.match(chat.replies.at(-1).text, /Excavation near the road/);
  callback(chat.replies.at(-1), 'reports:open:REP-1');
  assert.equal(requests.mock.callCount(), 2);
  assert.equal(chat.answeredCallbacks, 1);
});

test('long API cards fit Telegram UTF-16 limits and omit unavailable map and photo actions', async t => {
  const coordinates = [
    { lat: 91, lon: 71 },
    { lat: 51, lon: -181 },
    { lat: '51.1693', lon: '71.4492' },
    { lat: null, lon: null },
    {},
  ];
  const records = coordinates.map((location, index) => report({
    id: `REP-${index + 1}`,
    description: `DESCRIPTION ${'\u{1F4CD}'.repeat(2500)}`,
    explanation: `EXPLANATION ${'\u{1F4CD}'.repeat(2500)}`,
    nextStep: `NEXT STEP ${'\u{1F4CD}'.repeat(2500)}`,
    telegramFileId: undefined,
    lat: undefined,
    lon: undefined,
    ...location,
  }));
  backend(t, async () => Response.json({ reports: records }));
  const chat = conversation();
  await chat.openCabinet();
  const list = chat.replies.at(-1);

  for (const record of records) {
    await chat.click(callback(list, `reports:open:${record.id}`));
    const card = chat.replies.at(-1);
    assert.ok(card.text.length <= 4096, `${record.id} exceeds 4096 UTF-16 code units`);
    assert.equal(card.text.isWellFormed(), true, 'Truncation must not split surrogate pairs');
    for (const field of ['DESCRIPTION', 'EXPLANATION', 'NEXT STEP']) {
      assert.ok(card.text.includes(field), `Card must retain ${field}`);
    }
    assert.ok(!buttons(card).some(button => button.url), 'Invalid coordinates must not offer a map');
    assert.ok(!buttons(card).some(button => button.callback_data?.startsWith('reports:photo:')));
    callback(card, 'reports:page:0');
  }
  assert.equal(chat.photos.length, 0);
  assert.equal(chat.answeredCallbacks, records.length);
});

test('an unknown API status does not imply approval or government receipt in the list or card', async t => {
  backend(t, async () => Response.json({ reports: [report({ status: 'awaiting_import' })] }));
  const chat = conversation();
  await chat.openCabinet();
  await chat.click(callback(chat.replies.at(-1), 'reports:open:REP-1'));

  assert.equal(chat.replies.length, 2);
  for (const reply of chat.replies) {
    assert.match(reply.text, /уточня|неизвест|не указан/i);
    assert.doesNotMatch(reply.text, /одобрен|принят|получен|передан|зарегистрирован/i);
    assert.doesNotMatch(reply.text, /awaiting_import/);
  }
  callback(chat.replies.at(-1), 'reports:open:REP-1');
});

test('a stale pagination button clamps to the new last page after reports disappear', async t => {
  let records = Array.from({ length: 12 }, (_, index) => report({ id: `REP-${index + 1}` }));
  backend(t, async () => Response.json({ reports: records }));
  const chat = conversation();
  await chat.openCabinet();
  await chat.click(callback(chat.replies.at(-1), 'reports:page:1'));
  const oldLastPage = callback(chat.replies.at(-1), 'reports:page:2');

  records = records.slice(0, 6);
  await chat.click(oldLastPage);
  const lastPage = chat.replies.at(-1);
  assert.deepEqual(buttons(lastPage)
    .filter(button => button.callback_data?.startsWith('reports:open:'))
    .map(button => button.callback_data), ['reports:open:REP-1']);
  assert.ok(!buttons(lastPage).some(button => button.callback_data === 'reports:page:2'));
  callback(lastPage, 'reports:page:0');
  await chat.click(callback(lastPage, 'reports:page:1'));
  callback(chat.replies.at(-1), 'reports:open:REP-1');
  assert.equal(chat.replies.length, 4);
  assert.equal(chat.answeredCallbacks, 3);
});

test('corrupted owned IDs produce an actionable error instead of report callback data', async t => {
  let records;
  backend(t, async () => Response.json({ reports: records }));
  const chat = conversation();

  for (const id of ['R'.repeat(41), 'REP:broken']) {
    records = [report({ id })];
    await chat.openCabinet();
    const failure = chat.replies.at(-1);
    assert.match(failure.text, /некоррект|неверн|ошиб/i);
    const actions = buttons(failure);
    assert.ok(actions.length > 0);
    for (const button of actions) {
      assert.equal(typeof button.callback_data, 'string');
      assert.ok(Buffer.byteLength(button.callback_data, 'utf8') <= 64);
      assert.match(button.callback_data, /^reports:(?:page:0|menu)$/);
    }
    callback(failure, 'reports:menu');

    records = [report()];
    await chat.click(callback(failure, 'reports:page:0'));
    callback(chat.replies.at(-1), 'reports:open:REP-1');
  }
  assert.equal(chat.replies.length, 4);
  assert.equal(chat.answeredCallbacks, 2);
  assert.equal(chat.photos.length, 0);
});
