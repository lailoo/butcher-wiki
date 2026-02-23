'use client';

import { useState, useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { DomainIcon } from '@/components/ui/DomainIcon';
import { ScanLogPanel, type LogEntry, type ToolCallEvent } from '@/components/scan/ScanLogPanel';

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

type ScanPhase = 'idle' | 'cloning' | 'scanning' | 'extracting' | 'matching' | 'doc_generating' | 'all_done' | 'done' | 'error';

interface ScanResult {
  domain_id: string;
  title: string;
  description: string;
  files: string[];
  confidence: number;
}

interface CachedScan {
  url: string;
  results: ScanResult[];
  timestamp: number;
}

const PHASE_KEYS: Record<ScanPhase, string> = {
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

// --- 扫描缓存 ---
const CACHE_KEY = 'butcher-wiki-scan-cache';

function getCachedScans(): CachedScan[] {
  try {
    return JSON.parse(localStorage.getItem(CACHE_KEY) || '[]');
  } catch { return []; }
}

function getCachedResult(url: string): ScanResult[] | null {
  const normalized = url.replace(/\/+$/, '').replace(/\.git$/, '');
  const cached = getCachedScans().find(
    (c) => c.url.replace(/\/+$/, '').replace(/\.git$/, '') === normalized,
  );
  return cached ? cached.results : null;
}

function saveScanCache(url: string, results: ScanResult[]) {
  const normalized = url.replace(/\/+$/, '').replace(/\.git$/, '');
  const existing = getCachedScans().filter(
    (c) => c.url.replace(/\/+$/, '').replace(/\.git$/, '') !== normalized,
  );
  existing.unshift({ url: normalized, results, timestamp: Date.now() });
  // 最多缓存 20 个项目
  localStorage.setItem(CACHE_KEY, JSON.stringify(existing.slice(0, 20)));
}

export default function ScanPage() {
  const { t } = useTranslation();
  const [repoUrl, setRepoUrl] = useState('');
  const [phase, setPhase] = useState<ScanPhase>('idle');
  const [progress, setProgress] = useState(0);
  const [logEntries, setLogEntries] = useState<LogEntry[]>([]);
  const [results, setResults] = useState<ScanResult[]>([]);
  const [error, setError] = useState('');
  const [fromCache, setFromCache] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const addTextLog = useCallback((msg: string) => {
    setLogEntries((prev) => [...prev, { kind: 'text', message: msg, timestamp: Date.now() }]);
  }, []);

  const addOrUpdateToolCall = useCallback((event: ToolCallEvent) => {
    setLogEntries((prev) => {
      // 如果已有同 id 的 tool entry，更新它（running → done）
      const idx = prev.findIndex(e => e.kind === 'tool' && e.event.id === event.id);
      if (idx >= 0) {
        const next = [...prev];
        next[idx] = { kind: 'tool', event };
        return next;
      }
      return [...prev, { kind: 'tool', event }];
    });
  }, []);

  const handleScan = async () => {
    if (!repoUrl.trim()) return;

    // 检查缓存
    const cached = getCachedResult(repoUrl);
    if (cached) {
      setPhase('done');
      setProgress(100);
      setResults(cached);
      setFromCache(true);
      setLogEntries([{ kind: 'text', message: t('Cached result for this project'), timestamp: Date.now() }]);
      setError('');
      return;
    }

    // Reset state
    setPhase('cloning');
    setProgress(0);
    setLogEntries([]);
    setResults([]);
    setError('');
    setFromCache(false);

    const controller = new AbortController();
    abortRef.current = controller;

    addTextLog(`开始扫描: ${repoUrl}`);

    try {
      const response = await fetch('/api/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repoUrl }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || '扫描请求失败');
      }

      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          try {
            const event = JSON.parse(line.slice(6));
            switch (event.type) {
              case 'phase':
                setPhase(event.data as ScanPhase);
                break;
              case 'log':
                addTextLog(event.data as string);
                break;
              case 'progress':
                setProgress(event.data as number);
                break;
              case 'tool_use':
                addOrUpdateToolCall(event.data as ToolCallEvent);
                break;
              case 'result':
                setResults(event.data as ScanResult[]);
                saveScanCache(repoUrl, event.data as ScanResult[]);
                break;
              case 'doc_progress': {
                const dp = event.data as { completed: number; total: number };
                addTextLog(t('Doc progress: {{completed}}/{{total}}', { completed: dp.completed, total: dp.total }));
                break;
              }
              case 'error':
                setError(event.data as string);
                setPhase('error');
                break;
              case 'done':
                setPhase(prev => prev === 'all_done' ? prev : 'done');
                addTextLog(t('All done!'));
                break;
            }
          } catch {
            // 忽略解析错误
          }
        }
      }
    } catch (e) {
      if ((e as Error).name === 'AbortError') {
        setPhase('error');
        setError(t('Scan cancelled'));
        addTextLog(t('User cancelled scan'));
      } else {
        setPhase('error');
        setError(e instanceof Error ? e.message : '未知错误');
        addTextLog(`错误: ${e instanceof Error ? e.message : '未知错误'}`);
      }
    } finally {
      abortRef.current = null;
    }
  };

  const handleCancel = () => {
    abortRef.current?.abort();
  };

  const handleRescan = () => {
    // 清除该 URL 的缓存并重新扫描
    const normalized = repoUrl.replace(/\/+$/, '').replace(/\.git$/, '');
    const existing = getCachedScans().filter(
      (c) => c.url.replace(/\/+$/, '').replace(/\.git$/, '') !== normalized,
    );
    localStorage.setItem(CACHE_KEY, JSON.stringify(existing));
    setFromCache(false);
    setPhase('idle');
    setResults([]);
    setLogEntries([]);
    setProgress(0);
    // 触发重新扫描
    setTimeout(() => handleScan(), 50);
  };

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
                onChange={(e) => setRepoUrl(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && phase === 'idle' && handleScan()}
                placeholder="https://github.com/owner/repo"
                disabled={phase !== 'idle' && phase !== 'done' && phase !== 'all_done' && phase !== 'error'}
                className="w-full bg-[var(--code-bg)] border border-[var(--glass-border)] rounded-xl px-4 py-3 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:border-[var(--accent-blue)]/50 focus:ring-1 focus:ring-[var(--accent-blue)]/20 transition-all duration-200 font-mono disabled:opacity-50"
              />
              {/* URL validation hint */}
              {repoUrl && !repoUrl.match(/^https?:\/\//) && (
                <p className="absolute -bottom-5 left-0 text-[10px] text-rose-400/70">{t('Enter full URL (https://)')}</p>
              )}
            </div>
            <button
              onClick={phase !== 'idle' && phase !== 'done' && phase !== 'all_done' && phase !== 'error' ? handleCancel : handleScan}
              disabled={!repoUrl.trim()}
              className="shrink-0 px-6 py-3 rounded-xl text-sm font-medium transition-all duration-200 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed bg-[var(--accent-blue)]/20 border border-[var(--accent-blue)]/30 text-[var(--accent-blue)] hover:bg-[var(--accent-blue)]/30 hover:border-[var(--accent-blue)]/50"
            >
              {phase === 'idle' || phase === 'done' || phase === 'all_done' || phase === 'error' ? (
                <span className="flex items-center gap-2">
                  <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M3 2l9 9" /><path d="M12 11l9-9" /><path d="M12 11v11" /><path d="M8 22h8" />
                  </svg>
                  {t('Start Butchering')}
                </span>
              ) : (
                <span className="flex items-center gap-2">
                  <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="3" y="3" width="18" height="18" rx="2" />
                  </svg>
                  {t('Cancel')}
                </span>
              )}
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

      {/* Progress & Logs */}
      {phase !== 'idle' && (
        <section className="mb-8">
          <div className="glass-card p-6">
            {/* Progress bar */}
            <div className="flex items-center justify-between mb-3">
              <span className="text-sm text-[var(--text-secondary)]">{t(PHASE_KEYS[phase])}</span>
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

            {/* Structured log panel */}
            <div className="bg-[var(--bg-secondary)] rounded-lg overflow-hidden">
              <ScanLogPanel
                entries={logEntries}
                isRunning={phase !== 'done' && phase !== 'all_done' && phase !== 'error'}
              />
            </div>

            {error && (
              <p className="mt-3 text-sm text-rose-400">{error}</p>
            )}
          </div>
        </section>
      )}

      {/* Scan Results */}
      {results.length > 0 && (
        <section>
          <h2 className="text-lg font-medium text-[var(--text-secondary)] mb-4">
            {t('Scan Results')}
            <span className="text-sm font-normal text-[var(--text-muted)] ml-2">{t('Matched {{count}} domains', { count: results.length })}</span>
            {fromCache && (
              <span className="text-xs font-normal text-[var(--accent-blue)] ml-2">{t('(cached)')}</span>
            )}
          </h2>
          <div className="flex flex-col gap-3">
            {results.map((r) => {
              const domain = DOMAINS.find((d) => d.id === r.domain_id);
              return (
                <div
                  key={r.domain_id}
                  className="glass-card p-5 flex items-start gap-4"
                >
                  {domain && (
                    <DomainIcon name={domain.icon} color={domain.color} className="w-6 h-6 shrink-0 mt-0.5" />
                  )}
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
                        <span
                          key={f}
                          className="rounded-full border border-[var(--glass-border)] bg-white/[0.02] px-2 py-0.5 text-[10px] font-mono text-[var(--text-muted)]"
                        >
                          {f}
                        </span>
                      ))}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Action buttons after scan */}
          <div className="flex items-center gap-3 mt-6">
            <a
              href="/"
              className="glass-card inline-flex items-center gap-2 px-5 py-2.5 text-sm text-[var(--text-secondary)] hover:text-[var(--text-primary)] cursor-pointer transition-colors duration-200"
            >
              {t('View domain overview')}
            </a>
            {fromCache && (
              <button
                onClick={handleRescan}
                className="glass-card inline-flex items-center gap-2 px-5 py-2.5 text-sm text-[var(--accent-blue)] hover:text-[var(--text-primary)] cursor-pointer transition-colors duration-200"
              >
                {t('Rescan')}
              </button>
            )}
            <button
              onClick={() => { setPhase('idle'); setResults([]); setLogEntries([]); setProgress(0); setFromCache(false); }}
              className="glass-card inline-flex items-center gap-2 px-5 py-2.5 text-sm text-[var(--text-secondary)] hover:text-[var(--text-primary)] cursor-pointer transition-colors duration-200"
            >
              {t('Scan another project')}
            </button>
          </div>
        </section>
      )}
    </div>
  );
}
