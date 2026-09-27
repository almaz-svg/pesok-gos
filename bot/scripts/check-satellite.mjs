import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { createArea, analyzePair } from '../src/land/geometry.js';
import { createSatelliteProvider, renderScene } from '../src/land/satellite.js';
import { displayImage } from '../src/land/telegram.js';

// Explicit, read-only live smoke test. No bot token, Telegram sends or case writes.
const [lat = '51.05', lon = '71.15', halfSizeMeters = '250'] = process.argv.slice(2);
const area = createArea({ lat: Number(lat), lon: Number(lon), halfSizeMeters: Number(halfSizeMeters) });
let requests = 0;
let rangeRequests = 0;
const provider = createSatelliteProvider({ fetchImpl: (url, init) => {
  requests++;
  if (new Headers(init?.headers).has('range')) rangeRequests++;
  return fetch(url, init);
} });
try {
  const pair = await provider.getPair(area);
  const analysis = analyzePair(pair.before, pair.after, area);
  const directory = await mkdtemp(join(tmpdir(), 'zher-satellite-'));
  const images = [];
  for (const [name, scene, mask] of [['before', pair.before, []], ['after', pair.after, []], ['overlay', pair.after, analysis.candidatePixels]]) {
    const image = renderScene(scene, area, mask);
    const decoded = PNG.sync.read(image);
    let opaque = 0;
    const colors = new Set();
    for (let i = 0; i < decoded.data.length; i += 4) {
      if (decoded.data[i + 3]) { opaque++; colors.add(decoded.data.subarray(i, i + 3).toString('hex')); }
    }
    if (!opaque || colors.size < 2) throw new Error('Blank or constant live satellite render');
    const path = join(directory, `${name}.png`);
    await writeFile(path, image);
    const displayPath = join(directory, `${name}-telegram.png`);
    await writeFile(displayPath, displayImage(image));
    images.push({ path, displayPath, width: decoded.width, height: decoded.height, opaque, colors: colors.size });
  }
  console.log(JSON.stringify({ checkedAt: new Date().toISOString(), requests, rangeRequests,
    area, before: analysis.before, after: analysis.after, status: analysis.status,
    validFraction: analysis.validFraction, candidateHectares: analysis.changeHectares, images }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ status: 'failed', code: error.code || 'SMOKE_FAILED', message: error.message, requests, rangeRequests }));
  process.exitCode = 1;
}
