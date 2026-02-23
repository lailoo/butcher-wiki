import { NextRequest, NextResponse } from 'next/server';
import { ChatAnthropic } from '@langchain/anthropic';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { ALL_DOMAINS, invalidateDomainsCache } from '@/data/domains';
import { getNextDomainId, writeDynamicDomain, type DynamicDomainDef } from '@/lib/scan-domains';
import { translateDomainBackground } from '@/lib/translate-background';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ICONS = [
  'brain', 'network', 'shield', 'wrench', 'box', 'database', 'check-circle',
  'search', 'user-check', 'layers', 'activity', 'zap', 'knife', 'sparkles',
  'message-circle', 'eye', 'lock', 'cpu', 'globe', 'file-text', 'terminal',
  'refresh-cw', 'clock', 'link', 'settings', 'alert-triangle', 'code', 'git-branch',
];

const SYSTEM_PROMPT = `你是 Butcher Wiki 的问题域定义助手。用户会给出一个 AI Agent 工程问题域的标题（可能很简短），你需要将其扩展为完整的问题域定义。

你必须严格返回以下 JSON 格式（不要包含任何其他文字，只返回 JSON）：
{
  "slug": "kebab-case-english-slug",
  "title": "中文标题（2-6字）",
  "subtitle": "English Subtitle",
  "icon": "从以下选一个: ${ICONS.join(', ')}",
  "color": "#hex颜色",
  "severity": "critical 或 high 或 medium",
  "description": "2-3句中文描述，说明该域解决什么问题、为什么重要",
  "tags": ["4-6个kebab-case标签"],
  "sub_problems": ["3-5个子问题，格式：问题名：一句话描述"],
  "best_practices": ["3-5条最佳实践"]
}

要求：
- slug 用简短的英文 kebab-case
- title 如果用户给的标题合适就保留，否则润色为更专业的表述
- description 要专业、具体，聚焦 AI Agent 工程场景
- sub_problems 要覆盖该域的核心挑战
- best_practices 要有实操价值`;

export async function POST(req: NextRequest) {
  try {
    const { title, description } = await req.json();

    if (!title || typeof title !== 'string' || title.trim().length < 1) {
      return NextResponse.json({ error: '请输入域标题' }, { status: 400 });
    }

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey || apiKey === 'sk-你的API密钥') {
      return NextResponse.json({ error: '请先配置 ANTHROPIC_API_KEY' }, { status: 500 });
    }

    // 获取已有域列表，供 LLM 参考避免重复
    const existingDomains = ALL_DOMAINS.map(d => `${d.id} ${d.title}`).join(', ');

    const llm = new ChatAnthropic({
      model: 'claude-haiku-4-5-20251001',
      anthropicApiKey: apiKey,
      clientOptions: { baseURL: process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com' },
      temperature: 0.3,
      maxTokens: 1024,
    });

    const userMsg = description
      ? `标题：${title.trim()}\n补充描述：${description.trim()}`
      : `标题：${title.trim()}`;

    const response = await llm.invoke([
      new SystemMessage(SYSTEM_PROMPT + `\n\n已有问题域（避免重复）：${existingDomains}`),
      new HumanMessage(userMsg),
    ]);

    // 提取 JSON
    const text = typeof response.content === 'string'
      ? response.content
      : (response.content as Array<{ type: string; text?: string }>).find(c => c.type === 'text')?.text || '';

    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return NextResponse.json({ error: 'LLM 返回格式异常' }, { status: 500 });
    }

    const data = JSON.parse(jsonMatch[0]);

    // 分配 ID
    const existingIds = ALL_DOMAINS.map(d => d.id);
    const newId = getNextDomainId(existingIds);

    // 校验 icon
    const icon = ICONS.includes(data.icon) ? data.icon : 'sparkles';

    const def: DynamicDomainDef = {
      id: newId,
      slug: data.slug || title.trim().toLowerCase().replace(/\s+/g, '-'),
      title: data.title || title.trim(),
      subtitle: data.subtitle || '',
      icon,
      color: data.color || '#8b5cf6',
      severity: ['critical', 'high', 'medium'].includes(data.severity) ? data.severity : 'medium',
      description: data.description || '',
      tags: Array.isArray(data.tags) ? data.tags : [],
      sub_problems: Array.isArray(data.sub_problems) ? data.sub_problems : [],
      best_practices: Array.isArray(data.best_practices) ? data.best_practices : [],
    };

    writeDynamicDomain(def);
    invalidateDomainsCache();

    // Fire-and-forget: translate to English in background
    translateDomainBackground(newId, def.slug).catch(() => {});

    return NextResponse.json({ id: newId, slug: def.slug, title: def.title });
  } catch (error: unknown) {
    console.error('Domain create error:', error);
    const message = error instanceof Error ? error.message : '创建失败';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
