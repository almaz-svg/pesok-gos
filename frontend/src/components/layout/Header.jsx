import { useI18n } from '../../i18n/useI18n.js';
import { Link, NavLink } from 'react-router-dom';
import { Layers3 } from '../icons.jsx';
import LanguageSwitcher from './LanguageSwitcher.jsx';
import ThemeToggle from './ThemeToggle.jsx';
import TelegramLink from './TelegramLink.jsx';
import './navigation.css';

const navClass = ({ isActive }) => (isActive ? 'nav-current' : undefined);

export default function Header() {
  const { t } = useI18n();
  return (
    <header className="site-header header-localized">
      <Link className="brand" to="/" aria-label={t('Песок Гос — главная')}>
        <Layers3 size={29} />
        <span>
          песок<span className="brand-dot">.</span>
          <small>ГОС</small>
        </span>
      </Link>
      <nav className="header-nav" aria-label={t('Основная навигация')}>
        <NavLink to="/" end className={navClass}>
          {t('Обзор')}
        </NavLink>
        <NavLink to="/map" className={navClass}>
          {t('Карта земель')}
        </NavLink>
        <NavLink to="/reports" className={navClass}>
          {t('Обращения')}
        </NavLink>
      </nav>
      <div className="header-actions">
        <div className="header-preferences">
          <LanguageSwitcher />
          <ThemeToggle />
        </div>
        <TelegramLink className="header-telegram">
          <span>Telegram</span>
        </TelegramLink>
        <NavLink className="header-register" to="/register">
          {t('Регистрация')}
        </NavLink>
        <NavLink className="header-cta header-login" to="/login">
          {t('Войти')}
        </NavLink>
      </div>
    </header>
  );
}
