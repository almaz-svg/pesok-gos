import { Link } from 'react-router-dom';
import { MoveUpRight, Radio, ScanLine, Check } from 'lucide-react';
export default function ProcessSection() {
  return (
    <section className="process-section" aria-labelledby="process-title">
      <div className="process-intro">
        <div className="section-kicker">
          <span>02 /</span> КАК ЭТО РАБОТАЕТ
        </div>
        <h2 id="process-title">
          Ближе к земле.
          <br />
          <span>Ближе к людям.</span>
        </h2>
        <Link to="/reports">
          Перейти к обращениям
          <MoveUpRight size={17} />
        </Link>
      </div>
      <div className="process-steps">
        {[
          {
            n: '01',
            title: 'Замечено.',
            text: 'Гражданин отправляет геолокацию, фото и описание проблемы через Telegram.',
            tone: 'yellow',
            icon: Radio,
          },
          {
            n: '02',
            title: 'Проверено.',
            text: 'Инспектор изучает сигнал на карте, фиксирует результат и назначает контрольный срок.',
            tone: 'red',
            icon: ScanLine,
          },
          {
            n: '03',
            title: 'Решено.',
            text: 'Статус обращения меняется. Вся история работы остаётся в карточке.',
            tone: 'green',
            icon: Check,
          },
        ].map(({ n, title, text, tone, icon: Icon }) => (
          <div className={`process-step process-${tone}`} key={n}>
            <div className="process-step-top">
              <span>{n}</span>
              <Icon size={21} strokeWidth={1.4} />
            </div>
            <h3>{title}</h3>
            <p>{text}</p>
          </div>
        ))}
      </div>
    </section>
  );
}
