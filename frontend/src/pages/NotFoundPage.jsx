import { useI18n } from '../i18n/useI18n.js';
import { Link } from 'react-router-dom';
import { ArrowUpRight } from '../components/icons.jsx';

export default function NotFoundPage() {
  const { t } = useI18n();
  return (
    <section className="state-box not-found-page">
      <span className="section-kicker">{t('404 / СТРАНИЦА НЕ НАЙДЕНА')}</span>
      <h1>{t('Такой страницы нет')}</h1>
      <p>{t('Вернитесь к обзору или откройте карту через меню.')}</p>
      <Link className="button button-lime" to="/">
        {t('На главную')} <ArrowUpRight size={17} />
      </Link>
    </section>
  );
}
