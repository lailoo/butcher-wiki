'use client';

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AddDomainModal } from './AddDomainModal';

export function AddDomainCard() {
  const [open, setOpen] = useState(false);
  const { t } = useTranslation();

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="glass-card group flex flex-col items-center justify-center gap-3 p-6 min-h-[180px] cursor-pointer border-dashed hover:border-[var(--accent-blue)]/40 transition-colors duration-200"
      >
        <svg className="w-8 h-8 text-[var(--text-muted)] group-hover:text-[var(--accent-blue)] transition-colors" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="10" /><path d="M12 8v8M8 12h8" />
        </svg>
        <span className="text-xs text-[var(--text-muted)] group-hover:text-[var(--text-secondary)] transition-colors">{t('Add Domain')}</span>
      </button>
      <AddDomainModal open={open} onClose={() => setOpen(false)} />
    </>
  );
}
