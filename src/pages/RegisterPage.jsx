import { ArrowUpRight, Layers3, MapPinned } from 'lucide-react';
import { Link } from 'react-router-dom';
import RegisterForm from '../components/auth/RegisterForm.jsx';
import useScrollReveal from '../hooks/useScrollReveal.js';
import '../components/auth/auth.css';

function Contours() {
  return (
    <svg className="auth-contours" viewBox="0 0 540 320" fill="none" aria-hidden="true">
      <g transform="translate(270 166) rotate(-18)">
        {Array.from({ length: 15 }, (_, index) => (
          <path
            key={index}
            d="M-182 25C-198-16-123-38-103-83C-82-126-27-117 10-83C42-54 95-96 140-51C173-18 143 28 102 36C62 43 71 91 22 96C-26 101-27 61-79 72C-128 81-165 69-182 25Z"
            transform={`scale(${0.25 + index * 0.069})`}
            stroke="currentColor"
            strokeWidth="0.8"
          />
        ))}
      </g>
      <circle cx="263" cy="177" r="6" fill="var(--lime)" />
      <circle cx="263" cy="177" r="14" stroke="var(--lime)" opacity="0.35" />
      <path
        d="M263 143V118M263 211V236M229 177H204M297 177H322"
        stroke="var(--lime)"
        opacity="0.45"
      />
    </svg>
  );
}

export default function RegisterPage() {
  const revealRef = useScrollReveal();
  return (
    <section className="register-page" ref={revealRef} aria-labelledby="register-title">
      <div className="register-story" data-reveal>
        <Link className="auth-back" to="/">
          Вернуться к обзору <ArrowUpRight size={15} />
        </Link>
        <div className="auth-story-copy">
          <span className="section-kicker">
            <span className="live-dot" /> ОДНА ЗЕМЛЯ. ОБЩЕЕ БУДУЩЕЕ.
          </span>
          <h1 id="register-title">
            Большие перемены.
            <br />
            <span>С вашего участия.</span>
          </h1>
          <p>
            Внимание к земле начинается с людей.
            <br />
            Станьте частью цифрового мониторинга.
          </p>
        </div>
        <div className="auth-landscape">
          <Contours />
          <span className="auth-landscape-label">
            <MapPinned size={14} /> КАЖДАЯ ТОЧКА ИМЕЕТ ЗНАЧЕНИЕ
          </span>
        </div>
        <div className="auth-story-footer">
          <Layers3 size={20} strokeWidth={1.4} />
          <span>Технологии на стороне земли.</span>
        </div>
      </div>
      <div className="register-form-column" data-reveal style={{ '--reveal-delay': '100ms' }}>
        <RegisterForm />
      </div>
    </section>
  );
}
