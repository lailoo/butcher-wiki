'use client';

import { ProblemDomain } from '@/types';
import { DomainIcon } from '@/components/ui/DomainIcon';
import { useTranslation } from 'react-i18next';
import { useDomainText } from '@/i18n/useDomainText';

interface DomainCardProps {
  domain: ProblemDomain;
}

export function DomainCard({ domain }: DomainCardProps) {
  const { t } = useTranslation();
  const localDomain = useDomainText(domain.id, {
    title: domain.title,
    subtitle: domain.subtitle,
    description: domain.description,
    sub_problems: [],
    best_practices: [],
  });
  return (
    <a
      href={`/domain/${domain.slug}`}
      className="glass-card relative p-6 block group cursor-pointer overflow-hidden"
      style={{ '--glow-color': `${domain.color}40` } as React.CSSProperties}
      data-color={domain.color}
    >
      {/* Glow dot */}
      <div
        className="absolute top-4 right-4 w-2 h-2 rounded-full opacity-60"
        style={{ backgroundColor: domain.color }}
      />

      {/* Icon + Title */}
      <div className="flex items-start gap-3 mb-3">
        <DomainIcon name={domain.icon} color={domain.color} className="w-6 h-6 shrink-0 mt-0.5" />
        <div>
          <h3 className="text-base font-medium text-[var(--text-primary)] transition-colors duration-200">
            {localDomain.title}
          </h3>
          <p className="text-xs text-[var(--text-muted)] font-mono mt-0.5">{localDomain.subtitle}</p>
        </div>
      </div>

      {/* Description */}
      <p className="text-sm text-[var(--text-secondary)] leading-relaxed mb-4 line-clamp-2">
        {localDomain.description}
      </p>

      {/* Footer: severity + solution count */}
      <div className="flex items-center justify-between">
        <span className={`badge-${domain.severity} text-xs px-2 py-0.5 rounded-full`}>
          {t(domain.severity)}
        </span>
        {domain.solution_count !== undefined && (
          <span className="solution-pill font-mono">
            {domain.solution_count} solutions
          </span>
        )}
      </div>

      {/* Tags */}
      <div className="flex flex-wrap gap-1.5 mt-3">
        {domain.tags.slice(0, 3).map((tag) => (
          <span
            key={tag}
            className="text-[10px] font-mono text-[var(--text-muted)] bg-white/[0.03] px-2 py-0.5 rounded-full"
          >
            {tag}
          </span>
        ))}
      </div>
    </a>
  );
}
