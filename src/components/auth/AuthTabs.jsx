import { NavLink, useSearchParams } from 'react-router-dom';
import { useI18n } from '../../i18n/useI18n.js';
import { authPath } from '../../lib/login-form.js';

export default function AuthTabs() {
  const { t } = useI18n();
  const [params] = useSearchParams();
  return (
    <nav className="auth-tabs" aria-label={t('Вход и регистрация')}>
      <NavLink to={authPath('/login', params.get('next'))}>{t('Войти')}</NavLink>
      <NavLink to={authPath('/register', params.get('next'))}>{t('Регистрация')}</NavLink>
    </nav>
  );
}
