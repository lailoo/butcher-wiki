'use client';

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { DomainIcon } from '@/components/ui/DomainIcon';
import { ScanLogPanel } from '@/components/scan/ScanLogPanel';
import { ScanQueue } from '@/components/scan/ScanQueue';
import { useScanQueue, type ScanResult } from '@/hooks/useScanQueue';

const PHASE_KEYS: Record<string, string> = {
  idle: '',
  cloning: 'phase_cloning',
  scanning: 'phase_scanning',
  extracting: 'phase_extracting',
  matching: 'phase_matching',
  doc_generating: 'phase_doc_generating',
  all_done: 'phase_all_done',
  done: 'phase_done',
  error: 'phase_error',
};

// 12 问题域定义（用于展示扫描结果）
const DOMAINS = [
  { id: 'PD-01', title: '上下文管理', icon: 'brain', color: '#6366f1' },
  { id: 'PD-02', title: '多 Agent 编排', icon: 'network', color: '#8b5cf6' },
  { id: 'PD-03', title: '容错与重试', icon: 'shield', color: '#ec4899' },
  { id: 'PD-04', title: '工具系统', icon: 'wrench', color: '#f59e0b' },
  { id: 'PD-05', title: '沙箱隔离', icon: 'box', color: '#10b981' },
  { id: 'PD-06', title: '记忆持久化', icon: 'database', color: '#06b6d4' },
  { id: 'PD-07', title: '质量检查', icon: 'check-circle', color: '#84cc16' },
  { id: 'PD-08', title: '搜索与检索', icon: 'search', color: '#3b82f6' },
  { id: 'PD-09', title: 'Human-in-the-Loop', icon: 'user-check', color: '#f97316' },
  { id: 'PD-10', title: '中间件管道', icon: 'layers', color: '#a855f7' },
  { id: 'PD-11', title: '可观测性', icon: 'activity', color: '#14b8a6' },
  { id: 'PD-12', title: '推理增强', icon: 'zap', color: '#eab308' },
];

export default function ScanPage() {
  const { t } = useTranslation();
  const [repoUrl, setRepoUrl] = useState('');
  const [dupError, setDupError] = useState('');
  const {
    queue, phase, progress, logEntries, activeItemId,
    addToQueue, removeFromQueue, retryItem, cancelCurrent, clearDone, isScanning,
  } = useScanQueue();

  // PLACEHOLDER_REST

  const handleAdd = () => {
    if (!repoUrl.trim()) return;
    setDupError('');
    const err = addToQueue(repoUrl);
    if (err) {
      setDupError(err);
      return;
    }
    setRepoUrl('');
  };

  // Find the active scanning item's results for display
  const activeItem = queue.find(q => q.id === activeItemId);
  // Show results of the most recently completed item if nothing is scanning
  const displayItem = activeItem || [...queue].reverse().find(q => q.status === 'done' && q.results && q.results.length > 0);
  const displayResults: ScanResult[] = displayItem?.results || [];

  return (
    <div className="max-w-5xl mx-auto px-6 py-12">
      {/* Breadcrumb */}
      <div className="flex items-center gap-2 text-sm text-[var(--text-muted)] mb-6">
        <a href="/" className="hover:text-[var(--text-secondary)] transition-colors duration-200 cursor-pointer">{t('Home')}</a>
        <span>/</span>
        <span className="text-[var(--text-secondary)]">{t('Scan New Project')}</span>
      </div>

      {/* Header */}
      <section className="mb-8">
        <div className="flex items-start gap-4 mb-4">
          <DomainIcon name="knife" color="#3B82F6" className="w-8 h-8 shrink-0 mt-1" />
          <div>
            <h1 className="text-3xl font-bold">{t('Scan New Project')}</h1>
            <p className="text-sm text-[var(--text-muted)] font-mono mt-1">Project Scanner — The Butcher</p>
          </div>
        </div>
        <p className="text-base text-[var(--text-secondary)] max-w-3xl leading-relaxed">
          {t('scan_desc')}
        </p>
      </section>

      {/* Input Section */}
      <section className="mb-8">
        <div className="glass-card p-6">
          <label className="block text-sm text-[var(--text-secondary)] mb-3">{t('Git repo URL')}</label>
          <div className="flex gap-3">
            <div className="flex-1 relative">
              <input
                type="text"
                value={repoUrl}
                onChange={(e) => { setRepoUrl(e.target.value); setDupError(''); }}
                onKeyDown={(e) => e.key === 'Enter' && handleAdd()}
                placeholder="https://github.com/owner/repo"
                className="w-full bg-[var(--code-bg)] border border-[var(--glass-border)] rounded-xl px-4 py-3 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:border-[var(--accent-blue)]/50 focus:ring-1 focus:ring-[var(--accent-blue)]/20 transition-all duration-200 font-mono"
              />
              {repoUrl && !repoUrl.match(/^https?:\/\//) && (
                <p className="absolute -bottom-5 left-0 text-[10px] text-rose-400/70">{t('Enter full URL (https://)')}</p>
              )}
              {dupError && (
                <p className="absolute -bottom-5 left-0 text-[10px] text-amber-400/70">{dupError}</p>
              )}
            </div>
            <button
              onClick={handleAdd}
              disabled={!repoUrl.trim()}
              className="shrink-0 px-6 py-3 rounded-xl text-sm font-medium transition-all duration-200 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed bg-[var(--accent-blue)]/20 border border-[var(--accent-blue)]/30 text-[var(--accent-blue)] hover:bg-[var(--accent-blue)]/30 hover:border-[var(--accent-blue)]/50"
            >
              <span className="flex items-center gap-2">
                <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M3 2l9 9" /><path d="M12 11l9-9" /><path d="M12 11v11" /><path d="M8 22h8" />
                </svg>
                {isScanning ? t('Add to Queue') : t('Start Butchering')}
              </span>
            </button>
          </div>

          {/* Quick examples */}
          <div className="flex items-center gap-2 mt-4 flex-wrap">
            <span className="text-[10px] text-[var(--text-muted)] uppercase tracking-wider font-medium">{t('Examples:')}</span>
            {[
              { name: 'DeerFlow', url: 'https://github.com/bytedance/deer-flow' },
              { name: 'GPT-Researcher', url: 'https://github.com/assafelovic/gpt-researcher' },
              { name: 'DeepWiki', url: 'https://github.com/AsyncFuncAI/deepwiki-open' },
            ].map((ex) => (
              <button
                key={ex.name}
                onClick={() => setRepoUrl(ex.url)}
                className="rounded-full border border-[var(--glass-border)] bg-white/[0.02] px-2.5 py-0.5 text-[10px] font-mono text-[var(--text-muted)] hover:border-[var(--accent-blue)]/40 hover:text-[var(--text-primary)] transition-colors duration-200 cursor-pointer"
              >
                {ex.name}
              </button>
            ))}
          </div>
        </div>
      </section>

      {/* Queue */}
      <ScanQueue
        queue={queue}
        activeItemId={activeItemId}
        phase={phase}
        progress={progress}
        onRemove={removeFromQueue}
        onRetry={retryItem}
        onCancel={cancelCurrent}
        onClearDone={clearDone}
      />

      {/* Progress & Logs for active scan */}
      {phase !== 'idle' && (
        <section className="mb-8">
          <div className="glass-card p-6">
            <div className="flex items-center justify-between mb-3">
              <span className="text-sm text-[var(--text-secondary)]">{t(PHASE_KEYS[phase] || '')}</span>
              <span className="text-xs font-mono text-[var(--text-muted)]">{progress}%</span>
            </div>
            <div className="w-full h-1.5 bg-[var(--code-bg)] rounded-full overflow-hidden mb-4">
              <div
                className="h-full rounded-full transition-all duration-500 ease-out"
                style={{
                  width: `${progress}%`,
                  backgroundColor: phase === 'error' ? '#ef4444' : (phase === 'done' || phase === 'all_done') ? '#10b981' : '#3B82F6',
                }}
              />
            </div>
            <div className="bg-[var(--bg-secondary)] rounded-lg overflow-hidden">
              <ScanLogPanel
                entries={logEntries}
                isRunning={phase !== 'done' && phase !== 'all_done' && phase !== 'error'}
              />
            </div>
          </div>
        </section>
      )}

      {/* Results */}
      {displayResults.length > 0 && (
        <section>
          <h2 className="text-lg font-medium text-[var(--text-secondary)] mb-4">
            {t('Scan Results')}
            <span className="text-sm font-normal text-[var(--text-muted)] ml-2">{t('Matched {{count}} domains', { count: displayResults.length })}</span>
          </h2>
          <div className="flex flex-col gap-3">
            {displayResults.map((r) => {
              const domain = DOMAINS.find((d) => d.id === r.domain_id);
              return (
                <div key={r.domain_id} className="glass-card p-5 flex items-start gap-4">
                  {domain && <DomainIcon name={domain.icon} color={domain.color} className="w-6 h-6 shrink-0 mt-0.5" />}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-sm font-medium text-[var(--text-primary)]">{r.title}</span>
                      <span className="text-[10px] font-mono text-[var(--text-muted)]">{r.domain_id}</span>
                      <span
                        className="ml-auto text-[10px] font-bold px-1.5 py-0.5 rounded border"
                        style={{
                          color: domain?.color,
                          borderColor: `${domain?.color}30`,
                          backgroundColor: `${domain?.color}10`,
                        }}
                      >
                        {Math.round(r.confidence * 100)}% match
                      </span>
                    </div>
                    <p className="text-xs text-[var(--text-secondary)] mb-2">{r.description}</p>
                    <div className="flex flex-wrap gap-1">
                      {r.files.map((f) => (
                        <span key={f} className="rounded-full border border-[var(--glass-border)] bg-white/[0.02] px-2 py-0.5 text-[10px] font-mono text-[var(--text-muted)]">
                          {f}
                        </span>
                      ))}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
          <div className="flex items-center gap-3 mt-6">
            <a href="/" className="glass-card inline-flex items-center gap-2 px-5 py-2.5 text-sm text-[var(--text-secondary)] hover:text-[var(--text-primary)] cursor-pointer transition-colors duration-200">
              {t('View domain overview')}
            </a>
          </div>
        </section>
      )}
    </div>
  );
}