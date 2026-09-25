import { ArrowUpRight, Search } from 'lucide-react';
import { Status } from './InspectorElements.jsx';
import { CATEGORY_LABELS, formatDate } from '../../lib/domain.js';
export default function ReportsTable({ filtered, data, resources, selectReport }) {
  return (
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
                <button className="table-report" onClick={() => selectReport(report.id)}>
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
  );
}
