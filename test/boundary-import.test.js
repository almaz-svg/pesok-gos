import test from 'node:test';
import assert from 'node:assert/strict';
import { createBoundaryCollection } from '../scripts/boundary-data.mjs';

function response(missingInner = false) {
  return {
    osm3s: { timestamp_osm_base: '2026-09-26T07:07:50Z' },
    elements: Array.from({ length: 20 }, (_, index) => ({
      type: 'relation', id: index + 1,
      tags: { type: 'multipolygon', boundary: 'administrative', admin_level: '4',
        'ISO3166-2': `KZ-${index}`, 'name:ru': `Region ${index}`, 'name:kk': `Region ${index}` },
      members: [
        { type: 'way', ref: index + 100, role: 'outer', geometry: [
          { lat: 40, lon: 60 }, { lat: 40, lon: 61 }, { lat: 41, lon: 61 },
          { lat: 41, lon: 60 }, { lat: 40, lon: 60 },
        ] },
        ...(missingInner ? [{ type: 'way', ref: index + 200, role: 'inner' }] : []),
      ],
    })),
  };
}

test('importer converts complete polygons and preserves provenance', () => {
  const result = createBoundaryCollection(response(), 'https://example.test', 'test query');
  assert.equal(result.features.length, 20);
  assert.equal(result.source.timestamp, '2026-09-26T07:07:50Z');
  assert.match(result.source.sha256, /^[a-f0-9]{64}$/);
});

test('importer refuses missing polygon parts even when all 20 regions exist', () => {
  assert.throws(() => createBoundaryCollection(response(true)), /Incomplete geometry/);
});

test('importer refuses a partial response and invalid snapshot timestamps', () => {
  const raw = response();
  raw.remark = 'Query timed out';
  assert.throws(() => createBoundaryCollection(raw), /Incomplete boundary response/);
  delete raw.remark;
  raw.osm3s.timestamp_osm_base = 'unknown';
  assert.throws(() => createBoundaryCollection(raw), /metadata/);
});
