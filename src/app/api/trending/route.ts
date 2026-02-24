import { NextRequest, NextResponse } from 'next/server';
import { fetchTrendingRepos } from '@/lib/trending-fetch';
import {
  loadTrendingState,
  saveTrendingState,
  getUnscannedRepos,
  markRepoScanned,
} from '@/lib/trending-state';
import { CCRunner, CCProgressEvent } from '@/lib/cc-runner';
import { buildCCPrompt } from '@/lib/scan-prompt';
import { ALL_DOMAINS, invalidateDomainsCache } from '@/data/domains';
import { getNextDomainId, writeDynamicDomain, type DynamicDomainDef } from '@/lib/scan-domains';
import { KNOWLEDGE_DOCS, invalidateKnowledgeDocsCache } from '@/data/knowledge-docs';
import { translateDomainBackground } from '@/lib/translate-background';
import { exec } from 'child_process';
import path from 'path';
import fs from 'fs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const PROJECT_ROOT = path.resolve(process.cwd());

// GET: 返回当前 trending 状态
export async function GET() {
  const state = loadTrendingState();
  const unscanned = getUnscannedRepos(state);
  return NextResponse.json({
    ...state,
    unscannedCount: unscanned.length,
  });
}

// POST: 触发操作
// body: { action: 'refresh' | 'scan-next', language?: string }
export async function POST(req: NextRequest) {
  const { action, language } = await req.json();

  if (action === 'refresh') {
    return handleRefresh(language);
  }

  if (action === 'scan-next') {
    return handleScanNext();
  }

  return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
}

/** 刷新 trending 列表 */
async function handleRefresh(language?: string) {
  try {
    const repos = await fetchTrendingRepos(language);
    const state = loadTrendingState();
    state.trendingRepos = repos;
    state.lastFetchedAt = Date.now();
    saveTrendingState(state);
    return NextResponse.json({ ok: true, count: repos.length });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Fetch failed';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

/** 扫描下 2 个未扫描的 trending 项目 */
async function handleScanNext() {
  const state = loadTrendingState();
  const unscanned = getUnscannedRepos(state);

  if (unscanned.length === 0) {
    return NextResponse.json({ ok: true, message: 'No unscanned repos', scanned: [] });
  }

  const batch = unscanned.slice(0, 2);
  const results: Array<{ url: string; status: string; domainsFound: number; error?: string }> = [];

  for (const repo of batch) {
    try {
      const scanResult = await runScanForRepo(repo.url);
      markRepoScanned(state, repo.url, {
        status: 'success',
        domainsFound: scanResult.matchCount,
      });
      results.push({ url: repo.url, status: 'success', domainsFound: scanResult.matchCount });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Scan failed';
      markRepoScanned(state, repo.url, { status: 'error', domainsFound: 0, error: msg });
      results.push({ url: repo.url, status: 'error', domainsFound: 0, error: msg });
    }
    saveTrendingState(state);
  }

  state.consecutiveErrors = results.every(r => r.status === 'error')
    ? state.consecutiveErrors + 1
    : 0;
  saveTrendingState(state);

  return NextResponse.json({ ok: true, scanned: results });
}

// --- 扫描核心逻辑（复用 scan route 的 CCRunner 管线）---

interface ScanMatch {
  domain_id: string;
  title: string;
  description: string;
  files: string[];
  confidence: number;
  signals?: string[];
}

interface NewDomainProposal {
  slug: string;
  title: string;
  subtitle: string;
  icon?: string;
  color?: string;
  severity: 'critical' | 'high' | 'medium';
  description: string;
  tags: string[];
  sub_problems: string[];
  best_practices: string[];
}

interface ScanResult {
  project: string;
  repo: string;
  matches: ScanMatch[];
  new_domains?: NewDomainProposal[];
}

/** 预克隆仓库到本地（避免 CCRunner watchdog 超时） */
async function preCloneRepo(repoUrl: string, targetDir: string): Promise<void> {
  // 如果目录已存在且有内容，跳过克隆
  if (fs.existsSync(targetDir) && fs.readdirSync(targetDir).length > 1) {
    console.log(`[trending] 仓库已存在: ${targetDir}，跳过克隆`);
    return;
  }

  const delays = [0, 10_000, 30_000]; // 重试间隔
  for (let i = 0; i < delays.length; i++) {
    if (delays[i] > 0) {
      console.log(`[trending] 等待 ${delays[i] / 1000}s 后重试...`);
      await new Promise(r => setTimeout(r, delays[i]));
    }
    try {
      await new Promise<void>((resolve, reject) => {
        const cmd = `rm -rf ${targetDir} && git clone --depth=1 ${repoUrl} ${targetDir}`;
        console.log(`[trending] 预克隆 (第${i + 1}次): ${cmd}`);
        exec(cmd, { timeout: 3_000_000 }, (err, _stdout, stderr) => {
          if (err) {
            console.error(`[trending] 预克隆失败: ${stderr || err.message}`);
            reject(new Error(err.message));
          } else {
            resolve();
          }
        });
      });
      console.log(`[trending] 预克隆完成: ${targetDir}`);
      return;
    } catch (err) {
      if (i === delays.length - 1) throw new Error(`预克隆失败（${delays.length}次重试后）: ${(err as Error).message}`);
    }
  }
}

/** 对单个 repo 执行完整扫描（Phase 1 + Phase 2），返回匹配数 */
async function runScanForRepo(repoUrl: string): Promise<{ matchCount: number }> {
  const repoName = repoUrl.replace(/\/+$/, '').split('/').pop()?.replace(/\.git$/, '') || 'unknown';
  const repoPath = `/tmp/butcher-scan-${repoName}`;

  // 先预克隆，不受 CCRunner watchdog 限制
  await preCloneRepo(repoUrl, repoPath);

  const { system, prompt, resultFile } = buildCCPrompt(repoUrl, { preCloned: true });

  console.log(`[trending] 开始扫描: ${repoUrl}`);

  return new Promise((resolve, reject) => {
    const scanRunner = new CCRunner({
      prompt,
      systemPrompt: system,
      cwd: PROJECT_ROOT,
      timeoutMs: 1_800_000,
      noOutputTimeoutMs: 600_000,
      allowedTools: 'Bash Read Glob Grep Write',
      disallowedTools: 'TodoWrite Task',
      maxBudgetUsd: 500,
      skipResultExtraction: true,
    });

    scanRunner.on('event', (event: CCProgressEvent) => {
      if (event.type === 'log') {
        console.log(`[trending][${repoName}] ${event.data}`);
      } else if (event.type === 'error') {
        console.error(`[trending][${repoName}] ERROR: ${event.data}`);
      } else if (event.type === 'done') {
        // 读取结果
        let scanResult: ScanResult | null = null;
        try {
          if (fs.existsSync(resultFile)) {
            scanResult = JSON.parse(fs.readFileSync(resultFile, 'utf-8'));
          }
        } catch { /* fallback below */ }

        if (!scanResult) {
          // fallback: 从 CC 输出文本解析
          scanResult = extractResultFromText(event.data);
        }

        // 清理结果文件
        try { if (fs.existsSync(resultFile)) fs.unlinkSync(resultFile); } catch { /* ignore */ }

        if (!scanResult || !scanResult.matches) {
          reject(new Error('扫描完成但未获取到结果'));
          return;
        }

        // 处理新域
        const newDomains = scanResult.new_domains || [];
        let domainMapping = new Map<string, string>();
        if (newDomains.length > 0) {
          domainMapping = processNewDomains(newDomains);
          invalidateDomainsCache();
        }

        // 替换 NEW-X → PD-XX
        let allMatches = (scanResult.matches || []).map(m => {
          const mappedId = domainMapping.get(m.domain_id);
          return mappedId ? { ...m, domain_id: mappedId } : m;
        });

        // 兜底：如果 new_domain 没有对应 match，自动补一个
        for (let i = 0; i < newDomains.length; i++) {
          const tempId = `NEW-${i + 1}`;
          const realId = domainMapping.get(tempId);
          if (!realId) continue;
          const hasMatch = allMatches.some(m => m.domain_id === realId || m.domain_id === tempId);
          if (!hasMatch) {
            const proposal = newDomains[i];
            allMatches.push({
              domain_id: realId,
              title: proposal.title,
              description: proposal.description,
              files: [],
              confidence: 0.7,
              signals: proposal.tags || [],
            });
            console.log(`[trending][${repoName}] 自动补充 match: ${realId} ${proposal.title}`);
          }
        }

        // 过滤已有文档的域
        const parsed = repoUrl.match(/github\.com\/([^/]+)\/([^/\s#?]+)/);
        const projectName = parsed ? parsed[2].replace(/\.git$/, '') : repoName;
        const matches = allMatches.filter(m => !docAlreadyExists(m.domain_id, projectName));

        console.log(`[trending][${repoName}] 扫描完成: ${matches.length} 个新域匹配`);

        // Phase 2: 文档生成
        const qualified = matches.filter(m => m.confidence >= 0.6);
        if (qualified.length === 0) {
          resolve({ matchCount: matches.length });
          return;
        }

        startDocGeneration(repoUrl, projectName, repoPath, qualified, () => {
          invalidateDomainsCache();
          invalidateKnowledgeDocsCache();
          console.log(`[trending][${repoName}] 文档生成完成`);
          resolve({ matchCount: matches.length });
        });
      }
    });

    scanRunner.start();
  });
}

/** 从 CC done 事件中提取 JSON 结果 */
function extractResultFromText(eventData: unknown): ScanResult | null {
  const data = eventData as Record<string, unknown> | undefined;
  const text = data?.resultText as string | undefined;
  if (!text) return null;

  const firstBrace = text.indexOf('{');
  if (firstBrace === -1) return null;

  let depth = 0, inString = false, escape = false;
  for (let i = firstBrace; i < text.length; i++) {
    const ch = text[i];
    if (escape) { escape = false; continue; }
    if (ch === '\\' && inString) { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') depth++;
    if (ch === '}') {
      depth--;
      if (depth === 0) {
        try {
          const result = JSON.parse(text.slice(firstBrace, i + 1));
          if (result.matches) return result as ScanResult;
        } catch { /* continue */ }
      }
    }
  }
  return null;
}

/** 处理新域提案，返回 NEW-X → PD-XX 映射 */
function processNewDomains(newDomains: NewDomainProposal[]): Map<string, string> {
  const mapping = new Map<string, string>();
  const existingIds = ALL_DOMAINS.map(d => d.id);
  const VALID_ICONS = new Set([
    'brain', 'network', 'shield', 'wrench', 'box', 'database', 'check-circle',
    'search', 'user-check', 'layers', 'activity', 'zap', 'knife', 'sparkles',
  ]);

  for (let i = 0; i < newDomains.length; i++) {
    const proposal = newDomains[i];
    const newId = getNextDomainId(existingIds);
    existingIds.push(newId);
    mapping.set(`NEW-${i + 1}`, newId);

    const icon = proposal.icon && VALID_ICONS.has(proposal.icon) ? proposal.icon : 'sparkles';
    const color = proposal.color && /^#[0-9a-fA-F]{6}$/.test(proposal.color) ? proposal.color : '#8b5cf6';

    const def: DynamicDomainDef = {
      id: newId,
      slug: proposal.slug,
      title: proposal.title,
      subtitle: proposal.subtitle,
      icon,
      color,
      severity: proposal.severity || 'medium',
      description: proposal.description,
      tags: proposal.tags || [],
      sub_problems: proposal.sub_problems || [],
      best_practices: proposal.best_practices || [],
    };

    writeDynamicDomain(def);
    translateDomainBackground(newId, def.slug).catch(() => {});
    console.log(`[trending] 发现新域 ${newId} ${proposal.title}`);
  }
  return mapping;
}

/** 检查文档是否已存在 */
function docAlreadyExists(domainId: string, projectName: string): boolean {
  const exists = KNOWLEDGE_DOCS.some(
    k => k.domain_id === domainId && k.project.toLowerCase() === projectName.toLowerCase()
  );
  if (exists) return true;
  const solutionsDir = path.join(process.cwd(), 'knowledge', 'solutions');
  if (!fs.existsSync(solutionsDir)) return false;
  const prefix = `${domainId}-${projectName}`;
  return fs.readdirSync(solutionsDir).some(f => f.startsWith(prefix) && f.endsWith('.md'));
}

/** Phase 2: 文档生成 */
function startDocGeneration(
  repoUrl: string,
  projectName: string,
  repoPath: string,
  matches: ScanMatch[],
  onAllDone: () => void,
) {
  let completed = 0;
  const total = matches.length;

  for (const match of matches) {
    const filesStr = match.files.join(', ');
    const signalsStr = (match.signals || []).join(', ');

    const prompt = `/butcher-doc ${match.domain_id} ${repoPath}

项目: ${projectName}
GitHub: ${repoUrl}
域: ${match.domain_id} ${match.title}
匹配信号: ${signalsStr}
关键文件: ${filesStr}
描述: ${match.description}`;

    const docRunner = new CCRunner({
      prompt,
      cwd: PROJECT_ROOT,
      timeoutMs: 300_000,
      noOutputTimeoutMs: 240_000,
      allowedTools: 'Bash Read Glob Grep Write Edit',
      skipResultExtraction: true,
    });

    docRunner.on('event', (event: CCProgressEvent) => {
      if (event.type === 'done') {
        completed++;
        console.log(`[trending][${projectName}] 文档 ${match.domain_id} 完成 (${completed}/${total})`);
        if (completed >= total) onAllDone();
      } else if (event.type === 'error') {
        console.error(`[trending][${projectName}] 文档 ${match.domain_id} 错误: ${event.data}`);
      }
    });

    docRunner.start();
  }
}
