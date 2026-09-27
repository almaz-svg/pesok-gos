import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { normalizeTelegramUserId } from '../reports.js';

const queues = new Map();
const ID = /^[a-f0-9]{12}$/;

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validateJson(value, ancestors = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean'
    || (typeof value === 'number' && Number.isFinite(value))) return;
  if ((!Array.isArray(value) && (!isObject(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value)))) || ancestors.has(value)) {
    throw new Error('Land records must contain finite JSON data.');
  }
  ancestors.add(value);
  for (const entry of Object.values(value)) validateJson(entry, ancestors);
  ancestors.delete(value);
}

function validateRecord(record, id) {
  if (!isObject(record) || !ID.test(id) || record.id !== id
    || !Number.isSafeInteger(record.owner) || record.owner <= 0
    || !['ru', 'kk'].includes(record.language) || !isObject(record.area)
    || !Number.isFinite(Date.parse(record.createdAt)) || !Number.isFinite(Date.parse(record.updatedAt))
    || !['open', 'closed'].includes(record.localStatus)
    || !isObject(record.watch) || typeof record.watch.enabled !== 'boolean'
    || typeof record.reviewRequested !== 'boolean'
    || !Array.isArray(record.evidence) || record.evidence.length > 20
    || !Array.isArray(record.events) || record.events.length > 50) {
    throw new Error('Invalid land case record.');
  }
  const eventIds = new Set();
  for (const event of record.events) {
    if (!isObject(event) || typeof event.id !== 'string' || !event.id || eventIds.has(event.id)) {
      throw new Error('Land events require unique ids.');
    }
    eventIds.add(event.id);
  }
  validateJson(record);
}

function boundHistory(record, previous) {
  if (!Array.isArray(record.evidence) || !Array.isArray(record.events)) {
    throw new Error('Land evidence and events must be arrays.');
  }
  record.evidence = record.evidence.slice(-20);
  // A history replacement or trim cannot silently discard undelivered alerts.
  const missing = previous.events.filter(event => event.delivery === 'pending'
    && !record.events.some(next => next?.id === event.id));
  record.events = [...missing, ...record.events];
  const pending = record.events.filter(event => event?.delivery === 'pending').length;
  if (pending > 50) throw new Error('Land pending event limit reached.');
  let remove = Math.max(0, record.events.length - 50);
  record.events = record.events.filter(event => {
    if (remove && event?.delivery !== 'pending') {
      remove--;
      return false;
    }
    return true;
  });
}

// Serialize all instances targeting one file in this process. Use one writer process.
function enqueue(file, work) {
  const operation = (queues.get(file) ?? Promise.resolve()).then(work);
  const recovered = operation.catch(() => {});
  queues.set(file, recovered);
  void recovered.then(() => {
    if (queues.get(file) === recovered) queues.delete(file);
  });
  return operation;
}

/** Owner checks are data scoping. The parent must authorize operator access first. */
export function createLandStore({ file = resolve('data/land-cases.json') } = {}) {
  file = resolve(file);

  async function readRecords() {
    let content;
    try {
      content = await readFile(file, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return {};
      throw error;
    }
    const records = JSON.parse(content);
    if (!isObject(records)) throw new Error('Land store must contain a JSON object.');
    const counts = new Map();
    for (const [id, record] of Object.entries(records)) {
      validateRecord(record, id);
      const count = (counts.get(record.owner) ?? 0) + 1;
      if (count > 10) throw new Error('Land case limit exceeded in store.');
      counts.set(record.owner, count);
    }
    return records;
  }

  async function saveRecords(records) {
    await mkdir(dirname(file), { recursive: true });
    const temporaryFile = `${file}.${randomUUID()}.tmp`;
    try {
      const handle = await open(temporaryFile, 'wx');
      try {
        await handle.writeFile(`${JSON.stringify(records, null, 2)}\n`, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporaryFile, file);
    } catch (error) {
      await rm(temporaryFile, { force: true }).catch(() => {});
      throw error;
    }
  }

  async function readAfterWrites() {
    await queues.get(file);
    return readRecords();
  }

  return {
    async create(owner, { area, language }) {
      owner = Number(normalizeTelegramUserId(owner));
      const timestamp = new Date().toISOString();
      const record = {
        id: randomBytes(6).toString('hex'), owner, language, area,
        createdAt: timestamp, updatedAt: timestamp,
        evidence: [], events: [], localStatus: 'open', watch: { enabled: false },
        reviewRequested: false,
      };
      validateRecord(record, record.id);
      const snapshot = structuredClone(record);
      return enqueue(file, async () => {
        const records = await readRecords();
        if (Object.values(records).filter(item => item.owner === owner).length >= 10) {
          throw new Error('Land case limit is 10 per owner.');
        }
        while (Object.hasOwn(records, snapshot.id)) snapshot.id = randomBytes(6).toString('hex');
        records[snapshot.id] = snapshot;
        await saveRecords(records);
        return structuredClone(snapshot);
      });
    },

    async get(id, owner) {
      owner = Number(normalizeTelegramUserId(owner));
      if (typeof id !== 'string' || !ID.test(id)) return null;
      const record = (await readAfterWrites())[id];
      return record?.owner === owner ? structuredClone(record) : null;
    },

    async list(owner) {
      owner = Number(normalizeTelegramUserId(owner));
      return Object.values(await readAfterWrites()).filter(record => record.owner === owner);
    },

    // Internal worker/operator use only; never expose as an unscoped user endpoint.
    async listAll() {
      return Object.values(await readAfterWrites());
    },

    // Mutate a detached draft, or return a replacement. Returning null aborts the write.
    // Async mutators are supported; do not re-enter the same queued store from one.
    async update(id, owner, mutator) {
      owner = Number(normalizeTelegramUserId(owner));
      if (typeof id !== 'string' || !ID.test(id)) return null;
      if (typeof mutator !== 'function') throw new Error('Land update requires a mutator.');
      return enqueue(file, async () => {
        const records = await readRecords();
        const previous = records[id];
        if (previous?.owner !== owner) return null;
        const draft = structuredClone(previous);
        const result = await mutator(draft);
        if (result === null) return null;
        const next = result === undefined ? draft : result;
        if (draft.id !== id || draft.owner !== owner || next?.id !== id || next?.owner !== owner) {
          throw new Error('A land update cannot change id or owner.');
        }
        const snapshot = structuredClone(next);
        boundHistory(snapshot, previous);
        snapshot.updatedAt = new Date().toISOString();
        validateRecord(snapshot, id);
        records[id] = snapshot;
        await saveRecords(records);
        return structuredClone(snapshot);
      });
    },
  };
}
