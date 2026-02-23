'use client';

import { useTranslation } from 'react-i18next';

interface ComparisonTableProps {
  dimensions: {
    name: string;
    values: Record<string, string>;
  }[];
  projects: string[];
}

export function ComparisonTable({ dimensions, projects }: ComparisonTableProps) {
  const { t } = useTranslation();

  return (
    <div className="glass-card overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-[var(--glass-border)]">
              <th className="text-left p-4 text-[var(--text-muted)] font-normal">{t('Dimension')}</th>
              {projects.map((p) => (
                <th key={p} className="text-left p-4 text-[var(--text-secondary)] font-medium">{p}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {dimensions.map((dim, i) => (
              <tr key={i} className="border-b border-[var(--glass-border)]/50 hover:bg-[var(--glass-bg)] transition-colors">
                <td className="p-4 text-[var(--text-secondary)] font-medium">{dim.name}</td>
                {projects.map((p) => (
                  <td key={p} className="p-4 text-[var(--text-muted)]">{dim.values[p] || '—'}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
