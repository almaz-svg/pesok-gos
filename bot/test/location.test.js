import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

test('real OSM boundaries identify cities and newly created regions without remote calls', async t => {
  const { analyzeLocation } = await import('../src/location.js');
  t.mock.method(globalThis, 'fetch', () => { throw new Error('No coordinates may leave the process'); });
  for (const [lat, lon, expected] of [
    [51.12955, 71.4154, 'KZ-71'],
    [43.238949, 76.889709, 'KZ-75'],
    [42.3417, 69.5901, 'KZ-79'],
    [50.4111, 80.2275, 'KZ-10'],
    [47.8043, 67.7144, 'KZ-62'],
    [45.0156, 78.3739, 'KZ-33'],
    [44.8488, 65.4823, 'KZ-43'],
  ]) {
    const result = analyzeLocation({ lat, lon });
    assert.equal(result.status, 'matched', `${lat}, ${lon}`);
    assert.equal(result.regions[0].id, expected);
    assert.ok(result.datasetTimestamp);
    assert.match(result.datasetHash, /^[a-f0-9]{64}$/);
  }
});

test('outside and invalid coordinates never receive an invented Kazakh region', async () => {
  const { analyzeLocation } = await import('../src/location.js');
  for (const [lat, lon] of [[0, 0], [55.7558, 37.6173], [71.4154, 51.12955]]) {
    const result = analyzeLocation({ lat, lon });
    assert.equal(result.status, 'outside');
    assert.deepEqual(result.regions, []);
  }
  for (const lat of [91, -91, NaN, Infinity, '51', null]) {
    assert.throws(() => analyzeLocation({ lat, lon: 71 }), /coordinates/i);
  }
});

test('the geographic result preserves GPS accuracy and has localized factual summaries', async () => {
  const { analyzeLocation, formatLocationAnalysis } = await import('../src/location.js');
  const result = analyzeLocation({ lat: 51.12955, lon: 71.4154, accuracyMeters: 32, live: true });
  assert.equal(result.accuracyMeters, 32);
  assert.equal(result.live, true);
  for (const language of ['ru', 'kk']) {
    const text = formatLocationAnalysis(result, language);
    assert.match(text, /Астана/);
    assert.match(text, /OpenStreetMap/);
    assert.match(text, /32/);
    assert.ok(text.length < 2500);
  }
  assert.match(formatLocationAnalysis(result, 'ru'), /не определяет|не устанавливает/);
  assert.match(formatLocationAnalysis(result, 'kk'), /анықтамайды/);
});

test('the bundled geometry has complete provenance, closed rings and 20 unique regions', async () => {
  const data = JSON.parse(await readFile(new URL('../assets/geo/kz-regions.geojson', import.meta.url), 'utf8'));
  assert.equal(data.features.length, 20);
  assert.equal(new Set(data.features.map(feature => feature.properties.id)).size, 20);
  assert.equal(createHash('sha256').update(JSON.stringify(data.features)).digest('hex'), data.source.sha256);
  for (const feature of data.features) {
    assert.ok(feature.properties.names.ru);
    assert.ok(feature.properties.names.kk);
    assert.ok(['Polygon', 'MultiPolygon'].includes(feature.geometry.type));
    const polygons = feature.geometry.type === 'Polygon' ? [feature.geometry.coordinates] : feature.geometry.coordinates;
    for (const polygon of polygons) for (const ring of polygon) {
      assert.ok(ring.length >= 4);
      assert.deepEqual(ring[0], ring.at(-1));
    }
  }
});

test('a point exactly on a mapped boundary is not reported as unambiguously inside', async () => {
  const { analyzeLocation } = await import('../src/location.js');
  const data = JSON.parse(await readFile(new URL('../assets/geo/kz-regions.geojson', import.meta.url), 'utf8'));
  const { geometry } = data.features.find(feature => feature.properties.id === 'KZ-71');
  const [lon, lat] = geometry.type === 'Polygon' ? geometry.coordinates[0][0] : geometry.coordinates[0][0][0];
  assert.equal(analyzeLocation({ lat, lon }).status, 'boundary');
  for (const accuracyMeters of [NaN, Infinity, -1, 1501, '25']) {
    assert.equal(analyzeLocation({ lat, lon, accuracyMeters }).accuracyMeters, undefined);
  }
});
