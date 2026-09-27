import { useI18n } from '../../i18n/useI18n.js';
import { Link } from 'react-router-dom';
import { Radio, Search, Check, ArrowUpRight, ArrowRight } from '../icons.jsx';
import LandMap from '../LandMap.jsx';
import { ResourceState, Status } from './InspectorElements.jsx';
import { CATEGORY_LABELS, formatDate } from '../../lib/domain.js';
export default function MapPanel({
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
}) {
  const { t } = useI18n();
  return (
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
              {isDemo ? t('Туркестанская область') : t('Карта мониторинга')}
              <small>{isDemo ? t('ДЕМОНСТРАЦИОННАЯ ЗОНА') : t('ЗЕМЕЛЬНЫЕ УЧАСТКИ')}</small>
            </div>
            {!resources.map.error &&
              !filtered.map.reports.features.length &&
              !filtered.map.plots.features.length && (
                <div className="map-empty">
                  <Search size={22} />
                  <strong>
                    {query || status !== 'ALL' || overdueOnly
                      ? t('Ничего не найдено')
                      : t('Сигналов пока нет')}
                  </strong>
                  <span>
                    {query || status !== 'ALL' || overdueOnly
                      ? t('Попробуйте изменить фильтры')
                      : t('Новые объекты появятся автоматически')}
                  </span>
                </div>
              )}
            <div className="map-legend">
              <span>
                <i className="green-dot" />
                {t('Без нарушений')}
              </span>
              <span>
                <i className="yellow-dot" />
                {t('Проверка')}
              </span>
              <span>
                <i className="red-dot" />
                {t('Нарушение')}
              </span>
            </div>
          </>
        ) : (
          <ResourceState
            resource={resources.map}
            label={t('Карта')}
            onRetry={() => refresh({ only: 'map' })}
          />
        )}
      </div>
      <aside className="reports-rail">
        <div className="rail-heading">
          <div>
            <Radio size={16} />
            <h3>{t('Лента обращений')}</h3>
          </div>
          <span>{resources.reports.loaded ? filtered.reports.length : '—'}</span>
        </div>
        <div className="rail-list">
          {!resources.reports.loaded ? (
            <ResourceState
              resource={resources.reports}
              label={t('Обращения')}
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
                  <h4>{t(CATEGORY_LABELS[report.category])}</h4>
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
                      ? t('Не удалось обновить ленту')
                      : data.reports.length
                        ? t('Нет обращений по выбранным фильтрам')
                        : t('Сигналов пока нет')}
                  </p>
                </div>
              )}
            </>
          )}
        </div>
        <Link className="rail-all" to="/reports">
          {t('Все обращения')}
          <ArrowRight size={16} />
        </Link>
      </aside>
    </div>
  );
}
