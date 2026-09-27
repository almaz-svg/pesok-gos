import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useI18n } from '../../i18n/useI18n.js';
import { dataMode, login } from '../../lib/data-client.js';
import { authPath, loginErrorMessage, validateLogin } from '../../lib/login-form.js';
import { ArrowUpRight, Eye, EyeOff, Info, LoaderCircle } from '../icons.jsx';
import AuthTabs from './AuthTabs.jsx';

export default function LoginForm({ destination, onLogin }) {
  const { t } = useI18n();
  const [values, setValues] = useState({ username: '', password: '' });
  const [errors, setErrors] = useState({});
  const [formError, setFormError] = useState('');
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const requestRef = useRef(null);
  const errorRef = useRef(null);
  const isDemo = dataMode === 'demo';
  const canSignIn = dataMode === 'api';
  useEffect(() => () => requestRef.current?.abort(), []);
  useEffect(() => {
    if (formError) errorRef.current?.focus();
  }, [formError]);

  async function submit(event) {
    event.preventDefault();
    if (!canSignIn || requestRef.current) return;
    const nextErrors = validateLogin(values);
    setErrors(nextErrors);
    setFormError('');
    const invalid = Object.keys(nextErrors)[0];
    if (invalid) {
      event.currentTarget.elements.namedItem(invalid)?.focus();
      return;
    }
    const controller = new AbortController();
    requestRef.current = controller;
    setBusy(true);
    try {
      const result = await login(values.username.trim(), values.password, {
        signal: controller.signal,
      });
      if (!controller.signal.aborted) {
        setValues((previous) => ({ ...previous, password: '' }));
        onLogin(result.user);
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        setFormError(loginErrorMessage(error));
        setValues((previous) => ({ ...previous, password: '' }));
      }
    } finally {
      if (!controller.signal.aborted) setBusy(false);
      if (requestRef.current === controller) requestRef.current = null;
    }
  }

  function update(name, value) {
    setValues((previous) => ({ ...previous, [name]: value }));
    setErrors((previous) => ({ ...previous, [name]: undefined }));
  }

  return (
    <div className="register-card login-form-card">
      <AuthTabs />
      <div className="register-card-heading">
        <span className="auth-eyebrow">{t('ДОСТУП ИНСПЕКТОРА')}</span>
        <h2 id="login-form-title">{t('Войти в аккаунт')}</h2>
        <p>{t('Используйте учётную запись, выданную администратором.')}</p>
      </div>
      {isDemo && (
        <div className="registration-notice login-demo-notice" id="login-demo-note">
          <Info size={17} />
          <p>
            {t('В деморежиме вход в аккаунт отключён. Демо-панель доступна без логина и пароля.')}
          </p>
        </div>
      )}
      <form
        className="register-form login-form"
        onSubmit={submit}
        noValidate
        aria-labelledby="login-form-title"
        aria-busy={busy}
        aria-describedby={isDemo ? 'login-demo-note' : undefined}
      >
        <fieldset disabled={busy || !canSignIn}>
          <div className="auth-field">
            <label htmlFor="login-username">{t('Логин')}</label>
            <div className={`auth-input-wrap ${errors.username ? 'has-error' : ''}`}>
              <input
                id="login-username"
                name="username"
                autoComplete="username"
                autoCapitalize="none"
                spellCheck={false}
                maxLength={150}
                placeholder={t('Введите логин')}
                value={values.username}
                required
                aria-invalid={Boolean(errors.username)}
                aria-describedby={errors.username ? 'login-username-error' : undefined}
                onChange={(event) => update('username', event.target.value)}
              />
            </div>
            {errors.username && (
              <p className="auth-field-error" id="login-username-error">
                {t(errors.username)}
              </p>
            )}
          </div>
          <div className="auth-field">
            <label htmlFor="login-password">{t('Пароль')}</label>
            <div className={`auth-input-wrap ${errors.password ? 'has-error' : ''}`}>
              <input
                id="login-password"
                name="password"
                type={visible ? 'text' : 'password'}
                autoComplete="current-password"
                maxLength={4096}
                value={values.password}
                required
                placeholder={t('Введите пароль')}
                aria-invalid={Boolean(errors.password)}
                aria-describedby={errors.password ? 'login-password-error' : undefined}
                onChange={(event) => update('password', event.target.value)}
              />
              <button
                type="button"
                className="password-toggle"
                aria-controls="login-password"
                aria-pressed={visible}
                aria-label={t(visible ? 'Скрыть пароль' : 'Показать пароль')}
                onClick={() => setVisible((previous) => !previous)}
              >
                {visible ? <EyeOff size={18} /> : <Eye size={18} />}
              </button>
            </div>
            {errors.password && (
              <p className="auth-field-error" id="login-password-error">
                {t(errors.password)}
              </p>
            )}
          </div>
          <button className="button auth-submit" type="submit">
            {t(busy ? 'Входим…' : 'Войти')}
            {busy ? <LoaderCircle className="spin" size={19} /> : <ArrowUpRight size={19} />}
          </button>
        </fieldset>
        {formError && (
          <p className="auth-field-error login-error" role="alert" ref={errorRef} tabIndex={-1}>
            {t(formError)}
          </p>
        )}
        {!isDemo && !canSignIn && (
          <p className="auth-field-error" role="alert">
            {t('Не удалось подключиться к серверу')}
          </p>
        )}
      </form>
      {isDemo && (
        <Link className="button auth-submit login-demo-link" to={destination}>
          {t('Открыть демо-панель')} <ArrowUpRight size={19} />
        </Link>
      )}
      <p className="auth-signin">
        {t('Нет аккаунта?')}{' '}
        <Link to={authPath('/register', destination)}>
          {t('Регистрация')} <ArrowUpRight size={13} />
        </Link>
      </p>
    </div>
  );
}
