import { Link } from 'react-router-dom';
import { ArrowUpRight } from 'lucide-react';

export default function NotFoundPage() {
  return (
    <section className="state-box not-found-page">
      <span className="section-kicker">404 / СТРАНИЦА НЕ НАЙДЕНА</span>
      <h1>Такой страницы нет</h1>
      <p>Вернитесь к обзору или откройте карту через меню.</p>
      <Link className="button button-lime" to="/">
        На главную <ArrowUpRight size={17} />
      </Link>
    </section>
  );
}
