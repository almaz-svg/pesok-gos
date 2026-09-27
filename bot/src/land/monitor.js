import { randomBytes } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

const DAY = 86_400_000;
const WATCH_INTERVAL = 7 * DAY;

function watched(record) {
  return record?.localStatus === 'closed' && record.watch?.enabled === true;
}

function due(record, time) {
  return watched(record) && (record.watch.nextCheckAt == null
    || Date.parse(record.watch.nextCheckAt) <= time.getTime());
}

function nextCheck(time, delay) {
  return new Date(time.getTime() + delay).toISOString();
}

function watchInterval(record) {
  return Number.isSafeInteger(record.watch.intervalMs) && record.watch.intervalMs >= DAY
    ? record.watch.intervalMs : WATCH_INTERVAL;
}

function jsonMetadata(analysis) {
  try {
    return !analysis?.before?.bands && !analysis?.after?.bands
      && isDeepStrictEqual(analysis, JSON.parse(JSON.stringify(analysis)));
  } catch {
    return false;
  }
}

function validAnalysis(analysis) {
  const grid = analysis?.area;
  if (!jsonMetadata(analysis) || !['change', 'no_change'].includes(analysis?.status)
    || typeof analysis.method !== 'string' || !analysis.method
    || !grid || !Number.isSafeInteger(grid.width) || grid.width <= 0
    || !Number.isSafeInteger(grid.height) || grid.height <= 0
    || !Number.isFinite(grid.resolution) || grid.resolution <= 0 || !grid.epsg
    || !Array.isArray(grid.projectedBbox) || grid.projectedBbox.length !== 4
    || !grid.projectedBbox.every(Number.isFinite)
    || typeof analysis.before?.id !== 'string' || !analysis.before.id
    || typeof analysis.after?.id !== 'string' || !analysis.after.id
    || !Number.isFinite(Date.parse(analysis.before.datetime))
    || !Number.isFinite(Date.parse(analysis.after.datetime))
    || Date.parse(analysis.before.datetime) >= Date.parse(analysis.after.datetime)
    || !Number.isFinite(analysis.validFraction) || analysis.validFraction <= 0 || analysis.validFraction > 1
    || !Array.isArray(analysis.candidatePixels) || !Array.isArray(analysis.validPixels)
    || !analysis.validPixels.length) return false;
  const pixels = grid.width * grid.height;
  const validIndex = index => Number.isSafeInteger(index) && index >= 0 && index < pixels;
  if (!analysis.validPixels.every(validIndex) || !analysis.candidatePixels.every(validIndex)) return false;
  const valid = new Set(analysis.validPixels);
  return analysis.candidatePixels.every(index => valid.has(index))
    && (analysis.status !== 'no_change' || analysis.candidatePixels.length === 0);
}

function compare(previous, next) {
  if (!validAnalysis(next) || previous.before.id !== next.before.id
    || Date.parse(previous.before.datetime) !== Date.parse(next.before.datetime)
    || previous.method !== next.method || !isDeepStrictEqual(previous.settings, next.settings)
    || !isDeepStrictEqual(previous.area, next.area)) return { outcome: 'insufficient' };
  if (next.after.id === previous.after.id
    || Date.parse(next.after.datetime) <= Date.parse(previous.after.datetime)) return { outcome: 'no_new' };
  const previousCandidates = new Set(previous.candidatePixels);
  const previousValid = new Set(previous.validPixels);
  const shared = new Set(next.validPixels.filter(index => previousValid.has(index)));
  const threshold = previous.settings?.minValidFraction ?? 0.8;
  if (!Number.isFinite(threshold) || threshold <= 0 || threshold > 1
    || shared.size / (next.area.width * next.area.height) < threshold) return { outcome: 'insufficient' };
  // Both masks already describe common clear pixels against the fixed baseline.
  const additional = new Set(next.candidatePixels.filter(index =>
    previousValid.has(index) && !previousCandidates.has(index)));
  return {
    outcome: additional.size ? 'additional_change' : 'no_new',
    analysis: next,
    additionalHectares: additional.size * next.area.resolution ** 2 / 10_000,
  };
}

function blocked(error) {
  return [error?.response?.error_code, error?.status, error?.statusCode, error?.code]
    .some(code => Number(code) === 403);
}

/**
 * intervalMs is the polling cadence (one minute by default). Each case uses
 * watch.intervalMs >= one day, default seven days; unavailable scenes and sends
 * retry after one day. analyze returns JSON metadata only, never image buffers.
 * Import/construction starts no work. start() runs a tick and schedules polling;
 * stop() invalidates in-flight analysis and prevents any further dispatch.
 *
 * Delivery is at least once: a crash after Telegram accepts a message but before
 * its event is marked sent can cause a retry. Telegram has no idempotency key,
 * so exactly-once delivery cannot be guaranteed. An already-started send cannot
 * be recalled by stop(); its success is still recorded to avoid needless retry.
 */
export function createMonitor({ store, analyze, notify, now = () => new Date(), intervalMs = 60_000 }) {
  if (!store || typeof analyze !== 'function' || typeof notify !== 'function'
    || !Number.isSafeInteger(intervalMs) || intervalMs <= 0 || intervalMs > 2_147_483_647) {
    throw new Error('Land monitor requires a store, analyze, notify and a valid polling interval.');
  }
  let timer;
  let active;
  let stopped = false;
  let generation = 0;

  const running = token => !stopped && token === generation;

  function currentAnalysis(current, snapshot, token) {
    return running(token) && watched(current)
      && isDeepStrictEqual(current.watch, snapshot.watch)
      && isDeepStrictEqual(current.area, snapshot.area)
      && isDeepStrictEqual(current.analysis, snapshot.analysis)
      && isDeepStrictEqual(current.boundary, snapshot.boundary);
  }

  async function deliver(reserved, eventId, token) {
    const latest = await store.get(reserved.id, reserved.owner);
    if (!running(token) || !watched(latest) || !isDeepStrictEqual(latest.watch, reserved.watch)) return;
    const event = latest.events.find(item => item.id === eventId && item.delivery === 'pending');
    if (!event) return;
    let failure;
    try {
      await notify(structuredClone(latest), structuredClone(event));
    } catch (error) {
      failure = { error };
    }
    await store.update(latest.id, latest.owner, current => {
      const pending = current.events.find(item => item.id === eventId && item.delivery === 'pending');
      if (!pending) return null;
      if (!failure) pending.delivery = 'sent';
      if (failure && blocked(failure.error)) {
        current.watch.enabled = false;
        current.watch.lastOutcome = 'blocked';
        return;
      }
      // Keep user changes made during the network request, including reopening.
      if (running(token) && watched(current) && isDeepStrictEqual(current.watch, latest.watch)) {
        current.watch.lastOutcome = failure ? 'delivery_failed' : 'additional_change';
        const retry = failure || current.events.some(item => item.delivery === 'pending');
        current.watch.nextCheckAt = nextCheck(now(), retry ? DAY : watchInterval(current));
      }
      if (failure && !running(token)) return null;
    });
  }

  async function processCase(snapshot, token) {
    if (!running(token)) return;
    snapshot = await store.get(snapshot.id, snapshot.owner);
    if (!running(token) || !due(snapshot, now())) return;
    const pending = snapshot.events.find(event => event.delivery === 'pending');
    if (pending) {
      const reserved = await store.update(snapshot.id, snapshot.owner, current => {
        if (!running(token) || !due(current, now())
          || !current.events.some(event => event.id === pending.id && event.delivery === 'pending')) return null;
        current.watch.nextCheckAt = nextCheck(now(), DAY);
      });
      if (reserved) await deliver(reserved, pending.id, token);
      return;
    }

    let result = { outcome: 'insufficient' };
    if (validAnalysis(snapshot.analysis)) {
      try {
        result = compare(snapshot.analysis, await analyze(structuredClone(snapshot)));
      } catch (error) {
        const outcome = error?.code === 'SATELLITE_NO_NEW' ? 'no_new'
          : error?.code === 'SATELLITE_NO_PAIR' ? 'insufficient' : 'providerfail';
        result = { outcome };
      }
    }
    let eventId;
    const saved = await store.update(snapshot.id, snapshot.owner, current => {
      // Re-read under the store queue; analysis runs outside it so user actions
      // remain responsive, and stale results cannot restore a disabled watch.
      if (!currentAnalysis(current, snapshot, token)) return null;
      const time = now();
      current.watch.lastOutcome = result.outcome;
      current.watch.lastCheckedAt = time.toISOString();
      if (result.analysis) current.analysis = structuredClone(result.analysis);
      current.watch.nextCheckAt = nextCheck(time, result.analysis ? watchInterval(current) : DAY);
      if (result.additionalHectares > 0) {
        do { eventId = randomBytes(6).toString('hex'); } while (current.events.some(event => event.id === eventId));
        current.events.push({
          id: eventId, type: 'additional_change', createdAt: time.toISOString(),
          // Retries can outlive a manual baseline/analysis replacement.
          analysisAfterId: result.analysis.after.id,
          analysisAfterDate: result.analysis.after.datetime,
          sourceUrl: typeof result.analysis.after.sourceUrl === 'string' ? result.analysis.after.sourceUrl : null,
          additionalHectares: result.additionalHectares,
          delivery: 'pending',
        });
        current.watch.nextCheckAt = nextCheck(time, DAY);
      }
    });
    if (saved && eventId) await deliver(saved, eventId, token);
  }

  async function sweep(token) {
    const errors = [];
    for (const record of await store.listAll()) {
      if (!running(token)) break;
      if (!due(record, now())) continue;
      try {
        await processCase(record, token);
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length) throw new AggregateError(errors, 'Land monitoring could not persist one or more cases.');
  }

  function tick() {
    if (stopped) return Promise.resolve();
    if (!active) {
      active = sweep(generation).finally(() => { active = undefined; });
    }
    return active;
  }

  function scheduledTick() {
    const work = tick();
    void work.catch(() => { console.error('Land monitor tick failed.'); });
    return work;
  }

  return {
    tick,
    start() {
      if (timer) return active ?? Promise.resolve();
      stopped = false;
      timer = setInterval(scheduledTick, intervalMs);
      timer.unref?.();
      return scheduledTick();
    },
    stop() {
      stopped = true;
      generation++;
      clearInterval(timer);
      timer = undefined;
    },
  };
}
