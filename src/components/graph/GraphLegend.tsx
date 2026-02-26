'use client';

import { useTranslation } from 'react-i18next';

export function GraphLegend() {
  const { t } = useTranslation();

  return (
    <div className="absolute bottom-4 right-4 glass-card px-4 py-3 text-xs z-10">
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <span className="w-4 h-4 rounded-full bg-[#3b82f6] border border-white/25 shrink-0" />
          <span className="text-[var(--text-secondary)]">{t('Project')}</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="w-2.5 h-2.5 rounded-full bg-[#8b5cf6] shrink-0" />
          <span className="text-[var(--text-secondary)]">{t('Problem Domain')}</span>
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
