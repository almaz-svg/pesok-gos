import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createLandStore } from '../src/land/store.js';

const area = { lat: 43, lon: 76, halfSizeMeters: 250 };

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'zher-land-store-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'cases.json');
  return { directory, file, store: createLandStore({ file }) };
}

test('missing store is empty without creating a file', async t => {
  const { directory, store } = await fixture(t);
  assert.deepEqual(await store.list(101), []);
  assert.deepEqual(await store.listAll(), []);
  assert.equal(await store.get('0123456789ab', 101), null);
  assert.deepEqual(await readdir(directory), []);
});

test('creates owner-scoped cases with detached defaults and persists across restart', async t => {
  const { file, directory, store } = await fixture(t);
  const input = { area: structuredClone(area), language: 'kk' };
  const record = await store.create('101', input);
  assert.match(record.id, /^[a-f0-9]{12}$/);
  assert.equal(record.owner, 101);
  assert.equal(record.language, 'kk');
  assert.deepEqual(record.area, area);
  assert.deepEqual(record.evidence, []);
  assert.deepEqual(record.events, []);
  assert.equal(record.localStatus, 'open');
  assert.deepEqual(record.watch, { enabled: false });
  assert.equal(record.reviewRequested, false);
  assert.ok(Number.isFinite(Date.parse(record.createdAt)));
  assert.equal(record.updatedAt, record.createdAt);
  input.area.lat = 0;
  record.area.lon = 0;
  const reopened = createLandStore({ file });
  assert.deepEqual((await reopened.get(record.id, 101)).area, area);
  assert.equal(await reopened.get(record.id, 202), null);
  assert.equal(await reopened.update(record.id, 202, () => assert.fail('wrong owner')), null);
  assert.equal(await reopened.update('000000000000', 101, () => assert.fail('missing')), null);
  assert.deepEqual(await reopened.list(202), []);
  assert.equal((await reopened.list('101')).length, 1);
  assert.deepEqual(await readdir(directory), ['cases.json']);
});

test('internal discovery lets an allowlisted parent use the actual owner for operator updates', async t => {
  const { store } = await fixture(t);
  const record = await store.create(101, { area, language: 'ru' });
  const [internal] = await store.listAll();
  await store.update(internal.id, internal.owner, draft => { draft.reviewRequested = true; });
  assert.equal((await store.get(record.id, internal.owner)).reviewRequested, true);
  assert.equal((await store.list(internal.owner)).length, 1);
});

test('service metadata and Telegram file ids survive mutations and reopening', async t => {
  const { store, file } = await fixture(t);
  const record = await store.create(101, { area, language: 'ru' });
  const metadata = {
    analysisAttempts: [{ at: '2026-09-26T00:00:00Z', kind: 'monitor' }],
    imagery: { afterId: 'scene-2', beforeFileId: 'tg-before', afterFileId: 'tg-after', overlayFileId: 'tg-overlay' },
    boundary: { geometry: { type: 'Polygon', coordinates: [] }, source: 'upload', revision: 2,
      verifiedBy: 202, reviewedAt: '2026-09-26T01:00:00Z', note: 'reviewed' },
    evidence: [{ id: 'ev-1', fileId: 'tg-evidence', caption: 'field', createdAt: '2026-09-26T00:00:00Z',
      review: { by: 202, decision: 'accepted' } }],
    reviewRequestedAt: '2026-09-26T00:30:00Z',
  };
  await store.update(record.id, 101, draft => Object.assign(draft, metadata));
  const restored = await createLandStore({ file }).get(record.id, 101);
  for (const [key, value] of Object.entries(metadata)) assert.deepEqual(restored[key], value);
});

test('queued updates and reads see every change, including across instances for one file', async t => {
  const { file, store } = await fixture(t);
  const other = createLandStore({ file });
  const record = await store.create(101, { area, language: 'ru' });
  const writes = Array.from({ length: 20 }, (_, i) => (i % 2 ? other : store)
    .update(record.id, 101, async draft => {
      await new Promise(resolve => setImmediate(resolve));
      draft.count = (draft.count ?? 0) + 1;
    }));
  const read = store.get(record.id, 101);
  await Promise.all(writes);
  assert.equal((await read).count, 20);
  assert.equal((await other.get(record.id, 101)).count, 20);
});

test('update uses clones, accepts returned records, and preserves state on failed mutations', async t => {
  const { file, store } = await fixture(t);
  const record = await store.create(101, { area, language: 'ru' });
  let leaked;
  const result = await store.update(record.id, 101, draft => {
    leaked = draft;
    return { ...draft, reportId: 'report-1' };
  });
  leaked.area.lat = 0;
  result.area.lon = 0;
  assert.deepEqual((await store.get(record.id, 101)).area, area);
  const before = await readFile(file, 'utf8');
  await assert.rejects(store.update(record.id, 101, draft => {
    draft.localStatus = 'closed';
    throw new Error('cancelled');
  }), /cancelled/);
  assert.equal(await readFile(file, 'utf8'), before);
  assert.equal(await store.update(record.id, 101, () => null), null);
  assert.equal(await readFile(file, 'utf8'), before);
  await store.update(record.id, 101, draft => { draft.localStatus = 'closed'; });
  assert.equal((await store.get(record.id, 101)).localStatus, 'closed');
});

test('mutators cannot transfer ownership or change ids', async t => {
  const { file, store } = await fixture(t);
  const record = await store.create(101, { area, language: 'ru' });
  const before = await readFile(file, 'utf8');
  for (const changes of [{ owner: 202 }, { id: 'abcdef123456' }]) {
    await assert.rejects(store.update(record.id, 101, draft => Object.assign(draft, changes)), /owner|id/i);
  }
  assert.equal(await readFile(file, 'utf8'), before);
});

test('concurrent creation enforces ten cases per owner without affecting another owner', async t => {
  const { store } = await fixture(t);
  const attempts = await Promise.allSettled(Array.from({ length: 12 }, () =>
    store.create(101, { area, language: 'ru' })));
  assert.equal(attempts.filter(result => result.status === 'fulfilled').length, 10);
  assert.equal((await store.list(101)).length, 10);
  assert.equal(new Set((await store.list(101)).map(record => record.id)).size, 10);
  assert.equal((await store.create(202, { area, language: 'kk' })).owner, 202);
});

test('evidence and event history are bounded without evicting old pending alerts', async t => {
  const { store } = await fixture(t);
  const record = await store.create(101, { area, language: 'ru' });
  const result = await store.update(record.id, 101, draft => {
    draft.evidence = Array.from({ length: 30 }, (_, id) => ({ id }));
    draft.events = Array.from({ length: 60 }, (_, id) => ({
      id: String(id), delivery: id < 2 ? 'pending' : 'sent',
    }));
  });
  assert.equal(result.evidence.length, 20);
  assert.equal(result.evidence[0].id, 10);
  assert.equal(result.events.length, 50);
  assert.deepEqual(result.events.slice(0, 3).map(event => event.id), ['0', '1', '12']);
  assert.equal(result.events.at(-1).id, '59');
  const changed = await store.update(record.id, 101, draft => { draft.events = []; });
  assert.deepEqual(changed.events.map(event => event.id), ['0', '1']);
});

test('more than fifty pending alerts rejects the mutation without losing any saved alerts', async t => {
  const { file, store } = await fixture(t);
  const record = await store.create(101, { area, language: 'ru' });
  await store.update(record.id, 101, draft => {
    draft.events = Array.from({ length: 50 }, (_, id) => ({ id: String(id), delivery: 'pending' }));
  });
  const before = await readFile(file, 'utf8');
  await assert.rejects(store.update(record.id, 101, draft => {
    draft.events.push({ id: 'overflow', delivery: 'pending' });
  }), /pending|limit/i);
  assert.equal(await readFile(file, 'utf8'), before);
});

test('invalid owners and ids cannot access or alter cases', async t => {
  const { file, store } = await fixture(t);
  const record = await store.create(Number.MAX_SAFE_INTEGER, { area, language: 'ru' });
  const before = await readFile(file, 'utf8');
  for (const owner of [undefined, null, '', 0, -1, 1.5, NaN, Infinity,
    Number.MAX_SAFE_INTEGER + 1, '01', ' 101', '+101', true, {}, [], 101n, '__proto__']) {
    await assert.rejects(() => store.create(owner, { area, language: 'ru' }));
    await assert.rejects(() => store.get(record.id, owner));
    await assert.rejects(() => store.list(owner));
    await assert.rejects(() => store.update(record.id, owner, () => {}));
  }
  for (const id of ['__proto__', 'constructor', '../cases', '', null, 1]) {
    assert.equal(await store.get(id, record.owner), null);
    assert.equal(await store.update(id, record.owner, () => assert.fail()), null);
  }
  assert.equal(await readFile(file, 'utf8'), before);
});

test('invalid records and corrupt files are preserved, and repaired files recover the queue', async t => {
  const { file, store } = await fixture(t);
  const record = await store.create(101, { area, language: 'ru' });
  const good = await readFile(file, 'utf8');
  for (const content of ['', '{broken', 'null', '[]', '42', '{"bad":{}}',
    JSON.stringify({ [record.id]: { ...record, owner: 0 } }),
    JSON.stringify({ [record.id]: { ...record, events: null } })]) {
    await writeFile(file, content);
    await assert.rejects(store.listAll());
    await assert.rejects(store.get(record.id, 101));
    await assert.rejects(store.create(202, { area, language: 'ru' }));
    await assert.rejects(store.update(record.id, 101, () => {}));
    assert.equal(await readFile(file, 'utf8'), content);
  }
  await writeFile(file, good);
  await store.update(record.id, 101, draft => { draft.language = 'kk'; });
  assert.equal((await store.get(record.id, 101)).language, 'kk');
});

test('invalid data is rejected without creating a file', async t => {
  const { directory, store } = await fixture(t);
  for (const input of [{ area, language: 'en' }, { area: null, language: 'ru' },
    { area: { lat: NaN }, language: 'ru' }]) {
    await assert.rejects(store.create(101, input));
  }
  assert.deepEqual(await readdir(directory), []);
});

test('filesystem failures do not poison later writes', async t => {
  const { directory } = await fixture(t);
  const blocked = join(directory, 'blocked');
  await writeFile(blocked, 'keep');
  const store = createLandStore({ file: join(blocked, 'cases.json') });
  await assert.rejects(store.create(101, { area, language: 'ru' }));
  assert.equal(await readFile(blocked, 'utf8'), 'keep');
  await rm(blocked);
  assert.equal((await store.create(101, { area, language: 'ru' })).owner, 101);
  assert.deepEqual(await readdir(blocked), ['cases.json']);
});
