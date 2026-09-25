import { useLayoutEffect, useRef } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import Header from './Header.jsx';
import Footer from './Footer.jsx';

const titles = { '/': 'Обзор', '/map': 'Карта земель', '/reports': 'Обращения' };

export default function SiteLayout() {
  const { pathname } = useLocation();
  const mainRef = useRef(null);
  useLayoutEffect(() => {
    document.title = `${titles[pathname.replace(/\/$/, '') || '/'] || 'Страница не найдена'} — Песок Гос`;
    window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
    mainRef.current?.focus({ preventScroll: true });
  }, [pathname]);

  return (
    <>
      <a className="skip-link" href="#main-content">
        Перейти к содержимому
      </a>
      <div className="site-shell">
        <Header />
        <main id="main-content" tabIndex={-1} ref={mainRef}>
          <Outlet />
        </main>
        <Footer />
      </div>
    </>
  );
}
