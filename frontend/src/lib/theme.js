import { useSyncExternalStore } from 'react';

const THEME_KEY = 'pesok-theme';
const listeners = new Set();
let theme = document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';

const getTheme = () => theme;
function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function applyTheme(next, persist = true) {
  theme = next === 'light' ? 'light' : 'dark';
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = theme === 'light' ? '#f5f7f1' : '#08100b';
  if (persist) {
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch {
      // Keep the chosen palette in memory when browser storage is unavailable.
    }
  }
  listeners.forEach((listener) => listener());
}

function syncTheme(event) {
  if (event.key === THEME_KEY || event.key === null) applyTheme(event.newValue, false);
}
window.addEventListener('storage', syncTheme);
if (import.meta.hot)
  import.meta.hot.dispose(() => window.removeEventListener('storage', syncTheme));

export function useTheme() {
  const current = useSyncExternalStore(subscribe, getTheme, () => 'dark');
  return { theme: current, toggleTheme: () => applyTheme(theme === 'dark' ? 'light' : 'dark') };
}
