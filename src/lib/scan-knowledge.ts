// 动态扫描 knowledge/solutions/ 目录，自动发现新生成的文档
// 文件名规律: PD-XX-ProjectName-中文标题.md

import fs from 'fs';
import path from 'path';

export interface DomainMetadata {
  description?: string;
  sub_problems?: string[];
  best_practices?: string[];
}

export interface ScannedDoc {
  filename: string;       // 不含 .md
  domain_id: string;      // PD-01
  project: string;        // PageIndex
  title: string;          // Token预算文档分割方案
  repo: string;           // 从文档 frontmatter 提取
  slug: string;           // URL slug
  comparisonDimensions?: Record<string, string>;  // 维度名 → 描述
  domainMetadata?: DomainMetadata;  // 域元数据补充
}

const SOLUTIONS_DIR = path.join(process.cwd(), 'knowledge', 'solutions');

// 文件名解析: PD-01-PageIndex-Token预算文档分割方案.md
const FILENAME_RE = /^(PD-\d{2})-([A-Za-z0-9_-]+)-(.+)$/;

function filenameToSlug(domainId: string, project: string, title: string): string {
  // PD-01 + PageIndex + Token预算文档分割方案 → pd01-pageindex-token
  // 只保留 ASCII 字母数字，去掉中文
  const pd = domainId.toLowerCase().replace('-', '');
  const proj = project.toLowerCase();
  // 从 title 中提取英文单词
  const englishWords = title.match(/[a-zA-Z0-9]+/g);
  const titlePart = englishWords ? englishWords.join('-').toLowerCase() : '';
  const slug = titlePart ? `${pd}-${proj}-${titlePart}` : `${pd}-${proj}`;
  return slug.replace(/-+/g, '-').replace(/^-|-$/g, '');
}

function extractRepoFromContent(content: string): string {
  const match = content.slice(0, 1000).match(/GitHub[：:]\s*(https:\/\/github\.com\/[^\s\n]+)/);
  return match ? match[1] : '';
}

/** 从文档 frontmatter 的 "> 来源：ProjectName ..." 行提取项目名 */
function extractProjectFromContent(content: string): string | undefined {
  const match = content.slice(0, 500).match(/>\s*来源[：:]\s*([A-Za-z0-9_-]+)/);
  return match ? match[1] : undefined;
}

/** 从文档中提取 ```json comparison_data 代码块 */
function extractComparisonData(content: string): Record<string, string> | undefined {
  const blockMatch = content.match(/```json\s+comparison_data\s*\n([\s\S]*?)```/);
  if (!blockMatch) return undefined;
  try {
    const data = JSON.parse(blockMatch[1]);
    if (data?.dimensions && typeof data.dimensions === 'object') {
      return data.dimensions as Record<string, string>;
    }
  } catch { /* ignore parse errors */ }
  return undefined;
}

/** 从文档中提取 ```json domain_metadata 代码块，或从 markdown 内容 fallback 提取 */
function extractDomainMetadata(content: string): DomainMetadata | undefined {
  // 优先从 JSON 代码块提取
  const blockMatch = content.match(/```json\s+domain_metadata\s*\n([\s\S]*?)```/);
  if (blockMatch) {
    try {
      const data = JSON.parse(blockMatch[1]);
      const meta: DomainMetadata = {};
      if (typeof data.description === 'string' && data.description) meta.description = data.description;
      if (Array.isArray(data.sub_problems) && data.sub_problems.length > 0) meta.sub_problems = data.sub_problems;
      if (Array.isArray(data.best_practices) && data.best_practices.length > 0) meta.best_practices = data.best_practices;
      if (Object.keys(meta).length > 0) return meta;
    } catch { /* ignore */ }
  }

  // Fallback: 从 markdown 内容提取 description
  // 尝试匹配 "### 1.2" 或 "### 1.1" 后的第一段非空文字
  const descMatch = content.match(/###\s+1\.[12][^\n]*\n+([^\n#][^\n]{20,})/);
  if (descMatch) {
    return { description: descMatch[1].trim().slice(0, 300) };
  }

  return undefined;
}

/** 扫描 knowledge/solutions/ 返回所有可解析的文档 */
export function scanKnowledgeDocs(): ScannedDoc[] {
  if (!fs.existsSync(SOLUTIONS_DIR)) return [];

  const files = fs.readdirSync(SOLUTIONS_DIR).filter(f => f.endsWith('.md'));
  const docs: ScannedDoc[] = [];

  for (const file of files) {
    const basename = file.replace(/\.md$/, '');
    const m = basename.match(FILENAME_RE);
    if (!m) continue;

    const [, domain_id, project, title] = m;
    const filePath = path.join(SOLUTIONS_DIR, file);
    let content: string;
    try {
      content = fs.readFileSync(filePath, 'utf-8');
    } catch { continue; }

    const repo = extractRepoFromContent(content);
    const actualProject = extractProjectFromContent(content) || project;
    const comparisonDimensions = extractComparisonData(content);
    const domainMetadata = extractDomainMetadata(content);

    docs.push({
      filename: basename,
      domain_id,
      project: actualProject,
      title,
      repo,
      slug: filenameToSlug(domain_id, actualProject, title),
      comparisonDimensions,
      domainMetadata,
    });
  }

  return docs;
}
