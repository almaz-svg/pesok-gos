import { Link, useLocation } from 'react-router-dom';
import { ArrowUpRight, Layers3 } from '../icons.jsx';
import './footer.css';

const links = [
  { to: '/', label: 'Обзор' },
  { to: '/map', label: 'Карта земель' },
  { to: '/reports', label: 'Обращения' },
  { to: '/reports?view=analytics', label: 'Аналитика' },
  { to: '/register', label: 'Регистрация' },
];

export default function Footer() {
  const { pathname, search } = useLocation();
  const currentPage =
    pathname === '/reports' && new URLSearchParams(search).get('view') === 'analytics'
      ? '/reports?view=analytics'
      : pathname;

  return (
    <footer className="site-footer footer-shell">
      <div className="footer-main">
        <div className="footer-intro">
          <Link className="footer-brand" to="/" aria-label="Песок Гос — главная">
            <Layers3 size={30} aria-hidden="true" />
            <span>
              песок<span className="footer-brand-dot">.</span>
              <small>ГОС</small>
            </span>
          </Link>
          <p className="footer-description">
            Цифровой мониторинг земель. Карта участков, обращения и контроль их исполнения в одном
            пространстве.
          </p>
          <span className="footer-motto">Будущее земли начинается с внимания.</span>
        </div>

        <nav className="footer-navigation" aria-label="Навигация в подвале">
          <h2 className="footer-heading">Платформа</h2>
          <ul className="footer-links">
            {links.map(({ to, label }) => (
              <li key={to}>
                <Link to={to} aria-current={currentPage === to ? 'page' : undefined}>
                  <span>{label}</span>
                  <ArrowUpRight size={15} aria-hidden="true" />
                </Link>
              </li>
            ))}
          </ul>
        </nav>

        <div className="footer-explore">
          <span className="footer-eyebrow">Территория в деталях</span>
          <h2 className="footer-explore-title">Начните с карты.</h2>
          <p className="footer-explore-description">
            Найдите участок и посмотрите, какие обращения с ним связаны.
          </p>
          <Link className="footer-map-link" to="/map">
            Открыть карту
            <ArrowUpRight size={19} aria-hidden="true" />
          </Link>
        </div>
      </div>

      <div className="footer-bottom">
        <span className="footer-copyright">© {new Date().getFullYear()} Песок Гос</span>
        <span className="footer-prototype">Демонстрационный прототип</span>
        <span className="footer-signoff">Внимание к земле. Ответственность за результат.</span>
      </div>
    </footer>
  );
}
