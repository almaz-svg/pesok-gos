import test from 'node:test';
import assert from 'node:assert/strict';
import { createLandService, readOperatorIds } from '../src/land/service.js';

function setup(options = {}) {
  const records = new Map();
  const store = {
    async create(owner, data) {
      const record = { id: '123456abcdef', owner: String(owner), ...data,
        evidence: [], events: [], watch: { enabled: false }, localStatus: 'open' };
      records.set(record.id, record);
      return structuredClone(record);
    },
    async get(id, owner) { const r = records.get(id); return r?.owner === String(owner) ? structuredClone(r) : null; },
    async listAll() { return structuredClone([...records.values()]); },
    async list(owner) { return (await this.listAll()).filter(r => r.owner === String(owner)); },
    async update(id, owner, fn) {
      const r = await this.get(id, owner);
      if (!r) return null;
      const next = fn(r) || r;
      records.set(id, structuredClone(next));
      return structuredClone(next);
    },
  };
  let calls = 0;
  const service = createLandService({ store, operatorIds: ['77'],
    provider: { async getPair() { calls++; return { before: {}, after: {} }; } },
    analyzePair: () => ({ status: 'change', candidatePixels: [0], validPixels: [0],
      before: { id: 'before' }, after: { id: 'after' }, boundary: { status: 'missing', outsideHectares: null } }),
    renderScene: () => Buffer.from('png'), ...options });
  return { service, store, calls: () => calls };
}

test('operator allowlist rejects malformed configuration and never auto-enrols users', () => {
  assert.deepEqual(readOperatorIds(''), []);
  assert.deepEqual(readOperatorIds('77, 88'), ['77', '88']);
  assert.throws(() => readOperatorIds('77,anyone'));
  assert.throws(() => readOperatorIds('-77'));
});

test('case creation does not contact imagery provider; analysis checks owner and rate limits', async () => {
  const { service, calls } = setup();
  const r = await service.create(12, { lat: 51, lon: 71, halfSizeMeters: 250 }, 'ru');
  assert.equal(calls(), 0);
  await assert.rejects(service.analyze(r.id, 13), { code: 'LAND_NOT_FOUND' });
  for (let i = 0; i < 5; i++) await service.analyze(r.id, 12);
  await assert.rejects(service.analyze(r.id, 12), { code: 'LAND_LIMIT' });
  assert.equal(calls(), 5);
});

test('one shared analysis lock rejects concurrent user and monitor work and releases on errors', async () => {
  let release;
  const { service } = setup({ provider: { getPair: () => new Promise(resolve => { release = resolve; }) } });
  const r = await service.create(12, { lat: 51, lon: 71, halfSizeMeters: 250 }, 'ru');
  const first = service.analyze(r.id, 12);
  while (!release) await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(service.analyzeMonitor(r), { code: 'LAND_BUSY' });
  release({ before: {}, after: {} });
  assert.equal((await first).images.length, 3);
});

test('local closure never silently starts monitoring; reopening disables it', async () => {
  const { service } = setup();
  const r = await service.create(12, { lat: 51, lon: 71, halfSizeMeters: 250 }, 'ru');
  await assert.rejects(service.setWatch(r.id, 12, true), { code: 'LAND_WATCH' });
  await service.analyze(r.id, 12);
  assert.equal((await service.setClosed(r.id, 12, true)).watch.enabled, false);
  assert.equal((await service.setWatch(r.id, 12, true)).watch.enabled, true);
  assert.equal((await service.setClosed(r.id, 12, false)).watch.enabled, false);
});

test('review needs explicit sharing, trusted actor, current revision and a reason', async () => {
  const { service, store } = setup();
  const r = await service.create(12, { lat: 51, lon: 71, halfSizeMeters: 250 }, 'ru');
  await store.update(r.id, 12, x => { x.evidence.push({ id: 'abcdef123456', fileId: 'photo' }); });
  await assert.rejects(service.review(r.id, 77, 'evidence', 'abcdef123456', true, 'Seen'), { code: 'LAND_NOT_FOUND' });
  await service.shareReview(r.id, 12, true);
  await assert.rejects(service.review(r.id, 12, 'evidence', 'abcdef123456', true, 'Seen'), { code: 'LAND_FORBIDDEN' });
  await assert.rejects(service.review(r.id, 77, 'evidence', 'outdated', true, 'Seen'), { code: 'LAND_STALE' });
  await assert.rejects(service.review(r.id, 77, 'evidence', 'abcdef123456', true, ''), { code: 'LAND_INPUT' });
  const reviewed = await service.review(r.id, 77, 'evidence', 'abcdef123456', true, 'Visible exposed soil, cause unknown');
  assert.equal(reviewed.evidence[0].review.actor, '77');
  await service.shareReview(r.id, 12, false);
  assert.equal((await service.reviewQueue(77)).length, 0);
});

test('field evidence is bounded and stays unverified until an operator decision', async () => {
  const { service } = setup();
  const r = await service.create(12, { lat: 51, lon: 71, halfSizeMeters: 250 }, 'kk');
  const result = await service.addEvidence(r.id, 12, 'telegram-photo', 'Taken today from public road');
  assert.equal(result.evidence[0].review, undefined);
  await assert.rejects(service.addEvidence(r.id, 13, 'photo', ''), { code: 'LAND_NOT_FOUND' });
});
