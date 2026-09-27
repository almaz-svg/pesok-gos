import { useI18n } from '../../i18n/useI18n.js';

import { Radio, RefreshCw, LoaderCircle } from '../icons.jsx';

import { STATUS_META } from '../../lib/domain.js';
export function ResourceState({ resource, label, onRetry }) {
  const { t } = useI18n();
  return resource.error ? (
    <div className="state-box error-box" role="alert">
      <Radio size={25} />
      <h3>{t('{label}: данные недоступны', { label: t(label) })}</h3>
      <p>{t(resource.error.message)}</p>
      <button className="button" disabled={resource.loading} onClick={onRetry}>
        {t('Повторить загрузку')} <RefreshCw size={15} />
      </button>
    </div>
  ) : (
    <div className="state-box" role="status">
      <LoaderCircle className="spin" size={23} />
      <p>{t('{label}: загружаем данные…', { label: t(label) })}</p>
    </div>
  );
}

export function Status({ status }) {
  const { t } = useI18n();
  const meta = STATUS_META[status] || { label: status, tone: 'green' };
  return (
    <span className={`status status-${meta.tone}`}>
      <i />
      {t(meta.label)}
    </span>
  );
}
