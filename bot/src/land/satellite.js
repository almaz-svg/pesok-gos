import proj4 from 'proj4';
import { intersect } from '@turf/intersect';
import { area as polygonArea } from '@turf/area';
import { PNG } from 'pngjs';
import { fromCustomClient } from 'geotiff';

const ROOT = 'https://earth-search.aws.element84.com/v1';
const COLLECTION = 'sentinel-2-l2a';
const COG_HOST = 'sentinel-cogs.s3.us-west-2.amazonaws.com';
const BANDS = ['red', 'green', 'blue', 'nir', 'swir16'];
const DAY = 86400000;
const MIN_CLEAR = 0.8;
const TOTAL_MS = 180000;
const REQUEST_MS = 20000;
const SCENE_MS = 40000;
const CATALOG_BYTES = 8 * 1024 * 1024;
const RANGE_BYTES = 8 * 1024 * 1024;
const TOTAL_RASTER_BYTES = 96 * 1024 * 1024;
const ID = /^[A-Za-z0-9_-]{1,160}$/;

class SatelliteError extends Error {
  constructor(code = 'SATELLITE_UNAVAILABLE') {
    super({
      SATELLITE_NO_PAIR: 'No sufficiently clear comparable satellite pair is available.',
      SATELLITE_NO_NEW: 'No newer comparable satellite observation is available.',
      SATELLITE_UNAVAILABLE: 'Satellite data could not be retrieved within the acquisition limits.',
    }[code]);
    this.name = 'SatelliteError';
    this.code = code;
  }
}

function requireData(condition) {
  if (!condition) throw new SatelliteError('SATELLITE_NO_PAIR');
}

function isClear(value) {
  return value === 4 || value === 5;
}

function validPixel(bands, index) {
  return isClear(bands.scl[index]) && BANDS.every(band =>
    Number.isFinite(bands[band][index]) && bands[band][index] >= 0 && bands[band][index] <= 1)
    && bands.nir[index] + bands.red[index] > 0
    && bands.swir16[index] + bands.red[index] + bands.nir[index] + bands.blue[index] > 0;
}

function clearFraction(scene, reference) {
  let count = 0;
  for (let i = 0; i < scene.bands.scl.length; i++) {
    if (validPixel(scene.bands, i) && (!reference || validPixel(reference.bands, i))) count++;
  }
  return count / scene.bands.scl.length;
}

function validateArea(area) {
  requireData(area && area.resolution === 20 && Number.isInteger(area.width) && Number.isInteger(area.height)
    && area.width > 0 && area.height > 0 && area.width <= 102 && area.height <= 102);
  requireData(Number.isInteger(area.epsg) && ((area.epsg >= 32601 && area.epsg <= 32660)
    || (area.epsg >= 32701 && area.epsg <= 32760)));
  for (const bbox of [area.bbox, area.projectedBbox]) {
    requireData(Array.isArray(bbox) && bbox.length === 4 && bbox.every(Number.isFinite)
      && bbox[0] < bbox[2] && bbox[1] < bbox[3]);
  }
  const [x0, y0, x1, y1] = area.projectedBbox;
  requireData(Math.abs(x1 - x0 - area.width * 20) < 1e-6 && Math.abs(y1 - y0 - area.height * 20) < 1e-6);
  requireData(area.bbox[0] >= -180 && area.bbox[2] <= 180 && area.bbox[1] >= -90 && area.bbox[3] <= 90);
}

function footprint(area) {
  const [x0, y0, x1, y1] = area.projectedBbox;
  const projected = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
  const utm = `+proj=utm +zone=${area.epsg % 100} ${area.epsg >= 32700 ? '+south ' : ''}+datum=WGS84 +units=m +no_defs`;
  const ring = [];
  // Densify the projected edges so a tile corner or footprint hole cannot hide inside a geographic bbox.
  for (let edge = 0; edge < 4; edge++) {
    const a = projected[edge], b = projected[(edge + 1) % 4];
    const steps = Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 20);
    for (let i = 0; i < steps; i++) ring.push(proj4(utm, 'EPSG:4326', [
      a[0] + (b[0] - a[0]) * i / steps, a[1] + (b[1] - a[1]) * i / steps,
    ]));
  }
  ring.push(ring[0]);
  return { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [ring] } };
}

function covers(item, aoi) {
  if (!['Polygon', 'MultiPolygon'].includes(item.geometry?.type)) return false;
  const clipped = intersect({ type: 'FeatureCollection', features: [aoi, item] });
  return clipped && polygonArea(clipped) >= polygonArea(aoi) * (1 - 1e-7);
}

function trustedAsset(asset) {
  const url = new URL(asset.href);
  requireData(url.protocol === 'https:' && url.hostname === COG_HOST && !url.port
    && !url.username && !url.password && !url.search && !url.hash
    && url.pathname.startsWith('/sentinel-s2-l2a-cogs/') && url.pathname.endsWith('.tif'));
  requireData(typeof asset.type === 'string' && asset.type.startsWith('image/tiff'));
  return url.href;
}

function acceptableItem(item, area, aoi) {
  try {
    if (item?.type !== 'Feature' || item.collection !== COLLECTION || !ID.test(item.id)
      || item.properties?.['proj:epsg'] !== area.epsg || !Number.isFinite(Date.parse(item.properties.datetime))) return false;
    for (const band of ['scl', ...BANDS]) {
      const asset = item.assets[band];
      trustedAsset(asset);
      if (asset['proj:epsg'] !== undefined && asset['proj:epsg'] !== area.epsg) return false;
      const metadata = asset['raster:bands'];
      if (!Array.isArray(metadata) || metadata.length !== 1) return false;
      const { scale = band === 'scl' ? 1 : NaN, offset = 0, nodata = 0 } = metadata[0];
      if (!Number.isFinite(scale) || scale <= 0 || !Number.isFinite(offset)
        || !(Number.isFinite(nodata) || nodata === 'nan') || (band === 'scl' && (scale !== 1 || offset !== 0))) return false;
    }
    return covers(item, aoi);
  } catch {
    return false;
  }
}

function shiftMonths(date, months) {
  const result = new Date(date);
  const day = result.getUTCDate();
  result.setUTCDate(1);
  result.setUTCMonth(result.getUTCMonth() + months);
  const end = new Date(result);
  end.setUTCMonth(end.getUTCMonth() + 1, 0);
  result.setUTCDate(Math.min(day, end.getUTCDate()));
  return result;
}

function sameSeason(baseline, latest) {
  const yearDifference = new Date(latest).getUTCFullYear() - new Date(baseline).getUTCFullYear();
  return [-1, 0, 1].some(delta => Math.abs(latest - shiftMonths(baseline, (yearDifference + delta) * 12)) <= 45 * DAY);
}

async function withDeadline(operation, parent, milliseconds) {
  const controller = new AbortController();
  const signal = parent ? AbortSignal.any([parent, controller.signal]) : controller.signal;
  let onAbort;
  const timer = setTimeout(() => controller.abort(), milliseconds);
  try {
    signal.throwIfAborted();
    const aborted = new Promise((_, reject) => {
      onAbort = () => reject(new SatelliteError());
      signal.addEventListener('abort', onAbort, { once: true });
    });
    return await Promise.race([Promise.resolve().then(() => operation(signal)), aborted]);
  } finally {
    clearTimeout(timer);
    if (onAbort) signal.removeEventListener('abort', onAbort);
    controller.abort();
  }
}

async function readBody(response, maximum, signal) {
  if (Number(response.headers.get('content-length')) > maximum) {
    await response.body?.cancel();
    throw new SatelliteError();
  }
  if (!response.body) throw new SatelliteError();
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    for (;;) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximum) throw new SatelliteError();
      chunks.push(Buffer.from(value));
    }
    signal.throwIfAborted();
    return Buffer.concat(chunks, size);
  } finally {
    signal.removeEventListener('abort', cancel);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

async function getCatalog(fetchImpl, url, init, signal, optional = false) {
  return withDeadline(async requestSignal => {
    const response = await fetchImpl(url, { ...init, redirect: 'error', credentials: 'omit', signal: requestSignal });
    if (optional && response.status === 404) { await response.body?.cancel(); return null; }
    if (!response.ok || response.redirected || (response.url && response.url !== url)) {
      await response.body?.cancel();
      throw new SatelliteError();
    }
    return JSON.parse((await readBody(response, CATALOG_BYTES, requestSignal)).toString('utf8'));
  }, signal, REQUEST_MS);
}

async function candidates(fetchImpl, area, aoi, start, end, signal, predicate = () => true, anniversary) {
  const items = new Map();
  for (let page = 0; page < 3 && start < end; page++) {
    const catalog = await getCatalog(fetchImpl, `${ROOT}/search`, {
      method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/geo+json, application/json' },
      body: JSON.stringify({ collections: [COLLECTION], bbox: area.bbox,
        datetime: `${new Date(start).toISOString()}/${new Date(end).toISOString()}`,
        limit: 100, sortby: [{ field: 'properties.datetime', direction: 'desc' }] }),
    }, signal);
    if (catalog?.type !== 'FeatureCollection' || !Array.isArray(catalog.features) || catalog.features.length > 100) throw new SatelliteError();
    let oldest = end;
    for (const item of catalog.features) {
      const date = Date.parse(item?.properties?.datetime);
      if (!Number.isFinite(date) || date < start || date > end) continue;
      oldest = Math.min(oldest, date);
      if (acceptableItem(item, area, aoi) && predicate(date)) items.set(item.id, item);
    }
    if ((anniversary === undefined && items.size >= 4) || catalog.features.length < 100 || oldest >= end) break;
    end = oldest - 1;
  }
  return [...items.values()].sort((a, b) => {
    const aDate = Date.parse(a.properties.datetime), bDate = Date.parse(b.properties.datetime);
    return anniversary === undefined ? bDate - aDate : Math.abs(aDate - anniversary) - Math.abs(bDate - anniversary) || bDate - aDate;
  }).slice(0, 4);
}

function rangeClient(href, fetchImpl, signal, budget) {
  return {
    request({ headers }) {
      // geotiff schedules tiles concurrently; serialize HTTP streams, including their bodies.
      const pending = budget.queue.then(() => withDeadline(async requestSignal => {
        const range = /^bytes=(\d+)-(\d+)$/.exec(new Headers(headers).get('range'));
        if (!range) throw new SatelliteError();
        const start = Number(range[1]), end = Number(range[2]);
        const maximum = end - start + 1;
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || maximum < 1
          || maximum > RANGE_BYTES || budget.bytes + maximum > TOTAL_RASTER_BYTES) throw new SatelliteError();
        const response = await fetchImpl(href, { headers, redirect: 'error', credentials: 'omit', signal: requestSignal });
        const contentRange = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('content-range') || '');
        const actualStart = Number(contentRange?.[1]), actualEnd = Number(contentRange?.[2]), total = Number(contentRange?.[3]);
        if (response.status !== 206 || response.redirected || (response.url && response.url !== href)
          || !contentRange || !Number.isSafeInteger(total) || total <= 0 || actualStart !== start
          || actualEnd < start || actualEnd !== Math.min(end, total - 1)) {
          await response.body?.cancel();
          throw new SatelliteError();
        }
        const data = await readBody(response, maximum, requestSignal);
        budget.bytes += data.byteLength;
        if (data.byteLength !== actualEnd - actualStart + 1) throw new SatelliteError();
        return { ok: true, status: 206, getHeader: name => response.headers.get(name),
          getData: async () => data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) };
      }, signal, REQUEST_MS));
      budget.queue = pending.catch(() => {});
      return pending;
    },
  };
}

async function readCog({ href, asset, band, area, fetchImpl, signal, budget }) {
  const tiff = await fromCustomClient(rangeClient(href, fetchImpl, signal, budget), {
    allowFullFile: false, maxRanges: 0, blockSize: 16384, cacheSize: 8,
  }, signal);
  try {
    const image = await tiff.getImage();
    const keys = image.getGeoKeys();
    requireData(keys?.ProjectedCSTypeGeoKey === area.epsg && keys.GTModelTypeGeoKey === 1
      && keys.GTRasterTypeGeoKey === 1 && keys.ProjLinearUnitsGeoKey === 9001);
    const tiepoint = image.fileDirectory.getValue('ModelTiepoint');
    requireData(!image.fileDirectory.hasTag('ModelTransformation') && tiepoint?.length === 6
      && tiepoint[0] === 0 && tiepoint[1] === 0 && tiepoint[2] === 0);
    const [x, y] = image.getOrigin(), [rx, ry] = image.getResolution();
    requireData([10, 20].includes(rx) && ry === -rx && (band !== 'scl' || rx === 20));
    const bbox = image.getBoundingBox(), [x0, y0, x1, y1] = area.projectedBbox;
    requireData(bbox.every(Number.isFinite) && bbox[0] <= x0 && bbox[1] <= y0 && bbox[2] >= x1 && bbox[3] >= y1);
    const imageWidth = image.getWidth(), imageHeight = image.getHeight();
    const tw = image.getTileWidth(), th = image.getTileHeight();
    requireData(image.isTiled && imageWidth <= 20000 && imageHeight <= 20000 && tw > 0 && tw <= 1024 && th > 0 && th <= 1024
      && image.getSamplesPerPixel() === 1 && image.getSampleFormat() === 1 && [8, 16].includes(image.getBitsPerSample()));
    const fractionalWindow = [(x0 - x) / rx, (y - y1) / rx, (x1 - x) / rx, (y - y0) / rx];
    requireData(fractionalWindow.every(value => Number.isFinite(value) && Math.abs(value - Math.round(value)) < 1e-6));
    const window = fractionalWindow.map(Math.round);
    const width = window[2] - window[0], height = window[3] - window[1];
    requireData(window[0] >= 0 && window[1] >= 0 && window[2] <= imageWidth && window[3] <= imageHeight
      && width <= 204 && height <= 204 && width > 0 && height > 0 && (width < imageWidth || height < imageHeight));
    const tileCount = (Math.ceil(window[2] / tw) - Math.floor(window[0] / tw))
      * (Math.ceil(window[3] / th) - Math.floor(window[1] / th));
    requireData(tileCount <= 16);
    const native = await image.readRasters({ window, samples: [0], interleave: true, signal });
    requireData(native.length === width * height);
    const nodata = image.getGDALNoData(), assetNodata = asset['raster:bands'][0].nodata ?? 0;
    const data = new Float32Array(area.width * area.height).fill(NaN);
    const factor = 20 / rx;
    // Average each exact 2x2 native block, but never interpolate across a nodata pixel.
    for (let row = 0; row < area.height; row++) for (let col = 0; col < area.width; col++) {
      let sum = 0, valid = true;
      for (let dy = 0; dy < factor; dy++) for (let dx = 0; dx < factor; dx++) {
        const value = native[(row * factor + dy) * width + col * factor + dx];
        if (!Number.isFinite(value) || value === 0 || value === nodata || value === assetNodata) valid = false;
        sum += value;
      }
      if (valid) data[row * area.width + col] = sum / (factor * factor);
    }
    return { data, width: area.width, height: area.height, epsg: area.epsg, bbox: area.projectedBbox, nodata };
  } finally {
    await tiff.close();
  }
}

async function loadScene(item, area, rasterLoader, fetchImpl, signal) {
  return withDeadline(async sceneSignal => {
    const size = area.width * area.height;
    const bands = {};
    const radiometry = { policy: 'earthsearch-cog-v1',
      boaOffsetAlreadyApplied: item.properties['earthsearch:boa_offset_applied'] === true, bands: {} };
    for (const band of ['scl', ...BANDS]) {
      sceneSignal.throwIfAborted();
      const asset = item.assets[band];
      const raster = await rasterLoader({ item, band, asset, href: trustedAsset(asset), area, fetchImpl, signal: sceneSignal });
      sceneSignal.throwIfAborted();
      requireData(raster && raster.width === area.width && raster.height === area.height && raster.epsg === area.epsg
        && raster.data?.length === size && Array.isArray(raster.bbox)
        && raster.bbox.length === 4 && raster.bbox.every((value, i) => Math.abs(value - area.projectedBbox[i]) < 1e-6));
      const { scale = 1, offset = 0, nodata = 0 } = asset['raster:bands'][0];
      // This legacy COG collection can retain the source JP2 offset after applying it to pixels.
      // https://github.com/Element84/earth-search/issues/71; never infer this correction from pixel values.
      const appliedOffset = radiometry.boaOffsetAlreadyApplied && scale === 0.0001 && offset === -0.1 ? 0 : offset;
      if (band !== 'scl') radiometry.bands[band] = { scale, declaredOffset: offset, appliedOffset };
      const output = band === 'scl' ? new Uint8Array(size) : new Float32Array(size).fill(NaN);
      for (let i = 0; i < size; i++) {
        const raw = raster.data[i];
        if (!Number.isFinite(raw) || raw === 0 || raw === nodata || raw === raster.nodata) continue;
        if (band === 'scl') output[i] = Number.isInteger(raw) && raw >= 0 && raw <= 11 ? raw : 0;
        else if (isClear(bands.scl[i])) output[i] = raw * scale + appliedOffset;
      }
      bands[band] = output;
      if (band === 'scl') requireData(output.reduce((count, value) => count + Number(isClear(value)), 0) / size >= MIN_CLEAR);
    }
    const scene = { id: item.id, datetime: item.properties.datetime,
      sourceUrl: `${ROOT}/collections/${COLLECTION}/items/${item.id}`, bands, radiometry };
    requireData(clearFraction(scene) >= MIN_CLEAR);
    return scene;
  }, signal, SCENE_MS);
}

async function chooseScene(items, area, rasterLoader, fetchImpl, signal, reference) {
  let unavailable = false;
  for (const item of items) {
    signal.throwIfAborted();
    try {
      const scene = await loadScene(item, area, rasterLoader, fetchImpl, signal);
      if (!reference || clearFraction(scene, reference) >= MIN_CLEAR) return scene;
    } catch (error) {
      if (!(error instanceof SatelliteError && error.code === 'SATELLITE_NO_PAIR')) unavailable = true;
    }
  }
  throw new SatelliteError(unavailable ? 'SATELLITE_UNAVAILABLE' : 'SATELLITE_NO_PAIR');
}

/** rasterLoader receives {item, band, asset, href, area, fetchImpl, signal} and returns
 * raw DN {data, width, height, epsg, bbox, nodata} on the exact requested 20 m grid. */
export function createSatelliteProvider({ fetchImpl = fetch, now = () => new Date(), rasterLoader = readCog } = {}) {
  return {
    async getPair(area, { baselineId, afterDate, signal } = {}) {
      try {
        validateArea(area);
        const current = new Date(now());
        requireData(Number.isFinite(current.getTime()));
        requireData(baselineId === undefined || (typeof baselineId === 'string' && ID.test(baselineId)));
        const newerThan = afterDate === undefined ? -Infinity : Date.parse(afterDate);
        requireData(afterDate === undefined || (typeof afterDate === 'string' && Number.isFinite(newerThan)));
        const aoi = footprint(area);
        return await withDeadline(async taskSignal => {
          const budget = { bytes: 0, queue: Promise.resolve() };
          const load = rasterLoader === readCog ? options => readCog({ ...options, budget }) : rasterLoader;
          let before;
          if (baselineId !== undefined) {
            const item = await getCatalog(fetchImpl, `${ROOT}/collections/${COLLECTION}/items/${baselineId}`, {}, taskSignal, true);
            requireData(item && item.id === baselineId && acceptableItem(item, area, aoi)
              && Date.parse(item.properties.datetime) < current.getTime());
            before = await chooseScene([item], area, load, fetchImpl, taskSignal);
          }
          const baselineTime = before ? Date.parse(before.datetime) : null;
          const start = Math.max(shiftMonths(current, -18).getTime(), newerThan + 1,
            before ? baselineTime + 45 * DAY : -Infinity);
          const latest = await candidates(fetchImpl, area, aoi, start, current.getTime(), taskSignal,
            date => !before || sameSeason(baselineTime, date));
          if (!latest.length && afterDate !== undefined) throw new SatelliteError('SATELLITE_NO_NEW');
          const after = await chooseScene(latest, area, load, fetchImpl, taskSignal, before);
          if (!before) {
            const anniversary = shiftMonths(new Date(after.datetime), -12).getTime();
            const earlier = await candidates(fetchImpl, area, aoi, anniversary - 45 * DAY,
              Math.min(anniversary + 45 * DAY, Date.parse(after.datetime) - 45 * DAY), taskSignal, undefined, anniversary);
            before = await chooseScene(earlier, area, load, fetchImpl, taskSignal, after);
          }
          return { before, after };
        }, signal, TOTAL_MS);
      } catch (error) {
        throw error instanceof SatelliteError ? error : new SatelliteError();
      }
    },
  };
}

export function renderScene(scene, area, candidatePixels = []) {
  validateArea(area);
  const size = area.width * area.height;
  requireData(scene?.bands && ['scl', ...BANDS].every(band => scene.bands[band]?.length === size));
  const png = new PNG({ width: area.width, height: area.height });
  const highlighted = new Set(candidatePixels.filter(index => Number.isInteger(index) && index >= 0 && index < size));
  // One fixed reflectance stretch for both dates; no independent image equalization.
  const channel = reflectance => Math.round(255 * Math.pow(Math.max(0, Math.min(1, reflectance / 0.3)), 1 / 2.2));
  for (let i = 0; i < size; i++) {
    if (!validPixel(scene.bands, i)) continue;
    for (const [j, band] of ['red', 'green', 'blue'].entries()) {
      const value = channel(scene.bands[band][i]);
      png.data[i * 4 + j] = highlighted.has(i) ? Math.round(value * 0.4 + [255, 40, 70][j] * 0.6) : value;
    }
    png.data[i * 4 + 3] = 255;
  }
  return PNG.sync.write(png);
}
