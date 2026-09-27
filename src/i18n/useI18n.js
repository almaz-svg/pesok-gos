import { useMemo, useSyncExternalStore } from 'react';
import { getLanguage, getLocale, setLanguage, subscribe, translateFor } from './core.js';

export function useI18n() {
  const language = useSyncExternalStore(subscribe, getLanguage, () => 'ru');
  return useMemo(
    () => ({
      language,
      locale: getLocale(),
      setLanguage,
      t: (source, values) => translateFor(language, source, values),
    }),
    [language],
  );
}
