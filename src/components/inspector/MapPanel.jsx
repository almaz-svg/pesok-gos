import { Link } from 'react-router-dom';
import { Radio, Search, Check, ArrowUpRight, ArrowRight } from 'lucide-react';
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
              {isDemo ? 'Туркестанская область' : 'Карта мониторинга'}
              <small>{isDemo ? 'ДЕМОНСТРАЦИОННАЯ ЗОНА' : 'ЗЕМЕЛЬНЫЕ УЧАСТКИ'}</small>
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
        <Link className="rail-all" to="/reports">
          Все обращения
          <ArrowRight size={16} />
        </Link>
      </aside>
    </div>
  );
}
