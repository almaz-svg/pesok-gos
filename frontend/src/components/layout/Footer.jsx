import { Link } from 'react-router-dom';
import { ArrowUpRight, Layers3 } from 'lucide-react';

export default function Footer() {
  return (
    <footer className="site-footer">
      <Link className="brand" to="/" aria-label="Песок Гос — главная">
        <Layers3 size={25} strokeWidth={1.5} />
        <span>
          песок<span className="brand-dot">.</span>
          <small>ГОС</small>
        </span>
      </Link>
      <p>Будущее земли начинается с внимания.</p>
      <span>
        ПРОТОТИП · 2026 <ArrowUpRight size={15} />
      </span>
    </footer>
  );
}
