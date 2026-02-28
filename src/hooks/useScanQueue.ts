'use client';

import { useState, useRef, useCallback, useEffect } from 'react';
import type { LogEntry, ToolCallEvent } from '@/components/scan/ScanLogPanel';

export interface ScanResult {
  domain_id: string;
  title: string;
  description: string;
  files: string[];
  confidence: number;
}

export interface QueueItem {
  id: string;
  repoUrl: string;
  status: 'pending' | 'scanning' | 'done' | 'error';
  addedAt: number;
  results?: ScanResult[];
  error?: string;
}

export type ScanPhase = 'idle' | 'cloning' | 'scanning' | 'extracting' | 'matching' | 'doc_generating' | 'all_done' | 'done' | 'error';

const QUEUE_KEY = 'butcher-wiki-scan-queue';
const CACHE_KEY = 'butcher-wiki-scan-cache';

function normalizeUrl(url: string) {
  return url.replace(/\/+$/, '').replace(/\.git$/, '');
}

function loadQueue(): QueueItem[] {
  try {
    const raw = localStorage.getItem(QUEUE_KEY);
    if (!raw) return [];
    const items: QueueItem[] = JSON.parse(raw);
    // Reset any "scanning" items to "pending" on reload (interrupted scans)
    return items.map(item => item.status === 'scanning' ? { ...item, status: 'pending' as const } : item);
  } catch { return []; }
}

function saveQueue(items: QueueItem[]) {
  localStorage.setItem(QUEUE_KEY, JSON.stringify(items));
}

// PLACEHOLDER_CACHE

interface CachedScan {
  url: string;
  results: ScanResult[];
  timestamp: number;
}

function getCachedScans(): CachedScan[] {
  try { return JSON.parse(localStorage.getItem(CACHE_KEY) || '[]'); }
  catch { return []; }
}

function saveScanCache(url: string, results: ScanResult[]) {
  const normalized = normalizeUrl(url);
  const existing = getCachedScans().filter(c => normalizeUrl(c.url) !== normalized);
  existing.unshift({ url: normalized, results, timestamp: Date.now() });
  localStorage.setItem(CACHE_KEY, JSON.stringify(existing.slice(0, 20)));
}

export function useScanQueue() {
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [phase, setPhase] = useState<ScanPhase>('idle');
  const [progress, setProgress] = useState(0);
  const [logEntries, setLogEntries] = useState<LogEntry[]>([]);
  const [activeItemId, setActiveItemId] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const processingRef = useRef(false);

  // Load queue from localStorage on mount
  useEffect(() => {
    setQueue(loadQueue());
  }, []);

  // Persist queue changes
  const updateQueue = useCallback((updater: (prev: QueueItem[]) => QueueItem[]) => {
    setQueue(prev => {
      const next = updater(prev);
      saveQueue(next);
      return next;
    });
  }, []);

  const addTextLog = useCallback((msg: string) => {
    setLogEntries(prev => [...prev, { kind: 'text', message: msg, timestamp: Date.now() }]);
  }, []);

  const addOrUpdateToolCall = useCallback((event: ToolCallEvent) => {
    setLogEntries(prev => {
      const idx = prev.findIndex(e => e.kind === 'tool' && e.event.id === event.id);
      if (idx >= 0) {
        const next = [...prev];
        next[idx] = { kind: 'tool', event };
        return next;
      }
      return [...prev, { kind: 'tool', event }];
    });
  }, []);

  // Run a single scan for a queue item
  const runScan = useCallback(async (item: QueueItem) => {
    processingRef.current = true;
    setActiveItemId(item.id);
    setPhase('cloning');
    setProgress(0);
    setLogEntries([]);

    updateQueue(prev => prev.map(q => q.id === item.id ? { ...q, status: 'scanning' as const } : q));

    const controller = new AbortController();
    abortRef.current = controller;

    addTextLog(`开始扫描: ${item.repoUrl}`);

    try {
      const response = await fetch('/api/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repoUrl: item.repoUrl }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || '扫描请求失败');
      }

      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let scanResults: ScanResult[] = [];

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
                scanResults = event.data as ScanResult[];
                saveScanCache(item.repoUrl, scanResults);
                break;
              case 'doc_progress': {
                const dp = event.data as { completed: number; total: number };
                addTextLog(`文档生成进度: ${dp.completed}/${dp.total}`);
                break;
              }
              case 'error':
                throw new Error(event.data as string);
              case 'done':
                setPhase(prev => prev === 'all_done' ? prev : 'done');
                addTextLog('扫描完成！');
                break;
            }
          } catch (parseErr) {
            if (parseErr instanceof Error && parseErr.message !== 'Unexpected end of JSON input') {
              throw parseErr;
            }
          }
        }
      }

      // Mark done
      updateQueue(prev => prev.map(q =>
        q.id === item.id ? { ...q, status: 'done' as const, results: scanResults } : q
      ));
    } catch (e) {
      const errMsg = (e as Error).name === 'AbortError' ? '用户取消扫描' : ((e as Error).message || '未知错误');
      setPhase('error');
      addTextLog(`错误: ${errMsg}`);
      updateQueue(prev => prev.map(q =>
        q.id === item.id ? { ...q, status: 'error' as const, error: errMsg } : q
      ));
    } finally {
      abortRef.current = null;
      processingRef.current = false;
      setActiveItemId(null);
    }
  }, [updateQueue, addTextLog, addOrUpdateToolCall]);

  // Process next pending item
  const processNext = useCallback(() => {
    if (processingRef.current) return;
    const next = queue.find(q => q.status === 'pending');
    if (next) {
      processingRef.current = true; // Lock immediately to prevent double-start
      setTimeout(() => runScan(next), 0);
    } else {
      setPhase('idle');
    }
  }, [queue, runScan]);

  // Auto-process when queue changes and nothing is running
  useEffect(() => {
    if (!processingRef.current && queue.some(q => q.status === 'pending')) {
      processNext();
    }
  }, [queue, processNext]);

  const addToQueue = useCallback((url: string): string | null => {
    const normalized = normalizeUrl(url);
    // Duplicate check
    const existing = queue.find(q => normalizeUrl(q.repoUrl) === normalized && (q.status === 'pending' || q.status === 'scanning'));
    if (existing) return '该仓库已在队列中';

    const item: QueueItem = {
      id: String(Date.now()),
      repoUrl: url.trim(),
      status: 'pending',
      addedAt: Date.now(),
    };
    updateQueue(prev => [...prev, item]);
    return null;
  }, [queue, updateQueue]);

  const removeFromQueue = useCallback((id: string) => {
    updateQueue(prev => prev.filter(q => q.id !== id || q.status === 'scanning'));
  }, [updateQueue]);

  const retryItem = useCallback((id: string) => {
    updateQueue(prev => prev.map(q =>
      q.id === id && q.status === 'error' ? { ...q, status: 'pending' as const, error: undefined } : q
    ));
  }, [updateQueue]);

  const cancelCurrent = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const clearDone = useCallback(() => {
    updateQueue(prev => prev.filter(q => q.status !== 'done' && q.status !== 'error'));
  }, [updateQueue]);

  return {
    queue,
    phase,
    progress,
    logEntries,
    activeItemId,
    addToQueue,
    removeFromQueue,
    retryItem,
    cancelCurrent,
    clearDone,
    isScanning: processingRef.current || queue.some(q => q.status === 'scanning'),
  };
}
