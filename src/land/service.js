import { createHash, randomBytes } from 'node:crypto';
import { createArea, validateBoundary, analyzePair, compareBoundary } from './geometry.js';
import { createSatelliteProvider, renderScene } from './satellite.js';
import { createLandStore } from './store.js';

const fail = code => { throw Object.assign(new Error(code), { code }); };
const id = () => randomBytes(6).toString('hex');

export function analysisVersion(record) {
  return createHash('sha256').update(JSON.stringify(record.analysis || null)).digest('hex').slice(0, 12);
}

export function readOperatorIds(value = process.env.TELEGRAM_OPERATOR_IDS || '') {
  if (!value.trim()) return [];
  const ids = value.split(',').map(item => item.trim());
  if (ids.some(item => !/^[1-9]\d{0,15}$/.test(item) || !Number.isSafeInteger(Number(item)))) {
    throw new Error('TELEGRAM_OPERATOR_IDS must contain positive numeric Telegram IDs separated by commas');
  }
  return [...new Set(ids)];
}

export function createLandService(options = {}) {
  const store = options.store || createLandStore({});
  const provider = options.provider || createSatelliteProvider();
  const operators = new Set((options.operatorIds || readOperatorIds()).map(String));
  const now = options.now || (() => new Date());
  const analyze = options.analyzePair || analyzePair;
  const render = options.renderScene || renderScene;
  let busy = false;

  async function owned(caseId, owner) {
    const record = await store.get(caseId, owner);
    if (!record) fail('LAND_NOT_FOUND');
    return record;
  }

  async function update(caseId, owner, mutate) {
    await owned(caseId, owner);
    const result = await store.update(caseId, owner, record => { mutate(record); });
    if (!result) fail('LAND_NOT_FOUND');
    return result;
  }

  async function compute(record, monitoring) {
    if (busy) fail('LAND_BUSY');
    busy = true;
    try {
      const date = now().toISOString();
      const day = date.slice(0, 10);
      const all = await store.listAll();
      const attempts = all.flatMap(r => (r.analysisAttempts || [])
        .filter(a => a.at.startsWith(day)).map(a => ({ ...a, owner: String(r.owner) })));
      if (attempts.length >= 50 || (!monitoring && attempts.filter(a => a.owner === String(record.owner) && a.kind === 'user').length >= 5)) {
        fail('LAND_LIMIT');
      }
      await update(record.id, record.owner, r => {
        r.analysisAttempts = [...(r.analysisAttempts || []).filter(a => a.at.startsWith(day)),
          { at: date, kind: monitoring ? 'monitor' : 'user' }];
      });
      const pair = await provider.getPair(record.area, monitoring ? {
        baselineId: record.analysis?.before.id, afterDate: record.analysis?.after.datetime,
      } : {});
      const analysis = analyze(pair.before, pair.after, record.area, monitoring ? record.boundary : null);
      analysis.checkedAt = date;
      if (monitoring) return analysis;
      const images = [render(pair.before, record.area), render(pair.after, record.area),
        render(pair.after, record.area, analysis.candidatePixels)];
      const saved = await update(record.id, record.owner, r => {
        r.analysis = { ...analysis, boundary: compareBoundary(analysis, r.boundary) };
        r.imagery = null;
        // A manually selected pair resets the watch baseline; opt-in must be renewed.
        r.watch = { enabled: false };
        delete r.lastError;
      });
      return { record: saved, images };
    } catch (error) {
      if (!monitoring && error.code !== 'LAND_BUSY') {
        await update(record.id, record.owner, r => { r.lastError = { code: error.code || 'SATELLITE_UNAVAILABLE', at: now().toISOString() }; });
      }
      throw error;
    } finally {
      busy = false;
    }
  }

  return {
    store,
    isOperator: actor => operators.has(String(actor)),
    hasOperators: operators.size > 0,
    async create(owner, point, language) {
      let area;
      try { area = createArea(point); } catch { fail('LAND_INPUT'); }
      try { return await store.create(owner, { area, language }); } catch (error) {
        if (/case limit/i.test(error.message)) fail('LAND_LIMIT');
        throw error;
      }
    },
    get: owned,
    list: owner => store.list(owner),
    async analyze(caseId, owner) { return compute(await owned(caseId, owner), false); },
    analyzeMonitor: record => compute(record, true),
    saveImagery: (caseId, owner, imagery) => update(caseId, owner, r => {
      if (r.analysis?.after.id === imagery.afterId) r.imagery = imagery;
    }),
    linkReport: (caseId, owner, reportId) => update(caseId, owner, r => { r.reportId = reportId; }),
    addEvidence: (caseId, owner, fileId, caption = '') => {
      if (typeof fileId !== 'string' || !fileId || fileId.length > 512 || caption.length > 1500) fail('LAND_INPUT');
      return update(caseId, owner, r => {
        if (r.evidence.length >= 20) fail('LAND_LIMIT');
        r.evidence.push({ id: id(), fileId, caption, createdAt: now().toISOString() });
      });
    },
    async setBoundary(caseId, owner, geojson, source) {
      if (typeof source !== 'string' || source.trim().length < 8 || source.length > 1000) fail('LAND_INPUT');
      const record = await owned(caseId, owner);
      let feature;
      try { feature = validateBoundary(geojson, record.area); } catch { fail('LAND_INPUT'); }
      return update(caseId, owner, r => {
        r.boundary = { geometry: feature.geometry, source: source.trim(), revision: id(), uploadedAt: now().toISOString() };
        if (r.analysis) r.analysis.boundary = compareBoundary(r.analysis, r.boundary);
      });
    },
    shareReview: (caseId, owner, enabled) => update(caseId, owner, r => {
      r.reviewRequested = Boolean(enabled);
      r.reviewRequestedAt = now().toISOString();
    }),
    async reviewQueue(actor) {
      if (!operators.has(String(actor))) fail('LAND_FORBIDDEN');
      return (await store.listAll()).filter(r => r.reviewRequested);
    },
    async reviewCase(caseId, actor) {
      if (!operators.has(String(actor))) fail('LAND_FORBIDDEN');
      const record = (await store.listAll()).find(r => r.id === caseId && r.reviewRequested);
      if (!record) fail('LAND_NOT_FOUND');
      return record;
    },
    async review(caseId, actor, kind, revision, accepted, note, analysisAfterId, expectedVersion) {
      if (!operators.has(String(actor))) fail('LAND_FORBIDDEN');
      if (!['boundary', 'evidence'].includes(kind) || typeof note !== 'string' || note.trim().length < 4 || note.length > 1000) fail('LAND_INPUT');
      const record = await this.reviewCase(caseId, actor);
      return update(caseId, record.owner, r => {
        if (!r.reviewRequested) fail('LAND_NOT_FOUND');
        const review = { actor: String(actor), accepted: Boolean(accepted), note: note.trim(), at: now().toISOString() };
        if (kind === 'boundary') {
          if (r.boundary?.revision !== revision) fail('LAND_STALE');
          r.boundary.review = review;
          if (accepted) r.boundary.verifiedBy = String(actor);
          else delete r.boundary.verifiedBy;
          if (r.analysis) r.analysis.boundary = compareBoundary(r.analysis, r.boundary);
        } else {
          if (analysisAfterId !== undefined && (r.analysis?.after.id || null) !== analysisAfterId) fail('LAND_STALE');
          if (expectedVersion !== undefined && analysisVersion(r) !== expectedVersion) fail('LAND_STALE');
          const evidence = r.evidence.find(e => e.id === revision);
          if (!evidence) fail('LAND_STALE');
          review.analysisAfterId = r.analysis?.after.id || null;
          review.analysisVersion = analysisVersion(r);
          evidence.review = review;
        }
      });
    },
    setClosed: (caseId, owner, closed) => update(caseId, owner, r => {
      r.localStatus = closed ? 'closed' : 'open';
      r.watch = { enabled: false };
    }),
    setWatch: (caseId, owner, enabled) => update(caseId, owner, r => {
      if (enabled && (r.localStatus !== 'closed' || !r.analysis || r.analysis.status === 'insufficient_data')) fail('LAND_WATCH');
      r.watch = enabled ? { enabled: true, nextCheckAt: new Date(now().getTime() + 7 * 86400000).toISOString() } : { enabled: false };
    }),
  };
}
