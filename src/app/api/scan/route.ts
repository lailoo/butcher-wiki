import { NextRequest } from 'next/server';
import path from 'path';
import fs from 'fs';
import { exec } from 'child_process';
import { CCRunner, CCProgressEvent } from '@/lib/cc-runner';
import { buildCCPrompt } from '@/lib/scan-prompt';
import { getDomainById, ALL_DOMAINS, invalidateDomainsCache } from '@/data/domains';
import { getNextDomainId, writeDynamicDomain, type DynamicDomainDef } from '@/lib/scan-domains';
import { KNOWLEDGE_DOCS, invalidateKnowledgeDocsCache } from '@/data/knowledge-docs';
import { translateDomainBackground } from '@/lib/translate-background';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const PROJECT_ROOT = path.resolve(process.cwd());

interface SSEEvent {
  type: string;
  data: unknown;
}

interface ScanMatch {
  domain_id: string;
  title: string;
  description: string;
  files: string[];
  confidence: number;
  signals?: string[];
  source_files_detail?: Array<{ file: string; lines: string; description: string }>;
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

/** 处理扫描结果中的新域提案，写入 JSON 文件并返回 NEW-X → PD-XX 映射 */
function processNewDomains(
  newDomains: NewDomainProposal[],
  emit: (event: SSEEvent) => void,
): Map<string, string> {
  const mapping = new Map<string, string>(); // NEW-1 → PD-13
  if (!newDomains || newDomains.length === 0) return mapping;

  const existingIds = ALL_DOMAINS.map(d => d.id);
  const VALID_ICONS = new Set([
    'brain', 'network', 'shield', 'wrench', 'box', 'database', 'check-circle',
    'search', 'user-check', 'layers', 'activity', 'zap', 'knife', 'sparkles',
    'message-circle', 'eye', 'lock', 'cpu', 'globe', 'file-text', 'terminal',
    'refresh-cw', 'clock', 'link', 'settings', 'alert-triangle', 'code', 'git-branch',
  ]);
  const FALLBACK_ICON: Record<string, string> = {
    'critical': 'zap', 'high': 'shield', 'medium': 'sparkles',
  };
  const FALLBACK_COLOR: Record<string, string> = {
    'critical': '#ef4444', 'high': '#f59e0b', 'medium': '#8b5cf6',
  };

  for (let i = 0; i < newDomains.length; i++) {
    const proposal = newDomains[i];
    const newId = getNextDomainId(existingIds);
    existingIds.push(newId);
    mapping.set(`NEW-${i + 1}`, newId);

    const icon = proposal.icon && VALID_ICONS.has(proposal.icon)
      ? proposal.icon
      : FALLBACK_ICON[proposal.severity] || 'sparkles';
    const color = proposal.color && /^#[0-9a-fA-F]{6}$/.test(proposal.color)
      ? proposal.color
      : FALLBACK_COLOR[proposal.severity] || '#8b5cf6';

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
    // Fire-and-forget: translate new domain to English
    translateDomainBackground(newId, def.slug).catch(() => {});
    emit({ type: 'log', data: `发现新域 ${newId} ${proposal.title}，已创建定义文件` });
  }

  return mapping;
}

/** 检查某个域+项目的知识文档是否已存在（增量更新） */
function docAlreadyExists(domainId: string, projectName: string): boolean {
  // 检查 KNOWLEDGE_DOCS 中是否已有该域+项目的文档
  const exists = KNOWLEDGE_DOCS.some(
    k => k.domain_id === domainId && k.project.toLowerCase() === projectName.toLowerCase()
  );
  if (exists) return true;
  // 也检查文件系统（可能是动态扫描到的）
  const solutionsDir = path.join(process.cwd(), 'knowledge', 'solutions');
  if (!fs.existsSync(solutionsDir)) return false;
  const prefix = `${domainId}-${projectName}`;
  return fs.readdirSync(solutionsDir).some(f => f.startsWith(prefix) && f.endsWith('.md'));
}

function parseGitHubUrl(url: string): { owner: string; repo: string } | null {
  const m = url.match(/github\.com\/([^/]+)\/([^/\s#?]+)/);
  if (!m) return null;
  return { owner: m[1], repo: m[2].replace(/\.git$/, '') };
}

/** 预克隆仓库到本地（避免 CCRunner watchdog 超时） */
async function preCloneRepo(repoUrl: string, targetDir: string): Promise<void> {
  if (fs.existsSync(targetDir) && fs.readdirSync(targetDir).length > 1) {
    console.log(`[scan] 仓库已存在: ${targetDir}，跳过克隆`);
    return;
  }
  const delays = [0, 10_000, 30_000];
  for (let i = 0; i < delays.length; i++) {
    if (delays[i] > 0) {
      await new Promise(r => setTimeout(r, delays[i]));
    }
    try {
      await new Promise<void>((resolve, reject) => {
        const cmd = `rm -rf ${targetDir} && git clone --depth=1 ${repoUrl} ${targetDir}`;
        console.log(`[scan] 预克隆 (第${i + 1}次): ${cmd}`);
        exec(cmd, { timeout: 3_000_000 }, (err, _stdout, stderr) => {
          if (err) {
            console.error(`[scan] 预克隆失败: ${stderr || err.message}`);
            reject(new Error(err.message));
          } else {
            resolve();
          }
        });
      });
      console.log(`[scan] 预克隆完成: ${targetDir}`);
      return;
    } catch (err) {
      if (i === delays.length - 1) throw new Error(`预克隆失败（${delays.length}次重试后）: ${(err as Error).message}`);
    }
  }
}

/** Fallback: 从 CC done 事件的 resultText 中提取 JSON */
function extractResultFromEvent(eventData: unknown): ScanResult | null {
  const data = eventData as Record<string, unknown> | undefined;
  const text = data?.resultText as string | undefined;
  if (!text) return null;

  // 尝试找平衡的 JSON 对象
  const firstBrace = text.indexOf('{');
  if (firstBrace === -1) return null;

  let depth = 0;
  let inString = false;
  let escape = false;
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
        } catch { /* continue searching */ }
      }
    }
  }
  return null;
}

// PLACEHOLDER_DOC_GEN

/** Phase 2: 为每个匹配域触发 butcher-doc skill 生成文档 */
function startDocGeneration(
  repoUrl: string,
  projectName: string,
  repoPath: string,
  matches: ScanMatch[],
  emit: (event: SSEEvent) => void,
  onAllDone: () => void,
  abortSignal: AbortSignal,
) {
  const qualified = matches.filter(m => m.confidence >= 0.6);
  if (qualified.length === 0) {
    emit({ type: 'log', data: '没有 confidence >= 0.6 的域，跳过文档生成' });
    onAllDone();
    return;
  }

  emit({ type: 'phase', data: 'doc_generating' });
  emit({ type: 'log', data: `开始为 ${qualified.length} 个域生成知识文档...` });

  let completed = 0;
  const total = qualified.length;
  const finished = new Set<string>(); // 防止重复计数

  for (const match of qualified) {
    const filesStr = match.files.join(', ');
    const signalsStr = (match.signals || []).join(', ');

    // 查找该域的已有对比维度名，注入到 prompt 中确保 CC 用对名字
    const domain = getDomainById(match.domain_id);
    const existingDims = domain?.comparison_dimensions.map(d => d.name).join('、') || '';
    const dimsHint = existingDims
      ? `\n该域已有对比维度：${existingDims}\n请在第 7 章 comparison_data 中优先使用这些维度名，确保跨项目可比。`
      : '';
    const existingSubs = domain?.sub_problems.join('；') || '';
    const existingBPs = domain?.best_practices.slice(0, 5).join('；') || '';
    const metaHint = `\n该域已有子问题：${existingSubs}\n该域已有最佳实践：${existingBPs}\n请在 domain_metadata 中只添加新的、不重复的内容。`;

    // 简短 prompt — CC 会自动加载 .claude/skills/butcher-doc/SKILL.md
    const prompt = `/butcher-doc ${match.domain_id} ${repoPath}

项目: ${projectName}
GitHub: ${repoUrl}
域: ${match.domain_id} ${match.title}
匹配信号: ${signalsStr}
关键文件: ${filesStr}
描述: ${match.description}${dimsHint}${metaHint}`;

    emit({ type: 'log', data: `[${match.domain_id}] 启动文档生成: ${match.title}` });

    const docRunner = new CCRunner({
      prompt,
      cwd: PROJECT_ROOT,
      timeoutMs: 30_000_000,
      noOutputTimeoutMs: 600_000,
      allowedTools: 'Bash Read Glob Grep Write Edit',
      skipResultExtraction: true,
    });

    docRunner.on('event', (event: CCProgressEvent) => {
      switch (event.type) {
        case 'tool_use':
          emit({ type: 'tool_use', data: event.data });
          break;
        case 'log':
          emit({ type: 'log', data: `[${match.domain_id}] ${event.data}` });
          break;
        case 'error':
          emit({ type: 'log', data: `[${match.domain_id}] ⚠ ${event.data}` });
          break;
        case 'done': {
          if (!finished.has(match.domain_id)) {
            finished.add(match.domain_id);
            completed++;
            emit({ type: 'log', data: `[${match.domain_id}] ✓ 文档生成完成 (${completed}/${total})` });
            emit({ type: 'doc_progress', data: { completed, total, domain_id: match.domain_id } });
            // 文档生成进度: 50% → 95%（100% 留给 all_done）
            const docProgress = Math.round(50 + (completed / total) * 45);
            emit({ type: 'progress', data: docProgress });
            if (completed >= total) onAllDone();
          }
          break;
        }
        default:
          break;
      }
    });

    abortSignal.addEventListener('abort', () => docRunner.kill());
    docRunner.start();
  }
}

// PLACEHOLDER_POST

export async function POST(req: NextRequest) {
  const { repoUrl } = await req.json();

  const parsed = parseGitHubUrl(repoUrl);
  if (!parsed) {
    return Response.json({ error: '无效的 GitHub URL' }, { status: 400 });
  }

  const repoName = repoUrl.replace(/\/+$/, '').split('/').pop()?.replace(/\.git$/, '') || 'unknown';
  const repoPath = `/tmp/butcher-scan-${repoName}`;
  const encoder = new TextEncoder();

  // 预克隆仓库（在 SSE stream 之前完成，避免 CCRunner watchdog 超时）
  try {
    await preCloneRepo(repoUrl, repoPath);
  } catch (err) {
    const msg = err instanceof Error ? err.message : '预克隆失败';
    return Response.json({ error: msg }, { status: 500 });
  }

  const { system, prompt, resultFile } = buildCCPrompt(repoUrl, { preCloned: true });

  const stream = new ReadableStream({
    start(controller) {
      const emit = (event: SSEEvent) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        } catch { /* controller may be closed */ }
      };

      // Phase 1: Scan
      emit({ type: 'phase', data: 'scanning' });
      emit({ type: 'log', data: `仓库已预克隆，启动 Claude Code 分析 ${parsed.owner}/${parsed.repo}...` });
      emit({ type: 'progress', data: 15 });

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

      let scanMatches: ScanMatch[] = [];

      /** 从结果文件读取扫描结果 */
      function readResultFile(): ScanResult | null {
        try {
          if (!fs.existsSync(resultFile)) return null;
          const content = fs.readFileSync(resultFile, 'utf-8');
          return JSON.parse(content) as ScanResult;
        } catch {
          return null;
        }
      }

      /** 处理扫描结果（来自文件或文本解析） */
      function processScanResult(result: ScanResult) {
        let rawMatches = result.matches || [];
        const newDomains = result.new_domains || [];

        // 处理新域提案
        const domainMapping = processNewDomains(newDomains, emit);

        // 新域写入后刷新缓存，后续 getDomainById 能找到新域
        if (domainMapping.size > 0) {
          invalidateDomainsCache();
        }

        // 替换 NEW-X → PD-XX
        scanMatches = rawMatches.map(m => {
          const mappedId = domainMapping.get(m.domain_id);
          return mappedId ? { ...m, domain_id: mappedId } : m;
        });

        // 兜底：如果 new_domain 没有对应 match，自动补一个
        for (let i = 0; i < newDomains.length; i++) {
          const tempId = `NEW-${i + 1}`;
          const realId = domainMapping.get(tempId);
          if (!realId) continue;
          const hasMatch = scanMatches.some(m => m.domain_id === realId || m.domain_id === tempId);
          if (!hasMatch) {
            const proposal = newDomains[i];
            scanMatches.push({
              domain_id: realId,
              title: proposal.title,
              description: proposal.description,
              files: [],
              confidence: 0.7,
              signals: proposal.tags || [],
            });
            emit({ type: 'log', data: `[${realId}] 自动补充 match: ${proposal.title}` });
          }
        }

        // 增量过滤
        const projectName = parsed!.repo;        const beforeCount = scanMatches.length;
        scanMatches = scanMatches.filter(m => {
          if (docAlreadyExists(m.domain_id, projectName)) {
            emit({ type: 'log', data: `[${m.domain_id}] 已有 ${projectName} 文档，跳过` });
            return false;
          }
          return true;
        });
        const skipped = beforeCount - scanMatches.length;

        emit({ type: 'log', data: `扫描完成: 命中 ${beforeCount} 个问题域${skipped > 0 ? `（${skipped} 个已有文档，跳过）` : ''}${newDomains.length > 0 ? `，发现 ${newDomains.length} 个新域` : ''}` });
        emit({ type: 'result', data: scanMatches });

        const qualified = scanMatches.filter(m => m.confidence >= 0.6);
        if (qualified.length > 0) {
          emit({ type: 'progress', data: 50 });
        } else {
          emit({ type: 'progress', data: 100 });
        }
      }

      scanRunner.on('event', (event: CCProgressEvent) => {
        switch (event.type) {
          case 'phase':
          case 'log':
          case 'progress':
            emit({ type: event.type, data: event.data });
            break;
          case 'tool_use':
            emit({ type: 'tool_use', data: event.data });
            break;
          case 'error':
            emit({ type: 'error', data: event.data });
            break;
          case 'done': {
            // CC 完成 → 优先从文件读取结果，fallback 到文本解析
            let scanResult: ScanResult | null = readResultFile();
            if (scanResult && scanResult.matches) {
              emit({ type: 'log', data: '从结果文件读取扫描结果成功' });
            } else {
              // fallback: 从 CC 输出文本中解析 JSON
              emit({ type: 'log', data: '结果文件未找到，尝试从输出文本解析...' });
              scanResult = extractResultFromEvent(event.data);
            }

            if (scanResult && scanResult.matches) {
              processScanResult(scanResult);
            } else {
              emit({ type: 'error', data: '扫描完成但未能获取结果（文件和文本解析均失败）' });
            }

            // 清理结果文件
            try { if (fs.existsSync(resultFile)) fs.unlinkSync(resultFile); } catch { /* ignore */ }

            // Phase 2: 文档生成
            if (scanMatches.length > 0) {
              startDocGeneration(
                repoUrl,
                parsed.repo,
                repoPath,
                scanMatches,
                emit,
                () => {
                  invalidateDomainsCache(); // 文档生成完毕，刷新缓存
                  invalidateKnowledgeDocsCache();
                  emit({ type: 'progress', data: 100 });
                  emit({ type: 'phase', data: 'all_done' });
                  emit({ type: 'log', data: '所有文档生成完成！' });
                  emit({ type: 'done', data: event.data });
                  controller.close();
                },
                req.signal,
              );
            } else {
              emit({ type: 'done', data: event.data });
              controller.close();
            }
            break;
          }
        }
      });

      req.signal.addEventListener('abort', () => scanRunner.kill());
      scanRunner.start();
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
}
