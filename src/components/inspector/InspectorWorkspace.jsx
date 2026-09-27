import { useI18n } from '../../i18n/useI18n.js';
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import {
  Layers3,
  ScanLine,
  Radio,
  Check,
  Map,
  List,
  ChartNoAxesCombined,
  RefreshCw,
  Search,
  SlidersHorizontal,
  X,
  Download,
  Plus,
  ArrowUpRight,
  CircleHelp,
  LogOut,
  LoaderCircle,
} from '../icons.jsx';
import useInspectorData, { RESOURCE_LABELS } from '../../hooks/useInspectorData.js';
import { ResourceState, LoginForm } from './InspectorElements.jsx';
import MapPanel from './MapPanel.jsx';
import ReportsTable from './ReportsTable.jsx';
import ReportDrawer from '../ReportDrawer.jsx';
import { dataMode, logout, addDemoReport, resetDemoData } from '../../lib/data-client.js';
import { STATUS_META } from '../../lib/domain.js';
import { filterMonitoringData, visibleFeatureCollection } from '../../lib/monitor-data.js';
const STATUSES = ['NEW', 'INSPECTION', 'VIOLATION', 'IN_PROGRESS', 'RESOLVED'];
const isDemo = dataMode === 'demo';
export default function InspectorWorkspace({ view }) {
  const { t, locale } = useI18n();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const tab =
    view === 'map' ? 'map' : searchParams.get('view') === 'analytics' ? 'analytics' : 'reports';
  const navigateToView = (next) =>
    navigate(
      next === 'map' ? '/map' : next === 'analytics' ? '/reports?view=analytics' : '/reports',
    );
  const {
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
  } = useInspectorData();
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('ALL');
  const [overdueOnly, setOverdueOnly] = useState(false);
  const [showFilters, setShowFilters] = useState(false);
  const [showPlots, setShowPlots] = useState(true);
  const [showReports, setShowReports] = useState(true);
  const [toast, setToast] = useState('');
  const [adding, setAdding] = useState(false);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(''), 4500);
    return () => clearTimeout(timer);
  }, [toast]);

  const filtered = useMemo(
    () => filterMonitoringData(data, { query, status, overdueOnly }),
    [data, query, status, overdueOnly],
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
      navigateToView('map');
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
      <section
        id="workspace"
        className="workspace workspace-page"
        aria-labelledby="workspace-title"
      >
        <div className="section-heading">
          <div>
            <div className="section-kicker">
              <span>01 /</span> {t('РАБОЧЕЕ ПРОСТРАНСТВО')}
            </div>
            <h1 id="workspace-title" className="workspace-title">
              {view === 'map' ? t('Карта земель.') : t('Обращения.')}
              <br />
              <span>
                {view === 'map' ? t('Территория под контролем.') : t('Каждый сигнал важен.')}
              </span>
            </h1>
          </div>
          <div className="workspace-context">
            <div className="demo-label">
              <span className="live-dot" />
              {isDemo ? t('DEMO · ТУРКЕСТАН') : 'DJANGO API'}
            </div>
            <p>
              {isDemo ? (
                <>
                  {t('Вымышленные участки и обращения.')}
                  <br />
                  {t('Данные не являются официальным кадастром.')}
                </>
              ) : (
                <>
                  {t('Карта участков и обращения граждан.')}
                  <br />
                  {t('Обновление каждые 5 секунд.')}
                </>
              )}
            </p>
            {user && (
              <span className="user-label">
                {isDemo ? t(user.username) : user.username}
                {!isDemo && (
                  <button aria-label={t('Выйти из аккаунта')} onClick={signOut}>
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
            {t('Подключаем рабочее пространство…')}
          </div>
        ) : sessionError ? (
          <div className="state-box error-box" role="alert">
            <Radio size={26} />
            <h3>{t('Сервер недоступен')}</h3>
            <p>{t(sessionError)}</p>
            <button className="button" onClick={checkSession}>
              {t('Повторить подключение')} <RefreshCw size={15} />
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
                  label: t('Участков в системе'),
                  tone: 'neutral',
                  icon: <Layers3 size={17} />,
                  filter: 'ALL',
                },
                {
                  key: 'under_inspection',
                  label: t('На проверке'),
                  tone: 'yellow',
                  icon: <ScanLine size={17} />,
                  filter: 'INSPECTION',
                },
                {
                  key: 'active_violations',
                  label: t('Активных нарушений'),
                  tone: 'red',
                  icon: <Radio size={17} />,
                  filter: 'VIOLATION',
                },
                {
                  key: 'resolved',
                  label: t('Обращений закрыто'),
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
              <nav className="view-tabs" aria-label={t('Разделы мониторинга')}>
                {[
                  { id: 'map', label: t('Карта'), icon: Map },
                  { id: 'reports', label: t('Обращения'), icon: List },
                  { id: 'analytics', label: t('Аналитика'), icon: ChartNoAxesCombined },
                ].map(({ id, label, icon: Icon }) => (
                  <Link
                    aria-current={tab === id ? 'page' : undefined}
                    className={tab === id ? 'selected' : ''}
                    key={id}
                    to={
                      id === 'map'
                        ? '/map'
                        : id === 'analytics'
                          ? '/reports?view=analytics'
                          : '/reports'
                    }
                  >
                    <Icon size={16} />
                    <span>{t(label)}</span>
                    {id === 'reports' && (
                      <small>{resources.reports.loaded ? data.reports.length : '—'}</small>
                    )}
                  </Link>
                ))}
              </nav>
              <div className="sync-status">
                <span className={resourceErrors.length ? 'offline-dot' : 'live-dot'} />
                {resourceErrors.length
                  ? t('Часть данных недоступна')
                  : updatedAt
                    ? t('Обновлено в {value0}', {
                        value0: updatedAt.toLocaleTimeString(locale, {
                          hour: '2-digit',
                          minute: '2-digit',
                          second: '2-digit',
                          timeZone: 'Asia/Qyzylorda',
                        }),
                      })
                    : t('Получаем данные')}
                <button
                  className={refreshing ? 'spin' : ''}
                  onClick={refresh}
                  aria-label={t('Обновить данные')}
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
                    placeholder={t('Номер обращения или кадастровый номер')}
                    aria-label={t('Поиск по номеру обращения или кадастровому номеру')}
                  />
                  {query && (
                    <button aria-label={t('Очистить поиск')} onClick={() => setQuery('')}>
                      <X size={15} />
                    </button>
                  )}
                </label>
                <div className="filter-actions">
                  <label className="status-select">
                    <span className="sr-only">{t('Статус обращения')}</span>
                    <select
                      aria-label={t('Статус обращения')}
                      value={status}
                      onChange={(e) => setStatus(e.target.value)}
                    >
                      <option value="ALL">{t('Все статусы')}</option>
                      {STATUSES.map((s) => (
                        <option key={s} value={s}>
                          {t(STATUS_META[s]?.label)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <button
                    className={`icon-button ${showFilters ? 'is-active' : ''}`}
                    aria-label={t('Дополнительные фильтры')}
                    aria-expanded={showFilters}
                    onClick={() => setShowFilters(!showFilters)}
                  >
                    <SlidersHorizontal size={17} />
                  </button>
                  <button
                    className="icon-button export-button"
                    aria-label={t('Скачать видимые объекты GeoJSON')}
                    title={t('Скачать GeoJSON')}
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
                    {t('Только просроченные')}
                  </label>
                  <label>
                    <input
                      type="checkbox"
                      checked={showPlots}
                      onChange={(e) => setShowPlots(e.target.checked)}
                    />
                    {t('Участки на карте')}
                  </label>
                  <label>
                    <input
                      type="checkbox"
                      checked={showReports}
                      onChange={(e) => setShowReports(e.target.checked)}
                    />
                    {t('Обращения на карте')}
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
                    {t('Сбросить')}
                  </button>
                </div>
              )}
              {resourceErrors.map(([key, resource]) => (
                <div className="data-error" role="alert" key={key}>
                  <Radio size={17} />
                  <span>
                    <strong>{t(RESOURCE_LABELS[key])}. </strong>
                    {resource.loaded ? t('Показаны последние загруженные данные. ') : ''}
                    {t(resource.error.message)}
                    {resource.error.requestId ? ` · ${resource.error.requestId}` : ''}
                  </span>
                  <button disabled={resource.loading} onClick={() => refresh({ only: key })}>
                    {t('Повторить')}
                  </button>
                </div>
              ))}
              <div
                id="data-panel"
                role="region"
                aria-label={
                  tab === 'map'
                    ? t('Карта земель')
                    : tab === 'analytics'
                      ? t('Аналитика обращений')
                      : t('Список обращений')
                }
              >
                {tab === 'map' ? (
                  <MapPanel
                    {...{
                      resources,
                      filtered,
                      data,
                      refresh,
                      canShowMap,
                      onMapBoundsChange,
                      selectReport,
                      selectPlot,
                      selection,
                      focusId,
                      showPlots,
                      showReports,
                      isDemo,
                      query,
                      status,
                      overdueOnly,
                    }}
                  />
                ) : !resources.reports.loaded ? (
                  <ResourceState
                    resource={resources.reports}
                    label={t('Обращения')}
                    onRetry={() => refresh({ only: 'reports' })}
                  />
                ) : tab === 'reports' ? (
                  <ReportsTable {...{ filtered, data, resources, selectReport }} />
                ) : (
                  <div className="analytics-panel">
                    <div>
                      <div className="section-kicker">{t('СТАТУСЫ ОБРАЩЕНИЙ')}</div>
                      <h3>{t('От сигнала к результату')}</h3>
                      <p>
                        {t('Распределение обращений по выбранным фильтрам: {count}.', {
                          count: filtered.reports.length,
                        })}
                      </p>
                      <div className="chart-bars">
                        {STATUSES.map((s) => {
                          const count = filtered.reports.filter((r) => r.status === s).length;
                          return (
                            <div className="chart-row" key={s}>
                              <span>{t(STATUS_META[s].label)}</span>
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
                      <h4>{t('Требуют внимания')}</h4>
                      <p>{t('Обращения с истёкшим контрольным сроком среди выбранных данных.')}</p>
                      <button
                        onClick={() => {
                          setOverdueOnly(true);
                          navigateToView('reports');
                          setShowFilters(true);
                        }}
                      >
                        {t('Посмотреть обращения')}
                        <ArrowUpRight size={16} />
                      </button>
                    </div>
                  </div>
                )}
              </div>
              <div className="data-footer">
                <span>
                  <span className="live-dot" />
                  {isDemo ? t('ДЕМО-ДАННЫЕ') : t('ДАННЫЕ API')}
                  <span className="footer-separator">/</span>
                  {t('ОБНОВЛЕНИЕ КАЖДЫЕ 5 СЕК')}
                </span>
                {isDemo && (
                  <button disabled={adding} onClick={demoSignal}>
                    <Plus size={14} />
                    {adding ? t('Добавляем…') : t('Добавить демо-сигнал')}
                  </button>
                )}
              </div>
            </div>
          </>
        )}
      </section>
      <details className="help-details">
        <summary>
          <CircleHelp size={17} />
          {t('О демонстрационном пространстве')}
          <Plus size={17} />
        </summary>
        <div>
          <p>
            {t(
              'В режиме DEMO участки, обращения и иллюстрации вымышлены. Изменения сохраняются только в вашем браузере. «Добавить демо-сигнал» помогает проверить появление нового обращения на карте.',
            )}
          </p>
          <p>
            {t(
              'Рабочая панель поддерживает карту, поиск по кадастровому номеру, фильтры, историю и смену статуса. Для живого пути из Telegram нужно подключить Django API и серверный процесс бота. Участки с фактическими границами отображаются как полигоны; точки не превращаются в границы.',
            )}
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
                setToast(t('Исходные демо-данные восстановлены'));
              } catch (err) {
                setToast(err.message);
              } finally {
                setAdding(false);
              }
            }}
          >
            {t('Восстановить демо-данные')} <RefreshCw size={14} />
          </button>
        )}
      </details>
      {user && selection && (
        <ReportDrawer
          selection={selection}
          onClose={() => setSelection(null)}
          onSaved={async () => {
            await refresh({ force: true });
            setToast(t('Изменения сохранены'));
          }}
          plots={data.plots}
        />
      )}
      {toast && (
        <div className="toast" role="status">
          <Check size={17} />
          {t(toast)}
          <button onClick={() => setToast('')} aria-label={t('Закрыть уведомление')}>
            <X size={15} />
          </button>
        </div>
      )}
    </>
  );
}
