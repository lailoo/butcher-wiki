'use client';

import { useTranslation } from 'react-i18next';
import { MarkdownRenderer } from '@/components/ui/MarkdownRenderer';
import { DomainIcon } from '@/components/ui/DomainIcon';

interface DomainLink {
  id: string;
  slug: string;
  title: string;
  icon: string;
  color: string;
  solutionTitle: string;
  knowledgeSlug?: string;
}

interface ProjectDetailProps {
  name: string;
  slug: string;
  repo: string;
  language: string;
  description: string;
  domains: DomainLink[];
  meta: Record<string, string>;
  body: string;
}

export function ProjectDetailClient({ name, repo, language, description, domains, meta, body }: ProjectDetailProps) {
  const { t } = useTranslation();
  const repoShort = repo.replace('https://github.com/', '');
  const hasContent = !body.includes('*待补充*') || body.length > 200;

  return (
    <div className="max-w-7xl mx-auto px-6 py-12">
      {/* Breadcrumb */}
      <div className="flex items-center gap-2 text-sm text-[var(--text-muted)] mb-8 flex-wrap">
        <a href="/" className="hover:text-[var(--text-secondary)] transition-colors cursor-pointer">{t('Home')}</a>
        <span>/</span>
        <a href="/projects" className="hover:text-[var(--text-secondary)] transition-colors cursor-pointer">{t('Projects')}</a>
        <span>/</span>
        <span className="text-[var(--text-secondary)]">{name}</span>
      </div>

      {/* Hero */}
      <div className="glass-card p-8 mb-8 relative overflow-hidden">
        <div className="relative z-10">
          <div className="flex items-start justify-between gap-4 flex-wrap">
            <div>
              <h1 className="text-3xl font-bold mb-2">{name}</h1>
              <p className="text-base text-[var(--text-secondary)] mb-4 max-w-2xl">{description}</p>
              <div className="flex items-center gap-4 flex-wrap">
                {repo && (
                  <a href={repo} target="_blank" rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 text-xs font-mono text-[var(--accent-blue)] hover:opacity-80 transition-opacity cursor-pointer">
                    <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.403 5.403 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65S8.93 17.38 9 18v4" />
                      <path d="M9 18c-4.51 2-5-2-7-2" />
                    </svg>
                    {repoShort}
                  </a>
                )}
                <span className="text-xs font-mono px-2 py-0.5 rounded-full border border-[var(--glass-border)] text-[var(--text-muted)]">{language}</span>
                <span className="text-xs font-mono px-2 py-0.5 rounded-full border border-[var(--glass-border)] text-[var(--text-muted)]">
                  {t('{{count}} domains', { count: domains.length })}
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Main layout: sidebar + content */}
      <div className="flex gap-8 flex-col lg:flex-row">
        {/* Sidebar */}
        <aside className="lg:w-72 shrink-0">
          {/* Meta card */}
          <div className="glass-card p-5 mb-4">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)] mb-3">{t('Project Info')}</h3>
            <dl className="space-y-2.5 text-sm">
              {repo && (
                <div>
                  <dt className="text-[var(--text-muted)] text-xs">{t('Repository')}</dt>
                  <dd>
                    <a href={repo} target="_blank" rel="noopener noreferrer"
                      className="text-[var(--accent-blue)] hover:underline font-mono text-xs cursor-pointer">
                      {repoShort}
                    </a>
                  </dd>
                </div>
              )}
              <div>
                <dt className="text-[var(--text-muted)] text-xs">{t('Language')}</dt>
                <dd className="text-[var(--text-secondary)]">{language}</dd>
              </div>
              <div>
                <dt className="text-[var(--text-muted)] text-xs">{t('Covered Domains')}</dt>
                <dd className="text-[var(--text-secondary)] font-mono">{domains.length}</dd>
              </div>
              {Object.entries(meta).filter(([k]) => !['项目', 'GitHub', '语言', '定位', 'Project', 'Language', 'Description'].includes(k)).map(([k, v]) => (
                <div key={k}>
                  <dt className="text-[var(--text-muted)] text-xs">{k}</dt>
                  <dd className="text-[var(--text-secondary)] text-xs">{v}</dd>
                </div>
              ))}
            </dl>
          </div>

          {/* Domain coverage */}
          <div className="glass-card p-5">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)] mb-3">{t('Domain Coverage')}</h3>
            <div className="space-y-1.5">
              {domains.map(d => (
                <div key={d.id} className="flex items-center gap-2.5 py-1.5 px-2 rounded-lg hover:bg-[var(--glass-hover)] transition-colors">
                  <DomainIcon name={d.icon} color={d.color} className="w-4 h-4 shrink-0" />
                  <div className="flex-1 min-w-0">
                    <a href={`/domain/${d.slug}`} className="text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors cursor-pointer block truncate">
                      <span className="font-mono text-[10px] text-[var(--text-muted)] mr-1">{d.id}</span>
                      {d.title}
                    </a>
                  </div>
                  {d.knowledgeSlug && (
                    <a href={`/knowledge/${d.knowledgeSlug}`}
                      className="shrink-0 text-[10px] font-mono text-[var(--accent-blue)] hover:opacity-70 transition-opacity cursor-pointer">
                      {t('Doc')}
                    </a>
                  )}
                </div>
              ))}
              {domains.length === 0 && (
                <p className="text-xs text-[var(--text-muted)]">{t('No domains analyzed yet')}</p>
              )}
            </div>
          </div>
        </aside>

        {/* Content */}
        <main className="flex-1 min-w-0">
          {!hasContent && (
            <div className="glass-card p-8 text-center mb-6">
              <p className="text-[var(--text-muted)] text-sm">{t('Engineering analysis content is being prepared...')}</p>
            </div>
          )}
          <article className="prose-custom">
            <MarkdownRenderer content={body} />
          </article>
        </main>
      </div>
    </div>
  );
}
