import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useI18n } from '../i18n/useI18n.js';
import useScrollReveal from '../hooks/useScrollReveal.js';
import { loginDestination } from '../lib/login-form.js';
import LoginForm from '../components/auth/LoginForm.jsx';
import { ArrowUpRight, Layers3, MapPinned } from '../components/icons.jsx';
import '../components/auth/auth.css';

export default function LoginPage() {
  const { t } = useI18n();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const revealRef = useScrollReveal();
  const destination = loginDestination(params.get('next'));
  return (
    <section className="register-page login-page" ref={revealRef} aria-labelledby="login-title">
      <div className="register-story" data-reveal>
        <Link className="auth-back" to="/">
          {t('Вернуться к обзору')} <ArrowUpRight size={15} />
        </Link>
        <div className="auth-story-copy">
          <span className="section-kicker">
            <span className="live-dot" /> {t('ДОСТУП ИНСПЕКТОРА')}
          </span>
          <h1 id="login-title">
            {t('С возвращением.')}
            <br />
            <span>{t('Продолжим работу.')}</span>
          </h1>
          <p>{t('Карта, обращения и результаты проверок — в вашем рабочем пространстве.')}</p>
        </div>
        <div className="login-landmark" aria-hidden="true">
          <MapPinned size={76} />
        </div>
        <div className="auth-story-footer">
          <Layers3 size={20} />
          <span>{t('Технологии на стороне земли.')}</span>
        </div>
      </div>
      <div className="register-form-column" data-reveal style={{ '--reveal-delay': '100ms' }}>
        <LoginForm
          destination={destination}
          onLogin={() => navigate(destination, { replace: true })}
        />
      </div>
    </section>
  );
}
