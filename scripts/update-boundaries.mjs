import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { createBoundaryCollection } from './boundary-data.mjs';

const endpoint = process.env.OVERPASS_ENDPOINT || 'https://overpass.private.coffee/api/interpreter';
const query = '[out:json][timeout:120];rel["ISO3166-2"~"^KZ-"][boundary=administrative][admin_level=4];out geom;';
const response = await fetch(`${endpoint}?${new URLSearchParams({ data: query })}`, {
  headers: { 'User-Agent': 'ZherMonitoring/1.0 (https://github.com/almaz-svg/pesok-gos)' },
  signal: AbortSignal.timeout(150000),
});
if (!response.ok) throw new Error(`Boundary download failed: HTTP ${response.status}`);
const raw = await response.json();
const collection = createBoundaryCollection(raw, endpoint, query);
const directory = new URL('../assets/geo/', import.meta.url);
const destination = new URL('kz-regions.geojson', directory);
const temporary = new URL('kz-regions.geojson.tmp', directory);
try {
  const previous = JSON.parse(await readFile(destination, 'utf8'));
  if (Date.parse(collection.source.timestamp) < Date.parse(previous.source.timestamp)) {
    throw new Error('The provider returned an older snapshot; existing boundaries were kept.');
  }
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
await mkdir(directory, { recursive: true });
await writeFile(temporary, `${JSON.stringify(collection)}\n`, 'utf8');
await rename(temporary, destination);
console.log(JSON.stringify({ regions: collection.features.length, timestamp: collection.source.timestamp, bytes: Buffer.byteLength(JSON.stringify(collection)), sha256: collection.source.sha256 }));
