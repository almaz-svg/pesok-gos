import proj4 from 'proj4';
import turfArea from '@turf/area';
import intersect from '@turf/intersect';
import kinks from '@turf/kinks';
import { booleanPointInPolygon } from '@turf/boolean-point-in-polygon';
import { featureCollection, polygon } from '@turf/helpers';

const RESOLUTION = 20;
const MAX_SIDE = 100;
const MAX_VERTICES = 2000;
const REFLECTANCE_BANDS = ['red', 'green', 'blue', 'nir', 'swir16'];
const METHOD = 'vegetation-to-bare-heuristic-v1';
const SETTINGS = Object.freeze({
  validated: false,
  interpretation: 'Candidate vegetation-to-bare change only; not confirmed excavation, permission, or illegality. No change is not evidence of safety.',
  minValidFraction: 0.8,
  clearScl: Object.freeze([4, 5]),
  minBeforeNdvi: 0.45,
  maxAfterNdvi: 0.25,
  minNdviDrop: 0.25,
  minAfterBsi: 0.1,
  minBsiRise: 0.15,
  connectivity: 8,
  minConnectedPixels: 4,
  cellSquareMeters: 400,
  maskConvention: 'Zero-based row-major flat indices; rows north to south, columns west to east.',
  validFractionDenominator: 'All AOI cells; SCL water and all classes except 4/5 are excluded from valid pixels in both scenes.',
  outsideAreaMethod: '400 m2 times Turf intersection area / Turf cell area, clamped to [0,1] per cell; approximate ground area.',
});

function projection(epsg) {
  if (!Number.isInteger(epsg) || epsg < 32638 || epsg > 32645) throw new RangeError('Invalid area UTM EPSG');
  return proj4('EPSG:4326', `+proj=utm +zone=${epsg - 32600} +datum=WGS84 +units=m +no_defs`);
}

function rectangle(project, x0, y0, x1, y1) {
  return polygon([[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]
    .map(coordinate => project.inverse(coordinate))]);
}

function footprint(project, [x0, y0, x1, y1]) {
  // UTM edges curve in WGS84. Include every perimeter cell corner (at most 400).
  const points = [];
  for (let x = x0; x < x1; x += RESOLUTION) points.push([x, y0]);
  for (let y = y0; y < y1; y += RESOLUTION) points.push([x1, y]);
  for (let x = x1; x > x0; x -= RESOLUTION) points.push([x, y1]);
  for (let y = y1; y > y0; y -= RESOLUTION) points.push([x0, y]);
  points.push(points[0]);
  return polygon([points.map(coordinate => project.inverse(coordinate))]);
}

function bounds(feature) {
  const rings = feature.geometry.type === 'Polygon'
    ? feature.geometry.coordinates : feature.geometry.coordinates.flat();
  const result = [Infinity, Infinity, -Infinity, -Infinity];
  for (const ring of rings) {
    for (const [x, y] of ring) {
      result[0] = Math.min(result[0], x);
      result[1] = Math.min(result[1], y);
      result[2] = Math.max(result[2], x);
      result[3] = Math.max(result[3], y);
    }
  }
  return result;
}

/** The centre is snapped by at most 10 m per axis, preserving the requested size. */
export function createArea({ lat, lon, halfSizeMeters } = {}) {
  if (!Number.isFinite(lat) || lat < 40 || lat > 56 || !Number.isFinite(lon) || lon < 46 || lon > 88) {
    throw new RangeError('Area centre must be within latitude 40..56 and longitude 46..88');
  }
  if (![250, 500, 1000].includes(halfSizeMeters)) throw new RangeError('Invalid area half-size');
  const epsg = 32600 + Math.floor((lon + 180) / 6) + 1;
  const project = projection(epsg);
  const [x, y] = project.forward([lon, lat]);
  const x0 = Math.round((x - halfSizeMeters) / RESOLUTION) * RESOLUTION;
  const y0 = Math.round((y - halfSizeMeters) / RESOLUTION) * RESOLUTION;
  const projectedBbox = [x0, y0, x0 + 2 * halfSizeMeters, y0 + 2 * halfSizeMeters];
  return {
    lat, lon, halfSizeMeters, bbox: bounds(footprint(project, projectedBbox)), epsg, projectedBbox,
    width: 2 * halfSizeMeters / RESOLUTION, height: 2 * halfSizeMeters / RESOLUTION, resolution: RESOLUTION,
  };
}

function checkArea(area) {
  if (!area || !Number.isInteger(area.width) || !Number.isInteger(area.height)
    || area.width < 1 || area.height < 1 || area.width > MAX_SIDE || area.height > MAX_SIDE
    || area.resolution !== RESOLUTION) throw new RangeError('Invalid or unbounded area grid');
  const box = area.projectedBbox;
  if (!Array.isArray(box) || box.length !== 4 || !box.every(Number.isFinite)
    || box.some(value => value % RESOLUTION !== 0)
    || box[0] < 100000 || box[2] > 900000 || box[1] < 4000000 || box[3] > 6400000
    || box[2] - box[0] !== area.width * RESOLUTION || box[3] - box[1] !== area.height * RESOLUTION) {
    throw new RangeError('Invalid area projected grid bounds');
  }
  return projection(area.epsg);
}

function samePoint(a, b) {
  return a[0] === b[0] && a[1] === b[1];
}

function overlaps(a, b) {
  return a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
}

function collinear(a, b, c) {
  return (b[0] - a[0]) * (c[1] - a[1]) === (b[1] - a[1]) * (c[0] - a[0]);
}

function checkSegments(rings) {
  const segments = [];
  for (const [ringIndex, ring] of rings.entries()) {
    for (let i = 0; i < ring.length - 1; i++) {
      const a = ring[i];
      const b = ring[i + 1];
      segments.push({ a, b, ringIndex, edge: i, count: ring.length - 1,
        bbox: [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])] });
    }
  }
  // At most 2000 vertices. Sweep bounding boxes and stop at the first crossing;
  // never ask kinks() to allocate every intersection in a hostile contour.
  segments.sort((a, b) => a.bbox[0] - b.bbox[0]);
  for (let i = 0; i < segments.length; i++) {
    const a = segments[i];
    for (let j = i + 1; j < segments.length && segments[j].bbox[0] <= a.bbox[2]; j++) {
      const b = segments[j];
      if (!overlaps(a.bbox, b.bbox)) continue;
      const adjacent = a.ringIndex === b.ringIndex
        && (Math.abs(a.edge - b.edge) === 1 || Math.abs(a.edge - b.edge) === a.count - 1);
      const onSameLine = collinear(a.a, a.b, b.a) && collinear(a.a, a.b, b.b);
      if (onSameLine) {
        const axis = a.a[0] === a.b[0] ? 1 : 0;
        const length = Math.min(a.bbox[axis + 2], b.bbox[axis + 2]) - Math.max(a.bbox[axis], b.bbox[axis]);
        if (length > 0 || !adjacent) throw new Error('Invalid boundary: overlapping or touching edges');
      } else if (!adjacent && kinks({ type: 'MultiLineString', coordinates: [[a.a, a.b], [b.a, b.b]] }).features.length) {
        throw new Error('Invalid boundary: self-crossing or touching rings');
      }
    }
  }
}

/** Return an independent 2D GeoJSON Feature. Upload properties never establish verification. */
export function validateBoundary(geojson, area) {
  const project = checkArea(area);
  const geometry = geojson?.type === 'Feature' ? geojson.geometry : geojson;
  if (!geometry || !['Polygon', 'MultiPolygon'].includes(geometry.type)) throw new TypeError('Boundary must be a Polygon or MultiPolygon');
  const rawPolygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
  if (!Array.isArray(rawPolygons) || !rawPolygons.length || rawPolygons.length > MAX_VERTICES / 4) {
    throw new RangeError('Invalid boundary or vertex limit (2000) exceeded');
  }
  let vertexCount = 0;
  for (const rings of rawPolygons) {
    if (!Array.isArray(rings) || !rings.length || rings.length > MAX_VERTICES / 4) throw new RangeError('Invalid boundary ring limit');
    for (const ring of rings) {
      if (!Array.isArray(ring) || ring.length < 4) throw new TypeError('Boundary rings need at least four vertices');
      vertexCount += ring.length;
      if (vertexCount > MAX_VERTICES) throw new RangeError('Boundary vertex limit is 2000');
    }
  }
  const polygons = rawPolygons.map(rings => rings.map(rawRing => {
    const ring = rawRing.map(coordinate => {
      if (!Array.isArray(coordinate) || coordinate.length < 2 || coordinate.length > 3
        || !coordinate.every(Number.isFinite) || Math.abs(coordinate[0]) > 180 || Math.abs(coordinate[1]) > 90) {
        throw new TypeError('Boundary coordinates must be finite WGS84 positions');
      }
      return coordinate.slice(0, 2);
    });
    if (!samePoint(ring[0], ring.at(-1))) throw new Error('Boundary rings must be closed');
    const seen = new Set();
    let twiceArea = 0;
    const [ox, oy] = ring[0];
    for (let i = 0; i < ring.length - 1; i++) {
      const key = `${ring[i][0]},${ring[i][1]}`;
      if (seen.has(key)) throw new Error('Invalid boundary: repeated vertices');
      seen.add(key);
      twiceArea += (ring[i][0] - ox) * (ring[i + 1][1] - oy) - (ring[i + 1][0] - ox) * (ring[i][1] - oy);
    }
    if (twiceArea === 0) throw new Error('Invalid boundary: degenerate ring');
    return ring;
  }));
  checkSegments(polygons.flat());
  const parts = polygons.map(rings => polygon(rings));
  for (const rings of polygons) {
    const shell = polygon([rings[0]]);
    for (let i = 1; i < rings.length; i++) {
      if (!booleanPointInPolygon(rings[i][0], shell, { ignoreBoundary: true })) throw new Error('Boundary hole must be inside its shell');
      for (let j = 1; j < i; j++) {
        if (booleanPointInPolygon(rings[i][0], polygon([rings[j]]))
          || booleanPointInPolygon(rings[j][0], polygon([rings[i]]))) throw new Error('Boundary holes must not overlap or nest');
      }
    }
  }
  for (let i = 0; i < parts.length; i++) {
    for (let j = 0; j < i; j++) {
      if (booleanPointInPolygon(polygons[i][0][0], parts[j]) || booleanPointInPolygon(polygons[j][0][0], parts[i])) {
        throw new Error('Boundary MultiPolygon parts must not overlap');
      }
    }
  }
  const feature = { type: 'Feature', properties: {}, geometry: {
    type: geometry.type, coordinates: geometry.type === 'Polygon' ? polygons[0] : polygons,
  } };
  const overlap = intersect(featureCollection([feature, footprint(project, area.projectedBbox)]));
  if (!overlap || turfArea(overlap) <= 0) throw new Error('Boundary must intersect the AOI with positive area');
  return feature;
}

function sceneMetadata(scene, count) {
  if (!scene || typeof scene.id !== 'string' || !scene.id.trim() || typeof scene.datetime !== 'string'
    || !Number.isFinite(Date.parse(scene.datetime)) || typeof scene.sourceUrl !== 'string' || !scene.sourceUrl.trim()) {
    throw new TypeError('Scene requires id, datetime and sourceUrl');
  }
  for (const name of [...REFLECTANCE_BANDS, 'scl']) {
    const band = scene.bands?.[name];
    if (!(Array.isArray(band) || ArrayBuffer.isView(band)) || band.length !== count) {
      throw new TypeError(`Invalid scene band ${name}: expected ${count} samples`);
    }
  }
  const metadata = { id: scene.id, datetime: scene.datetime, sourceUrl: scene.sourceUrl };
  if (scene.radiometry) {
    const { policy, boaOffsetAlreadyApplied, bands } = scene.radiometry;
    if (policy !== 'earthsearch-cog-v1' || typeof boaOffsetAlreadyApplied !== 'boolean') throw new TypeError('Invalid scene radiometry policy');
    metadata.radiometry = { policy, boaOffsetAlreadyApplied, bands: {} };
    for (const name of REFLECTANCE_BANDS) {
      const { scale, declaredOffset, appliedOffset } = bands?.[name] || {};
      if (![scale, declaredOffset, appliedOffset].every(Number.isFinite) || scale <= 0) throw new TypeError('Invalid scene radiometry');
      metadata.radiometry.bands[name] = { scale, declaredOffset, appliedOffset };
    }
  }
  return metadata;
}

function indices(bands, index) {
  if (!SETTINGS.clearScl.includes(bands.scl[index])) return null;
  for (const key of REFLECTANCE_BANDS) {
    const value = bands[key][index];
    if (!Number.isFinite(value) || value < 0 || value > 1) return null;
  }
  const red = bands.red[index];
  const nir = bands.nir[index];
  const soil = bands.swir16[index] + red;
  const vegetation = nir + bands.blue[index];
  if (nir + red <= 0 || soil + vegetation <= 0) return null;
  return { ndvi: (nir - red) / (nir + red), bsi: (soil - vegetation) / (soil + vegetation) };
}

function connectedPixels(mask, width, height) {
  const visited = new Uint8Array(mask.length);
  const accepted = [];
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || visited[start]) continue;
    const component = [start];
    visited[start] = 1;
    for (let cursor = 0; cursor < component.length; cursor++) {
      const row = Math.floor(component[cursor] / width);
      const column = component[cursor] % width;
      for (let y = Math.max(0, row - 1); y <= Math.min(height - 1, row + 1); y++) {
        for (let x = Math.max(0, column - 1); x <= Math.min(width - 1, column + 1); x++) {
          const neighbor = y * width + x;
          if (mask[neighbor] && !visited[neighbor]) {
            visited[neighbor] = 1;
            component.push(neighbor);
          }
        }
      }
    }
    if (component.length >= SETTINGS.minConnectedPixels) accepted.push(...component);
  }
  return accepted.sort((a, b) => a - b);
}

/** Fixed, unvalidated heuristic. The provider is responsible for same-season, co-registered scenes. */
export function analyzePair(before, after, area, boundary = null) {
  checkArea(area);
  const count = area.width * area.height;
  const beforeMetadata = sceneMetadata(before, count);
  const afterMetadata = sceneMetadata(after, count);
  const validPixels = [];
  const mask = new Uint8Array(count);
  for (let i = 0; i < count; i++) {
    const first = indices(before.bands, i);
    const second = indices(after.bands, i);
    if (!first || !second) continue;
    validPixels.push(i);
    if (first.ndvi >= SETTINGS.minBeforeNdvi && second.ndvi <= SETTINGS.maxAfterNdvi
      && first.ndvi - second.ndvi >= SETTINGS.minNdviDrop && second.bsi >= SETTINGS.minAfterBsi
      && second.bsi - first.bsi >= SETTINGS.minBsiRise) mask[i] = 1;
  }
  const validFraction = validPixels.length / count;
  const sufficient = validFraction >= SETTINGS.minValidFraction;
  const candidatePixels = sufficient ? connectedPixels(mask, area.width, area.height) : [];
  const result = {
    status: sufficient ? (candidatePixels.length ? 'change' : 'no_change') : 'insufficient_data',
    method: METHOD, area: { ...area, bbox: [...area.bbox], projectedBbox: [...area.projectedBbox] },
    before: beforeMetadata, after: afterMetadata, validFraction,
    changeHectares: sufficient ? candidatePixels.length * SETTINGS.cellSquareMeters / 10000 : null,
    candidatePixels, validPixels, settings: { ...SETTINGS, clearScl: [...SETTINGS.clearScl] },
  };
  result.boundary = compareBoundary(result, boundary);
  return result;
}

function pixelSet(pixels, count) {
  if (!Array.isArray(pixels) || pixels.length > count) throw new RangeError('Invalid stored pixel mask length');
  const unique = new Set();
  for (const index of pixels) {
    if (!Number.isInteger(index) || index < 0 || index >= count || unique.has(index)) throw new RangeError('Invalid stored pixel mask index');
    unique.add(index);
  }
  return unique;
}

/** Return only {status, outsideHectares}; verifiedBy must come from the trusted operator layer. */
export function compareBoundary(analysis, boundary) {
  if (!boundary) return { status: 'missing', outsideHectares: null };
  const project = checkArea(analysis?.area);
  const area = analysis.area;
  const count = area.width * area.height;
  const candidates = pixelSet(analysis.candidatePixels, count);
  const valid = pixelSet(analysis.validPixels, count);
  for (const index of candidates) if (!valid.has(index)) throw new RangeError('Candidate mask must be a subset of valid pixels');
  const feature = validateBoundary(boundary.type ? boundary : boundary.geometry, area);
  const reviewed = (typeof boundary.verifiedBy === 'string' && boundary.verifiedBy.trim().length > 0)
    || (Number.isSafeInteger(boundary.verifiedBy) && boundary.verifiedBy > 0);
  if (!reviewed) return { status: 'unverified', outsideHectares: null };
  if (analysis.status === 'insufficient_data' || valid.size / count < SETTINGS.minValidFraction) {
    return { status: 'verified', outsideHectares: null };
  }
  // Clip to the geographic envelope, not four projected AOI corners: straight
  // chords between those corners can otherwise cut off valid perimeter cells.
  const [west, south, east, north] = bounds(footprint(project, area.projectedBbox));
  const envelope = polygon([[[west, south], [east, south], [east, north], [west, north], [west, south]]]);
  const clipped = intersect(featureCollection([feature, envelope]));
  const clipBounds = bounds(clipped);
  let outsideCells = 0;
  for (const index of candidates) {
    const column = index % area.width;
    const row = Math.floor(index / area.width);
    const x0 = area.projectedBbox[0] + column * RESOLUTION;
    const y1 = area.projectedBbox[3] - row * RESOLUTION;
    const cell = rectangle(project, x0, y1 - RESOLUTION, x0 + RESOLUTION, y1);
    const overlap = overlaps(bounds(cell), clipBounds) ? intersect(featureCollection([cell, clipped])) : null;
    // Use a ratio so spherical Turf areas cannot exceed the nominal 400 m2 grid cell.
    const fraction = overlap ? Math.max(0, Math.min(1, turfArea(overlap) / turfArea(cell))) : 0;
    outsideCells += 1 - fraction;
  }
  return { status: 'verified', outsideHectares: outsideCells * SETTINGS.cellSquareMeters / 10000 };
}
