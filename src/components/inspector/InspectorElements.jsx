import { useI18n } from '../../i18n/useI18n.js';
import { useState } from 'react';
import { Radio, RefreshCw, LoaderCircle, ArrowRight } from '../icons.jsx';
import { login } from '../../lib/data-client.js';
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

export function LoginForm({ onLogin }) {
  const { t } = useI18n();
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
      <div className="section-kicker">{t('ДОСТУП ИНСПЕКТОРА')}</div>
      <h3>{t('Войдите в рабочее пространство')}</h3>
      <p>{t('Используйте учётную запись, выданную администратором.')}</p>
      <form onSubmit={submit}>
        <label>
          {t('Имя пользователя')}
          <input name="username" autoComplete="username" required />
        </label>
        <label>
          {t('Пароль')}
          <input name="password" type="password" autoComplete="current-password" required />
        </label>
        {error && (
          <p className="form-error" role="alert">
            {t(error)}
          </p>
        )}
        <button className="button button-lime" disabled={busy}>
          {busy ? t('Входим…') : t('Войти')}
          <ArrowRight size={17} />
        </button>
      </form>
    </div>
  );
}
