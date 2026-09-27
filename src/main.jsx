import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import '@fontsource-variable/inter';
import 'leaflet/dist/leaflet.css';
import App from './App.jsx';
import './styles.css';
import './routing.css';
import './motion.css';
import './responsive.css';
import { useI18n } from './i18n/useI18n.js';

function FatalError() {
  const { t } = useI18n();
  return (
    <main className="fatal-error">
      <h1>{t('Не удалось открыть панель')}</h1>
      <p>{t('Обновите страницу, чтобы повторить загрузку.')}</p>
      <button onClick={() => window.location.reload()}>{t('Обновить страницу')}</button>
    </main>
  );
}

class ErrorBoundary extends React.Component {
  state = { error: null };
  static getDerivedStateFromError(error) {
    return { error };
  }
  render() {
    if (this.state.error) return <FatalError />;
    return this.props.children;
  }
}

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ErrorBoundary>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </ErrorBoundary>
  </React.StrictMode>,
);
