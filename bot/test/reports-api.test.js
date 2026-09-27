import test from 'node:test';
import assert from 'node:assert/strict';
import { djangoPage } from './helpers/django-fixtures.js';
import { analyzeViolationCase } from '../src/case-analysis.js';
import { analyzeLocation, formatLocationAnalysis } from '../src/location.js';

process.env.DATA_MODE = 'api';
process.env.API_BASE_URL = 'http://django.test/api';
process.env.BOT_API_KEY = 'synthetic-api-key';
process.env.OPENAI_API_KEY = '';
const api = await import('../src/api.js');
const { config } = await import('../src/config.js');
const idempotencyKey = '80274b0b-5c36-4990-9ef8-f38b8ffb41d3';
const baseReport = { telegramUserId: 101, lat: 51.12955, lon: 71.4154,
  description: 'На участке появилась незаконная свалка мусора.', telegramFileId: 'photo', idempotencyKey };

test('API creation and cabinet round trip preserve the bot analysis, location and photo', async t => {
  const casePassport = analyzeViolationCase({ ...baseReport, hasPhoto: true });
  const locationAnalysis = analyzeLocation(baseReport);
  let saved;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(options.headers.Authorization, 'Bearer synthetic-api-key');
    assert.equal(options.redirect, 'error', 'Credentials must not follow redirects');
    if (options.method === 'POST') {
      assert.equal(url, `${config.apiBaseUrl}/reports`);
      assert.equal(options.headers['Idempotency-Key'], idempotencyKey);
      saved = JSON.parse(options.body);
      return Response.json({ id: 'backend-uuid', tracking_number: 'KZ-2026-000001', status: 'NEW', created_at: '2026-09-27T10:00:00Z' });
    }
    assert.equal(url, `${config.apiBaseUrl}/bot/reports?telegram_user_id=101`);
    return Response.json({ results: [{ ...saved, id: 'backend-uuid', tracking_number: 'KZ-2026-000001',
      created_at: '2026-09-27T10:00:00Z', status: 'NEW' }], next: null });
  });
  const created = await api.createReport({ ...baseReport, language: 'kk', casePassport, locationAnalysis, landCaseId: '12ab34cd56ef' });
  assert.deepEqual(saved, {
    telegram_user_id: '101', location: { latitude: baseReport.lat, longitude: baseReport.lon },
    photos: [{ telegram_file_id: 'photo' }], description: baseReport.description, category: 'DUMPING',
    bot_result: { language: 'kk', location_summary: formatLocationAnalysis(locationAnalysis, 'kk'),
      case_passport: casePassport, land_case_id: '12ab34cd56ef' },
  });
  assert.equal(created.id, 'KZ-2026-000001');
  assert.equal(created.backendId, 'backend-uuid');
  const [reopened] = await api.listReports(101);
  assert.deepEqual(reopened.casePassport, casePassport);
  assert.equal(reopened.locationSummary, saved.bot_result.location_summary);
  assert.equal(reopened.landCaseId, '12ab34cd56ef');
  assert.equal(reopened.telegramFileId, 'photo');
  assert.equal(reopened.telegramUserId, '101');
  assert.equal(reopened.status, 'NEW');
});

test('API paginates owner-scoped reports and filters foreign and unowned records on every page', async t => {
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    requests.push(url);
    assert.equal(options.headers.Authorization, 'Bearer synthetic-api-key');
    if (requests.length === 1) return Response.json(djangoPage([
      { id: 'REP-1', telegramUserId: '101', createdAt: '2026-09-20T12:00:00Z' },
      { id: 'REP-2', telegramUserId: '202', description: 'Private' },
      { id: 'REP-3', description: 'Legacy' },
    ], `${config.apiBaseUrl}/bot/reports?telegram_user_id=101&page=2`));
    return Response.json(djangoPage([
      { id: 'REP-4', telegramUserId: 101, createdAt: '2026-09-25T12:00:00Z' },
      { id: 'REP-5', telegramUserId: '202', description: 'Private second page' },
      null,
    ]));
  });
  assert.deepEqual((await api.listReports(101)).map(report => report.id), ['REP-4', 'REP-1']);
  assert.deepEqual(requests, [
    `${config.apiBaseUrl}/bot/reports?telegram_user_id=101`,
    `${config.apiBaseUrl}/bot/reports?telegram_user_id=101&page=2`,
  ]);
});

test('pagination never sends credentials to an external URL or a different owner or endpoint', async t => {
  const malicious = [
    'https://external.example/api/bot/reports?telegram_user_id=101&page=2',
    '//external.example/api/bot/reports?telegram_user_id=101&page=2',
    'http://user:password@django.test/api/bot/reports?telegram_user_id=101&page=2',
    '/api/bot/reports?telegram_user_id=202&page=2',
    '/api/reports?telegram_user_id=101&page=2',
    '/api/bot/reports?telegram_user_id=101&page=-1',
  ];
  let next;
  const requests = t.mock.method(globalThis, 'fetch', async (url) => {
    assert.equal(url, `${config.apiBaseUrl}/bot/reports?telegram_user_id=101`);
    return Response.json({ results: [], next });
  });
  for (next of malicious) await assert.rejects(() => api.listReports('101'), /формат/);
  assert.equal(requests.mock.callCount(), malicious.length);
});

test('pagination rejects a repeated page rather than hanging or duplicating results', async t => {
  const requests = t.mock.method(globalThis, 'fetch', async () => Response.json({ results: [],
    next: '/api/bot/reports?telegram_user_id=101&page=2' }));
  await assert.rejects(() => api.listReports('101'), /формат/);
  assert.equal(requests.mock.callCount(), 2);
});

test('API cabinet rejects legacy response shapes and distinguishes a missing backend endpoint', async t => {
  let response;
  t.mock.method(globalThis, 'fetch', async () => response);
  for (const body of [[], { reports: [] }, { results: {} }, {}]) {
    response = Response.json(body);
    await assert.rejects(() => api.listReports('101'), /формат/);
  }
  response = Response.json({}, { status: 404 });
  await assert.rejects(() => api.listReports('101'), /API/);
});

test('API refuses ownerless requests and missing idempotency keys before contacting Django', async t => {
  const requests = t.mock.method(globalThis, 'fetch', async () => Response.json([]));
  await assert.rejects(() => api.listReports(undefined), /пользоват/);
  await assert.rejects(() => api.createReport({ description: 'Ownerless' }), /пользоват/);
  await assert.rejects(() => api.getApplication('KZ-2026-000001'), /пользоват/);
  await assert.rejects(() => api.createReport({ ...baseReport, idempotencyKey: undefined }), /ключ/);
  assert.equal(requests.mock.callCount(), 0);
});

test('application tracking includes the owner and instructions use the actual Django route', async t => {
  let missing = false;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(options.headers.Authorization, 'Bearer synthetic-api-key');
    if (url.endsWith('/instructions')) return Response.json([{ id: 'instruction', title: 'Земельное обращение', body: 'Сохраните доказательства.' }]);
    assert.equal(url, `${config.apiBaseUrl}/tracking/KZ-2026-000001?telegram_user_id=101`);
    return missing ? Response.json({}, { status: 404 }) : Response.json({ tracking_number: 'KZ-2026-000001',
      status: 'INSPECTION', status_label: 'На проверке', updated_at: '2026-09-27T10:00:00Z' });
  });
  assert.deepEqual(await api.getApplication('KZ-2026-000001', 101), { trackingNumber: 'KZ-2026-000001',
    stage: 'INSPECTION', explanation: 'На проверке', updatedAt: '2026-09-27T10:00:00Z' });
  assert.deepEqual(await api.listProcedures(), [{ id: 'instruction', title: 'Земельное обращение',
    steps: ['Сохраните доказательства.'], referenceOnly: true }]);
  missing = true;
  await assert.rejects(() => api.getApplication('KZ-2026-000001', 101), /Заявление не найдено/);
});

test('API hides backend diagnostics on server errors', async t => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ error: { message: 'PRIVATE DATABASE ERROR' } }, { status: 503 }));
  await assert.rejects(() => api.listReports(101), error => /временно недоступен/.test(error.message) && !error.message.includes('DATABASE'));
});

test('the actual report handler retries the same payload and idempotency key after a lost response', async t => {
  const { createBot } = await import('../src/bot.js');
  const posts = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, `${config.apiBaseUrl}/reports`);
    posts.push({ body: options.body, key: options.headers['Idempotency-Key'] });
    if (posts.length === 1) throw new Error('Response lost after server save');
    return Response.json({ id: 'backend-id', tracking_number: 'KZ-2026-000009', status: 'NEW', created_at: '2026-09-27T10:00:00Z' });
  });
  const bot = createBot('synthetic-token', {}, { preferences: { getLanguage: async () => 'ru' }, assistant: { enabled: false } });
  bot.botInfo = { id: 1, is_bot: true, first_name: 'Test', username: 'test_bot' };
  bot.catch(error => { throw error; });
  t.mock.method(Object.getPrototypeOf(bot.telegram), 'callApi', async () => { throw new Error('Unexpected Telegram request'); });
  const replies = [];
  bot.context.reply = async text => replies.push(text);
  let updateId = 0;
  const send = async content => bot.handleUpdate({ update_id: ++updateId, message: {
    message_id: updateId, date: 0, from: { id: 101, is_bot: false, first_name: 'Test' },
    chat: { id: 101, type: 'private' }, ...content,
  } });
  await send({ location: { latitude: baseReport.lat, longitude: baseReport.lon } });
  await send({ photo: [{ file_id: 'photo', file_unique_id: 'photo-id', width: 10, height: 10 }] });
  await send({ text: baseReport.description });
  assert.equal(posts.length, 1);
  assert.match(replies.at(-1), /недоступен/);
  await send({ text: 'Повторная отправка после потери соединения' });
  assert.equal(posts.length, 2);
  assert.deepEqual(posts[1], posts[0], 'An uncertain response must not create a different report on retry');
  assert.match(posts[0].key, /^[a-f\d-]{36}$/);
  assert.equal(JSON.parse(posts[0].body).description, baseReport.description);
  assert.match(replies.at(-1), /KZ-2026-000009/);
  await send({ text: 'Ещё одно случайное сообщение' });
  assert.equal(posts.length, 2, 'Successful submission clears the draft');
});
