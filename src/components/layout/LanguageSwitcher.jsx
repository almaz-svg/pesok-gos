import { useEffect, useId, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { useI18n } from '../../i18n/useI18n.js';
import { LANGUAGES } from '../../i18n/core.js';
import { Globe, ChevronDown, Check } from '../icons.jsx';

export default function LanguageSwitcher() {
  const { t, language, setLanguage } = useI18n();
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);
  const triggerRef = useRef(null);
  const optionRefs = useRef([]);
  const firstFocus = useRef(null);
  const menuId = useId();
  const location = useLocation();
  const selected = LANGUAGES.find(({ code }) => code === language);

  useEffect(() => setOpen(false), [location.key]);
  useEffect(() => {
    if (!open) return;
    const index = firstFocus.current ?? LANGUAGES.findIndex(({ code }) => code === language);
    optionRefs.current[index]?.focus();
    firstFocus.current = null;
    function dismiss(event) {
      if (!rootRef.current?.contains(event.target)) setOpen(false);
    }
    document.addEventListener('pointerdown', dismiss);
    document.addEventListener('focusin', dismiss);
    return () => {
      document.removeEventListener('pointerdown', dismiss);
      document.removeEventListener('focusin', dismiss);
    };
  }, [open, language]);

  function close() {
    setOpen(false);
    triggerRef.current?.focus();
  }

  function navigateOptions(event) {
    const index = optionRefs.current.indexOf(document.activeElement);
    let next;
    if (event.key === 'ArrowDown') next = (index + 1) % LANGUAGES.length;
    if (event.key === 'ArrowUp') next = (index + LANGUAGES.length - 1) % LANGUAGES.length;
    if (event.key === 'Home') next = 0;
    if (event.key === 'End') next = LANGUAGES.length - 1;
    if (next !== undefined) {
      event.preventDefault();
      optionRefs.current[next]?.focus();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close();
    } else if (event.key === 'Tab') {
      // Let the browser continue from the trigger in the normal tab order.
      close();
    }
  }

  return (
    <div className="language-switcher" ref={rootRef}>
      <button
        type="button"
        className="language-trigger"
        ref={triggerRef}
        aria-label={`${t('Язык интерфейса')}: ${selected.name}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((previous) => !previous)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            firstFocus.current = event.key === 'ArrowDown' ? 0 : LANGUAGES.length - 1;
            setOpen(true);
          } else if (event.key === 'Escape') close();
        }}
      >
        <Globe size={15} />
        <span lang={language}>{selected.short}</span>
        <ChevronDown className="language-caret" size={11} />
      </button>
      {open && (
        <div
          className="language-menu"
          id={menuId}
          role="menu"
          aria-label={t('Язык интерфейса')}
          onKeyDown={navigateOptions}
        >
          {LANGUAGES.map(({ code, name, short }, index) => (
            <button
              key={code}
              ref={(node) => {
                optionRefs.current[index] = node;
              }}
              type="button"
              role="menuitemradio"
              aria-checked={code === language}
              tabIndex={-1}
              lang={code}
              onClick={() => {
                setLanguage(code);
                close();
              }}
            >
              <span className="language-code" aria-hidden="true">
                {short}
              </span>
              <span className="language-name">{name}</span>
              {code === language && <Check size={15} />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
