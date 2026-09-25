import { Link, NavLink } from 'react-router-dom';
import { ArrowUpRight, Layers3 } from 'lucide-react';

const navClass = ({ isActive }) => (isActive ? 'nav-current' : undefined);

export default function Header() {
  return (
    <header className="site-header">
      <Link className="brand" to="/" aria-label="Песок Гос — главная">
        <Layers3 size={29} strokeWidth={1.5} />
        <span>
          песок<span className="brand-dot">.</span>
          <small>ГОС</small>
        </span>
      </Link>
      <nav className="header-nav" aria-label="Основная навигация">
        <NavLink to="/" end className={navClass}>
          Обзор
        </NavLink>
        <NavLink to="/map" className={navClass}>
          Карта земель
        </NavLink>
        <NavLink to="/reports" className={navClass}>
          Обращения
        </NavLink>
      </nav>
      <div className="header-actions">
        <NavLink className="header-register" to="/register">
          Регистрация
        </NavLink>
        <Link className="header-cta" to="/map" aria-label="Открыть панель инспектора">
          <span>Панель инспектора</span>
          <span className="round-icon">
            <ArrowUpRight size={18} />
          </span>
        </Link>
      </div>
    </header>
  );
}
