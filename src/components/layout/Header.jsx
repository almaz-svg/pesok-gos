import { useI18n } from '../../i18n/useI18n.js';
import { Link, NavLink } from 'react-router-dom';
import { ArrowUpRight, Layers3 } from '../icons.jsx';
import LanguageSwitcher from './LanguageSwitcher.jsx';
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
        <LanguageSwitcher />
        <TelegramLink className="header-telegram">
          <span>Telegram</span>
        </TelegramLink>
        <NavLink className="header-register" to="/register">
          {t('Регистрация')}
        </NavLink>
        <Link className="header-cta" to="/map" aria-label={t('Открыть панель инспектора')}>
          <span>{t('Панель инспектора')}</span>
          <span className="round-icon">
            <ArrowUpRight size={18} />
          </span>
        </Link>
      </div>
    </header>
  );
}
