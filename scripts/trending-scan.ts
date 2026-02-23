#!/usr/bin/env tsx
// GitHub Trending 自动扫描脚本 — self-driving setTimeout 循环
// 用法: npm run trending
// 需要 dev server 运行中 (npm run dev)

import 'dotenv/config';

const BASE_URL = process.env.TRENDING_BASE_URL || 'http://localhost:3000';
const SCAN_INTERVAL_MS = 2 * 60 * 60 * 1000; // 2 小时
const MAX_TIMER_DELAY_MS = 60_000; // 60s 防止时钟漂移
const TRENDING_STALE_MS = 60 * 60 * 1000; // 1 小时后刷新 trending 列表
const ERROR_BACKOFF = [30_000, 60_000, 300_000, 900_000, 3_600_000];

let consecutiveErrors = 0;
let lastTickAt = 0;

function log(msg: string) {
  const ts = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  console.log(`[${ts}] ${msg}`);
}

/** 检查 dev server 是否可达 */
async function checkServer(): Promise<boolean> {
  try {
    const res = await fetch(`${BASE_URL}/api/trending`, { method: 'GET' });
    return res.ok;
  } catch {
    return false;
  }
}

/** 执行一次扫描周期 */
async function tick() {
  lastTickAt = Date.now();
  log('--- tick start ---');

  // 检查 server
  if (!(await checkServer())) {
    log('⚠ Dev server 不可达，跳过本轮');
    consecutiveErrors++;
    armTimer();
    return;
  }

  try {
    // 1. 检查是否需要刷新 trending 列表
    const stateRes = await fetch(`${BASE_URL}/api/trending`);
    const state = await stateRes.json();

    if (!state.lastFetchedAt || Date.now() - state.lastFetchedAt > TRENDING_STALE_MS) {
      log('刷新 GitHub Trending 列表...');
      const refreshRes = await fetch(`${BASE_URL}/api/trending`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'refresh' }),
      });
      const refreshData = await refreshRes.json();
      if (refreshData.error) {
        throw new Error(`Refresh failed: ${refreshData.error}`);
      }
      log(`获取到 ${refreshData.count} 个 trending 项目`);
    } else {
      log(`Trending 列表仍有效（${state.trendingRepos?.length || 0} 个项目，未扫描 ${state.unscannedCount || 0} 个）`);
    }

    // 2. 扫描下 2 个
    if ((state.unscannedCount || 0) > 0 || !state.lastFetchedAt) {
      log('开始扫描下 2 个项目...');
      const scanRes = await fetch(`${BASE_URL}/api/trending`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'scan-next' }),
      });
      const scanData = await scanRes.json();

      if (scanData.error) {
        throw new Error(`Scan failed: ${scanData.error}`);
      }

      if (scanData.scanned) {
        for (const r of scanData.scanned) {
          const icon = r.status === 'success' ? '✓' : '✗';
          log(`  ${icon} ${r.url} — ${r.domainsFound} 个域${r.error ? ` (${r.error})` : ''}`);
        }
      } else {
        log('没有待扫描的项目');
      }
    } else {
      log('所有 trending 项目已扫描完毕');
    }

    consecutiveErrors = 0;
  } catch (err) {
    consecutiveErrors++;
    const msg = err instanceof Error ? err.message : String(err);
    log(`✗ 错误 (连续 ${consecutiveErrors} 次): ${msg}`);
  }

  armTimer();
}

/** 设置下一次 tick 的定时器 */
function armTimer() {
  const delay = consecutiveErrors > 0
    ? ERROR_BACKOFF[Math.min(consecutiveErrors - 1, ERROR_BACKOFF.length - 1)]
    : SCAN_INTERVAL_MS;

  // 计算距离上次 tick 的时间，避免重复执行
  const elapsed = Date.now() - lastTickAt;
  const remaining = Math.max(delay - elapsed, 1000);
  const clamped = Math.min(remaining, MAX_TIMER_DELAY_MS);

  if (clamped < remaining) {
    // 还没到时间，先 sleep 一个 MAX_TIMER_DELAY 再检查
    setTimeout(() => armTimer(), clamped);
  } else {
    const mins = (delay / 60_000).toFixed(1);
    log(`下次扫描: ${mins} 分钟后${consecutiveErrors > 0 ? ` (退避 #${consecutiveErrors})` : ''}`);
    setTimeout(() => tick(), clamped);
  }
}

// --- 启动 ---
log('🔪 Butcher Wiki Trending Scanner 启动');
log(`目标: ${BASE_URL}`);
log(`间隔: ${SCAN_INTERVAL_MS / 60_000} 分钟`);
tick();
