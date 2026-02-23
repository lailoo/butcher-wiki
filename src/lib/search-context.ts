// 构建 LLM 搜索上下文 — 精简的知识库摘要供 system prompt 使用

import { ALL_DOMAINS } from '@/data/domains';
import { KNOWLEDGE_DOCS } from '@/data/knowledge-docs';

/** 生成精简的知识库摘要文本，用于 LLM system prompt */
export function buildSearchContext(): string {
  const lines: string[] = ['Butcher Wiki 知识库包含以下 Agent 工程问题域：\n'];

  for (const d of ALL_DOMAINS) {
    lines.push(`## ${d.id} ${d.title} (${d.subtitle})`);
    lines.push(`slug: ${d.slug} | severity: ${d.severity} | tags: ${d.tags.join(', ')}`);
    lines.push(`描述: ${d.description.slice(0, 120)}`);
    lines.push('方案:');
    for (const s of d.solutions) {
      lines.push(`  - [${s.project}] ${s.title.slice(0, 80)} | signals: ${s.signals.slice(0, 5).join(', ')}`);
    }
    // 知识文档
    const docs = KNOWLEDGE_DOCS.filter(k => k.domain_id === d.id);
    if (docs.length > 0) {
      lines.push('知识文档:');
      for (const doc of docs) {
        lines.push(`  - slug: ${doc.slug} | ${doc.title}`);
      }
    }
    lines.push('');
  }

  return lines.join('\n');
}

/** 生成单个域的知识上下文文本 */
export function buildDomainContext(domainId: string): string {
  const d = ALL_DOMAINS.find(x => x.id === domainId);
  if (!d) return '';
  const lines: string[] = [`# ${d.id} ${d.title} (${d.subtitle})\n`];
  lines.push(`描述: ${d.description}`);
  lines.push(`\n子问题:`);
  for (const p of d.sub_problems) lines.push(`  - ${p}`);
  lines.push(`\n方案:`);
  for (const s of d.solutions) {
    lines.push(`  - [${s.project}] ${s.title}`);
    lines.push(`    ${s.description.slice(0, 200)}`);
    lines.push(`    signals: ${s.signals.join(', ')}`);
  }
  if (d.comparison_dimensions.length > 0) {
    lines.push(`\n横向对比:`);
    for (const dim of d.comparison_dimensions) {
      lines.push(`  ${dim.name}:`);
      for (const [proj, val] of Object.entries(dim.values)) {
        lines.push(`    - ${proj}: ${val}`);
      }
    }
  }
  if (d.best_practices.length > 0) {
    lines.push(`\n最佳实践:`);
    for (const bp of d.best_practices) lines.push(`  - ${bp}`);
  }
  const docs = KNOWLEDGE_DOCS.filter(k => k.domain_id === d.id);
  if (docs.length > 0) {
    lines.push(`\n知识文档:`);
    for (const doc of docs) lines.push(`  - ${doc.slug} | ${doc.title}`);
  }
  return lines.join('\n');
}

/** 获取所有可匹配的 ID 列表，供 LLM 参考 */
export function getMatchableIds() {
  const domainSlugs = ALL_DOMAINS.map(d => ({ slug: d.slug, id: d.id, title: d.title }));
  const knowledgeSlugs = KNOWLEDGE_DOCS.map(k => ({ slug: k.slug, domain_id: k.domain_id, project: k.project, title: k.title }));
  const solutions = ALL_DOMAINS.flatMap(d =>
    d.solutions.map(s => ({ project: s.project, domain_id: d.id, domain_slug: d.slug, title: s.title }))
  );
  return { domainSlugs, knowledgeSlugs, solutions };
}
