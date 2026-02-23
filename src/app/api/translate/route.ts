import { NextRequest, NextResponse } from 'next/server';
import { ChatAnthropic } from '@langchain/anthropic';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import fs from 'fs';
import path from 'path';
import { getDomainById } from '@/data/domains';
import {
  readDomainTranslation,
  writeDomainTranslation,
  writeSolutionTranslation,
  hasSolutionTranslation,
  type DomainTranslation,
} from '@/lib/translate-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

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

const SOLUTION_SYSTEM = `You are a professional translator for a software engineering knowledge base.
Translate the following Chinese markdown document into English.
- Keep code blocks, file paths, and technical identifiers unchanged
- Keep markdown formatting intact
- Translate all Chinese text to natural, professional English
- Keep the document structure (headings, lists, blockquotes) identical
Return ONLY the translated markdown content.`;

async function translateDomain(domainId: string, llm: ChatAnthropic) {
  if (!domainId) {
    return NextResponse.json({ error: 'Missing domain id' }, { status: 400 });
  }

  // Check if already translated
  const existing = readDomainTranslation(domainId);
  if (existing) {
    console.log(`[translate] Domain ${domainId} — cache hit`);
    return NextResponse.json({ translation: existing, cached: true });
  }

  const domain = getDomainById(domainId);
  if (!domain) {
    return NextResponse.json({ error: `Domain ${domainId} not found` }, { status: 404 });
  }

  console.log(`[translate] Domain ${domainId} — cache miss, calling LLM...`);

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
  if (!jsonMatch) {
    return NextResponse.json({ error: 'LLM returned invalid format' }, { status: 500 });
  }

  const translation: DomainTranslation = JSON.parse(jsonMatch[0]);
  translation.id = domain.id; // ensure ID is preserved
  writeDomainTranslation(domain.id, domain.slug, translation);
  console.log(`[translate] Domain ${domainId} — translated successfully (${translation.solutions?.length ?? 0} solutions, ${translation.comparison_dimensions?.length ?? 0} dimensions)`);

  return NextResponse.json({ translation, cached: false });
}

async function translateSolution(filename: string, llm: ChatAnthropic) {
  if (!filename) {
    return NextResponse.json({ error: 'Missing filename' }, { status: 400 });
  }

  // Check if already translated
  if (hasSolutionTranslation(filename)) {
    const content = fs.readFileSync(
      path.join(process.cwd(), 'knowledge', 'solutions-en', `${filename}.md`),
      'utf-8',
    );
    return NextResponse.json({ content, cached: true });
  }

  // Read original Chinese doc
  const srcPath = path.join(process.cwd(), 'knowledge', 'solutions', `${filename}.md`);
  if (!fs.existsSync(srcPath)) {
    return NextResponse.json({ error: `Solution doc ${filename} not found` }, { status: 404 });
  }

  const original = fs.readFileSync(srcPath, 'utf-8');

  const response = await llm.invoke([
    new SystemMessage(SOLUTION_SYSTEM),
    new HumanMessage(original),
  ]);

  const translated = typeof response.content === 'string'
    ? response.content
    : (response.content as Array<{ type: string; text?: string }>).find(c => c.type === 'text')?.text || '';

  writeSolutionTranslation(filename, translated);

  return NextResponse.json({ content: translated, cached: false });
}

export async function POST(req: NextRequest) {
  try {
    const { type, id, filename } = await req.json();

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey || apiKey === 'sk-你的API密钥') {
      return NextResponse.json({ error: 'ANTHROPIC_API_KEY not configured' }, { status: 500 });
    }

    const llm = new ChatAnthropic({
      model: 'claude-haiku-4-5-20251001',
      anthropicApiKey: apiKey,
      clientOptions: { baseURL: process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com' },
      temperature: 0.2,
      maxTokens: 8192,
    });

    if (type === 'domain') {
      return await translateDomain(id, llm);
    } else if (type === 'solution') {
      return await translateSolution(filename, llm);
    } else {
      return NextResponse.json({ error: 'Invalid type, use "domain" or "solution"' }, { status: 400 });
    }
  } catch (error: unknown) {
    console.error('Translation error:', error);
    const message = error instanceof Error ? error.message : 'Translation failed';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
