#!/usr/bin/env npx tsx
// Butcher Wiki MCP Server
// 让其他项目的 Claude Code 能查询 Butcher Wiki 知识库
//
// 使用方式：在其他项目的 .claude/settings.json 中添加：
// {
//   "mcpServers": {
//     "butcher-wiki": {
//       "command": "npx",
//       "args": ["tsx", "src/mcp-server.ts"],
//       "cwd": "/path/to/butcher-wiki",
//       "env": { "TSX_TSCONFIG_PATH": "tsconfig.json" }
//     }
//   }
// }

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import Anthropic from '@anthropic-ai/sdk';
import fs from 'fs';
import path from 'path';

// 手动加载 .env（不用 dotenv，避免 stdout 输出干扰 MCP 协议）
const envPath = path.join(process.cwd(), '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf-8').split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.+)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
}

import { ALL_DOMAINS } from '@/data/domains';
import { KNOWLEDGE_DOCS } from '@/data/knowledge-docs';
import { buildSearchContext, buildDomainContext } from '@/lib/search-context';

// --- LLM 智能搜索 ---

const SEARCH_SYSTEM_PROMPT = `你是 Butcher Wiki 的智能搜索助手。Butcher Wiki 是一个 AI Agent 工程组件知识库。

用户会输入自然语言查询，你需要：
1. 理解用户的意图
2. 从知识库中匹配最相关的问题域、方案、知识文档
3. 返回 3-8 个最相关的结果，按相关度降序
4. 用简短中文解释匹配原因

// SEARCH_SYSTEM_PROMPT continued
严格返回 JSON：
{
  "intent": "用户意图",
  "matches": [
    { "type": "domain|solution|knowledge", "id": "标识符", "title": "标题", "reason": "匹配原因", "relevance": 0.95 }
  ],
  "suggestion": "补充建议"
}

知识库内容：
`;

async function llmSearch(query: string): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return keywordFallback(query);

  try {
    const client = new Anthropic({ apiKey });
    const context = buildSearchContext();
    const resp = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1024,
      system: SEARCH_SYSTEM_PROMPT + context,
      messages: [{ role: 'user', content: query }],
    });
    const text = resp.content[0].type === 'text' ? resp.content[0].text : '';
    // 尝试解析 JSON 并补充详细上下文
    try {
      const result = JSON.parse(text);
      const enriched = enrichSearchResult(result);
      return JSON.stringify(enriched, null, 2);
    } catch {
      return text;
    }
  } catch {
    return keywordFallback(query);
  }
}

function enrichSearchResult(result: { matches?: Array<{ type: string; id: string }> }) {
  if (!result.matches) return result;
  for (const m of result.matches) {
    if (m.type === 'domain') {
      const d = ALL_DOMAINS.find(x => x.slug === m.id || x.id === m.id);
      if (d) Object.assign(m, { description: d.description, solutions: d.solutions.map(s => s.project) });
    } else if (m.type === 'knowledge') {
      const doc = KNOWLEDGE_DOCS.find(k => k.slug === m.id);
      if (doc) Object.assign(m, { domain_id: doc.domain_id, project: doc.project });
    }
  }
  return result;
}

function keywordFallback(query: string): string {
  const q = query.toLowerCase();
  const domainHits = ALL_DOMAINS.filter(d =>
    d.title.toLowerCase().includes(q) ||
    d.description.toLowerCase().includes(q) ||
    d.tags.some(t => t.toLowerCase().includes(q)) ||
    d.solutions.some(s => s.title.toLowerCase().includes(q) || s.signals.some(sig => sig.toLowerCase().includes(q)))
  ).slice(0, 5);

  const docHits = KNOWLEDGE_DOCS.filter(k =>
    k.title.toLowerCase().includes(q) || k.project.toLowerCase().includes(q)
  ).slice(0, 5);

  return JSON.stringify({
    intent: query,
    matches: [
      ...domainHits.map(d => ({ type: 'domain', id: d.slug, title: d.title, reason: '关键词匹配', relevance: 0.6 })),
      ...docHits.map(k => ({ type: 'knowledge', id: k.slug, title: k.title, reason: '关键词匹配', relevance: 0.5 })),
    ],
    suggestion: domainHits.length === 0 && docHits.length === 0 ? '未找到匹配，请尝试更具体的关键词' : null,
  }, null, 2);
}

// --- 读取知识文档 markdown ---

function readKnowledgeDoc(slug: string): string | null {
  const doc = KNOWLEDGE_DOCS.find(k => k.slug === slug);
  if (!doc) return null;
  const filePath = path.join(process.cwd(), 'knowledge', 'solutions', `${doc.filename}.md`);
  if (!fs.existsSync(filePath)) return null;
  return fs.readFileSync(filePath, 'utf-8');
}

// --- MCP Server ---

const server = new McpServer({ name: 'butcher-wiki', version: '1.0.0' });

// Tool 1: 智能搜索
server.tool(
  'search_wiki',
  '搜索 Butcher Wiki 知识库，支持自然语言查询。返回匹配的问题域、方案、知识文档。',
  { query: z.string().describe('搜索查询（自然语言）') },
  async ({ query }) => {
    const result = await llmSearch(query);
    return { content: [{ type: 'text' as const, text: result }] };
  }
);

// Tool 2: 获取域上下文
server.tool(
  'get_domain_context',
  '获取指定问题域的完整上下文，包括描述、子问题、方案、对比维度、最佳实践。',
  { domain_id: z.string().describe('域 ID（如 PD-01）或 slug（如 context-management）') },
  async ({ domain_id }) => {
    // 支持 ID 或 slug
    const d = ALL_DOMAINS.find(x => x.id === domain_id || x.slug === domain_id);
    if (!d) return { content: [{ type: 'text' as const, text: `未找到域: ${domain_id}` }] };
    const ctx = buildDomainContext(d.id);
    return { content: [{ type: 'text' as const, text: ctx }] };
  }
);

// Tool 3: 知识库概览
server.tool(
  'get_wiki_overview',
  '获取 Butcher Wiki 知识库概览：所有问题域列表及其方案数量。',
  {},
  async () => {
    const overview = ALL_DOMAINS.map(d => ({
      id: d.id, slug: d.slug, title: d.title, subtitle: d.subtitle,
      severity: d.severity, solutions: d.solutions.length,
      docs: KNOWLEDGE_DOCS.filter(k => k.domain_id === d.id).length,
    }));
    return { content: [{ type: 'text' as const, text: JSON.stringify(overview, null, 2) }] };
  }
);

// Tool 4: 读取知识文档
server.tool(
  'read_knowledge_doc',
  '读取指定知识文档的完整 markdown 内容。',
  { slug: z.string().describe('知识文档 slug（如 pd01-mirothinker-tiktoken-context）') },
  async ({ slug }) => {
    const content = readKnowledgeDoc(slug);
    if (!content) return { content: [{ type: 'text' as const, text: `未找到文档: ${slug}` }] };
    return { content: [{ type: 'text' as const, text: content }] };
  }
);

// 启动
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(e => {
  process.stderr.write(`MCP Server error: ${e}\n`);
  process.exit(1);
});
