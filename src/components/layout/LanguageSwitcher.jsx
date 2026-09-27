import { useI18n } from '../../i18n/useI18n.js';
import { LANGUAGES } from '../../i18n/core.js';
import { Globe, ChevronDown } from '../icons.jsx';

export default function LanguageSwitcher() {
  const { t, language, setLanguage } = useI18n();
  return (
    <label className="language-switcher">
      <Globe size={17} />
      <span className="sr-only">{t('Язык интерфейса')}</span>
      <select value={language} onChange={(event) => setLanguage(event.target.value)}>
        {LANGUAGES.map(({ code, name }) => (
          <option key={code} value={code} lang={code}>
            {name}
          </option>
        ))}
      </select>
      <ChevronDown className="language-caret" size={12} />
    </label>
  );
}
