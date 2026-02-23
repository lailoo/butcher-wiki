import { NextRequest, NextResponse } from 'next/server';
import { ChatAnthropic } from '@langchain/anthropic';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { buildSearchContext } from '@/lib/search-context';

// 缓存搜索上下文（只构建一次）
let cachedContext: string | null = null;
function getContext() {
  if (!cachedContext) cachedContext = buildSearchContext();
  return cachedContext;
}

const SYSTEM_PROMPT_ZH = `你是 Butcher Wiki 的智能搜索助手。Butcher Wiki 是一个 Agent 工程组件知识库，把开源项目大卸八块，提取可移植的工程组件。

用户会输入自然语言查询，你需要：
1. 理解用户的意图（想解决什么问题、找什么技术方案、了解哪个项目）
2. 从知识库中匹配最相关的问题域(domain)、解决方案(solution)、知识文档(knowledge)
3. 返回 3-8 个最相关的结果，按相关度降序排列
4. 用简短的中文解释每个匹配的原因

ID 格式说明：
- domain 类型：使用域的 slug（如 "context-management"）
- solution 类型：使用 "域slug#sol-项目名小写"（如 "context-management#sol-mirothinker"）
- knowledge 类型：使用知识文档的 slug（如 "pd01-mirothinker-tiktoken-context"）

你必须严格返回以下 JSON 格式（不要包含任何其他文字，只返回 JSON）：
{
  "intent": "对用户意图的简短理解",
  "matches": [
    {
      "type": "domain|solution|knowledge",
      "id": "标识符",
      "domain_id": "PD-XX",
      "title": "标题",
      "reason": "匹配原因",
      "relevance": 0.95
    }
  ],
  "suggestion": "可选的补充建议"
}

以下是完整的知识库内容：

`;

const SYSTEM_PROMPT_EN = `You are the intelligent search assistant for Butcher Wiki — an Agent engineering knowledge base that dissects open-source projects into portable engineering components.

Given a natural language query, you should:
1. Understand the user's intent (what problem to solve, what pattern to find, which project to explore)
2. Match the most relevant problem domains, solutions, and knowledge docs from the knowledge base
3. Return 3-8 most relevant results sorted by relevance
4. Explain each match reason in concise English

ID format:
- domain type: use the domain slug (e.g. "context-management")
- solution type: use "domain-slug#sol-projectname" (e.g. "context-management#sol-mirothinker")
- knowledge type: use the knowledge doc slug (e.g. "pd01-mirothinker-tiktoken-context")

Return ONLY the following JSON format (no other text):
{
  "intent": "brief understanding of user intent",
  "matches": [
    {
      "type": "domain|solution|knowledge",
      "id": "identifier",
      "domain_id": "PD-XX",
      "title": "title in English",
      "reason": "match reason in English",
      "relevance": 0.95
    }
  ],
  "suggestion": "optional follow-up suggestion"
}

Below is the full knowledge base content:

`;

export async function POST(req: NextRequest) {
  try {
    const { query, lang } = await req.json();

    if (!query || typeof query !== 'string' || query.trim().length < 2) {
      return NextResponse.json({ error: lang === 'en' ? 'Query too short' : '查询内容太短' }, { status: 400 });
    }

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey || apiKey === 'sk-你的API密钥') {
      return NextResponse.json({ error: lang === 'en' ? 'ANTHROPIC_API_KEY not configured' : '请先配置 ANTHROPIC_API_KEY' }, { status: 500 });
    }

    const llm = new ChatAnthropic({
      model: 'claude-haiku-4-5-20251001',
      anthropicApiKey: apiKey,
      clientOptions: { baseURL: process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com' },
      temperature: 0,
      maxTokens: 1024,
    });

    const context = getContext();
    const systemPrompt = lang === 'en' ? SYSTEM_PROMPT_EN : SYSTEM_PROMPT_ZH;
    const response = await llm.invoke([
      new SystemMessage(systemPrompt + context),
      new HumanMessage(query.trim()),
    ]);

    // 从 LLM 响应中提取 JSON
    const text = typeof response.content === 'string'
      ? response.content
      : (response.content as Array<{ type: string; text?: string }>).find(c => c.type === 'text')?.text || '';

    // 提取 JSON（可能被 markdown code block 包裹）
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return NextResponse.json({ error: 'Search result parse failed' }, { status: 500 });
    }

    const result = JSON.parse(jsonMatch[0]);
    return NextResponse.json(result);
  } catch (error: unknown) {
    console.error('Search API error:', error);
    const message = error instanceof Error ? error.message : '搜索服务异常';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
