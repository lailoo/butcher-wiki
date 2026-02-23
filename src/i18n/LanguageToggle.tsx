'use client';

import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';

export function LanguageToggle() {
  const { i18n } = useTranslation();
  const [lang, setLang] = useState(i18n.language || 'zh');

  useEffect(() => {
    const onChanged = () => setLang(i18n.language);
    i18n.on('languageChanged', onChanged);
    return () => { i18n.off('languageChanged', onChanged); };
  }, [i18n]);

  const toggle = () => {
    const next = lang === 'zh' ? 'en' : 'zh';
    window.dispatchEvent(new CustomEvent('language-change', { detail: next }));
    setLang(next);
  };

  return (
    <button
      onClick={toggle}
      className="w-8 h-8 flex items-center justify-center rounded-lg border border-[var(--glass-border)] bg-[var(--glass-bg)] hover:bg-[var(--glass-hover)] transition-colors duration-200 cursor-pointer"
      aria-label="Switch language"
    >
      <span className="text-xs font-medium text-[var(--text-secondary)]">
        {lang === 'zh' ? 'EN' : '中'}
      </span>
    </button>
  );
}
