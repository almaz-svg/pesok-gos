import { createHash } from 'node:crypto';
import osmtogeojson from 'osmtogeojson';

export function createBoundaryCollection(raw, endpoint, query) {
  if (raw.remark) throw new Error(`Incomplete boundary response: ${raw.remark}`);
  if (!Number.isFinite(Date.parse(raw.osm3s?.timestamp_osm_base)) || !Array.isArray(raw.elements)) {
    throw new Error('Missing boundary metadata');
  }
  const relations = new Map(raw.elements.filter(item => item.type === 'relation').map(item => [String(item.id), item]));
  if (relations.size !== 20) throw new Error(`Expected 20 administrative regions; got ${relations.size}. Review changes before replacing the dataset.`);
  // Flattening drops osmtogeojson's tainted flag for missing polygon members.
  const converted = osmtogeojson(raw, { flatProperties: false });
  const features = converted.features.filter(feature => feature.id?.startsWith('relation/')).map(feature => {
    const relation = relations.get(feature.id.split('/')[1]);
    if (!relation || feature.properties.tainted || !['Polygon', 'MultiPolygon'].includes(feature.geometry?.type)) {
      throw new Error(`Incomplete geometry: ${feature.id}`);
    }
    const tags = relation.tags;
    if (!tags['ISO3166-2'] || !tags['name:ru'] || !tags['name:kk']) throw new Error(`Missing regional names: ${feature.id}`);
    return {
      type: 'Feature',
      properties: { id: tags['ISO3166-2'], osmId: relation.id, names: { ru: tags['name:ru'], kk: tags['name:kk'] } },
      geometry: feature.geometry,
    };
  }).sort((a, b) => a.properties.id.localeCompare(b.properties.id));
  if (features.length !== 20 || new Set(features.map(feature => feature.properties.id)).size !== 20) {
    throw new Error('Converted dataset must contain 20 unique complete regions.');
  }
  return {
    type: 'FeatureCollection',
    source: {
      name: 'OpenStreetMap contributors', url: 'https://www.openstreetmap.org/copyright',
      license: 'ODbL-1.0', endpoint, query, timestamp: raw.osm3s.timestamp_osm_base,
      retrievedAt: new Date().toISOString(),
      sha256: createHash('sha256').update(JSON.stringify(features)).digest('hex'),
    },
    features,
  };
}
