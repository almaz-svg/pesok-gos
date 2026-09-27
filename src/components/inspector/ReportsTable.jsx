import { ArrowUpRight, Search } from 'lucide-react';
import { Status } from './InspectorElements.jsx';
import { CATEGORY_LABELS, formatDate } from '../../lib/domain.js';
export default function ReportsTable({ filtered, data, resources, selectReport }) {
  return (
    <div className="table-container">
      <table role="table" aria-label="Обращения граждан">
        <thead role="rowgroup">
          <tr role="row">
            <th scope="col" role="columnheader">
              Обращение / категория
            </th>
            <th scope="col" role="columnheader">
              Участок
            </th>
            <th scope="col" role="columnheader">
              Статус
            </th>
            <th scope="col" role="columnheader">
              Контрольный срок
            </th>
            <th scope="col" role="columnheader">
              <span className="sr-only">Открыть</span>
            </th>
          </tr>
        </thead>
        <tbody role="rowgroup">
          {filtered.reports.map((report) => (
            <tr key={report.id} role="row">
              <td role="cell">
                <button className="table-report" onClick={() => selectReport(report.id)}>
                  {report.tracking_number}
                  <small>{CATEGORY_LABELS[report.category]}</small>
                </button>
              </td>
              <td className="table-plot" data-label="Участок" role="cell">
                {report.plot?.cadastral_number || 'Участок не привязан'}
              </td>
              <td data-label="Статус" role="cell">
                <Status status={report.status} />
              </td>
              <td
                className={report.is_overdue ? 'overdue-date' : ''}
                data-label="Контрольный срок"
                role="cell"
              >
                {report.deadline ? formatDate(report.deadline) : 'Не назначен'}
                {report.is_overdue && <small>Просрочено</small>}
              </td>
              <td className="table-open" role="cell">
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
  );
}
