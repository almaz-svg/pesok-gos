import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DATA_MODE = 'api';
const api = await import('../src/api.js');
const { config } = await import('../src/config.js');

test('API report creation includes a normalized owner from Telegram', async t => {
  let saved;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, `${config.apiBaseUrl}/reports`);
    assert.equal(options.method, 'POST');
    saved = JSON.parse(options.body);
    return { ok: true, json: async () => ({ id: 'REP-1', status: 'signal_received' }) };
  });
  await api.createReport({ telegramUserId: 101, lat: 51, lon: 71, description: 'Report', telegramFileId: 'photo' });
  assert.equal(saved.telegramUserId, '101');
});

test('API cabinet scopes requests and filters foreign and unowned records in either response format', async t => {
  const records = [
    { id: 'REP-1', telegramUserId: '101', createdAt: '2026-09-20T12:00:00Z' },
    { id: 'REP-2', telegramUserId: '202', description: 'Private' },
    { id: 'REP-3', description: 'Legacy' },
    { id: 'REP-4', telegramUserId: 101, createdAt: '2026-09-25T12:00:00Z' },
  ];
  let payload = { reports: records };
  t.mock.method(globalThis, 'fetch', async url => {
    assert.equal(url, `${config.apiBaseUrl}/reports?telegramUserId=101`);
    return { ok: true, json: async () => payload };
  });
  assert.equal(typeof api.listReports, 'function', 'API mode must support the cabinet');
  assert.deepEqual((await api.listReports(101)).map(report => report.id), ['REP-4', 'REP-1']);
  payload = records;
  assert.deepEqual((await api.listReports('101')).map(report => report.id), ['REP-4', 'REP-1']);
});

test('API cabinet reports incompatible responses and a missing backend endpoint', async t => {
  let response = { ok: true, json: async () => ({ results: [] }) };
  t.mock.method(globalThis, 'fetch', async () => response);
  assert.equal(typeof api.listReports, 'function');
  await assert.rejects(() => api.listReports('101'), /формат/);
  response = { ok: false, status: 404, json: async () => ({}) };
  await assert.rejects(() => api.listReports('101'), /API/);
});

test('API refuses ownerless cabinet requests before contacting the backend', async t => {
  const requests = t.mock.method(globalThis, 'fetch', async () => ({ ok: true, json: async () => [] }));
  assert.equal(typeof api.listReports, 'function');
  await assert.rejects(async () => api.listReports(undefined), /пользоват/);
  await assert.rejects(async () => api.createReport({ description: 'Ownerless' }), /пользоват/);
  assert.equal(requests.mock.callCount(), 0);
});
