// Fire-and-forget domain translation — called after domain creation/scan
// Translates domain metadata to English in the background

import { ChatAnthropic } from '@langchain/anthropic';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { getDomainById } from '@/data/domains';
import {
  hasDomainTranslation,
  writeDomainTranslation,
  type DomainTranslation,
} from '@/lib/translate-store';

const DOMAIN_SYSTEM = `You are a professional translator for a software engineering knowledge base called "Butcher Wiki".
Translate the following Chinese domain definition into English. Keep technical terms accurate.
Return ONLY a JSON object with these fields:
{
  "id": "keep original",
  "title": "English title (2-6 words)",
  "subtitle": "keep original English subtitle",
  "description": "English description (2-3 sentences)",
  "sub_problems": ["translated sub-problems"],
  "best_practices": ["translated best practices"],
  "comparison_dimensions": [{"name": "translated dimension name", "values": {"ProjectName": "translated value"}}],
  "solutions": [{"source_id": "keep original", "title": "translated title", "description": "translated description", "design_philosophy": ["translated philosophy"], "migration_scenarios": ["translated scenarios"]}]
}
Keep all project names, source_ids, and technical identifiers unchanged.
Do NOT include any text outside the JSON.`;

/**
 * Translate a domain's metadata to English in the background.
 * Safe to call fire-and-forget — errors are logged but not thrown.
 */
export async function translateDomainBackground(domainId: string, slug: string): Promise<void> {
  try {
    if (hasDomainTranslation(domainId)) return;

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey || apiKey === 'sk-你的API密钥') return;

    const domain = getDomainById(domainId);
    if (!domain) return;

    const llm = new ChatAnthropic({
      model: 'claude-haiku-4-5-20251001',
      anthropicApiKey: apiKey,
      clientOptions: { baseURL: process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com' },
      temperature: 0.2,
      maxTokens: 8192,
    });

    const content = JSON.stringify({
      id: domain.id,
      title: domain.title,
      subtitle: domain.subtitle,
      description: domain.description,
      sub_problems: domain.sub_problems,
      best_practices: domain.best_practices,
      comparison_dimensions: domain.comparison_dimensions,
      solutions: domain.solutions.map(s => ({
        source_id: s.source_id,
        title: s.title,
        description: s.description,
        design_philosophy: (s as unknown as Record<string, unknown>).design_philosophy || [],
        migration_scenarios: (s as unknown as Record<string, unknown>).migration_scenarios || [],
      })),
    }, null, 2);

    const response = await llm.invoke([
      new SystemMessage(DOMAIN_SYSTEM),
      new HumanMessage(content),
    ]);

    const text = typeof response.content === 'string'
      ? response.content
      : (response.content as Array<{ type: string; text?: string }>).find(c => c.type === 'text')?.text || '';

    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return;

    const translation: DomainTranslation = JSON.parse(jsonMatch[0]);
    translation.id = domain.id;
    writeDomainTranslation(domain.id, slug, translation);
    console.log(`[translate] Domain ${domainId} translated to English`);
  } catch (err) {
    console.error(`[translate] Failed to translate domain ${domainId}:`, err);
  }
}
