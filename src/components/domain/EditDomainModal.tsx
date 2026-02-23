'use client';

import { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';

interface EditDomainModalProps {
  open: boolean;
  onClose: () => void;
  domain: {
    id: string;
    slug: string;
    title: string;
    subtitle: string;
    description: string;
    icon: string;
    color: string;
    severity: 'critical' | 'high' | 'medium';
    tags: string[];
    sub_problems: string[];
    best_practices: string[];
  };
}

type State = 'idle' | 'saving' | 'error';

export function EditDomainModal({ open, onClose, domain }: EditDomainModalProps) {
  const [title, setTitle] = useState('');
  const [subtitle, setSubtitle] = useState('');
  const [description, setDescription] = useState('');
  const [icon, setIcon] = useState('');
  const [color, setColor] = useState('');
  const [severity, setSeverity] = useState<'critical' | 'high' | 'medium'>('medium');
  const [tags, setTags] = useState('');
  const [subProblems, setSubProblems] = useState('');
  const [bestPractices, setBestPractices] = useState('');
  const [state, setState] = useState<State>('idle');
  const [error, setError] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const { t } = useTranslation();

  useEffect(() => {
    if (open) {
      setTitle(domain.title);
      setSubtitle(domain.subtitle);
      setDescription(domain.description);
      setIcon(domain.icon);
      setColor(domain.color);
      setSeverity(domain.severity);
      setTags(domain.tags.join(', '));
      setSubProblems(domain.sub_problems.join('\n'));
      setBestPractices(domain.best_practices.join('\n'));
      setState('idle');
      setError('');
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open, domain]);

  const handleSubmit = async () => {
    if (!title.trim()) return;
    setState('saving');
    setError('');
    try {
      const res = await fetch('/api/domains/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: domain.id,
          title: title.trim(),
          subtitle: subtitle.trim(),
          description: description.trim(),
          icon,
          color,
          severity,
          tags: tags.split(',').map(t => t.trim()).filter(Boolean),
          sub_problems: subProblems.split('\n').map(s => s.trim()).filter(Boolean),
          best_practices: bestPractices.split('\n').map(s => s.trim()).filter(Boolean),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || t('Update failed'));
      window.location.reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : t('Update failed'));
      setState('error');
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') onClose();
  };

  if (!open) return null;

  return (
    <>
      <div className="search-overlay" onClick={onClose} />
      <div className="search-palette max-h-[85vh] flex flex-col" onKeyDown={handleKeyDown}>
        {/* Header */}
        <div className="flex items-center gap-3 px-5 py-4 border-b border-[var(--glass-border)] shrink-0">
          <svg className="w-5 h-5 text-[var(--text-muted)] shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" /><path d="m15 5 4 4" />
          </svg>
          <span className="text-sm text-[var(--text-secondary)]">{t('Edit domain {{id}}', { id: domain.id })}</span>
          <div className="flex-1" />
          <kbd className="hidden sm:inline-flex items-center rounded border border-[var(--glass-border)] bg-[var(--code-bg)] px-1.5 py-0.5 text-[10px] font-mono text-[var(--text-muted)]">ESC</kbd>
        </div>

        {/* Form */}
        <div className="px-5 py-4 space-y-4 overflow-y-auto flex-1">
          {/* Row: title + subtitle */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-[var(--text-muted)] mb-1.5">{t('Title')}</label>
              <input
                ref={inputRef}
                type="text"
                value={title}
                onChange={e => setTitle(e.target.value)}
                disabled={state === 'saving'}
                className="w-full bg-[var(--code-bg)] border border-[var(--glass-border)] rounded-lg px-3 py-2 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--accent-blue)]/50 transition-colors"
              />
            </div>
            <div>
              <label className="block text-xs text-[var(--text-muted)] mb-1.5">{t('Subtitle')}</label>
              <input
                type="text"
                value={subtitle}
                onChange={e => setSubtitle(e.target.value)}
                disabled={state === 'saving'}
                className="w-full bg-[var(--code-bg)] border border-[var(--glass-border)] rounded-lg px-3 py-2 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--accent-blue)]/50 transition-colors"
              />
            </div>
          </div>

          {/* Description */}
          <div>
            <label className="block text-xs text-[var(--text-muted)] mb-1.5">{t('Description')}</label>
            <textarea
              value={description}
              onChange={e => setDescription(e.target.value)}
              disabled={state === 'saving'}
              rows={2}
              className="w-full bg-[var(--code-bg)] border border-[var(--glass-border)] rounded-lg px-3 py-2 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--accent-blue)]/50 transition-colors resize-none"
            />
          </div>

          {/* Row: icon + color + severity */}
          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="block text-xs text-[var(--text-muted)] mb-1.5">{t('Icon')}</label>
              <input
                type="text"
                value={icon}
                onChange={e => setIcon(e.target.value)}
                disabled={state === 'saving'}
                className="w-full bg-[var(--code-bg)] border border-[var(--glass-border)] rounded-lg px-3 py-2 text-sm text-[var(--text-primary)] font-mono outline-none focus:border-[var(--accent-blue)]/50 transition-colors"
              />
            </div>
            <div>
              <label className="block text-xs text-[var(--text-muted)] mb-1.5">{t('Color')}</label>
              <div className="flex items-center gap-2">
                <input
                  type="color"
                  value={color}
                  onChange={e => setColor(e.target.value)}
                  disabled={state === 'saving'}
                  className="w-8 h-8 rounded border border-[var(--glass-border)] cursor-pointer bg-transparent"
                />
                <input
                  type="text"
                  value={color}
                  onChange={e => setColor(e.target.value)}
                  disabled={state === 'saving'}
                  className="flex-1 bg-[var(--code-bg)] border border-[var(--glass-border)] rounded-lg px-3 py-2 text-sm text-[var(--text-primary)] font-mono outline-none focus:border-[var(--accent-blue)]/50 transition-colors"
                />
              </div>
            </div>
            <div>
              <label className="block text-xs text-[var(--text-muted)] mb-1.5">{t('Severity')}</label>
              <select
                value={severity}
                onChange={e => setSeverity(e.target.value as 'critical' | 'high' | 'medium')}
                disabled={state === 'saving'}
                className="w-full bg-[var(--code-bg)] border border-[var(--glass-border)] rounded-lg px-3 py-2 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--accent-blue)]/50 transition-colors"
              >
                <option value="critical">{t('critical_label')}</option>
                <option value="high">{t('high_label')}</option>
                <option value="medium">{t('medium_label')}</option>
              </select>
            </div>
          </div>

          {/* Tags */}
          <div>
            <label className="block text-xs text-[var(--text-muted)] mb-1.5">{t('Tags')} <span className="text-[var(--text-muted)]">{t('(comma separated)')}</span></label>
            <input
              type="text"
              value={tags}
              onChange={e => setTags(e.target.value)}
              disabled={state === 'saving'}
              className="w-full bg-[var(--code-bg)] border border-[var(--glass-border)] rounded-lg px-3 py-2 text-sm text-[var(--text-primary)] font-mono outline-none focus:border-[var(--accent-blue)]/50 transition-colors"
            />
          </div>

          {/* Sub-problems */}
          <div>
            <label className="block text-xs text-[var(--text-muted)] mb-1.5">{t('Sub-problems')} <span className="text-[var(--text-muted)]">{t('(one per line)')}</span></label>
            <textarea
              value={subProblems}
              onChange={e => setSubProblems(e.target.value)}
              disabled={state === 'saving'}
              rows={4}
              className="w-full bg-[var(--code-bg)] border border-[var(--glass-border)] rounded-lg px-3 py-2 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--accent-blue)]/50 transition-colors resize-none"
            />
          </div>

          {/* Best practices */}
          <div>
            <label className="block text-xs text-[var(--text-muted)] mb-1.5">{t('Best Practices')} <span className="text-[var(--text-muted)]">{t('bp_hint')}</span></label>
            <textarea
              value={bestPractices}
              onChange={e => setBestPractices(e.target.value)}
              disabled={state === 'saving'}
              rows={4}
              className="w-full bg-[var(--code-bg)] border border-[var(--glass-border)] rounded-lg px-3 py-2 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--accent-blue)]/50 transition-colors resize-none"
            />
          </div>

          {state === 'error' && (
            <p className="text-xs text-rose-400">{error}</p>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-5 py-3 border-t border-[var(--glass-border)] shrink-0">
          <button
            onClick={onClose}
            className="text-xs text-[var(--text-muted)] hover:text-[var(--text-secondary)] cursor-pointer transition-colors"
          >
            {t('Cancel')}
          </button>
          <button
            onClick={handleSubmit}
            disabled={!title.trim() || state === 'saving'}
            className="inline-flex items-center gap-2 rounded-lg bg-[var(--accent-blue)] px-4 py-1.5 text-xs font-medium text-white disabled:opacity-40 cursor-pointer hover:opacity-90 transition-opacity"
          >
            {state === 'saving' ? (
              <>
                <svg className="w-3 h-3 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 12a9 9 0 1 1-6.219-8.56" /></svg>
                {t('Saving...')}
              </>
            ) : t('Save')}
          </button>
        </div>
      </div>
    </>
  );
}
