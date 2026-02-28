'use client';

import { useTranslation } from 'react-i18next';
import type { GraphViewMode } from './ForceGraph';

interface Props {
  viewMode: GraphViewMode;
}

export function GraphLegend({ viewMode }: Props) {
  const { t } = useTranslation();
  const primary = viewMode === 'project'
    ? { color: '#3b82f6', label: t('Project'), size: 'w-4 h-4' }
    : { color: '#8b5cf6', label: t('Problem Domain'), size: 'w-4 h-4' };
  const secondary = viewMode === 'project'
    ? { color: '#8b5cf6', label: t('Problem Domain'), size: 'w-2.5 h-2.5' }
    : { color: '#3b82f6', label: t('Project'), size: 'w-2.5 h-2.5' };

  return (
    <div className="absolute bottom-4 right-4 glass-card px-4 py-3 text-xs z-10">
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <span className={`${primary.size} rounded-full border border-white/25 shrink-0`} style={{ backgroundColor: primary.color }} />
          <span className="text-[var(--text-secondary)]">{primary.label}</span>
        </div>
        <div className="flex items-center gap-2">
          <span className={`${secondary.size} rounded-full shrink-0`} style={{ backgroundColor: secondary.color }} />
          <span className="text-[var(--text-secondary)]">{secondary.label}</span>
        </div>
        <div className="border-t border-[var(--glass-border)] pt-2 mt-1">
          <div className="flex items-center gap-2">
            <span className="w-6 h-px bg-white/20" />
            <span className="text-[var(--text-muted)]">{t('has solution')}</span>
          </div>
        </div>
      </div>
    </div>
  );
}
