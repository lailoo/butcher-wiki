// Trending 扫描状态持久化 — 读写 knowledge/trending-state.json

import fs from 'fs';
import path from 'path';
import type { TrendingRepo } from './trending-fetch';

const STATE_FILE = path.join(process.cwd(), 'knowledge', 'trending-state.json');

export interface ScannedRepo {
  url: string;
  scannedAt: number;
  status: 'success' | 'error';
  domainsFound: number;
  error?: string;
}

export interface TrendingState {
  lastFetchedAt: number;
  trendingRepos: TrendingRepo[];
  scannedRepos: ScannedRepo[];
  consecutiveErrors: number;
  lastError?: string;
}

const EMPTY_STATE: TrendingState = {
  lastFetchedAt: 0,
  trendingRepos: [],
  scannedRepos: [],
  consecutiveErrors: 0,
};

/** 读取状态文件 */
export function loadTrendingState(): TrendingState {
  try {
    if (!fs.existsSync(STATE_FILE)) return { ...EMPTY_STATE };
    const content = fs.readFileSync(STATE_FILE, 'utf-8');
    return { ...EMPTY_STATE, ...JSON.parse(content) };
  } catch {
    return { ...EMPTY_STATE };
  }
}

/** 写入状态文件 */
export function saveTrendingState(state: TrendingState): void {
  const dir = path.dirname(STATE_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf-8');
}

/** 获取未扫描的 trending repos */
export function getUnscannedRepos(state: TrendingState): TrendingRepo[] {
  const scannedUrls = new Set(state.scannedRepos.map(r => r.url));
  return state.trendingRepos.filter(r => !scannedUrls.has(r.url));
}

/** 标记 repo 为已扫描 */
export function markRepoScanned(
  state: TrendingState,
  url: string,
  result: { status: 'success' | 'error'; domainsFound: number; error?: string },
): void {
  // 去重：如果已有记录则更新
  state.scannedRepos = state.scannedRepos.filter(r => r.url !== url);
  state.scannedRepos.push({
    url,
    scannedAt: Date.now(),
    status: result.status,
    domainsFound: result.domainsFound,
    error: result.error,
  });
}
