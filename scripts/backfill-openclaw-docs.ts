#!/usr/bin/env tsx
// 补生成 OpenClaw 缺失的特性文档（14 个新域 PD-34 ~ PD-47）
// 用法: npx tsx scripts/backfill-openclaw-docs.ts

import path from 'path';
import { CCRunner, CCProgressEvent } from '../src/lib/cc-runner';
import { scanDynamicDomains } from '../src/lib/scan-domains';
import { getDomainById, invalidateDomainsCache } from '../src/data/domains';

const REPO_URL = 'https://github.com/openclaw/openclaw';
const PROJECT_NAME = 'openclaw';
const REPO_PATH = '/tmp/butcher-scan-openclaw';
const PROJECT_ROOT = path.resolve(process.cwd());

// 需要补生成的域 ID 范围
const MISSING_IDS = new Set(
  Array.from({ length: 14 }, (_, i) => `PD-${34 + i}`)
);

interface DomainInfo {
  id: string;
  title: string;
  tags: string[];
}

function getMissingDomains(): DomainInfo[] {
  const dynDomains = scanDynamicDomains();
  return dynDomains
    .filter(d => MISSING_IDS.has(d.id))
    .map(d => ({ id: d.id, title: d.title, tags: d.tags || [] }));
}

// 串行生成，每次一个域，避免资源争抢
async function generateDoc(domain: DomainInfo): Promise<boolean> {
  return new Promise((resolve) => {
    const tagsStr = domain.tags.join(', ');

    // 查找已有对比维度和元数据
    invalidateDomainsCache();
    const domainData = getDomainById(domain.id);
    const existingSubs = domainData?.sub_problems.join('；') || '';
    const existingBPs = domainData?.best_practices.slice(0, 5).join('；') || '';
    const metaHint = existingSubs
      ? `\n该域已有子问题：${existingSubs}\n该域已有最佳实践：${existingBPs}\n请在 domain_metadata 中只添加新的、不重复的内容。`
      : '';

    const prompt = `/butcher-doc ${domain.id} ${REPO_PATH}

项目: ${PROJECT_NAME}
GitHub: ${REPO_URL}
域: ${domain.id} ${domain.title}
匹配信号: ${tagsStr}
关键文件: （请自行搜索 ${REPO_PATH} 中与 ${domain.title} 相关的文件）
描述: OpenClaw 项目中 ${domain.title} 的实现方案${metaHint}`;

    console.log(`\n${'='.repeat(60)}`);
    console.log(`[${domain.id}] 开始生成: ${domain.title}`);
    console.log(`${'='.repeat(60)}`);

    const runner = new CCRunner({
      prompt,
      cwd: PROJECT_ROOT,
      timeoutMs: 300_000,
      noOutputTimeoutMs: 240_000,
      allowedTools: 'Bash Read Glob Grep Write Edit',
      skipResultExtraction: true,
    });

    runner.on('event', (event: CCProgressEvent) => {
      const ts = new Date().toLocaleTimeString();
      switch (event.type) {
        case 'log':
          console.log(`  [${ts}] ${String(event.data).slice(0, 150)}`);
          break;
        case 'tool_use': {
          const d = event.data as Record<string, unknown>;
          console.log(`  [${ts}] TOOL: ${d.tool} [${d.status}]`);
          break;
        }
        case 'error':
          console.error(`  [${ts}] ERROR: ${event.data}`);
          break;
        case 'done':
          console.log(`  [${ts}] ✓ ${domain.id} 完成`);
          resolve(true);
          break;
      }
    });

    // 超时兜底
    setTimeout(() => {
      console.error(`  [${domain.id}] 超时，跳过`);
      runner.kill();
      resolve(false);
    }, 310_000);

    runner.start();
  });
}

async function main() {
  const missing = getMissingDomains();
  console.log(`找到 ${missing.length} 个缺失域需要补生成文档:\n`);
  missing.forEach(d => console.log(`  ${d.id} ${d.title}`));

  let success = 0;
  let failed = 0;

  for (let i = 0; i < missing.length; i++) {
    const domain = missing[i];
    console.log(`\n进度: ${i + 1}/${missing.length}`);
    const ok = await generateDoc(domain);
    if (ok) success++;
    else failed++;
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log(`全部完成: ${success} 成功, ${failed} 失败`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('脚本失败:', err);
  process.exit(1);
});
