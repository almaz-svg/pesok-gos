import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowUpRight,
  ArrowDown,
  ArrowRight,
  Layers3,
  Map,
  List,
  ChartNoAxesCombined,
  Search,
  SlidersHorizontal,
  Radio,
  Plus,
  RefreshCw,
  Check,
  X,
  Download,
  MoveUpRight,
  ScanLine,
  CircleHelp,
  LogOut,
  LoaderCircle,
} from 'lucide-react';
import Terrain from './components/Terrain.jsx';
import LandMap from './components/LandMap.jsx';
import ReportDrawer from './components/ReportDrawer.jsx';
import {
  dataMode,
  getMap,
  getReports,
  getPlots,
  getStatistics,
  getSession,
  login,
  logout,
  addDemoReport,
  resetDemoData,
} from './lib/data-client.js';
import { STATUS_META, CATEGORY_LABELS, formatDate } from './lib/domain.js';
import { filterMonitoringData, visibleFeatureCollection } from './lib/monitor-data.js';

const EMPTY_MAP = {
  plots: { type: 'FeatureCollection', features: [] },
  reports: { type: 'FeatureCollection', features: [] },
};
const STATUSES = ['NEW', 'INSPECTION', 'VIOLATION', 'IN_PROGRESS', 'RESOLVED'];
const isDemo = dataMode === 'demo';
const EMPTY_DATA = { map: EMPTY_MAP, reports: [], plots: [], statistics: null };
const LOADERS = { map: getMap, reports: getReports, plots: getPlots, statistics: getStatistics };
const RESOURCE_LABELS = {
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

function ResourceState({ resource, label, onRetry }) {
  return resource.error ? (
    <div className="state-box error-box" role="alert">
      <Radio size={25} />
      <h3>{label}: данные недоступны</h3>
      <p>{resource.error.message}</p>
      <button className="button" disabled={resource.loading} onClick={onRetry}>
        Повторить загрузку <RefreshCw size={15} />
      </button>
    </div>
  ) : (
    <div className="state-box" role="status">
      <LoaderCircle className="spin" size={23} />
      <p>{label}: загружаем данные…</p>
    </div>
  );
}

function Status({ status }) {
  const meta = STATUS_META[status] || { label: status, tone: 'green' };
  return (
    <span className={`status status-${meta.tone}`}>
      <i />
      {meta.label}
    </span>
  );
}

function LoginForm({ onLogin }) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(event) {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    setBusy(true);
    setError('');
    try {
      const result = await login(values.get('username'), values.get('password'));
      onLogin(result.user);
    } catch (err) {
      setError(err.message || 'Не удалось войти. Попробуйте ещё раз.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="login-card">
      <div className="section-kicker">ДОСТУП ИНСПЕКТОРА</div>
      <h3>Войдите в рабочее пространство</h3>
      <p>Используйте учётную запись, выданную администратором.</p>
      <form onSubmit={submit}>
        <label>
          Имя пользователя
          <input name="username" autoComplete="username" required />
        </label>
        <label>
          Пароль
          <input name="password" type="password" autoComplete="current-password" required />
        </label>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <button className="button button-lime" disabled={busy}>
          {busy ? 'Входим…' : 'Войти'}
          <ArrowRight size={17} />
        </button>
      </form>
    </div>
  );
}

export default function App() {
  const [user, setUser] = useState(null);
  const [sessionReady, setSessionReady] = useState(false);
  const [sessionError, setSessionError] = useState('');
  const [data, setData] = useState(EMPTY_DATA);
  const [resources, setResources] = useState(initialResources);
  const [updatedAt, setUpdatedAt] = useState(null);
  const [tab, setTab] = useState('map');
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('ALL');
  const [overdueOnly, setOverdueOnly] = useState(false);
  const [showFilters, setShowFilters] = useState(false);
  const [showPlots, setShowPlots] = useState(true);
  const [showReports, setShowReports] = useState(true);
  const [selection, setSelection] = useState(null);
  const [focusId, setFocusId] = useState(null);
  const [toast, setToast] = useState('');
  const [adding, setAdding] = useState(false);
  const requests = useRef({});
  const retryAt = useRef({});
  const mapBounds = useRef(null);
  const viewportMode = useRef(false);
  const [viewportMap, setViewportMap] = useState(false);
  const workspace = useRef(null);

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
    setSessionReady(false);
    setSessionError('');
    try {
      setUser(await getSession());
    } catch (err) {
      if (err.status === 401) clearInspector();
      else setSessionError(err.message || 'Не удалось подключиться к серверу');
    } finally {
      setSessionReady(true);
    }
  }, [clearInspector]);
  useEffect(() => {
    checkSession();
  }, [checkSession]);

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
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(''), 4500);
    return () => clearTimeout(timer);
  }, [toast]);

  function navigate(next = 'map') {
    setTab(next);
    workspace.current?.scrollIntoView({
      behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
      block: 'start',
    });
  }
  const filtered = useMemo(
    () => filterMonitoringData(data, { query, status, overdueOnly }),
    [data, query, status, overdueOnly],
  );
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
  const selectReport = (id) => {
    setSelection({ type: 'report', id });
    setFocusId(`report:${id}`);
  };
  const selectPlot = (id) => {
    setSelection({ type: 'plot', id });
    setFocusId(`plot:${id}`);
  };
  async function demoSignal() {
    setAdding(true);
    try {
      await addDemoReport();
      await refresh({ force: true });
      setToast('Демо-сигнал добавлен на карту');
      setTab('map');
      setStatus('ALL');
      setQuery('');
      setOverdueOnly(false);
      setShowReports(true);
    } catch (err) {
      setToast(err.message || 'Не удалось добавить сигнал');
    } finally {
      setAdding(false);
    }
  }
  function downloadMap() {
    const content = visibleFeatureCollection(filtered.map, { showPlots, showReports });
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(content, null, 2)], { type: 'application/geo+json' }),
    );
    const link = document.createElement('a');
    link.href = url;
    link.download = `${isDemo ? 'demo-' : ''}pesok-map.geojson`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  async function signOut() {
    try {
      await logout();
      clearInspector();
    } catch (err) {
      if (err.status === 401) clearInspector();
      else setToast(err.message);
    }
  }

  return (
    <>
      <a className="skip-link" href="#workspace">
        Перейти к карте
      </a>
      <div className="site-shell">
        <header className="site-header">
          <a className="brand" href="#" aria-label="Песок Гос — главная">
            <Layers3 size={29} strokeWidth={1.5} />
            <span>
              песок<span className="brand-dot">.</span>
              <small>ГОС</small>
            </span>
          </a>
          <nav className="header-nav" aria-label="Основная навигация">
            <a href="#" className="nav-current">
              Обзор
            </a>
            <a href="#workspace" onClick={() => setTab('map')}>
              Карта земель
            </a>
            <a href="#workspace" onClick={() => setTab('reports')}>
              Обращения
            </a>
          </nav>
          <button
            className="header-cta"
            aria-label="Открыть панель инспектора"
            onClick={() => navigate()}
          >
            <span>Панель инспектора</span>
            <span className="round-icon">
              <ArrowUpRight size={18} />
            </span>
          </button>
        </header>

        <main>
          <section className="hero" aria-labelledby="hero-title">
            <div className="hero-ambient" />
            <Terrain />
            <div className="hero-content">
              <div className="eyebrow">
                <span className="live-dot" /> ЦИФРОВОЙ МОНИТОРИНГ ЗЕМЕЛЬ
              </div>
              <h1 id="hero-title">
                Земля.
                <br />
                Под защитой<span className="title-dot">.</span>
              </h1>
              <p className="hero-description">
                Видеть изменения. Слышать людей.
                <br />
                Сохранять то, что имеет значение.
              </p>
              <button className="button hero-button" onClick={() => navigate()}>
                Открыть карту
                <span className="round-icon">
                  <ArrowUpRight size={20} />
                </span>
              </button>
            </div>
            <div className="terrain-coordinate">
              <span className="crosshair">+</span> 43°18′ N &nbsp; 68°16′ E
              <span>ТУРКЕСТАН · ДЕМО-ТЕРРИТОРИЯ</span>
            </div>
            <div className="terrain-label">
              <span className="label-line" />
              <span className="live-dot" /> МОНИТОРИНГ ТЕРРИТОРИИ
            </div>
            <div className="hero-side-note">
              <span className="tiny-index">01 / НАБЛЮДЕНИЕ</span>
              <p>
                Каждый сигнал
                <br />
                имеет значение.
              </p>
              <span className="side-note-rule" />
            </div>
            <div className="hero-footer">
              <a href="#workspace" onClick={() => setTab('map')} className="scroll-cue">
                <span>
                  <ArrowDown size={15} />
                </span>
                Исследуйте территорию
              </a>
              <div className="hero-bottom-nav">
                <button
                  className="active"
                  onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
                >
                  <i />
                  Обзор
                </button>
                <button onClick={() => navigate('map')}>
                  Карта <Plus size={11} />
                </button>
                <button onClick={() => navigate('reports')}>
                  Обращения <Plus size={11} />
                </button>
              </div>
              <span className="hero-caption">
                ТЕХНОЛОГИИ НА СТОРОНЕ ЗЕМЛИ <ArrowUpRight size={13} />
              </span>
            </div>
          </section>

          <section
            id="workspace"
            className="workspace"
            ref={workspace}
            aria-labelledby="workspace-title"
          >
            <div className="section-heading">
              <div>
                <div className="section-kicker">
                  <span>01 /</span> РАБОЧЕЕ ПРОСТРАНСТВО
                </div>
                <h2 id="workspace-title">
                  Вся территория.
                  <br />
                  <span>Одна картина.</span>
                </h2>
              </div>
              <div className="workspace-context">
                <div className="demo-label">
                  <span className="live-dot" />
                  {isDemo ? 'DEMO · ТУРКЕСТАН' : 'DJANGO API'}
                </div>
                <p>
                  {isDemo ? (
                    <>
                      Вымышленные участки и обращения.
                      <br />
                      Данные не являются официальным кадастром.
                    </>
                  ) : (
                    <>
                      Карта участков и обращения граждан.
                      <br />
                      Обновление каждые 5 секунд.
                    </>
                  )}
                </p>
                {user && (
                  <span className="user-label">
                    {user.username}
                    {!isDemo && (
                      <button aria-label="Выйти из аккаунта" onClick={signOut}>
                        <LogOut size={14} />
                      </button>
                    )}
                  </span>
                )}
              </div>
            </div>
            {!sessionReady ? (
              <div className="state-box">
                <LoaderCircle className="spin" size={23} />
                Подключаем рабочее пространство…
              </div>
            ) : sessionError ? (
              <div className="state-box error-box" role="alert">
                <Radio size={26} />
                <h3>Сервер недоступен</h3>
                <p>{sessionError}</p>
                <button className="button" onClick={checkSession}>
                  Повторить подключение <RefreshCw size={15} />
                </button>
              </div>
            ) : !user ? (
              <LoginForm onLogin={setUser} />
            ) : (
              <>
                <div className="stat-grid" aria-busy={resources.statistics.loading}>
                  {[
                    {
                      key: 'total_plots',
                      label: 'Участков в системе',
                      tone: 'neutral',
                      icon: <Layers3 size={17} />,
                      filter: 'ALL',
                    },
                    {
                      key: 'under_inspection',
                      label: 'На проверке',
                      tone: 'yellow',
                      icon: <ScanLine size={17} />,
                      filter: 'INSPECTION',
                    },
                    {
                      key: 'active_violations',
                      label: 'Активных нарушений',
                      tone: 'red',
                      icon: <Radio size={17} />,
                      filter: 'VIOLATION',
                    },
                    {
                      key: 'resolved',
                      label: 'Обращений закрыто',
                      tone: 'green',
                      icon: <Check size={18} />,
                      filter: 'RESOLVED',
                    },
                  ].map((item, index) => (
                    <div className={`stat-item stat-${item.tone}`} key={item.key}>
                      <div className="stat-top">
                        <span>{item.label}</span>
                        {item.icon}
                      </div>
                      <div className="stat-bottom">
                        <strong>
                          {statistics ? String(statistics[item.key]).padStart(2, '0') : '—'}
                        </strong>
                        <span>
                          {String(index + 1).padStart(2, '0')} <span className="stat-dash">/</span>
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
                <div className="monitor-toolbar">
                  <div className="view-tabs" role="tablist" aria-label="Представление данных">
                    {[
                      { id: 'map', label: 'Карта', icon: Map },
                      { id: 'reports', label: 'Обращения', icon: List },
                      { id: 'analytics', label: 'Аналитика', icon: ChartNoAxesCombined },
                    ].map(({ id, label, icon: Icon }) => (
                      <button
                        id={`tab-${id}`}
                        role="tab"
                        aria-selected={tab === id}
                        aria-controls="data-panel"
                        className={tab === id ? 'selected' : ''}
                        key={id}
                        onClick={() => setTab(id)}
                      >
                        <Icon size={16} />
                        <span>{label}</span>
                        {id === 'reports' && (
                          <small>{resources.reports.loaded ? data.reports.length : '—'}</small>
                        )}
                      </button>
                    ))}
                  </div>
                  <div className="sync-status">
                    <span className={resourceErrors.length ? 'offline-dot' : 'live-dot'} />
                    {resourceErrors.length
                      ? 'Часть данных недоступна'
                      : updatedAt
                        ? `Обновлено в ${updatedAt.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: 'Asia/Qyzylorda' })}`
                        : 'Получаем данные'}
                    <button
                      className={refreshing ? 'spin' : ''}
                      onClick={refresh}
                      aria-label="Обновить данные"
                      disabled={refreshing}
                    >
                      <RefreshCw size={14} />
                    </button>
                  </div>
                </div>
                <div className="data-surface">
                  <div className="filter-toolbar">
                    <label className="search-field">
                      <Search size={18} />
                      <input
                        type="search"
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                        placeholder="Номер обращения или кадастровый номер"
                        aria-label="Поиск по номеру обращения или кадастровому номеру"
                      />
                      {query && (
                        <button aria-label="Очистить поиск" onClick={() => setQuery('')}>
                          <X size={15} />
                        </button>
                      )}
                    </label>
                    <div className="filter-actions">
                      <label className="status-select">
                        <span className="sr-only">Статус обращения</span>
                        <select
                          aria-label="Статус обращения"
                          value={status}
                          onChange={(e) => setStatus(e.target.value)}
                        >
                          <option value="ALL">Все статусы</option>
                          {STATUSES.map((s) => (
                            <option key={s} value={s}>
                              {STATUS_META[s]?.label}
                            </option>
                          ))}
                        </select>
                      </label>
                      <button
                        className={`icon-button ${showFilters ? 'is-active' : ''}`}
                        aria-label="Дополнительные фильтры"
                        aria-expanded={showFilters}
                        onClick={() => setShowFilters(!showFilters)}
                      >
                        <SlidersHorizontal size={17} />
                      </button>
                      <button
                        className="icon-button export-button"
                        aria-label="Скачать видимые объекты GeoJSON"
                        title="Скачать GeoJSON"
                        onClick={downloadMap}
                        disabled={!resources.map.loaded}
                      >
                        <Download size={17} />
                      </button>
                    </div>
                  </div>
                  {showFilters && (
                    <div className="extra-filters">
                      <label>
                        <input
                          type="checkbox"
                          checked={overdueOnly}
                          onChange={(e) => setOverdueOnly(e.target.checked)}
                        />
                        Только просроченные
                      </label>
                      <label>
                        <input
                          type="checkbox"
                          checked={showPlots}
                          onChange={(e) => setShowPlots(e.target.checked)}
                        />
                        Участки на карте
                      </label>
                      <label>
                        <input
                          type="checkbox"
                          checked={showReports}
                          onChange={(e) => setShowReports(e.target.checked)}
                        />
                        Обращения на карте
                      </label>
                      <button
                        onClick={() => {
                          setStatus('ALL');
                          setQuery('');
                          setOverdueOnly(false);
                          setShowPlots(true);
                          setShowReports(true);
                        }}
                      >
                        Сбросить
                      </button>
                    </div>
                  )}
                  {resourceErrors.map(([key, resource]) => (
                    <div className="data-error" role="alert" key={key}>
                      <Radio size={17} />
                      <span>
                        <strong>{RESOURCE_LABELS[key]}. </strong>
                        {resource.loaded ? 'Показаны последние загруженные данные. ' : ''}
                        {resource.error.message}
                        {resource.error.requestId ? ` · ${resource.error.requestId}` : ''}
                      </span>
                      <button disabled={resource.loading} onClick={() => refresh({ only: key })}>
                        Повторить
                      </button>
                    </div>
                  ))}
                  <div id="data-panel" role="tabpanel" aria-labelledby={`tab-${tab}`}>
                    {tab === 'map' ? (
                      <div className="map-layout">
                        <div className="map-frame">
                          {canShowMap ? (
                            <>
                              <LandMap
                                onBoundsChange={onMapBoundsChange}
                                data={filtered.map}
                                onSelectReport={selectReport}
                                onSelectPlot={selectPlot}
                                selectedId={selection ? `${selection.type}:${selection.id}` : null}
                                focusId={focusId}
                                showPlots={showPlots}
                                showReports={showReports}
                              />
                              <div className="map-location">
                                <span className="live-dot" />
                                {isDemo ? 'Туркестанская область' : 'Карта мониторинга'}
                                <small>
                                  {isDemo ? 'ДЕМОНСТРАЦИОННАЯ ЗОНА' : 'ЗЕМЕЛЬНЫЕ УЧАСТКИ'}
                                </small>
                              </div>
                              {!resources.map.error &&
                                !filtered.map.reports.features.length &&
                                !filtered.map.plots.features.length && (
                                  <div className="map-empty">
                                    <Search size={22} />
                                    <strong>
                                      {query || status !== 'ALL' || overdueOnly
                                        ? 'Ничего не найдено'
                                        : 'Сигналов пока нет'}
                                    </strong>
                                    <span>
                                      {query || status !== 'ALL' || overdueOnly
                                        ? 'Попробуйте изменить фильтры'
                                        : 'Новые объекты появятся автоматически'}
                                    </span>
                                  </div>
                                )}
                              <div className="map-legend">
                                <span>
                                  <i className="green-dot" />
                                  Без нарушений
                                </span>
                                <span>
                                  <i className="yellow-dot" />
                                  Проверка
                                </span>
                                <span>
                                  <i className="red-dot" />
                                  Нарушение
                                </span>
                              </div>
                            </>
                          ) : (
                            <ResourceState
                              resource={resources.map}
                              label="Карта"
                              onRetry={() => refresh({ only: 'map' })}
                            />
                          )}
                        </div>
                        <aside className="reports-rail">
                          <div className="rail-heading">
                            <div>
                              <Radio size={16} />
                              <h3>Лента обращений</h3>
                            </div>
                            <span>{resources.reports.loaded ? filtered.reports.length : '—'}</span>
                          </div>
                          <div className="rail-list">
                            {!resources.reports.loaded ? (
                              <ResourceState
                                resource={resources.reports}
                                label="Обращения"
                                onRetry={() => refresh({ only: 'reports' })}
                              />
                            ) : (
                              <>
                                {filtered.reports.slice(0, 5).map((report) => (
                                  <button
                                    className={`report-preview ${selection?.id === report.id ? 'preview-selected' : ''}`}
                                    key={report.id}
                                    onClick={() => selectReport(report.id)}
                                  >
                                    <div className="preview-top">
                                      <span>{report.tracking_number}</span>
                                      <ArrowUpRight size={15} />
                                    </div>
                                    <h4>{CATEGORY_LABELS[report.category]}</h4>
                                    <p>{report.description}</p>
                                    <div className="preview-bottom">
                                      <Status status={report.status} />
                                      <span>{formatDate(report.created_at)}</span>
                                    </div>
                                  </button>
                                ))}
                                {!filtered.reports.length && (
                                  <div className="rail-empty">
                                    <Check size={25} />
                                    <p>
                                      {resources.reports.error
                                        ? 'Не удалось обновить ленту'
                                        : data.reports.length
                                          ? 'Нет обращений по выбранным фильтрам'
                                          : 'Сигналов пока нет'}
                                    </p>
                                  </div>
                                )}
                              </>
                            )}
                          </div>
                          <button className="rail-all" onClick={() => setTab('reports')}>
                            Все обращения
                            <ArrowRight size={16} />
                          </button>
                        </aside>
                      </div>
                    ) : !resources.reports.loaded ? (
                      <ResourceState
                        resource={resources.reports}
                        label="Обращения"
                        onRetry={() => refresh({ only: 'reports' })}
                      />
                    ) : tab === 'reports' ? (
                      <div className="table-container">
                        <table>
                          <thead>
                            <tr>
                              <th>Обращение / категория</th>
                              <th>Участок</th>
                              <th>Статус</th>
                              <th>Контрольный срок</th>
                              <th>
                                <span className="sr-only">Открыть</span>
                              </th>
                            </tr>
                          </thead>
                          <tbody>
                            {filtered.reports.map((report) => (
                              <tr key={report.id}>
                                <td>
                                  <button
                                    className="table-report"
                                    onClick={() => selectReport(report.id)}
                                  >
                                    {report.tracking_number}
                                    <small>{CATEGORY_LABELS[report.category]}</small>
                                  </button>
                                </td>
                                <td className="table-plot">
                                  {report.plot?.cadastral_number || 'Участок не привязан'}
                                </td>
                                <td>
                                  <Status status={report.status} />
                                </td>
                                <td className={report.is_overdue ? 'overdue-date' : ''}>
                                  {report.deadline ? formatDate(report.deadline) : 'Не назначен'}
                                  {report.is_overdue && <small>Просрочено</small>}
                                </td>
                                <td>
                                  <button
                                    className="icon-button"
                                    aria-label={`Открыть ${report.tracking_number}`}
                                    onClick={() => selectReport(report.id)}
                                  >
                                    <ArrowUpRight size={18} />
                                  </button>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                        {!filtered.reports.length && (
                          <div className="state-box">
                            <Search size={24} />
                            <p>
                              {resources.reports.error
                                ? 'Не удалось обновить список'
                                : data.reports.length
                                  ? 'Нет обращений по выбранным фильтрам'
                                  : 'Сигналов пока нет'}
                            </p>
                          </div>
                        )}
                      </div>
                    ) : (
                      <div className="analytics-panel">
                        <div>
                          <div className="section-kicker">СТАТУСЫ ОБРАЩЕНИЙ</div>
                          <h3>От сигнала к результату</h3>
                          <p>
                            Распределение {filtered.reports.length} обращений по выбранным фильтрам.
                          </p>
                          <div className="chart-bars">
                            {STATUSES.map((s) => {
                              const count = filtered.reports.filter((r) => r.status === s).length;
                              return (
                                <div className="chart-row" key={s}>
                                  <span>{STATUS_META[s].label}</span>
                                  <div>
                                    <i
                                      style={{
                                        width: `${filtered.reports.length ? (count / filtered.reports.length) * 100 : 0}%`,
                                        background: STATUS_META[s].color,
                                      }}
                                    />
                                  </div>
                                  <strong>{count}</strong>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                        <div className="analytics-callout">
                          <ScanLine size={30} />
                          <strong>{filtered.reports.filter((r) => r.is_overdue).length}</strong>
                          <h4>Требуют внимания</h4>
                          <p>Обращения с истёкшим контрольным сроком среди выбранных данных.</p>
                          <button
                            onClick={() => {
                              setOverdueOnly(true);
                              setTab('reports');
                              setShowFilters(true);
                            }}
                          >
                            Посмотреть обращения
                            <ArrowUpRight size={16} />
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                  <div className="data-footer">
                    <span>
                      <span className="live-dot" />
                      {isDemo ? 'ДЕМО-ДАННЫЕ' : 'ДАННЫЕ API'}
                      <span className="footer-separator">/</span>ОБНОВЛЕНИЕ КАЖДЫЕ 5 СЕК
                    </span>
                    {isDemo && (
                      <button disabled={adding} onClick={demoSignal}>
                        <Plus size={14} />
                        {adding ? 'Добавляем…' : 'Добавить демо-сигнал'}
                      </button>
                    )}
                  </div>
                </div>
              </>
            )}
          </section>

          <section className="process-section" aria-labelledby="process-title">
            <div className="process-intro">
              <div className="section-kicker">
                <span>02 /</span> КАК ЭТО РАБОТАЕТ
              </div>
              <h2 id="process-title">
                Ближе к земле.
                <br />
                <span>Ближе к людям.</span>
              </h2>
              <a href="#workspace" onClick={() => setTab('reports')}>
                Перейти к обращениям
                <MoveUpRight size={17} />
              </a>
            </div>
            <div className="process-steps">
              {[
                {
                  n: '01',
                  title: 'Замечено.',
                  text: 'Гражданин отправляет геолокацию, фото и описание проблемы через Telegram.',
                  tone: 'yellow',
                  icon: Radio,
                },
                {
                  n: '02',
                  title: 'Проверено.',
                  text: 'Инспектор изучает сигнал на карте, фиксирует результат и назначает контрольный срок.',
                  tone: 'red',
                  icon: ScanLine,
                },
                {
                  n: '03',
                  title: 'Решено.',
                  text: 'Статус обращения меняется. Вся история работы остаётся в карточке.',
                  tone: 'green',
                  icon: Check,
                },
              ].map(({ n, title, text, tone, icon: Icon }) => (
                <div className={`process-step process-${tone}`} key={n}>
                  <div className="process-step-top">
                    <span>{n}</span>
                    <Icon size={21} strokeWidth={1.4} />
                  </div>
                  <h3>{title}</h3>
                  <p>{text}</p>
                </div>
              ))}
            </div>
          </section>
          <details className="help-details">
            <summary>
              <CircleHelp size={17} />О демонстрационном пространстве
              <Plus size={17} />
            </summary>
            <div>
              <p>
                В режиме DEMO участки, обращения и иллюстрации вымышлены. Изменения сохраняются
                только в вашем браузере. «Добавить демо-сигнал» помогает проверить появление нового
                обращения на карте.
              </p>
              <p>
                Рабочая панель поддерживает карту, поиск по кадастровому номеру, фильтры, историю и
                смену статуса. Для живого пути из Telegram нужно подключить Django API и серверный
                процесс бота. Участки с фактическими границами отображаются как полигоны; точки не
                превращаются в границы.
              </p>
            </div>
            {isDemo && user && (
              <button
                className="button demo-reset"
                disabled={adding}
                onClick={async () => {
                  setAdding(true);
                  try {
                    await resetDemoData();
                    setSelection(null);
                    setFocusId(null);
                    setQuery('');
                    setStatus('ALL');
                    setOverdueOnly(false);
                    await refresh({ force: true });
                    setToast('Исходные демо-данные восстановлены');
                  } catch (err) {
                    setToast(err.message);
                  } finally {
                    setAdding(false);
                  }
                }}
              >
                Восстановить демо-данные <RefreshCw size={14} />
              </button>
            )}
          </details>
        </main>
        <footer className="site-footer">
          <a className="brand" href="#">
            <Layers3 size={25} strokeWidth={1.5} />
            <span>
              песок<span className="brand-dot">.</span>
              <small>ГОС</small>
            </span>
          </a>
          <p>Будущее земли начинается с внимания.</p>
          <span>
            ПРОТОТИП · 2026 <ArrowUpRight size={15} />
          </span>
        </footer>
      </div>
      {user && selection && (
        <ReportDrawer
          selection={selection}
          onClose={() => setSelection(null)}
          onSaved={async () => {
            await refresh({ force: true });
            setToast('Изменения сохранены');
          }}
          plots={data.plots}
        />
      )}
      {toast && (
        <div className="toast" role="status">
          <Check size={17} />
          {toast}
          <button onClick={() => setToast('')} aria-label="Закрыть уведомление">
            <X size={15} />
          </button>
        </div>
      )}
    </>
  );
}
