'use client';

import type { GraphNode } from '@/lib/graph-data';
import { useTranslation } from 'react-i18next';

interface Props {
  node: GraphNode;
  position: { x: number; y: number };
}

export function GraphTooltip({ node, position }: Props) {
  const { t } = useTranslation();

  return (
    <div
      className="absolute pointer-events-none z-20 glass-card px-4 py-3 max-w-[280px] text-left"
      style={{
        left: position.x,
        top: position.y,
        transform: 'translate(-50%, calc(-100% - 16px))',
      }}
    >
      {node.type === 'project' ? (
        <>
          <div className="text-sm font-semibold text-[var(--text-primary)]">{node.label}</div>
          {node.repo && (
            <div className="text-[10px] font-mono text-[var(--accent-blue)] mt-0.5 truncate">
              {node.repo.replace('https://github.com/', '')}
            </div>
          )}
          <div className="text-xs text-[var(--text-muted)] mt-1">
            {t('{{count}} domains', { count: node.domainCount || 0 })}
          </div>
        </>
      ) : (
        <>
          <div className="flex items-center gap-2">
            <span
              className="w-2 h-2 rounded-full shrink-0"
              style={{ backgroundColor: node.color }}
            />
            <span className="text-sm font-semibold text-[var(--text-primary)]">{node.label}</span>
          </div>
          {node.subtitle && (
            <div className="text-[10px] font-mono text-[var(--text-muted)] mt-0.5">{node.subtitle}</div>
          )}
          <div className="flex items-center gap-2 mt-1">
            {node.severity && (
              <span className={`badge-${node.severity} text-[10px] px-1.5 py-0.5 rounded-full`}>
                {node.severity}
              </span>
            )}
            <span className="text-xs text-[var(--text-muted)]">
              {node.solutionCount || 0} {t('solutions')}
            </span>
          </div>
        </>
      )}
    </div>
  );
}
