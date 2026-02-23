'use client';

import { useEffect } from 'react';
import i18n from 'i18next';
import { initI18n, normalizeLanguage, type AppLanguage } from './init';

// Always initialize with 'zh' to match server-side rendering.
// Client-side language switch happens in useEffect to avoid hydration mismatch.
initI18n('zh');

export function I18nProvider({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    const stored = localStorage.getItem('language') as string | null;
    const lang = normalizeLanguage(stored);
    if (i18n.language !== lang) {
      i18n.changeLanguage(lang);
    }
    document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
    // Swap loading → ready to fade in after hydration
    document.documentElement.classList.remove('i18n-loading');
    document.documentElement.classList.add('i18n-ready');

    const handler = ((e: CustomEvent<AppLanguage>) => {
      const next = normalizeLanguage(e.detail);
      i18n.changeLanguage(next);
      localStorage.setItem('language', next);
      document.documentElement.lang = next === 'zh' ? 'zh-CN' : 'en';
    }) as EventListener;

    window.addEventListener('language-change', handler);
    return () => window.removeEventListener('language-change', handler);
  }, []);

  return <>{children}</>;
}
