import { useState } from 'react';
import { Radio, RefreshCw, LoaderCircle, ArrowRight } from 'lucide-react';
import { login } from '../../lib/data-client.js';
import { STATUS_META } from '../../lib/domain.js';
export function ResourceState({ resource, label, onRetry }) {
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

export function Status({ status }) {
  const meta = STATUS_META[status] || { label: status, tone: 'green' };
  return (
    <span className={`status status-${meta.tone}`}>
      <i />
      {meta.label}
    </span>
  );
}

export function LoginForm({ onLogin }) {
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
