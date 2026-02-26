// 项目工程分析数据层
// 扫描 knowledge/projects/*.md 自动发现项目文档
// 关联 domains.ts 中的域覆盖信息

import fs from 'fs';
import path from 'path';
import { ALL_DOMAINS } from './domains';
import { findKnowledgeDoc } from './knowledge-docs';

export interface ProjectDomainLink {
  id: string;
  slug: string;
  title: string;
  icon: string;
  color: string;
  solutionTitle: string;
  knowledgeSlug?: string;
}

export interface ProjectProfile {
  slug: string;
  name: string;
  repo: string;
  language: string;
  description: string;
  markdownFile: string;
  domains: ProjectDomainLink[];
}

const PROJECTS_DIR = path.join(process.cwd(), 'knowledge', 'projects');

function extractFrontmatter(content: string): Record<string, string> {
  const meta: Record<string, string> = {};
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('> ')) {
      const match = trimmed.slice(2).match(/^(.+?)[：:]\s*(.+)$/);
      if (match) meta[match[1].trim()] = match[2].trim();
    } else if (trimmed.startsWith('---')) {
      break;
    }
  }
  return meta;
}

function nameToSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function buildDomainLinks(projectName: string): ProjectDomainLink[] {
  const links: ProjectDomainLink[] = [];
  for (const domain of ALL_DOMAINS) {
    for (const sol of domain.solutions) {
      if (sol.project.toLowerCase() === projectName.toLowerCase()) {
        if (!links.some(l => l.id === domain.id)) {
          const doc = findKnowledgeDoc(domain.id, sol.project);
          links.push({
            id: domain.id,
            slug: domain.slug,
            title: domain.title,
            icon: domain.icon,
            color: domain.color,
            solutionTitle: sol.title,
            knowledgeSlug: doc?.slug,
          });
        }
      }
    }
  }
  return links.sort((a, b) => a.id.localeCompare(b.id));
}

function scanProjects(): ProjectProfile[] {
  if (!fs.existsSync(PROJECTS_DIR)) return [];

  const files = fs.readdirSync(PROJECTS_DIR).filter(f => f.endsWith('.md'));
  const projects: ProjectProfile[] = [];

  for (const file of files) {
    const name = file.replace(/\.md$/, '');
    const filePath = path.join(PROJECTS_DIR, file);
    let content: string;
    try {
      content = fs.readFileSync(filePath, 'utf-8');
    } catch { continue; }

    const meta = extractFrontmatter(content);
    projects.push({
      slug: nameToSlug(name),
      name: meta['项目'] || meta['Project'] || name,
      repo: meta['GitHub'] || '',
      language: meta['语言'] || meta['Language'] || 'Python',
      description: meta['定位'] || meta['Description'] || '',
      markdownFile: name,
      domains: buildDomainLinks(name),
    });
  }

  return projects.sort((a, b) => b.domains.length - a.domains.length);
}

export const ALL_PROJECTS: ProjectProfile[] = scanProjects();

export function getProjectBySlug(slug: string): ProjectProfile | undefined {
  return ALL_PROJECTS.find(p => p.slug === slug);
}
