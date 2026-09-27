import { useId } from 'react';
import { useI18n } from '../i18n/useI18n.js';
import { ChevronDown, Telegram } from './icons.jsx';
import './bot-result.css';

const draftFields = [
  ['officialDraft', 'Проект официального обращения'],
  ['followUpDraft', 'Проект повторного обращения'],
  ['inactivityComplaintDraft', 'Проект жалобы на бездействие'],
  ['publicText', 'Текст для публикации'],
  ['socialText', 'Текст для социальных сетей'],
];
const hasText = (value) => typeof value === 'string' && Boolean(value.trim());

export default function BotResult({ result }) {
  const { t } = useI18n();
  const titleId = useId();
  const passport =
    result?.case_passport &&
    typeof result.case_passport === 'object' &&
    !Array.isArray(result.case_passport)
      ? result.case_passport
      : {};
  const locationLanguage = ['kk', 'ru', 'en'].includes(result?.language)
    ? result.language
    : undefined;
  // The bot's case-analysis templates are Russian regardless of its selected UI language.
  const language = 'ru';
  const evidence = Array.isArray(passport.evidenceChecklist)
    ? passport.evidenceChecklist.filter(hasText)
    : [];
  const drafts = draftFields.filter(([key]) => hasText(passport[key]));
  const category = hasText(passport.typeLabel) ? passport.typeLabel : passport.type;
  const days = passport.followUpDays;
  if (
    !hasText(result?.location_summary) &&
    !hasText(category) &&
    !hasText(passport.responsibleAuthority) &&
    !hasText(passport.nextAction) &&
    !evidence.length &&
    !drafts.length &&
    !['high', 'normal'].includes(passport.urgency)
  )
    return null;

  return (
    <section className="bot-result" aria-labelledby={titleId}>
      <header className="bot-result__header">
        <span className="bot-result__icon">
          <Telegram size={21} />
        </span>
        <div>
          <h3 id={titleId}>{t('Ответ Telegram-бота')}</h3>
          <p>{t('Предварительный анализ · @zbjer_bot')}</p>
        </div>
      </header>

      <dl className="bot-result__facts">
        {hasText(category) && (
          <div>
            <dt>{t('Категория по анализу бота')}</dt>
            <dd lang={language} dir="auto">
              {category}
            </dd>
          </div>
        )}
        {hasText(passport.responsibleAuthority) && (
          <div>
            <dt>{t('Рекомендуемое ведомство')}</dt>
            <dd lang={language} dir="auto">
              {passport.responsibleAuthority}
            </dd>
          </div>
        )}
        {['high', 'normal'].includes(passport.urgency) && (
          <div>
            <dt>{t('Срочность по анализу бота')}</dt>
            <dd>
              <span className={`bot-result__urgency is-${passport.urgency}`}>
                <i aria-hidden="true" />
                {passport.urgency === 'high' ? t('Повышенная') : t('Обычная')}
              </span>
            </dd>
          </div>
        )}
        {hasText(result.location_summary) && (
          <div>
            <dt>{t('Место по данным бота')}</dt>
            <dd lang={locationLanguage} dir="auto">
              {result.location_summary}
            </dd>
          </div>
        )}
      </dl>

      {evidence.length > 0 && (
        <div className="bot-result__section">
          <h4>{t('Какие доказательства собрать')}</h4>
          <ul lang={language}>
            {evidence.map((item, index) => (
              <li key={index} dir="auto">
                {item}
              </li>
            ))}
          </ul>
        </div>
      )}

      {hasText(passport.nextAction) && (
        <div className="bot-result__next">
          <h4>{t('Следующий шаг')}</h4>
          <p lang={language} dir="auto">
            {passport.nextAction}
          </p>
          {Number.isInteger(days) && days > 0 && (
            <span>{t('Повторное обращение через {days} дн.', { days })}</span>
          )}
        </div>
      )}

      {drafts.length > 0 && (
        <div className="bot-result__drafts">
          <h4>{t('Подготовленные тексты')}</h4>
          {drafts.map(([key, label]) => (
            <details className="bot-result__draft" key={key} data-draft={key}>
              <summary>
                <span>{t(label)}</span>
                <ChevronDown size={16} />
              </summary>
              <p lang={language} dir="auto">
                {passport[key]}
              </p>
            </details>
          ))}
        </div>
      )}

      <p className="bot-result__note">
        {t('Ответ бота носит справочный характер. Результат проверки фиксирует инспектор.')}
      </p>
    </section>
  );
}
