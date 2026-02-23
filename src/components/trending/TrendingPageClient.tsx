'use client';

import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';

interface TrendingRepo {
  owner: string;
  repo: string;
  url: string;
  description: string;
  language: string;
  starsToday: number;
  fetchedAt: number;
}

interface ScannedRepo {
  url: string;
  scannedAt: number;
  status: 'success' | 'error';
  domainsFound: number;
  error?: string;
}

interface TrendingState {
  lastFetchedAt: number;
  trendingRepos: TrendingRepo[];
  scannedRepos: ScannedRepo[];
  unscannedCount: number;
}

export function TrendingPageClient() {
  const { t } = useTranslation();
  const [state, setState] = useState<TrendingState | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [scanning, setScanning] = useState(false);

  // 加载状态
  const fetchState = useCallback(async () => {
    try {
      const res = await fetch('/api/trending');
      if (res.ok) setState(await res.json());
    } catch { /* ignore */ }
    setLoading(false);
  }, []);

  useEffect(() => { fetchState(); }, [fetchState]);

  // 刷新 trending 列表
  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      await fetch('/api/trending', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'refresh' }),
      });
      await fetchState();
    } catch { /* ignore */ }
    setRefreshing(false);
  };

  // 扫描下 2 个
  const handleScanNext = async () => {
    setScanning(true);
    try {
      await fetch('/api/trending', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'scan-next' }),
      });
      await fetchState();
    } catch { /* ignore */ }
    setScanning(false);
  };

  // 获取 repo 的扫描状态
  const getRepoStatus = (url: string): ScannedRepo | undefined => {
    return state?.scannedRepos.find(r => r.url === url);
  };

  // 语言颜色映射
  const langColor = (lang: string) => {
    const colors: Record<string, string> = {
      Python: '#3572A5', TypeScript: '#3178c6', JavaScript: '#f1e05a',
      Go: '#00ADD8', Rust: '#dea584', Java: '#b07219', 'C++': '#f34b7d',
      Ruby: '#701516', Swift: '#F05138', Kotlin: '#A97BFF',
    };
    return colors[lang] || '#8b8b8b';
  };

  if (loading) {
    return (
      <div className="max-w-5xl mx-auto px-6 pt-28 pb-16">
        <div className="text-center text-[var(--text-muted)]">Loading...</div>
      </div>
    );
  }

  const repos = state?.trendingRepos || [];
  const scannedCount = state?.scannedRepos.length || 0;
  const unscannedCount = state?.unscannedCount || 0;

  return (
    <div className="max-w-5xl mx-auto px-6 pt-28 pb-16">
      {/* Header */}
      <div className="mb-8">
        <h1 className="text-2xl font-bold mb-2">GitHub Trending Scanner</h1>
        <p className="text-sm text-[var(--text-muted)]">{t('trending_desc')}</p>
      </div>

      {/* Stats + Actions */}
      <div className="flex items-center justify-between mb-6 flex-wrap gap-3">
        <div className="flex items-center gap-4 text-sm">
          <span className="text-[var(--text-secondary)]">
            {t('trending_repos', { count: repos.length })}
          </span>
          <span className="text-emerald-400">
            {t('scanned_count', { count: scannedCount })}
          </span>
          <span className="text-[var(--text-muted)]">
            {t('unscanned_count', { count: unscannedCount })}
          </span>
          {state?.lastFetchedAt ? (
            <span className="text-xs text-[var(--text-muted)]">
              {t('Last updated')}: {new Date(state.lastFetchedAt).toLocaleString()}
            </span>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={handleRefresh}
            disabled={refreshing}
            className="px-4 py-2 text-sm rounded-lg border border-[var(--glass-border)] bg-[var(--glass-bg)] hover:bg-[var(--glass-border)] transition-colors cursor-pointer disabled:opacity-50"
          >
            {refreshing ? t('Refreshing...') : t('Refresh Trending')}
          </button>
          <button
            onClick={handleScanNext}
            disabled={scanning || unscannedCount === 0}
            className="px-4 py-2 text-sm rounded-lg bg-[var(--accent-blue)] text-white hover:opacity-90 transition-colors cursor-pointer disabled:opacity-50"
          >
            {scanning ? t('Scanning...') : unscannedCount === 0 ? t('All scanned') : t('Scan Next 2')}
          </button>
        </div>
      </div>

      {/* Repo List */}
      {repos.length === 0 ? (
        <div className="glass-card p-12 text-center">
          <p className="text-[var(--text-muted)]">{t('No trending data')}</p>
        </div>
      ) : (
        <div className="space-y-2">
          {repos.map((repo) => {
            const scanned = getRepoStatus(repo.url);
            return (
              <div
                key={repo.url}
                className="glass-card px-5 py-4 flex items-center gap-4"
              >
                {/* Status badge */}
                <div className="shrink-0 w-16">
                  {scanned ? (
                    scanned.status === 'success' ? (
                      <span className="text-xs px-2 py-1 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                        {t('Scanned')}
                      </span>
                    ) : (
                      <span className="text-xs px-2 py-1 rounded-full bg-rose-500/10 text-rose-400 border border-rose-500/20">
                        {t('Scan failed')}
                      </span>
                    )
                  ) : (
                    <span className="text-xs px-2 py-1 rounded-full bg-amber-500/10 text-amber-400 border border-amber-500/20">
                      {t('Pending')}
                    </span>
                  )}
                </div>

                {/* Repo info */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <a
                      href={repo.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-sm font-medium text-[var(--text-primary)] hover:text-[var(--accent-blue)] transition-colors"
                    >
                      {repo.owner}/{repo.repo}
                    </a>
                    {repo.language && (
                      <span className="flex items-center gap-1 text-xs text-[var(--text-muted)]">
                        <span
                          className="w-2 h-2 rounded-full inline-block"
                          style={{ backgroundColor: langColor(repo.language) }}
                        />
                        {repo.language}
                      </span>
                    )}
                  </div>
                  {repo.description && (
                    <p className="text-xs text-[var(--text-muted)] mt-1 line-clamp-1">{repo.description}</p>
                  )}
                </div>

                {/* Stars + domains */}
                <div className="shrink-0 flex items-center gap-4 text-xs text-[var(--text-muted)]">
                  {repo.starsToday > 0 && (
                    <span className="flex items-center gap-1">
                      <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>
                      {t('stars_today', { count: repo.starsToday })}
                    </span>
                  )}
                  {scanned?.status === 'success' && scanned.domainsFound > 0 && (
                    <span className="text-emerald-400">
                      {t('domains_found', { count: scanned.domainsFound })}
                    </span>
                  )}
                  {scanned?.error && (
                    <span className="text-rose-400 max-w-[200px] truncate" title={scanned.error}>
                      {scanned.error}
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
