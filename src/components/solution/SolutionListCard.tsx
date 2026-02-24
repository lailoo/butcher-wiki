'use client';

import { useState } from 'react';
import { useTranslation } from 'react-i18next';

interface SolutionListCardProps {
  solution: {
    project: string;
    source_id: string;
    type: 'Solution';
    title: string;
    description: string;
    signals: string[];
    score: number;
    calls: number;
    repo?: string;
    source_files?: string[];
    design_philosophy?: string[];
    migration_scenarios?: string[];
  };
  color: string;
  knowledgeDocSlug?: string;
  anchorId?: string;
}

export function SolutionListCard({ solution, color, knowledgeDocSlug, anchorId }: SolutionListCardProps) {
  const [expanded, setExpanded] = useState(false);
  const { t } = useTranslation();

  return (
    <div
      className="flex flex-col rounded-lg border border-[var(--glass-border)] bg-white/[0.02] backdrop-blur-sm transition-colors duration-200 hover:border-white/[0.15]"
      id={anchorId || `sol-${solution.project.toLowerCase()}`}
    >
      {/* Header — clickable to expand */}
      <button
        className="flex flex-col gap-2 p-4 text-left cursor-pointer w-full"
        onClick={() => setExpanded(!expanded)}
      >
        <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-2">
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-[var(--text-primary)] line-clamp-1">
              {solution.title}
            </p>
            <p className="text-xs text-[var(--text-muted)] mt-0.5 line-clamp-2">
              {solution.description}
            </p>
            {/* Project info + GitHub link */}
            <div className="flex items-center gap-2 mt-1 flex-wrap">
              <p className="text-xs text-[var(--text-muted)] font-mono">
                {solution.type} -- {solution.project}
                <span className="ml-2">#{solution.source_id}</span>
              </p>
              {solution.repo && (
                <a
                  href={solution.repo}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={(e) => e.stopPropagation()}
                  className="inline-flex items-center gap-1 text-[10px] font-mono text-[var(--accent-blue)] hover:text-[var(--accent-blue)]/80 transition-colors"
                >
                  <svg className="w-2.5 h-2.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.403 5.403 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65S8.93 17.38 9 18v4" />
                    <path d="M9 18c-4.51 2-5-2-7-2" />
                  </svg>
                  {solution.repo.replace('https://github.com/', '')}
                </a>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2 sm:gap-3 shrink-0 text-xs text-[var(--text-muted)] flex-wrap">
            {/* Score badge */}
            <span
              className="inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[10px] font-bold border"
              style={{ color, borderColor: `${color}30`, backgroundColor: `${color}10` }}
            >
              <svg className="w-2 h-2" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" />
              </svg>
              {solution.score >= 0.9 ? 'A' : solution.score >= 0.8 ? 'B' : 'C'}
            </span>
            {/* Star score */}
            <span className="flex items-center gap-1">
              <svg className="w-2.5 h-2.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M11.525 2.295a.53.53 0 0 1 .95 0l2.31 4.679a2.123 2.123 0 0 0 1.595 1.16l5.166.756a.53.53 0 0 1 .294.904l-3.736 3.638a2.123 2.123 0 0 0-.611 1.878l.882 5.14a.53.53 0 0 1-.771.56l-4.618-2.428a2.122 2.122 0 0 0-1.973 0L6.396 21.01a.53.53 0 0 1-.77-.56l.881-5.139a2.122 2.122 0 0 0-.611-1.879L2.16 9.795a.53.53 0 0 1 .294-.906l5.165-.755a2.122 2.122 0 0 0 1.597-1.16z" />
              </svg>
              {solution.score.toFixed(2)}
            </span>
            {/* Expand chevron */}
            <svg
              className={`w-3.5 h-3.5 transition-transform duration-200 ${expanded ? 'rotate-180' : ''}`}
              viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
            >
              <path d="m6 9 6 6 6-6" />
            </svg>
          </div>
        </div>
        {/* Signal tags */}
        {solution.signals.length > 0 && (
          <div className="flex flex-wrap gap-1 mt-1 overflow-hidden max-h-6">
            {solution.signals.map((s) => (
              <span key={s} className="rounded-full border border-[var(--glass-border)] bg-white/[0.02] px-2 py-0.5 text-[10px] font-mono text-[var(--text-muted)]">
                {s}
              </span>
            ))}
          </div>
        )}
      </button>

      {/* Expanded detail panel */}
      {expanded && (
        <div className="border-t border-[var(--glass-border)] px-4 pb-4 pt-3 space-y-4">
          {/* Design Philosophy */}
          {solution.design_philosophy && solution.design_philosophy.length > 0 && (
            <div>
              <p className="text-[10px] uppercase tracking-wider text-[var(--text-muted)] font-medium mb-2">{t('Design Philosophy')}</p>
              <div className="space-y-1.5">
                {solution.design_philosophy.map((p, i) => (
                  <p key={i} className="text-xs text-[var(--text-secondary)] flex items-start gap-2">
                    <span className="text-[var(--text-muted)] mt-0.5 shrink-0">›</span>
                    {p}
                  </p>
                ))}
              </div>
            </div>
          )}

          {/* Source Files */}
          {solution.source_files && solution.source_files.length > 0 && (
            <div>
              <p className="text-[10px] uppercase tracking-wider text-[var(--text-muted)] font-medium mb-2">{t('Source Files')}</p>
              <div className="flex flex-wrap gap-1.5">
                {solution.source_files.map((f) => (
                  <span key={f} className="rounded border border-[var(--glass-border)] bg-[var(--code-bg)] px-2 py-0.5 text-[10px] font-mono text-[var(--text-muted)]">
                    {f}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Migration Scenarios */}
          {solution.migration_scenarios && solution.migration_scenarios.length > 0 && (
            <div>
              <p className="text-[10px] uppercase tracking-wider text-[var(--text-muted)] font-medium mb-2">{t('Migration Scenarios')}</p>
              <div className="space-y-1.5">
                {solution.migration_scenarios.map((s, i) => (
                  <p key={i} className="text-xs text-[var(--text-secondary)] flex items-start gap-2">
                    <span className="text-emerald-400/60 mt-0.5 shrink-0">✓</span>
                    {s}
                  </p>
                ))}
              </div>
            </div>
          )}

          {/* GitHub link button */}
          <div className="flex items-center gap-4 flex-wrap mt-2">
            {solution.repo && (
              <a
                href={solution.repo}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2 text-xs font-mono text-[var(--accent-blue)] hover:text-[var(--accent-blue)]/80 transition-colors"
              >
                <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.403 5.403 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65S8.93 17.38 9 18v4" />
                  <path d="M9 18c-4.51 2-5-2-7-2" />
                </svg>
                {t('View source →')} {solution.repo.replace('https://github.com/', '')}
              </a>
            )}
            {knowledgeDocSlug && (
              <a
                href={`/knowledge/${knowledgeDocSlug}`}
                className="inline-flex items-center gap-2 text-xs font-mono text-emerald-400 hover:text-emerald-300 transition-colors"
              >
                <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H19a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1H6.5a1 1 0 0 1 0-5H20" />
                </svg>
                {t('View detailed analysis →')}
              </a>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
