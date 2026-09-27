import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createLandStore } from '../src/land/store.js';
import { createMonitor } from '../src/land/monitor.js';

const DAY = 86_400_000;
const START = '2026-09-26T00:00:00.000Z';
const area = {
  lat: 43, lon: 76, halfSizeMeters: 250, bbox: [75.99, 42.99, 76.01, 43.01],
  epsg: 32643, projectedBbox: [0, 0, 80, 60], width: 4, height: 3, resolution: 20,
};
const indices = Array.from({ length: 12 }, (_, i) => i);

function analysis(overrides = {}) {
  return {
    status: 'change', method: 'vegetation-to-bare-v1', area: structuredClone(area),
    before: { id: 'baseline', datetime: '2025-09-20T00:00:00Z', sourceUrl: 'https://example.test/before' },
    after: { id: 'previous', datetime: '2026-09-20T00:00:00Z', sourceUrl: 'https://example.test/previous' },
    validFraction: 10 / 12, changeHectares: 0.08, candidatePixels: [0, 1], validPixels: indices.slice(0, 10),
    boundary: { status: 'unknown', outsideHectares: null }, settings: { minCommonValidFraction: 0.6 },
    ...overrides,
  };
}

function newer(overrides = {}) {
  return analysis({
    after: { id: 'new-scene', datetime: '2026-09-24T00:00:00Z', sourceUrl: 'https://example.test/after' },
    validFraction: 1, candidatePixels: [0, 1, 2, 10], validPixels: indices, changeHectares: 0.16,
    ...overrides,
  });
}

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'zher-land-monitor-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'cases.json');
  const store = createLandStore({ file });
  let time = new Date(START);
  const now = () => new Date(time);
  async function create(overrides = {}) {
    const record = await store.create(101, { area, language: 'ru' });
    return store.update(record.id, 101, draft => Object.assign(draft, {
      analysis: analysis(), localStatus: 'closed', watch: { enabled: true }, ...overrides,
    }));
  }
  function monitor(options = {}) {
    const worker = createMonitor({ store, now, analyze: async () => newer(), notify: async () => {}, ...options });
    t.after(() => worker.stop());
    return worker;
  }
  return { file, store, create, monitor, now, advance: days => { time = new Date(+time + days * DAY); } };
}

test('only due, closed, explicitly watched cases are analyzed', async t => {
  const f = await fixture(t);
  await f.create({ localStatus: 'open' });
  await f.create({ watch: { enabled: false } });
  await f.create({ watch: { enabled: true, nextCheckAt: '2026-09-27T00:00:00Z' } });
  await f.create({ watch: { enabled: true, nextCheckAt: 'invalid' } });
  const due = await f.create({ watch: { enabled: true, nextCheckAt: START } });
  const requested = [];
  const worker = f.monitor({ analyze: async record => { requested.push(record.id); return newer(); } });
  assert.deepEqual(requested, []);
  await worker.tick();
  assert.deepEqual(requested, [due.id]);
});

test('additional area uses prior clear cells and persists a pending event before notification', async t => {
  const f = await fixture(t);
  const initial = await f.create();
  let delivered;
  const worker = f.monitor({
    analyze: async record => {
      assert.equal(record.analysis.before.id, 'baseline');
      return newer();
    },
    notify: async (record, event) => {
      const onDisk = await createLandStore({ file: f.file }).get(record.id, record.owner);
      assert.deepEqual(onDisk.events, [event]);
      assert.equal(onDisk.analysis.after.id, 'new-scene');
      assert.equal(event.delivery, 'pending');
      delivered = structuredClone(event);
    },
  });
  await worker.tick();
  assert.match(delivered.id, /^[a-f0-9]{12}$/);
  assert.deepEqual(delivered, {
    id: delivered.id, type: 'additional_change', createdAt: START,
    analysisAfterId: 'new-scene', analysisAfterDate: '2026-09-24T00:00:00Z',
    sourceUrl: 'https://example.test/after', additionalHectares: 0.04, delivery: 'pending',
  });
  const saved = await f.store.get(initial.id, 101);
  assert.equal(saved.events[0].delivery, 'sent');
  assert.equal(saved.analysis.before.id, 'baseline');
  assert.equal(saved.watch.nextCheckAt, '2026-10-03T00:00:00.000Z');
});

test('same acquisition never repeats an alert and retries no sooner than one day', async t => {
  const f = await fixture(t);
  const initial = await f.create();
  let sends = 0;
  let analyses = 0;
  const worker = f.monitor({
    analyze: async () => { analyses++; return newer(); },
    notify: async () => { sends++; },
  });
  await worker.tick();
  await worker.tick();
  assert.equal(analyses, 1);
  f.advance(7);
  await worker.tick();
  await worker.tick();
  assert.equal(sends, 1);
  assert.equal(analyses, 2);
  const saved = await f.store.get(initial.id, 101);
  assert.equal(saved.events.length, 1);
  assert.equal(saved.watch.lastOutcome, 'no_new');
  assert.equal(saved.watch.nextCheckAt, '2026-10-04T00:00:00.000Z');
});

test('newly unclouded candidates are saved but cannot be claimed as additional change', async t => {
  const f = await fixture(t);
  const record = await f.create();
  const next = newer({ candidatePixels: [0, 1, 10, 11] });
  await f.monitor({ analyze: async () => next, notify: async () => assert.fail('newly clear is not new change') }).tick();
  const saved = await f.store.get(record.id, 101);
  assert.deepEqual(saved.analysis, next);
  assert.deepEqual(saved.events, []);
  assert.equal(saved.watch.lastOutcome, 'no_new');
  assert.equal(saved.watch.nextCheckAt, '2026-10-03T00:00:00.000Z');
});

test('a valid no-change result advances the comparison without inventing an alert', async t => {
  const f = await fixture(t);
  const record = await f.create();
  const next = newer({ status: 'no_change', candidatePixels: [], changeHectares: 0 });
  await f.monitor({ analyze: async () => next, notify: async () => assert.fail('no additional change') }).tick();
  const saved = await f.store.get(record.id, 101);
  assert.deepEqual(saved.analysis, next);
  assert.deepEqual(saved.events, []);
});

test('incomparable or insufficient results preserve the last valid analysis and retry daily', async t => {
  const variants = [
    ['baseline', newer({ before: { id: 'different', datetime: '2025-09-20T00:00:00Z' } })],
    ['baseline date', newer({ before: { id: 'baseline', datetime: '2025-09-21T00:00:00Z' } })],
    ['method', newer({ method: 'different' })],
    ['settings', newer({ settings: { minCommonValidFraction: 0.1 } })],
    ['resolution', newer({ area: { ...area, resolution: 10 } })],
    ['grid origin', newer({ area: { ...area, projectedBbox: [20, 0, 100, 60] } })],
    ['projection', newer({ area: { ...area, epsg: 32644 } })],
    ['grid shape', newer({ area: { ...area, width: 3, height: 4 } })],
    ['insufficient', newer({ status: 'insufficient_data' })],
    ['invalid date', newer({ after: { id: 'new-scene', datetime: 'invalid' } })],
    ['missing mask', newer({ validPixels: undefined })],
    ['outside grid', newer({ candidatePixels: [0, 1, 99] })],
    ['cloudy candidate', newer({ validPixels: [0, 1, 2], candidatePixels: [0, 1, 5] })],
    ['empty valid mask', newer({ validPixels: [], candidatePixels: [] })],
    ['no change with candidates', newer({ status: 'no_change' })],
  ];
  for (const [name, next] of variants) {
    await t.test(name, async t => {
      const f = await fixture(t);
      const record = await f.create();
      let calls = 0;
      const worker = f.monitor({ analyze: async () => { calls++; return next; }, notify: async () => assert.fail(name) });
      await worker.tick();
      await worker.tick();
      const saved = await f.store.get(record.id, 101);
      assert.deepEqual(saved.analysis, record.analysis);
      assert.deepEqual(saved.events, []);
      assert.equal(saved.watch.lastOutcome, 'insufficient');
      assert.equal(saved.watch.nextCheckAt, '2026-09-27T00:00:00.000Z');
      assert.equal(calls, 1);
    });
  }
});

test('an alternative id at the same or an older acquisition time cannot produce a new alert', async t => {
  for (const datetime of ['2026-09-20T00:00:00Z', '2026-09-19T00:00:00Z']) {
    const f = await fixture(t);
    const record = await f.create();
    await f.monitor({ analyze: async () => newer({ after: { id: 'different-id', datetime } }),
      notify: async () => assert.fail('not a new acquisition') }).tick();
    const saved = await f.store.get(record.id, 101);
    assert.deepEqual(saved.analysis, record.analysis);
    assert.deepEqual(saved.events, []);
    assert.equal(saved.watch.lastOutcome, 'no_new');
  }
});

test('provider failures reschedule without changing the analysis or sending a no-change claim', async t => {
  const f = await fixture(t);
  const record = await f.create();
  let calls = 0;
  const worker = f.monitor({ analyze: async () => { calls++; throw new Error('unavailable'); },
    notify: async () => assert.fail('no imagery is not no change') });
  await worker.tick();
  await worker.tick();
  const saved = await f.store.get(record.id, 101);
  assert.deepEqual(saved.analysis, record.analysis);
  assert.deepEqual(saved.events, []);
  assert.equal(saved.watch.lastOutcome, 'providerfail');
  assert.equal(saved.watch.nextCheckAt, '2026-09-27T00:00:00.000Z');
  assert.equal(calls, 1);
  f.advance(1);
  await worker.tick();
  assert.equal(calls, 2);
});

test('typed provider outcomes distinguish missing new imagery from unavailable service', async t => {
  for (const [code, outcome] of [['SATELLITE_NO_NEW', 'no_new'], ['SATELLITE_NO_PAIR', 'insufficient'],
    ['SATELLITE_UNAVAILABLE', 'providerfail']]) {
    const f = await fixture(t);
    const record = await f.create();
    await f.monitor({ analyze: async () => { throw Object.assign(new Error(code), { code }); },
      notify: async () => assert.fail('no imagery') }).tick();
    const saved = await f.store.get(record.id, 101);
    assert.equal(saved.watch.lastOutcome, outcome);
    assert.equal(saved.watch.nextCheckAt, '2026-09-27T00:00:00.000Z');
    assert.deepEqual(saved.analysis, record.analysis);
    assert.deepEqual(saved.events, []);
  }
});

test('missing previous analysis is insufficient and never calls the provider', async t => {
  const f = await fixture(t);
  const record = await f.create();
  await f.store.update(record.id, 101, draft => { delete draft.analysis; });
  await f.monitor({ analyze: async () => assert.fail('no fixed baseline'),
    notify: async () => assert.fail('no analysis') }).tick();
  const saved = await f.store.get(record.id, 101);
  assert.equal(saved.watch.lastOutcome, 'insufficient');
  assert.equal(saved.watch.nextCheckAt, '2026-09-27T00:00:00.000Z');
});

test('failed notifications survive restart and retry the same event without reanalysis', async t => {
  const f = await fixture(t);
  const record = await f.create();
  let sends = 0;
  const first = f.monitor({ notify: async () => { sends++; throw new Error('network'); } });
  await first.tick();
  await first.tick();
  first.stop();
  const pending = (await f.store.get(record.id, 101)).events[0];
  assert.equal(pending.delivery, 'pending');
  assert.equal(sends, 1);
  const reopened = createLandStore({ file: f.file });
  const retry = f.monitor({ store: reopened, analyze: async () => assert.fail('pending first'),
    notify: async (_record, event) => { assert.deepEqual(event, pending); sends++; } });
  await retry.tick();
  assert.equal(sends, 1);
  f.advance(1);
  await retry.tick();
  assert.equal(sends, 2);
  const saved = await reopened.get(record.id, 101);
  assert.deepEqual(saved.events, [{ ...pending, delivery: 'sent' }]);
  assert.equal(saved.watch.nextCheckAt, '2026-10-04T00:00:00.000Z');
});

test('a persisted event from a crash before dispatch is delivered without requiring analysis', async t => {
  const f = await fixture(t);
  const record = await f.create();
  const event = { id: 'abc123abc123', type: 'additional_change', createdAt: START,
    analysisAfterId: 'new-scene', additionalHectares: 0.04, delivery: 'pending' };
  await f.store.update(record.id, 101, draft => { draft.events.push(event); delete draft.analysis; });
  await f.monitor({ store: createLandStore({ file: f.file }), analyze: async () => assert.fail('retry only'),
    notify: async (_record, sent) => assert.deepEqual(sent, event) }).tick();
  assert.equal((await f.store.get(record.id, 101)).events[0].delivery, 'sent');
});

test('pending event acquisition metadata survives manual analysis replacement and restart', async t => {
  const f = await fixture(t);
  const record = await f.create();
  const first = f.monitor({ notify: async () => { throw new Error('transport unavailable'); } });
  await first.tick();
  first.stop();
  const pending = (await f.store.get(record.id, 101)).events[0];
  assert.equal(pending.analysisAfterDate, '2026-09-24T00:00:00Z');
  assert.equal(pending.sourceUrl, 'https://example.test/after');
  await f.store.update(record.id, 101, draft => {
    draft.analysis = newer({
      before: { id: 'manual-baseline', datetime: '2025-09-21T00:00:00Z', sourceUrl: 'https://example.test/manual-baseline' },
      after: { id: 'manual-scene', datetime: '2026-09-25T00:00:00Z', sourceUrl: 'https://example.test/manual-scene' },
    });
    draft.watch = { enabled: true, nextCheckAt: '2026-09-27T00:00:00Z' };
  });
  f.advance(1);
  const deliveries = [];
  const reopened = createLandStore({ file: f.file });
  await f.monitor({ store: reopened, analyze: async () => assert.fail('retry must not reanalyze'),
    notify: async (snapshot, event) => { deliveries.push({ snapshot, event }); } }).tick();
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].snapshot.analysis.after.id, 'manual-scene');
  assert.deepEqual(deliveries[0].event, pending);
  assert.equal(deliveries[0].event.analysisAfterDate, '2026-09-24T00:00:00Z');
  assert.equal(deliveries[0].event.sourceUrl, 'https://example.test/after');
  const saved = await reopened.get(record.id, 101);
  assert.deepEqual(saved.events, [{ ...pending, delivery: 'sent' }]);
  assert.equal(saved.analysis.before.id, 'manual-baseline');
});

test('optional acquisition source metadata stays JSON-safe when omitted by an injected analysis', async t => {
  const f = await fixture(t);
  const record = await f.create();
  await f.monitor({ analyze: async () => newer({
    after: { id: 'new-scene', datetime: '2026-09-24T00:00:00Z' },
  }) }).tick();
  const saved = await createLandStore({ file: f.file }).get(record.id, 101);
  assert.equal(saved.events[0].sourceUrl, null);
  assert.equal(saved.events[0].analysisAfterDate, '2026-09-24T00:00:00Z');
  assert.equal(saved.events[0].delivery, 'sent');
});

test('Telegram 403 disables the watch but retains the pending event', async t => {
  for (const failure of [{ response: { error_code: 403 } }, { status: 403 }, { code: 403 }]) {
    const f = await fixture(t);
    const record = await f.create();
    let sends = 0;
    const worker = f.monitor({ notify: async () => { sends++; throw failure; } });
    await worker.tick();
    f.advance(30);
    await worker.tick();
    const saved = await f.store.get(record.id, 101);
    assert.equal(saved.watch.enabled, false);
    assert.equal(saved.events[0].delivery, 'pending');
    assert.equal(sends, 1);
  }
});

test('overlapping ticks share one analysis and notification', async t => {
  const f = await fixture(t);
  const record = await f.create();
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  let calls = 0;
  let sends = 0;
  const worker = f.monitor({ analyze: async () => {
    calls++; entered.resolve(); await release.promise; return newer();
  }, notify: async () => { sends++; } });
  const first = worker.tick();
  await entered.promise;
  const second = worker.tick();
  const third = worker.tick();
  release.resolve();
  await Promise.all([first, second, third]);
  assert.equal(calls, 1);
  assert.equal(sends, 1);
  assert.equal((await f.store.get(record.id, 101)).events.length, 1);
});

test('watch disable or reopening while analysis is in flight is preserved without dispatch', async t => {
  for (const change of [draft => { draft.watch.enabled = false; }, draft => { draft.localStatus = 'open'; }]) {
    const f = await fixture(t);
    const record = await f.create();
    const entered = Promise.withResolvers();
    const release = Promise.withResolvers();
    const worker = f.monitor({ analyze: async () => {
      entered.resolve(); await release.promise; return newer();
    }, notify: async () => assert.fail('cancelled') });
    const work = worker.tick();
    await entered.promise;
    await f.store.update(record.id, 101, change);
    const changed = await f.store.get(record.id, 101);
    release.resolve();
    await work;
    assert.deepEqual(await f.store.get(record.id, 101), changed);
  }
});

test('worker stop cancels in-flight results and blocks ticks until explicitly started', async t => {
  const f = await fixture(t);
  const record = await f.create();
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  let calls = 0;
  const worker = f.monitor({ analyze: async () => {
    calls++; entered.resolve(); await release.promise; return newer();
  } });
  const work = worker.tick();
  await entered.promise;
  worker.stop();
  release.resolve();
  await work;
  await worker.tick();
  assert.equal(calls, 1);
  assert.deepEqual(await f.store.get(record.id, 101), record);
  await worker.start();
  worker.stop();
  assert.equal(calls, 2);
  assert.equal((await f.store.get(record.id, 101)).events[0].delivery, 'sent');
});

test('a replaced analysis cannot be overwritten by an older in-flight result', async t => {
  const f = await fixture(t);
  const record = await f.create();
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const worker = f.monitor({ analyze: async () => {
    entered.resolve(); await release.promise; return newer();
  }, notify: async () => assert.fail('stale analysis') });
  const work = worker.tick();
  await entered.promise;
  const replacement = newer({ after: { id: 'manual', datetime: '2026-09-25T00:00:00Z' } });
  await f.store.update(record.id, 101, draft => { draft.analysis = replacement; });
  release.resolve();
  await work;
  assert.deepEqual((await f.store.get(record.id, 101)).analysis, replacement);
});

test('unrelated evidence and parent metadata written during analysis survive the monitor save', async t => {
  const f = await fixture(t);
  const record = await f.create();
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const worker = f.monitor({ analyze: async snapshot => {
    snapshot.language = 'kk';
    entered.resolve(); await release.promise; return newer();
  } });
  const work = worker.tick();
  await entered.promise;
  await f.store.update(record.id, 101, draft => {
    draft.evidence.push({ id: 'photo', fileId: 'telegram-id' });
    draft.analysisAttempts = [{ at: START, kind: 'manual' }];
    draft.imagery = { afterId: 'previous', afterFileId: 'telegram-preview' };
  });
  release.resolve();
  await work;
  const saved = await f.store.get(record.id, 101);
  assert.deepEqual(saved.evidence, [{ id: 'photo', fileId: 'telegram-id' }]);
  assert.deepEqual(saved.analysisAttempts, [{ at: START, kind: 'manual' }]);
  assert.deepEqual(saved.imagery, { afterId: 'previous', afterFileId: 'telegram-preview' });
  assert.equal(saved.language, 'ru');
  assert.equal(saved.analysis.after.id, 'new-scene');
});

test('successful delivery records sent without overwriting a reopen during notification', async t => {
  const f = await fixture(t);
  const record = await f.create();
  await f.monitor({ notify: async () => {
    await f.store.update(record.id, 101, draft => {
      draft.localStatus = 'open'; draft.watch.enabled = false; draft.watch.nextCheckAt = '2030-01-01T00:00:00Z';
    });
  } }).tick();
  const saved = await f.store.get(record.id, 101);
  assert.equal(saved.events[0].delivery, 'sent');
  assert.equal(saved.localStatus, 'open');
  assert.equal(saved.watch.enabled, false);
  assert.equal(saved.watch.nextCheckAt, '2030-01-01T00:00:00Z');
});

test('a failing case does not prevent later due cases from being processed', async t => {
  const f = await fixture(t);
  const first = await f.create();
  const second = await f.create();
  await f.monitor({ analyze: async record => {
    if (record.id === first.id) throw new Error('provider');
    return newer();
  } }).tick();
  assert.equal((await f.store.get(first.id, 101)).watch.lastOutcome, 'providerfail');
  assert.equal((await f.store.get(second.id, 101)).events[0].delivery, 'sent');
});

test('malformed JSON analysis is rescheduled without repeatedly requesting the provider', async t => {
  const f = await fixture(t);
  const record = await f.create();
  let calls = 0;
  const worker = f.monitor({ analyze: async () => { calls++; return newer({ raw: Buffer.from('raster') }); },
    notify: async () => assert.fail('not metadata') });
  await worker.tick();
  await worker.tick();
  const saved = await f.store.get(record.id, 101);
  assert.deepEqual(saved.analysis, record.analysis);
  assert.equal(saved.watch.lastOutcome, 'insufficient');
  assert.equal(saved.watch.nextCheckAt, '2026-09-27T00:00:00.000Z');
  assert.equal(calls, 1);
});

test('insufficient shared clear coverage between checks cannot produce a change conclusion', async t => {
  const f = await fixture(t);
  const previous = analysis({ settings: { minValidFraction: 0.8 } });
  const record = await f.create({ analysis: previous });
  await f.monitor({ analyze: async () => newer({ settings: { minValidFraction: 0.8 },
    validPixels: indices.slice(2), candidatePixels: [2, 3], validFraction: 10 / 12,
  }), notify: async () => assert.fail('only 8 of 12 jointly clear') }).tick();
  const saved = await f.store.get(record.id, 101);
  assert.deepEqual(saved.analysis, previous);
  assert.equal(saved.watch.lastOutcome, 'insufficient');
  assert.equal(saved.watch.nextCheckAt, '2026-09-27T00:00:00.000Z');
});

test('changing the case area during analysis cancels the stale result', async t => {
  const f = await fixture(t);
  const record = await f.create();
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const worker = f.monitor({ analyze: async () => {
    entered.resolve(); await release.promise; return newer();
  }, notify: async () => assert.fail('old area') });
  const work = worker.tick();
  await entered.promise;
  await f.store.update(record.id, 101, draft => { draft.area.lat = 44; });
  release.resolve();
  await work;
  const saved = await f.store.get(record.id, 101);
  assert.equal(saved.area.lat, 44);
  assert.deepEqual(saved.analysis, record.analysis);
  assert.deepEqual(saved.events, []);
});

test('a blocked notification disables monitoring even when its interval changed during delivery', async t => {
  const f = await fixture(t);
  const record = await f.create();
  await f.monitor({ notify: async () => {
    await f.store.update(record.id, 101, draft => { draft.watch.intervalMs = 14 * DAY; });
    throw { response: { error_code: 403 } };
  } }).tick();
  const saved = await f.store.get(record.id, 101);
  assert.equal(saved.watch.enabled, false);
  assert.equal(saved.watch.intervalMs, 14 * DAY);
  assert.equal(saved.events[0].delivery, 'pending');
});

test('start is idempotent and stop clears the scheduled polling', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const f = await fixture(t);
  let reads = 0;
  const worker = f.monitor({ intervalMs: 1000, store: {
    ...f.store, listAll: async () => { reads++; return f.store.listAll(); },
  } });
  assert.equal(reads, 0);
  await worker.start();
  await worker.start();
  assert.equal(reads, 1);
  t.mock.timers.tick(1000);
  await worker.tick();
  assert.equal(reads, 2);
  worker.stop();
  t.mock.timers.tick(10_000);
  await worker.tick();
  assert.equal(reads, 2);
});

test('a crash after acceptance but before the sent write leaves a recoverable duplicate-delivery window', async t => {
  const f = await fixture(t);
  const record = await f.create();
  const delivered = [];
  const failingStore = { ...f.store, update: (id, owner, mutate) => f.store.update(id, owner, async draft => {
    const result = await mutate(draft);
    if (draft.events.some(event => event.delivery === 'sent')) throw new Error('write failed after send');
    return result;
  }) };
  const worker = f.monitor({ store: failingStore, notify: async (_record, event) => delivered.push(event.id) });
  await assert.rejects(worker.tick(), /persist/);
  assert.equal(delivered.length, 1);
  assert.equal((await f.store.get(record.id, 101)).events[0].delivery, 'pending');
  worker.stop();
  f.advance(1);
  await f.monitor({ store: createLandStore({ file: f.file }), analyze: async () => assert.fail('retry pending'),
    notify: async (_record, event) => delivered.push(event.id) }).tick();
  assert.deepEqual(delivered, [delivered[0], delivered[0]]);
  assert.equal((await f.store.get(record.id, 101)).events[0].delivery, 'sent');
});

test('real geometry analyses retain the original baseline through consecutive worker checks', async t => {
  const { createArea, analyzePair } = await import('../src/land/geometry.js');
  const f = await fixture(t);
  const grid = createArea({ lat: 43, lon: 76, halfSizeMeters: 250 });
  function scene(id, datetime, bare = []) {
    const count = grid.width * grid.height;
    const bands = { red: Array(count).fill(0.08), green: Array(count).fill(0.12),
      blue: Array(count).fill(0.07), nir: Array(count).fill(0.6), swir16: Array(count).fill(0.1), scl: Array(count).fill(4) };
    for (const index of bare) {
      bands.red[index] = 0.3; bands.nir[index] = 0.25; bands.swir16[index] = 0.45; bands.scl[index] = 5;
    }
    return { id, datetime, sourceUrl: `https://example.test/${id}`, bands };
  }
  const baseline = scene('fixed-baseline', '2025-09-20T00:00:00Z');
  const previous = analyzePair(baseline, scene('previous', '2026-09-20T00:00:00Z', [0, 1, 25, 26]), grid);
  const next = analyzePair(baseline, scene('next', '2026-09-24T00:00:00Z', [0, 1, 2, 3, 25, 26, 27, 28]), grid);
  const record = await f.create({ area: grid, analysis: previous });
  let call = 0;
  const worker = f.monitor({ analyze: async current => {
    assert.equal(current.analysis.before.id, 'fixed-baseline');
    call++;
    return call === 1 ? next : analyzePair(baseline,
      scene('later', '2026-10-02T00:00:00Z', [0, 1, 2, 3, 25, 26, 27, 28]), grid);
  } });
  await worker.tick();
  assert.equal((await f.store.get(record.id, 101)).events[0].additionalHectares, 0.16);
  f.advance(7);
  await worker.tick();
  const saved = await f.store.get(record.id, 101);
  assert.equal(saved.analysis.after.id, 'later');
  assert.equal(saved.analysis.before.id, 'fixed-baseline');
  assert.equal(saved.events.length, 1);
});
