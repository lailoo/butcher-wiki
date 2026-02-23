'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';

// 工具调用事件（与 cc-runner.ts CCToolCallEvent 对应）
export interface ToolCallEvent {
  id: string;
  tool: string;
  status: 'running' | 'done' | 'error';
  input: string;
  output?: string;
  exitCode?: number;
  durationMs?: number;
  startedAt: number;
}

// 日志条目：纯文本 或 结构化工具调用
export type LogEntry =
  | { kind: 'text'; message: string; timestamp: number }
  | { kind: 'tool'; event: ToolCallEvent };

// --- 工具图标 ---
const TOOL_ICONS: Record<string, { icon: string; label: string; color: string }> = {
  Bash:  { icon: '⚡', label: 'Bash',  color: '#f59e0b' },
  Read:  { icon: '📄', label: 'Read',  color: '#3b82f6' },
  Glob:  { icon: '🔍', label: 'Glob',  color: '#8b5cf6' },
  Grep:  { icon: '🔎', label: 'Grep',  color: '#10b981' },
};

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString('zh-CN', { hour12: false });
}

// --- ToolCallItem: 单个工具调用卡片 ---
function ToolCallItem({ event }: { event: ToolCallEvent }) {
  const [expanded, setExpanded] = useState(false);
  const meta = TOOL_ICONS[event.tool] || { icon: '🔧', label: event.tool, color: '#6b7280' };
  const { t } = useTranslation();
  const hasOutput = event.output && event.output.length > 0;

  // 简化 input 显示
  const shortInput = event.input.length > 120 ? event.input.slice(0, 120) + '…' : event.input;

  return (
    <div className="group border border-[var(--glass-border)] rounded-lg bg-[var(--code-bg)] overflow-hidden">
      {/* Header */}
      <button
        onClick={() => hasOutput && setExpanded(!expanded)}
        className={`w-full flex items-center gap-2 px-3 py-2 text-left text-xs ${hasOutput ? 'cursor-pointer hover:bg-white/[0.03]' : 'cursor-default'} transition-colors`}
      >
        {/* 工具图标 + 名称 */}
        <span className="shrink-0 text-sm">{meta.icon}</span>
        <span
          className="shrink-0 font-mono font-medium text-[10px] px-1.5 py-0.5 rounded border"
          style={{ color: meta.color, borderColor: `${meta.color}30`, backgroundColor: `${meta.color}10` }}
        >
          {meta.label}
        </span>

        {/* Input */}
        <span className="flex-1 font-mono text-[var(--text-secondary)] truncate">{shortInput}</span>

        {/* Status + Duration */}
        <span className="shrink-0 flex items-center gap-1.5">
          {event.status === 'running' && (
            <span className="flex items-center gap-1 text-[var(--accent-blue)]">
              <span className="inline-block w-1.5 h-1.5 rounded-full bg-[var(--accent-blue)] animate-pulse" />
              {t('running')}
            </span>
          )}
          {event.status === 'done' && (
            <>
              {event.tool === 'Bash' && event.exitCode !== undefined && (
                <span
                  className="font-mono text-[10px] px-1 py-0.5 rounded"
                  style={{
                    color: event.exitCode === 0 ? '#10b981' : '#ef4444',
                    backgroundColor: event.exitCode === 0 ? '#10b98110' : '#ef444410',
                  }}
                >
                  exit {event.exitCode}
                </span>
              )}
              {event.durationMs !== undefined && (
                <span className="font-mono text-[10px] text-[var(--text-muted)]">
                  {formatDuration(event.durationMs)}
                </span>
              )}
              <span className="text-emerald-500">✓</span>
            </>
          )}
          {event.status === 'error' && <span className="text-rose-400">✗</span>}

          {/* 展开箭头 */}
          {hasOutput && (
            <svg
              className={`w-3 h-3 text-[var(--text-muted)] transition-transform ${expanded ? 'rotate-180' : ''}`}
              viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
            >
              <polyline points="6 9 12 15 18 9" />
            </svg>
          )}
        </span>
      </button>

      {/* Output (collapsible) */}
      {expanded && hasOutput && (
        <div className="border-t border-[var(--glass-border)] px-3 py-2 max-h-60 overflow-y-auto">
          <pre className="font-mono text-[10px] text-[var(--text-muted)] whitespace-pre-wrap break-words leading-relaxed">
            {event.output}
          </pre>
        </div>
      )}
    </div>
  );
}

// --- ScanLogPanel: 主面板 ---
interface ScanLogPanelProps {
  entries: LogEntry[];
  isRunning: boolean;
}

export function ScanLogPanel({ entries, isRunning }: ScanLogPanelProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const [filter, setFilter] = useState<'all' | 'tools' | 'text'>('all');
  const { t } = useTranslation();

  // 自动滚动到底部
  useEffect(() => {
    if (autoScroll && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [entries, autoScroll]);

  // 检测用户手动滚动
  const handleScroll = useCallback(() => {
    if (!scrollRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = scrollRef.current;
    setAutoScroll(scrollHeight - scrollTop - clientHeight < 40);
  }, []);

  const filtered = entries.filter((e) => {
    if (filter === 'tools') return e.kind === 'tool';
    if (filter === 'text') return e.kind === 'text';
    return true;
  });

  const toolCount = entries.filter(e => e.kind === 'tool').length;
  const runningCount = entries.filter(e => e.kind === 'tool' && e.event.status === 'running').length;

  return (
    <div className="flex flex-col">
      {/* Toolbar */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-[var(--glass-border)]">
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-mono text-[var(--text-muted)] uppercase tracking-wider">{t('Log')}</span>
          {toolCount > 0 && (
            <span className="text-[10px] font-mono text-[var(--text-muted)]">
              {t('{{count}} tool calls', { count: toolCount })}
              {runningCount > 0 && <span className="text-[var(--accent-blue)] ml-1">({runningCount} {t('running')})</span>}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          {(['all', 'tools', 'text'] as const).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`px-2 py-0.5 rounded text-[10px] font-mono transition-colors cursor-pointer ${
                filter === f
                  ? 'bg-[var(--accent-blue)]/20 text-[var(--accent-blue)] border border-[var(--accent-blue)]/30'
                  : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)]'
              }`}
            >
              {{ all: t('All'), tools: t('Tools'), text: t('Text') }[f]}
            </button>
          ))}
        </div>
      </div>

      {/* Log entries */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="max-h-80 overflow-y-auto p-3 space-y-1.5"
      >
        {filtered.map((entry, i) => {
          if (entry.kind === 'tool') {
            return <ToolCallItem key={entry.event.id + '-' + entry.event.status} event={entry.event} />;
          }
          return (
            <p
              key={`text-${i}`}
              className={`text-xs font-mono px-1 ${
                i === filtered.length - 1 && isRunning
                  ? 'text-[var(--text-secondary)]'
                  : 'text-[var(--text-muted)]'
              }`}
            >
              <span className="text-[var(--text-muted)]/50 mr-2">{formatTime(entry.timestamp)}</span>
              {entry.message}
            </p>
          );
        })}
        {isRunning && (
          <p className="text-[var(--accent-blue)] animate-pulse text-xs">▌</p>
        )}
      </div>
    </div>
  );
}