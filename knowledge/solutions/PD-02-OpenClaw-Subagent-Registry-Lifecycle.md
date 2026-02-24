# PD-02.06 OpenClaw — 子Agent注册表生命周期管理

> 文档编号：PD-02.06
> 来源：OpenClaw `src/agents/subagent-registry.ts`, `src/agents/subagent-spawn.ts`, `src/agents/subagent-announce.ts`
> GitHub：https://github.com/openclaw/openclaw.git
> 问题域：PD-02 多Agent编排 Multi-Agent Orchestration
> 状态：可复用方案

---

## 第 1 章 问题与动机

### 1.1 核心问题

多 Agent 系统中，子 Agent 的生命周期管理是最容易出错的环节。核心挑战包括：

1. **生命周期追踪**：父 Agent spawn 子 Agent 后，如何可靠地知道子 Agent 何时完成、是否超时、是否出错？
2. **结果交付**：子 Agent 完成后，其输出如何可靠地回传给请求者？如果请求者正忙怎么办？
3. **递归防护**：子 Agent 能否继续 spawn 子子 Agent？如何防止无限嵌套？
4. **崩溃恢复**：进程重启后，正在运行的子 Agent 状态如何恢复？
5. **资源回收**：已完成的子 Agent 会话如何清理，避免资源泄漏？

这些问题在单 Agent 系统中不存在，但在生产级多 Agent 编排中是必须解决的基础设施问题。

### 1.2 OpenClaw 的解法概述

OpenClaw 采用**中心化注册表 + 推送式公告**的架构，核心要点：

1. **SubagentRunRecord 注册表**：内存 Map + 磁盘持久化，记录每个子 Agent 运行的完整状态（`src/agents/subagent-registry.ts:42`）
2. **深度限制递归防护**：通过 `maxSpawnDepth` 配置（默认 1）限制嵌套层级，在 spawn 时检查（`src/agents/subagent-spawn.ts:222-227`）
3. **公告重试机制**：指数退避 + 最大 3 次重试 + 5 分钟过期，确保结果交付的可靠性（`src/agents/subagent-registry.ts:48-61`）
4. **三路交付策略**：steered → queued → direct，根据请求者状态选择最优交付路径（`src/agents/subagent-announce.ts:774-850`）
5. **Sweeper 自动清理**：60 秒间隔扫描过期记录，删除会话并回收资源（`src/agents/subagent-registry.ts:340-369`）

### 1.3 设计思想

| 设计原则 | 具体实现 | 理由 | 替代方案 |
|----------|----------|------|----------|
| 推送优于轮询 | 子 Agent 完成后自动公告给请求者，系统提示明确写 "do not busy-poll" | 轮询浪费 token 和 API 调用，推送模型更高效 | 请求者定期 poll subagents list |
| 持久化优于纯内存 | 注册表每次变更都 persist 到磁盘，重启后 restore | 进程崩溃不丢失运行中子 Agent 的状态 | 纯内存 Map，崩溃即丢失 |
| 深度限制优于无限嵌套 | DEFAULT_SUBAGENT_MAX_SPAWN_DEPTH = 1，可配置 | 防止递归 spawn 导致资源耗尽 | 无限制嵌套 + 全局并发上限 |
| 优雅降级优于硬失败 | 公告失败时 retry → queue → give-up，不阻塞调用者 | 分布式系统中交付失败是常态，需要容错 | 公告失败直接丢弃结果 |
| 幂等交付 | 每次公告生成 idempotencyKey，网关去重 | 重试不会导致重复消息 | 无去重，依赖业务层处理 |

---

## 第 2 章 源码实现分析

### 2.1 架构概览

OpenClaw 的子 Agent 编排系统由 10+ 个模块组成，核心架构如下：

```
┌─────────────────────────────────────────────────────────────────┐
│                     Parent Agent (Requester)                     │
│                                                                  │
│  spawnSubagentDirect()  ──→  registerSubagentRun()              │
│       ↓                           ↓                              │
│  callGateway("agent")       subagentRuns Map                    │
│       ↓                     + persistToDisk()                   │
│  Child Agent starts              ↓                              │
└──────────┬──────────────────────────────────────────────────────┘
           │
           │  lifecycle event (start/end/error)
           ↓
┌─────────────────────────────────────────────────────────────────┐
│                   Lifecycle Event Listener                        │
│                                                                  │
│  onAgentEvent() ──→ completeSubagentRun()                       │
│                          ↓                                       │
│                   startSubagentAnnounceCleanupFlow()             │
│                          ↓                                       │
│              ┌───────────┴───────────┐                           │
│              ↓                       ↓                           │
│     runSubagentAnnounceFlow()   emitSubagentEndedHook()         │
│              ↓                                                   │
│     deliverSubagentAnnouncement()                               │
│              ↓                                                   │
│     ┌────────┼────────┐                                         │
│     ↓        ↓        ↓                                         │
│  steered  queued   direct                                       │
│  (inject) (queue)  (gateway send)                               │
└─────────────────────────────────────────────────────────────────┘
           │
           ↓  (on failure)
┌─────────────────────────────────────────────────────────────────┐
│                   Retry & Cleanup                                │
│                                                                  │
│  resolveDeferredCleanupDecision()                               │
│     ├── defer-descendants (wait for children)                   │
│     ├── retry (exponential backoff, max 3)                      │
│     └── give-up (expiry 5min / retry-limit)                    │
│                                                                  │
│  sweepSubagentRuns() ──→ delete archived sessions (60s interval)│
└─────────────────────────────────────────────────────────────────┘
```

### 2.2 核心实现

#### 2.2.1 SubagentRunRecord — 运行记录数据结构

每个子 Agent 运行由一个 `SubagentRunRecord` 描述（`src/agents/subagent-registry.types.ts:6-35`）：

```typescript
export type SubagentRunRecord = {
  runId: string;
  childSessionKey: string;
  requesterSessionKey: string;
  requesterOrigin?: DeliveryContext;
  requesterDisplayKey: string;
  task: string;
  cleanup: "delete" | "keep";
  label?: string;
  model?: string;
  runTimeoutSeconds?: number;
  spawnMode?: SpawnSubagentMode;  // "run" | "session"
  createdAt: number;
  startedAt?: number;
  endedAt?: number;
  outcome?: SubagentRunOutcome;   // ok | error | timeout | unknown
  archiveAtMs?: number;
  cleanupCompletedAt?: number;
  cleanupHandled?: boolean;
  suppressAnnounceReason?: "steer-restart" | "killed";
  expectsCompletionMessage?: boolean;
  announceRetryCount?: number;
  lastAnnounceRetryAt?: number;
  endedReason?: SubagentLifecycleEndedReason;
  endedHookEmittedAt?: number;
};
```

这个设计的关键在于：`cleanup` 字段控制会话生命周期（"delete" 完成后删除，"keep" 保留），`spawnMode` 区分一次性运行和持久会话，`announceRetryCount` + `lastAnnounceRetryAt` 支撑指数退避重试。

#### 2.2.2 Spawn 流程 — 深度检查与并发限制

`spawnSubagentDirect()` 是 spawn 入口（`src/agents/subagent-spawn.ts:162-527`），关键防护逻辑：

```typescript
// src/agents/subagent-spawn.ts:219-236
const callerDepth = getSubagentDepthFromSessionStore(requesterInternalKey, { cfg });
const maxSpawnDepth =
  cfg.agents?.defaults?.subagents?.maxSpawnDepth ?? DEFAULT_SUBAGENT_MAX_SPAWN_DEPTH;
if (callerDepth >= maxSpawnDepth) {
  return {
    status: "forbidden",
    error: `sessions_spawn is not allowed at this depth (current depth: ${callerDepth}, max: ${maxSpawnDepth})`,
  };
}

const maxChildren = cfg.agents?.defaults?.subagents?.maxChildrenPerAgent ?? 5;
const activeChildren = countActiveRunsForSession(requesterInternalKey);
if (activeChildren >= maxChildren) {
  return {
    status: "forbidden",
    error: `sessions_spawn has reached max active children for this session (${activeChildren}/${maxChildren})`,
  };
}
```

两层防护：
- **深度限制**：`DEFAULT_SUBAGENT_MAX_SPAWN_DEPTH = 1`（`src/config/agent-limits.ts:6`），即默认只允许一层子 Agent，不允许子子 Agent
- **并发限制**：每个 Agent 最多 5 个活跃子 Agent（`maxChildrenPerAgent`），防止单个 Agent 过度 spawn

#### 2.2.3 注册与等待 — 双通道完成检测

spawn 成功后立即注册到内存 Map 并持久化（`src/agents/subagent-registry.ts:671-720`）：

```typescript
// src/agents/subagent-registry.ts:694-720
subagentRuns.set(params.runId, {
  runId: params.runId,
  childSessionKey: params.childSessionKey,
  requesterSessionKey: params.requesterSessionKey,
  // ... 完整记录
  createdAt: now,
  startedAt: now,
  cleanupHandled: false,
});
ensureListener();        // 启动生命周期事件监听器
persistSubagentRuns();   // 持久化到磁盘
// 通过 gateway RPC 等待子 Agent 完成（跨进程）
void waitForSubagentCompletion(params.runId, waitTimeoutMs);
```

完成检测有两个通道：
- **Gateway RPC**：`callGateway({ method: "agent.wait" })` 跨进程等待（`src/agents/subagent-registry.ts:722-785`）
- **进程内事件监听**：`onAgentEvent()` 监听 lifecycle stream 的 start/end/error 事件（`src/agents/subagent-registry.ts:371-416`），作为 fallback

#### 2.2.4 公告重试 — 指数退避策略

公告失败时的重试逻辑（`src/agents/subagent-registry.ts:63-69`）：

```typescript
function resolveAnnounceRetryDelayMs(retryCount: number) {
  const boundedRetryCount = Math.max(0, Math.min(retryCount, 10));
  const backoffExponent = Math.max(0, boundedRetryCount - 1);
  const baseDelay = MIN_ANNOUNCE_RETRY_DELAY_MS * 2 ** backoffExponent;  // 1s, 2s, 4s...
  return Math.min(baseDelay, MAX_ANNOUNCE_RETRY_DELAY_MS);  // 上限 8s
}
```

退避参数：
- 初始延迟：1 秒（`MIN_ANNOUNCE_RETRY_DELAY_MS`）
- 最大延迟：8 秒（`MAX_ANNOUNCE_RETRY_DELAY_MS`）
- 最大重试次数：3 次（`MAX_ANNOUNCE_RETRY_COUNT`，`src/agents/subagent-registry.ts:56`）
- 绝对过期：5 分钟（`ANNOUNCE_EXPIRY_MS`，`src/agents/subagent-registry.ts:61`）

清理决策由 `resolveDeferredCleanupDecision()` 统一处理（`src/agents/subagent-registry-cleanup.ts:33-67`），返回三种决策：
- `defer-descendants`：子 Agent 还有活跃后代，等待后代完成
- `retry`：递增重试计数，按退避延迟重试
- `give-up`：达到重试上限或过期，放弃公告

### 2.3 实现细节

#### 三路交付策略

`deliverSubagentAnnouncement()` 实现了三种交付路径（`src/agents/subagent-announce.ts:774-850`）：

1. **Steered**：如果请求者正在运行嵌入式 PI，通过 `queueEmbeddedPiMessage()` 直接注入消息流
2. **Queued**：如果请求者正忙，放入公告队列 `enqueueAnnounce()`，等请求者空闲时 drain
3. **Direct**：通过 gateway `agent` 或 `send` 方法直接发送

对于 `expectsCompletionMessage` 模式（手动 spawn），优先尝试 direct 以实现即时返回；失败后 fallback 到 queue。

#### 子 Agent 系统提示注入

`buildSubagentSystemPrompt()` 根据深度动态生成系统提示（`src/agents/subagent-announce.ts:860-950`）：
- 深度 < maxSpawnDepth：允许 spawn 子子 Agent，提示中包含 spawn 指引
- 深度 >= maxSpawnDepth：标记为 "leaf worker"，禁止继续 spawn
- 明确告知 "Results auto-announce to your requester; do not busy-poll for status"

#### 磁盘持久化与恢复

`persistSubagentRunsToDisk()` 和 `restoreSubagentRunsFromDisk()` 实现跨进程状态共享（`src/agents/subagent-registry-state.ts:1-56`）：
- 每次状态变更都写磁盘（`persistSubagentRuns()` 在 registry 中被调用 15+ 次）
- 读取时合并磁盘和内存状态，磁盘优先（让其他 worker 进程可见）
- 恢复时使用 `mergeOnly: true`，不覆盖已有内存记录

#### 后代运行计数 — BFS 遍历

`countActiveDescendantRunsFromRuns()` 使用 BFS 遍历整个子 Agent 树（`src/agents/subagent-registry-queries.ts:82-114`），统计所有活跃后代。这用于：
- 公告延迟：如果子 Agent 还有活跃后代，延迟公告避免报告不完整结果
- 直接交付决策：有活跃兄弟/后代时，不直接发送 completion 消息

---

## 第 3 章 迁移指南

### 3.1 迁移清单

**阶段 1：基础注册表**
- [ ] 定义 `SubagentRunRecord` 类型（至少包含 runId, childSessionKey, requesterSessionKey, task, status, createdAt, endedAt, outcome）
- [ ] 实现内存 Map 存储 + JSON 文件持久化
- [ ] 实现 `registerRun()` / `completeRun()` / `killRun()` 基础 API

**阶段 2：Spawn 防护**
- [ ] 实现深度计算（从 session store 或 session key 解析）
- [ ] 添加 `maxSpawnDepth` 配置（建议默认 1-2）
- [ ] 添加 `maxChildrenPerAgent` 并发限制（建议默认 5）

**阶段 3：结果交付**
- [ ] 实现完成事件监听（进程内 + 跨进程两个通道）
- [ ] 实现公告消息构建（区分 ok/error/timeout 状态）
- [ ] 实现指数退避重试（建议 1s/2s/4s，最大 3 次）

**阶段 4：清理与恢复**
- [ ] 实现 sweeper 定时清理过期记录
- [ ] 实现进程重启后的状态恢复
- [ ] 实现后代运行计数，延迟公告直到后代完成

### 3.2 适配代码模板

以下是一个简化但可运行的 TypeScript 注册表实现：

```typescript
import fs from "node:fs";
import path from "node:path";

// --- Types ---
type RunOutcome = { status: "ok" | "error" | "timeout"; error?: string };

type SubagentRunRecord = {
  runId: string;
  parentId: string;
  task: string;
  depth: number;
  createdAt: number;
  startedAt?: number;
  endedAt?: number;
  outcome?: RunOutcome;
  announceRetryCount: number;
  lastRetryAt?: number;
};

// --- Config ---
const MAX_SPAWN_DEPTH = 2;
const MAX_CHILDREN_PER_AGENT = 5;
const MAX_ANNOUNCE_RETRIES = 3;
const ANNOUNCE_EXPIRY_MS = 5 * 60_000;
const MIN_RETRY_DELAY_MS = 1_000;
const MAX_RETRY_DELAY_MS = 8_000;

// --- Registry ---
const runs = new Map<string, SubagentRunRecord>();
const PERSIST_PATH = path.join(process.cwd(), ".subagent-registry.json");

function persist() {
  const data = Object.fromEntries(runs);
  fs.writeFileSync(PERSIST_PATH, JSON.stringify(data, null, 2));
}

function restore() {
  try {
    const raw = fs.readFileSync(PERSIST_PATH, "utf-8");
    const data = JSON.parse(raw) as Record<string, SubagentRunRecord>;
    for (const [id, record] of Object.entries(data)) {
      if (!runs.has(id)) runs.set(id, record);
    }
  } catch { /* ignore */ }
}

// --- Spawn Guard ---
function canSpawn(parentId: string): { ok: boolean; error?: string } {
  const parent = runs.get(parentId);
  const depth = parent ? parent.depth + 1 : 1;
  if (depth > MAX_SPAWN_DEPTH) {
    return { ok: false, error: `Depth ${depth} exceeds max ${MAX_SPAWN_DEPTH}` };
  }
  const activeChildren = [...runs.values()].filter(
    (r) => r.parentId === parentId && !r.endedAt
  ).length;
  if (activeChildren >= MAX_CHILDREN_PER_AGENT) {
    return { ok: false, error: `Active children ${activeChildren} >= ${MAX_CHILDREN_PER_AGENT}` };
  }
  return { ok: true };
}

// --- Register ---
function registerRun(params: {
  runId: string; parentId: string; task: string; depth: number;
}): SubagentRunRecord {
  const record: SubagentRunRecord = {
    ...params,
    createdAt: Date.now(),
    startedAt: Date.now(),
    announceRetryCount: 0,
  };
  runs.set(params.runId, record);
  persist();
  return record;
}

// --- Complete ---
function completeRun(runId: string, outcome: RunOutcome) {
  const record = runs.get(runId);
  if (!record || record.endedAt) return;
  record.endedAt = Date.now();
  record.outcome = outcome;
  persist();
  scheduleAnnounce(runId);
}

// --- Retry with exponential backoff ---
function retryDelayMs(retryCount: number): number {
  const exp = Math.max(0, retryCount - 1);
  return Math.min(MIN_RETRY_DELAY_MS * 2 ** exp, MAX_RETRY_DELAY_MS);
}

async function scheduleAnnounce(runId: string) {
  const record = runs.get(runId);
  if (!record) return;
  if (record.announceRetryCount >= MAX_ANNOUNCE_RETRIES) return;
  if (record.endedAt && Date.now() - record.endedAt > ANNOUNCE_EXPIRY_MS) return;

  const delivered = await deliverAnnouncement(record);
  if (delivered) return;

  record.announceRetryCount += 1;
  record.lastRetryAt = Date.now();
  persist();
  const delay = retryDelayMs(record.announceRetryCount);
  setTimeout(() => scheduleAnnounce(runId), delay).unref?.();
}

async function deliverAnnouncement(record: SubagentRunRecord): Promise<boolean> {
  // Implement your delivery logic here (steered → queued → direct)
  console.log(`Announcing ${record.runId}: ${record.outcome?.status}`);
  return true; // Return false to trigger retry
}

// --- Init ---
restore();
```

### 3.3 适用场景

| 场景 | 适用度 | 说明 |
|------|--------|------|
| 长时间运行的子任务（研究、代码生成） | ⭐⭐⭐ | 完整的超时、重试、恢复机制 |
| 需要嵌套子 Agent 的复杂编排 | ⭐⭐⭐ | 深度限制 + 后代计数 + 递归公告 |
| 多渠道交付（Slack/Discord/Web） | ⭐⭐⭐ | 三路交付策略 + 渠道路由 |
| 简单的单层工具调用 | ⭐ | 过度设计，直接调用即可 |
| 实时流式协作 | ⭐⭐ | 推送模型适合，但不支持流式中间结果 |

---

