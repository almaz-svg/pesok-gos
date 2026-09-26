import test from 'node:test';
import assert from 'node:assert/strict';
import proj4 from 'proj4';
import { PNG } from 'pngjs';
import { writeArrayBuffer } from 'geotiff';
import { createSatelliteProvider, renderScene } from '../src/land/satellite.js';

const ROOT = 'https://earth-search.aws.element84.com/v1';
const COG = 'https://sentinel-cogs.s3.us-west-2.amazonaws.com';
const KEYS = ['red', 'green', 'blue', 'nir', 'swir16', 'scl'];
const NOW = new Date('2026-09-26T12:00:00Z');
const projection = '+proj=utm +zone=42 +datum=WGS84 +units=m +no_defs';
const corners = [[600000, 5600000], [600080, 5600000], [600080, 5600080], [600000, 5600080]]
  .map(point => proj4(projection, 'EPSG:4326', point));
const area = {
  epsg: 32642, projectedBbox: [600000, 5600000, 600080, 5600080],
  bbox: [Math.min(...corners.map(p => p[0])), Math.min(...corners.map(p => p[1])),
    Math.max(...corners.map(p => p[0])), Math.max(...corners.map(p => p[1]))],
  width: 4, height: 4, resolution: 20,
};

function scene(id, date, overrides = {}) {
  const [w, s, e, n] = area.bbox;
  return {
    type: 'Feature', id, collection: 'sentinel-2-l2a', bbox: [w - 0.1, s - 0.1, e + 0.1, n + 0.1],
    geometry: { type: 'Polygon', coordinates: [[[w - 0.1, s - 0.1], [e + 0.1, s - 0.1],
      [e + 0.1, n + 0.1], [w - 0.1, n + 0.1], [w - 0.1, s - 0.1]]] },
    properties: { datetime: `${date}T06:00:00Z`, 'proj:epsg': 32642, 'eo:cloud_cover': 99 },
    assets: Object.fromEntries(KEYS.map(band => [band, {
      href: `${COG}/sentinel-s2-l2a-cogs/42/U/XB/2026/9/${id}/${band}.tif`,
      type: 'image/tiff; application=geotiff; profile=cloud-optimized',
      'raster:bands': [band === 'scl' ? { nodata: 0 } : { scale: 0.0001, offset: -0.1, nodata: 0 }],
    }])),
    ...overrides,
  };
}

function catalog(items, calls = [], direct = items) {
  return async (url, options) => {
    calls.push({ url, options });
    assert.equal(options.redirect, 'error');
    assert.equal(options.credentials, 'omit');
    assert.ok(options.signal instanceof AbortSignal);
    if (url.startsWith(`${ROOT}/collections/sentinel-2-l2a/items/`)) {
      const item = direct.find(entry => entry.id === url.split('/').at(-1));
      return Response.json(item || {}, { status: item ? 200 : 404 });
    }
    assert.equal(url, `${ROOT}/search`);
    assert.equal(options.method, 'POST');
    const query = JSON.parse(options.body);
    assert.deepEqual(query.collections, ['sentinel-2-l2a']);
    assert.deepEqual(query.bbox, area.bbox);
    assert.ok(query.limit > 0 && query.limit <= 100);
    assert.deepEqual(query.sortby, [{ field: 'properties.datetime', direction: 'desc' }]);
    const [start, end] = query.datetime.split('/').map(Date.parse);
    assert.ok(Number.isFinite(start) && Number.isFinite(end) && start < end);
    assert.ok(end <= NOW.getTime());
    const features = items.filter(item => {
      const timestamp = Date.parse(item.properties.datetime);
      return timestamp >= start && timestamp <= end;
    }).sort((a, b) => Date.parse(b.properties.datetime) - Date.parse(a.properties.datetime));
    return Response.json({ type: 'FeatureCollection', features: features.slice(0, query.limit), links: [] });
  };
}

function rasterLoader(overrides = {}, reads = []) {
  return async ({ item, band, area: requestedArea, signal }) => {
    assert.ok(signal instanceof AbortSignal);
    assert.deepEqual(requestedArea.projectedBbox, area.projectedBbox);
    reads.push(`${item.id}:${band}`);
    const override = overrides[item.id]?.[band];
    return {
      data: Uint16Array.from(override || Array(16).fill(band === 'scl' ? 5 : 3000)),
      width: 4, height: 4, epsg: 32642, bbox: area.projectedBbox, nodata: 65535,
    };
  };
}

function provider(items, options = {}) {
  return createSatelliteProvider({ fetchImpl: catalog(items), rasterLoader: rasterLoader(), now: () => NOW, ...options });
}

const before = () => scene('S2B_before', '2025-09-10');
const after = () => scene('S2B_after', '2026-09-20');
const errorCode = code => error => {
  assert.equal(error.code, code);
  assert.doesNotMatch(String(error), /https?:|secret|token|password/i);
  assert.equal(error.cause, undefined);
  return true;
};

test('selects the latest AOI-clear scene and an annual same-season baseline on the shared grid', async () => {
  const cloudy = scene('S2B_cloudy', '2026-09-25');
  cloudy.properties['eo:cloud_cover'] = 0;
  const reads = [], calls = [];
  const pair = await provider([before(), after(), cloudy, scene('S2B_winter', '2025-12-01')], {
    fetchImpl: catalog([before(), after(), cloudy, scene('S2B_winter', '2025-12-01')], calls),
    rasterLoader: rasterLoader({ S2B_cloudy: { scl: Array(16).fill(9) } }, reads),
  }).getPair(area);
  assert.equal(pair.after.id, 'S2B_after');
  assert.equal(pair.before.id, 'S2B_before');
  assert.equal(pair.after.sourceUrl, `${ROOT}/collections/sentinel-2-l2a/items/S2B_after`);
  assert.deepEqual(Object.keys(pair.after.bands).sort(), [...KEYS].sort());
  for (const band of KEYS) assert.equal(pair.after.bands[band].length, 16);
  assert.ok(Math.abs(pair.after.bands.red[0] - 0.2) < 1e-6);
  assert.equal(pair.after.bands.scl[0], 5);
  assert.equal(reads.filter(read => read.startsWith('S2B_cloudy:')).length, 1);
  const [start] = JSON.parse(calls[0].options.body).datetime.split('/');
  assert.equal(start, '2025-03-26T12:00:00.000Z');
});

test('rejects wrong CRS, partial footprints, holes and unsafe assets before loading pixels', async () => {
  const badCrs = scene('bad_crs', '2026-09-25');
  badCrs.properties['proj:epsg'] = 32643;
  const partial = scene('partial', '2026-09-24');
  partial.geometry.coordinates[0][1][0] = area.bbox[0];
  partial.geometry.coordinates[0][2][0] = area.bbox[0];
  const hole = scene('hole', '2026-09-23');
  hole.geometry.coordinates.push([...corners, corners[0]]);
  const unsafe = scene('unsafe', '2026-09-22');
  unsafe.assets.red.href = 'https://sentinel-cogs.s3.us-west-2.amazonaws.com.evil.test/secret.tif';
  const reads = [];
  const pair = await provider([badCrs, partial, hole, unsafe, after(), before()], {
    rasterLoader: rasterLoader({}, reads),
  }).getPair(area);
  assert.equal(pair.after.id, 'S2B_after');
  assert.ok(reads.every(read => read.startsWith('S2B_after:') || read.startsWith('S2B_before:')));
});

test('rejects non-HTTPS, authenticated, signed, redirected-host and missing band assets', async t => {
  for (const href of [
    'http://sentinel-cogs.s3.us-west-2.amazonaws.com/a.tif',
    'https://secret:password@sentinel-cogs.s3.us-west-2.amazonaws.com/a.tif',
    `${COG}/a.tif?token=secret`, `${COG}:8443/a.tif`, 'https://127.0.0.1/a.tif',
  ]) await t.test(href.split('/').at(-1), async () => {
    const item = after(); item.assets.red.href = href;
    await assert.rejects(provider([item, before()]).getPair(area), errorCode('SATELLITE_NO_PAIR'));
  });
  const missing = after(); delete missing.assets.nir;
  await assert.rejects(provider([missing, before()]).getPair(area), errorCode('SATELLITE_NO_PAIR'));
});

test('zero, asset nodata, TIFF nodata and cloud pixels cannot turn into valid reflectance', async () => {
  const item = after(); item.assets.red['raster:bands'][0].nodata = 1234;
  const values = [0, 1234, 65535, 4000, ...Array(12).fill(3000)];
  const scl = [5, 5, 3, ...Array(13).fill(5)];
  const pair = await provider([before(), item], {
    rasterLoader: rasterLoader({ S2B_after: { red: values, scl }, S2B_before: { green: [65535, ...Array(15).fill(3000)] } }),
  }).getPair(area);
  for (let i = 0; i < 3; i++) assert.ok(Number.isNaN(pair.after.bands.red[i]));
  assert.ok(Number.isNaN(pair.after.bands.nir[2]));
  assert.ok(Number.isNaN(pair.before.bands.green[0]));
  assert.ok(Math.abs(pair.after.bands.red[4] - 0.2) < 1e-6);
});

test('does not compare individually clear scenes with insufficient common clear area', async () => {
  const reads = [];
  const near = scene('S2B_near', '2025-09-21');
  const pair = await provider([after(), before(), near], {
    rasterLoader: rasterLoader({
      S2B_after: { scl: [9, 9, 9, ...Array(13).fill(5)] },
      S2B_near: { scl: [...Array(13).fill(5), 9, 9, 9] },
    }, reads),
  }).getPair(area);
  assert.equal(pair.before.id, 'S2B_before');
  assert.ok(reads.some(read => read.startsWith('S2B_near:')));
});

test('bounds candidate attempts to four per period and loads bands sequentially', async () => {
  const recent = Array.from({ length: 6 }, (_, i) => scene(`cloud${i}`, `2026-09-${25 - i}`));
  const reads = [];
  await assert.rejects(provider([...recent, before()], {
    rasterLoader: rasterLoader(Object.fromEntries(recent.map(item => [item.id, { scl: Array(16).fill(8) }])), reads),
  }).getPair(area), errorCode('SATELLITE_NO_PAIR'));
  assert.equal(reads.length, 4);
  let active = 0, maximum = 0;
  const load = rasterLoader();
  await provider([before(), after()], { rasterLoader: async options => {
    active++; maximum = Math.max(active, maximum);
    await new Promise(resolve => setImmediate(resolve));
    const result = await load(options); active--; return result;
  } }).getPair(area);
  assert.equal(maximum, 1);
});

test('never selects future, stale, near-date or noncomparable baseline scenes', async () => {
  const candidates = [after(), scene('future', '2026-10-01'), scene('stale', '2024-09-20'),
    scene('near', '2026-09-10'), scene('other_season', '2025-12-01')];
  await assert.rejects(provider(candidates).getPair(area), errorCode('SATELLITE_NO_PAIR'));
  const old = [scene('old_after', '2025-03-01'), scene('old_before', '2024-03-01')];
  await assert.rejects(provider(old).getPair(area), errorCode('SATELLITE_NO_PAIR'));
});

test('monitoring resolves the exact fixed item and finds only newer same-season observations', async () => {
  const fixed = scene('S2B_fixed', '2024-09-10');
  const items = [after(), scene('wrong_season', '2026-05-01')], calls = [];
  const pair = await provider(items, { fetchImpl: catalog(items, calls, [fixed]) })
    .getPair(area, { baselineId: fixed.id, afterDate: '2026-09-01T00:00:00Z' });
  assert.equal(pair.before.id, fixed.id);
  assert.equal(pair.after.id, 'S2B_after');
  assert.equal(calls[0].url, `${ROOT}/collections/sentinel-2-l2a/items/S2B_fixed`);
  await assert.rejects(provider([fixed, after()]).getPair(area, {
    baselineId: fixed.id, afterDate: '2026-09-25T00:00:00Z',
  }), errorCode('SATELLITE_NO_NEW'));
});

test('missing fixed baseline and incomparable new observations never silently replace the baseline', async () => {
  await assert.rejects(provider([before(), after()]).getPair(area, { baselineId: 'missing' }), errorCode('SATELLITE_NO_PAIR'));
  const fixed = scene('fixed', '2024-02-10');
  await assert.rejects(provider([fixed, after()]).getPair(area, { baselineId: 'fixed' }), errorCode('SATELLITE_NO_PAIR'));
  const recent = scene('recent', '2026-09-10');
  await assert.rejects(provider([recent, after()]).getPair(area, { baselineId: 'recent' }), errorCode('SATELLITE_NO_PAIR'));
});

test('malformed catalog and raster failures become stable errors without upstream details', async () => {
  for (const fetchImpl of [
    async () => new Response('password', { status: 503 }),
    async () => new Response('not json'),
    async () => Response.json({ features: null }),
    async () => { throw new Error('https://private.test/?token=secret'); },
  ]) await assert.rejects(provider([], { fetchImpl }).getPair(area), errorCode('SATELLITE_UNAVAILABLE'));
  await assert.rejects(provider([before(), after()], {
    rasterLoader: async () => { throw new Error('https://private.test/?token=secret'); },
  }).getPair(area), errorCode('SATELLITE_UNAVAILABLE'));
});

test('invalid area, monitoring input and mismatched returned grids are rejected', async () => {
  for (const bad of [{ ...area, width: 50000 }, { ...area, resolution: 10 }, { ...area, epsg: 4326 }]) {
    await assert.rejects(provider([]).getPair(bad), errorCode('SATELLITE_NO_PAIR'));
  }
  for (const options of [{ baselineId: '../secret' }, { afterDate: 'yesterday' }]) {
    await assert.rejects(provider([]).getPair(area, options), errorCode('SATELLITE_NO_PAIR'));
  }
  const load = rasterLoader();
  await assert.rejects(provider([before(), after()], {
    rasterLoader: async options => ({ ...await load(options), epsg: 32643 }),
  }).getPair(area), errorCode('SATELLITE_NO_PAIR'));
});

test('PNG pixels contain actual RGB samples, masks and only requested candidate highlights', () => {
  const bands = Object.fromEntries(KEYS.map(band => [band, new Float32Array(16).fill(band === 'scl' ? 5 : 0.1)]));
  bands.red[0] = 0.3; bands.green[0] = 0.1; bands.blue[0] = 0.05;
  bands.red[1] = 0.05; bands.green[1] = 0.3; bands.blue[1] = 0.1;
  bands.scl[2] = 9; bands.red[3] = NaN;
  const encoded = renderScene({ bands }, area);
  assert.ok(Buffer.isBuffer(encoded));
  const png = PNG.sync.read(encoded);
  assert.equal(png.width, 4); assert.equal(png.height, 4);
  assert.ok(png.data[0] > png.data[1] && png.data[1] > png.data[2]);
  assert.deepEqual([...png.data.subarray(0, 4)], [255, 155, 113, 255]);
  assert.ok(png.data[5] > png.data[6] && png.data[6] > png.data[4]);
  assert.equal(png.data[3], 255);
  assert.equal(png.data[11], 0); assert.equal(png.data[15], 0);
  const marked = PNG.sync.read(renderScene({ bands }, area, [1, 2, -1, 900]));
  assert.deepEqual(marked.data.subarray(0, 4), png.data.subarray(0, 4));
  assert.notDeepEqual(marked.data.subarray(4, 8), png.data.subarray(4, 8));
  assert.equal(marked.data[11], 0);
});

function tiledRaster({ band, epsg = 32642, x = 599840, y = 5600240, resolution = 20,
  width = 64, height = 64, sample = () => band === 'scl' ? 5 : 3000 } = {}) {
  const tileSize = 16, bytesPerTile = tileSize * tileSize * 2;
  const tilesAcross = width / tileSize, tilesDown = height / tileSize;
  const data = new Uint16Array(width * height);
  for (let ty = 0; ty < tilesDown; ty++) for (let tx = 0; tx < tilesAcross; tx++) {
    for (let row = 0; row < tileSize; row++) for (let col = 0; col < tileSize; col++) {
      data[(ty * tilesAcross + tx) * tileSize * tileSize + row * tileSize + col] = sample(tx * tileSize + col, ty * tileSize + row);
    }
  }
  const metadata = {
    width, height, ModelPixelScale: [resolution, resolution, 0], ModelTiepoint: [0, 0, 0, x, y, 0],
    GTModelTypeGeoKey: 1, GTRasterTypeGeoKey: 1, ProjectedCSTypeGeoKey: epsg, ProjLinearUnitsGeoKey: 9001,
    GDAL_NODATA: '65535\0',
  };
  const buffer = writeArrayBuffer(data, metadata);
  // The library writer only emits strips; append a tiled directory for the same tiny payload.
  const view = new DataView(buffer), little = view.getUint16(0) === 0x4949;
  const ifd = view.getUint32(4, little), entries = view.getUint16(ifd, little);
  const retained = [];
  for (let i = 0; i < entries; i++) {
    const offset = ifd + 2 + i * 12;
    if (![273, 278, 279].includes(view.getUint16(offset, little))) retained.push(new Uint8Array(buffer.slice(offset, offset + 12)));
  }
  const tileCount = tilesAcross * tilesDown;
  const nextIfd = buffer.byteLength;
  const table = nextIfd + 2 + (retained.length + 4) * 12 + 4;
  const tiled = new Uint8Array(table + tileCount * 8);
  tiled.set(new Uint8Array(buffer));
  const output = new DataView(tiled.buffer);
  for (const [tag, count, value] of [[322, 1, tileSize], [323, 1, tileSize],
    [324, tileCount, table], [325, tileCount, table + tileCount * 4]]) {
    const entry = new DataView(new ArrayBuffer(12));
    entry.setUint16(0, tag, little); entry.setUint16(2, 4, little);
    entry.setUint32(4, count, little); entry.setUint32(8, value, little);
    retained.push(new Uint8Array(entry.buffer));
  }
  retained.sort((a, b) => new DataView(a.buffer).getUint16(0, little) - new DataView(b.buffer).getUint16(0, little));
  output.setUint32(4, nextIfd, little);
  output.setUint16(nextIfd, retained.length, little);
  retained.forEach((entry, i) => tiled.set(entry, nextIfd + 2 + i * 12));
  output.setUint32(nextIfd + 2 + retained.length * 12, 0, little);
  for (let i = 0; i < tileCount; i++) {
    output.setUint32(table + i * 4, 1000 + bytesPerTile * i, little);
    output.setUint32(table + tileCount * 4 + i * 4, bytesPerTile, little);
  }
  return Buffer.from(tiled);
}

function rangeServer(items, makeRaster, requests = [], overrideResponse) {
  const stac = catalog(items);
  return async (url, options) => {
    if (url.startsWith(ROOT)) return stac(url, options);
    assert.ok(url.startsWith(`${COG}/sentinel-s2-l2a-cogs/`));
    assert.equal(options.redirect, 'error');
    assert.equal(options.credentials, 'omit');
    const range = new Headers(options.headers).get('range');
    const match = /^bytes=(\d+)-(\d+)$/.exec(range);
    assert.ok(match, 'Every COG request must have a bounded single byte range');
    const start = Number(match[1]), requestedEnd = Number(match[2]);
    assert.ok(requestedEnd - start + 1 <= 8 * 1024 * 1024);
    const band = url.split('/').at(-1).replace('.tif', '');
    const bytes = makeRaster(band);
    requests.push({ start, end: requestedEnd, band, signal: options.signal });
    if (overrideResponse) return overrideResponse({ bytes, start, end: requestedEnd, signal: options.signal });
    const end = Math.min(bytes.length - 1, requestedEnd);
    return new Response(bytes.subarray(start, end + 1), {
      status: 206, headers: { 'content-range': `bytes ${start}-${end}/${bytes.length}`,
        'content-length': String(end - start + 1), 'content-type': 'image/tiff' },
    });
  };
}

test('real TIFF decoding uses byte ranges and aligns 10 m and 20 m samples to the exact AOI', async () => {
  const requests = [];
  const rasters = Object.fromEntries(KEYS.map(band => [band, tiledRaster({ band,
    resolution: band === 'scl' || band === 'swir16' ? 20 : 10,
    sample: (col, row) => band === 'scl' ? 5 : band === 'swir16' ? 4000 : 2000 + col * 100 + row * 10,
  })]));
  const pair = await createSatelliteProvider({ now: () => NOW,
    fetchImpl: rangeServer([before(), after()], band => rasters[band], requests),
  }).getPair(area);
  // Upper-left 20 m cell averages native columns 16/17 and rows 16/17: DN 3815.
  assert.ok(Math.abs(pair.after.bands.red[0] - 0.2815) < 1e-6);
  assert.ok(Math.abs(pair.after.bands.red[1] - 0.3015) < 1e-6);
  assert.ok(Math.abs(pair.after.bands.red[4] - 0.2835) < 1e-6);
  assert.ok(Math.abs(pair.after.bands.swir16[0] - 0.3) < 1e-6);
  assert.equal(pair.after.bands.scl[0], 5);
  assert.ok(requests.length >= 12);
  const png = PNG.sync.read(renderScene(pair.after, area));
  assert.ok(png.data[4] > png.data[0]);
});

test('real raster CRS, bounds, partial coverage and resolution cannot be replaced by STAC claims', async () => {
  for (const override of [{ epsg: 32643 }, { x: 600020 }, { y: 5600060 }, { resolution: 60 }]) {
    const rasters = Object.fromEntries(KEYS.map(band => [band, tiledRaster({ band, ...override })]));
    await assert.rejects(createSatelliteProvider({ now: () => NOW,
      fetchImpl: rangeServer([before(), after()], band => rasters[band]),
    }).getPair(area), errorCode('SATELLITE_NO_PAIR'));
  }
});

test('native 10 m nodata contaminates its 20 m cell instead of being averaged into reflectance', async () => {
  const rasters = Object.fromEntries(KEYS.map(band => [band, tiledRaster({ band,
    resolution: band === 'scl' || band === 'swir16' ? 20 : 10,
    sample: (col, row) => band === 'scl' ? 5 : (band === 'red' && col === 16 && row === 16) ? 0 : 3000,
  })]));
  const pair = await createSatelliteProvider({ now: () => NOW,
    fetchImpl: rangeServer([before(), after()], band => rasters[band]),
  }).getPair(area);
  assert.ok(Number.isNaN(pair.after.bands.red[0]));
  assert.ok(Math.abs(pair.after.bands.red[1] - 0.2) < 1e-6);
});

test('HTTP 200 and redirects are rejected before any full raster response is consumed', async () => {
  for (const status of [200, 302]) {
    let consumed = 0, cancelled = 0;
    await assert.rejects(createSatelliteProvider({ now: () => NOW,
      fetchImpl: rangeServer([before(), after()], band => tiledRaster({ band }), [], () => new Response(new ReadableStream({
        pull() { consumed++; }, cancel() { cancelled++; },
      }, { highWaterMark: 0 }), { status })),
    }).getPair(area), errorCode('SATELLITE_UNAVAILABLE'));
    assert.equal(consumed, 0);
    assert.ok(cancelled > 0);
  }
});

test('incorrect, missing and oversized range responses fail without whole-file fallback', async () => {
  for (const headers of [
    { 'content-range': 'bytes 3-9/100' }, {},
    { 'content-range': 'bytes 0-10/100', 'content-length': '999999999' },
  ]) {
    await assert.rejects(createSatelliteProvider({ now: () => NOW,
      fetchImpl: rangeServer([before(), after()], band => tiledRaster({ band }), [], () => new Response('bad data', { status: 206, headers })),
    }).getPair(area), errorCode('SATELLITE_UNAVAILABLE'));
  }
});

test('catalog header and body stalls time out even if an injected fetch ignores cancellation', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const fetchImpl of [
    () => new Promise(() => {}),
    async () => new Response(new ReadableStream({ pull() {} })),
  ]) {
    const pending = provider([], { fetchImpl }).getPair(area);
    const rejected = assert.rejects(pending, errorCode('SATELLITE_UNAVAILABLE'));
    await new Promise(resolve => setImmediate(resolve));
    t.mock.timers.tick(20001);
    await rejected;
  }
});

test('caller cancellation aborts raster work and never leaks the cancellation reason', async () => {
  const controller = new AbortController();
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  let rasterSignal;
  const pending = provider([before(), after()], { rasterLoader: async ({ signal }) => {
    rasterSignal = signal; started(); return new Promise(() => {});
  } }).getPair(area, { signal: controller.signal });
  const rejected = assert.rejects(pending, errorCode('SATELLITE_UNAVAILABLE'));
  await ready;
  controller.abort(new Error('secret https://private.test'));
  await rejected;
  assert.equal(rasterSignal.aborted, true);
});

test('scene selection matches the geometry contract: at least 80 percent clear SCL 4/5 land', async () => {
  const water = scene('water', '2026-09-25'), insufficient = scene('insufficient', '2026-09-24');
  const overexposed = scene('overexposed', '2026-09-23');
  const pair = await provider([water, insufficient, overexposed, after(), before()], {
    rasterLoader: rasterLoader({ water: { scl: Array(16).fill(6) },
      insufficient: { scl: [9, 9, 9, 9, ...Array(12).fill(5)] },
      overexposed: { red: Array(16).fill(12000) } }),
  }).getPair(area);
  assert.equal(pair.after.id, 'S2B_after');
});

test('exactly 80 percent common valid pixels passes, while one fewer pixel fails', async () => {
  const grid = { ...area, width: 5, height: 5, projectedBbox: [600000, 5600000, 600100, 5600100] };
  for (const valid of [20, 19]) {
    const load = async ({ band, item }) => ({
      data: Uint16Array.from({ length: 25 }, (_, i) => band === 'scl'
        ? (i < valid ? 5 : 9) : band === 'red' && item.id === 'S2B_after' ? 11000 : 3000),
      width: 5, height: 5, epsg: grid.epsg, bbox: grid.projectedBbox, nodata: 0,
    });
    const pending = provider([before(), after()], { rasterLoader: load }).getPair(grid);
    if (valid === 20) {
      const pair = await pending;
      assert.equal(pair.after.id, 'S2B_after');
      assert.equal(pair.after.bands.red[0], 1);
      assert.equal(pair.after.bands.red.filter(Number.isFinite).length, 20);
    } else await assert.rejects(pending, errorCode('SATELLITE_NO_PAIR'));
  }
});

test('pixels with zero index denominators cannot satisfy the common usable-area threshold', async () => {
  const zero = scene('zero_indices', '2026-09-25');
  const pair = await provider([zero, after(), before()], { rasterLoader: rasterLoader({
    zero_indices: { red: Array(16).fill(1000), nir: Array(16).fill(1000) },
  }) }).getPair(area);
  assert.equal(pair.after.id, 'S2B_after');
});

test('Earth Search COGs explicitly marked offset-applied do not have the BOA offset subtracted twice', async () => {
  const items = [before(), after()];
  for (const item of items) item.properties['earthsearch:boa_offset_applied'] = true;
  const corrected = { red: [0, ...Array(15).fill(500)], green: Array(16).fill(600),
    blue: Array(16).fill(300), nir: Array(16).fill(4000), swir16: Array(16).fill(2500) };
  const pair = await provider(items, { rasterLoader: rasterLoader({ S2B_before: corrected, S2B_after: corrected }) }).getPair(area);
  assert.ok(Number.isNaN(pair.after.bands.red[0]));
  assert.ok(Math.abs(pair.after.bands.red[1] - 0.05) < 1e-6);
  assert.ok(Math.abs(pair.after.bands.blue[1] - 0.03) < 1e-6);
  assert.ok(Math.abs(pair.after.bands.nir[1] - 0.4) < 1e-6);
  assert.deepEqual(pair.after.radiometry.bands.red, { scale: 0.0001, declaredOffset: -0.1, appliedOffset: 0 });
});

test('an unapplied BOA offset still follows raster scale/offset, and corrected zero offsets remain zero', async () => {
  for (const [flag, offset, expected] of [[false, -0.1, 0.2], [true, 0, 0.3]]) {
    const items = [before(), after()];
    for (const item of items) {
      item.properties['earthsearch:boa_offset_applied'] = flag;
      for (const band of KEYS.filter(band => band !== 'scl')) item.assets[band]['raster:bands'][0].offset = offset;
    }
    const pair = await provider(items).getPair(area);
    assert.ok(Math.abs(pair.after.bands.red[0] - expected) < 1e-6);
  }
});

test('annual seasonal windows include 45 days but exclude 46, and monitoring wraps New Year', async () => {
  const within = scene('within', '2025-11-04'), outside = scene('outside', '2025-11-05');
  const pair = await provider([after(), within, outside]).getPair(area);
  assert.equal(pair.before.id, 'within');
  const fixed = scene('fixed', '2024-12-25'), january = scene('january', '2026-01-05');
  const monitored = await provider([fixed, january, after()]).getPair(area, { baselineId: 'fixed', afterDate: '2025-12-30' });
  assert.equal(monitored.after.id, 'january');
});

test('baseline attempts start nearest the annual anniversary instead of wasting all four on late-season snow', async () => {
  const snowy = ['2025-11-03', '2025-11-01', '2025-10-29', '2025-10-26']
    .map((date, i) => scene(`snow${i}`, date));
  const comparable = scene('anniversary', '2025-09-20'), reads = [];
  const pair = await provider([after(), comparable, ...snowy], { rasterLoader: rasterLoader(
    Object.fromEntries(snowy.map(item => [item.id, { scl: Array(16).fill(11) }])), reads,
  ) }).getPair(area);
  assert.equal(pair.before.id, 'anniversary');
  assert.ok(reads.every(read => !read.startsWith('snow')));
});

test('invalid radiometric metadata is skipped instead of interpreting raw DN as reflectance', async () => {
  for (const metadata of [{ nodata: 0 }, { scale: -0.001 }, { scale: 0 }, { scale: 0.0001, offset: 'bad' }]) {
    const bad = scene('bad', '2026-09-25'); bad.assets.red['raster:bands'] = [metadata];
    const pair = await provider([bad, before(), after()]).getPair(area);
    assert.equal(pair.after.id, 'S2B_after');
  }
});

test('catalog paging stays bounded and never follows external next links', async () => {
  const calls = [];
  const broken = Array.from({ length: 100 }, (_, index) => {
    const item = scene(`wrong${index}`, '2026-09-25'); item.properties['proj:epsg'] = 32643; return item;
  });
  await assert.rejects(provider([], { fetchImpl: async (url, options) => {
    assert.equal(url, `${ROOT}/search`);
    const query = JSON.parse(options.body);
    calls.push(query);
    return Response.json({ type: 'FeatureCollection', features: broken.map((item, i) => ({ ...item,
      properties: { ...item.properties, datetime: new Date(Date.parse(query.datetime.split('/')[1]) - (i + 1) * 1000).toISOString() },
    })), links: [{ rel: 'next', href: 'https://private.test/secret', method: 'POST' }] });
  } }).getPair(area), errorCode('SATELLITE_NO_PAIR'));
  assert.equal(calls.length, 3);
  assert.ok(calls[1].datetime < calls[0].datetime);
});

test('catalog responses over the byte bound are cancelled before consumption', async () => {
  let reads = 0, cancelled = false;
  await assert.rejects(provider([], { fetchImpl: async () => new Response(new ReadableStream({
    pull() { reads++; }, cancel() { cancelled = true; },
  }, { highWaterMark: 0 }), { headers: { 'content-length': '999999999' } }) }).getPair(area), errorCode('SATELLITE_UNAVAILABLE'));
  assert.equal(reads, 0); assert.equal(cancelled, true);
});

test('the 180 second total deadline spans both periods and aborts outstanding raster loads', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const slow = [scene('slow1', '2026-09-25'), scene('slow2', '2026-09-24'), scene('slow3', '2026-09-23')];
  const earlier = [scene('old1', '2025-09-25'), scene('old2', '2025-09-24')];
  const load = rasterLoader(), signals = [];
  let settled = false;
  const pending = provider([...slow, after(), ...earlier], { rasterLoader: options => {
    if (options.item.id === 'S2B_after') return load(options);
    signals.push(options.signal); return new Promise(() => {});
  } }).getPair(area);
  const rejected = assert.rejects(pending, errorCode('SATELLITE_UNAVAILABLE')).then(() => { settled = true; });
  await new Promise(resolve => setImmediate(resolve));
  for (let i = 0; i < 4; i++) {
    t.mock.timers.tick(40000);
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.equal(settled, false);
  t.mock.timers.tick(19999);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false);
  t.mock.timers.tick(1);
  await rejected;
  assert.equal(signals.length, 5);
  assert.ok(signals.every(signal => signal.aborted));
});
