import { useI18n } from '../../i18n/useI18n.js';
import { useLayoutEffect, useRef } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import Header from './Header.jsx';
import Footer from './Footer.jsx';
import AssistantWidget from '../assistant/AssistantWidget.jsx';

const titles = {
  '/': 'Обзор',
  '/map': 'Карта земель',
  '/reports': 'Обращения',
  '/register': 'Регистрация',
  '/login': 'Вход',
};

export default function SiteLayout() {
  const { t } = useI18n();
  const { pathname, search } = useLocation();
  const mainRef = useRef(null);
  useLayoutEffect(() => {
    const label =
      pathname === '/reports' && new URLSearchParams(search).get('view') === 'analytics'
        ? 'Аналитика'
        : titles[pathname.replace(/\/$/, '') || '/'] || 'Страница не найдена';
    document.title = t('{value0} — Песок Гос', { value0: t(label) });
  }, [pathname, search, t]);
  useLayoutEffect(() => {
    window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
    mainRef.current?.focus({ preventScroll: true });
  }, [pathname]);

  return (
    <>
      <a className="skip-link" href="#main-content">
        {t('Перейти к содержимому')}
      </a>
      <div className="site-shell">
        <Header />
        <main id="main-content" tabIndex={-1} ref={mainRef}>
          <Outlet />
        </main>
        <Footer />
      </div>
      <AssistantWidget />
    </>
  );
}
