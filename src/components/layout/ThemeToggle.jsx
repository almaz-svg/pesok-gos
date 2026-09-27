import { useI18n } from '../../i18n/useI18n.js';
import { useTheme } from '../../lib/theme.js';
import { Moon, Sun } from '../icons.jsx';

export default function ThemeToggle() {
  const { t } = useI18n();
  const { theme, toggleTheme } = useTheme();
  const label = t(theme === 'dark' ? 'Включить светлую тему' : 'Включить тёмную тему');
  return (
    <button
      type="button"
      className="theme-toggle"
      onClick={toggleTheme}
      aria-label={label}
      title={label}
    >
      {theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}
    </button>
  );
}
