import test from 'node:test';
import assert from 'node:assert/strict';
import { createDemoStore } from '../src/lib/data-client.js';
import { filterMonitoringData, visibleFeatureCollection } from '../src/lib/monitor-data.js';

async function data() {
  const store = createDemoStore({ now: () => new Date('2026-09-25T07:00:00Z') });
  return {
    reports: await store.getReports(),
    plots: await store.getPlots(),
    map: await store.getMap(),
  };
}

test('a successfully loaded map remains usable when independent lists have not loaded', async () => {
  const full = await data();
  const filtered = filterMonitoringData({ ...full, reports: [], plots: [] });
  assert.equal(filtered.map.reports.features.length, 7);
  assert.equal(filtered.map.plots.features.length, 6);
  const parcel = full.map.plots.features[0];
  const searched = filterMonitoringData(
    { ...full, reports: [], plots: [] },
    { query: parcel.properties.cadastral_number },
  );
  assert.equal(searched.map.plots.features.length, 1);
  assert.ok(searched.map.reports.features.length > 0);
  assert.ok(
    searched.map.reports.features.every((feature) => feature.properties.plot_id === parcel.id),
  );
});

test('map search can use a parcel without geometry from the independent plot list', async () => {
  const full = await data();
  const parcel = full.plots[0];
  const map = { ...full.map, plots: { type: 'FeatureCollection', features: [] } };
  const filtered = filterMonitoringData(
    { ...full, reports: [], map },
    { query: parcel.cadastral_number },
  );
  assert.ok(filtered.map.reports.features.length > 0);
  assert.ok(
    filtered.map.reports.features.every((feature) => feature.properties.plot_id === parcel.id),
  );
});

test('combined filters respect report status and overdue, preserving reports without known parcels', async () => {
  const full = await data();
  const overdue = filterMonitoringData(full, { status: 'VIOLATION', overdueOnly: true });
  assert.equal(overdue.reports.length, 1);
  assert.equal(overdue.map.reports.features.length, 1);
  assert.equal(overdue.map.plots.features.length, 1);
  const incoming = filterMonitoringData({ ...full, reports: [], plots: [] }, { status: 'NEW' });
  assert.ok(incoming.map.reports.features.some((feature) => feature.properties.plot_id === null));
  const closed = filterMonitoringData(full, { status: 'RESOLVED' });
  assert.equal(closed.map.reports.features.length, 1);
  assert.equal(closed.map.plots.features.length, 0);
});

test('GeoJSON export includes exactly the visible layers', async () => {
  const full = await data();
  assert.equal(visibleFeatureCollection(full.map, { showPlots: false }).features.length, 7);
  assert.equal(visibleFeatureCollection(full.map, { showReports: false }).features.length, 6);
  assert.deepEqual(
    visibleFeatureCollection(full.map, { showPlots: false, showReports: false }).features,
    [],
  );
});
