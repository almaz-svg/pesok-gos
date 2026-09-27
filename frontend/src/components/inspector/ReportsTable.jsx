import { useI18n } from '../../i18n/useI18n.js';
import { ArrowUpRight, Search } from '../icons.jsx';
import { Status } from './InspectorElements.jsx';
import { CATEGORY_LABELS, formatDate } from '../../lib/domain.js';
export default function ReportsTable({ filtered, data, resources, selectReport }) {
  const { t } = useI18n();
  return (
    <div className="table-container">
      <table role="table" aria-label={t('Обращения граждан')}>
        <thead role="rowgroup">
          <tr role="row">
            <th scope="col" role="columnheader">
              {t('Обращение / категория')}
            </th>
            <th scope="col" role="columnheader">
              {t('Участок')}
            </th>
            <th scope="col" role="columnheader">
              {t('Статус')}
            </th>
            <th scope="col" role="columnheader">
              {t('Контрольный срок')}
            </th>
            <th scope="col" role="columnheader">
              <span className="sr-only">{t('Открыть')}</span>
            </th>
          </tr>
        </thead>
        <tbody role="rowgroup">
          {filtered.reports.map((report) => (
            <tr key={report.id} role="row">
              <td role="cell">
                <button className="table-report" onClick={() => selectReport(report.id)}>
                  {report.tracking_number}
                  <small>{t(CATEGORY_LABELS[report.category])}</small>
                </button>
              </td>
              <td className="table-plot" data-label={t('Участок')} role="cell">
                {report.plot?.cadastral_number || t('Участок не привязан')}
              </td>
              <td data-label={t('Статус')} role="cell">
                <Status status={report.status} />
              </td>
              <td
                className={report.is_overdue ? 'overdue-date' : ''}
                data-label={t('Контрольный срок')}
                role="cell"
              >
                {report.deadline ? formatDate(report.deadline) : t('Не назначен')}
                {report.is_overdue && <small>{t('Просрочено')}</small>}
              </td>
              <td className="table-open" role="cell">
                <button
                  className="icon-button"
                  aria-label={t('Открыть {value0}', { value0: report.tracking_number })}
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
              ? t('Не удалось обновить список')
              : data.reports.length
                ? t('Нет обращений по выбранным фильтрам')
                : t('Сигналов пока нет')}
          </p>
        </div>
      )}
    </div>
  );
}
