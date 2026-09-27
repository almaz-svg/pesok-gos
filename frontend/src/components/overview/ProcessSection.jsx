import { useI18n } from '../../i18n/useI18n.js';
import { Link } from 'react-router-dom';
import { MoveUpRight, Radio, ScanLine, Check } from '../icons.jsx';
export default function ProcessSection() {
  const { t } = useI18n();
  return (
    <section className="process-section" aria-labelledby="process-title">
      <div className="process-intro" data-reveal>
        <div className="section-kicker">
          <span>02 /</span> {t('КАК ЭТО РАБОТАЕТ')}
        </div>
        <h2 id="process-title">
          {t('Ближе к земле.')}
          <br />
          <span>{t('Ближе к людям.')}</span>
        </h2>
        <Link to="/reports">
          {t('Перейти к обращениям')}
          <MoveUpRight size={17} />
        </Link>
      </div>
      <div className="process-steps">
        {[
          {
            n: '01',
            title: t('Замечено.'),
            text: t('Гражданин отправляет геолокацию, фото и описание проблемы через Telegram.'),
            tone: 'yellow',
            icon: Radio,
          },
          {
            n: '02',
            title: t('Проверено.'),
            text: t(
              'Инспектор изучает сигнал на карте, фиксирует результат и назначает контрольный срок.',
            ),
            tone: 'red',
            icon: ScanLine,
          },
          {
            n: '03',
            title: t('Решено.'),
            text: t('Статус обращения меняется. Вся история работы остаётся в карточке.'),
            tone: 'green',
            icon: Check,
          },
        ].map(({ n, title, text, tone, icon: Icon }, index) => (
          <div
            className={`process-step process-${tone}`}
            key={n}
            data-reveal
            style={{ '--reveal-delay': `${index * 90}ms` }}
          >
            <div className="process-step-top">
              <span>{n}</span>
              <Icon size={21} />
            </div>
            <h3>{title}</h3>
            <p>{text}</p>
          </div>
        ))}
      </div>
    </section>
  );
}
