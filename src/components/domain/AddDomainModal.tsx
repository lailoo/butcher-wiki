'use client';

import { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';

interface AddDomainModalProps {
  open: boolean;
  onClose: () => void;
}

type State = 'idle' | 'loading' | 'error';

export function AddDomainModal({ open, onClose }: AddDomainModalProps) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [state, setState] = useState<State>('idle');
  const [error, setError] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const { t } = useTranslation();

  useEffect(() => {
    if (open) {
      setTimeout(() => inputRef.current?.focus(), 50);
      setTitle('');
      setDescription('');
      setState('idle');
      setError('');
    }
  }, [open]);

  const handleSubmit = async () => {
    if (!title.trim()) return;
    setState('loading');
    setError('');
    try {
      const res = await fetch('/api/domains/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: title.trim(), description: description.trim() || undefined }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || t('Create failed'));
      window.location.href = `/domain/${data.slug}`;
    } catch (e) {
      setError(e instanceof Error ? e.message : t('Create failed'));
      setState('error');
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') onClose();
    if (e.key === 'Enter' && !e.shiftKey && title.trim() && state !== 'loading') {
      e.preventDefault();
      handleSubmit();
    }
  };

  if (!open) return null;

  return (
    <>
      <div className="search-overlay" onClick={onClose} />
      <div className="search-palette" onKeyDown={handleKeyDown}>
        {/* Header */}
        <div className="flex items-center gap-3 px-5 py-4 border-b border-[var(--glass-border)]">
          <svg className="w-5 h-5 text-[var(--text-muted)] shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10" /><path d="M12 8v8M8 12h8" />
          </svg>
          <span className="text-sm text-[var(--text-secondary)]">{t('Add Domain')}</span>
          <div className="flex-1" />
          <kbd className="hidden sm:inline-flex items-center rounded border border-[var(--glass-border)] bg-[var(--code-bg)] px-1.5 py-0.5 text-[10px] font-mono text-[var(--text-muted)]">ESC</kbd>
        </div>

        {/* Form */}
        <div className="px-5 py-4 space-y-4">
          <div>
            <label className="block text-xs text-[var(--text-muted)] mb-1.5">{t('Domain title')}</label>
            <input
              ref={inputRef}
              type="text"
              value={title}
              onChange={e => setTitle(e.target.value)}
              placeholder={t('add_domain_placeholder')}
              disabled={state === 'loading'}
              className="w-full bg-[var(--code-bg)] border border-[var(--glass-border)] rounded-lg px-3 py-2 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] outline-none focus:border-[var(--accent-blue)]/50 transition-colors"
            />
          </div>
          <div>
            <label className="block text-xs text-[var(--text-muted)] mb-1.5">{t('Description (optional)')} <span className="text-[var(--text-muted)]">{t('ai_auto_complete')}</span></label>
            <textarea
              value={description}
              onChange={e => setDescription(e.target.value)}
              placeholder={t('add_domain_desc_placeholder')}
              disabled={state === 'loading'}
              rows={2}
              className="w-full bg-[var(--code-bg)] border border-[var(--glass-border)] rounded-lg px-3 py-2 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] outline-none focus:border-[var(--accent-blue)]/50 transition-colors resize-none"
            />
          </div>

          {state === 'error' && (
            <p className="text-xs text-rose-400">{error}</p>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-5 py-3 border-t border-[var(--glass-border)]">
          <p className="text-[10px] text-[var(--text-muted)]">{t('ai_will_complete')}</p>
          <button
            onClick={handleSubmit}
            disabled={!title.trim() || state === 'loading'}
            className="inline-flex items-center gap-2 rounded-lg bg-[var(--accent-blue)] px-4 py-1.5 text-xs font-medium text-white disabled:opacity-40 cursor-pointer hover:opacity-90 transition-opacity"
          >
            {state === 'loading' ? (
              <>
                <svg className="w-3 h-3 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 12a9 9 0 1 1-6.219-8.56" /></svg>
                {t('Generating...')}
              </>
            ) : t('Create')}
          </button>
        </div>
      </div>
    </>
  );
}
