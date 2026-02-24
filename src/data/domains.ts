// 全局域数据 — 驱动首页卡片 + 域详情页
// 每个域包含：元信息、子问题、解决方案、对比维度、最佳实践
// 静态手写数据 + 动态扫描 knowledge/solutions/ 自动发现新项目

import { scanKnowledgeDocs, type ScannedDoc } from '@/lib/scan-knowledge';
import { scanDynamicDomains, dynamicDomainToData } from '@/lib/scan-domains';

export interface DomainSolution {
  project: string;
  source_id: string;
  type: 'Solution';
  repo: string;
  title: string;
  description: string;
  signals: string[];
  score: number;
  calls: number;
  source_files?: string[];
  design_philosophy?: string[];
  migration_scenarios?: string[];
}

export interface ComparisonDimension {
  name: string;
  values: Record<string, string>;
}

export interface DomainData {
  id: string;
  slug: string;
  title: string;
  subtitle: string;
  icon: string;
  color: string;
  severity: 'critical' | 'high' | 'medium';
  description: string;
  tags: string[];
  sub_problems: string[];
  solutions: DomainSolution[];
  comparison_dimensions: ComparisonDimension[];
  best_practices: string[];
}

// ─── PD-01 上下文管理 ───
const PD01: DomainData = {
  id: 'PD-01', slug: 'context-management', title: '上下文管理',
  subtitle: 'Context Window Management', icon: 'brain', color: '#6366f1',
  severity: 'critical',
  description: 'LLM 上下文窗口有限，长任务中如何保留关键信息、裁剪冗余内容、避免 token 超限崩溃。这不是一个"优化"问题，而是一个"生存"问题。',
// PLACEHOLDER_CONTINUE
  tags: ['token-estimation', 'truncation', 'compression', 'sliding-window'],
  sub_problems: [
    'Token 估算：在调用 LLM 前精确估算当前 prompt 的 token 数',
    '超限裁剪：按优先级裁剪内容（旧消息、工具结果、搜索素材）',
    '摘要压缩：将长历史对话压缩为摘要，保留关键信息',
    '滑动窗口：只保留最近 N 轮对话或最近 N 个工具结果',
    '预算分配：为不同内容类型分配 token 预算',
  ],
  solutions: [
    {
      project: 'MiroThinker', source_id: '37.33', type: 'Solution',
      repo: 'https://github.com/MiroMindAI/MiroThinker',
      title: '_estimate_tokens() tiktoken 估算 + ensure_summary_context() 自动回退',
      description: 'openai_client.py:363-382 的 _estimate_tokens() 用 tiktoken o200k_base 编码器精确估算 token 数（降级 cl100k_base → len//4）。openai_client.py:384-444 的 ensure_summary_context() 在生成最终答案前检查 prompt_tokens + completion_tokens + summary_tokens + max_tokens + 1000 buffer 是否超限，超限时移除最后一轮 assistant-user 对话对。安全系数 1.5x。',
      signals: ['token_overflow', 'context_limit', 'tiktoken', 'ensure_summary_context', '_estimate_tokens', 'o200k_base'],
      score: 0.92, calls: 0,
      source_files: ['openai_client.py:363-382', 'openai_client.py:384-444', 'base_client.py:222'],
      design_philosophy: ['精确优于估算：tiktoken o200k_base 精确计数，降级为 cl100k_base → len(text)//4', '预防优于治疗：ensure_summary_context() 在调用前检查，而非等 API 报 400', '1.5x 安全系数 + 1000 token 固定 buffer 双重保护', '回退策略是移除最后一轮对话对，而非截断内容'],
      migration_scenarios: ['ReAct 循环中消息不断累积的多轮 Agent', '以 OpenAI 为主要 LLM 的项目（tiktoken 编码器适配）', '需要在生成最终答案前检查上下文容量的场景'],
    },
    {
      project: 'DeerFlow', source_id: '102.07', type: 'Solution',
      repo: 'https://github.com/bytedance/deer-flow',
      title: 'DanglingToolCallMiddleware + SummarizationMiddleware 双中间件容错压缩',
      description: 'DanglingToolCallMiddleware 在 before_model 钩子中扫描 AIMessage.tool_calls，为缺少 ToolMessage 响应的悬挂调用注入 status="error" 占位消息。SummarizationMiddleware 支持三触发条件（tokens 阈值/messages 条数/fraction 使用率），触发后用 LLM 生成摘要替换旧消息，保留最近 N 条，AI/Tool 消息对保护防止拆分。摘要失败时回退保留最后 15 条消息。',
      signals: ['DanglingToolCallMiddleware', 'SummarizationMiddleware', 'before_model', 'tool_call_repair', 'fraction_trigger'],
      score: 0.88, calls: 0,
      source_files: ['backend/src/agents/middlewares/dangling_tool_call_middleware.py', 'backend/src/config/summarization_config.py', 'langchain.agents.middleware.SummarizationMiddleware'],
      design_philosophy: ['中间件模式：上下文压缩和悬挂修复作为可插拔 AgentMiddleware', '三触发条件 OR 逻辑：tokens/messages/fraction 任一满足即压缩', 'AI/Tool 消息对保护：切割点不拆分 AIMessage 和对应 ToolMessage', '摘要失败容错：生成失败返回 "Error generating summary"，不阻塞主流程'],
      migration_scenarios: ['LangGraph 中间件架构的 Agent 框架', '多轮对话中用户中断/网络超时导致悬挂工具调用的场景', '需要 token/消息数/使用率三维触发压缩的长对话场景'],
    },
    {
      project: 'DeepResearch', source_id: '113.01', type: 'Solution',
      repo: 'https://github.com/Alibaba-NLP/DeepResearch',
      title: 'AgentFold <compress> 标签 + ReSum 90% 阈值全量摘要替换',
      description: 'AgentFold/infer.py:78 让 LLM 在每轮推理时主动生成 <compress> 标签声明可折叠的历史步骤。update_and_sort_steps()（infer.py:170-198）维护 step_list 数据结构，将连续步骤合并为 [Compressed Step X to Y]。ReSum（WebResummer/src/react_agent.py:135）在 token 使用率达 90% 时调用独立摘要模型全量替换消息历史。使用两套 prompt：QUERY_SUMMARY_PROMPT（首次）和 QUERY_SUMMARY_PROMPT_LAST（增量）。',
      signals: ['AgentFold', 'compress_tag', 'update_and_sort_steps', 'ReSum', 'step_list', 'summarize_conversation'],
      score: 0.90, calls: 0,
      source_files: ['AgentFold/infer.py:78', 'AgentFold/infer.py:170-198', 'WebResummer/src/react_agent.py:135', 'WebResummer/src/summary_utils.py:50', 'WebResummer/src/prompt.py:97-169'],
      design_philosophy: ['LLM 主动压缩：模型比规则更懂哪些信息对当前推理仍然重要', '步骤级粒度：不是对整个对话做摘要，而是维护 step_list 按步骤合并', 'ReSum 核弹级兜底：90% 阈值时全量替换消息历史，牺牲细节换空间', '增量摘要递增质量：QUERY_SUMMARY_PROMPT_LAST 以上次摘要为基线分析新增进展'],
      migration_scenarios: ['多轮 Agent 推理中历史步骤不断累积的场景', '需要 LLM 自主判断压缩范围（而非规则引擎）的项目', '极端上下文压力下需要全量摘要替换的深度研究 Agent'],
    },
    {
      project: 'GPT-Researcher', source_id: '41.02', type: 'Solution',
      repo: 'https://github.com/assafelovic/gpt-researcher',
      title: 'trim_context_to_word_limit() 25000 词上限 + visited_urls 跨层去重',
      description: 'gpt_researcher/skills/deep_research.py 的 DeepResearchSkill 在树状递归搜索（breadth=4, depth=2）完成后，用 trim_context_to_word_limit(25000 words) 裁剪合并的 learnings + context + citations。跨层共享 visited_urls 集合实现 URL 级去重，避免重复抓取。并发控制用 asyncio.Semaphore(2) 限制同时查询数。',
      signals: ['trim_context_to_word_limit', 'visited_urls', 'DeepResearchSkill', 'word_limit_25000', 'asyncio_semaphore'],
      score: 0.85, calls: 0,
      source_files: ['gpt_researcher/skills/deep_research.py', 'gpt_researcher/context/compression.py'],
      design_philosophy: ['硬上限裁剪：25000 words 上限防止 LLM 上下文溢出', '跨层 URL 去重：visited_urls 集合跨递归层传递，避免重复抓取', 'breadth 逐层减半：max(2, breadth // 2) 控制指数爆炸', '知识累积：learnings 跨层传递，后续层基于前序知识生成子查询'],
      migration_scenarios: ['树状递归深度研究中需要裁剪合并结果的场景', '多层搜索需要 URL 级去重的项目', '需要硬性词数上限防止上下文溢出的 Agent'],
    },
  ],
  comparison_dimensions: [
    { name: '估算方式', values: { MiroThinker: 'tiktoken o200k_base 精确估算', DeerFlow: 'tokens/messages/fraction 三阈值', DeepResearch: 'AutoTokenizer 精确计数', 'GPT-Researcher': 'trim_context_to_word_limit 词数上限' } },
    { name: '压缩策略', values: { MiroThinker: '移除最后一轮对话对', DeerFlow: 'LLM 摘要替换旧消息 + 悬挂工具调用修复', DeepResearch: 'AgentFold 步骤级合并 + ReSum 全量替换', 'GPT-Researcher': '25000 词硬裁剪 + visited_urls 去重' } },
    { name: '触发机制', values: { MiroThinker: 'ensure_summary_context() 调用前检查', DeerFlow: '三触发 OR 逻辑（任一满足）', DeepResearch: 'LLM 主动 <compress> 标签 + 90% 阈值', 'GPT-Researcher': '递归搜索完成后裁剪' } },
    { name: '实现位置', values: { MiroThinker: 'openai_client.py LLM 客户端内部', DeerFlow: 'AgentMiddleware 独立中间件', DeepResearch: 'infer.py 推理主循环 + react_agent.py', 'GPT-Researcher': 'deep_research.py 技能层' } },
    { name: '容错设计', values: { MiroThinker: '降级 len//4 估算', DeerFlow: '摘要失败回退保留最后 15 条', DeepResearch: '独立 ReSum 模型服务器不占主模型窗口', 'GPT-Researcher': 'Semaphore(2) 并发控制' } },
  ],
  best_practices: [
    '必须有估算：不管用什么方案，调用前必须知道当前 token 用量',
    '预留安全边际：MiroThinker 的 85% 策略值得借鉴，为输出预留 15-20% 空间',
    '分层裁剪优于一刀切：工具结果 > 旧对话 > 系统提示，按重要性分级',
    '压缩后要验证格式：悬挂工具调用修复是容易被忽略但很关键的细节',
    '考虑多提供商差异：不同 LLM 的 tokenizer 不同，需要适配',
  ],
};
// PLACEHOLDER_PD02

// ─── PD-02 多 Agent 编排 ───
const PD02: DomainData = {
  id: 'PD-02', slug: 'multi-agent-orchestration', title: '多 Agent 编排',
  subtitle: 'Multi-Agent Orchestration', icon: 'network', color: '#8b5cf6',
  severity: 'critical',
  description: '多个专职 Agent 如何协调执行顺序、并行分发任务、汇聚结果。核心挑战是在灵活性和可控性之间找到平衡。',
  tags: ['parallel', 'dag', 'lead-subagent', 'state-sync'],
  sub_problems: [
    '任务分解：将复杂任务拆分为可并行的子任务',
    '执行编排：DAG 调度、顺序/并行/条件分支',
    '状态同步：多 Agent 间共享上下文和中间结果',
    '结果汇聚：多个子 Agent 结果的合并与冲突解决',
    '动态路由：根据任务类型动态选择合适的 Agent',
  ],
  solutions: [
    {
      project: 'DeerFlow', source_id: '102.01', type: 'Solution',
      repo: 'https://github.com/bytedance/deer-flow',
      title: 'Lead Agent → SubagentExecutor 动态委派 + task_tool.py 并行编排',
      description: 'Lead Agent 通过 task_tool.py 调用 task() 工具动态委派子任务给 Subagent。SubagentExecutor（executor.py）使用双线程池架构：_scheduler_pool(3) 调度层 + _execution_pool(3) 执行层。SubagentConfig（config.py）定义 name/tools/model/timeout，支持 model="inherit" 复用父 Agent 模型。SubagentLimitMiddleware 截断超过 MAX_CONCURRENT_SUBAGENTS=3 的 task 调用。工具隔离通过 disallowed_tools=["task"] 防止递归嵌套。',
      signals: ['SubagentExecutor', 'task_tool', 'SubagentConfig', 'Lead_Agent', 'dual_thread_pool', 'SubagentLimitMiddleware'],
      score: 0.91, calls: 0,
      source_files: ['backend/src/subagents/executor.py', 'backend/src/subagents/config.py', 'backend/src/tools/builtins/task_tool.py', 'backend/src/agents/lead_agent/agent.py', 'backend/src/agents/middlewares/subagent_limit_middleware.py'],
      design_philosophy: ['动态编排器：Lead Agent 在运行时根据任务性质决定并行策略，而非编译时固定图结构', '双线程池隔离：_scheduler_pool 调度 + _execution_pool 执行，互不阻塞', '工具即委派：task() 工具是委派入口，Subagent 禁用 task 工具防止递归', '模型继承：model="inherit" 复用父 Agent 模型，减少配置冗余'],
      migration_scenarios: ['需要运行时动态决定并行策略的复杂任务', '多 Subagent 并行执行且需要超时保护和状态追踪的场景', '已有 LangGraph DAG 但需要在节点内部引入并行委派的项目'],
    },
    {
      project: 'GPT-Researcher', source_id: '41.02', type: 'Solution',
      repo: 'https://github.com/assafelovic/gpt-researcher',
      title: 'DeepResearchSkill 树状递归 breadth=4 depth=2 + asyncio.Semaphore(2) 并发控制',
      description: 'gpt_researcher/skills/deep_research.py 的 DeepResearchSkill 实现树状递归研究：每层生成 breadth 个子查询，每个子查询创建独立 GPTResearcher 实例执行 conduct_research()。breadth 逐层减半 max(2, breadth//2) 控制指数爆炸。asyncio.Semaphore(2) 限制并发。跨层共享 visited_urls 去重 + learnings 知识累积。默认参数 breadth=4 depth=2 产生约 36 次搜索 + 20 次 LLM 调用，耗时 3-5 分钟。',
      signals: ['DeepResearchSkill', 'breadth_depth', 'asyncio_Semaphore', 'visited_urls', 'conduct_research', 'tree_recursion'],
      score: 0.87, calls: 0,
      source_files: ['gpt_researcher/skills/deep_research.py', 'gpt_researcher/researcher/research_agent.py'],
      design_philosophy: ['每个子查询独立 Researcher：GPTResearcher(query=sub_q) 隔离状态避免污染', 'breadth 逐层减半：max(2, breadth//2) 控制指数爆炸', '跨层知识累积：learnings 传递给后续层，后续层基于前序知识生成子查询', '并发控制：asyncio.Semaphore(2) 避免 API 限流'],
      migration_scenarios: ['需要树状递归深度研究的搜索密集型 Agent', '多源信息聚合需要并行子查询的场景', '研究类 Agent 需要控制搜索爆炸的项目'],
    },
    {
      project: 'MiroThinker', source_id: '37.05', type: 'Solution',
      repo: 'https://github.com/MiroMindAI/MiroThinker',
      title: 'run_sub_agent() 子 Agent 即工具 + expose_sub_agents_as_tools() 配置驱动',
      description: 'orchestrator.py:327-499 的 run_sub_agent() 实现子 Agent 独立执行：独立 system_prompt、tool_definitions、message_history、max_turns 限制。settings.py 的 expose_sub_agents_as_tools() 将子 Agent 暴露为主 Agent 可调用的工具。YAML 配置（conf/agent/multi_agent.yaml）定义 main_agent 和 sub_agents（agent-browsing/agent-research/agent-citation），每个子 Agent 有独立工具集和轮次限制。',
      signals: ['run_sub_agent', 'expose_sub_agents_as_tools', 'sub_agent_as_tool', 'independent_context', 'multi_agent_yaml'],
      score: 0.82, calls: 0,
      source_files: ['orchestrator.py:327-499', 'settings.py', 'conf/agent/multi_agent.yaml'],
      design_philosophy: ['子 Agent 即工具：主 Agent 通过工具调用接口委派子任务，调用方式统一', '独立上下文：每个子 Agent 有独立消息历史，不污染主 Agent', 'YAML 配置驱动：sub_agents 配置定义工具集和轮次限制', '独立 Session 追踪：子 Agent 执行记录在独立 session 中'],
      migration_scenarios: ['需要子 Agent 独立上下文和工具集的多角色场景', '主 Agent 需要动态委派子任务的项目', '不需要并行但需要角色隔离的顺序工作流'],
    },
  ],
  comparison_dimensions: [
    { name: '编排模式', values: { DeerFlow: 'Lead Agent → task_tool 动态委派', 'GPT-Researcher': 'DeepResearchSkill 树状递归', MiroThinker: 'run_sub_agent() 子 Agent 即工具' } },
    { name: '并行能力', values: { DeerFlow: '双线程池 _scheduler_pool + _execution_pool', 'GPT-Researcher': 'asyncio.Semaphore(2) 异步并发', MiroThinker: '顺序执行（子 Agent 独立轮次）' } },
    { name: '状态管理', values: { DeerFlow: 'SubagentConfig + SubagentResult + 5 态状态机', 'GPT-Researcher': 'visited_urls + learnings 跨层传递', MiroThinker: '独立 message_history 不污染主 Agent' } },
    { name: '并发限制', values: { DeerFlow: 'SubagentLimitMiddleware MAX_CONCURRENT=3', 'GPT-Researcher': 'Semaphore(2) + breadth 逐层减半', MiroThinker: '无（顺序执行）' } },
    { name: '工具隔离', values: { DeerFlow: 'disallowed_tools=["task"] 防递归嵌套', 'GPT-Researcher': '每个子查询独立 GPTResearcher 实例', MiroThinker: 'YAML 配置独立工具集 per sub_agent' } },
  ],
  best_practices: [
    '从简单开始：单 Agent + 多工具往往比多 Agent 更容易调试',
    '明确角色边界：每个 Agent 的职责要清晰，避免职责重叠',
    '状态要可序列化：Agent 间传递的状态必须可序列化，便于持久化和恢复',
    '超时和熔断：并行 Agent 需要超时机制，防止单个 Agent 阻塞整体',
    '结果验证：汇聚结果时要检查一致性，处理冲突',
  ],
};
// PLACEHOLDER_PD03

// ─── PD-03 容错与重试 ───
const PD03: DomainData = {
  id: 'PD-03', slug: 'fault-tolerance', title: '容错与重试',
  subtitle: 'Fault Tolerance & Retry', icon: 'shield', color: '#ec4899',
  severity: 'critical',
  description: 'LLM 调用失败、响应截断、格式错误时如何检测、恢复、重试。Agent 系统的鲁棒性取决于容错设计。',
  tags: ['retry', 'rollback', 'degradation', 'exponential-backoff'],
  sub_problems: [
    'API 调用失败：网络超时、速率限制、服务不可用',
    '响应格式错误：JSON 解析失败、缺少必要字段',
    '响应截断：输出超过 max_tokens 被截断',
    '幻觉检测：LLM 生成不存在的工具名或参数',
    '级联失败：一个 Agent 失败导致整个流程崩溃',
  ],
  solutions: [
    {
      project: 'MiroThinker', source_id: '37.32', type: 'Solution',
      repo: 'https://github.com/MiroMindAI/MiroThinker',
      title: 'openai_client.py 截断自动扩容 + 错误分类重试 + with_timeout() 超时保护',
      description: 'openai_client.py:128-192 检测 finish_reason=="length" 后自动扩容 max_tokens*1.1，最多 10 次重试，最后一次仍截断则返回截断结果不崩溃。openai_client.py:228-277 智能错误分类：TimeoutError→重试、CancelledError→直接抛出、"Error code: 400"+"longer than"→上下文超限快速失败。base_client.py:222 的 @with_timeout(600) 为 LLM 调用加 10 分钟超时保护。固定 30s 等待间隔。',
      signals: ['finish_reason_length', 'auto_expand_max_tokens', 'error_classification', 'with_timeout', 'context_overflow_fast_fail'],
      score: 0.90, calls: 0,
      source_files: ['openai_client.py:128-192', 'openai_client.py:228-277', 'base_client.py:222', 'util.py'],
      design_philosophy: ['截断检测：finish_reason=="length" 是唯一可靠的截断信号', '渐进扩容：每次 +10% max_tokens，最多 10 次，避免一次性分配过大', '优雅降级：最后一次仍截断→返回截断结果让 ReAct 循环继续，不崩溃', '错误分类：上下文超限→快速失败不浪费重试次数，取消→直接抛出不重试'],
      migration_scenarios: ['LLM 响应频繁被截断的长文生成场景', '需要区分可重试/不可重试错误的 API 调用', '多轮 Agent 需要超时保护防止无限等待的项目'],
    },
    {
      project: 'DeerFlow', source_id: '102.07', type: 'Solution',
      repo: 'https://github.com/bytedance/deer-flow',
      title: 'SubagentExecutor 5 态状态机 + 双线程池 + DanglingToolCallMiddleware 悬挂修复',
      description: 'executor.py 实现 5 态状态机 PENDING→RUNNING→COMPLETED/FAILED/TIMED_OUT。双线程池：_scheduler_pool(3) + _execution_pool(3)。15 分钟硬超时 execution_future.result(timeout=900s)，FuturesTimeoutError 标记 TIMED_OUT 并 cancel()。DanglingToolCallMiddleware 在 before_model 钩子扫描缺少 ToolMessage 的 AIMessage.tool_calls，注入 status="error" 占位消息。全局 _background_tasks + 线程锁保证并发安全。',
      signals: ['SubagentStatus', 'TIMED_OUT', 'dual_thread_pool', 'DanglingToolCallMiddleware', 'FuturesTimeoutError', 'background_tasks'],
      score: 0.88, calls: 0,
      source_files: ['backend/src/subagents/executor.py', 'backend/src/agents/middlewares/dangling_tool_call_middleware.py', 'backend/src/subagents/config.py'],
      design_philosophy: ['5 态状态机：PENDING/RUNNING/COMPLETED/FAILED/TIMED_OUT 完整覆盖所有执行结果', '双线程池隔离：调度层和执行层互不阻塞，调度层超时可取消执行层', '悬挂修复前置：before_model 钩子确保 LLM 永远看到格式正确的消息历史', '全局任务字典 + 线程锁：_background_tasks 保证并发安全的任务追踪'],
      migration_scenarios: ['多 Subagent 并行执行需要统一状态追踪的场景', '用户中断/网络超时导致工具调用悬挂的 LangGraph 工作流', '需要 15 分钟级硬超时保护的长时间 Agent 任务'],
    },
    {
      project: 'GPT-Researcher', source_id: '41.02', type: 'Solution',
      repo: 'https://github.com/assafelovic/gpt-researcher',
      title: 'visited_urls 跨层去重 + Semaphore(2) 并发保护 + 搜索源降级链',
      description: 'DeepResearchSkill 树状递归中 visited_urls 集合跨层传递，URL 级去重避免重复抓取。asyncio.Semaphore(2) 限制每层最多 2 个子查询并发，防止 API 限流。每个子查询创建独立 GPTResearcher 实例隔离状态。搜索源失败时自动降级：Tavily→Google→搜索摘要兜底。breadth 逐层减半 max(2, breadth//2) 控制指数爆炸。最终 trim_context_to_word_limit(25000) 裁剪上下文。',
      signals: ['visited_urls', 'Semaphore', 'source_fallback', 'breadth_halving', 'trim_context_to_word_limit', 'independent_researcher'],
      score: 0.84, calls: 0,
      source_files: ['gpt_researcher/skills/deep_research.py', 'gpt_researcher/retrievers/tavily/', 'gpt_researcher/retrievers/google/'],
      design_philosophy: ['跨层去重：visited_urls 集合在递归层间共享，URL 级去重避免重复抓取和浪费 token', '并发保护：Semaphore(2) 限流防止 API 被封，每个子查询独立 Researcher 实例隔离状态', '指数爆炸控制：breadth 逐层减半 max(2, breadth//2)，默认 depth=2 breadth=4 总计约 36 次搜索', '部分结果优于无结果：搜索源降级链确保即使主源失败也能获取素材'],
      migration_scenarios: ['树状递归搜索需要跨层 URL 去重的深度研究场景', '多搜索源并发需要限流保护的 API 密集型 Agent', '需要搜索源降级链保证高可用的生产环境'],
    },
  ],
  comparison_dimensions: [
    { name: '截断/错误检测', values: { MiroThinker: 'finish_reason=="length" 检测截断', DeerFlow: 'DanglingToolCallMiddleware 扫描悬挂 tool_calls', 'GPT-Researcher': 'visited_urls 跨层去重检测重复' } },
    { name: '重试/恢复策略', values: { MiroThinker: 'max_tokens*1.1 渐进扩容，最多 10 次', DeerFlow: '5 态状态机 FAILED→重新调度', 'GPT-Researcher': '搜索源降级链 Tavily→Google→摘要' } },
    { name: '超时保护', values: { MiroThinker: '@with_timeout(600) 10 分钟', DeerFlow: 'execution_future.result(timeout=900s) 15 分钟', 'GPT-Researcher': 'Semaphore(2) 并发限流' } },
    { name: '优雅降级', values: { MiroThinker: '最后一次仍截断→返回截断结果继续', DeerFlow: 'TIMED_OUT 状态 + cancel() 清理', 'GPT-Researcher': 'breadth 逐层减半 + trim_context 25000 words' } },
  ],
  best_practices: [
    '必须有重试：任何 LLM 调用都可能失败，重试是基本要求',
    '指数退避 + 抖动：避免重试风暴，加入随机抖动',
    '设置最大重试次数：无限重试会耗尽预算',
    '日志记录每次失败：便于事后分析失败模式',
    '降级方案要预先设计：不要在生产环境临时决定降级策略',
  ],
};
// PLACEHOLDER_PD04

// ─── PD-04 工具系统 ───
const PD04: DomainData = {
  id: 'PD-04', slug: 'tool-system', title: '工具系统',
  subtitle: 'Tool System Design', icon: 'wrench', color: '#f59e0b',
  severity: 'high',
  description: '统一管理、注册、发现、执行工具；MCP 协议标准化。工具系统是 Agent 能力的边界。',
  tags: ['mcp', 'tool-manager', 'hot-reload', 'permission'],
  sub_problems: [
    '工具注册：如何定义和注册工具的 schema（名称、参数、返回值）',
    '工具发现：Agent 如何知道有哪些工具可用',
    '权限控制：哪些工具需要用户确认才能执行',
    '结果格式化：工具返回结果如何格式化为 LLM 可理解的文本',
    'MCP 协议：Model Context Protocol 标准化工具接口',
  ],
  solutions: [
    {
      project: 'DeerFlow', source_id: '102.08', type: 'Solution',
      repo: 'https://github.com/bytedance/deer-flow',
      title: 'config.yaml → ToolConfig → resolve_variable() 反射加载 + tool_groups 分组 + SubagentConfig 白/黑名单',
      description: 'config.yaml 声明式配置工具（name/group/use 三元组），ToolConfig(Pydantic) 解析后通过 resolve_variable() 反射加载：importlib.import_module(module_path) + getattr(module, variable_name) + isinstance 类型校验。4 个 tool_groups（web/file:read/file:write/bash），get_available_tools(groups=["web"]) 按组过滤。社区工具统一模式：src/community/ 下每个工具用 @tool("tool_name") 装饰器，通过 get_app_config().get_tool_config("tool_name").model_extra 读取 YAML 额外参数。SubagentConfig 支持 tools（白名单）和 disallowed_tools（黑名单，默认禁止 "task" 防递归委派）。ConfigDict(extra="allow") 实现参数透传。',
      signals: ['resolve_variable', 'ToolConfig', 'tool_groups', 'get_available_tools', 'SubagentConfig', 'disallowed_tools', 'model_extra', 'community_tools'],
      score: 0.91, calls: 0,
      source_files: ['deer-flow/config.example.yaml', 'deer-flow/src/config/tool_config.py', 'deer-flow/src/reflection/resolvers.py', 'deer-flow/src/tools/tools.py', 'deer-flow/src/community/tavily/tools.py', 'deer-flow/src/subagents/config.py'],
      design_philosophy: ['声明式配置：YAML 中 name/group/use 三元组，改 use 路径即可切换工具实现（如 Tavily→Firecrawl）', '反射加载：resolve_variable() 通过 importlib 动态加载，零硬编码依赖', '分组权限：4 个 tool_groups 实现 Subagent 级别的工具权限隔离', '参数透传：ConfigDict(extra="allow") + model_extra 让 YAML 额外字段自动传递给工具'],
      migration_scenarios: ['需要声明式配置管理大量工具的项目（改 YAML 不改代码）', '多 Subagent 需要不同工具权限的编排场景（tool_groups + 白/黑名单）', '需要社区工具插件化扩展的开放平台（src/community/ 模式）'],
    },
    {
      project: 'DeerFlow', source_id: '1002.06', type: 'Solution',
      repo: 'https://github.com/bytedance/deer-flow',
      title: 'MCP 协议集成：McpServerConfig + get_cached_mcp_tools() mtime 缓存 + 三种传输协议',
      description: 'backend/src/mcp/ 4 个文件约 200 行实现完整 MCP 集成。McpServerConfig(Pydantic) 定义 enabled/type/command/args/env/url/headers。build_servers_config() 遍历已启用服务器构建 langchain-mcp-adapters 参数，错误隔离（单服务器失败不影响其他）。get_mcp_tools() 每次从磁盘读取最新配置确保 Gateway API 修改立即生效。get_cached_mcp_tools() 基于文件 mtime 缓存失效 + asyncio.Lock 防并发 + ThreadPoolExecutor 兼容同步环境。支持 stdio/SSE/HTTP 三种传输协议。resolve_env_variables() 递归解析 $ENV_VAR。4 级配置文件查找优先级：参数→环境变量→CWD→父目录。',
      signals: ['McpServerConfig', 'get_cached_mcp_tools', 'mtime_cache', 'build_servers_config', 'MultiServerMCPClient', 'resolve_env_variables', 'stdio_sse_http'],
      score: 0.88, calls: 0,
      source_files: ['deer-flow/backend/src/config/extensions_config.py:11-22', 'deer-flow/backend/src/mcp/client.py:11-68', 'deer-flow/backend/src/mcp/tools.py:13-49', 'deer-flow/backend/src/mcp/cache.py:17-126', 'deer-flow/backend/src/tools/tools.py:50-64'],
      design_philosophy: ['配置即扩展：编辑 JSON 配置文件即可接入新 MCP 服务器，零代码修改', 'mtime 缓存失效：基于文件修改时间自动检测配置变更，Gateway API 修改立即生效', '错误隔离：单个 MCP 服务器失败不影响其他服务器和内置工具', '传输协议抽象：stdio（本地进程）/SSE（流式）/HTTP（标准）三种传输统一接口'],
      migration_scenarios: ['需要零代码接入社区 MCP 服务器（GitHub/文件系统/数据库等）的项目', '需要工具热更新（mtime 自动检测）的生产环境', '同时需要本地工具（stdio）和远程工具（SSE/HTTP）的混合部署场景'],
    },
    {
      project: 'MiroThinker', source_id: '37.09', type: 'Solution',
      repo: 'https://github.com/MiroMindAI/MiroThinker',
      title: 'ToolManager MCP 多服务器管理 + tool_blacklist + @with_timeout(1200) + fix_tool_call_arguments()',
      description: 'manager.py 的 ToolManager(ToolManagerProtocol) 统一管理多个 MCP 服务器。server_configs 列表定义 7 种工具服务器（tool-python/tool-google-search/tool-jina-scrape/tool-reasoning/tool-reader/tool-vqa/tool-transcribe），每个用 StdioServerParameters 配置。get_all_tool_definitions() 获取所有工具 schema，execute_tool_call(server_name, tool_name, arguments) 执行调用。tool_blacklist 集合禁用特定工具。@with_timeout(1200) 装饰器为工具执行加 20 分钟超时保护。fix_tool_call_arguments() 修正 LLM 常见参数错误。支持持久化浏览器会话 browser_session。',
      signals: ['ToolManager', 'ToolManagerProtocol', 'StdioServerParameters', 'tool_blacklist', 'with_timeout_1200', 'fix_tool_call_arguments', 'get_all_tool_definitions', 'execute_tool_call'],
      score: 0.87, calls: 0,
      source_files: ['manager.py', 'conf/agent/multi_agent.yaml'],
      design_philosophy: ['MCP 原生：基于 Model Context Protocol 标准化所有工具接口，7 种工具服务器统一管理', '黑名单机制：tool_blacklist 集合动态禁用特定工具，运行时可调整', '超时保护：@with_timeout(1200) 20 分钟硬超时防止工具执行卡死', '参数修正：fix_tool_call_arguments() 自动修正 LLM 常见的参数格式错误，提高工具调用成功率'],
      migration_scenarios: ['需要 MCP 协议统一管理多种工具服务器的项目', '工具执行时间长（代码执行/网页抓取）需要超时保护的场景', 'LLM 工具调用参数经常出错需要自动修正的 Agent 系统'],
    },
  ],
  comparison_dimensions: [
    { name: '工具注册方式', values: { 'DeerFlow(配置)': 'YAML config.yaml → resolve_variable() 反射加载', 'DeerFlow(MCP)': 'JSON mcp_config.json → McpServerConfig', MiroThinker: 'server_configs 列表 + StdioServerParameters' } },
    { name: '工具分组/权限', values: { 'DeerFlow(配置)': 'tool_groups(web/file:read/file:write/bash) + SubagentConfig 白/黑名单', 'DeerFlow(MCP)': 'enabled 字段控制启用/禁用', MiroThinker: 'tool_blacklist 集合禁用特定工具' } },
    { name: 'MCP 协议支持', values: { 'DeerFlow(配置)': '内置工具用 @tool 装饰器，MCP 工具通过 get_cached_mcp_tools() 合并', 'DeerFlow(MCP)': '完整支持 stdio/SSE/HTTP 三种传输', MiroThinker: 'MCP 原生，7 种 StdioServerParameters 工具服务器' } },
    { name: '热更新/缓存', values: { 'DeerFlow(配置)': '改 YAML use 路径切换实现，需重启', 'DeerFlow(MCP)': 'mtime 缓存失效自动检测配置变更', MiroThinker: '启动时加载，运行时固定' } },
    { name: '超时保护', values: { 'DeerFlow(配置)': '无内置超时', 'DeerFlow(MCP)': '无内置超时', MiroThinker: '@with_timeout(1200) 20 分钟硬超时' } },
  ],
  best_practices: [
    '工具描述要精确：LLM 根据描述选择工具，模糊描述导致误选',
    '参数要有默认值：减少 LLM 需要决策的参数数量',
    '返回结果要结构化：便于 LLM 解析和引用',
    '危险操作需确认：文件删除、网络请求等需要 human-in-the-loop',
    '工具数量要控制：太多工具会稀释 LLM 的选择准确率',
  ],
};

// ─── PD-05 沙箱隔离 ───
const PD05: DomainData = {
  id: 'PD-05', slug: 'sandbox-isolation', title: '沙箱隔离',
  subtitle: 'Sandbox Isolation', icon: 'box', color: '#10b981',
  severity: 'high',
  description: 'Agent 执行代码时如何隔离环境，防止宿主机污染。安全性和便利性的平衡。',
  tags: ['docker', 'e2b', 'subprocess', 'virtual-path'],
  sub_problems: [
    '代码执行隔离：用户代码在沙箱中运行，不影响宿主机',
    '文件系统隔离：Agent 只能访问指定目录',
    '网络隔离：限制 Agent 的网络访问范围',
    '资源限制：CPU、内存、执行时间的限制',
    '环境一致性：沙箱环境与目标环境的一致性',
  ],
  solutions: [
    {
      project: 'DeerFlow', source_id: '102.04', type: 'Solution',
      repo: 'https://github.com/bytedance/deer-flow',
      title: 'SandboxProvider ABC + 虚拟路径映射 + 中间件生命周期',
      description: '经典 Provider + Sandbox 双层抽象：SandboxProvider(ABC) 管理沙箱生命周期（acquire/get/release），Sandbox(ABC) 提供 5 个工具（bash/ls/read_file/write_file/str_replace）。LocalSandbox 用 subprocess + 本地 FS（全局单例），AioSandbox 用 HTTP API → Docker/Apple Container。虚拟路径系统将 /mnt/user-data/workspace/* 双层翻译（工具层 replace_virtual_path + 沙箱层 _resolve_path + 输出反向翻译 _reverse_resolve_paths_in_output）。SandboxMiddleware 控制懒初始化（lazy_init=True 延迟到首次工具调用），AioSandbox 支持确定性 ID sha256(thread_id)[:8]、空闲超时回收 600s、atexit 优雅关闭。',
      signals: ['SandboxProvider', 'LocalSandbox', 'AioSandbox', 'virtual_path', '_resolve_path', 'SandboxMiddleware', 'lazy_init'],
      score: 0.90, calls: 0,
      source_files: ['deer-flow/src/sandbox/sandbox.py', 'deer-flow/src/sandbox/local_sandbox.py', 'deer-flow/src/sandbox/aio_sandbox.py', 'deer-flow/src/tools/tools.py', 'deer-flow/src/agents/middlewares/sandbox_middleware.py', 'deer-flow/config.yaml'],
      design_philosophy: ['双层抽象：Provider 管生命周期（acquire/get/release），Sandbox 管执行操作（5 个工具），职责分离', '虚拟路径统一视角：Agent 始终看到 /mnt/user-data/* 虚拟路径，双层翻译（工具层 + 沙箱层）+ 输出反向翻译', '懒初始化：SandboxMiddleware lazy_init=True 延迟到首次工具调用才 acquire，避免不需要沙箱的 Agent 浪费资源', '配置驱动切换：config.yaml 中 sandbox.use 字段通过 resolve_class() 反射动态加载实现类'],
      migration_scenarios: ['需要代码执行隔离的 Agent 项目（5 个沙箱工具即插即用）', '多租户场景需要每线程独立沙箱（AioSandbox 确定性 ID + 空闲回收）', '开发用 LocalSandbox、生产切 AioSandbox 的渐进式部署（config.yaml 一行切换）'],
    },
    {
      project: 'MiroThinker', source_id: '37.01', type: 'Solution',
      repo: 'https://github.com/MiroMindAI/MiroThinker',
      title: 'E2B Code Interpreter 云沙箱 + LLM 自动修复',
      description: 'python_mcp_server.py 通过 e2b_code_interpreter.Sandbox 提供云端代码执行环境。核心常量：DEFAULT_TIMEOUT=600s 单次执行超时、MAX_RESULT_LEN=20000 字符结果截断、MAX_ERROR_LEN=4000 字符错误截断。INVALID_SANDBOX_IDS 黑名单（default/sandbox1/sandbox/some_id/new_sandbox）防止 LLM 瞎编 sandbox ID。支持文件上传到沙箱。每个任务独立 Sandbox 实例互不干扰。迁移适配为 CodeValidatorService：超时降为 30s、结果截断降为 5000 字符、validate_and_fix() 验证失败后用 LLM 自动修复代码（最多 2 次）。',
      signals: ['e2b_code_interpreter', 'Sandbox', 'DEFAULT_TIMEOUT_600', 'MAX_RESULT_LEN_20000', 'INVALID_SANDBOX_IDS', 'CodeValidatorService', 'validate_and_fix'],
      score: 0.88, calls: 0,
      source_files: ['MiroThinker/libs/miroflow-tools/src/miroflow_tools/mcp_servers/python_mcp_server.py'],
      design_philosophy: ['云端隔离：E2B 沙箱完全隔离，每个任务独立 Sandbox 实例', '防御性设计：INVALID_SANDBOX_IDS 黑名单防止 LLM 幻觉生成无效 ID', '结果截断保护：20K 字符输出截断 + 4K 错误截断，避免 token 爆炸', '验证-修复闭环：validate_and_fix() 验证失败 → 错误信息反馈 LLM → 重新生成 → 再验证'],
      migration_scenarios: ['需要云端强隔离代码执行的生产环境', '博客/教程生成中代码示例需要验证可运行的场景', '需要 LLM 自动修复代码错误的 Agent（validate_and_fix 模式）'],
    },
  ],
  comparison_dimensions: [
    { name: '隔离级别', values: { DeerFlow: 'Provider+Sandbox 双层抽象（Local subprocess / Aio Docker）', MiroThinker: 'E2B 云沙箱（完全隔离）' } },
    { name: '虚拟路径', values: { DeerFlow: '/mnt/user-data/* 双层翻译 + 输出反向翻译', MiroThinker: '无（直接操作沙箱内路径）' } },
    { name: '生命周期管理', values: { DeerFlow: 'SandboxMiddleware 懒初始化 + 空闲超时回收 600s', MiroThinker: '每任务独立实例 + DEFAULT_TIMEOUT=600s' } },
    { name: '防御性设计', values: { DeerFlow: '结构化异常体系（SandboxError 层级）', MiroThinker: 'INVALID_SANDBOX_IDS 黑名单 + 结果/错误截断' } },
    { name: '代码修复', values: { DeerFlow: '无', MiroThinker: 'validate_and_fix() LLM 自动修复（最多 2 次）' } },
  ],
  best_practices: [
    '双层抽象是最佳实践：Provider 管生命周期、Sandbox 管操作，DeerFlow 的模式值得借鉴',
    '虚拟路径必须双向翻译：输入翻译 + 输出反向翻译，否则 Agent 看到真实路径会混乱',
    '懒初始化节省资源：不是所有 Agent 都需要沙箱，首次工具调用才创建',
    '设置执行超时：MiroThinker 600s、博客场景 30s，防止死循环耗尽资源',
    '防御 LLM 幻觉：INVALID_SANDBOX_IDS 黑名单是简单有效的防御手段',
    '结果截断保护：输出超过阈值自动截断，避免 token 爆炸',
  ],
};
// PLACEHOLDER_PD06

// ─── PD-06 记忆持久化 ───
const PD06: DomainData = {
  id: 'PD-06', slug: 'memory-persistence', title: '记忆持久化',
  subtitle: 'Memory Persistence', icon: 'database', color: '#06b6d4',
  severity: 'high',
  description: '跨会话的用户偏好、历史上下文、事实知识如何存储和检索。Agent 的"长期记忆"。',
  tags: ['vector-store', 'structured-memory', 'debounce', 'cross-session'],
  sub_problems: [
    '记忆存储：选择合适的存储后端（向量库、KV 存储、文件系统）',
    '记忆检索：如何高效检索相关记忆',
    '记忆更新：新信息如何更新或覆盖旧记忆',
    '记忆过期：过时信息的清理策略',
    '跨会话：不同会话间共享记忆',
  ],
  solutions: [
    {
      project: 'DeerFlow', source_id: '102.03', type: 'Solution',
      repo: 'https://github.com/bytedance/deer-flow',
      title: '三层记忆结构 + MemoryUpdateQueue 防抖队列 + LLM 自动事实提取',
      description: 'user/history/facts 三层记忆存储在 memory.json：user 层含 workContext(2-3句)/personalContext(1-2句)/topOfMind(3-5句)，history 层含 recentMonths(4-6句)/earlierContext(3-5句)/longTermBackground(2-4句)，facts 层为离散事实列表（5 类：preference/knowledge/context/behavior/goal）。MemoryUpdateQueue 实现 30s 防抖（threading.Timer）+ thread_id 去重 + threading.Lock 并发安全 + _processing 标志防重入 + 批处理间 0.5s 间隔。MemoryUpdater 用 LLM 分析对话提取结构化 JSON（6 维上下文 shouldUpdate 判断 + newFacts 置信度过滤 + factsToRemove 清理），原子写入（temp + rename）。MemoryMiddleware.after_agent() 过滤消息（仅保留 human + 无 tool_calls 的 AI）后入队。',
      signals: ['MemoryUpdateQueue', 'MemoryUpdater', 'MemoryMiddleware', 'memory_json', 'debounce_30s', 'fact_confidence', 'atomic_write'],
      score: 0.91, calls: 0,
      source_files: ['deer-flow/backend/src/agents/memory/queue.py', 'deer-flow/backend/src/agents/memory/updater.py', 'deer-flow/backend/src/agents/memory/prompt.py', 'deer-flow/backend/src/agents/middlewares/memory_middleware.py', 'deer-flow/backend/src/config/memory_config.py'],
      design_philosophy: ['LLM-as-Memory-Extractor：LLM 比规则更懂哪些信息值得记住，能捕获隐含偏好', 'Debounce-then-Batch：30s 防抖窗口收集多轮对话后批量处理，平衡实时性与 API 成本', 'Confidence-Gated Fact Storage：置信度 0.7 阈值门控，超过上限按置信度排序淘汰低分事实（自然遗忘）', 'Middleware-Driven Injection：MemoryMiddleware 在 after_agent 钩子自动入队，对业务代码完全透明'],
      migration_scenarios: ['需要跨会话记住用户偏好的 Agent 项目', '对话频繁需要防抖降低 LLM 调用成本的场景', '需要 LLM 自动提取结构化事实（而非手动 add_fact）的项目'],
    },
    {
      project: 'DeerFlow', source_id: '1002.05', type: 'Solution',
      repo: 'https://github.com/bytedance/deer-flow',
      title: 'MemoryConfig Pydantic 配置化 + Gateway API 暴露',
      description: 'MemoryConfig(BaseModel) 定义 8 项可配置参数：enabled(bool)/storage_path(str)/debounce_seconds(int,ge=1,le=300)/model_name(Optional[str])/max_facts(int,ge=10,le=500)/fact_confidence_threshold(float,ge=0.0,le=1.0)/injection_enabled(bool)/max_injection_tokens(int,ge=100,le=10000)。全局单例模式：get_memory_config() 线程安全获取、load_memory_config_from_dict() 从字典加载。Gateway API 暴露 3 个 REST 端点（GET/PUT /api/memory/config + POST /api/memory/config/reset）。被 6 个模块消费：queue/updater/middleware/prompt/gateway router/lead_agent。',
      signals: ['MemoryConfig', 'get_memory_config', 'load_memory_config_from_dict', 'Pydantic_BaseModel', 'gateway_api', 'global_singleton'],
      score: 0.85, calls: 0,
      source_files: ['deer-flow/backend/src/config/memory_config.py', 'deer-flow/backend/src/agents/memory/queue.py', 'deer-flow/backend/src/agents/memory/updater.py', 'deer-flow/backend/src/agents/middlewares/memory_middleware.py', 'deer-flow/backend/src/gateway/routers/memory.py'],
      design_philosophy: ['配置即文档：Pydantic BaseModel 自带类型校验和边界约束，配置项自描述', '全局单例 + 运行时可变：get_memory_config() 保证全局一致，Gateway API 支持运行时动态修改', '6 模块消费统一配置源：queue/updater/middleware/prompt/gateway/lead_agent 都从同一 config 读取', 'REST API 暴露：前端可直接调 GET/PUT 管理记忆配置，无需重启服务'],
      migration_scenarios: ['需要运行时动态调整记忆参数的 Agent 项目', '多模块共享配置的场景（避免各模块硬编码不同默认值）', '需要通过 API 暴露配置给前端管理界面的项目'],
    },
  ],
  comparison_dimensions: [
    { name: '记忆结构', values: { 'DeerFlow(102.03)': 'user/history/facts 三层 + 6 维上下文', 'DeerFlow(1002.05)': '8 项 Pydantic 配置参数' } },
    { name: '更新机制', values: { 'DeerFlow(102.03)': 'MemoryUpdateQueue 30s 防抖 + thread_id 去重 + 批处理', 'DeerFlow(1002.05)': 'Gateway REST API 运行时动态修改' } },
    { name: '事实提取', values: { 'DeerFlow(102.03)': 'LLM 结构化输出（5 类 fact + 置信度 0.7 阈值）', 'DeerFlow(1002.05)': '配置 fact_confidence_threshold/max_facts 控制提取行为' } },
    { name: '存储方式', values: { 'DeerFlow(102.03)': '单 JSON 文件 + 原子写入（temp + rename）', 'DeerFlow(1002.05)': '全局单例 MemoryConfig + 6 模块消费' } },
    { name: '注入方式', values: { 'DeerFlow(102.03)': 'MemoryMiddleware after_agent 自动入队 + format_memory_for_injection() 注入 <memory> 标签', 'DeerFlow(1002.05)': 'injection_enabled + max_injection_tokens 控制注入行为' } },
  ],
  best_practices: [
    'LLM 提取优于手动记录：LLM 能捕获对话中隐含的偏好和背景，手动 add_fact 粒度太粗',
    '防抖是必须的：30s 窗口 + thread_id 去重，避免高频对话场景下 LLM 调用浪费',
    '置信度门控：不是所有信息都值得记住，0.7 阈值过滤低价值事实',
    '配置化而非硬编码：8 项参数都应可配置，支持运行时动态调整',
    '原子写入保护数据：temp + rename 模式防止写入中断导致数据损坏',
    '中间件模式对业务透明：记忆的读写不应侵入业务代码',
  ],
};

// ─── PD-07 质量检查 ───
const PD07: DomainData = {
  id: 'PD-07', slug: 'quality-assurance', title: '质量检查',
  subtitle: 'Quality Assurance', icon: 'check-circle', color: '#84cc16',
  severity: 'high',
  description: '生成内容的多维自动评估、Generator-Critic 迭代循环。确保 Agent 输出质量。',
  tags: ['reviewer', 'fact-check', 'consistency', 'scoring'],
  sub_problems: [
    '事实核查：生成内容是否与源材料一致',
    '格式检查：输出是否符合预期格式',
    '一致性检查：多次生成的结果是否一致',
    '评分机制：自动化质量评分',
    '迭代改进：Generator-Critic 循环直到质量达标',
  ],
  solutions: [
    {
      project: 'DeerFlow', source_id: '102.07', type: 'Solution',
      repo: 'https://github.com/bytedance/deer-flow',
      title: '三层容错隔离 + SubagentStatus 5 状态机 + 故障隔离矩阵',
      description: 'DeerFlow 实现三层容错：工作流层（recursion_limit=25/50 防止无限循环）、Agent 层（SubagentStatus 5 状态机 PENDING→RUNNING→COMPLETED/FAILED/TIMED_OUT + 双线程池架构）、LLM 调用层（DanglingToolCallMiddleware 自动注入 status="error" 占位消息修复悬挂工具调用 + SummarizationMiddleware 三触发压缩）。故障隔离矩阵：核心节点（coordinator/planner）重试、增强节点（researcher/coder）跳过、循环节点（human_feedback）有 recursion_limit。',
      signals: ['SubagentStatus', 'DanglingToolCallMiddleware', 'recursion_limit', 'fault_isolation_matrix', 'three_layer_fault_tolerance'],
      score: 0.89, calls: 0,
      source_files: ['deer-flow/backend/src/agents/middlewares/dangling_tool_call_middleware.py', 'deer-flow/backend/src/config/summarization_config.py', 'deer-flow/backend/src/agents/subagents/executor.py'],
      design_philosophy: ['三层容错分治：工作流/Agent/LLM 调用各层独立容错，不互相依赖', '故障隔离矩阵：核心节点重试、增强节点跳过、循环节点限制递归，按节点重要性差异化处理', '5 状态机精确追踪：PENDING→RUNNING→COMPLETED/FAILED/TIMED_OUT，每个子 Agent 状态可观测', '悬挂工具调用自动修复：DanglingToolCallMiddleware 在 before_model 钩子扫描并注入占位消息'],
      migration_scenarios: ['多 Agent 编排中需要按节点重要性差异化容错的项目', '长流程 Agent 需要 recursion_limit 防止无限循环的场景', '工具调用频繁、网络不稳定导致悬挂调用的 Agent 系统'],
    },
    {
      project: 'VibeBlog', source_id: '13', type: 'Solution',
      repo: 'https://github.com/user/vibe-blog',
      title: 'Reviewer 多维评分体系 + 6 检查维度 + 问题类型分类',
      description: '三阶段质量检查：Phase 0 学习目标达成度（LEARNING_OBJECTIVE_MISMATCH/CONTRADICTION/INSUFFICIENT + TERMINOLOGY_UNDEFINED/CONFUSION/MISUSE + CONTENT_OFF_TOPIC/IRRELEVANT_DISCUSSION）、Phase 1 表述质量（SENTENCE_TOO_LONG/GRAMMAR_ERROR/LOGIC_JUMP/REPETITION + WORD_MISUSE/CONCEPT_CONFUSION/INACCURATE_EXPRESSION + MISSING_TRANSITION/PARAGRAPH_TOO_LONG）、Phase 2 专业性（TERMINOLOGY_INCONSISTENCY/TRANSLATION_INCONSISTENT + CODE_BLOCK_MISSING_LANGUAGE/LIST_FORMAT_INCONSISTENT + MISSING_SOURCE_CITATION/HANGING_REFERENCE）。多维评分：accuracy(40) + expression_quality(30) + professionalism(20) + completeness(10) = 100 分，及格线 score >= 80。',
      signals: ['multi_dimension_scoring', 'LEARNING_OBJECTIVE_MISMATCH', 'TERMINOLOGY_CONFUSION', 'expression_quality', 'professionalism', 'reviewer_j2'],
      score: 0.87, calls: 0,
      source_files: ['reviewer.j2', 'reviewer.py'],
      design_philosophy: ['多维度优于单维度：accuracy/expression/professionalism/completeness 四维评分，不只看准确性', '问题类型分类：每个问题有明确的 type + severity，反馈可操作而非模糊', '三阶段渐进检查：Phase 0 目标达成 → Phase 1 表述质量 → Phase 2 专业性，按优先级排序', '评分规则透明：基础分 100 + 扣分规则明确，及格线 80 分可量化'],
      migration_scenarios: ['内容生成类 Agent 需要多维质量评估的场景', '需要结构化问题反馈（type + severity + suggestion）的项目', '博客/报告生成中需要检查术语一致性、来源标注的场景'],
    },
    {
      project: 'VibeBlog', source_id: '69.04', type: 'Solution',
      repo: 'https://github.com/user/vibe-blog',
      title: 'Generator-Critic 双 Agent 迭代循环 + SectionEvaluator 4 维评估',
      description: '借鉴 AutoFigure 的 Generator-Critic Loop：WriterAgent 生成/改进内容，QuestionerAgent(SectionEvaluator) 对每段进行 4 维评估（information_density/logical_coherence/professional_depth/expression_quality）。输出结构化 JSON：scores + overall_quality + specific_issues + improvement_suggestions。三重终止条件：分数阈值（overall_quality >= 9.0）+ 改进幅度（delta < 0.3 则收敛停止）+ 最大轮次（max_rounds=2）。关键方法：evaluate_section() 段落级评估、improve_section() 针对性改进、_should_improve_sections() 收敛判断。',
      signals: ['Generator_Critic_Loop', 'SectionEvaluator', 'information_density', 'logical_coherence', 'triple_termination', 'evaluate_section', 'improve_section'],
      score: 0.90, calls: 0,
      source_files: ['agents/questioner.py', 'agents/writer.py', 'generator.py', 'schemas/state.py', 'templates/section_evaluator.j2', 'templates/writer_improve.j2'],
      design_philosophy: ['对抗性协作：Generator 和 Critic 分离，Critic 被 prompt 要求严格打分、专门挑毛病', '段落级粒度：不是全文一个分数，而是逐段 4 维评估，修改更精准', '三重终止防浪费：分数达标 OR 改进收敛 OR 轮次上限，任一满足即停止', '结构化反馈可执行：specific_issues + improvement_suggestions，不是模糊的"改好一点"'],
      migration_scenarios: ['需要迭代提升输出质量的内容生成 Agent', '段落级精细化评估和改进的写作场景', '需要收敛判断避免无限迭代的 Generator-Critic 系统'],
    },
  ],
  comparison_dimensions: [
    { name: '检查方式', values: { DeerFlow: '三层容错隔离 + 故障隔离矩阵', 'VibeBlog(13)': '三阶段 Reviewer（目标/表述/专业性）', 'VibeBlog(69.04)': 'Generator-Critic 双 Agent 迭代循环' } },
    { name: '评估维度', values: { DeerFlow: '5 状态机（PENDING/RUNNING/COMPLETED/FAILED/TIMED_OUT）', 'VibeBlog(13)': 'accuracy(40)+expression(30)+professionalism(20)+completeness(10)', 'VibeBlog(69.04)': 'information_density/logical_coherence/professional_depth/expression_quality' } },
    { name: '评估粒度', values: { DeerFlow: '节点级（核心/增强/循环差异化）', 'VibeBlog(13)': '全文级（问题类型 + severity 分类）', 'VibeBlog(69.04)': '段落级（逐段 4 维评估）' } },
    { name: '迭代机制', values: { DeerFlow: '节点重试 + recursion_limit', 'VibeBlog(13)': 'score >= 80 及格线', 'VibeBlog(69.04)': '三重终止（分数 >= 9.0 / delta < 0.3 / max_rounds=2）' } },
  ],
  best_practices: [
    'Generator 和 Critic 必须分离：同一 Agent 自评效果差，对抗性协作才能提升质量',
    '多维评估优于单一分数：accuracy/expression/professionalism 分维度评分，定位问题更精准',
    '三重终止条件防浪费：分数达标 OR 改进收敛 OR 轮次上限，任一满足即停止',
    '结构化反馈可执行：specific_issues + improvement_suggestions，不是模糊的"改好一点"',
    '故障隔离矩阵：核心节点重试、增强节点跳过，按重要性差异化处理',
    '段落级粒度优于全文级：逐段评估和改进比全文一个分数更精准',
  ],
};
// PLACEHOLDER_PD08

// ─── PD-08 搜索与检索 ───
const PD08: DomainData = {
  id: 'PD-08', slug: 'search-retrieval', title: '搜索与检索',
  subtitle: 'Search & Retrieval', icon: 'search', color: '#3b82f6',
  severity: 'critical',
  description: '多搜索源聚合、树状递归深度研究、知识缺口检测。Agent 获取外部知识的核心能力。',
  tags: ['multi-source', 'recursive-search', 'knowledge-gap', 'credibility'],
  sub_problems: [
    '多源聚合：整合 Web 搜索、学术搜索、代码搜索等多种来源',
    '递归深入：初始搜索不够时，自动生成子查询深入研究',
    '知识缺口检测：识别当前信息不足以回答的部分',
    '源可信度：评估搜索结果的可信度和相关性',
    '去重与融合：多源结果的去重和信息融合',
  ],
  solutions: [
    {
      project: 'GPT-Researcher', source_id: '41.02', type: 'Solution',
      repo: 'https://github.com/assafelovic/gpt-researcher',
      title: 'DeepResearchSkill 树状递归搜索 + breadth 逐层减半 + visited_urls 去重',
      description: 'gpt_researcher/skills/deep_research.py 的 DeepResearchSkill 实现树状递归深度研究：breadth=4（每层 4 个子查询）、depth=2（递归 2 层）、concurrency_limit=2（asyncio.Semaphore 并发控制）。Step 0 generate_research_plan() 先做初始搜索获取背景 → LLM 生成 3 个澄清问题 → 构造 combined_query。每层 generate_search_queries() 生成子查询 → 每个子查询创建独立 GPTResearcher 实例（状态隔离）→ conduct_research() → process_research_results() 提取 learnings + follow-up questions。breadth 逐层减半 max(2, breadth//2) 控制指数爆炸。跨层共享 visited_urls 实现 URL 级去重。最终 trim_context_to_word_limit(25000) 裁剪合并结果。',
      signals: ['DeepResearchSkill', 'breadth_4_depth_2', 'generate_research_plan', 'visited_urls', 'trim_context_to_word_limit', 'asyncio_Semaphore', 'process_research_results'],
      score: 0.93, calls: 0,
      source_files: ['gpt_researcher/skills/deep_research.py', 'gpt_researcher/master/agent.py', 'gpt_researcher/researcher/research_agent.py'],
      design_philosophy: ['每个子查询独立 Researcher：GPTResearcher(query=sub_q) 状态隔离，避免污染', 'breadth 逐层减半：max(2, breadth//2) 控制指数爆炸，第 1 层 4 个 → 第 2 层 2 个', '知识累积：learnings 跨层传递，后续层基于前序知识生成更精准的子查询', '并发控制：asyncio.Semaphore(2) 限制同时查询数，避免 API 限流'],
      migration_scenarios: ['需要深度研究能力的 Agent（breadth/depth 参数可调）', '多搜索源并行查询的场景（Tavily/Google/Bing 等）', '需要树状递归搜索 + URL 去重的研究类项目'],
    },
    {
      project: 'MiroThinker', source_id: '75.02', type: 'Solution',
      repo: 'https://github.com/MiroMindAI/MiroThinker',
      title: 'Serper Google 搜索 + 智谱双引擎路由 + 语言感知降级',
      description: 'MiroThinker 通过两层 MCP 嵌套调用 Serper API（searching_google_mcp_server.py → serper_mcp_server.py → https://google.serper.dev），本质是 Google 搜索代理。迁移时跳过 MCP 壳直接调 Serper API，作为 SmartSearchService 新搜索源与智谱并行。路由策略：中文主题 → 智谱为主 + Serper 补充英文结果，英文主题 → Serper 为主 + 智谱补充中文结果。任一引擎不可用 → 自动降级。Serper 免费额度 2500 次，单篇博客 3-8 次搜索。filter_google_search_result() 过滤搜索结果。',
      signals: ['Serper_API', 'SmartSearchService', 'language_aware_routing', 'filter_google_search_result', 'dual_engine', 'auto_fallback'],
      score: 0.87, calls: 0,
      source_files: ['MiroThinker/libs/miroflow-tools/src/miroflow_tools/mcp_servers/searching_google_mcp_server.py', 'MiroThinker/libs/miroflow-tools/src/miroflow_tools/mcp_servers/serper_mcp_server.py'],
      design_philosophy: ['跳过 MCP 壳直接调 API：两层 MCP 嵌套本质就是调 Serper API，简化架构', '语言感知路由：中文用智谱、英文用 Serper，按语言特长分配', '双引擎互为降级：任一不可用自动切换，保证搜索可用性', '成本可控：Serper 免费 2500 次，按需升级 Developer/Production 方案'],
      migration_scenarios: ['需要中英文双语搜索能力的项目', '当前只有单一搜索引擎需要增加冗余的场景', '需要 Google 搜索质量但不想直接调 Google API 的项目'],
    },
    {
      project: 'DeepResearch', source_id: '113.02', type: 'Solution',
      repo: 'https://github.com/Alibaba-NLP/DeepResearch',
      title: 'Visit 工具两阶段目标导向网页提取 + 渐进式降级截断',
      description: 'inference/tool_visit.py 的 Visit(BaseTool) 实现两阶段信息提取管线：Stage 1 用 Jina API（https://r.jina.ai/{url}，3 次重试 + 50s 超时）抓取原始 Markdown 全文 → Stage 2 用独立摘要 LLM（SUMMARY_MODEL_NAME 环境变量配置）+ EXTRACTOR_PROMPT 目标导向提取，输出 {rational, evidence, summary} 三字段 JSON。truncate_to_tokens(text, 95000) 用 tiktoken cl100k_base 精确截断。摘要失败时渐进式降级截断：70% → 70% → 25000 字符。JSON 容错解析：直接 json.loads → 提取 {} 之间内容 → 重新调用 LLM（最多 3 次）。',
      signals: ['Visit_BaseTool', 'EXTRACTOR_PROMPT', 'Jina_API', 'goal_directed_extraction', 'progressive_truncation', 'SUMMARY_MODEL_NAME', 'rational_evidence_summary'],
      score: 0.90, calls: 0,
      source_files: ['inference/tool_visit.py:40-255', 'inference/prompt.py:37-51', 'inference/react_agent.py:228'],
      design_philosophy: ['目标导向提取：用 LLM + EXTRACTOR_PROMPT 只提取与当前 goal 相关的信息，10 万字网页压缩为几百字', '独立摘要 LLM：关注点分离，摘要模型可选更便宜的 7B 级别，不污染主推理 LLM 上下文', '渐进式降级截断：宁可截断不可失败，70% → 70% → 25K 字符三级降级', 'JSON 容错多层解析：直接解析 → 提取 {} → 重新调用 LLM，最多 3 次'],
      migration_scenarios: ['需要从网页中提取与特定目标相关信息的 Agent', '搜索结果网页过长需要 LLM 摘要压缩的场景', '需要独立摘要模型降低成本的深度研究项目'],
    },
  ],
  comparison_dimensions: [
    { name: '搜索架构', values: { 'GPT-Researcher': 'DeepResearchSkill 树状递归（breadth=4, depth=2）', MiroThinker: 'Serper + 智谱双引擎语言感知路由', DeepResearch: 'Visit 两阶段目标导向提取管线' } },
    { name: '去重机制', values: { 'GPT-Researcher': 'visited_urls 跨层 URL 级去重', MiroThinker: 'filter_google_search_result() 结果过滤', DeepResearch: '无（每次 Visit 独立）' } },
    { name: '结果处理', values: { 'GPT-Researcher': 'trim_context_to_word_limit(25000) 硬裁剪', MiroThinker: '直接返回搜索 snippet', DeepResearch: 'EXTRACTOR_PROMPT → {rational, evidence, summary} 结构化提取' } },
    { name: '容错策略', values: { 'GPT-Researcher': 'asyncio.Semaphore(2) 并发控制', MiroThinker: '双引擎互为降级', DeepResearch: '渐进式截断（70%→70%→25K）+ JSON 容错 3 次重试' } },
    { name: '成本控制', values: { 'GPT-Researcher': '~36 次搜索 + 20 次 LLM 调用', MiroThinker: 'Serper 免费 2500 次', DeepResearch: '独立摘要 LLM 可选 7B 级别降低成本' } },
  ],
  best_practices: [
    '树状递归搜索是深度研究的标配：breadth 逐层减半控制指数爆炸，visited_urls 去重避免重复',
    '双引擎互为降级：不依赖单一搜索源，语言感知路由提升中英文搜索质量',
    '目标导向提取优于全文返回：用 LLM 只提取与当前 goal 相关的信息，节省 token',
    '渐进式降级截断：宁可截断不可失败，70% → 70% → 25K 字符三级降级',
    '独立摘要 LLM 降低成本：摘要用便宜模型，不占主推理 LLM 上下文',
    '搜索策略要可配置：breadth/depth 参数化，不同任务需要不同的搜索深度',
  ],
};

// ─── PD-09 Human-in-the-Loop ───
const PD09: DomainData = {
  id: 'PD-09', slug: 'human-in-the-loop', title: 'Human-in-the-Loop',
  subtitle: 'Human-Agent Interaction', icon: 'user-check', color: '#f97316',
  severity: 'medium',
  description: 'Agent 执行中如何在关键节点暂停、向用户澄清、获取审批。人机协作的关键。',
  tags: ['clarification', 'approval', 'interrupt', 'multi-turn'],
  sub_problems: [
    '暂停点设计：哪些操作需要人工确认',
    '澄清请求：Agent 不确定时如何向用户提问',
    '审批流程：危险操作的审批机制',
    '反馈整合：用户反馈如何影响后续执行',
    '多轮交互：复杂任务中的多轮人机对话',
  ],
  solutions: [
    {
      project: 'DeerFlow', source_id: '102.05', type: 'Solution',
      repo: 'https://github.com/bytedance/deer-flow',
      title: 'ClarificationMiddleware + ask_clarification 五类型主动澄清',
      description: '三层架构实现主动澄清：ask_clarification @tool 工具层（5 种类型：missing_info/ambiguous_requirement/approach_choice/risk_confirmation/suggestion）→ ClarificationMiddleware 中间件层（wrap_tool_call 拦截，_format_clarification_message 格式化带图标消息，Command(goto=END) 中断图执行）→ Prompt 层（lead_agent/prompt.py 的 <clarification_system> 块强制 CLARIFY→PLAN→ACT 工作流优先级）。前端通过 isClarificationToolMessage() 检测并渲染澄清 UI。',
      signals: ['ask_clarification', 'ClarificationMiddleware', 'Command_goto_END', 'clarify_plan_act', 'wrap_tool_call', 'missing_info', 'ambiguous_requirement', 'approach_choice', 'risk_confirmation'],
      score: 0.91, calls: 0,
      source_files: ['src/tools/builtins/clarification_tool.py:6-55', 'src/agents/middlewares/clarification_middleware.py:20-173', 'src/agents/lead_agent/prompt.py:165-232', 'src/agents/lead_agent/agent.py:186-235'],
      design_philosophy: ['宁可多问一句不可假设执行：准确性优先于速度', '三层解耦：Tool 声明（@tool return_direct=True）+ Middleware 拦截（wrap_tool_call）+ Prompt 指令（<clarification_system>），各层独立可测', 'CLARIFY→PLAN→ACT 强制优先级：严格禁止先做再问模式', '中间件链尾注册：ClarificationMiddleware 必须是第 11 个（最后），确保其他中间件处理完毕后才拦截', '占位实现 + 中间件拦截：工具函数体永远不会执行，实际逻辑由中间件 wrap_tool_call 处理'],
      migration_scenarios: ['需要用户意图澄清的对话式 Agent（topic 模糊时追问具体方向而非使用默认值）', '高风险操作需确认的场景（文件删除、生产配置修改、长时间任务启动前确认）', '已有 LangGraph 中间件架构的项目（通过 wrap_tool_call 钩子拦截特定工具调用）', '需要结构化澄清类型（5 种类型 + options 选项列表）而非自由文本提问的场景'],
    },
    {
      project: 'DeerFlow', source_id: '101.113', type: 'Solution',
      repo: 'https://github.com/bytedance/deer-flow',
      title: 'LangGraph interrupt() + Command(resume=...) 原生中断恢复',
      description: '用 LangGraph 原生 interrupt() 替代 threading.Event 阻塞方案：_planner_node 中调用 interrupt({type: confirm_outline}) 自动中断图执行并持久化 checkpoint，前端展示中断数据后用户操作触发 POST /api/tasks/resume，后端通过 Command(resume=action) 恢复图执行。支持 SqliteSaver 持久化，进程重启后可恢复中断任务。',
      signals: ['langgraph_interrupt', 'Command_resume', 'SqliteSaver', 'checkpoint_persistence', 'confirm_outline', 'interrupt_data', 'two_phase_stream'],
      score: 0.86, calls: 0,
      source_files: ['generator.py:266-290', 'blog_service.py（_interrupted_tasks + resume_generation）', 'blog_routes.py（POST /api/tasks/resume）', 'schemas/state.py（SharedState.interrupt_data）'],
      design_philosophy: ['原生优于自建：LangGraph interrupt() 比 threading.Event 更安全，不阻塞线程', '状态持久化：SqliteSaver 替代 MemorySaver，支持进程重启后恢复', '两段式流式推送：启动到中断为第一段 SSE，Command(resume=...) 恢复后为第二段', '向后兼容：保留旧 /confirm-outline 接口内部转发到 /resume'],
      migration_scenarios: ['从 threading.Event 阻塞方案迁移到 LangGraph 原生中断', '需要多个中断点的 Agent 工作流（大纲确认、风险确认、方案选择等）', '长时间运行需要断点续传的任务（SqliteSaver 持久化 checkpoint）', '需要 SSE 两段式流式推送的前后端分离架构'],
    },
  ],
  comparison_dimensions: [
    { name: '暂停机制', values: { 'DeerFlow-澄清': 'ClarificationMiddleware wrap_tool_call + Command(goto=END)', 'DeerFlow-中断': 'LangGraph interrupt() + Command(resume=...)' } },
    { name: '澄清类型', values: { 'DeerFlow-澄清': '5 种结构化类型（missing_info/ambiguous/approach/risk/suggestion）', 'DeerFlow-中断': '单一 confirm_outline 类型' } },
    { name: '状态持久化', values: { 'DeerFlow-澄清': '依赖 LangGraph checkpoint', 'DeerFlow-中断': 'SqliteSaver 持久化，支持进程重启恢复' } },
    { name: '实现层级', values: { 'DeerFlow-澄清': 'Tool + Middleware + Prompt 三层', 'DeerFlow-中断': 'Graph 节点内 interrupt() 单层' } },
  ],
  best_practices: [
    'CLARIFY→PLAN→ACT 优先级：Agent 不确定时必须先澄清，严格禁止先做再问',
    '结构化澄清类型：用枚举类型（missing_info 等）而非自由文本，便于前端渲染不同 UI',
    '中间件拦截优于节点内硬编码：wrap_tool_call 钩子让澄清逻辑与业务逻辑解耦',
    'interrupt() 优于 threading.Event：不阻塞线程，支持持久化，可扩展为多个中断点',
    '超时自动处理：用户长时间不响应时有默认行为，避免任务永久挂起',
  ],
};
// PLACEHOLDER_PD10

// ─── PD-10 中间件管道 ───
const PD10: DomainData = {
  id: 'PD-10', slug: 'middleware-pipeline', title: '中间件管道',
  subtitle: 'Middleware Pipeline', icon: 'layers', color: '#a855f7',
  severity: 'medium',
  description: 'Agent 生命周期中横切关注点的可组合中间件解耦。日志、限流、缓存等通过中间件注入。',
  tags: ['lifecycle-hooks', 'composable', 'aop', 'plugin'],
  sub_problems: [
    '中间件注册：如何定义和注册中间件',
    '执行顺序：中间件的执行顺序和优先级',
    '上下文传递：中间件间如何传递上下文',
    '错误处理：中间件异常不影响主流程',
    '可组合性：中间件可自由组合和拆卸',
  ],
  solutions: [
    {
      project: 'DeerFlow', source_id: '102.02', type: 'Solution',
      repo: 'https://github.com/bytedance/deer-flow',
      title: 'AgentMiddleware[S] 泛型基类 + _build_middlewares() 11 层中间件链',
      description: '_build_middlewares() 按严格顺序注册 11 层中间件：(1)ThreadDataMiddleware(before_agent,线程数据目录隔离) → (2)UploadsMiddleware(before_agent,文件上传注入) → (3)SandboxMiddleware(before_agent,沙箱环境获取) → (4)DanglingToolCallMiddleware(before_model,悬挂工具调用修复) → (5)SummarizationMiddleware(LangChain内置,三触发压缩) → (6)TodoListMiddleware(plan_mode时启用,任务追踪) → (7)TitleMiddleware(after_agent,自动生成线程标题) → (8)MemoryMiddleware(after_agent,异步队列更新长期记忆) → (9)ViewImageMiddleware(before_model,base64图片注入) → (10)SubagentLimitMiddleware(after_model,截断超限并行task调用) → (11)ClarificationMiddleware(wrap_tool_call,澄清拦截必须最后)。5 类钩子点：before_agent/before_model/after_model/after_agent/wrap_tool_call。同步/异步双模（before_model/abefore_model）。状态驱动：返回 dict|None 合并状态更新。',
      signals: ['AgentMiddleware', '_build_middlewares', 'ThreadDataMiddleware', 'UploadsMiddleware', 'SandboxMiddleware', 'DanglingToolCallMiddleware', 'SummarizationMiddleware', 'TodoListMiddleware', 'TitleMiddleware', 'MemoryMiddleware', 'ViewImageMiddleware', 'SubagentLimitMiddleware', 'ClarificationMiddleware', 'before_agent', 'before_model', 'after_model', 'after_agent', 'wrap_tool_call'],
      score: 0.92, calls: 0,
      source_files: ['src/agents/lead_agent/agent.py:186-235（_build_middlewares）', 'src/agents/middlewares/dangling_tool_call_middleware.py', 'src/agents/middlewares/clarification_middleware.py:20-173', 'src/agents/middlewares/subagent_limit_middleware.py', 'src/config/summarization_config.py'],
      design_philosophy: ['单一职责：每个中间件只处理一个横切关注点（数据隔离/上传/沙箱/压缩/记忆/澄清等）', '声明式组合：中间件以列表形式注册，执行顺序由 _build_middlewares() 注册顺序决定', '状态驱动：中间件通过返回 dict|None 合并状态更新，返回 None 表示不修改', '条件激活：部分中间件根据 RunnableConfig 动态启用（TodoList 需 is_plan_mode=True，ViewImage 需模型支持视觉）', '同步/异步双模：每个钩子都有同步和异步版本（before_model/abefore_model）'],
      migration_scenarios: ['单体 Agent 类膨胀需要拆分横切关注点的项目（如 1340 行的 BlogGenerator）', '需要条件激活中间件的场景（不同模式启用不同中间件组合）', '需要在 LLM 调用前后注入逻辑（消息修补、图片注入、响应截断）的 Agent 框架', '需要工具调用拦截能力（wrap_tool_call）的场景（澄清、权限控制、审计）'],
    },
  ],
  comparison_dimensions: [
    { name: '中间件基类', values: { DeerFlow: 'AgentMiddleware[S] 泛型基类，LangChain 内置' } },
    { name: '钩子点', values: { DeerFlow: '5 类：before_agent/before_model/after_model/after_agent/wrap_tool_call' } },
    { name: '中间件数量', values: { DeerFlow: '11 层，_build_middlewares() 显式控制顺序' } },
    { name: '条件激活', values: { DeerFlow: 'RunnableConfig.configurable 运行时配置驱动' } },
    { name: '状态管理', values: { DeerFlow: '返回 dict 合并状态，返回 None 不修改' } },
  ],
  best_practices: [
    '中间件顺序有依赖关系：ThreadData 必须最先（创建目录），ClarificationMiddleware 必须最后（拦截澄清）',
    '条件激活减少开销：不需要的中间件通过 RunnableConfig 动态禁用，避免无谓执行',
    '状态合并而非直接修改：中间件返回 dict 由框架合并，避免并发修改冲突',
    '同步/异步双模：支持同步和异步调用场景，异步版本用 a 前缀（abefore_model）',
    '横切关注点必须独立可测：每个中间件可以独立单元测试，不依赖其他中间件',
  ],
};

// ─── PD-11 可观测性 ───
const PD11: DomainData = {
  id: 'PD-11', slug: 'observability', title: '可观测性',
  subtitle: 'Observability & Cost Tracking', icon: 'activity', color: '#14b8a6',
  severity: 'high',
  description: 'LLM 调用链路追踪、Token 计量、成本分析、结构化日志。没有可观测性就是盲飞。',
  tags: ['tracing', 'token-tracking', 'cost', 'structured-log'],
  sub_problems: [
    '调用链追踪：每次 LLM 调用的输入/输出/耗时',
    'Token 计量：精确统计每次调用的 token 消耗',
    '成本分析：按模型、按任务、按用户的成本统计',
    '结构化日志：可查询的结构化日志而非纯文本',
    '告警机制：成本超限、错误率过高时告警',
  ],
  solutions: [
    {
      project: 'MiroThinker', source_id: '37.31', type: 'Solution',
      repo: 'https://github.com/MiroMindAI/MiroThinker',
      title: 'TokenUsage TypedDict 四维追踪 + _update_token_usage() 多提供商适配',
      description: 'base_client.py:32-49 定义 TokenUsage(TypedDict) 统一追踪 4 种 token 类型：total_input_tokens/total_output_tokens/total_cache_read_input_tokens/total_cache_write_input_tokens。openai_client.py 的 _update_token_usage() 从 usage_data.prompt_tokens/completion_tokens 提取，通过 prompt_tokens_details.cached_tokens 获取缓存命中（OpenAI 无 cache_write）。anthropic_client.py 的 _update_token_usage() 提取完整 4 种（含 cache_creation_input_tokens/cache_read_input_tokens）。累计追踪 + last_call_tokens 单次记录双模式。',
      signals: ['TokenUsage', '_update_token_usage', 'total_cache_read_input_tokens', 'total_cache_write_input_tokens', 'prompt_tokens_details', 'cache_creation_input_tokens', 'last_call_tokens', 'format_token_usage_summary'],
      score: 0.90, calls: 0,
      source_files: ['base_client.py:32-49（TokenUsage TypedDict 定义）', 'openai_client.py（_update_token_usage OpenAI 适配）', 'anthropic_client.py（_update_token_usage Anthropic 适配）'],
      design_philosophy: ['4 种 token 类型统一追踪：input/output/cache_read/cache_write 覆盖所有计费维度', '提供商差异适配：OpenAI 无 cache_write，Anthropic 有完整 4 种，统一到同一 TypedDict', '累计 + 单次双模式：token_usage 任务级累加，last_call_tokens 记录最近一次调用', '从 API 返回值精确提取：不估算，直接从 usage_data 属性获取', '缓存 token 区分计费：OpenAI cache_read 按 50% 计费，Anthropic cache_read 按 10% 计费'],
      migration_scenarios: ['多 LLM 提供商混用的项目（需要统一 token 追踪格式）', '需要精确成本分析的场景（区分缓存命中和非缓存 token 的计费差异）', '需要回答"这篇博客花了多少钱"的产品'],
    },
    {
      project: 'MiroThinker', source_id: '37.08', type: 'Solution',
      repo: 'https://github.com/MiroMindAI/MiroThinker',
      title: 'TaskLog + StepLog + ColoredFormatter 结构化任务日志',
      description: 'task_logger.py 实现两级结构化日志：TaskLog（任务级，含 task_id/status/steps/total_tokens/sub_agent_sessions）和 StepLog（步骤级，含 timestamp/level/title/detail/metadata）。每个 LLM 调用、工具执行、决策点都记录为 StepLog。log_step() 同时追加到 steps 列表和控制台输出。save() 持久化为 JSON 文件。ColoredFormatter 按级别着色（ERROR 红/WARNING 黄/INFO 绿/DEBUG 青）。start_sub_agent_session() 为子 Agent 创建独立 session 记录。',
      signals: ['TaskLog', 'StepLog', 'ColoredFormatter', 'log_step', 'sub_agent_sessions', 'json_persistence', 'task_logger'],
      score: 0.86, calls: 0,
      source_files: ['task_logger.py（TaskLog + StepLog dataclass）', 'task_logger.py（ColoredFormatter 彩色输出）'],
      design_philosophy: ['任务级粒度：每个任务一个 TaskLog，包含所有步骤的完整记录', '步骤级追踪：每个 LLM 调用、工具执行、决策点都记录为 StepLog', 'JSON 持久化：自动保存为 JSON 文件，支持后续程序化分析', '子 Agent 隔离：子 Agent 的日志在独立 session 中，不与主 Agent 混淆', '彩色控制台输出：按级别着色提升可读性，同时保留结构化数据'],
      migration_scenarios: ['需要任务级日志聚合的 Agent 系统（一次任务的所有步骤统一记录）', '需要 JSON 持久化便于后续分析的场景（成本分析、性能瓶颈定位）', '多 Agent 系统需要子 Agent 日志隔离的项目'],
    },
    {
      project: 'MiroThinker', source_id: '47', type: 'Solution',
      repo: 'https://github.com/MiroMindAI/MiroThinker',
      title: 'AOP install_tracing() + TraceCollector 自建轻量追踪系统',
      description: '自建轻量 LLM 调用链路追踪系统，作为 Langfuse 云端追踪的本地补充。TraceCollector 收集每次 LLM 调用的 input/output/tokens/duration/model 信息。install_tracing() 通过 AOP 方式拦截 LLM 客户端调用，零侵入注入追踪逻辑。支持 trace_id 关联同一任务的所有调用。与 37.08 BlogTaskLog 集成，追踪数据自动写入步骤日志。',
      signals: ['TraceCollector', 'install_tracing', 'AOP', 'trace_id', 'llm_call_trace', 'zero_intrusion'],
      score: 0.82, calls: 0,
      source_files: ['utils/tracing.py（TraceCollector + install_tracing）'],
      design_philosophy: ['AOP 零侵入：通过 monkey-patch 拦截 LLM 调用，不改业务代码', '本地优先：不依赖外部服务（Langfuse），本地即可查看追踪数据', 'trace_id 关联：同一任务的所有 LLM 调用通过 trace_id 串联', '与结构化日志集成：追踪数据自动写入 BlogTaskLog 的 StepLog'],
      migration_scenarios: ['不想依赖 Langfuse 等外部追踪服务的项目', '需要本地调试 LLM 调用链路的开发环境', '需要 AOP 方式零侵入注入追踪的场景'],
    },
  ],
  comparison_dimensions: [
    { name: '追踪方式', values: { 'MiroThinker-Token': 'TokenUsage TypedDict 从 API 返回值精确提取', 'MiroThinker-日志': 'TaskLog + StepLog 两级结构化日志', 'MiroThinker-链路': 'AOP install_tracing() 零侵入拦截' } },
    { name: '数据粒度', values: { 'MiroThinker-Token': '4 种 token 类型（含 cache_read/cache_write）', 'MiroThinker-日志': '步骤级（每个 LLM 调用/工具执行/决策点）', 'MiroThinker-链路': '调用级（input/output/tokens/duration/model）' } },
    { name: '持久化', values: { 'MiroThinker-Token': '内存累计 + last_call_tokens', 'MiroThinker-日志': 'JSON 文件持久化', 'MiroThinker-链路': '内存 + 可选写入日志' } },
    { name: '多提供商', values: { 'MiroThinker-Token': 'OpenAI/Anthropic 差异适配（cache_write 字段差异）', 'MiroThinker-日志': '提供商无关', 'MiroThinker-链路': '提供商无关（AOP 层拦截）' } },
  ],
  best_practices: [
    '从 API 返回值精确提取 token 数：不要用 len(content)/1.5 估算，误差 30%+',
    '区分 4 种 token 类型：input/output/cache_read/cache_write 各有不同计费规则',
    '适配多提供商差异：OpenAI 无 cache_write，Anthropic 有完整 4 种，需统一数据结构',
    '结构化日志 + JSON 持久化：便于程序化分析成本分布和性能瓶颈',
    '子 Agent 日志隔离：多 Agent 系统中每个子 Agent 的日志在独立 session 中',
  ],
};

// ─── PD-12 推理增强 ───
const PD12: DomainData = {
  id: 'PD-12', slug: 'reasoning-enhancement', title: '推理增强',
  subtitle: 'Reasoning Enhancement', icon: 'zap', color: '#eab308',
  severity: 'medium',
  description: 'Extended Thinking、分层 LLM 策略、MoE 路由。提升 Agent 的推理能力和效率。',
  tags: ['extended-thinking', 'tiered-llm', 'moe', 'chain-of-thought'],
  sub_problems: [
    'Extended Thinking：利用模型的深度思考能力',
    '分层 LLM：简单任务用小模型，复杂任务用大模型',
    'Chain-of-Thought：引导模型逐步推理',
    'MoE 路由：根据任务类型路由到专家模型',
    '推理验证：验证推理过程的正确性',
  ],
  solutions: [
    {
      project: 'MiroThinker', source_id: '37.03', type: 'Solution',
      repo: 'https://github.com/MiroMindAI/MiroThinker',
      title: 'reasoning_mcp_server.py Extended Thinking + ReasoningService 三级预算',
      description: 'reasoning_mcp_server.py（仅 63 行）通过 @mcp.tool() 暴露 reasoning() 工具，调用 Anthropic API 的 thinking={"type": "enabled", "budget_tokens": 19000} 启用 Extended Thinking 模式。ReasoningService 封装三级思考预算：light(8K tokens, QuestionerAgent 评估)、medium(16K, Planner 规划)、heavy(24K, FactCheck 验证)。选择性启用策略：Writer/Coder/Artist 用普通模式（生成类不需要推理），Planner/Reviewer/FactCheck/ThreadChecker 用 Thinking 模式（分析类需要推理）。单篇博客增量成本仅 +$0.20-0.30，ROI 极高。',
      signals: ['reasoning_mcp_server', 'extended_thinking', 'budget_tokens', 'ReasoningService', 'BUDGET_PRESETS', 'thinking_enabled', 'selective_enablement'],
      score: 0.91, calls: 0,
      source_files: ['reasoning_mcp_server.py（63 行，@mcp.tool reasoning）', 'services/reasoning_service.py（ReasoningService + BUDGET_PRESETS）'],
      design_philosophy: ['选择性启用：不是所有调用都用 Thinking 模式，生成类任务用普通模式，分析类任务用 Thinking', '三级预算分层：light(8K)/medium(16K)/heavy(24K) 按任务复杂度分配思考预算', '利用模型原生能力：Extended Thinking 比 prompt hack 更可靠，19K tokens 内部推理链', 'MCP 工具暴露：通过 @mcp.tool 让其他 Agent 可调用推理能力', '成本可控：单篇博客增量仅 +$0.20-0.30，质量提升 40-60%'],
      migration_scenarios: ['需要深度推理的分析类 Agent（Planner 规划、Reviewer 审核、FactCheck 验证）', '使用 Claude/Anthropic API 的项目（Extended Thinking 是 Claude 原生能力）', '需要按任务复杂度分配推理预算的场景（三级 BUDGET_PRESETS）', '通过 MCP 协议暴露推理能力给其他 Agent 调用的架构'],
    },
    {
      project: 'DeepResearch', source_id: '113.05', type: 'Solution',
      repo: 'https://github.com/Alibaba-NLP/DeepResearch',
      title: 'WebWeaver Dynamic Outline Optimization 动态大纲演化',
      description: '基于 WebWeaver 论文（arXiv 2509.13312）的 Dynamic Outline Optimization 概念：大纲不是一次性产物，而是随信息收集持续演化的活文档。Planner Agent 在连续循环中交替执行 Web 搜索→大纲修订，每轮搜索后评估新信息对现有大纲的影响，支持增删合并拆分章节和调整顺序。Search-Outline Interleaving 形成正反馈循环：大纲 v1→识别缺口→搜索→新发现→大纲 v2→...。Writer Agent 采用 Memory-Grounded Hierarchical Synthesis，为每个章节从记忆库检索最相关证据子集。概念级方案，无源代码迁移。',
      signals: ['Dynamic_Outline_Optimization', 'WebWeaver', 'Search_Outline_Interleaving', 'Memory_Grounded_Synthesis', 'outline_fossilization', 'living_document', 'outline_evaluator', 'outline_reviser'],
      score: 0.87, calls: 0,
      source_files: ['DeepResearch-main/WebAgent/WebWeaver/README.md（论文概念描述）', 'arXiv:2509.13312（WebWeaver 论文）'],
      design_philosophy: ['大纲是活文档：随研究深入持续演化，而非一次性生成后化石化', '搜索-大纲交替：搜索和规划交替进行，搜索结果驱动大纲修订，大纲缺口驱动搜索查询', '基于记忆的层次化综合：Writer 为每个章节从记忆库检索最相关证据，而非使用全部搜索结果', '渐进式引入：通过新增 outline_evaluator/outline_reviser 节点和条件边实现，不重构现有工作流'],
      migration_scenarios: ['大纲一次性生成后不再修改导致结构僵化的项目', '深度研究中后续搜索发现新主题但无法反馈到大纲结构的场景', '需要搜索-规划正反馈循环的研究类 Agent', '章节评估发现结构问题但只能在现有框架内修改文字的场景'],
    },
    {
      project: 'DeerFlow', source_id: '1002.16', type: 'Solution',
      repo: 'https://github.com/bytedance/deer-flow',
      title: 'prompt_enhancer LangGraph 子图 + XML 结构化输出解析',
      description: 'DeerFlow 的 prompt_enhancer 是独立 LangGraph 子图，三文件分层：PromptEnhancerState(TypedDict, 4 字段: prompt/context/report_style/output) → prompt_enhancer_node() 核心增强逻辑（get_llm_by_type + apply_prompt_template Jinja2 模板 + XML <enhanced_prompt> 标签解析 + fallback 前缀移除）→ build_graph() 图构建。通过 /api/enhance_prompt FastAPI 端点对外暴露。支持 5 种 ReportStyle（ACADEMIC/POPULAR_SCIENCE/NEWS/SOCIAL_MEDIA/STRATEGIC_INVESTMENT）和 locale 国际化注入。',
      signals: ['prompt_enhancer', 'PromptEnhancerState', 'prompt_enhancer_node', 'enhanced_prompt_xml', 'apply_prompt_template', 'ReportStyle', 'build_graph', 'Jinja2_template'],
      score: 0.84, calls: 0,
      source_files: ['src/prompt_enhancer/graph/state.py:1-15（PromptEnhancerState TypedDict）', 'src/prompt_enhancer/graph/enhancer_node.py:1-60（prompt_enhancer_node）', 'src/prompt_enhancer/graph/builder.py:1-20（build_graph）', 'src/prompts/template.py（apply_prompt_template Jinja2）'],
      design_philosophy: ['独立子图解耦：prompt_enhancer 与主工作流完全解耦，拥有独立 State/Node/Builder', 'XML 结构化输出 + fallback 双保险：优先提取 <enhanced_prompt> 标签，失败时 fallback 移除常见前缀', 'Jinja2 模板管理：通过 apply_prompt_template() 加载模板，支持 report_style 和 locale 注入', '配置驱动模型选择：AGENT_LLM_MAP.get("prompt_enhancer") 从配置获取模型，不硬编码'],
      migration_scenarios: ['用户输入粗略 prompt 需要 AI 重写为结构化研究指令的场景', '需要独立 LangGraph 子图编排（可扩展为多步增强）的项目', '需要 XML 结构化输出解析的 LLM 应用', '需要按报告风格（学术/科普/新闻/社交媒体）调整 prompt 的场景'],
    },
  ],
  comparison_dimensions: [
    { name: '推理方式', values: { MiroThinker: 'Extended Thinking budget_tokens 内部推理链', DeepResearch: 'Dynamic Outline 搜索-大纲交替演化', DeerFlow: 'prompt_enhancer AI 重写结构化指令' } },
    { name: '模型策略', values: { MiroThinker: '三级预算 light(8K)/medium(16K)/heavy(24K)', DeepResearch: 'Planner+Writer 双 Agent 协作', DeerFlow: 'AGENT_LLM_MAP 配置驱动模型选择' } },
    { name: '成本', values: { MiroThinker: '单篇 +$0.20-0.30（选择性启用）', DeepResearch: '概念级（无实现代码）', DeerFlow: '单次 LLM 调用（轻量）' } },
    { name: '适用场景', values: { MiroThinker: '分析类任务（规划/审核/验证）', DeepResearch: '深度研究大纲持续演化', DeerFlow: '用户输入预处理和增强' } },
  ],
  best_practices: [
    '选择性启用推理增强：生成类任务不需要深度推理，分析类任务才需要',
    '三级预算分层：按任务复杂度分配思考预算，避免一刀切浪费 token',
    '大纲应是活文档：后续搜索发现的新信息应能反馈到大纲结构层面',
    'XML 结构化输出 + fallback：优先解析结构化标签，失败时有降级策略',
    'Prompt 增强作为独立子图：与主工作流解耦，可独立测试和复用',
  ],
};

// ─── 动态合并扫描到的新项目 ───
function scannedDocToSolution(doc: ScannedDoc): DomainSolution {
  // 优先用 solution_summary（项目特定），其次 description（域级补充），最后 fallback
  const desc = doc.domainMetadata?.solution_summary
    || doc.domainMetadata?.description
    || `由 Butcher Scanner 自动生成的 ${doc.project} ${doc.title} 方案文档`;
  return {
    project: doc.project,
    source_id: 'scan',
    type: 'Solution',
    repo: doc.repo,
    title: doc.title,
    description: desc,
    signals: [],
    score: 0.8,
    calls: 0,
  };
}

function mergeDomainsWithScanned(domains: DomainData[]): DomainData[] {
  // 1. 加载动态域定义
  const dynamicDefs = scanDynamicDomains();
  const staticIds = new Set(domains.map(d => d.id));

  // 1a. 分离：新域 vs 静态域覆盖
  const overrideMap = new Map<string, ReturnType<typeof scanDynamicDomains>[number]>();
  const newDynamicDomains: DomainData[] = [];
  for (const def of dynamicDefs) {
    if (staticIds.has(def.id)) {
      overrideMap.set(def.id, def);
    } else {
      newDynamicDomains.push(dynamicDomainToData(def));
    }
  }

  // 1b. 应用覆盖到静态域
  const mergedStatic = domains.map(d => {
    const override = overrideMap.get(d.id);
    if (!override) return d;
    return {
      ...d,
      title: override.title || d.title,
      subtitle: override.subtitle || d.subtitle,
      icon: override.icon || d.icon,
      color: override.color || d.color,
      severity: override.severity || d.severity,
      description: override.description || d.description,
      tags: override.tags?.length ? override.tags : d.tags,
      sub_problems: override.sub_problems?.length ? override.sub_problems : d.sub_problems,
      best_practices: override.best_practices?.length ? override.best_practices : d.best_practices,
    };
  });

  const allDomains = [...mergedStatic, ...newDynamicDomains];

  // 2. 扫描知识文档
  const scanned = scanKnowledgeDocs();
  // 按 domain_id 分组
  const byDomain = new Map<string, ScannedDoc[]>();
  for (const doc of scanned) {
    const list = byDomain.get(doc.domain_id) || [];
    list.push(doc);
    byDomain.set(doc.domain_id, list);
  }

  return allDomains.map(domain => {
    const docs = byDomain.get(domain.id) || [];
    if (docs.length === 0) return domain;

    // 合并 solutions：找出静态中没有的项目
    const existingProjects = new Set(domain.solutions.map(s => s.project));
    const newSolutions = docs
      .filter(d => !existingProjects.has(d.project))
      .map(scannedDocToSolution);

    // 合并 comparison_dimensions：填入已有维度 + 创建新维度
    let mergedDimensions = [...domain.comparison_dimensions];
    const docsWithComparison = docs.filter(d => d.comparisonDimensions);
    if (docsWithComparison.length > 0) {
      const existingDimNames = new Set(mergedDimensions.map(d => d.name));

      // 1. 填入已有维度
      mergedDimensions = mergedDimensions.map(dim => {
        const newValues = { ...dim.values };
        for (const doc of docsWithComparison) {
          if (doc.comparisonDimensions?.[dim.name] && !newValues[doc.project]) {
            newValues[doc.project] = doc.comparisonDimensions[dim.name];
          }
        }
        return { ...dim, values: newValues };
      });

      // 2. 发现新维度：扫描文档中不在已有维度列表里的 key
      for (const doc of docsWithComparison) {
        if (!doc.comparisonDimensions) continue;
        for (const [dimName, dimValue] of Object.entries(doc.comparisonDimensions)) {
          if (!existingDimNames.has(dimName)) {
            existingDimNames.add(dimName);
            mergedDimensions.push({ name: dimName, values: { [doc.project]: dimValue } });
          } else {
            // 可能是另一个 doc 的新维度已经被前一个 doc 创建了
            const existing = mergedDimensions.find(d => d.name === dimName);
            if (existing && !existing.values[doc.project]) {
              existing.values[doc.project] = dimValue;
            }
          }
        }
      }
    }

    // 合并 domain_metadata：补充 sub_problems 和 best_practices
    const docsWithMeta = docs.filter(d => d.domainMetadata);
    let mergedSubProblems = [...domain.sub_problems];
    let mergedBestPractices = [...domain.best_practices];
    if (docsWithMeta.length > 0) {
      const existingSubs = new Set(domain.sub_problems);
      const existingBPs = new Set(domain.best_practices);
      for (const doc of docsWithMeta) {
        const meta = doc.domainMetadata!;
        if (meta.sub_problems) {
          for (const sp of meta.sub_problems) {
            if (!existingSubs.has(sp)) {
              existingSubs.add(sp);
              mergedSubProblems.push(sp);
            }
          }
        }
        if (meta.best_practices) {
          for (const bp of meta.best_practices) {
            if (!existingBPs.has(bp)) {
              existingBPs.add(bp);
              mergedBestPractices.push(bp);
            }
          }
        }
      }
    }

    if (newSolutions.length === 0 && docsWithComparison.length === 0 && docsWithMeta.length === 0) {
      return domain;
    }
    return {
      ...domain,
      solutions: [...domain.solutions, ...newSolutions],
      comparison_dimensions: mergedDimensions,
      sub_problems: mergedSubProblems,
      best_practices: mergedBestPractices,
    };
  });
}

// ─── 导出 ───
const STATIC_DOMAINS: DomainData[] = [
  PD01, PD02, PD03, PD04, PD05, PD06, PD07, PD08, PD09, PD10, PD11, PD12,
];

// 带缓存的动态加载 — 扫描写入新域后调 invalidateDomainsCache() 即可刷新
let _cache: DomainData[] | null = null;

function getAll(): DomainData[] {
  if (!_cache) {
    _cache = mergeDomainsWithScanned(STATIC_DOMAINS);
  }
  return _cache;
}

/** 清除域缓存，下次访问 ALL_DOMAINS 时重新从文件系统加载 */
export function invalidateDomainsCache(): void {
  _cache = null;
}

/** 动态域列表（惰性加载 + 可失效缓存） */
export const ALL_DOMAINS: DomainData[] = new Proxy([] as DomainData[], {
  get(_, prop) {
    const data = getAll();
    const value = Reflect.get(data, prop);
    return typeof value === 'function' ? value.bind(data) : value;
  },
  has(_, prop) {
    return Reflect.has(getAll(), prop);
  },
  ownKeys() {
    return Reflect.ownKeys(getAll());
  },
  getOwnPropertyDescriptor(_, prop) {
    return Reflect.getOwnPropertyDescriptor(getAll(), prop);
  },
});

export function getDomainBySlug(slug: string): DomainData | undefined {
  return getAll().find(d => d.slug === slug);
}

export function getDomainById(id: string): DomainData | undefined {
  return getAll().find(d => d.id === id);
}
