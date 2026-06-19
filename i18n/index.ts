import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { zh } from './locales/zh';
import { en } from './locales/en';

export type Locale = 'zh' | 'en';
const LOCALES: Record<Locale, Record<string, string>> = { zh, en };
const STORAGE_KEY = 'cat_investigation_locale';

interface I18nContextValue {
  locale: Locale;
  setLocale: (l: Locale) => void;
  t: (key: string, params?: Record<string, string | number>) => string;
}
const I18nContext = createContext<I18nContextValue | null>(null);

export const I18nProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [locale, setLocaleState] = useState<Locale>(() => {
    if (typeof window === 'undefined') return 'zh';
    try {
      const saved = window.localStorage.getItem(STORAGE_KEY);
      return saved === 'en' ? 'en' : 'zh';
    } catch { return 'zh'; }
  });
  useEffect(() => {
    try { window.localStorage.setItem(STORAGE_KEY, locale); } catch { /* ignore */ }
    if (typeof document !== 'undefined') document.documentElement.lang = locale;
  }, [locale]);
  const setLocale = useCallback((l: Locale) => setLocaleState(l), []);
  const t = useCallback((key: string, params?: Record<string, string | number>) => {
    const dict = LOCALES[locale] || zh;
    let str = dict[key] ?? zh[key] ?? key;
    if (params) {
      Object.entries(params).forEach(([k, v]) => {
        str = str.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v));
      });
    }
    return str;
  }, [locale]);
  return React.createElement(I18nContext.Provider, { value: { locale, setLocale, t } }, children);
};

export const useI18n = (): I18nContextValue => {
  const ctx = useContext(I18nContext);
  if (!ctx) {
    // Fallback for components rendered outside provider (shouldn't happen in prod)
    return { locale: 'zh', setLocale: () => {}, t: (k: string) => zh[k] ?? k };
  }
  return ctx;
};
