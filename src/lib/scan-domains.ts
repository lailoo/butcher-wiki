// 动态域扫描 — 从 knowledge/domains/ 加载 JSON 格式的动态域定义
// 扫描项目时如果发现不属于静态 12 域的 Agent 工程特性，CC 会提出新域
// route.ts 将新域写入 knowledge/domains/PD-XX-slug.json

import fs from 'fs';
import path from 'path';
import type { DomainData } from '@/data/domains';

const DOMAINS_DIR = path.join(process.cwd(), 'knowledge', 'domains');

/** 动态域 JSON 格式（与 DomainData 兼容的子集） */
export interface DynamicDomainDef {
  id: string;           // PD-13, PD-14, ...
  slug: string;         // url-friendly slug
  title: string;        // 中文标题
  subtitle: string;     // English subtitle
  icon: string;         // emoji or icon name
  color: string;        // hex color
  severity: 'critical' | 'high' | 'medium';
  description: string;
  tags: string[];
  sub_problems: string[];
  best_practices: string[];
}

/** 扫描 knowledge/domains/ 目录，返回所有动态域定义 */
export function scanDynamicDomains(): DynamicDomainDef[] {
  if (!fs.existsSync(DOMAINS_DIR)) return [];

  const files = fs.readdirSync(DOMAINS_DIR).filter(f => f.endsWith('.json'));
  const domains: DynamicDomainDef[] = [];

  for (const file of files) {
    try {
      const content = fs.readFileSync(path.join(DOMAINS_DIR, file), 'utf-8');
      const data = JSON.parse(content) as DynamicDomainDef;
      if (data.id && data.slug && data.title) {
        domains.push(data);
      }
    } catch { /* skip invalid files */ }
  }

  return domains;
}

/** 将动态域定义转换为完整的 DomainData（solutions/comparison_dimensions 为空） */
export function dynamicDomainToData(def: DynamicDomainDef): DomainData {
  return {
    id: def.id,
    slug: def.slug,
    title: def.title,
    subtitle: def.subtitle,
    icon: def.icon || 'sparkles',
    color: def.color || '#8b5cf6',
    severity: def.severity || 'medium',
    description: def.description,
    tags: def.tags || [],
    sub_problems: def.sub_problems || [],
    solutions: [],
    comparison_dimensions: [],
    best_practices: def.best_practices || [],
  };
}

/** 计算下一个可用的域 ID（PD-13, PD-14, ...） */
export function getNextDomainId(existingIds: string[]): string {
  const nums = existingIds
    .map(id => parseInt(id.replace('PD-', ''), 10))
    .filter(n => !isNaN(n));
  const max = nums.length > 0 ? Math.max(...nums) : 12;
  return `PD-${String(max + 1).padStart(2, '0')}`;
}

/** 将新域定义写入 knowledge/domains/ */
export function writeDynamicDomain(def: DynamicDomainDef): void {
  if (!fs.existsSync(DOMAINS_DIR)) {
    fs.mkdirSync(DOMAINS_DIR, { recursive: true });
  }
  const filename = `${def.id}-${def.slug}.json`;
  fs.writeFileSync(
    path.join(DOMAINS_DIR, filename),
    JSON.stringify(def, null, 2),
    'utf-8',
  );
}

/** 查找某个域 ID 对应的 JSON 文件路径（如果存在） */
export function findDomainFile(domainId: string): string | null {
  if (!fs.existsSync(DOMAINS_DIR)) return null;
  const file = fs.readdirSync(DOMAINS_DIR).find(f => f.startsWith(`${domainId}-`) && f.endsWith('.json'));
  return file ? path.join(DOMAINS_DIR, file) : null;
}

/** 更新域定义（部分字段），如果 JSON 文件已存在则合并，否则创建新文件 */
export function updateDomainDef(domainId: string, slug: string, updates: Partial<Omit<DynamicDomainDef, 'id'>>): void {
  if (!fs.existsSync(DOMAINS_DIR)) {
    fs.mkdirSync(DOMAINS_DIR, { recursive: true });
  }

  const existingFile = findDomainFile(domainId);
  let current: Partial<DynamicDomainDef> = {};

  if (existingFile) {
    try {
      current = JSON.parse(fs.readFileSync(existingFile, 'utf-8'));
    } catch { /* start fresh */ }
  }

  const merged: DynamicDomainDef = {
    id: domainId,
    slug: updates.slug || current.slug || slug,
    title: updates.title ?? current.title ?? '',
    subtitle: updates.subtitle ?? current.subtitle ?? '',
    icon: updates.icon ?? current.icon ?? 'sparkles',
    color: updates.color ?? current.color ?? '#8b5cf6',
    severity: updates.severity ?? current.severity ?? 'medium',
    description: updates.description ?? current.description ?? '',
    tags: updates.tags ?? current.tags ?? [],
    sub_problems: updates.sub_problems ?? current.sub_problems ?? [],
    best_practices: updates.best_practices ?? current.best_practices ?? [],
  };

  // 如果 slug 变了，删除旧文件
  if (existingFile) {
    const newFilename = `${domainId}-${merged.slug}.json`;
    const newPath = path.join(DOMAINS_DIR, newFilename);
    if (existingFile !== newPath) {
      fs.unlinkSync(existingFile);
    }
  }

  writeDynamicDomain(merged);
}
