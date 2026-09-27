import test from 'node:test';
import assert from 'node:assert/strict';
import fixture from '../src/data/demo.json' with { type: 'json' };
import { createDemoStore, createApiClient, DEMO_STORAGE_KEY } from '../src/lib/data-client.js';
import { calendarDate, derivePlotStatus, isOverdue } from '../src/lib/domain.js';

const now = () => new Date('2026-09-25T07:00:00Z');
const fresh = (options = {}) => createDemoStore({ now, ...options });
const matches = (code, field) => (error) =>
  error.code === code && (!field || Boolean(error.fields[field]));
const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });

test('a report completes the lifecycle and updates its parcel, map, statistics and history atomically', async () => {
  const store = fresh();
  let report = (await store.getReports()).find((entry) => entry.status === 'NEW' && entry.plot);
  const plotId = report.plot.id;
  const initialStatistics = await store.getStatistics();
  const originalHistory = (await store.getReport(report.id)).history.length;
  const update = async (payload) => {
    report = await store.patchReport(report.id, { version: report.version, ...payload });
  };

  await update({ status: 'INSPECTION' });
  await update({ status: 'VIOLATION' });
  assert.equal((await store.getPlots()).find((plot) => plot.id === plotId).status, 'VIOLATION');
  await assert.rejects(update({ status: 'IN_PROGRESS' }), matches('validation_error', 'deadline'));
  await update({ status: 'IN_PROGRESS', deadline: '2026-09-29' });
  await assert.rejects(update({ status: 'RESOLVED' }), matches('validation_error', 'comment'));
  await update({ status: 'RESOLVED', comment: '  Повторный осмотр завершён, отходы убраны.  ' });

  assert.equal(report.version, 5);
  assert.equal(report.history.length, originalHistory + 4);
  assert.equal(report.history.at(-1).comment, 'Повторный осмотр завершён, отходы убраны.');
  assert.equal(report.history.at(-1).before.status, 'IN_PROGRESS');
  assert.equal(report.history.at(-1).after.status, 'RESOLVED');
  assert.equal((await store.getPlots()).find((plot) => plot.id === plotId).status, 'NORMAL');
  assert.equal(
    (await store.getMap()).plots.features.find((feature) => feature.id === plotId).properties
      .status,
    'NORMAL',
  );
  assert.equal(
    (await store.getMap()).reports.features.find((feature) => feature.id === report.id).properties
      .status,
    'RESOLVED',
  );
  assert.equal((await store.getStatistics()).resolved, initialStatistics.resolved + 1);
  assert.equal(
    (await store.getStatistics()).under_inspection,
    initialStatistics.under_inspection - 1,
  );
});

test('stale versions, forbidden transitions, unknown plots and no-op patches do not mutate data', async () => {
  const store = fresh();
  const report = (await store.getReports()).find((entry) => entry.status === 'NEW');
  const before = await store.getReport(report.id);
  await assert.rejects(
    store.patchReport(report.id, { version: 88, status: 'INSPECTION' }),
    matches('version_conflict'),
  );
  await assert.rejects(
    store.patchReport(report.id, {
      version: report.version,
      status: 'RESOLVED',
      comment: 'Обойти проверку',
    }),
    matches('invalid_transition'),
  );
  await assert.rejects(
    store.patchReport(report.id, { version: report.version, plot_id: 'unknown-parcel' }),
    matches('validation_error', 'plot_id'),
  );
  await assert.rejects(
    store.patchReport(report.id, { version: report.version, status: report.status }),
    matches('no_changes'),
  );
  await assert.rejects(
    store.patchReport(report.id, { version: report.version, category: 'OTHER' }),
    matches('validation_error', 'category'),
  );
  await assert.rejects(
    store.patchReport(report.id, { version: report.version, deadline: '2026-02-30' }),
    matches('validation_error', 'deadline'),
  );
  assert.deepEqual(await store.getReport(report.id), before);
  const updated = await store.patchReport(report.id, {
    version: report.version,
    comment: 'Добавлен результат звонка',
  });
  assert.equal(updated.version, before.version + 1);
  assert.equal(updated.history.length, before.history.length + 1);
  assert.deepEqual(updated.history.at(-1).before, updated.history.at(-1).after);
});

test('unknown-parcel reports remain on the map and assigning/unlinking a parcel recalculates status', async () => {
  const store = fresh();
  const report = (await store.getReports()).find((entry) => !entry.plot);
  const normalPlot = (await store.getPlots()).find((plot) => plot.status === 'NORMAL');
  const marker = (await store.getMap()).reports.features.find(
    (feature) => feature.id === report.id,
  );
  assert.equal(marker.properties.plot_id, null);
  assert.deepEqual(marker.geometry.coordinates, [
    report.location.longitude,
    report.location.latitude,
  ]);
  const linked = await store.patchReport(report.id, {
    version: report.version,
    plot_id: normalPlot.id,
  });
  assert.equal(
    (await store.getPlots()).find((plot) => plot.id === normalPlot.id).status,
    'INSPECTION',
  );
  await store.patchReport(report.id, { version: linked.version, plot_id: null });
  assert.equal((await store.getPlots()).find((plot) => plot.id === normalPlot.id).status, 'NORMAL');

  const initialData = structuredClone(fixture);
  initialData.plots[0].geometry = null;
  const withoutGeometry = fresh({ initialData });
  assert.equal((await withoutGeometry.getPlots()).length, fixture.plots.length);
  assert.equal((await withoutGeometry.getMap()).plots.features.length, fixture.plots.length - 1);
});

test('parcel priority is violation, then inspection, then normal; resolved reports never count as violations', () => {
  assert.equal(derivePlotStatus([]), 'NORMAL');
  assert.equal(derivePlotStatus([{ status: 'RESOLVED' }]), 'NORMAL');
  assert.equal(derivePlotStatus([{ status: 'RESOLVED' }, { status: 'NEW' }]), 'INSPECTION');
  assert.equal(
    derivePlotStatus([{ status: 'INSPECTION' }, { status: 'IN_PROGRESS' }]),
    'VIOLATION',
  );
});

test('overdue uses the Qyzylorda calendar day, excluding the deadline day and closed reports', () => {
  const report = { status: 'IN_PROGRESS', deadline: '2026-09-24' };
  assert.equal(calendarDate(new Date('2026-09-24T18:59:59Z')), '2026-09-24');
  assert.equal(isOverdue(report, new Date('2026-09-24T18:59:59Z')), false);
  assert.equal(isOverdue(report, new Date('2026-09-24T19:00:00Z')), true);
  assert.equal(isOverdue({ ...report, status: 'RESOLVED' }, now()), false);
  assert.equal(isOverdue({ ...report, deadline: null }, now()), false);
});

test('demo arrivals persist across stores, are detached copies and can be reset', async () => {
  const cache = new Map();
  const storage = {
    getItem: (key) => cache.get(key),
    setItem: (key, value) => cache.set(key, value),
  };
  const store = fresh({ storage });
  const added = await store.addDemoReport();
  assert.equal(added.status, 'NEW');
  assert.match(added.tracking_number, /^DEMO-/);
  assert.ok(cache.has(DEMO_STORAGE_KEY));
  const anotherTab = fresh({ storage });
  assert.equal((await anotherTab.getReports()).length, fixture.reports.length + 1);
  added.description = 'Изменение копии';
  assert.notEqual((await anotherTab.getReport(added.id)).description, added.description);
  await anotherTab.resetDemoData();
  assert.equal((await store.getReports()).length, fixture.reports.length);
});

test('API follows pagination, keeps session cookies and rotates CSRF after login', async () => {
  const calls = [];
  const api = createApiClient({
    baseUrl: 'https://backend.example/api',
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      const path = new URL(url).pathname;
      if (path.endsWith('/csrf')) return json({ csrf_token: 'before-login' });
      if (path.endsWith('/login'))
        return json({
          user: { id: 'inspector-1', username: 'inspector' },
          csrf_token: 'after-login',
        });
      if (path.endsWith('/reports') && !url.includes('page=2'))
        return json({
          count: 2,
          next: '/api/reports?page=2',
          previous: null,
          results: [{ id: 'first' }],
        });
      if (path.endsWith('/reports'))
        return json({
          count: 2,
          next: null,
          previous: '/api/reports',
          results: [{ id: 'second' }],
        });
      if (options.method === 'PATCH') return json({ id: 'first', version: 2 });
      if (path.endsWith('/logout')) return new Response(null, { status: 204 });
      throw new Error(`Unexpected request: ${url}`);
    },
  });
  await api.login('inspector', 'password');
  assert.equal(
    calls.find((call) => call.url.endsWith('/login')).options.headers['X-CSRFToken'],
    'before-login',
  );
  assert.deepEqual(await api.getReports(), [{ id: 'first' }, { id: 'second' }]);
  await api.patchReport('first', { version: 1, status: 'INSPECTION' });
  const patch = calls.find((call) => call.options.method === 'PATCH');
  assert.equal(patch.options.headers['X-CSRFToken'], 'after-login');
  assert.deepEqual(JSON.parse(patch.options.body), { version: 1, status: 'INSPECTION' });
  assert.ok(
    calls.every(
      (call) => call.options.credentials === 'include' && call.options.cache === 'no-store',
    ),
  );
  assert.equal(api.photoUrl('/api/photos/123'), 'https://backend.example/api/photos/123');
  assert.equal(api.photoUrl('https://unrelated.example/tracker'), '');
  await api.logout();
});

test('API errors expose structured fields and request ID, without silently falling back to demo', async () => {
  const api = createApiClient({
    fetchImpl: async () =>
      json(
        {
          error: {
            code: 'rate_limited',
            message: 'Слишком много запросов',
            fields: { deadline: ['Проверьте дату'] },
            request_id: 'req-42',
          },
        },
        429,
        { 'Retry-After': '15' },
      ),
  });
  await assert.rejects(api.getMap(), (error) => {
    assert.equal(error.status, 429);
    assert.equal(error.code, 'rate_limited');
    assert.equal(error.requestId, 'req-42');
    assert.equal(error.retryAfter, 15);
    assert.deepEqual(error.fields, { deadline: ['Проверьте дату'] });
    return true;
  });
});

test('pagination rejects external destinations before sending cookies or further requests', async () => {
  let requests = 0;
  const api = createApiClient({
    fetchImpl: async () => {
      requests++;
      return json({
        results: [],
        next: 'https://unrelated.example/api/reports',
        count: 1,
        previous: null,
      });
    },
  });
  await assert.rejects(api.getReports(), matches('invalid_response'));
  assert.equal(requests, 1);
});

test('API map rejects malformed collections and geometry instead of crashing rendering or substituting demo data', async () => {
  const valid = await fresh().getMap();
  const accepted = createApiClient({ fetchImpl: async () => json(valid) });
  assert.deepEqual(await accepted.getMap(), valid);
  const empty = {
    reports: { type: 'FeatureCollection', features: [] },
    plots: { type: 'FeatureCollection', features: [] },
  };
  assert.deepEqual(await createApiClient({ fetchImpl: async () => json(empty) }).getMap(), empty);

  const badPoint = structuredClone(valid);
  badPoint.reports.features[0].geometry.coordinates = [500, 43.3];
  const openRing = structuredClone(valid);
  openRing.plots.features[0].geometry.coordinates[0].pop();
  const unknownStatus = structuredClone(valid);
  unknownStatus.reports.features[0].properties.status = 'UNKNOWN';
  for (const body of [
    null,
    {},
    { ...empty, reports: { features: [] } },
    { ...empty, plots: { type: 'FeatureCollection', features: null } },
    badPoint,
    openRing,
    unknownStatus,
  ]) {
    const api = createApiClient({ fetchImpl: async () => json(body) });
    await assert.rejects(api.getMap(), matches('invalid_response'));
  }
});

test('API map adds optional viewport bounds without mutating options or losing cancellation', async () => {
  const body = await fresh().getMap();
  const calls = [];
  const api = createApiClient({
    fetchImpl: async (url, options) => {
      calls.push({ url: new URL(url), options });
      return json(body);
    },
  });
  await api.getMap();
  assert.equal(calls[0].url.pathname, '/api/map');
  assert.equal(calls[0].url.search, '');
  const controller = new AbortController();
  const bbox = Object.freeze([68.2, 43.2, 68.4, 43.4]);
  const options = Object.freeze({ bbox, signal: controller.signal });
  await api.getMap(options);
  assert.equal(calls[1].url.searchParams.get('bbox'), '68.2,43.2,68.4,43.4');
  assert.equal(calls[1].options.method, 'GET');
  assert.equal(options.signal, controller.signal);
  assert.deepEqual(options.bbox, [68.2, 43.2, 68.4, 43.4]);
  assert.equal(controller.signal.aborted, false);
  for (const invalid of [
    null,
    [1, 2, 3],
    [68.4, 43.2, 68.2, 43.4],
    [0, -91, 1, 1],
    [0, 0, Infinity, 1],
    ['0', 0, 1, 1],
  ]) {
    await assert.rejects(api.getMap({ bbox: invalid }), matches('validation_error', 'bbox'));
  }
  assert.equal(calls.length, 2);

  let networkSignal;
  const pendingApi = createApiClient({
    fetchImpl: (_url, { signal }) => {
      networkSignal = signal;
      return new Promise((_resolve, reject) =>
        signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
      );
    },
  });
  const pending = pendingApi.getMap(options);
  controller.abort();
  await assert.rejects(pending, (error) => error.name === 'AbortError');
  assert.equal(networkSignal.aborted, true);
  assert.equal(networkSignal.reason, controller.signal.reason);
});

test('API supports caller abort and timeout, and never retries uncertain mutations', async () => {
  const abortableFetch = (_url, { signal }) =>
    new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  const api = createApiClient({ fetchImpl: abortableFetch, timeoutMs: 20 });
  const controller = new AbortController();
  const pending = api.getMap({ signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, (error) => error.name === 'AbortError');
  await assert.rejects(api.getMap(), matches('timeout'));

  let patches = 0;
  const uncertain = createApiClient({
    fetchImpl: async (url, options) => {
      if (url.endsWith('/csrf')) return json({ csrf_token: 'csrf' });
      if (options.method === 'PATCH') patches++;
      throw new TypeError('Connection interrupted');
    },
  });
  await assert.rejects(
    uncertain.patchReport('report', { version: 1, status: 'INSPECTION' }),
    matches('network_error'),
  );
  assert.equal(patches, 1);
});
