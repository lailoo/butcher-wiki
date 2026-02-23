// 知识文档索引 — 将 solution (domain_id + project) 映射到 knowledge markdown 文件
// slug 用纯英文（URL 路由），filename 是实际的 markdown 文件名
// 静态手写条目 + 动态扫描 knowledge/solutions/ 目录自动发现新文档

import { scanKnowledgeDocs } from '@/lib/scan-knowledge';

export interface KnowledgeDoc {
  /** URL slug（纯英文） */
  slug: string;
  /** 实际文件名（不含 .md） */
  filename: string;
  /** 所属问题域 ID */
  domain_id: string;
  /** 项目名 */
  project: string;
  /** 文档标题 */
  title: string;
}

const STATIC_KNOWLEDGE_DOCS: KnowledgeDoc[] = [
  // PD-01
  { slug: 'pd01-mirothinker-tiktoken-context', filename: 'PD-01-MiroThinker-tiktoken上下文管理方案', domain_id: 'PD-01', project: 'MiroThinker', title: 'MiroThinker tiktoken 上下文管理方案' },
  { slug: 'pd01-gpt-researcher-embedding-compress', filename: 'PD-01-GPT-Researcher-Embedding相似度压缩方案', domain_id: 'PD-01', project: 'GPT-Researcher', title: 'GPT-Researcher Embedding 相似度压缩方案' },
  // PD-02
  { slug: 'pd02-deerflow-langgraph-dag', filename: 'PD-02-DeerFlow-LangGraph-DAG编排方案', domain_id: 'PD-02', project: 'DeerFlow', title: 'DeerFlow LangGraph DAG 编排方案' },
  { slug: 'pd02-gpt-researcher-master-worker', filename: 'PD-02-GPT-Researcher-Master-Worker并行方案', domain_id: 'PD-02', project: 'GPT-Researcher', title: 'GPT-Researcher Master-Worker 并行方案' },
  { slug: 'pd02-mirothinker-orchestrator', filename: 'PD-02-MiroThinker-Orchestrator单中心调度方案', domain_id: 'PD-02', project: 'MiroThinker', title: 'MiroThinker Orchestrator 单中心调度方案' },
  // PD-03
  { slug: 'pd03-deerflow-checkpoint-retry', filename: 'PD-03-DeerFlow-LangGraph检查点重试方案', domain_id: 'PD-03', project: 'DeerFlow', title: 'DeerFlow LangGraph 检查点重试方案' },
  { slug: 'pd03-gpt-researcher-search-fallback', filename: 'PD-03-GPT-Researcher-搜索源降级方案', domain_id: 'PD-03', project: 'GPT-Researcher', title: 'GPT-Researcher 搜索源降级方案' },
  { slug: 'pd03-mirothinker-exponential-backoff', filename: 'PD-03-MiroThinker-指数退避与模型降级方案', domain_id: 'PD-03', project: 'MiroThinker', title: 'MiroThinker 指数退避与模型降级方案' },
  // PD-04
  { slug: 'pd04-deerflow-langchain-tool', filename: 'PD-04-DeerFlow-LangChain-Tool装饰器方案', domain_id: 'PD-04', project: 'DeerFlow', title: 'DeerFlow LangChain Tool 装饰器方案' },
  { slug: 'pd04-mirothinker-function-calling', filename: 'PD-04-MiroThinker-OpenAI-FunctionCalling方案', domain_id: 'PD-04', project: 'MiroThinker', title: 'MiroThinker OpenAI FunctionCalling 方案' },
  // PD-05
  { slug: 'pd05-deerflow-subprocess-sandbox', filename: 'PD-05-DeerFlow-subprocess临时目录隔离方案', domain_id: 'PD-05', project: 'DeerFlow', title: 'DeerFlow subprocess 临时目录隔离方案' },
  { slug: 'pd05-mirothinker-docker-e2b', filename: 'PD-05-MiroThinker-Docker-E2B云沙箱方案', domain_id: 'PD-05', project: 'MiroThinker', title: 'MiroThinker Docker/E2B 云沙箱方案' },
  { slug: 'pd05-deepresearch-path-whitelist', filename: 'PD-05-DeepResearch-路径白名单方案', domain_id: 'PD-05', project: 'DeepResearch', title: 'DeepResearch 路径白名单方案' },
  // PD-06
  { slug: 'pd06-deerflow-checkpoint-persistence', filename: 'PD-06-DeerFlow-LangGraph-Checkpoint持久化方案', domain_id: 'PD-06', project: 'DeerFlow', title: 'DeerFlow LangGraph Checkpoint 持久化方案' },
  { slug: 'pd06-gpt-researcher-report-cache', filename: 'PD-06-GPT-Researcher-研究报告缓存方案', domain_id: 'PD-06', project: 'GPT-Researcher', title: 'GPT-Researcher 研究报告缓存方案' },
  // PD-07
  { slug: 'pd07-deerflow-reviewer-agent', filename: 'PD-07-DeerFlow-Reviewer-Agent多维评估方案', domain_id: 'PD-07', project: 'DeerFlow', title: 'DeerFlow Reviewer Agent 多维评估方案' },
  { slug: 'pd07-gpt-researcher-citation-verify', filename: 'PD-07-GPT-Researcher-源引用验证方案', domain_id: 'PD-07', project: 'GPT-Researcher', title: 'GPT-Researcher 源引用验证方案' },
  // PD-08
  { slug: 'pd08-gpt-researcher-multi-source-search', filename: 'PD-08-GPT-Researcher-多源并行搜索方案', domain_id: 'PD-08', project: 'GPT-Researcher', title: 'GPT-Researcher 多源并行搜索方案' },
  { slug: 'pd08-deepresearch-tree-search', filename: 'PD-08-DeepResearch-树状搜索方案', domain_id: 'PD-08', project: 'DeepResearch', title: 'DeepResearch 树状搜索方案' },
  { slug: 'pd08-deepwiki-git-rag', filename: 'PD-08-DeepWiki-Git仓库RAG检索方案', domain_id: 'PD-08', project: 'DeepWiki', title: 'DeepWiki Git 仓库 RAG 检索方案' },
  // PD-09
  { slug: 'pd09-deerflow-langgraph-interrupt', filename: 'PD-09-DeerFlow-LangGraph-interrupt方案', domain_id: 'PD-09', project: 'DeerFlow', title: 'DeerFlow LangGraph interrupt 方案' },
  { slug: 'pd09-gpt-researcher-plan-confirm', filename: 'PD-09-GPT-Researcher-研究计划确认方案', domain_id: 'PD-09', project: 'GPT-Researcher', title: 'GPT-Researcher 研究计划确认方案' },
  // PD-10
  { slug: 'pd10-deerflow-middleware-chain', filename: 'PD-10-DeerFlow-中间件链方案', domain_id: 'PD-10', project: 'DeerFlow', title: 'DeerFlow 中间件链方案' },
  // PD-11
  { slug: 'pd11-mirothinker-token-counter', filename: 'PD-11-MiroThinker-Token计数器方案', domain_id: 'PD-11', project: 'MiroThinker', title: 'MiroThinker Token 计数器方案' },
  { slug: 'pd11-deerflow-langsmith-tracing', filename: 'PD-11-DeerFlow-LangSmith集成追踪方案', domain_id: 'PD-11', project: 'DeerFlow', title: 'DeerFlow LangSmith 集成追踪方案' },
  // PD-12
  { slug: 'pd12-gpt-researcher-cot-reasoning', filename: 'PD-12-GPT-Researcher-CoT研究推理方案', domain_id: 'PD-12', project: 'GPT-Researcher', title: 'GPT-Researcher CoT 研究推理方案' },
  { slug: 'pd12-deepresearch-tiered-llm', filename: 'PD-12-DeepResearch-分层LLM策略方案', domain_id: 'PD-12', project: 'DeepResearch', title: 'DeepResearch 分层 LLM 策略方案' },
];

// --- 动态扫描合并 ---
// 扫描 knowledge/solutions/ 目录，将未在静态列表中注册的文档自动加入
function mergeWithScanned(): KnowledgeDoc[] {
  const staticFilenames = new Set(STATIC_KNOWLEDGE_DOCS.map(d => d.filename));
  const scanned = scanKnowledgeDocs();
  const dynamic: KnowledgeDoc[] = scanned
    .filter(s => !staticFilenames.has(s.filename))
    .map(s => ({
      slug: s.slug,
      filename: s.filename,
      domain_id: s.domain_id,
      project: s.project,
      title: `${s.project} ${s.title}`,
    }));
  return [...STATIC_KNOWLEDGE_DOCS, ...dynamic];
}

let _docsCache: KnowledgeDoc[] | null = null;

function getDocs(): KnowledgeDoc[] {
  if (!_docsCache) {
    _docsCache = mergeWithScanned();
  }
  return _docsCache;
}

/** 清除知识文档缓存 */
export function invalidateKnowledgeDocsCache(): void {
  _docsCache = null;
}

/** 知识文档列表（惰性加载 + 可失效缓存） */
export const KNOWLEDGE_DOCS: KnowledgeDoc[] = new Proxy([] as KnowledgeDoc[], {
  get(_, prop) {
    const data = getDocs();
    const value = Reflect.get(data, prop);
    return typeof value === 'function' ? value.bind(data) : value;
  },
  has(_, prop) {
    return Reflect.has(getDocs(), prop);
  },
  ownKeys() {
    return Reflect.ownKeys(getDocs());
  },
  getOwnPropertyDescriptor(_, prop) {
    return Reflect.getOwnPropertyDescriptor(getDocs(), prop);
  },
});

/** 根据域 ID 和项目名查找知识文档 */
export function findKnowledgeDoc(domainId: string, project: string): KnowledgeDoc | undefined {
  return getDocs().find(d => d.domain_id === domainId && d.project === project);
}

/** 根据 slug 查找知识文档 */
export function getKnowledgeDocBySlug(slug: string): KnowledgeDoc | undefined {
  return getDocs().find(d => d.slug === slug);
}
