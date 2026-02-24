# PD-11.05 OpenClaw — 全栈可观测性：Usage 归一化 + Session 成本追踪 + 子系统结构化日志

> 文档编号：PD-11.05
> 来源：OpenClaw `src/agents/usage.ts` `src/infra/session-cost-usage.ts` `src/logging/subsystem.ts` `src/logging/diagnostic.ts`
> GitHub：https://github.com/openclaw/openclaw.git
> 问题域：PD-11 可观测性 Observability & Cost Tracking
> 状态：可复用方案

---

## 第 1 章 问题与动机

### 1.1 核心问题

Agent 系统接入多个 LLM 提供商（OpenAI、Anthropic、Google 等），每家 API 返回的 usage 字段命名各不相同：有的用 `input_tokens`，有的用 `promptTokens`，有的用 `prompt_tokens`。缓存 token 更是只有部分提供商支持（Anthropic 有 `cache_creation_input_tokens`，OpenAI 则无）。如果不做归一化，成本统计就是一团乱麻。

更深层的问题是：Agent 系统的可观测性不只是"记个日志"。它需要回答三个层次的问题：
1. **每次调用花了多少钱？** — Token 归一化 + 成本计算
2. **一个 session 整体表现如何？** — 延迟 p95、工具调用分布、按模型/日期聚合
3. **系统运行时健不健康？** — Session 状态追踪、卡死检测、心跳监控

OpenClaw 的方案覆盖了这三个层次，形成了从单次调用到系统全局的完整可观测性栈。

### 1.2 OpenClaw 的解法概述

1. **Usage 归一化层**（`src/agents/usage.ts:52-90`）：一个 `normalizeUsage()` 函数统一 10+ 种 provider 字段命名到 5 字段标准结构
2. **Session 级成本追踪**（`src/infra/session-cost-usage.ts`）：从 JSONL transcript 文件解析 usage，按日期/模型/工具多维聚合，含延迟 p95 统计
3. **子系统结构化日志**（`src/logging/subsystem.ts:263-350`）：基于 tslog 的分层日志，支持 subsystem 路径、console/file 双通道、JSON/pretty/compact 三种输出格式
4. **诊断心跳系统**（`src/logging/diagnostic.ts:308-376`）：30 秒心跳检测卡死 session（>120s），追踪 webhook/消息/队列全链路指标
5. **Usage 时间序列**（`src/infra/session-cost-usage.ts:740-847`）：累积 token/cost 时间序列，支持降采样，可直接用于图表渲染

### 1.3 设计思想

| 设计原则 | 具体实现 | 理由 | 替代方案 |
|----------|----------|------|----------|
| 归一化优先 | `UsageLike` 接受 10+ 种字段名，输出统一 `NormalizedUsage` | 多 provider 字段命名混乱，不归一化无法聚合 | 每个 provider 写适配器（代码量大） |
| JSONL 作为持久化格式 | transcript 文件用 JSONL，逐行追加 | 崩溃安全（写到哪算哪），流式读取不占内存 | SQLite（需要额外依赖）、JSON（非崩溃安全） |
| 按需计算不缓存 | `loadSessionCostSummary` 每次从文件扫描 | 避免缓存一致性问题，JSONL 顺序读取性能足够 | 预计算缓存（需要失效策略） |
| 子系统路径隔离 | `createSubsystemLogger("agent/embedded")` 支持 `/` 分层 | 多 Agent 系统中日志来源必须可区分 | 全局单 logger（无法过滤） |
| 双通道输出 | console + file 独立级别控制 | 开发时看 console，生产时查 file | 单通道（要么看不到要么太吵） |

---

## 第 2 章 源码实现分析

### 2.1 架构概览

```
┌─────────────────────────────────────────────────────────────────┐
│                    OpenClaw 可观测性架构                          │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌──────────────┐    ┌──────────────────┐    ┌───────────────┐ │
│  │ LLM Provider │───→│ normalizeUsage() │───→│ NormalizedUsage│ │
│  │ (各种格式)    │    │ agents/usage.ts  │    │ 5字段标准结构   │ │
│  └──────────────┘    └──────────────────┘    └───────┬───────┘ │
│                                                       │         │
│                                                       ▼         │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │              JSONL Transcript Files                       │  │
│  │  { message, usage, cost, provider, model, timestamp }    │  │
│  └──────────────────────────┬───────────────────────────────┘  │
│                              │                                  │
│              ┌───────────────┼───────────────┐                  │
│              ▼               ▼               ▼                  │
│  ┌────────────────┐ ┌──────────────┐ ┌──────────────────┐     │
│  │loadCostUsage   │ │loadSession   │ │loadSessionUsage  │     │
│  │Summary()       │ │CostSummary() │ │TimeSeries()      │     │
│  │ 全局日聚合      │ │ Session聚合   │ │ 时间序列+降采样   │     │
│  └────────────────┘ └──────────────┘ └──────────────────┘     │
│                                                                 │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │              Subsystem Logger (tslog)                     │  │
│  │  createSubsystemLogger("diagnostic")                     │  │
│  │  ├── console: pretty/compact/json                        │  │
│  │  ├── file: JSON lines (rolling, 500MB cap)               │  │
│  │  └── external transports (可扩展)                         │  │
│  └──────────────────────────────────────────────────────────┘  │
│                                                                 │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │              Diagnostic Heartbeat (30s)                   │  │
│  │  webhook stats → session states → stuck detection        │  │
│  │  tool loop detection (4 种检测器)                         │  │
│  └──────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

### 2.2 核心实现

#### 2.2.1 Usage 归一化（`src/agents/usage.ts:1-90`）

`UsageLike` 类型是整个可观测性栈的入口。它接受所有已知 provider 的字段命名：

```typescript
// src/agents/usage.ts:1-23
export type UsageLike = {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  total?: number;
  // OpenAI SDK 风格
  inputTokens?: number;
  outputTokens?: number;
  promptTokens?: number;
  completionTokens?: number;
  // Python SDK / REST API 风格
  input_tokens?: number;
  output_tokens?: number;
  prompt_tokens?: number;
  completion_tokens?: number;
  // Anthropic 缓存专用
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  // 其他变体
  totalTokens?: number;
  total_tokens?: number;
  cache_read?: number;
  cache_write?: number;
};
```

归一化函数用优先级链处理字段冲突（`src/agents/usage.ts:52-90`）：

```typescript
// src/agents/usage.ts:52-90
export function normalizeUsage(raw?: UsageLike | null): NormalizedUsage | undefined {
  if (!raw) return undefined;
  const input = asFiniteNumber(
    raw.input ?? raw.inputTokens ?? raw.input_tokens ?? raw.promptTokens ?? raw.prompt_tokens,
  );
  const output = asFiniteNumber(
    raw.output ?? raw.outputTokens ?? raw.output_tokens ??
    raw.completionTokens ?? raw.completion_tokens,
  );
  const cacheRead = asFiniteNumber(raw.cacheRead ?? raw.cache_read ?? raw.cache_read_input_tokens);
  const cacheWrite = asFiniteNumber(
    raw.cacheWrite ?? raw.cache_write ?? raw.cache_creation_input_tokens,
  );
  const total = asFiniteNumber(raw.total ?? raw.totalTokens ?? raw.total_tokens);
  if (input === undefined && output === undefined && cacheRead === undefined
      && cacheWrite === undefined && total === undefined) {
    return undefined;
  }
  return { input, output, cacheRead, cacheWrite, total };
}
```

关键设计：用 `??` 链而非 if-else，简洁且优先级清晰。`asFiniteNumber` 过滤 `NaN`/`Infinity`，防止脏数据污染聚合。

#### 2.2.2 Session 级成本追踪（`src/infra/session-cost-usage.ts`）

成本追踪的核心是 `loadSessionCostSummary()`（`src/infra/session-cost-usage.ts:462-738`），它从 JSONL transcript 文件中扫描每条记录，多维聚合：

```typescript
// src/infra/session-cost-usage.ts:186-195 — Token 累加
const applyUsageTotals = (totals: CostUsageTotals, usage: NormalizedUsage) => {
  totals.input += usage.input ?? 0;
  totals.output += usage.output ?? 0;
  totals.cacheRead += usage.cacheRead ?? 0;
  totals.cacheWrite += usage.cacheWrite ?? 0;
  const totalTokens = usage.total ??
    (usage.input ?? 0) + (usage.output ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
  totals.totalTokens += totalTokens;
};
```

延迟统计含 p95 计算（`src/infra/session-cost-usage.ts:169-184`）：

```typescript
// src/infra/session-cost-usage.ts:169-184
const computeLatencyStats = (values: number[]): SessionLatencyStats | undefined => {
  if (!values.length) return undefined;
  const sorted = values.toSorted((a, b) => a - b);
  const total = sorted.reduce((sum, v) => sum + v, 0);
  const count = sorted.length;
  const p95Index = Math.max(0, Math.ceil(count * 0.95) - 1);
  return {
    count,
    avgMs: total / count,
    p95Ms: sorted[p95Index] ?? sorted[count - 1],
    minMs: sorted[0],
    maxMs: sorted[count - 1],
  };
};
```

#### 2.2.3 子系统结构化日志（`src/logging/subsystem.ts:263-350`）

`createSubsystemLogger()` 是日志系统的工厂函数，每个子系统获得独立的 logger 实例：

```typescript
// src/logging/subsystem.ts:263-350 (核心结构)
export function createSubsystemLogger(subsystem: string): SubsystemLogger {
  let fileLogger: TsLogger<LogObj> | null = null;
  const getFileLogger = () => {
    if (!fileLogger) { fileLogger = getChildLogger({ subsystem }); }
    return fileLogger;
  };
  const emit = (level: LogLevel, message: string, meta?: Record<string, unknown>) => {
    // 1. 写入文件（JSON 格式，含 meta）
    logToFile(getFileLogger(), level, message, fileMeta);
    // 2. 检查 console 级别 + subsystem 过滤
    if (!shouldLogToConsole(level, { level: consoleSettings.level })) return;
    if (!shouldLogSubsystemToConsole(subsystem)) return;
    // 3. 格式化输出（pretty/compact/json 三种风格）
    const line = formatConsoleLine({ level, subsystem, message, style, meta });
    writeConsoleLine(level, line);
  };
  return {
    subsystem,
    isEnabled: (level, target) => { /* console/file/any 三种检查 */ },
    trace: (message, meta) => emit("trace", message, meta),
    debug: (message, meta) => emit("debug", message, meta),
    // ... info, warn, error, fatal
    raw: (message) => { /* 跳过格式化直接输出 */ },
    child: (name) => createSubsystemLogger(`${subsystem}/${name}`),
  };
}
```

子系统路径支持 `/` 分层（如 `agent/embedded`），`child()` 方法自动拼接路径。console 输出时会智能截断冗余前缀（`src/logging/subsystem.ts:113-132`）。

#### 2.2.4 诊断心跳与卡死检测（`src/logging/diagnostic.ts:308-376`）

30 秒心跳定时器扫描所有活跃 session，检测卡死（>120s 无活动）：

```typescript
// src/logging/diagnostic.ts:308-376
export function startDiagnosticHeartbeat() {
  heartbeatInterval = setInterval(() => {
    pruneDiagnosticSessionStates(now, true);
    // 统计活跃/等待/排队数
    const activeCount = /* ... processing sessions */;
    const waitingCount = /* ... waiting sessions */;
    const totalQueued = /* ... sum of queueDepth */;
    // 输出心跳日志
    diag.debug(`heartbeat: webhooks=${received}/${processed}/${errors} active=${activeCount}...`);
    // 发射诊断事件（可被外部消费）
    emitDiagnosticEvent({ type: "diagnostic.heartbeat", ... });
    // 检测卡死 session
    for (const [, state] of diagnosticSessionStates) {
      if (state.state === "processing" && (now - state.lastActivity) > 120_000) {
        logSessionStuck({ sessionId, state, ageMs });
      }
    }
  }, 30_000);
}
```

工具循环检测支持 4 种检测器（`src/logging/diagnostic.ts:259-293`）：
- `generic_repeat` — 通用重复检测
- `known_poll_no_progress` — 已知轮询无进展
- `global_circuit_breaker` — 全局熔断
- `ping_pong` — 乒乓循环

### 2.3 实现细节

**JSONL 流式读取**（`src/infra/session-cost-usage.ts:217-240`）：用 `readline.createInterface` 逐行解析，内存占用恒定，不受文件大小影响。

**成本估算回退链**：优先用 API 返回的 `cost` 字段（`extractCostBreakdown`），没有则用配置的模型价格 × token 数估算（`resolveModelCostConfig` + `estimateUsageCost`），都没有则记录 `missingCostEntries` 计数。

**时间序列降采样**（`src/infra/session-cost-usage.ts:800-844`）：当数据点超过 `maxPoints`（默认 100）时，按等间距分桶聚合，保留累积值的正确性。

**日志文件滚动**（`src/logging/logger.ts:270-308`）：按日期命名（`openclaw-YYYY-MM-DD.log`），自动清理 24 小时前的旧日志，单文件 500MB 上限。

**Session 状态生命周期管理**（`src/logging/diagnostic-session-state.ts:29-64`）：TTL 30 分钟，最大 2000 条，LRU 淘汰最久未活动的 session。

---

## 第 3 章 迁移指南

### 3.1 迁移清单

**阶段 1：Usage 归一化（1 个文件）**
- [ ] 复制 `UsageLike` 和 `NormalizedUsage` 类型定义
- [ ] 实现 `normalizeUsage()` 函数
- [ ] 根据你的 provider 列表调整字段优先级链

**阶段 2：成本计算（2 个文件）**
- [ ] 定义 `ModelCostConfig` 类型（每百万 token 价格）
- [ ] 实现 `estimateUsageCost()` 函数
- [ ] 配置各模型的价格表（可放在 config 文件中）

**阶段 3：Session 追踪（3 个文件）**
- [ ] 定义 `CostUsageTotals` 和 `SessionCostSummary` 类型
- [ ] 实现 JSONL transcript 写入（每次 LLM 调用追加一行）
- [ ] 实现 `loadSessionCostSummary()` 扫描聚合函数

**阶段 4：结构化日志（2 个文件）**
- [ ] 安装 tslog：`npm install tslog`
- [ ] 实现 `createSubsystemLogger()` 工厂函数
- [ ] 为每个子系统创建独立 logger

### 3.2 适配代码模板

```typescript
// === usage-normalizer.ts ===
// 可直接复用的 Usage 归一化模块

type UsageLike = {
  input?: number; output?: number;
  cacheRead?: number; cacheWrite?: number; total?: number;
  inputTokens?: number; outputTokens?: number;
  promptTokens?: number; completionTokens?: number;
  input_tokens?: number; output_tokens?: number;
  prompt_tokens?: number; completion_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  totalTokens?: number; total_tokens?: number;
};

type NormalizedUsage = {
  input?: number; output?: number;
  cacheRead?: number; cacheWrite?: number; total?: number;
};

const safe = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined;

export function normalizeUsage(raw?: UsageLike | null): NormalizedUsage | undefined {
  if (!raw) return undefined;
  const input = safe(raw.input ?? raw.inputTokens ?? raw.input_tokens
    ?? raw.promptTokens ?? raw.prompt_tokens);
  const output = safe(raw.output ?? raw.outputTokens ?? raw.output_tokens
    ?? raw.completionTokens ?? raw.completion_tokens);
  const cacheRead = safe(raw.cacheRead ?? raw.cache_read_input_tokens);
  const cacheWrite = safe(raw.cacheWrite ?? raw.cache_creation_input_tokens);
  const total = safe(raw.total ?? raw.totalTokens ?? raw.total_tokens);
  if ([input, output, cacheRead, cacheWrite, total].every(v => v === undefined)) return undefined;
  return { input, output, cacheRead, cacheWrite, total };
}

// === cost-calculator.ts ===
type ModelCost = { input: number; output: number; cacheRead: number; cacheWrite: number };

export function estimateCost(usage: NormalizedUsage, cost: ModelCost): number {
  return ((usage.input ?? 0) * cost.input +
    (usage.output ?? 0) * cost.output +
    (usage.cacheRead ?? 0) * cost.cacheRead +
    (usage.cacheWrite ?? 0) * cost.cacheWrite) / 1_000_000;
}

// === latency-stats.ts ===
export function computeLatencyStats(values: number[]) {
  if (!values.length) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((s, v) => s + v, 0);
  const p95Idx = Math.max(0, Math.ceil(sorted.length * 0.95) - 1);
  return {
    count: sorted.length,
    avgMs: sum / sorted.length,
    p95Ms: sorted[p95Idx],
    minMs: sorted[0],
    maxMs: sorted[sorted.length - 1],
  };
}
```

### 3.3 适用场景

| 场景 | 适用度 | 说明 |
|------|--------|------|
| 多 Provider Agent 系统 | ⭐⭐⭐ | Usage 归一化是核心价值，10+ 种格式统一 |
| 单 Provider 简单应用 | ⭐⭐ | 归一化价值降低，但成本追踪仍有用 |
| 长时间运行的 daemon | ⭐⭐⭐ | 心跳 + 卡死检测 + session 状态追踪非常适合 |
| 短生命周期 CLI 工具 | ⭐ | 诊断心跳过重，只需 usage 归一化 + 成本计算 |
| 需要实时监控的生产系统 | ⭐⭐⭐ | 诊断事件可对接外部监控（Prometheus/Grafana） |

---

## 第 4 章 测试用例

```typescript
import { describe, it, expect } from "vitest";

// ---- Usage 归一化测试 ----
describe("normalizeUsage", () => {
  it("should normalize OpenAI format", () => {
    const result = normalizeUsage({
      prompt_tokens: 100,
      completion_tokens: 50,
      total_tokens: 150,
    });
    expect(result).toEqual({
      input: 100, output: 50, cacheRead: undefined,
      cacheWrite: undefined, total: 150,
    });
  });

  it("should normalize Anthropic format with cache tokens", () => {
    const result = normalizeUsage({
      input_tokens: 200,
      output_tokens: 80,
      cache_read_input_tokens: 1500,
      cache_creation_input_tokens: 300,
    });
    expect(result).toEqual({
      input: 200, output: 80, cacheRead: 1500,
      cacheWrite: 300, total: undefined,
    });
  });

  it("should return undefined for empty/null input", () => {
    expect(normalizeUsage(null)).toBeUndefined();
    expect(normalizeUsage(undefined)).toBeUndefined();
    expect(normalizeUsage({})).toBeUndefined();
  });

  it("should filter NaN and Infinity", () => {
    const result = normalizeUsage({ input: NaN, output: Infinity, total: 100 });
    expect(result).toEqual({
      input: undefined, output: undefined,
      cacheRead: undefined, cacheWrite: undefined, total: 100,
    });
  });

  it("should prefer canonical names over alternates", () => {
    const result = normalizeUsage({
      input: 100,        // canonical
      inputTokens: 200,  // alternate (should be ignored)
    });
    expect(result?.input).toBe(100);
  });
});

// ---- 成本计算测试 ----
describe("estimateCost", () => {
  const claude35Cost = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };

  it("should calculate cost per million tokens", () => {
    const cost = estimateCost(
      { input: 1000, output: 500, cacheRead: 0, cacheWrite: 0 },
      claude35Cost,
    );
    // (1000*3 + 500*15) / 1_000_000 = 10500 / 1_000_000 = 0.0105
    expect(cost).toBeCloseTo(0.0105, 4);
  });

  it("should handle cache tokens in cost", () => {
    const cost = estimateCost(
      { input: 100, output: 50, cacheRead: 5000, cacheWrite: 1000 },
      claude35Cost,
    );
    // (100*3 + 50*15 + 5000*0.3 + 1000*3.75) / 1_000_000
    expect(cost).toBeCloseTo(0.006, 3);
  });
});

// ---- 延迟统计测试 ----
describe("computeLatencyStats", () => {
  it("should compute avg/p95/min/max", () => {
    const values = [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000];
    const stats = computeLatencyStats(values);
    expect(stats?.avgMs).toBe(550);
    expect(stats?.minMs).toBe(100);
    expect(stats?.maxMs).toBe(1000);
    expect(stats?.p95Ms).toBe(1000); // ceil(10*0.95)-1 = 9
    expect(stats?.count).toBe(10);
  });

  it("should return undefined for empty array", () => {
    expect(computeLatencyStats([])).toBeUndefined();
  });
});
```

---

## 第 5 章 跨域关联

| 关联域 | 关系类型 | 说明 |
|--------|----------|------|
| PD-01 上下文管理 | 协同 | `deriveSessionTotalTokens` 计算 session 总 token 用于上下文窗口占用率显示 |
| PD-03 容错与重试 | 协同 | 诊断系统的 `logRunAttempt` 追踪重试次数，`logToolLoopAction` 检测工具循环 |
| PD-04 工具系统 | 协同 | `SessionToolUsage` 统计每个工具的调用次数，`toolCallHistory` 记录工具调用链 |
| PD-09 Human-in-the-Loop | 协同 | Session 状态追踪（idle/processing/waiting）反映人机交互状态 |

---

## 第 6 章 来源文件索引

| 文件 | 行范围 | 关键实现 |
|------|--------|----------|
| `src/agents/usage.ts` | L1-90 | UsageLike 类型定义 + normalizeUsage 归一化函数 |
| `src/agents/usage.ts` | L92-143 | derivePromptTokens + deriveSessionTotalTokens |
| `src/infra/session-cost-usage.types.ts` | L1-168 | 全部类型定义：CostBreakdown, SessionCostSummary, SessionUsageTimeSeries 等 |
| `src/infra/session-cost-usage.ts` | L56-68 | emptyTotals 工厂函数 |
| `src/infra/session-cost-usage.ts` | L80-102 | extractCostBreakdown 成本分解提取 |
| `src/infra/session-cost-usage.ts` | L123-164 | parseTranscriptEntry JSONL 记录解析 |
| `src/infra/session-cost-usage.ts` | L169-184 | computeLatencyStats p95 延迟统计 |
| `src/infra/session-cost-usage.ts` | L186-215 | applyUsageTotals + applyCostBreakdown 聚合函数 |
| `src/infra/session-cost-usage.ts` | L290-379 | loadCostUsageSummary 全局日聚合 |
| `src/infra/session-cost-usage.ts` | L462-738 | loadSessionCostSummary Session 级完整聚合 |
| `src/infra/session-cost-usage.ts` | L740-847 | loadSessionUsageTimeSeries 时间序列+降采样 |
| `src/logging/subsystem.ts` | L14-25 | SubsystemLogger 类型定义 |
| `src/logging/subsystem.ts` | L180-222 | formatConsoleLine 三种输出格式 |
| `src/logging/subsystem.ts` | L263-350 | createSubsystemLogger 工厂函数 |
| `src/logging/logger.ts` | L100-149 | buildLogger tslog 实例构建 + 文件大小上限 |
| `src/logging/logger.ts` | L252-261 | registerLogTransport 外部传输注册 |
| `src/logging/logger.ts` | L270-308 | 日志文件滚动 + 旧日志清理 |
| `src/logging/diagnostic.ts` | L15-21 | webhookStats 全局统计 |
| `src/logging/diagnostic.ts` | L99-124 | logMessageQueued 消息队列追踪 |
| `src/logging/diagnostic.ts` | L169-202 | logSessionStateChange 状态变更追踪 |
| `src/logging/diagnostic.ts` | L259-293 | logToolLoopAction 4 种循环检测器 |
| `src/logging/diagnostic.ts` | L308-376 | startDiagnosticHeartbeat 30s 心跳 + 卡死检测 |
| `src/logging/diagnostic-session-state.ts` | L1-12 | SessionState 类型（含 toolCallHistory） |
| `src/logging/diagnostic-session-state.ts` | L27-64 | pruneDiagnosticSessionStates TTL+LRU 淘汰 |
| `src/logging/levels.ts` | L1-37 | 7 级日志级别定义 + levelToMinLevel 映射 |
| `src/utils/usage-format.ts` | L46-59 | resolveModelCostConfig 模型价格解析 |
| `src/utils/usage-format.ts` | L64-86 | estimateUsageCost 成本估算 |

---

## 第 7 章 横向对比维度

> **重要：** 本章用于自动填充 Butcher Wiki 的横向对比表。

```json comparison_data
{
  "project": "OpenClaw",
  "dimensions": {
    "追踪方式": "JSONL transcript 逐行追加 + 按需扫描聚合",
    "数据粒度": "每次 LLM 调用级，含 4 种 token 类型 + cost breakdown",
    "持久化": "JSONL 文件，崩溃安全，rolling 日志 24h 清理",
    "多提供商": "UsageLike 归一化 10+ 种字段命名到 5 字段标准结构",
    "日志格式": "tslog JSON lines + console pretty/compact/json 三种风格",
    "指标采集": "30s 心跳 + webhook/session/queue 全链路 + 诊断事件",
    "可视化": "时间序列降采样 + 日/模型/工具多维聚合，UI 层渲染",
    "成本追踪": "API cost 优先，回退到 config 价格表估算，记录 missing 计数",
    "日志级别": "7 级（silent/fatal/error/warn/info/debug/trace）",
    "崩溃安全": "JSONL 追加写入 + appendFileSync + 500MB 文件上限",
    "延迟统计": "avg/min/max/p95 + 按日聚合 + 12h 上限过滤",
    "卡死检测": "120s 阈值 + session 状态机 + 工具循环 4 种检测器"
  }
}
```

### 域元数据补充

```json domain_metadata
{
  "description": "运行时诊断：心跳监控、卡死检测、工具循环熔断等 Agent 系统健康度追踪",
  "sub_problems": [
    "运行时健康监控：心跳检测、卡死 session 识别、队列深度追踪",
    "工具循环检测：识别 Agent 陷入重复工具调用的死循环并熔断",
    "Usage 时间序列：累积 token/cost 随时间变化的趋势数据与降采样"
  ],
  "best_practices": [
    "JSONL 追加写入保证崩溃安全：appendFileSync 写到哪算哪，不丢数据",
    "延迟统计设上限阈值（如 12h）：过滤跨 session 的异常值避免 p95 失真",
    "诊断 session 状态用 TTL+LRU 淘汰：防止长期运行的 daemon 内存泄漏",
    "成本估算建立回退链：API 返回值 → 配置价格表 → 记录 missing 计数"
  ]
}
```
