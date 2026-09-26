import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DATA_MODE = 'mock';
process.env.OPENAI_API_KEY = '';
const { createBot } = await import('../src/bot.js');
const { displayImage, readTelegramBoundary } = await import('../src/land/telegram.js');
const { PNG } = await import('pngjs');

function harness(service, owner = 101) {
  const bot = createBot('test-token', { apiRoot: 'http://127.0.0.1:1' }, {
    preferences: { getLanguage: async () => 'ru' }, assistant: { enabled: false }, landService: service,
  });
  bot.botInfo = { id: 1, is_bot: true, first_name: 'Test', username: 'test_bot' };
  bot.catch(e => { throw e; });
  const replies = [];
  bot.context.reply = async function(text, extra) { replies.push({ text, extra }); };
  bot.context.replyWithPhoto = async function(photo, extra) { replies.push({ photo, extra }); return { photo: [{ file_id: 'stored-photo' }] }; };
  bot.context.replyWithDocument = async () => {};
  bot.context.answerCbQuery = async () => {};
  let seq = 0;
  const from = { id: owner, first_name: 'Test', is_bot: false };
  return { bot, replies,
    buttons: () => replies.flatMap(r => r.extra?.reply_markup?.inline_keyboard?.flat() || []),
    async send(content, group = false) {
      const message = typeof content === 'string' ? { text: content } : content;
      if (message.text?.startsWith('/')) message.entities = [{ type: 'bot_command', offset: 0, length: message.text.split(' ')[0].length }];
      await bot.handleUpdate({ update_id: ++seq, message: { message_id: seq, date: 0, from,
        chat: { id: group ? -1 : owner, type: group ? 'supergroup' : 'private' }, ...message } });
    },
    async click(data, group = false) {
      await bot.handleUpdate({ update_id: ++seq, callback_query: { id: String(seq), from, data, chat_instance: 'test',
        message: { message_id: 1, date: 0, chat: { id: group ? -1 : owner, type: group ? 'supergroup' : 'private' }, text: 'Test' } } });
    },
  };
}

function fakeService(overrides = {}) {
  const record = { id: '123456abcdef', owner: '101', language: 'ru', area: { lat: 51, lon: 71, width: 25, height: 25 },
    evidence: [], localStatus: 'open', watch: { enabled: false }, reviewRequested: false };
  let analyses = 0;
  return { record, calls: () => analyses, hasOperators: false, isOperator: () => false,
    create: async () => record, get: async (_, owner) => {
      if (String(owner) !== record.owner) throw Object.assign(new Error('missing'), { code: 'LAND_NOT_FOUND' });
      return record;
    }, list: async () => [record],
    analyze: async () => { analyses++; return { record, images: [] }; },
    saveImagery: async () => {}, ...overrides };
}
const location = { location: { latitude: 51.12955, longitude: 71.4154 } };

test('native location does not contact satellites until an explicit area/consent choice', async () => {
  const service = fakeService();
  const chat = harness(service);
  await chat.send(location);
  assert.equal(service.calls(), 0);
  const action = chat.buttons().find(b => b.callback_data?.startsWith('land:area:'));
  assert.ok(action);
  await chat.click(action.callback_data);
  assert.match(chat.replies.at(-1).text, /Earth Search/);
  const run = chat.buttons().find(b => b.callback_data?.startsWith('land:run:'));
  await chat.click(run.callback_data);
  await chat.bot.landIdle();
  assert.equal(service.calls(), 1);
  await chat.click(run.callback_data);
  await chat.bot.landIdle();
  assert.equal(service.calls(), 1, 'double tap must not create a second case');
});

test('stale point buttons and group callbacks cannot start analysis', async () => {
  const service = fakeService();
  const chat = harness(service);
  await chat.send(location);
  const button = chat.buttons().find(b => b.callback_data?.startsWith('land:area:'));
  await chat.send('/cancel');
  await chat.click(button.callback_data);
  assert.match(chat.replies.at(-1).text, /устарела/);
  await chat.click('land:retry:123456abcdef', true);
  assert.equal(service.calls(), 0);
});

test('a cancelled long-running analysis keeps its record but does not change the new conversation', async () => {
  let release;
  const service = fakeService({ analyze: () => new Promise(resolve => { release = resolve; }) });
  const chat = harness(service);
  await chat.send(location);
  await chat.click(chat.buttons().find(b => b.callback_data?.startsWith('land:area:')).callback_data);
  await chat.click(chat.buttons().find(b => b.callback_data?.startsWith('land:run:')).callback_data);
  while (!release) await new Promise(resolve => setImmediate(resolve));
  await chat.send('/cancel');
  const count = chat.replies.length;
  release({ record: service.record, images: [] });
  await chat.bot.landIdle();
  assert.equal(chat.replies.length, count);
});

test('opening another owner case and self-authorizing operator are denied', async () => {
  const service = fakeService({ reviewQueue: async () => { throw Object.assign(new Error('denied'), { code: 'LAND_FORBIDDEN' }); } });
  const chat = harness(service, 202);
  await chat.click('land:open:123456abcdef');
  assert.match(chat.replies.at(-1).text, /недоступно/);
  await chat.send('/review');
  assert.match(chat.replies.at(-1).text, /назначенному оператору/);
  await chat.send('/myid');
  assert.match(chat.replies.at(-1).text, /202/);
});

test('oversized contour document is rejected before any Telegram file download', async () => {
  const chat = harness(fakeService());
  await chat.click('land:boundary:123456abcdef');
  await chat.send({ document: { file_id: 'large', file_name: 'contour.geojson', file_size: 102401 }, caption: 'EGKN reference' });
  assert.match(chat.replies.at(-1).text, /100 КБ/);
});

test('evidence photo is saved as unverified evidence and not consumed by the report draft', async () => {
  let received;
  const service = fakeService({ addEvidence: async (...args) => { received = args; return service.record; } });
  const chat = harness(service);
  await chat.click('land:evidence:123456abcdef');
  await chat.send({ photo: [{ file_id: 'field-photo', width: 10, height: 10 }], caption: '26 Sep: exposed soil' });
  assert.deepEqual(received, ['123456abcdef', 101, 'field-photo', '26 Sep: exposed soil']);
});

test('satellite display enlargement preserves cell colors and marks invalid pixels gray', () => {
  const png = new PNG({ width: 25, height: 25 });
  png.data.set([10, 20, 30, 255], 0);
  const result = PNG.sync.read(displayImage(PNG.sync.write(png)));
  assert.equal(result.width, 500);
  assert.deepEqual([...result.data.subarray(0, 4)], [10, 20, 30, 255]);
  assert.deepEqual([...result.data.subarray(19 * 4, 20 * 4)], [10, 20, 30, 255]);
  assert.deepEqual([...result.data.subarray(20 * 4, 21 * 4)], [150, 150, 150, 255]);
});

test('contour download bounds streamed bodies and rejects non-Telegram file URLs', async () => {
  const ctx = { message: { document: { file_id: 'file', file_name: 'boundary.geojson' }, caption: 'EGKN document 2026' },
    telegram: { getFileLink: async () => 'https://api.telegram.org/file/botsecret/test.json' } };
  let called = 0;
  const fetchImpl = async () => { called++; return new Response(new Uint8Array(102401)); };
  await assert.rejects(readTelegramBoundary(ctx, fetchImpl), { code: 'LAND_INPUT' });
  ctx.telegram.getFileLink = async () => 'https://private.invalid/secret';
  await assert.rejects(readTelegramBoundary(ctx, fetchImpl), { code: 'LAND_INPUT' });
  assert.equal(called, 1);
  ctx.telegram.getFileLink = async () => 'https://api.telegram.org/file/botsecret/test.json';
  assert.deepEqual(await readTelegramBoundary(ctx, async () => new Response('{"type":"Polygon"}')), { type: 'Polygon' });
});

test('cancellation during a photo send stops the rest of a completed analysis presentation', async () => {
  const png = new PNG({ width: 25, height: 25 });
  png.data.fill(255);
  const image = PNG.sync.write(png);
  const service = fakeService();
  service.record.analysis = { before: { datetime: '2025-07-01' }, after: { id: 'after', datetime: '2026-07-01' } };
  service.analyze = async () => ({ record: service.record, images: [image, image, image] });
  const chat = harness(service);
  let release;
  let sends = 0;
  chat.bot.context.replyWithPhoto = async () => { sends++; await new Promise(resolve => { release = resolve; }); return { photo: [{ file_id: 'photo' }] }; };
  await chat.send(location);
  await chat.click(chat.buttons().find(b => b.callback_data?.startsWith('land:area:')).callback_data);
  await chat.click(chat.buttons().find(b => b.callback_data?.startsWith('land:run:')).callback_data);
  while (!release) await new Promise(resolve => setImmediate(resolve));
  await chat.send('/cancel');
  release();
  await chat.bot.landIdle();
  assert.equal(sends, 1);
});

test('owner can inspect persisted field observations and their operator reasons', async () => {
  const service = fakeService();
  service.record.evidence.push({ id: '111111abcdef', fileId: 'photo', caption: 'Public road', createdAt: '2026-09-26',
    review: { accepted: false, note: 'Location not established', actor: '77', at: '2026-09-26' } });
  const chat = harness(service);
  await chat.click('land:materials:123456abcdef');
  assert.ok(chat.buttons().some(b => b.callback_data === 'land:material:123456abcdef:111111abcdef'));
  await chat.click('land:material:123456abcdef:111111abcdef');
  assert.ok(chat.replies.some(r => r.photo === 'photo'));
  assert.match(chat.replies.at(-1).text, /Location not established/);
});

test('revoking operator sharing during a photo send prevents subsequent evidence disclosure', async () => {
  const service = fakeService();
  service.record.evidence.push({ id: '111111abcdef', fileId: 'photo', caption: 'PRIVATE OBSERVATION', createdAt: '2026-09-26' });
  let shared = true;
  service.reviewCase = async () => {
    if (!shared) throw Object.assign(new Error('revoked'), { code: 'LAND_NOT_FOUND' });
    return service.record;
  };
  const chat = harness(service, 77);
  chat.bot.context.replyWithPhoto = async () => { shared = false; };
  await chat.click('land:inspect:123456abcdef:111111abcdef');
  assert.ok(!chat.replies.some(r => r.text?.includes('PRIVATE OBSERVATION')));
});

test('approval buttons are bound to the analysis actually inspected, not the latest unseen analysis', async () => {
  const service = fakeService();
  service.record.analysis = { after: { id: 'old-scene' } };
  service.record.evidence.push({ id: '111111abcdef', fileId: 'photo', caption: 'Observation', createdAt: '2026-09-26' });
  service.reviewCase = async () => service.record;
  const chat = harness(service, 77);
  await chat.click('land:inspect:123456abcdef:111111abcdef');
  const approve = chat.buttons().find(b => b.callback_data?.includes(':decide:'));
  assert.ok(Buffer.byteLength(approve.callback_data) <= 64);
  service.record.analysis.after.id = 'new-unseen-scene';
  await chat.click(approve.callback_data);
  assert.match(chat.replies.at(-1).text, /устарела/);
});
