# PD-01.07 OpenClaw — 自适应分块压缩 + 上下文窗口守卫 + 工具结果预算控制

> 文档编号：PD-01.07
> 来源：OpenClaw `src/agents/compaction.ts` `src/agents/context-window-guard.ts` `src/agents/pi-embedded-runner/tool-result-context-guard.ts`
> GitHub：https://github.com/openclaw/openclaw.git
> 问题域：PD-01 上下文管理 Context Window Management
> 状态：可复用方案

---

## 第 1 章 问题与动机

### 1.1 核心问题

长对话 Agent 在多轮工具调用后，上下文窗口会被大量工具返回结果和历史消息填满。
不同于简单的 RAG 检索场景，Agent 对话中的上下文增长是不可预测的——一次 Bash 执行可能返回几十 KB 的日志，
一次文件读取可能灌入整个源文件。如果不加控制，会导致：

1. **API 拒绝请求**：超出模型 context window 硬限制（如 200K tokens）
2. **成本失控**：每次 API 调用的 input token 费用随上下文线性增长
3. **质量下降**：过长上下文中关键信息被稀释，模型注意力分散
4. **悬挂工具调用**：压缩历史后 tool_use/tool_result 配对断裂，导致 API 400 错误

OpenClaw 的解法不是简单的"超了就截"，而是一套多层防御体系：
从 token 估算 → 自适应分块 → 分阶段摘要 → 渐进降级 → 工具结果预算 → 窗口守卫，
每一层都有独立的安全边际和降级策略。

### 1.2 OpenClaw 的解法概述

1. **chars/4 快速估算 + 1.2x 安全边际**：不依赖 tokenizer 库，用字符数/4 估算 token 数，
   再乘以 SAFETY_MARGIN=1.2 补偿多字节字符和特殊 token 的低估（`compaction.ts:13`）
2. **自适应分块压缩**：根据消息平均大小动态调整 chunk ratio（0.15~0.4），
   大消息场景自动缩小分块避免溢出（`compaction.ts:129-148`）
3. **分阶段摘要合并**：先按 token 份额切分消息为 N 段，各段独立摘要，
   再用 LLM 合并为统一摘要，保留决策、TODO、约束（`compaction.ts:276-337`）
4. **工具结果预算控制**：独立的 transformContext 守卫，在每次 API 调用前
   截断过大的工具结果，从最旧的开始压缩（`tool-result-context-guard.ts:269-295`）
5. **上下文窗口守卫**：多源解析窗口大小（模型元数据 > 配置 > 默认值），
   硬限制 16K / 警告 32K，阻止过小窗口的模型运行（`context-window-guard.ts:57-74`）

### 1.3 设计思想

| 设计原则 | 具体实现 | 理由 | 替代方案 |
|----------|----------|------|----------|
| 安全边际优先 | SAFETY_MARGIN=1.2 贯穿所有估算 | chars/4 对代码/CJK/特殊 token 低估 | 引入 tiktoken 精确计算（更慢） |
| 自适应而非固定 | chunk ratio 根据消息大小动态调整 | 大消息用固定 ratio 会溢出 | 固定分块大小（不适应场景变化） |
| 渐进降级 | full → partial → fallback 三级摘要 | 大消息可能导致摘要本身溢出 | 直接丢弃（丢失上下文） |
| 工具结果隔离 | 独立的 tool result context guard | 单个工具结果可能占满整个窗口 | 统一压缩（无法针对性处理） |
| 配对修复 | repairToolUseResultPairing 修复悬挂调用 | 压缩后 tool_use 和 result 可能分离 | 忽略（导致 API 400 错误） |
| 多源窗口解析 | modelsConfig > model > agentContextTokens > default | 不同部署环境窗口大小不同 | 硬编码（不灵活） |

---

## 第 2 章 源码实现分析

### 2.1 架构概览

OpenClaw 的上下文管理分为三个独立但协作的子系统：

```
┌─────────────────────────────────────────────────────────────────┐
│                    Agent Run Loop (run.ts)                       │
│                                                                 │
│  ┌──────────────────┐  ┌──────────────────┐  ┌───────────────┐ │
│  │ Context Window    │  │ Tool Result      │  │ Compaction    │ │
│  │ Guard             │  │ Context Guard    │  │ Safeguard     │ │
│  │                   │  │                  │  │               │ │
│  │ • resolveContext  │  │ • transformCtx   │  │ • summarize   │ │
│  │   WindowInfo()    │  │   (per API call) │  │   InStages()  │ │
│  │ • evaluateGuard() │  │ • truncate tool  │  │ • pruneHist   │ │
│  │ • block/warn      │  │   results        │  │   oryForCtx   │ │
│  │                   │  │ • compact oldest │  │   Share()     │ │
│  └────────┬─────────┘  └────────┬─────────┘  └───────┬───────┘ │
│           │                     │                     │         │
│           ▼                     ▼                     ▼         │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │              Session Transcript Repair                      ││
│  │  • repairToolUseResultPairing() — 修复悬挂 tool_use/result  ││
│  │  • stripToolResultDetails() — 移除不可信的 details 字段     ││
│  │  • repairToolCallInputs() — 验证工具调用完整性              ││
│  └─────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────┘
```

**数据流：**
1. Agent 启动时，`resolveContextWindowInfo()` 确定窗口大小 → `evaluateContextWindowGuard()` 检查是否可用
2. 每次 API 调用前，`installToolResultContextGuard()` 注入 `transformContext` 钩子截断过大工具结果
3. 上下文接近阈值时，`compactionSafeguardExtension` 触发 `summarizeInStages()` 压缩历史
4. 压缩后，`repairToolUseResultPairing()` 修复因裁剪导致的 tool_use/tool_result 配对断裂

### 2.2 核心实现

#### 2.2.1 Token 估算与安全边际

OpenClaw 不使用 tiktoken 等精确 tokenizer，而是用 chars/4 启发式估算，
通过 1.2x 安全边际补偿低估（`compaction.ts:13,20-24`）：

```typescript
// src/agents/compaction.ts:11-24
export const SAFETY_MARGIN = 1.2; // 20% buffer for estimateTokens() inaccuracy

export function estimateMessagesTokens(messages: AgentMessage[]): number {
  // SECURITY: toolResult.details can contain untrusted/verbose payloads;
  // never include in LLM-facing compaction.
  const safe = stripToolResultDetails(messages);
  return safe.reduce((sum, message) => sum + estimateTokens(message), 0);
}
```

安全边际在分块时应用（`compaction.ts:91-93`）：

```typescript
// src/agents/compaction.ts:91-93
// Apply safety margin to compensate for estimateTokens() underestimation
const effectiveMax = Math.max(1, Math.floor(maxTokens / SAFETY_MARGIN));
```

#### 2.2.2 自适应分块比率

固定 chunk ratio 在消息大小差异大时会失效。OpenClaw 根据平均消息大小动态调整（`compaction.ts:129-148`）：

```typescript
// src/agents/compaction.ts:129-148
export function computeAdaptiveChunkRatio(
  messages: AgentMessage[], contextWindow: number
): number {
  if (messages.length === 0) return BASE_CHUNK_RATIO;

  const totalTokens = estimateMessagesTokens(messages);
  const avgTokens = totalTokens / messages.length;
  const safeAvgTokens = avgTokens * SAFETY_MARGIN;
  const avgRatio = safeAvgTokens / contextWindow;

  // If average message is > 10% of context, reduce chunk ratio
  if (avgRatio > 0.1) {
    const reduction = Math.min(avgRatio * 2, BASE_CHUNK_RATIO - MIN_CHUNK_RATIO);
    return Math.max(MIN_CHUNK_RATIO, BASE_CHUNK_RATIO - reduction);
  }
  return BASE_CHUNK_RATIO; // 0.4
}
```

当 avgRatio > 0.1（平均消息占上下文 10% 以上）时，ratio 从 0.4 线性下降到最低 0.15，
确保每个 chunk 不会因为单条大消息而溢出。

#### 2.2.3 分阶段摘要合并（Map-Reduce 模式）

`summarizeInStages()` 是压缩的核心入口（`compaction.ts:276-337`）：

1. 按 token 份额将消息切分为 N 段（默认 2 段）
2. 每段独立调用 `summarizeWithFallback()` 生成部分摘要
3. 将部分摘要作为新消息，用 `MERGE_SUMMARIES_INSTRUCTIONS` 合并为最终摘要

```typescript
// src/agents/compaction.ts:307-336 (简化)
const splits = splitMessagesByTokenShare(messages, parts);
const partialSummaries: string[] = [];
for (const chunk of splits) {
  partialSummaries.push(
    await summarizeWithFallback({ ...params, messages: chunk })
  );
}
// 合并部分摘要
const summaryMessages = partialSummaries.map(summary => ({
  role: "user", content: summary, timestamp: Date.now(),
}));
return summarizeWithFallback({
  ...params,
  messages: summaryMessages,
  customInstructions: MERGE_SUMMARIES_INSTRUCTIONS,
});
```

合并指令明确要求保留关键信息（`compaction.ts:16-18`）：
> "Merge these partial summaries into a single cohesive summary. Preserve decisions, TODOs, open questions, and any constraints."

#### 2.2.4 渐进降级摘要

`summarizeWithFallback()` 实现三级降级（`compaction.ts:208-274`）：

1. **Full**：尝试完整摘要所有消息
2. **Partial**：失败后，跳过超大消息（>50% 上下文），只摘要小消息，附注超大消息的存在
3. **Fallback**：全部失败，返回统计性描述 "Context contained N messages (M oversized)"

```typescript
// src/agents/compaction.ts:236-259
// Fallback 1: Summarize only small messages, note oversized ones
const smallMessages: AgentMessage[] = [];
const oversizedNotes: string[] = [];
for (const msg of messages) {
  if (isOversizedForSummary(msg, contextWindow)) {
    oversizedNotes.push(
      `[Large ${role} (~${Math.round(tokens / 1000)}K tokens) omitted from summary]`
    );
  } else {
    smallMessages.push(msg);
  }
}
```

#### 2.2.5 工具结果预算控制

独立于压缩系统，`installToolResultContextGuard()` 在每次 API 调用前拦截过大的工具结果
（`tool-result-context-guard.ts:297-336`）：

```typescript
// src/agents/pi-embedded-runner/tool-result-context-guard.ts:297-331
export function installToolResultContextGuard(params: {
  agent: GuardableAgent;
  contextWindowTokens: number;
}): () => void {
  const contextBudgetChars = Math.max(1_024,
    Math.floor(contextWindowTokens * CHARS_PER_TOKEN_ESTIMATE * CONTEXT_INPUT_HEADROOM_RATIO)
  ); // 75% of context window
  const maxSingleToolResultChars = Math.max(1_024,
    Math.floor(contextWindowTokens * TOOL_RESULT_CHARS_PER_TOKEN_ESTIMATE
      * SINGLE_TOOL_RESULT_CONTEXT_SHARE)
  ); // 50% of context for single result

  mutableAgent.transformContext = async (messages, signal) => {
    const transformed = originalTransformContext
      ? await originalTransformContext.call(mutableAgent, messages, signal)
      : messages;
    enforceToolResultContextBudgetInPlace({
      messages: transformed,
      contextBudgetChars,
      maxSingleToolResultChars,
    });
    return transformed;
  };
}
```

关键设计：
- 单个工具结果上限 = 上下文窗口 × 50%（`SINGLE_TOOL_RESULT_CONTEXT_SHARE`）
- 总预算 = 上下文窗口 × 75%（`CONTEXT_INPUT_HEADROOM_RATIO`）
- 超预算时从最旧的工具结果开始压缩（`compactExistingToolResultsInPlace`）
- 截断时在换行符处断开，保持可读性（`tool-result-context-guard.ts:176-183`）

#### 2.2.6 上下文窗口守卫

`resolveContextWindowInfo()` 按优先级从四个来源解析窗口大小（`context-window-guard.ts:21-50`）：

```
modelsConfig（用户配置的 provider.models[].contextWindow）
  → model（模型元数据的 contextWindow）
    → agentContextTokens（全局 cap）
      → DEFAULT_CONTEXT_TOKENS（200K fallback）
```

`evaluateContextWindowGuard()` 在 Agent 启动时检查（`context-window-guard.ts:57-74`）：
- `shouldWarn`：窗口 < 32K tokens → 日志警告
- `shouldBlock`：窗口 < 16K tokens → 抛出 FailoverError 阻止运行

### 2.3 实现细节

#### 历史裁剪与配对修复

`pruneHistoryForContextShare()` 按 token 预算裁剪历史（`compaction.ts:339-401`），
裁剪后立即调用 `repairToolUseResultPairing()` 修复断裂的 tool_use/tool_result 配对：

- 孤立的 tool_result（其 tool_use 在被裁剪的 chunk 中）会被丢弃
- 缺失的 tool_result 会插入合成的错误结果
- 重复的 tool_result 会被去重
- 被中止/出错的 assistant 消息（stopReason="error"/"aborted"）跳过修复，
  避免为不完整的 tool_use 创建合成结果导致 API 400 错误（`session-transcript-repair.ts:259-264`）

#### 安全性：stripToolResultDetails

所有进入摘要流程的消息都会先经过 `stripToolResultDetails()`（`session-transcript-repair.ts:106-123`），
移除 toolResult 的 `details` 字段。这是因为 details 可能包含不可信的、冗长的原始载荷
（如完整的 HTTP 响应体），不应进入 LLM 的摘要 prompt。

#### 压缩安全守卫扩展

`compactionSafeguardExtension`（`compaction-safeguard.ts:191-371`）是一个 pi-coding-agent 扩展，
监听 `session_before_compact` 事件。它在标准压缩流程之上增加了：

1. **历史预算裁剪**：当新内容占比过高时，先裁剪旧历史再摘要
2. **工具失败追踪**：收集被压缩消息中的工具失败记录，附加到摘要末尾
3. **文件操作记录**：将 read/modified 文件列表附加到摘要，保持文件上下文
4. **工作区关键规则**：从 AGENTS.md 提取 "Session Startup" 和 "Red Lines" 注入摘要
5. **Split Turn 处理**：分裂轮次的前缀消息单独摘要，用 TURN_PREFIX_INSTRUCTIONS 指导

---

## 第 3 章 迁移指南

### 3.1 迁移清单

**阶段 1：Token 估算 + 安全边际（1 个文件）**
- [ ] 实现 `estimateTokens(message)` 函数（chars/4 启发式）
- [ ] 定义 `SAFETY_MARGIN = 1.2` 常量
- [ ] 实现 `estimateMessagesTokens()` 批量估算

**阶段 2：分块压缩（1 个文件）**
- [ ] 实现 `chunkMessagesByMaxTokens()` 按 token 上限分块
- [ ] 实现 `splitMessagesByTokenShare()` 按 token 份额均分
- [ ] 实现 `computeAdaptiveChunkRatio()` 自适应比率

**阶段 3：摘要系统（需要 LLM 调用能力）**
- [ ] 实现 `summarizeChunks()` 逐块摘要
- [ ] 实现 `summarizeWithFallback()` 三级降级
- [ ] 实现 `summarizeInStages()` Map-Reduce 合并
- [ ] 集成重试机制（3 次，指数退避 + 抖动）

**阶段 4：工具结果预算（可选，推荐）**
- [ ] 实现 `installToolResultContextGuard()` transformContext 钩子
- [ ] 定义预算常量：75% 总预算，50% 单结果上限

**阶段 5：窗口守卫（可选）**
- [ ] 实现 `resolveContextWindowInfo()` 多源解析
- [ ] 实现 `evaluateContextWindowGuard()` 硬限制/警告

**阶段 6：配对修复（强烈推荐）**
- [ ] 实现 `repairToolUseResultPairing()` 修复悬挂调用
- [ ] 实现 `stripToolResultDetails()` 安全过滤

### 3.2 适配代码模板

以下是一个可直接运行的 TypeScript 最小实现，覆盖核心的估算 + 分块 + 安全边际：

```typescript
// context-manager.ts — 最小可运行模板
const SAFETY_MARGIN = 1.2;
const BASE_CHUNK_RATIO = 0.4;
const MIN_CHUNK_RATIO = 0.15;

interface Message {
  role: string;
  content: string | unknown[];
  timestamp?: number;
}

function estimateTokens(msg: Message): number {
  const text = typeof msg.content === "string"
    ? msg.content
    : JSON.stringify(msg.content);
  return Math.ceil(text.length / 4);
}

function estimateMessagesTokens(messages: Message[]): number {
  return messages.reduce((sum, m) => sum + estimateTokens(m), 0);
}

function chunkMessagesByMaxTokens(
  messages: Message[], maxTokens: number
): Message[][] {
  const effectiveMax = Math.floor(maxTokens / SAFETY_MARGIN);
  const chunks: Message[][] = [];
  let current: Message[] = [];
  let currentTokens = 0;

  for (const msg of messages) {
    const msgTokens = estimateTokens(msg);
    if (current.length > 0 && currentTokens + msgTokens > effectiveMax) {
      chunks.push(current);
      current = [];
      currentTokens = 0;
    }
    current.push(msg);
    currentTokens += msgTokens;
    // 超大消息单独成块
    if (msgTokens > effectiveMax) {
      chunks.push(current);
      current = [];
      currentTokens = 0;
    }
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

function computeAdaptiveChunkRatio(
  messages: Message[], contextWindow: number
): number {
  if (messages.length === 0) return BASE_CHUNK_RATIO;
  const totalTokens = estimateMessagesTokens(messages);
  const avgTokens = (totalTokens / messages.length) * SAFETY_MARGIN;
  const avgRatio = avgTokens / contextWindow;
  if (avgRatio > 0.1) {
    const reduction = Math.min(avgRatio * 2, BASE_CHUNK_RATIO - MIN_CHUNK_RATIO);
    return Math.max(MIN_CHUNK_RATIO, BASE_CHUNK_RATIO - reduction);
  }
  return BASE_CHUNK_RATIO;
}

// 使用示例
const messages: Message[] = [
  { role: "user", content: "Hello" },
  { role: "assistant", content: "Hi! How can I help?" },
  { role: "user", content: "Read this file..." + "x".repeat(10000) },
];
const contextWindow = 200_000;
const ratio = computeAdaptiveChunkRatio(messages, contextWindow);
const maxChunkTokens = Math.floor(contextWindow * ratio);
const chunks = chunkMessagesByMaxTokens(messages, maxChunkTokens);
console.log(`Adaptive ratio: ${ratio}, Chunks: ${chunks.length}`);
```

### 3.3 适用场景

| 场景 | 适用度 | 说明 |
|------|--------|------|
| 多轮工具调用 Agent | ⭐⭐⭐ | 核心场景，工具结果预算控制尤其关键 |
| 长对话聊天机器人 | ⭐⭐⭐ | 分阶段摘要 + 渐进降级非常适合 |
| 代码编辑 Agent | ⭐⭐⭐ | 文件读取产生大量上下文，自适应分块有效 |
| 单轮 RAG 问答 | ⭐ | 无需压缩历史，窗口守卫可复用 |
| 多模型切换场景 | ⭐⭐⭐ | 多源窗口解析 + 守卫确保模型兼容 |
| 成本敏感部署 | ⭐⭐ | 压缩减少 input token，但摘要本身消耗 token |

---

<!-- PLACEHOLDER_CONTENT_2 -->
