import test from 'node:test';
import assert from 'node:assert/strict';
import proj4 from 'proj4';
import { createArea, validateBoundary, analyzePair, compareBoundary } from '../src/land/geometry.js';

function projection(area) {
  return proj4('EPSG:4326', `+proj=utm +zone=${area.epsg - 32600} +datum=WGS84 +units=m +no_defs`);
}

function rectangle(area, left, bottom, right, top) {
  return [[left, bottom], [right, bottom], [right, top], [left, top], [left, bottom]]
    .map(coordinate => projection(area).inverse(coordinate));
}

function fixtureArea(width = 5, height = 4) {
  const area = createArea({ lat: 47, lon: 69, halfSizeMeters: 250 });
  const [x, y] = area.projectedBbox;
  const projectedBbox = [x, y, x + width * 20, y + height * 20];
  const corners = rectangle(area, ...projectedBbox);
  return { ...area, width, height, projectedBbox, bbox: [
    Math.min(...corners.map(p => p[0])), Math.min(...corners.map(p => p[1])),
    Math.max(...corners.map(p => p[0])), Math.max(...corners.map(p => p[1])),
  ] };
}

function polygon(coordinates) {
  return { type: 'Polygon', coordinates };
}

function enclosingBoundary(area) {
  const [x0, y0, x1, y1] = area.projectedBbox;
  return polygon([rectangle(area, x0 - 20, y0 - 20, x1 + 20, y1 + 20)]);
}

const vegetation = { red: 0.1, green: 0.15, blue: 0.08, nir: 0.5, swir16: 0.15, scl: 4 };
const bare = { red: 0.3, green: 0.25, blue: 0.15, nir: 0.32, swir16: 0.45, scl: 5 };

function scene(area, id, values = vegetation) {
  return {
    id, datetime: id === 'before' ? '2024-06-15T06:00:00Z' : '2025-06-15T06:00:00Z',
    sourceUrl: `https://example.test/scenes/${id}`,
    bands: Object.fromEntries(Object.entries(values)
      .map(([key, value]) => [key, new Float32Array(area.width * area.height).fill(value)])),
  };
}

function setPixels(target, indices, values) {
  for (const index of indices) {
    for (const [key, value] of Object.entries(values)) target.bands[key][index] = value;
  }
}

function pair(area, candidates = []) {
  const before = scene(area, 'before');
  const after = scene(area, 'after');
  setPixels(after, candidates, bare);
  return { before, after };
}

function close(actual, expected, tolerance = 1e-5) {
  assert.ok(Math.abs(actual - expected) < tolerance, `${actual} should be near ${expected}`);
}

test('AOIs keep requested dimensions on a bounded aligned northern UTM grid', () => {
  for (const [halfSizeMeters, size] of [[250, 25], [500, 50], [1000, 100]]) {
    const area = createArea({ lat: 43.25, lon: 76.9, halfSizeMeters });
    assert.equal(area.epsg, 32643);
    assert.equal(area.resolution, 20);
    assert.equal(area.width, size);
    assert.equal(area.height, size);
    const [x0, y0, x1, y1] = area.projectedBbox;
    for (const value of area.projectedBbox) assert.equal(value % 20, 0);
    assert.equal(x1 - x0, 2 * halfSizeMeters);
    assert.equal(y1 - y0, 2 * halfSizeMeters);
    const [x, y] = projection(area).forward([76.9, 43.25]);
    assert.ok(Math.abs((x0 + x1) / 2 - x) <= 10);
    assert.ok(Math.abs((y0 + y1) / 2 - y) <= 10);
    for (const [lon, lat] of rectangle(area, x0, y0, x1, y1)) {
      assert.ok(lon >= area.bbox[0] && lon <= area.bbox[2]);
      assert.ok(lat >= area.bbox[1] && lat <= area.bbox[3]);
    }
    assert.deepEqual(JSON.parse(JSON.stringify(area)), area);
  }
});

test('persisted scene metadata preserves the applied radiometry without retaining pixels', () => {
  const area = fixtureArea();
  const { before, after } = pair(area);
  before.radiometry = { policy: 'earthsearch-cog-v1', boaOffsetAlreadyApplied: true,
    bands: Object.fromEntries(['red', 'green', 'blue', 'nir', 'swir16'].map(name => [name,
      { scale: 0.0001, declaredOffset: -0.1, appliedOffset: 0 }])) };
  const result = analyzePair(before, after, area);
  assert.deepEqual(result.before.radiometry, before.radiometry);
  assert.notEqual(result.before.radiometry, before.radiometry);
  assert.equal(result.before.bands, undefined);
});

test('AOI region limits and half-size choices are enforced before raster allocation', () => {
  for (const input of [
    { lat: 39.99 }, { lat: 56.01 }, { lon: 45.99 }, { lon: 88.01 },
    { lat: NaN }, { lon: Infinity }, { lon: '69' }, { halfSizeMeters: 0 },
    { halfSizeMeters: 5000 }, { halfSizeMeters: '500' },
  ]) assert.throws(() => createArea({ lat: 47, lon: 69, halfSizeMeters: 500, ...input }));
  assert.equal(createArea({ lat: 40, lon: 46, halfSizeMeters: 250 }).epsg, 32638);
  assert.equal(createArea({ lat: 56, lon: 88, halfSizeMeters: 1000 }).epsg, 32645);
});

test('geographic AOI bounds include curved UTM edges between the four corners', () => {
  const area = createArea({ lat: 47, lon: 69, halfSizeMeters: 1000 });
  const [x0, , x1, y1] = area.projectedBbox;
  const [, latitude] = projection(area).inverse([(x0 + x1) / 2, y1]);
  assert.ok(latitude <= area.bbox[3], 'northern edge midpoint must be included');
});

test('four connected changed cells produce 0.16 candidate hectares and persisted provenance', () => {
  const area = fixtureArea();
  const { before, after } = pair(area, [0, 1, 5, 6]);
  const result = analyzePair(before, after, area);
  assert.equal(result.status, 'change');
  assert.deepEqual(result.area, area);
  assert.deepEqual(result.candidatePixels, [0, 1, 5, 6]);
  assert.deepEqual(result.validPixels, Array.from({ length: 20 }, (_, i) => i));
  assert.equal(result.validFraction, 1);
  close(result.changeHectares, 0.16);
  assert.deepEqual(result.before, { id: before.id, datetime: before.datetime, sourceUrl: before.sourceUrl });
  assert.deepEqual(result.after, { id: after.id, datetime: after.datetime, sourceUrl: after.sourceUrl });
  assert.deepEqual(result.boundary, { status: 'missing', outsideHectares: null });
  assert.match(result.method, /heuristic/);
  assert.match(result.settings.maskConvention, /north.*south/i);
  assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
});

test('plain reflectance arrays work and scenes remain unchanged', () => {
  const area = fixtureArea();
  const { before, after } = pair(area, [0, 1, 5, 6]);
  for (const item of [before, after]) {
    item.bands = Object.fromEntries(Object.entries(item.bands).map(([key, value]) => [key, Array.from(value)]));
  }
  const snapshot = structuredClone({ before, after, area });
  analyzePair(before, after, area);
  assert.deepEqual({ before, after, area }, snapshot);
});

test('unchanged vegetation and already bare land are no_change, not a safety finding', () => {
  const area = fixtureArea();
  for (const values of [vegetation, bare]) {
    const result = analyzePair(scene(area, 'before', values), scene(area, 'after', values), area);
    assert.equal(result.status, 'no_change');
    assert.equal(result.changeHectares, 0);
    assert.deepEqual(result.candidatePixels, []);
  }
});

test('low final NDVI alone is insufficient without BSI rise or vegetated baseline', () => {
  const area = fixtureArea();
  const after = scene(area, 'after', { ...vegetation, red: 0.15, nir: 0.2, blue: 0.2, swir16: 0.1 });
  assert.equal(analyzePair(scene(area, 'before'), after, area).status, 'no_change');
  const lowVegetation = scene(area, 'before', { ...vegetation, red: 0.25, nir: 0.4 });
  assert.equal(analyzePair(lowVegetation, scene(area, 'after', bare), area).status, 'no_change');
});

test('both NDVI drop and BSI rise must exceed the conservative change thresholds', () => {
  const area = fixtureArea();
  // NDVI 0.46 -> 0.24: both endpoint tests pass, but the 0.22 drop is too small.
  const before = scene(area, 'before', { ...vegetation, nir: 0.365, red: 0.135 });
  const after = scene(area, 'after', { ...bare, nir: 0.31, red: 0.19 });
  assert.equal(analyzePair(before, after, area).status, 'no_change');
  // Strong NDVI drop, but BSI 0.094 -> 0.230 rises by less than 0.15.
  const highBsiBefore = scene(area, 'before', { ...vegetation, swir16: 0.6 });
  assert.equal(analyzePair(highBsiBefore, scene(area, 'after', bare), area).status, 'no_change');
});

test('8-neighbor diagonal groups count, but isolated pixels and three-cell groups do not', () => {
  const area = fixtureArea(5, 5);
  const connected = pair(area, [0, 6, 12, 18]);
  assert.deepEqual(analyzePair(connected.before, connected.after, area).candidatePixels, [0, 6, 12, 18]);
  const disconnected = pair(area, [0, 1, 5, 24]);
  assert.deepEqual(analyzePair(disconnected.before, disconnected.after, area).candidatePixels, []);
  const wrapping = pair(area, [4, 5, 9, 10]);
  assert.deepEqual(analyzePair(wrapping.before, wrapping.after, area).candidatePixels, []);
});

test('common clear fraction requires SCL 4 or 5 on BOTH scenes and includes water in the denominator', () => {
  const area = fixtureArea();
  for (const scl of [0, 1, 2, 3, 6, 7, 8, 9, 10, 11, 4.5, NaN]) {
    const { before, after } = pair(area, [0, 1, 5, 6]);
    setPixels(before, [15, 16], { scl });
    setPixels(after, [18, 19], { scl });
    const result = analyzePair(before, after, area);
    assert.equal(result.validFraction, 0.8, `SCL ${scl}`);
    assert.equal(result.status, 'change');
    assert.deepEqual(result.validPixels, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 17]);
  }
});

test('less than 80% common clear area yields unknown change, even with a strong candidate patch', () => {
  const area = fixtureArea();
  const { before, after } = pair(area, [0, 1, 5, 6]);
  setPixels(after, [15, 16, 17, 18, 19], { scl: 9 });
  const result = analyzePair(before, after, area, { geometry: enclosingBoundary(area), verifiedBy: 123 });
  assert.equal(result.status, 'insufficient_data');
  assert.equal(result.validFraction, 0.75);
  assert.equal(result.changeHectares, null);
  assert.deepEqual(result.candidatePixels, []);
  assert.equal(result.boundary.outsideHectares, null);
});

test('invalid reflectance and undefined index ratios are masked instead of treated as bare soil', () => {
  const area = fixtureArea();
  const { before, after } = pair(area);
  setPixels(before, [0], { red: NaN });
  setPixels(after, [1], { swir16: Infinity });
  setPixels(after, [2], { nir: -0.1 });
  setPixels(after, [3], { blue: 1500 });
  setPixels(after, [4], { red: 0, nir: 0 });
  setPixels(after, [5], { green: NaN });
  const result = analyzePair(before, after, area);
  assert.equal(result.validFraction, 0.7);
  assert.equal(result.status, 'insufficient_data');
  assert.deepEqual(result.validPixels, Array.from({ length: 14 }, (_, i) => i + 6));
});

test('masked candidate cells cannot bridge a component or contribute change area', () => {
  const area = fixtureArea();
  const { before, after } = pair(area, [0, 1, 5, 6]);
  setPixels(before, [6], { scl: 9 });
  const result = analyzePair(before, after, area);
  assert.equal(result.validFraction, 0.95);
  assert.equal(result.status, 'no_change');
  assert.deepEqual(result.candidatePixels, []);
});

test('malformed scene arrays and unbounded or inconsistent grids fail promptly', () => {
  const area = fixtureArea();
  const { before, after } = pair(area);
  assert.throws(() => analyzePair({ ...before, bands: { ...before.bands, red: [] } }, after, area), /band/i);
  assert.throws(() => analyzePair({ ...before, bands: { ...before.bands, scl: undefined } }, after, area), /band/i);
  assert.throws(() => analyzePair(before, after, { ...area, width: 1e9 }), /area|grid/i);
  assert.throws(() => analyzePair(before, after, { ...area, resolution: 0 }), /area|grid/i);
  assert.throws(() => analyzePair(before, after, { ...area, height: 2.5 }), /area|grid/i);
  assert.throws(() => analyzePair(before, after, { ...area, projectedBbox: [0, 0, 20, 20] }), /area|grid/i);
});

test('validation returns a Polygon or MultiPolygon Feature with independent coordinates', () => {
  const area = fixtureArea();
  const geometry = enclosingBoundary(area);
  const feature = validateBoundary({ type: 'Feature', properties: { name: 'parcel' }, geometry }, area);
  assert.equal(feature.type, 'Feature');
  assert.deepEqual(feature.geometry, geometry);
  assert.notEqual(feature.geometry.coordinates, geometry.coordinates);
  const multi = validateBoundary({ type: 'MultiPolygon', coordinates: [geometry.coordinates] }, area);
  assert.equal(multi.geometry.type, 'MultiPolygon');
});

test('validation rejects unclosed, degenerate, non-finite, out-of-range and non-polygon geometries', () => {
  const area = fixtureArea();
  const ring = enclosingBoundary(area).coordinates[0];
  const invalid = [
    null, { type: 'FeatureCollection', features: [] }, { type: 'Point', coordinates: [69, 47] },
    polygon([]), polygon([ring.slice(0, -1)]), polygon([[[69, 47], [69, 47], [69, 47], [69, 47]]]),
    polygon([[[69, 47], [70, 47], [71, 47], [69, 47]]]),
    polygon([[[NaN, 47], ...ring.slice(1)]]), polygon([[[69, Infinity], ...ring.slice(1)]]),
    polygon([[[181, 47], ...ring.slice(1)]]), polygon([[[69, 91], ...ring.slice(1)]]),
    polygon([[[69, 47, NaN], ...ring.slice(1)]]),
  ];
  for (const value of invalid) assert.throws(() => validateBoundary(value, area));
});

test('validation rejects bow-ties, repeated vertices and collinear backtracking', () => {
  const area = fixtureArea();
  const [x, y] = area.projectedBbox;
  const ring = rectangle(area, x, y, x + 80, y + 60);
  assert.throws(() => validateBoundary(polygon([[ring[0], ring[2], ring[1], ring[3], ring[0]]]), area));
  assert.throws(() => validateBoundary(polygon([[ring[0], ring[1], ring[2], ring[1], ring[3], ring[0]]]), area));
  const backtracking = [[69, 47], [69.004, 47], [69.002, 47], [69.002, 47.002], [69, 47]];
  assert.throws(() => validateBoundary(polygon([backtracking]), area));
});

test('valid holes are retained while exterior, overlapping, and crossing holes are rejected', () => {
  const area = fixtureArea();
  const [x0, y0, x1, y1] = area.projectedBbox;
  const outer = rectangle(area, x0 - 40, y0 - 40, x1 + 40, y1 + 40);
  const hole = rectangle(area, x0 + 10, y0 + 10, x0 + 30, y0 + 30).reverse();
  assert.equal(validateBoundary(polygon([outer, hole]), area).geometry.coordinates.length, 2);
  const outside = rectangle(area, x1 + 60, y1 + 60, x1 + 80, y1 + 80);
  const crossing = rectangle(area, x1 + 30, y0, x1 + 60, y0 + 20);
  const overlap = rectangle(area, x0 + 20, y0 + 20, x0 + 40, y0 + 40);
  const nested = rectangle(area, x0 + 15, y0 + 15, x0 + 25, y0 + 25);
  for (const rings of [[outer, outside], [outer, crossing], [outer, hole, overlap], [outer, hole, nested]]) {
    assert.throws(() => validateBoundary(polygon(rings), area));
  }
});

test('boundaries must intersect the actual AOI footprint, including exclusion holes', () => {
  const area = fixtureArea();
  const [x0, y0, x1, y1] = area.projectedBbox;
  assert.throws(() => validateBoundary(polygon([rectangle(area, x1 + 100, y0, x1 + 200, y1)]), area));
  const outer = rectangle(area, x0 - 40, y0 - 40, x1 + 40, y1 + 40);
  const hole = rectangle(area, x0 - 20, y0 - 20, x1 + 20, y1 + 20);
  assert.throws(() => validateBoundary(polygon([outer, hole]), area));
});

test('vertex budget applies to the entire MultiPolygon before geometric work', () => {
  const area = fixtureArea();
  const many = Array.from({ length: 401 }, () => enclosingBoundary(area).coordinates);
  assert.throws(() => validateBoundary({ type: 'MultiPolygon', coordinates: many }, area), /vert|2000|limit/i);
  assert.throws(() => validateBoundary(polygon([new Array(10000000)]), area), /vert|2000|limit/i);
});

test('overlapping MultiPolygon parts are rejected, while disjoint parts are accepted', () => {
  const area = fixtureArea();
  const [x, y] = area.projectedBbox;
  const part = rectangle(area, x, y, x + 30, y + 30);
  const other = rectangle(area, x + 60, y + 40, x + 80, y + 60);
  assert.equal(validateBoundary({ type: 'MultiPolygon', coordinates: [[part], [other]] }, area).geometry.type, 'MultiPolygon');
  assert.throws(() => validateBoundary({ type: 'MultiPolygon', coordinates: [[part], [part]] }, area));
});

test('absent boundary returns missing before inspecting a partial injected analysis', () => {
  assert.deepEqual(compareBoundary({}, undefined), { status: 'missing', outsideHectares: null });
  assert.deepEqual(compareBoundary(undefined, null), { status: 'missing', outsideHectares: null });
});

test('outside area stays unknown for unverified contours, including spoofed upload properties', () => {
  const area = fixtureArea();
  const { before, after } = pair(area, [0, 1, 5, 6]);
  const analysis = analyzePair(before, after, area);
  for (const boundary of [
    { geometry: enclosingBoundary(area), source: 'upload', verified: true },
    { geometry: enclosingBoundary(area), verifiedBy: '' },
    { geometry: enclosingBoundary(area), verifiedBy: ' ' },
    { type: 'Feature', geometry: enclosingBoundary(area), properties: { verifiedBy: 123 } },
  ]) assert.deepEqual(compareBoundary(analysis, boundary), { status: 'unverified', outsideHectares: null });
});

test('verified half-cell overlap uses fractions of nominal 400 square metres and the northern row', () => {
  const area = fixtureArea();
  const { before, after } = pair(area, [0, 1, 2, 3]);
  const [x0, , , y1] = area.projectedBbox;
  const boundary = { geometry: polygon([rectangle(area, x0 - 20, y1 - 10, x0 + 100, y1 + 20)]),
    source: 'operator-provided permit contour', verifiedBy: 123 };
  const result = analyzePair(before, after, area, boundary);
  assert.equal(result.boundary.status, 'verified');
  close(result.boundary.outsideHectares, 0.08, 0.00001);
  assert.ok(result.boundary.outsideHectares <= result.changeHectares);
  assert.deepEqual(compareBoundary(result, boundary), result.boundary);
});

test('verified holes count as outside, even when a pixel center is inside the contour', () => {
  const area = fixtureArea();
  const { before, after } = pair(area, [0, 1, 2, 3]);
  const [x0, , , y1] = area.projectedBbox;
  const outer = enclosingBoundary(area).coordinates[0];
  const hole = rectangle(area, x0 + 2, y1 - 8, x0 + 18, y1 - 2);
  const result = analyzePair(before, after, area, { geometry: polygon([outer, hole]), verifiedBy: 'operator' });
  close(result.boundary.outsideHectares, 0.0096, 0.00001);
});

test('full coverage and empty coverage of candidate cells return bounded 0 and full candidate area', () => {
  const area = fixtureArea();
  const { before, after } = pair(area, [0, 1, 2, 3]);
  const analysis = analyzePair(before, after, area);
  const snapshot = structuredClone(analysis);
  const [x0, y0] = area.projectedBbox;
  close(compareBoundary(analysis, { geometry: enclosingBoundary(area), verifiedBy: 123 }).outsideHectares, 0);
  close(compareBoundary(analysis, { geometry: polygon([rectangle(area, x0, y0, x0 + 20, y0 + 20)]),
    verifiedBy: 123 }).outsideHectares, 0.16);
  assert.deepEqual(analysis, snapshot);
});

test('a fully enclosing contour leaves zero outside area on the maximum off-meridian grid', () => {
  const area = createArea({ lat: 43.25, lon: 76.9, halfSizeMeters: 1000 });
  const before = scene(area, 'before');
  const after = scene(area, 'after', bare);
  const result = analyzePair(before, after, area, { geometry: enclosingBoundary(area), verifiedBy: 123 });
  assert.equal(result.candidatePixels.length, 10000);
  assert.equal(result.changeHectares, 400);
  close(result.boundary.outsideHectares, 0, 1e-8);
});

test('comparison rejects malformed stored candidate masks before looping or double-counting', () => {
  const area = fixtureArea();
  const { before, after } = pair(area, [0, 1, 5, 6]);
  const analysis = analyzePair(before, after, area);
  const boundary = { geometry: enclosingBoundary(area), verifiedBy: 123 };
  for (const candidatePixels of [[-1], [20], [NaN], [1.5], [0, 0], new Array(10000000)]) {
    assert.throws(() => compareBoundary({ ...analysis, candidatePixels }, boundary));
  }
  assert.throws(() => compareBoundary({ ...analysis, validPixels: [1, 5, 6] }, boundary));
});
