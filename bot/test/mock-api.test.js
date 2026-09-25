import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createMockApi } from '../src/mock-api.js';

test('mock reports persist and use DEMO identifiers', async t => {
  const reportsFile = join(tmpdir(), `zher-reports-${randomUUID()}.json`);
  t.after(async () => {
    await rm(reportsFile, { force: true });
    await rm(`${reportsFile}.tmp`, { force: true });
  });

  const input = {
    lat: 51.1693,
    lon: 71.4492,
    description: 'Учебный сигнал',
    telegramFileId: 'telegram-file-id',
    telegramUserId: '101',
  };
  const first = await createMockApi({ reportsFile }).createReport(input);
  const second = await createMockApi({ reportsFile }).createReport(input);

  assert.equal(first.id, 'DEMO-042');
  assert.equal(second.id, 'DEMO-043');
  assert.equal(first.status, 'signal_received');
  assert.equal(first.demoOnly, true);
});

test('cabinet persists ownership and lists only the current user reports, newest first', async t => {
  const reportsFile = join(tmpdir(), `zher-cabinet-${randomUUID()}.json`);
  t.after(() => rm(reportsFile, { force: true }));
  await writeFile(reportsFile, JSON.stringify([{ id: 'DEMO-041', description: 'Legacy unowned report' }]));
  const api = createMockApi({ reportsFile });
  const input = { lat: 51, lon: 71, description: 'My report', telegramFileId: 'photo' };
  await api.createReport({ ...input, telegramUserId: 101 });
  await api.createReport({ ...input, telegramUserId: '202', description: 'Private other report' });
  await api.createReport({ ...input, telegramUserId: '101', description: 'New report' });

  const reopened = createMockApi({ reportsFile });
  assert.equal(typeof reopened.listReports, 'function', 'The cabinet needs a persistent user-scoped list');
  const reports = await reopened.listReports(101);
  assert.deepEqual(reports.map(report => report.id), ['DEMO-044', 'DEMO-042']);
  assert.equal(reports[0].description, 'New report');
  assert.equal(reports[0].telegramFileId, 'photo');
  assert.equal(reports[0].telegramUserId, '101');
  assert.equal(reports[0].lat, 51);
  assert.equal(reports[0].lon, 71);
  assert.ok(reports[0].createdAt);
  assert.deepEqual(await reopened.listReports('303'), []);
  assert.equal(JSON.parse(await readFile(reportsFile, 'utf8')).length, 4);
});

test('cabinet rejects missing or invalid owners instead of returning unowned reports', async t => {
  const reportsFile = join(tmpdir(), `zher-owner-${randomUUID()}.json`);
  t.after(() => rm(reportsFile, { force: true }));
  const api = createMockApi({ reportsFile });
  const input = { lat: 51, lon: 71, description: 'Report', telegramFileId: 'photo' };
  for (const telegramUserId of [undefined, null, '', 'undefined', -1, 1.5]) {
    await assert.rejects(() => api.createReport({ ...input, telegramUserId }), /пользоват/);
  }
  assert.equal(typeof api.listReports, 'function');
  for (const telegramUserId of [undefined, null, '', 'undefined', -1, 1.5]) {
    await assert.rejects(() => api.listReports(telegramUserId), /пользоват/);
  }
});

test('mock API keeps applications as demo and provides sourced reference procedures', async () => {
  const mockApi = createMockApi({ reportsFile: join(tmpdir(), `unused-${randomUUID()}.json`) });
  const application = await mockApi.getApplication('KZ-2026-042');
  const procedures = await mockApi.listProcedures();

  assert.equal(application.demoOnly, true);
  assert.equal(procedures.length, 3);
  assert.ok(procedures.every(procedure => procedure.referenceOnly && !procedure.demoOnly));
  for (const procedure of procedures) {
    assert.equal(new URL(procedure.officialUrl).protocol, 'https:');
    assert.equal(new URL(procedure.sourceUrl).protocol, 'https:');
    assert.ok(procedure.sourceCheckedAt);
    assert.ok(procedure.steps.length >= 3);
    assert.doesNotMatch(procedure.steps.join(' '), /Демонстрационный материал/);
  }
  assert.equal(new Set(procedures.map(procedure => procedure.steps.join(' '))).size, 3);
});

test('mock procedures are returned as readable Russian text', async () => {
  const mockApi = createMockApi({ reportsFile: join(tmpdir(), `unused-${randomUUID()}.json`) });
  const procedures = await mockApi.listProcedures();

  assert.equal(procedures[0].title, 'Сведения о земельном участке');
  assert.match(procedures[0].steps[0], /кадастровую карту/);
});
