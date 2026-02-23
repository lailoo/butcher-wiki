'use client';

import { useTranslation } from 'react-i18next';
import { DomainCard } from '@/components/domain/DomainCard';
import { AddDomainCard } from '@/components/domain/AddDomainCard';
import { CopyContextButton } from '@/components/ui/CopyContextButton';
import { ProblemDomain } from '@/types';

interface HomePageClientProps {
  domains: (ProblemDomain & { solution_count: number })[];
  totalSolutions: number;
  uniqueProjects: number;
  totalComparisons: number;
  knowledgeContext: string;
}

export function HomePageClient({ domains, totalSolutions, uniqueProjects, totalComparisons, knowledgeContext }: HomePageClientProps) {
  const { t } = useTranslation();

  return (
    <div className="max-w-7xl mx-auto px-6 py-12">
      {/* Hero */}
      <section className="mb-10 flex flex-col gap-6 md:flex-row md:items-start md:justify-between">
        <div className="flex max-w-[640px] lg:max-w-[800px] flex-col gap-3">
          <span className="text-[11px] font-bold uppercase tracking-widest text-[var(--accent-blue)]">
            {t('Agent Engineering Knowledge Base')}
          </span>
          <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">
            Butcher Wiki
          </h1>
          <p className="text-base text-[var(--text-secondary)] leading-relaxed">
            {t('hero_desc')}
          </p>
        </div>
      </section>

      {/* Metrics bar */}
      <section className="mb-10 grid grid-cols-1 gap-4 sm:grid-cols-4 md:gap-8 border-y border-[var(--glass-border)] py-6">
        {[
          { label: 'Problem Domains', value: String(domains.length), desc: t('metric_domains') },
          { label: 'Solutions', value: `${totalSolutions}`, desc: t('Solutions') },
          { label: 'Projects Analyzed', value: String(uniqueProjects), desc: t('Projects Analyzed') },
          { label: 'Comparisons', value: String(totalComparisons), desc: t('Comparisons') },
        ].map((m, i) => (
          <div key={i} className="flex flex-col gap-1 pr-2 border-r-0 sm:border-r sm:border-[var(--glass-border)] sm:last:border-r-0">
            <dt className="text-[11px] font-medium uppercase tracking-wider text-[var(--text-muted)]">{m.label}</dt>
            <dd className="text-2xl font-semibold tracking-tight">{m.value}</dd>
            <dd className="text-xs text-[var(--text-secondary)]">{m.desc}</dd>
          </div>
        ))}
      </section>

      {/* Domain Grid */}
      <section>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
          {domains.map((domain) => (
            <DomainCard key={domain.id} domain={domain} />
          ))}
          <AddDomainCard />
        </div>
      </section>

      {/* Bottom CTA */}
      <div className="text-center mt-16 flex items-center justify-center gap-4">
        <a
          href="/scan"
          className="glass-card inline-flex items-center gap-2 px-6 py-3 text-sm text-[var(--text-secondary)] hover:text-[var(--text-primary)] cursor-pointer transition-colors duration-200"
        >
          <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="11" cy="11" r="8" /><path d="m21 21-4.3-4.3" />
          </svg>
          {t('Scan new open source project')}
        </a>
        <CopyContextButton text={knowledgeContext} label={t('Copy knowledge context')} iconOnly />
      </div>
    </div>
  );
}
