import { useCallback, useEffect, useRef, useState } from 'react';
import { getMap, getReports, getPlots, getStatistics, getSession } from '../lib/data-client.js';
const EMPTY_MAP = {
  plots: { type: 'FeatureCollection', features: [] },
  reports: { type: 'FeatureCollection', features: [] },
};
const EMPTY_DATA = { map: EMPTY_MAP, reports: [], plots: [], statistics: null };
const LOADERS = { map: getMap, reports: getReports, plots: getPlots, statistics: getStatistics };
export const RESOURCE_LABELS = {
  map: 'Карта',
  reports: 'Обращения',
  plots: 'Участки',
  statistics: 'Статистика',
};
const initialResources = () =>
  Object.fromEntries(
    Object.keys(LOADERS).map((key) => [
      key,
      { loaded: false, loading: false, error: null, updatedAt: null },
    ]),
  );

export default function useInspectorData() {
  const [user, setUser] = useState(null);
  const [sessionReady, setSessionReady] = useState(false);
  const [sessionError, setSessionError] = useState('');
  const [data, setData] = useState(EMPTY_DATA);
  const [resources, setResources] = useState(initialResources);
  const [updatedAt, setUpdatedAt] = useState(null);

  const [selection, setSelection] = useState(null);
  const [focusId, setFocusId] = useState(null);
  const requests = useRef({});
  const sessionRequest = useRef(null);
  const retryAt = useRef({});
  const mapBounds = useRef(null);
  const viewportMode = useRef(false);
  const [viewportMap, setViewportMap] = useState(false);
  const cancelRequests = useCallback(() => {
    Object.values(requests.current).forEach((controller) => controller.abort());
    requests.current = {};
  }, []);
  const clearInspector = useCallback(() => {
    cancelRequests();
    retryAt.current = {};
    mapBounds.current = null;
    viewportMode.current = false;
    setViewportMap(false);
    setUser(null);
    setSelection(null);
    setFocusId(null);
    setData(EMPTY_DATA);
    setResources(initialResources());
    setUpdatedAt(null);
  }, [cancelRequests]);

  const checkSession = useCallback(async () => {
    sessionRequest.current?.abort();
    const controller = new AbortController();
    sessionRequest.current = controller;
    setSessionReady(false);
    setSessionError('');
    try {
      const session = await getSession({ signal: controller.signal });
      if (!controller.signal.aborted) setUser(session);
    } catch (err) {
      if (controller.signal.aborted || err.name === 'AbortError') return;
      if (err.status === 401) clearInspector();
      else setSessionError(err.message || 'Не удалось подключиться к серверу');
    } finally {
      if (!controller.signal.aborted) setSessionReady(true);
      if (sessionRequest.current === controller) sessionRequest.current = null;
    }
  }, [clearInspector]);
  useEffect(() => {
    checkSession();
    return () => {
      sessionRequest.current?.abort();
      cancelRequests();
    };
  }, [checkSession, cancelRequests]);

  const refresh = useCallback(
    async ({ force = false, only = null } = {}) => {
      await Promise.all(
        (only ? [only] : Object.keys(LOADERS)).map(async (key) => {
          // A slow resource must finish; polling never repeatedly cancels it.
          if ((retryAt.current[key] || 0) > Date.now()) return;
          if (requests.current[key]) {
            if (!force) return;
            requests.current[key].abort();
          }
          const controller = new AbortController();
          requests.current[key] = controller;
          setResources((previous) => ({ ...previous, [key]: { ...previous[key], loading: true } }));
          try {
            const result = await LOADERS[key]({
              signal: controller.signal,
              ...(key === 'map' && viewportMode.current && mapBounds.current
                ? { bbox: mapBounds.current }
                : {}),
            });
            if (controller.signal.aborted || requests.current[key] !== controller) return;
            const receivedAt = new Date();
            setData((previous) => ({ ...previous, [key]: result }));
            setResources((previous) => ({
              ...previous,
              [key]: { loaded: true, loading: false, error: null, updatedAt: receivedAt },
            }));
            setUpdatedAt(receivedAt);
            delete retryAt.current[key];
          } catch (err) {
            if (
              controller.signal.aborted ||
              requests.current[key] !== controller ||
              err.name === 'AbortError'
            )
              return;
            if (err.status === 401) {
              clearInspector();
              return;
            }
            if (err.retryAfter) retryAt.current[key] = Date.now() + err.retryAfter * 1000;
            if (key === 'map' && err.code === 'map_limit_exceeded') {
              viewportMode.current = true;
              setViewportMap(true);
            }
            setResources((previous) => ({
              ...previous,
              [key]: { ...previous[key], loading: false, error: err },
            }));
          } finally {
            if (requests.current[key] === controller) delete requests.current[key];
          }
        }),
      );
    },
    [clearInspector],
  );

  useEffect(() => {
    if (!user) return;
    refresh();
    const interval = setInterval(() => {
      if (!document.hidden) refresh();
    }, 5000);
    const onVisible = () => {
      if (!document.hidden) refresh();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisible);
      cancelRequests();
    };
  }, [user, refresh, cancelRequests]);

  const statistics = data.statistics;
  const resourceErrors = Object.entries(resources).filter(([, resource]) => resource.error);
  const refreshing = Object.values(resources).some((resource) => resource.loading);
  const hasMapFeatures = data.map.plots.features.length > 0 || data.map.reports.features.length > 0;
  const canShowMap =
    viewportMap || (resources.map.loaded && (!resources.map.error || hasMapFeatures));
  const onMapBoundsChange = useCallback(
    (bounds) => {
      mapBounds.current = bounds;
      if (viewportMode.current) refresh({ only: 'map', force: true });
    },
    [refresh],
  );

  return {
    user,
    setUser,
    sessionReady,
    sessionError,
    checkSession,
    clearInspector,
    data,
    resources,
    updatedAt,
    refresh,
    selection,
    setSelection,
    focusId,
    setFocusId,
    statistics,
    resourceErrors,
    refreshing,
    canShowMap,
    onMapBoundsChange,
  };
}
