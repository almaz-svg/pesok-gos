import { messages } from './messages.js';

export const LANGUAGE_KEY = 'pesok-language';
export const LANGUAGES = [
  { code: 'kk', name: 'Қазақша', short: 'ҚАЗ', locale: 'kk-KZ' },
  { code: 'ru', name: 'Русский', short: 'РУС', locale: 'ru-RU' },
  { code: 'en', name: 'English', short: 'ENG', locale: 'en-GB' },
];
const valid = (value) => LANGUAGES.some(({ code }) => code === value);
let language = 'ru';
try {
  const saved = globalThis.localStorage?.getItem(LANGUAGE_KEY);
  if (valid(saved)) language = saved;
} catch {
  // Private browsing can block storage. Switching still works for this session.
}
const listeners = new Set();
export const getLanguage = () => language;
export const getLocale = () => LANGUAGES.find(({ code }) => code === language).locale;
export function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
export function setLanguage(next, persist = true) {
  if (!valid(next)) return;
  language = next;
  if (typeof document !== 'undefined') document.documentElement.lang = next;
  if (persist) {
    try {
      globalThis.localStorage?.setItem(LANGUAGE_KEY, next);
    } catch {
      // The in-memory preference remains available.
    }
  }
  listeners.forEach((listener) => listener());
}
if (typeof window !== 'undefined') {
  document.documentElement.lang = language;
  window.addEventListener('storage', (event) => {
    if (event.key === LANGUAGE_KEY)
      setLanguage(valid(event.newValue) ? event.newValue : 'ru', false);
  });
}
export function translateFor(code, source, values = {}) {
  if (typeof source !== 'string') return source;
  const translated = code === 'ru' ? source : (messages[source]?.[code] ?? source);
  return translated.replace(/\{(\w+)\}/g, (match, key) =>
    Object.hasOwn(values, key) ? String(values[key]) : match,
  );
}
export const translate = (source, values) => translateFor(language, source, values);
