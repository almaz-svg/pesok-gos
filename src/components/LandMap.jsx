import { useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import { LocateFixed, Minus, Plus, RefreshCw, TriangleAlert } from 'lucide-react';
import 'leaflet/dist/leaflet.css';
import { STATUS_META } from '../lib/domain.js';
import './inspector.css';

const EMPTY = { type: 'FeatureCollection', features: [] };
const COLOR = { green: '#a5dc77', yellow: '#f0ca63', red: '#ef8977' };
const featureColor = (status) => COLOR[STATUS_META[status]?.tone] || '#a5dc77';
const matches = (value, type, id) =>
  value === id || value === `${type}:${id}` || (value?.id === id && value?.type === type);

function tooltip(text) {
  const element = document.createElement('span');
  element.textContent = text;
  return element;
}

/** GeoJSON remains in WGS84. Leaflet handles polygon coordinate conversion. */
export default function LandMap({
  data,
  onSelectReport,
  onSelectPlot,
  onBoundsChange,
  selectedId,
  focusId,
  showPlots = true,
  showReports = true,
}) {
  const containerRef = useRef(null);
  const mapRef = useRef(null);
  const tilesRef = useRef(null);
  const featuresRef = useRef(new Map());
  const callbackRef = useRef({ onSelectReport, onSelectPlot, onBoundsChange });
  const initialFitRef = useRef(false);
  const lastFocusRef = useRef(null);
  const [tileError, setTileError] = useState(false);
  callbackRef.current = { onSelectReport, onSelectPlot, onBoundsChange };

  function fitFeatures() {
    const layers = [...featuresRef.current.values()];
    if (!mapRef.current || !layers.length) return;
    const bounds = L.featureGroup(layers).getBounds();
    if (bounds.isValid())
      mapRef.current.fitBounds(bounds, {
        padding: [60, 60],
        maxZoom: 15,
        animate: !window.matchMedia('(prefers-reduced-motion: reduce)').matches,
      });
  }

  useEffect(() => {
    const map = L.map(containerRef.current, {
      zoomControl: false,
      attributionControl: true,
      scrollWheelZoom: false,
      keyboard: true,
    }).setView([43.3, 68.3], 13);
    const tiles = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution:
        '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a>',
      maxZoom: 19,
      crossOrigin: true,
      className: 'land-map__tiles',
    }).addTo(map);
    tiles.on('tileerror', () => setTileError(true));
    mapRef.current = map;
    tilesRef.current = tiles;
    const emitBounds = () => {
      const bounds = map.getBounds();
      const bbox = [
        Math.max(-180, Math.min(180, bounds.getWest())),
        Math.max(-90, Math.min(90, bounds.getSouth())),
        Math.max(-180, Math.min(180, bounds.getEast())),
        Math.max(-90, Math.min(90, bounds.getNorth())),
      ];
      if (!bbox.every(Number.isFinite) || bbox[0] >= bbox[2] || bbox[1] >= bbox[3]) return;
      callbackRef.current.onBoundsChange?.(bbox);
    };
    map.on('moveend', emitBounds);
    emitBounds();
    const resize = new ResizeObserver(() => map.invalidateSize({ animate: false }));
    resize.observe(containerRef.current);
    return () => {
      resize.disconnect();
      map.off('moveend', emitBounds);
      map.remove();
      mapRef.current = null;
      tilesRef.current = null;
      initialFitRef.current = false;
      lastFocusRef.current = null;
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const features = new Map();
    const plots = L.geoJSON(showPlots ? data?.plots || EMPTY : EMPTY, {
      style: (feature) => ({
        color: featureColor(feature.properties.status),
        fillColor: featureColor(feature.properties.status),
        weight: matches(selectedId, 'plot', feature.id) ? 3 : 1.5,
        opacity: 0.9,
        fillOpacity: matches(selectedId, 'plot', feature.id) ? 0.35 : 0.13,
      }),
      onEachFeature: (feature, layer) => {
        const label = `Участок ${feature.properties.cadastral_number} — ${STATUS_META[feature.properties.status]?.label || feature.properties.status}`;
        layer.bindTooltip(tooltip(label), { sticky: true, className: 'land-map__tooltip' });
        layer.on('click', () => callbackRef.current.onSelectPlot?.(feature.id));
        layer.on('add', () => {
          const path = layer.getElement();
          if (!path) return;
          path.setAttribute('tabindex', '0');
          path.setAttribute('role', 'button');
          path.setAttribute('aria-label', label);
          path.dataset.mapFeature = `plot:${feature.id}`;
          path.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              event.stopPropagation();
              callbackRef.current.onSelectPlot?.(feature.id);
            }
          });
        });
        features.set(`plot:${feature.id}`, layer);
      },
    }).addTo(map);
    const reports = L.geoJSON(showReports ? data?.reports || EMPTY : EMPTY, {
      pointToLayer: (feature, latlng) => {
        const selected = matches(selectedId, 'report', feature.id);
        const tone = STATUS_META[feature.properties.status]?.tone || 'yellow';
        return L.marker(latlng, {
          keyboard: true,
          riseOnHover: true,
          zIndexOffset: selected ? 500 : 0,
          icon: L.divIcon({
            className: `land-map__marker land-map__marker--${tone}${selected ? ' is-selected' : ''}${feature.properties.is_overdue ? ' is-overdue' : ''}`,
            html: '<span class="land-map__marker-halo"></span><span class="land-map__marker-core"></span>',
            iconSize: [30, 30],
            iconAnchor: [15, 15],
          }),
        });
      },
      onEachFeature: (feature, layer) => {
        const label = `Обращение ${feature.properties.tracking_number} — ${STATUS_META[feature.properties.status]?.label || feature.properties.status}${feature.properties.is_overdue ? ', просрочено' : ''}`;
        layer.bindTooltip(tooltip(label), {
          direction: 'top',
          offset: [0, -13],
          className: 'land-map__tooltip',
        });
        layer.on('click', () => callbackRef.current.onSelectReport?.(feature.id));
        layer.on('add', () => {
          const marker = layer.getElement();
          marker?.setAttribute('role', 'button');
          marker?.setAttribute('aria-label', label);
          if (marker) marker.dataset.mapFeature = `report:${feature.id}`;
          marker?.addEventListener('keydown', (event) => {
            if (event.key === ' ') {
              event.preventDefault();
              event.stopPropagation();
              callbackRef.current.onSelectReport?.(feature.id);
            }
          });
        });
        features.set(`report:${feature.id}`, layer);
      },
    }).addTo(map);
    featuresRef.current = features;
    if (features.size && !initialFitRef.current) {
      fitFeatures();
      initialFitRef.current = true;
    }
    return () => {
      plots.remove();
      reports.remove();
      featuresRef.current = new Map();
    };
  }, [data, selectedId, showPlots, showReports]);

  useEffect(() => {
    if (!focusId) {
      lastFocusRef.current = null;
      return;
    }
    const key = typeof focusId === 'object' ? `${focusId.type}:${focusId.id}` : focusId;
    if (lastFocusRef.current === key) return;
    const layer =
      featuresRef.current.get(key) ||
      featuresRef.current.get(`report:${key}`) ||
      featuresRef.current.get(`plot:${key}`);
    const map = mapRef.current;
    if (!layer || !map) return;
    const animate = !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (layer.getBounds)
      map.fitBounds(layer.getBounds(), { padding: [80, 80], maxZoom: 16, animate });
    else map.setView(layer.getLatLng(), Math.max(map.getZoom(), 15), { animate });
    lastFocusRef.current = key;
  }, [focusId, data, showPlots, showReports]);

  return (
    <div
      className="land-map"
      role="region"
      aria-label="Интерактивная карта земельных участков и обращений"
    >
      <div className="land-map__canvas" ref={containerRef} />
      <div className="land-map__controls" aria-label="Управление картой">
        <button
          type="button"
          onClick={() => mapRef.current?.zoomIn()}
          aria-label="Приблизить карту"
          title="Приблизить"
        >
          <Plus size={18} />
        </button>
        <button
          type="button"
          onClick={() => mapRef.current?.zoomOut()}
          aria-label="Отдалить карту"
          title="Отдалить"
        >
          <Minus size={18} />
        </button>
        <button
          type="button"
          onClick={fitFeatures}
          aria-label="Показать все видимые объекты"
          title="Показать все объекты"
        >
          <LocateFixed size={18} />
        </button>
      </div>
      {tileError && (
        <div className="land-map__notice" role="status">
          <TriangleAlert size={15} />
          <span>Подложка карты недоступна. Объекты остаются видимыми.</span>
          <button
            type="button"
            onClick={() => {
              setTileError(false);
              tilesRef.current?.redraw();
            }}
          >
            <RefreshCw size={13} />
            Повторить
          </button>
        </div>
      )}
      {!showPlots && !showReports && (
        <div className="land-map__empty" role="status">
          Включите слой участков или обращений
        </div>
      )}
    </div>
  );
}
