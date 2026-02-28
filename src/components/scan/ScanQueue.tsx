'use client';

import { useTranslation } from 'react-i18next';
import type { QueueItem, ScanPhase } from '@/hooks/useScanQueue';

interface ScanQueueProps {
  queue: QueueItem[];
  activeItemId: string | null;
  phase: ScanPhase;
  progress: number;
  onRemove: (id: string) => void;
  onRetry: (id: string) => void;
  onCancel: () => void;
  onClearDone: () => void;
}

function repoName(url: string) {
  const parts = url.replace(/\/+$/, '').replace(/\.git$/, '').split('/');
  return parts.length >= 2 ? `${parts[parts.length - 2]}/${parts[parts.length - 1]}` : url;
}

const PHASE_LABELS: Record<ScanPhase, string> = {
  idle: '',
  cloning: '克隆中...',
  scanning: '扫描中...',
  extracting: '提取中...',
  matching: '匹配中...',
  doc_generating: '生成文档...',
  all_done: '完成',
  done: '完成',
  error: '错误',
};

export function ScanQueue({ queue, activeItemId, phase, progress, onRemove, onRetry, onCancel, onClearDone }: ScanQueueProps) {
  const { t } = useTranslation();

  if (queue.length === 0) return null;

  const hasDone = queue.some(q => q.status === 'done' || q.status === 'error');

  return (
    <section className="mb-8">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-medium text-[var(--text-secondary)]">
          {t('Scan Queue')} <span className="text-[var(--text-muted)]">({queue.length})</span>
        </h2>
        {hasDone && (
          <button
            onClick={onClearDone}
            className="text-[10px] text-[var(--text-muted)] hover:text-[var(--text-secondary)] transition-colors cursor-pointer"
          >
            {t('Clear completed')}
          </button>
        )}
      </div>
      <div className="flex flex-col gap-2">
        {queue.map(item => (
          <QueueItemCard
            key={item.id}
            item={item}
            isActive={item.id === activeItemId}
            phase={phase}
            progress={progress}
            onRemove={onRemove}
            onRetry={onRetry}
            onCancel={onCancel}
          />
        ))}
      </div>
    </section>
  );
}

function QueueItemCard({
  item, isActive, phase, progress, onRemove, onRetry, onCancel,
}: {
  item: QueueItem;
  isActive: boolean;
  phase: ScanPhase;
  progress: number;
  onRemove: (id: string) => void;
  onRetry: (id: string) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const name = repoName(item.repoUrl);

  return (
    <div className={`glass-card px-4 py-3 flex items-center gap-3 ${isActive ? 'border-[var(--accent-blue)]/30' : ''}`}>
      {/* Status icon */}
      <div className="shrink-0">
        {item.status === 'scanning' && (
          <div className="w-2.5 h-2.5 rounded-full bg-[var(--accent-blue)] animate-pulse" />
        )}
        {item.status === 'pending' && (
          <div className="w-2.5 h-2.5 rounded-full border border-[var(--text-muted)]" />
        )}
        {item.status === 'done' && (
          <svg className="w-4 h-4 text-emerald-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="20 6 9 17 4 12" />
          </svg>
        )}
        {item.status === 'error' && (
          <svg className="w-4 h-4 text-rose-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10" /><line x1="15" y1="9" x2="9" y2="15" /><line x1="9" y1="9" x2="15" y2="15" />
          </svg>
        )}
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-mono text-[var(--text-primary)] truncate">{name}</span>
          {item.status === 'scanning' && (
            <span className="text-[10px] text-[var(--accent-blue)]">{PHASE_LABELS[phase]}</span>
          )}
          {item.status === 'done' && item.results && (
            <span className="text-[10px] text-emerald-500">{t('Matched {{count}} domains', { count: item.results.length })}</span>
          )}
          {item.status === 'error' && (
            <span className="text-[10px] text-rose-400 truncate">{item.error}</span>
          )}
        </div>
        {/* Progress bar for active item */}
        {item.status === 'scanning' && (
          <div className="w-full h-1 bg-[var(--code-bg)] rounded-full overflow-hidden mt-1.5">
            <div
              className="h-full rounded-full bg-[var(--accent-blue)] transition-all duration-500 ease-out"
              style={{ width: `${progress}%` }}
            />
          </div>
        )}
      </div>

      {/* Actions */}
      <div className="shrink-0 flex items-center gap-1">
        {item.status === 'pending' && (
          <button
            onClick={() => onRemove(item.id)}
            className="p-1 text-[var(--text-muted)] hover:text-rose-400 transition-colors cursor-pointer"
            title={t('Remove')}
          >
            <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        )}
        {item.status === 'scanning' && (
          <button
            onClick={onCancel}
            className="p-1 text-[var(--text-muted)] hover:text-rose-400 transition-colors cursor-pointer"
            title={t('Cancel')}
          >
            <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="3" width="18" height="18" rx="2" />
            </svg>
          </button>
        )}
        {item.status === 'error' && (
          <button
            onClick={() => onRetry(item.id)}
            className="p-1 text-[var(--text-muted)] hover:text-[var(--accent-blue)] transition-colors cursor-pointer"
            title={t('Retry')}
          >
            <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="23 4 23 10 17 10" /><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
            </svg>
          </button>
        )}
      </div>
    </div>
  );
}
