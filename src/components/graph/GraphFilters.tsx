'use client';

import { useTranslation } from 'react-i18next';

const SEVERITY_OPTIONS = [
  { key: 'critical', label: 'Critical', color: '#ef4444' },
  { key: 'high', label: 'High', color: '#f97316' },
  { key: 'medium', label: 'Medium', color: '#eab308' },
] as const;

interface Props {
  severityFilter: Set<string>;
  onSeverityChange: (filter: Set<string>) => void;
}

export function GraphFilters({ severityFilter, onSeverityChange }: Props) {
  const { t } = useTranslation();

  const toggle = (key: string) => {
    const next = new Set(severityFilter);
    if (next.has(key)) {
      if (next.size > 1) next.delete(key); // keep at least one
    } else {
      next.add(key);
    }
    onSeverityChange(next);
  };

  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-[var(--text-muted)] mr-1">{t('Severity')}:</span>
      {SEVERITY_OPTIONS.map(opt => {
        const active = severityFilter.has(opt.key);
        return (
          <button
            key={opt.key}
            onClick={() => toggle(opt.key)}
            className="text-[11px] font-mono px-2.5 py-1 rounded-full border transition-all duration-200 cursor-pointer"
            style={{
              borderColor: active ? opt.color : 'var(--glass-border)',
              backgroundColor: active ? `${opt.color}15` : 'transparent',
              color: active ? opt.color : 'var(--text-muted)',
              opacity: active ? 1 : 0.5,
            }}
          >
            {t(opt.label)}
          </button>
        );
      })}
    </div>
  );
}
