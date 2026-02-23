'use client';

import { useState } from 'react';
import { DomainIcon } from '@/components/ui/DomainIcon';
import { useTranslation } from 'react-i18next';
import { useDomainText } from '@/i18n/useDomainText';

export interface ProjectDomain {
  id: string;
  slug: string;
  title: string;
  icon: string;
  color: string;
  solutionTitle: string;
  knowledgeSlug?: string;
}

export interface ProjectEntry {
  name: string;
  repo: string;
  domains: ProjectDomain[];
}

function DomainRow({ d, t }: { d: ProjectDomain; t: (key: string) => string }) {
  const local = useDomainText(d.id, {
    title: d.title,
    subtitle: '',
    description: '',
    sub_problems: [],
    best_practices: [],
    solutions: [{ source_id: '', title: d.solutionTitle, description: '' }],
  });
  const translatedSolutionTitle = local.solutions?.[0]?.title || d.solutionTitle;

  return (
    <div className="flex items-center gap-3 py-2 px-3 rounded-lg hover:bg-white/[0.03] transition-colors duration-150">
      <DomainIcon name={d.icon} color={d.color} className="w-4 h-4 shrink-0" />
      <a href={`/domain/${d.slug}`} className="text-sm text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors cursor-pointer flex-1 min-w-0">
        <span className="font-mono text-[10px] text-[var(--text-muted)] mr-2">{d.id}</span>
        {local.title}
      </a>
      <span className="text-xs text-[var(--text-muted)] truncate max-w-[300px] hidden sm:block">{translatedSolutionTitle}</span>
      {d.knowledgeSlug && (
        <a
          href={`/knowledge/${d.knowledgeSlug}`}
          className="shrink-0 text-[10px] font-mono text-[var(--accent-blue)] hover:text-[var(--accent-blue)]/80 transition-colors cursor-pointer"
          onClick={(e) => e.stopPropagation()}
        >
          {t('View doc')}
        </a>
      )}
    </div>
  );
}

export function ProjectCard({ project }: { project: ProjectEntry }) {
  const [expanded, setExpanded] = useState(false);
  const { t } = useTranslation();

  return (
    <div className="glass-card overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full p-6 text-left cursor-pointer"
      >
        <div className="flex items-start gap-4">
          <div
            className="w-8 h-8 shrink-0 mt-0.5 rounded-lg flex items-center justify-center text-sm font-bold"
            style={{ backgroundColor: `${project.domains[0]?.color}20`, color: project.domains[0]?.color }}
          >
            {project.name[0]}
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-3 mb-1">
              <h3 className="text-base font-medium text-[var(--text-primary)]">{project.name}</h3>
            </div>
            {project.repo && (
              <span className="text-xs font-mono text-[var(--accent-blue)]">
                {project.repo.replace('https://github.com/', '')}
              </span>
            )}
            <div className="flex flex-wrap gap-1.5 mt-2">
              {project.domains.map((d) => (
                <span
                  key={d.id}
                  className="text-[10px] font-mono px-2 py-0.5 rounded-full"
                  style={{ color: d.color, backgroundColor: `${d.color}15`, border: `1px solid ${d.color}25` }}
                >
                  {d.id}
                </span>
              ))}
            </div>
          </div>
          <div className="shrink-0 flex items-center gap-2">
            <span className="text-xs font-mono text-[var(--text-muted)]">
              {t('{{count}} domains', { count: project.domains.length })}
            </span>
            <svg
              className={`w-4 h-4 text-[var(--text-muted)] transition-transform duration-200 ${expanded ? 'rotate-180' : ''}`}
              viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
            >
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </div>
        </div>
      </button>

      {expanded && (
        <div className="border-t border-[var(--glass-border)] px-6 pb-4 pt-3">
          <div className="flex flex-col gap-2">
            {project.domains.map((d) => (
              <DomainRow key={d.id} d={d} t={t} />
            ))}
          </div>
          {project.repo && (
            <a
              href={project.repo}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 text-xs font-mono text-[var(--accent-blue)] hover:text-[var(--accent-blue)]/80 transition-colors duration-200 cursor-pointer mt-3"
              onClick={(e) => e.stopPropagation()}
            >
              <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.403 5.403 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65S8.93 17.38 9 18v4" />
                <path d="M9 18c-4.51 2-5-2-7-2" />
              </svg>
              {t('View GitHub source')}
            </a>
          )}
        </div>
      )}
    </div>
  );
}
