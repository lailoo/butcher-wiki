'use client';

import { useState } from 'react';
import { useTranslation } from 'react-i18next';

interface CopyContextButtonProps {
  text: string;
  label?: string;
  iconOnly?: boolean;
}

export function CopyContextButton({ text, label, iconOnly = false }: CopyContextButtonProps) {
  const { t } = useTranslation();
  const displayLabel = label || t('Copy knowledge context');
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // fallback
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  };

  const iconClass = iconOnly ? 'w-3.5 h-3.5' : 'w-4 h-4';
  const btnClass = iconOnly
    ? 'inline-flex items-center justify-center w-7 h-7 rounded border border-[var(--glass-border)] text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:border-[var(--text-muted)] cursor-pointer transition-colors duration-200'
    : 'glass-card inline-flex items-center gap-2 px-6 py-3 text-sm text-[var(--text-secondary)] hover:text-[var(--text-primary)] cursor-pointer transition-colors duration-200';

  return (
    <button onClick={handleCopy} className={btnClass} title={displayLabel}>
      {copied ? (
        <svg className={`${iconClass} text-green-400`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="20 6 9 17 4 12" />
        </svg>
      ) : (
        <svg className={iconClass} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
        </svg>
      )}
      {!iconOnly && (copied ? t('Copied') : displayLabel)}
    </button>
  );
}
