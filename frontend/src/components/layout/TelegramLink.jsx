import { useI18n } from '../../i18n/useI18n.js';
import { TELEGRAM_BOT_NAME, TELEGRAM_BOT_URL } from '../../lib/links.js';
import { Telegram } from '../icons.jsx';

export default function TelegramLink({ className, children }) {
  const { t } = useI18n();
  return (
    <a
      className={className}
      href={TELEGRAM_BOT_URL}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={t('Открыть Telegram-бота @zbjer_bot (новая вкладка)')}
    >
      <Telegram size={21} />
      {children || <span>{TELEGRAM_BOT_NAME}</span>}
    </a>
  );
}
