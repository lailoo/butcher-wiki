import i18n, { type Resource } from 'i18next';
import { initReactI18next } from 'react-i18next';

import enApp from '@/locales/en/app.json';
import zhApp from '@/locales/zh/app.json';

export type AppLanguage = 'zh' | 'en';

export function normalizeLanguage(lang: unknown): AppLanguage {
  if (!lang) return 'zh';
  const s = String(lang).toLowerCase();
  if (s === 'en' || s === 'english') return 'en';
  return 'zh';
}

let _initialized = false;

export function initI18n(language?: unknown) {
  if (_initialized) return i18n;

  const resources: Resource = {
    en: { app: enApp },
    zh: { app: zhApp },
  };

  i18n.use(initReactI18next).init({
    resources,
    lng: normalizeLanguage(language),
    fallbackLng: 'zh',
    defaultNS: 'app',
    ns: ['app'],
    keySeparator: false,
    interpolation: { escapeValue: false },
    returnEmptyString: false,
  });

  _initialized = true;
  return i18n;
}
