import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PNG } from 'pngjs';
import { createLandStore } from '../src/land/store.js';
import { createLandService } from '../src/land/service.js';
import { createMonitor } from '../src/land/monitor.js';
import { eventText } from '../src/land/messages.js';

const DAY = 86_400_000;
const OWNER = 101;
const OPERATOR = 77;
const POINT = { lat: 43, lon: 76, halfSizeMeters: 250 };
const INITIAL = { id: 'initial', datetime: '2026-09-24T00:00:00Z', bare: [0, 1, 25, 26] };
const FIRST = { id: 'monitor-1', datetime: '2026-10-01T00:00:00Z', bare: [0, 1, 2, 3, 25, 26, 27, 28] };
const SECOND = { id: 'monitor-2', datetime: '2026-10-08T00:00:00Z', bare: [0, 1, 2, 3, 4, 5, 25, 26, 27, 28, 29, 30] };

function scene(area, id, datetime, bare = []) {
  const count = area.width * area.height;
  const bands = {
    red: new Float32Array(count).fill(0.08), green: new Float32Array(count).fill(0.12),
    blue: new Float32Array(count).fill(0.07), nir: new Float32Array(count).fill(0.6),
    swir16: new Float32Array(count).fill(0.1), scl: new Uint8Array(count).fill(4),
  };
  for (const index of bare) {
    bands.red[index] = 0.3;
    bands.green[index] = 0.3;
    bands.blue[index] = 0.2;
    bands.nir[index] = 0.25;
    bands.swir16[index] = 0.45;
    bands.scl[index] = 5;
  }
  return { id, datetime, sourceUrl: `https://example.test/scenes/${id}`, bands };
}

function pair(area, observation) {
  return {
    before: scene(area, observation.beforeId ?? 'fixed-baseline', observation.beforeDatetime ?? '2025-09-20T00:00:00Z'),
    after: scene(area, observation.id, observation.datetime, observation.bare),
  };
}

function contour(area) {
  const [w, s, e, n] = area.bbox;
  return { type: 'Polygon', coordinates: [[
    [w - 0.01, s - 0.01], [e + 0.01, s - 0.01], [e + 0.01, n + 0.01],
    [w - 0.01, n + 0.01], [w - 0.01, s - 0.01],
  ]] };
}

function assertJsonRecord(record) {
  assert.deepEqual(JSON.parse(JSON.stringify(record)), record, 'runtime record must round-trip without undefined or typed data');
  assert.equal(Object.hasOwn(record, 'images'), false);
  assert.equal(Object.hasOwn(record.analysis?.before ?? {}, 'bands'), false);
  assert.equal(Object.hasOwn(record.analysis?.after ?? {}, 'bands'), false);
}

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'zher-land-integration-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'cases.json');
  let time = new Date('2026-09-26T00:00:00.000Z');
  const now = () => new Date(time);
  const responses = [];
  const requests = [];
  const provider = {
    async getPair(area, options = {}) {
      requests.push(structuredClone({ area, options }));
      const response = responses.shift();
      assert.ok(response, 'unexpected provider request');
      return typeof response === 'function' ? response(area, options) : pair(area, response);
    },
  };
  function reopen() {
    const store = createLandStore({ file });
    // Keep the production geometry and PNG renderer; only the external provider is replaced.
    const service = createLandService({ store, provider, now, operatorIds: [OPERATOR] });
    return { store, service };
  }
  const { store, service } = reopen();
  function monitor(notify, reopened = { store, service }) {
    const worker = createMonitor({ store: reopened.store, analyze: reopened.service.analyzeMonitor, notify, now });
    t.after(() => worker.stop());
    return worker;
  }
  async function analyzed() {
    const created = await service.create(OWNER, POINT, 'ru');
    responses.push(INITIAL);
    return service.analyze(created.id, OWNER);
  }
  async function watched() {
    const { record } = await analyzed();
    await service.setClosed(record.id, OWNER, true);
    return service.setWatch(record.id, OWNER, true);
  }
  return { directory, file, store, service, responses, requests, now, reopen, monitor, analyzed, watched,
    advance: days => { time = new Date(time.getTime() + days * DAY); } };
}

test('real service persists rendered analysis, reviewed boundaries and two monitoring acquisitions', async t => {
  const f = await fixture(t);
  const created = await f.service.create(OWNER, POINT, 'ru');
  assert.equal(f.requests.length, 0);
  assertJsonRecord(created);
  f.responses.push(INITIAL);
  const { record, images } = await f.service.analyze(created.id, OWNER);
  assert.equal(record.analysis.status, 'change');
  assert.equal(record.analysis.changeHectares, 0.16);
  assert.deepEqual(record.analysis.candidatePixels, [0, 1, 25, 26]);
  assert.deepEqual(record.analysis.boundary, { status: 'missing', outsideHectares: null });
  assert.equal(images.length, 3);
  const decoded = images.map(buffer => {
    assert.ok(Buffer.isBuffer(buffer));
    const png = PNG.sync.read(buffer);
    assert.equal(png.width, 25);
    assert.equal(png.height, 25);
    assert.equal(png.data[3], 255);
    return png;
  });
  assert.notDeepEqual(decoded[0].data, decoded[1].data);
  assert.notDeepEqual(decoded[1].data, decoded[2].data);

  const imagery = { afterId: 'initial', beforeFileId: 'telegram-before',
    afterFileId: 'telegram-after', overlayFileId: 'telegram-overlay' };
  await f.service.saveImagery(record.id, OWNER, imagery);
  const uploaded = await f.service.setBoundary(record.id, OWNER, contour(record.area), 'Fixture survey source');
  assert.equal(uploaded.analysis.boundary.status, 'unverified');
  assert.equal(Object.hasOwn(uploaded.boundary, 'verifiedBy'), false);
  await f.service.shareReview(record.id, OWNER, true);
  const reviewed = await f.service.review(record.id, OPERATOR, 'boundary', uploaded.boundary.revision, true, 'Contour checked');
  assert.equal(reviewed.boundary.verifiedBy, String(OPERATOR));
  assert.equal(reviewed.analysis.boundary.status, 'verified');
  assert.ok(reviewed.analysis.boundary.outsideHectares < 1e-6);
  const evidence = await f.service.addEvidence(record.id, OWNER, 'telegram-evidence', 'Visible bare soil');
  const evidenceId = evidence.evidence[0].id;
  await f.service.review(record.id, OPERATOR, 'evidence', evidenceId, true, 'Photo reviewed');
  assert.equal((await f.service.setClosed(record.id, OWNER, true)).watch.enabled, false);
  const watched = await f.service.setWatch(record.id, OWNER, true);
  assert.equal(watched.watch.nextCheckAt, '2026-10-03T00:00:00.000Z');
  const restored = await f.reopen().service.get(record.id, OWNER);
  assert.deepEqual(restored.imagery, imagery);
  assert.equal(restored.evidence[0].review.accepted, true);
  assert.equal(restored.reviewRequested, true);
  assertJsonRecord(restored);

  const delivered = [];
  const notify = async (snapshot, event) => {
    const persisted = await f.reopen().store.get(snapshot.id, snapshot.owner);
    delivered.push({ snapshot, event, persisted });
  };
  const firstWorker = f.monitor(notify);
  await firstWorker.tick();
  assert.equal(f.requests.length, 1);
  f.advance(7);
  f.responses.push(FIRST);
  await firstWorker.tick();
  firstWorker.stop();
  f.advance(7);
  f.responses.push(SECOND);
  const nextWorker = f.monitor(notify, f.reopen());
  await nextWorker.tick();
  await nextWorker.tick();

  assert.deepEqual(f.requests.map(request => request.options), [
    {}, { baselineId: 'fixed-baseline', afterDate: INITIAL.datetime },
    { baselineId: 'fixed-baseline', afterDate: FIRST.datetime },
  ]);
  assert.equal(delivered.length, 2);
  assert.equal(new Set(delivered.map(item => item.event.id)).size, 2);
  for (const [index, item] of delivered.entries()) {
    assert.equal(item.event.delivery, 'pending');
    assert.equal(item.event.additionalHectares, 0.16);
    assert.equal(item.event.analysisAfterId, index === 0 ? 'monitor-1' : 'monitor-2');
    assert.equal(item.snapshot.analysis.after.id, item.event.analysisAfterId);
    assert.equal(item.persisted.events.find(event => event.id === item.event.id).delivery, 'pending');
    assertJsonRecord(item.snapshot);
  }
  const saved = await f.reopen().service.get(record.id, OWNER);
  assert.equal(saved.analysis.before.id, 'fixed-baseline');
  assert.equal(saved.analysis.after.id, 'monitor-2');
  assert.equal(saved.analysis.changeHectares, 0.48);
  assert.equal(saved.analysis.boundary.status, 'verified');
  assert.deepEqual(saved.events.map(event => event.delivery), ['sent', 'sent']);
  assert.equal(saved.watch.nextCheckAt, '2026-10-17T00:00:00.000Z');
  assert.deepEqual(saved.analysisAttempts, [{ at: '2026-10-10T00:00:00.000Z', kind: 'monitor' }]);
  assertJsonRecord(saved);
  assert.deepEqual(JSON.parse(await readFile(f.file, 'utf8'))[record.id], saved);
  assert.deepEqual(await readdir(f.directory), ['cases.json']);
});

test('omitted optional metadata persists and explicit undefined cannot partially overwrite imagery', async t => {
  const f = await fixture(t);
  const { record } = await f.analyzed();
  const imagery = { afterId: 'initial', beforeFileId: 'telegram-before', afterFileId: 'telegram-after' };
  const saved = await f.service.saveImagery(record.id, OWNER, imagery);
  assertJsonRecord(saved);
  assert.equal(Object.hasOwn(saved.imagery, 'overlayFileId'), false);
  const original = await readFile(f.file, 'utf8');
  await assert.rejects(f.service.saveImagery(record.id, OWNER, { ...imagery, overlayFileId: undefined }), /JSON/i);
  assert.equal(await readFile(f.file, 'utf8'), original);
  const uploaded = await f.service.setBoundary(record.id, OWNER, contour(record.area), 'Fixture survey source');
  assertJsonRecord(uploaded);
  await f.service.shareReview(record.id, OWNER, true);
  await f.service.review(record.id, OPERATOR, 'boundary', uploaded.boundary.revision, true, 'Accepted contour');
  const revoked = await f.service.review(record.id, OPERATOR, 'boundary', uploaded.boundary.revision, false, 'Needs revision');
  assert.equal(Object.hasOwn(revoked.boundary, 'verifiedBy'), false);
  assert.equal(revoked.analysis.boundary.status, 'unverified');
  assertJsonRecord(revoked);
  assert.deepEqual(await f.reopen().service.get(record.id, OWNER), revoked);
});

test('wrong owners and non-operators cannot read or mutate the real persisted case', async t => {
  const f = await fixture(t);
  const record = await f.service.create(OWNER, POINT, 'ru');
  const original = await readFile(f.file, 'utf8');
  for (const attempt of [
    () => f.service.get(record.id, 202),
    () => f.service.analyze(record.id, 202),
    () => f.service.saveImagery(record.id, 202, { afterId: 'initial' }),
    () => f.service.setBoundary(record.id, 202, contour(record.area), 'Fixture survey source'),
    () => f.service.addEvidence(record.id, 202, 'telegram-photo'),
    () => f.service.shareReview(record.id, 202, true),
    () => f.service.setClosed(record.id, 202, true),
    () => f.service.setWatch(record.id, 202, true),
  ]) await assert.rejects(attempt, { code: 'LAND_NOT_FOUND' });
  assert.deepEqual(await f.service.list(202), []);
  await assert.rejects(f.service.reviewQueue(OWNER), { code: 'LAND_FORBIDDEN' });
  await assert.rejects(f.service.reviewCase(record.id, OPERATOR), { code: 'LAND_NOT_FOUND' });
  await assert.rejects(f.service.review(record.id, OWNER, 'boundary', 'revision', true, 'Checked'), { code: 'LAND_FORBIDDEN' });
  assert.equal(f.requests.length, 0);
  assert.equal(await readFile(f.file, 'utf8'), original);
});

test('corrupt real storage stops service and monitoring without provider calls or data replacement', async t => {
  const f = await fixture(t);
  const record = await f.service.create(OWNER, POINT, 'ru');
  const corrupt = '{"unfinished":';
  await writeFile(f.file, corrupt);
  const notifications = [];
  const worker = f.monitor(async (...args) => { notifications.push(args); });
  await assert.rejects(f.service.get(record.id, OWNER));
  await assert.rejects(f.service.analyze(record.id, OWNER));
  await assert.rejects(f.service.create(OWNER, POINT, 'ru'));
  await assert.rejects(worker.tick());
  assert.equal(f.requests.length, 0);
  assert.deepEqual(notifications, []);
  assert.equal(await readFile(f.file, 'utf8'), corrupt);
  assert.deepEqual(await readdir(f.directory), ['cases.json']);
});

test('analyzeMonitor writes attempts but leaves analysis persistence to the worker', async t => {
  const f = await fixture(t);
  const record = await f.watched();
  f.advance(7);
  f.responses.push(FIRST);
  const result = await f.service.analyzeMonitor(record);
  assert.equal(result.after.id, 'monitor-1');
  assert.equal(result.before.id, 'fixed-baseline');
  assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
  assert.equal(Object.hasOwn(result, 'images'), false);
  const persisted = await f.reopen().service.get(record.id, OWNER);
  assert.deepEqual(persisted.analysis, record.analysis);
  assert.deepEqual(persisted.events, []);
  assert.deepEqual(persisted.analysisAttempts, [{ at: '2026-10-03T00:00:00.000Z', kind: 'monitor' }]);
});

test('notification retry after restart delivers the persisted event without repeating service analysis', async t => {
  const f = await fixture(t);
  const record = await f.watched();
  f.advance(7);
  f.responses.push(FIRST);
  const attempts = [];
  const firstWorker = f.monitor(async (_snapshot, event) => {
    attempts.push(event.id);
    throw new Error('notification transport unavailable');
  });
  await firstWorker.tick();
  firstWorker.stop();
  const pending = await f.reopen().service.get(record.id, OWNER);
  assert.equal(pending.analysis.after.id, 'monitor-1');
  assert.equal(pending.events[0].delivery, 'pending');
  assert.equal(pending.watch.nextCheckAt, '2026-10-04T00:00:00.000Z');
  const restarted = f.monitor(async (_snapshot, event) => { attempts.push(event.id); }, f.reopen());
  await restarted.tick();
  assert.equal(attempts.length, 1);
  f.advance(1);
  await restarted.tick();
  await restarted.tick();
  const saved = await f.reopen().service.get(record.id, OWNER);
  assert.deepEqual(attempts, [pending.events[0].id, pending.events[0].id]);
  assert.equal(f.requests.length, 2);
  assert.equal(saved.events[0].delivery, 'sent');
  assert.deepEqual(saved.analysisAttempts, pending.analysisAttempts);
});

test('service reopen or stop during a real provider request cancels the worker result', async t => {
  for (const action of ['reopen', 'stop']) {
    await t.test(action, async t => {
      const f = await fixture(t);
      const record = await f.watched();
      f.advance(7);
      const entered = Promise.withResolvers();
      const release = Promise.withResolvers();
      t.after(() => release.resolve());
      f.responses.push(async area => { entered.resolve(); await release.promise; return pair(area, FIRST); });
      const notifications = [];
      const worker = f.monitor(async (...args) => { notifications.push(args); });
      const tick = worker.tick();
      await entered.promise;
      try {
        if (action === 'reopen') await f.service.setClosed(record.id, OWNER, false);
        else await f.service.setWatch(record.id, OWNER, false);
      } finally {
        release.resolve();
      }
      await tick;
      const saved = await f.reopen().service.get(record.id, OWNER);
      assert.equal(saved.localStatus, action === 'reopen' ? 'open' : 'closed');
      assert.equal(saved.watch.enabled, false);
      assert.deepEqual(saved.analysis, record.analysis);
      assert.deepEqual(saved.events, []);
      assert.deepEqual(notifications, []);
      assert.deepEqual(saved.analysisAttempts, [{ at: '2026-10-03T00:00:00.000Z', kind: 'monitor' }]);
    });
  }
});

test('reopening during notification keeps the case open and records the accepted event as sent', async t => {
  const f = await fixture(t);
  const record = await f.watched();
  f.advance(7);
  f.responses.push(FIRST);
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  t.after(() => release.resolve());
  const delivered = [];
  const worker = f.monitor(async (_snapshot, event) => {
    delivered.push(event.id);
    entered.resolve();
    await release.promise;
  });
  const tick = worker.tick();
  await entered.promise;
  try {
    await f.service.setClosed(record.id, OWNER, false);
  } finally {
    release.resolve();
  }
  await tick;
  const saved = await f.reopen().service.get(record.id, OWNER);
  assert.equal(saved.localStatus, 'open');
  assert.deepEqual(saved.watch, { enabled: false });
  assert.equal(saved.events[0].delivery, 'sent');
  assert.deepEqual(delivered, [saved.events[0].id]);
  await worker.tick();
  assert.equal(delivered.length, 1);
});

test('pending notifications keep their acquisition date after a manual baseline replacement', async t => {
  const f = await fixture(t);
  const record = await f.watched();
  f.advance(7);
  f.responses.push(FIRST);
  const firstWorker = f.monitor(async () => { throw new Error('notification transport unavailable'); });
  await firstWorker.tick();
  firstWorker.stop();
  const pending = (await f.store.get(record.id, OWNER)).events[0];
  assert.equal(pending.delivery, 'pending');
  assert.equal(pending.analysisAfterId, FIRST.id);
  assert.equal(pending.analysisAfterDate, FIRST.datetime);
  assert.equal(pending.sourceUrl, 'https://example.test/scenes/monitor-1');
  f.responses.push({ ...SECOND, id: 'manual-replacement', datetime: '2026-10-02T00:00:00Z',
    beforeId: 'replacement-baseline', beforeDatetime: '2025-10-02T00:00:00Z' });
  const replacement = await f.service.analyze(record.id, OWNER);
  assert.equal(replacement.record.analysis.before.id, 'replacement-baseline');
  assert.equal(replacement.record.watch.enabled, false);
  assert.deepEqual(replacement.record.events, [pending]);
  await f.service.setWatch(record.id, OWNER, true);
  f.advance(7);
  const delivered = [];
  await f.monitor(async (snapshot, event) => {
    delivered.push({ event, text: eventText(snapshot, event) });
  }, f.reopen()).tick();
  assert.equal(f.requests.length, 3, 'a pending event must not trigger another provider analysis');
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].event.id, pending.id);
  assert.match(delivered[0].text, /2026-10-01/, 'the alert must date the acquisition that created the event');
  assert.doesNotMatch(delivered[0].text, /2026-10-02/, 'a later manual analysis must not re-date the old event');
});
