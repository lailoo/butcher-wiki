// 知识图谱数据转换 — 从 domains/projects 构建力导向图的 nodes + links

import { ALL_DOMAINS } from '@/data/domains';

export interface GraphNode {
  id: string;
  type: 'project' | 'domain';
  label: string;
  color: string;
  severity?: 'critical' | 'high' | 'medium';
  repo?: string;
  domainCount?: number;
  subtitle?: string;
  solutionCount?: number;
  slug?: string;
}

export interface GraphLink {
  source: string;
  target: string;
  solutionTitle?: string;
}

export interface GraphData {
  nodes: GraphNode[];
  links: GraphLink[];
}

const PROJECT_COLORS: Record<string, string> = {
  MetaGPT: '#f43f5e',
  DeerFlow: '#3b82f6',
  'GPT-Researcher': '#8b5cf6',
  DeepResearch: '#f59e0b',
  DeepWiki: '#06b6d4',
  MiroThinker: '#10b981',
  ClaudeMem: '#a855f7',
  OpenClaw: '#ec4899',
  OpenManus: '#84cc16',
  LightRAG: '#14b8a6',
  AgentOrchestrator: '#e879f9',
  DeepCode: '#fb923c',
  DeepTutor: '#22d3ee',
};

const FALLBACK_COLORS = [
  '#3b82f6', '#8b5cf6', '#ec4899', '#f59e0b', '#10b981',
  '#06b6d4', '#f43f5e', '#84cc16', '#a855f7', '#14b8a6',
];

export function buildGraphData(): GraphData {
  const nodes: GraphNode[] = [];
  const links: GraphLink[] = [];
  const projectMap = new Map<string, { domainCount: number; repo: string }>();

  for (const domain of ALL_DOMAINS) {
    nodes.push({
      id: `d:${domain.id}`,
      type: 'domain',
      label: domain.title,
      subtitle: domain.subtitle,
      color: domain.color,
      severity: domain.severity,
      solutionCount: domain.solutions.length,
      slug: domain.slug,
    });

    for (const sol of domain.solutions) {
      const pid = `p:${sol.project}`;
      if (!projectMap.has(sol.project)) {
        projectMap.set(sol.project, { domainCount: 0, repo: sol.repo });
      }
      const entry = projectMap.get(sol.project)!;
      // Avoid duplicate edges (same project-domain pair from multiple solutions)
      if (!links.some(l => l.source === pid && l.target === `d:${domain.id}`)) {
        entry.domainCount++;
        links.push({
          source: pid,
          target: `d:${domain.id}`,
          solutionTitle: sol.title,
        });
      }
      if (!entry.repo && sol.repo) entry.repo = sol.repo;
    }
  }

  let colorIdx = 0;
  for (const [name, info] of projectMap) {
    nodes.push({
      id: `p:${name}`,
      type: 'project',
      label: name,
      color: PROJECT_COLORS[name] || FALLBACK_COLORS[colorIdx++ % FALLBACK_COLORS.length],
      repo: info.repo,
      domainCount: info.domainCount,
    });
  }

  return { nodes, links };
}
