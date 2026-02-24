'use client';

import { useTranslation } from 'react-i18next';
import { useDomainText } from '@/i18n/useDomainText';
import { SolutionListCard } from '@/components/solution/SolutionListCard';
import { ComparisonTable } from '@/components/ui/ComparisonTable';
import { CopyContextButton } from '@/components/ui/CopyContextButton';
import { DomainIcon } from '@/components/ui/DomainIcon';
import { EditDomainButton } from '@/components/domain/EditDomainButton';
import { SidebarNav } from '@/components/layout/SidebarNav';

interface DomainPageClientProps {
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
    solutions: {
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
    }[];
    comparison_dimensions: { name: string; values: Record<string, string> }[];
  };
  domainContext: string;
  knowledgeDocSlugs: Record<string, string | undefined>;
}

export function DomainPageClient({ domain, domainContext, knowledgeDocSlugs }: DomainPageClientProps) {
  const { t } = useTranslation();
  const localDomain = useDomainText(domain.id, {
    title: domain.title,
    subtitle: domain.subtitle,
    description: domain.description,
    sub_problems: domain.sub_problems,
    best_practices: domain.best_practices,
    comparison_dimensions: domain.comparison_dimensions,
    solutions: domain.solutions.map(s => ({ source_id: s.source_id, project: s.project, title: s.title, description: s.description })),
  });

  // Build translated solutions by merging original data with translated fields
  // Match by project name (unique within domain) — source_id is not unique for scanned solutions
  const translatedSolutions = domain.solutions.map((s, idx) => {
    const ts = localDomain.solutions?.find(t => t.source_id === s.source_id && t.project === s.project)
      ?? localDomain.solutions?.[idx];
    if (!ts) return s;
    return {
      ...s,
      title: ts.title,
      description: ts.description,
      design_philosophy: ts.design_philosophy || s.design_philosophy,
      migration_scenarios: ts.migration_scenarios || s.migration_scenarios,
    };
  });
  const translatedDimensions = localDomain.comparison_dimensions || domain.comparison_dimensions;

  const SIDEBAR_ITEMS = [
    { label: t('Overview'), href: '#overview' },
    { label: t('Sub-problems'), href: '#sub-problems' },
    {
      label: t('Solutions from projects'), href: '#solutions',
      children: domain.solutions.map(s => ({ label: s.project, href: `#sol-${s.project.toLowerCase()}` })),
    },
    { label: t('Comparison'), href: '#comparison' },
    { label: t('Best Practices'), href: '#best-practices' },
  ];

  const allSignals = [...new Set(domain.solutions.flatMap(s => s.signals))].slice(0, 6);
  const projects = [...new Set(domain.solutions.map(s => s.project))];

  return (
    <div className="max-w-7xl mx-auto px-6 py-12">
      <div className="flex items-center gap-2 text-sm text-[var(--text-muted)] mb-6">
        <a href="/" className="hover:text-[var(--text-secondary)] transition-colors duration-200 cursor-pointer">{t('Problem Domains')}</a>
        <span>/</span>
        <span className="text-[var(--text-secondary)]">{domain.id}</span>
      </div>

      <section id="overview" className="mb-8">
        <div className="flex items-start gap-4 mb-4">
          <DomainIcon name={domain.icon} color={domain.color} className="w-8 h-8 shrink-0 mt-1" />
          <div className="flex-1">
            <h1 className="text-3xl font-bold">{localDomain.title}</h1>
            <p className="text-sm text-[var(--text-muted)] font-mono mt-1">{localDomain.subtitle}</p>
          </div>
          <CopyContextButton text={domainContext} label={t('Copy domain context')} iconOnly />
          <EditDomainButton domain={{
            id: domain.id, slug: domain.slug, title: domain.title,
            subtitle: domain.subtitle, description: domain.description,
            icon: domain.icon, color: domain.color, severity: domain.severity,
            tags: domain.tags, sub_problems: domain.sub_problems, best_practices: domain.best_practices,
          }} />
        </div>
        <p className="text-base text-[var(--text-secondary)] max-w-3xl leading-relaxed">
          {localDomain.isTranslating && <span className="text-xs text-[var(--accent-blue)] mr-2">{t('Translating...')}</span>}
          {localDomain.description}
        </p>
      </section>

      <div className="flex gap-8">
        <aside className="hidden lg:block w-56 shrink-0 sticky top-24 self-start">
          <SidebarNav items={SIDEBAR_ITEMS} />
        </aside>

        <div className="flex-1 min-w-0">
          <section id="sub-problems" className="mb-10">
            <h2 className="text-lg font-medium text-[var(--text-secondary)] mb-4">{t('Sub-problems')}</h2>
            <div className="glass-card p-5 space-y-2">
              {localDomain.sub_problems.map((p, i) => (
                <p key={i} className="text-sm text-[var(--text-secondary)] flex items-start gap-3">
                  <span className="text-[var(--text-muted)] font-mono text-xs mt-0.5 shrink-0">{i + 1}.</span>
                  {p}
                </p>
              ))}
            </div>
          </section>

          <section id="solutions" className="mb-10">
            <h2 className="text-lg font-medium text-[var(--text-secondary)] mb-4">
              {t('Solutions from projects')}
              <span className="text-sm font-normal text-[var(--text-muted)] ml-2">{t('{{count}} solutions', { count: domain.solutions.length })}</span>
            </h2>
            <div className="flex items-center gap-2 flex-wrap mb-4">
              <span className="text-[10px] text-[var(--text-muted)] uppercase tracking-wider font-medium shrink-0">{t('Signals')}</span>
              {allSignals.map(s => (
                <button key={s} className="rounded-full border border-[var(--glass-border)] bg-white/[0.02] px-2.5 py-0.5 text-[10px] font-mono text-[var(--text-muted)] hover:border-[var(--accent-blue)]/40 hover:text-[var(--text-primary)] transition-colors duration-200 cursor-pointer">{s}</button>
              ))}
            </div>
            <div className="flex flex-col gap-3">
              {translatedSolutions.map((s) => (
                <SolutionListCard key={`${s.project}-${s.source_id}`} solution={s} color={domain.color} knowledgeDocSlug={knowledgeDocSlugs[`${domain.id}-${s.project}`]} />
              ))}
            </div>
          </section>
          {domain.comparison_dimensions.length > 0 && (
            <section id="comparison" className="mb-10">
              <h2 className="text-lg font-medium text-[var(--text-secondary)] mb-4">{t('Comparison')}</h2>
              <ComparisonTable dimensions={translatedDimensions} projects={projects} />
            </section>
          )}

          <section id="best-practices">
            <h2 className="text-lg font-medium text-[var(--text-secondary)] mb-4">{t('Best Practices')}</h2>
            <div className="glass-card p-6 space-y-3">
              {localDomain.best_practices.map((p, i) => (
                <p key={i} className="text-sm text-[var(--text-secondary)] flex items-start gap-3">
                  <span className="text-[var(--text-muted)] font-mono text-xs mt-0.5">{i + 1}.</span>{p}
                </p>
              ))}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
