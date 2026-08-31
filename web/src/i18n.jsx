/**
 * UI localisation. English strings are the keys; `t('New module doc')` returns the
 * Polish text when the UI locale is pl, the English text otherwise (so a missing
 * entry never breaks the page). `{name}` placeholders are filled from the second
 * argument. The locale comes from localStorage (the switch in the top bar), else
 * the browser language; it is remembered per browser.
 */
import React, { createContext, useCallback, useContext, useMemo, useState } from 'react';
import { PL } from './i18n.pl.js';

export const UI_LANGUAGES = [
  { code: 'en', label: 'English', short: 'EN' },
  { code: 'pl', label: 'Polski', short: 'PL' },
];
const STORAGE_KEY = 'ftd-ui-lang';
const DICTS = { pl: PL };

let current = 'en';

export function detectLocale() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved && DICTS[saved] !== undefined) return saved;
    if (saved === 'en') return 'en';
  } catch {}
  const prefs = typeof navigator !== 'undefined' ? [navigator.language, ...(navigator.languages || [])] : [];
  return prefs.some((l) => String(l || '').toLowerCase().startsWith('pl')) ? 'pl' : 'en';
}

/** Current UI locale (outside React). */
export const locale = () => current;

/** Translate one UI string; usable anywhere (components re-render on locale change via the provider). */
export function t(text, vars) {
  const dict = DICTS[current];
  let out = dict && Object.prototype.hasOwnProperty.call(dict, text) ? dict[text] : text;
  if (vars) for (const [k, v] of Object.entries(vars)) out = out.split(`{${k}}`).join(String(v));
  return out;
}

/** Plural helper: n + a unit; the dictionary keys are the English singular/plural forms. */
export function plural(n, singular, pluralForm = `${singular}s`) {
  if (current === 'pl') {
    const dict = DICTS.pl;
    const forms = dict[`#${singular}`]; // "moduł|moduły|modułów"
    if (forms) {
      const [one, few, many] = forms.split('|');
      const m10 = n % 10;
      const m100 = n % 100;
      const form = n === 1 ? one : m10 >= 2 && m10 <= 4 && !(m100 >= 12 && m100 <= 14) ? few : many;
      return `${n} ${form}`;
    }
  }
  return `${n} ${n === 1 ? t(singular) : t(pluralForm)}`;
}

const LocaleContext = createContext({ locale: 'en', setLocale: () => {} });

export function LocaleProvider({ children }) {
  const [loc, setLoc] = useState(() => {
    const l = detectLocale();
    current = l;
    return l;
  });
  const setLocale = useCallback((l) => {
    current = l;
    try {
      localStorage.setItem(STORAGE_KEY, l);
    } catch {}
    setLoc(l);
  }, []);
  const value = useMemo(() => ({ locale: loc, setLocale }), [loc, setLocale]);
  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
}

export const useLocale = () => useContext(LocaleContext);

/** Top-right EN | PL switch. */
export function LanguageSwitch() {
  const { locale: loc, setLocale } = useLocale();
  return (
    <div className="mode-toggle ui-lang" title={t('Console language — remembered in this browser')}>
      {UI_LANGUAGES.map((l) => (
        <button key={l.code} className={loc === l.code ? 'active' : ''} onClick={() => setLocale(l.code)} title={l.label}>
          {l.short}
        </button>
      ))}
    </div>
  );
}
