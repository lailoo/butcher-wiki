'use client';

import { useTranslation } from 'react-i18next';

interface SearchTriggerProps {
  onClick: () => void;
}

export function SearchTrigger({ onClick }: SearchTriggerProps) {
  const { t } = useTranslation();

  return (
    <button
      onClick={onClick}
      className="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-[var(--glass-border)] bg-[var(--glass-bg)] hover:bg-[var(--glass-hover)] transition-colors duration-200 cursor-pointer text-sm text-[var(--text-muted)] hover:text-[var(--text-secondary)]"
      aria-label={t('Search')}
    >
      <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="11" cy="11" r="8" /><path d="m21 21-4.3-4.3" />
      </svg>
      <span className="hidden sm:inline">{t('Search')}</span>
      <kbd className="hidden sm:inline-flex items-center gap-0.5 rounded border border-[var(--glass-border)] bg-[var(--code-bg)] px-1.5 py-0.5 text-[10px] font-mono text-[var(--text-muted)]">
        ⌘K
      </kbd>
    </button>
  );
}
