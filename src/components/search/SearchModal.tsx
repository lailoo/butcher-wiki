'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';

interface SearchMatch {
  type: 'domain' | 'solution' | 'knowledge';
  id: string;
  domain_id: string;
  title: string;
  reason: string;
  relevance: number;
}

interface SearchResult {
  intent: string;
  matches: SearchMatch[];
  suggestion?: string;
}

interface SearchModalProps {
  open: boolean;
  onClose: () => void;
}

type SearchState = 'idle' | 'loading' | 'done' | 'error';

export function SearchModal({ open, onClose }: SearchModalProps) {
  const [query, setQuery] = useState('');
  const [state, setState] = useState<SearchState>('idle');
  const [result, setResult] = useState<SearchResult | null>(null);
  const [error, setError] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { t, i18n } = useTranslation();

  // Global ESC key listener — works regardless of focus
  useEffect(() => {
    if (!open) return;
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    document.addEventListener('keydown', handleEsc);
    return () => document.removeEventListener('keydown', handleEsc);
  }, [open, onClose]);

  // Auto-focus input when modal opens
  useEffect(() => {
    if (open) {
      setTimeout(() => inputRef.current?.focus(), 50);
      setQuery('');
      setState('idle');
      setResult(null);
      setSelectedIndex(0);
    }
  }, [open]);

  const doSearch = useCallback(async (q: string) => {
    if (q.trim().length < 2) return;
    setState('loading');
    setError('');
    try {
      const res = await fetch('/api/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: q.trim(), lang: i18n.language }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || t('Search failed'));
      }
      const data: SearchResult = await res.json();
      setResult(data);
      setState('done');
      setSelectedIndex(0);
    } catch (e) {
      setError(e instanceof Error ? e.message : t('Search service error'));
      setState('error');
    }
  }, []);

  // Debounced search on input change
  const handleInputChange = (value: string) => {
    setQuery(value);
    if (timerRef.current) clearTimeout(timerRef.current);
    if (value.trim().length >= 2) {
      timerRef.current = setTimeout(() => doSearch(value), 600);
    } else {
      setState('idle');
      setResult(null);
    }
  };

  // Keyboard navigation
  const handleKeyDown = (e: React.KeyboardEvent) => {
    const matches = result?.matches || [];
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex(i => (i + 1) % Math.max(matches.length, 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex(i => (i - 1 + matches.length) % Math.max(matches.length, 1));
    } else if (e.key === 'Enter' && matches[selectedIndex]) {
      e.preventDefault();
      navigateTo(matches[selectedIndex]);
    }
  };

  const navigateTo = (match: SearchMatch) => {
    let href = '/';
    if (match.type === 'domain') {
      href = `/domain/${match.id}`;
    } else if (match.type === 'solution') {
      href = `/domain/${match.id}`;
    } else if (match.type === 'knowledge') {
      href = `/knowledge/${match.id}`;
    }
    window.location.href = href;
    onClose();
  };

  const typeLabel = (type: string) => {
    switch (type) {
      case 'domain': return t('Domain');
      case 'solution': return t('Solution');
      case 'knowledge': return t('Document');
      default: return type;
    }
  };

  const typeColor = (type: string) => {
    switch (type) {
      case 'domain': return 'var(--accent-blue)';
      case 'solution': return '#10b981';
      case 'knowledge': return '#a855f7';
      default: return 'var(--text-muted)';
    }
  };

  if (!open) return null;

  return (
    <>
      {/* Overlay */}
      <div className="search-overlay" onClick={onClose} />

      {/* Palette */}
      <div className="search-palette" onKeyDown={handleKeyDown}>
        {/* Input */}
        <div className="flex items-center gap-3 px-5 py-4 border-b border-[var(--glass-border)]">
          <svg className="w-5 h-5 text-[var(--text-muted)] shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="11" cy="11" r="8" /><path d="m21 21-4.3-4.3" />
          </svg>
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => handleInputChange(e.target.value)}
            placeholder={t('search_placeholder')}
            className="flex-1 bg-transparent text-base text-[var(--text-primary)] placeholder:text-[var(--text-muted)] outline-none"
          />
          {state === 'loading' && (
            <svg className="w-4 h-4 text-[var(--accent-blue)] animate-spin shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M21 12a9 9 0 1 1-6.219-8.56" />
            </svg>
          )}
          <kbd className="hidden sm:inline-flex items-center rounded border border-[var(--glass-border)] bg-[var(--code-bg)] px-1.5 py-0.5 text-[10px] font-mono text-[var(--text-muted)]">
            ESC
          </kbd>
        </div>

        {/* Results */}
        <div className="max-h-[60vh] overflow-y-auto">
          {/* Idle state */}
          {state === 'idle' && query.length === 0 && (
            <div className="px-5 py-8 text-center">
              <p className="text-sm text-[var(--text-muted)]">{t('search_hint')}</p>
              <div className="flex items-center justify-center gap-2 mt-3 flex-wrap">
                {(i18n.language === 'en'
                  ? ['token overflow', 'DeerFlow parallel', 'sandbox isolation', 'search retrieval']
                  : ['token 超限', 'DeerFlow 并行', '沙箱隔离', '搜索检索']
                ).map(ex => (
                  <button
                    key={ex}
                    onClick={() => { setQuery(ex); doSearch(ex); }}
                    className="rounded-full border border-[var(--glass-border)] bg-[var(--code-bg)] px-3 py-1 text-xs text-[var(--text-muted)] hover:text-[var(--text-secondary)] hover:border-[var(--accent-blue)]/40 transition-colors cursor-pointer"
                  >
                    {ex}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Loading */}
          {state === 'loading' && (
            <div className="px-5 py-8 text-center">
              <div className="flex items-center justify-center gap-2">
                <svg className="w-4 h-4 text-[var(--accent-blue)] animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M21 12a9 9 0 1 1-6.219-8.56" />
                </svg>
                <p className="text-sm text-[var(--text-muted)]">{t('AI analyzing...')}</p>
              </div>
            </div>
          )}

          {/* Results */}
          {state === 'done' && result && (
            <>
              {/* Intent understanding */}
              {result.intent && (
                <div className="px-5 pt-3 pb-1">
                  <p className="text-xs text-[var(--accent-blue)]">
                    <span className="text-[var(--text-muted)]">{t('AI understanding:')}</span>{result.intent}
                  </p>
                </div>
              )}

              {result.matches.length === 0 ? (
                <div className="px-5 py-8 text-center">
                  <p className="text-sm text-[var(--text-muted)]">{t('No results found')}</p>
                </div>
              ) : (
                <div className="py-2">
                  {result.matches.map((match, i) => (
                    <button
                      key={`${match.type}-${match.id}-${i}`}
                      data-selected={i === selectedIndex}
                      onClick={() => navigateTo(match)}
                      onMouseEnter={() => setSelectedIndex(i)}
                      className="search-result-item w-full flex items-start gap-3 px-5 py-3 text-left cursor-pointer"
                    >
                      {/* Type badge */}
                      <span
                        className="shrink-0 mt-0.5 text-[10px] font-bold px-1.5 py-0.5 rounded border"
                        style={{
                          color: typeColor(match.type),
                          borderColor: `${typeColor(match.type)}30`,
                          backgroundColor: `${typeColor(match.type)}10`,
                        }}
                      >
                        {typeLabel(match.type)}
                      </span>
                      {/* Content */}
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-[var(--text-primary)] line-clamp-1">{match.title}</p>
                        <p className="text-xs text-[var(--text-muted)] mt-0.5 line-clamp-1">{match.reason}</p>
                      </div>
                      {/* Domain ID */}
                      <span className="shrink-0 text-[10px] font-mono text-[var(--text-muted)]">{match.domain_id}</span>
                    </button>
                  ))}
                </div>
              )}

              {/* Suggestion */}
              {result.suggestion && (
                <div className="px-5 pb-3">
                  <p className="text-xs text-[var(--text-muted)] italic">{result.suggestion}</p>
                </div>
              )}
            </>
          )}

          {/* Error */}
          {state === 'error' && (
            <div className="px-5 py-8 text-center">
              <p className="text-sm text-rose-400">{error}</p>
              <button
                onClick={() => doSearch(query)}
                className="mt-2 text-xs text-[var(--accent-blue)] hover:underline cursor-pointer"
              >
                {t('Retry')}
              </button>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center gap-4 px-5 py-2.5 border-t border-[var(--glass-border)] text-[10px] text-[var(--text-muted)]">
          <span className="flex items-center gap-1"><kbd className="rounded border border-[var(--glass-border)] bg-[var(--code-bg)] px-1 py-0.5">↑↓</kbd> {t('Navigate')}</span>
          <span className="flex items-center gap-1"><kbd className="rounded border border-[var(--glass-border)] bg-[var(--code-bg)] px-1 py-0.5">↵</kbd> {t('Open')}</span>
          <span className="flex items-center gap-1"><kbd className="rounded border border-[var(--glass-border)] bg-[var(--code-bg)] px-1 py-0.5">esc</kbd> {t('Close')}</span>
        </div>
      </div>
    </>
  );
}

