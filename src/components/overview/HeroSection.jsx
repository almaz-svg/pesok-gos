import { Link } from 'react-router-dom';
import { ArrowUpRight, ArrowDown, Plus } from 'lucide-react';
import Terrain from '../Terrain.jsx';
export default function HeroSection() {
  return (
    <section className="hero" aria-labelledby="hero-title">
      <div className="hero-ambient" />
      <Terrain />
      <div className="hero-content">
        <div className="eyebrow" data-reveal>
          <span className="live-dot" /> ЦИФРОВОЙ МОНИТОРИНГ ЗЕМЕЛЬ
        </div>
        <h1 id="hero-title" data-reveal style={{ '--reveal-delay': '80ms' }}>
          Земля.
          <br />
          Под защитой<span className="title-dot">.</span>
        </h1>
        <p className="hero-description" data-reveal style={{ '--reveal-delay': '150ms' }}>
          Видеть изменения. Слышать людей.
          <br />
          Сохранять то, что имеет значение.
        </p>
        <div data-reveal style={{ '--reveal-delay': '220ms' }}>
          <Link className="button hero-button" to="/map">
            Открыть карту
            <span className="round-icon">
              <ArrowUpRight size={20} />
            </span>
          </Link>
        </div>
      </div>
      <div className="terrain-coordinate">
        <span className="crosshair">+</span> 43°18′ N &nbsp; 68°16′ E
        <span>ТУРКЕСТАН · ДЕМО-ТЕРРИТОРИЯ</span>
      </div>
      <div className="terrain-label">
        <span className="label-line" />
        <span className="live-dot" /> МОНИТОРИНГ ТЕРРИТОРИИ
      </div>
      <div className="hero-side-note" data-reveal style={{ '--reveal-delay': '180ms' }}>
        <span className="tiny-index">01 / НАБЛЮДЕНИЕ</span>
        <p>
          Каждый сигнал
          <br />
          имеет значение.
        </p>
        <span className="side-note-rule" />
      </div>
      <div className="hero-footer">
        <Link to="/map" className="scroll-cue">
          <span>
            <ArrowDown size={15} />
          </span>
          Исследуйте территорию
        </Link>
        <div className="hero-bottom-nav">
          <Link to="/" className="active" aria-current="page">
            <i />
            Обзор
          </Link>
          <Link to="/map">
            Карта <Plus size={11} />
          </Link>
          <Link to="/reports">
            Обращения <Plus size={11} />
          </Link>
        </div>
        <span className="hero-caption">
          ТЕХНОЛОГИИ НА СТОРОНЕ ЗЕМЛИ <ArrowUpRight size={13} />
        </span>
      </div>
    </section>
  );
}
