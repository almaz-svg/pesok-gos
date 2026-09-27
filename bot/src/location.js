import { readFileSync } from 'node:fs';
import { booleanPointInPolygon } from '@turf/boolean-point-in-polygon';

const boundaries = JSON.parse(readFileSync(new URL('../assets/geo/kz-regions.geojson', import.meta.url), 'utf8'));
if (boundaries.type !== 'FeatureCollection' || boundaries.features?.length !== 20 || !boundaries.source?.timestamp) {
  throw new Error('Invalid Kazakhstan boundary dataset');
}

export function validCoordinates(lat, lon) {
  return Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
}

export function analyzeLocation({ lat, lon, accuracyMeters, live = false, inputType = 'coordinates' }) {
  if (!validCoordinates(lat, lon)) throw new RangeError('Invalid coordinates');
  const point = [lon, lat];
  const matches = boundaries.features.filter(feature => booleanPointInPolygon(point, feature));
  const inside = matches.length === 1 && booleanPointInPolygon(point, matches[0], { ignoreBoundary: true });
  return {
    lat, lon,
    status: inside ? 'matched' : matches.length ? 'boundary' : 'outside',
    regions: matches.map(feature => ({ id: feature.properties.id, names: { ...feature.properties.names } })),
    accuracyMeters: Number.isFinite(accuracyMeters) && accuracyMeters >= 0 && accuracyMeters <= 1500 ? accuracyMeters : undefined,
    live: Boolean(live), inputType,
    analyzedAt: new Date().toISOString(),
    datasetTimestamp: boundaries.source.timestamp,
    datasetHash: boundaries.source.sha256,
    source: { name: boundaries.source.name, url: boundaries.source.url, license: boundaries.source.license },
  };
}

export function locationMapUrl({ lat, lon }) {
  return validCoordinates(lat, lon)
    ? `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=17/${lat}/${lon}` : null;
}

export function formatLocationAnalysis(result, language = 'ru') {
  if (!result || !validCoordinates(result.lat, result.lon)) return '';
  const kk = language === 'kk';
  const regions = (Array.isArray(result.regions) ? result.regions : [])
    .map(region => region?.names?.[kk ? 'kk' : 'ru']).filter(name => typeof name === 'string').slice(0, 4);
  const lines = [kk ? 'Геолокацияны тексеру' : 'Проверка геолокации', `${result.lat}, ${result.lon}`];
  if (result.status === 'matched' && regions.length === 1) {
    lines.push(`${kk ? 'Картадағы өңір' : 'Регион по карте'}: ${regions[0]}`);
  } else if (result.status === 'boundary' && regions.length) {
    lines.push(`${kk ? 'Өңір шекарасындағы нүкте' : 'Точка на границе регионов'}: ${regions.join(', ')}`);
  } else {
    lines.push(kk
      ? 'Нүкте Қазақстан өңірлерінің осы картадағы шекараларынан табылмады. Координаттарды тексеріңіз.'
      : 'Точка не найдена в границах регионов Казахстана на этой карте. Проверьте координаты.');
  }
  if (Number.isFinite(result.accuracyMeters)) {
    lines.push(`${kk ? 'Telegram көрсеткен GPS дәлдігі' : 'Точность GPS по данным Telegram'}: +/- ${result.accuracyMeters} м`);
  }
  if (result.live) lines.push(kk
    ? 'Алғашқы нүкте ғана тіркелді. Кейінгі қозғалыс бақыланбайды.'
    : 'Зафиксирована только первая точка. Дальнейшее перемещение не отслеживается.');
  const date = typeof result.datasetTimestamp === 'string' ? result.datasetTimestamp.slice(0, 10) : '';
  lines.push('', `${kk ? 'Карта деректері' : 'Данные карты'}: OpenStreetMap contributors, ODbL 1.0${date ? ` (${date})` : ''}.`,
    'https://www.openstreetmap.org/copyright',
    kk
      ? 'Шекаралар анықтамалық сипатта. Бұл тексеру меншік иесін, кадастр нөмірін немесе заң бұзушылықты анықтамайды.'
      : 'Границы справочные. Эта проверка не определяет собственника, кадастровый номер или наличие нарушения.');
  return lines.join('\n');
}
