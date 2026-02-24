# PD-12.06 OpenClaw — 多级 Thinking 控制与推理通道协调

> 文档编号：PD-12.06
> 来源：OpenClaw `src/auto-reply/thinking.ts`, `src/agents/model-selection.ts`, `src/telegram/reasoning-lane-coordinator.ts`
> GitHub：https://github.com/openclaw/openclaw.git
> 问题域：PD-12 推理增强 Reasoning Enhancement
> 状态：可复用方案

---

## 第 1 章 问题与动机

### 1.1 核心问题

LLM 的推理增强（Extended Thinking / Chain-of-Thought）能力在不同模型、不同提供商之间差异巨大。一个支持多模型的 Agent 框架面临三个核心挑战：

1. **推理级别的统一抽象**：Anthropic 的 extended_thinking、OpenAI 的 reasoning_effort、OpenRouter 的 reasoning.effort 各有不同的参数格式和取值范围，需要一个统一的抽象层
2. **推理成本的精细控制**：深度推理消耗大量 token，不同任务需要不同级别的推理深度，一刀切会造成严重浪费
3. **推理过程的用户可见性**：推理内容（thinking blocks）需要在不同渠道（Telegram、Signal、CLI）以不同方式呈现，且需要与最终回答分离

### 1.2 OpenClaw 的解法概述

OpenClaw 设计了一套完整的多级推理控制体系：

1. **6 级 ThinkLevel 枚举**（`src/auto-reply/thinking.ts:1`）：off → minimal → low → medium → high → xhigh，提供从关闭到极致的推理深度梯度
2. **模型目录驱动的自动适配**（`src/agents/model-selection.ts:513-530`）：通过 ModelCatalog 检测模型是否支持 reasoning，自动设置默认推理级别
3. **三层级联默认值**（`src/auto-reply/reply/directive-handling.levels.ts:22-26`）：session → agentConfig → modelCapability 的优先级链
4. **Reasoning Lane Coordinator**（`src/telegram/reasoning-lane-coordinator.ts:62-88`）：Telegram 独立推理消息流，将 thinking 内容与最终回答分离为独立消息
5. **子 Agent 推理降级**（`src/agents/system-prompt.ts:17`）：PromptMode "minimal" 模式，子 Agent 跳过 Skills/Memory 等重型 prompt 段落

### 1.3 设计思想

| 设计原则 | 具体实现 | 理由 | 替代方案 |
|----------|----------|------|----------|
| 统一抽象层 | ThinkLevel 6 级枚举 + 提供商适配器 | 屏蔽 Anthropic/OpenAI/OpenRouter 差异 | 直接透传各提供商参数（耦合度高） |
| 模型感知默认值 | ModelCatalog.reasoning 字段驱动 | 新模型上线自动获得合理默认值 | 硬编码模型列表（维护成本高） |
| 级联覆盖 | session > agentConfig > modelDefault | 用户可随时调整，不影响全局配置 | 单一配置源（灵活性不足） |
| 推理可见性分离 | Reasoning Lane + tag stripping | 用户可选择看/不看推理过程 | 全部展示或全部隐藏（粒度不够） |
| 子 Agent 成本控制 | PromptMode minimal + thinking 传递 | 子 Agent 不需要完整 prompt 开销 | 统一 prompt（浪费 token） |

---

## 第 2 章 源码实现分析

### 2.1 架构概览

```
┌─────────────────────────────────────────────────────────┐
│                    用户输入 / 指令                        │
│  /thinking high  |  /reasoning on  |  /model switch     │
└──────────────┬──────────────────────────────────────────┘
               ▼
┌──────────────────────────────────────────────────────────┐
│          Directive Handling Layer                         │
│  directive-handling.levels.ts                             │
│  ┌─────────────┐  ┌──────────────┐  ┌────────────────┐  │
│  │ session     │→ │ agentConfig  │→ │ modelCatalog   │  │
│  │ thinkLevel  │  │ thinkDefault │  │ .reasoning     │  │
│  └─────────────┘  └──────────────┘  └────────────────┘  │
└──────────────┬──────────────────────────────────────────┘
               ▼
┌──────────────────────────────────────────────────────────┐
│          Model Selection & Adaptation                    │
│  model-selection.ts                                      │
│  ┌──────────────────────────────────────────────────┐    │
│  │ resolveThinkingDefault() → ThinkLevel            │    │
│  │ resolveReasoningDefault() → "on" | "off"         │    │
│  └──────────────────────────────────────────────────┘    │
└──────────────┬──────────────────────────────────────────┘
               ▼
┌──────────────────────────────────────────────────────────┐
│          Provider Adaptation Layer                        │
│  extra-params.ts                                         │
│  ┌────────────┐  ┌─────────────┐  ┌──────────────────┐  │
│  │ Anthropic   │  │ OpenRouter  │  │ Z.AI (binary)   │  │
│  │ thinking    │  │ reasoning   │  │ on/off only     │  │
│  │ level pass  │  │ .effort     │  │                 │  │
│  └────────────┘  └─────────────┘  └──────────────────┘  │
└──────────────┬──────────────────────────────────────────┘
               ▼
┌──────────────────────────────────────────────────────────┐
│          Output Processing                               │
│  ┌─────────────────────┐  ┌────────────────────────────┐ │
│  │ reasoning-tags.ts   │  │ reasoning-lane-coordinator │ │
│  │ strip <think> tags  │  │ Telegram 独立推理消息流     │ │
│  └─────────────────────┘  └────────────────────────────┘ │
└──────────────────────────────────────────────────────────┘
```

### 2.2 核心实现

#### 2.2.1 ThinkLevel 类型系统与归一化

`src/auto-reply/thinking.ts:1-6` 定义了完整的级别类型体系：

```typescript
// src/auto-reply/thinking.ts:1-6
export type ThinkLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
export type ReasoningLevel = "off" | "on" | "stream";
```

`normalizeThinkLevel()`（`src/auto-reply/thinking.ts:42-74`）将用户输入的各种别名归一化为标准枚举值：

```typescript
// src/auto-reply/thinking.ts:42-74
export function normalizeThinkLevel(raw?: string | null): ThinkLevel | undefined {
  if (!raw) return undefined;
  const key = raw.trim().toLowerCase();
  const collapsed = key.replace(/[\s_-]+/g, "");
  if (collapsed === "xhigh" || collapsed === "extrahigh") return "xhigh";
  if (["off"].includes(key)) return "off";
  if (["on", "enable", "enabled"].includes(key)) return "low";
  if (["min", "minimal"].includes(key)) return "minimal";
  if (["low", "thinkhard", "think-hard"].includes(key)) return "low";
  if (["mid", "med", "medium", "thinkharder"].includes(key)) return "medium";
  if (["high", "ultra", "ultrathink", "max"].includes(key)) return "high";
  if (["think"].includes(key)) return "minimal";
  return undefined;
}
```

关键设计：`"on"` 映射到 `"low"` 而非 `"high"`，体现了成本优先的默认策略。

#### 2.2.2 模型感知的推理默认值

`src/agents/model-selection.ts:513-530` 通过 ModelCatalog 自动检测模型能力：

```typescript
// src/agents/model-selection.ts:513-530
export function resolveThinkingDefault(params: {
  cfg: OpenClawConfig;
  provider: string;
  model: string;
  catalog?: ModelCatalogEntry[];
}): ThinkLevel {
  const configured = params.cfg.agents?.defaults?.thinkingDefault;
  if (configured) return configured;
  const candidate = params.catalog?.find(
    (entry) => entry.provider === params.provider && entry.id === params.model,
  );
  if (candidate?.reasoning) return "low";
  return "off";
}
```

逻辑链：用户配置 > 模型目录能力检测 > 默认关闭。支持 reasoning 的模型自动获得 `"low"` 级别。

#### 2.2.3 三层级联默认值解析

`src/auto-reply/reply/directive-handling.levels.ts:2-41` 实现了 session → agentConfig → modelCapability 的级联：

```typescript
// src/auto-reply/reply/directive-handling.levels.ts:22-26
const resolvedDefaultThinkLevel =
  (params.sessionEntry?.thinkingLevel as ThinkLevel | undefined) ??
  (params.agentCfg?.thinkingDefault as ThinkLevel | undefined) ??
  (await params.resolveDefaultThinkingLevel());
```

#### 2.2.4 提供商适配层

`src/agents/pi-embedded-runner/extra-params.ts:362-422` 将统一的 ThinkLevel 转换为 OpenRouter 的 `reasoning.effort` 格式：

```typescript
// src/agents/pi-embedded-runner/extra-params.ts:362-369
function mapThinkingLevelToOpenRouterReasoningEffort(
  thinkingLevel: ThinkLevel,
): "none" | "minimal" | "low" | "medium" | "high" | "xhigh" {
  if (thinkingLevel === "off") return "none";
  return thinkingLevel;
}
```

对于 Z.AI 等只支持二值推理的提供商（`src/auto-reply/thinking.ts:20-22`）：

```typescript
// src/auto-reply/thinking.ts:20-22
export function isBinaryThinkingProvider(provider?: string | null): boolean {
  return normalizeProviderId(provider) === "zai";
}
```

UI 层自动降级为 `["off", "on"]` 两个选项（`src/auto-reply/thinking.ts:97-102`）。

#### 2.2.5 xhigh 模型白名单

`src/auto-reply/thinking.ts:24-32` 维护了支持 xhigh 级别的模型白名单：

```typescript
// src/auto-reply/thinking.ts:24-32
export const XHIGH_MODEL_REFS = [
  "openai/gpt-5.2",
  "openai-codex/gpt-5.3-codex",
  "openai-codex/gpt-5.3-codex-spark",
  // ... more models
] as const;
```

`supportsXHighThinking()` 检查当前模型是否在白名单中，`listThinkingLevels()` 据此动态返回可用级别列表。

### 2.3 实现细节

#### 2.3.1 Telegram Reasoning Lane Coordinator

`src/telegram/reasoning-lane-coordinator.ts` 实现了推理内容与最终回答的分离投递。核心是 `splitTelegramReasoningText()`（L62-88）：

```typescript
// src/telegram/reasoning-lane-coordinator.ts:62-88
export function splitTelegramReasoningText(text?: string): TelegramReasoningSplit {
  if (typeof text !== "string") return {};
  const trimmed = text.trim();
  if (isPartialReasoningTagPrefix(trimmed)) return {};
  if (trimmed.startsWith(REASONING_MESSAGE_PREFIX) && trimmed.length > REASONING_MESSAGE_PREFIX.length) {
    return { reasoningText: trimmed };
  }
  const taggedReasoning = extractThinkingFromTaggedStreamOutsideCode(text);
  const strippedAnswer = stripReasoningTagsFromText(text, { mode: "strict", trim: "both" });
  if (!taggedReasoning && strippedAnswer === text) return { answerText: text };
  const reasoningText = taggedReasoning ? formatReasoningMessage(taggedReasoning) : undefined;
  const answerText = strippedAnswer || undefined;
  return { reasoningText, answerText };
}
```

状态机 `createTelegramReasoningStepState()`（L95-136）管理推理消息的投递时序：
- `"none"` → `"hinted"`：检测到推理内容，缓冲最终回答
- `"hinted"` → `"delivered"`：推理消息已发送，释放缓冲的最终回答
- 每个 step 结束时 `resetForNextStep()` 重置状态

#### 2.3.2 Reasoning Tag 智能剥离

`src/shared/text/reasoning-tags.ts:19-92` 实现了代码块感知的 tag 剥离：

```typescript
// src/shared/text/reasoning-tags.ts:5-7
const QUICK_TAG_RE = /<\s*\/?\s*(?:think(?:ing)?|thought|antthinking|final)\b/i;
const FINAL_TAG_RE = /<\s*\/?\s*final\b[^<>]*>/gi;
const THINKING_TAG_RE = /<\s*(\/?)\s*(?:think(?:ing)?|thought|antthinking)\b[^<>]*>/gi;
```

关键特性：
- 支持 `<think>`, `<thinking>`, `<thought>`, `<antthinking>` 四种标签变体
- 通过 `findCodeRegions()` + `isInsideCode()` 跳过代码块内的标签（避免误剥离）
- `mode: "strict"` 模式下，未闭合的 thinking 标签会丢弃后续所有内容
- `mode: "preserve"` 模式下保留未闭合标签后的内容

#### 2.3.3 子 Agent 的 Prompt 降级

`src/agents/system-prompt.ts:13-17` 定义了三级 PromptMode：

```typescript
// src/agents/system-prompt.ts:13-17
export type PromptMode = "full" | "minimal" | "none";
```

`buildAgentSystemPrompt()` 中，`isMinimal` 模式跳过以下段落（`src/agents/system-prompt.ts:375`）：
- Skills section（`buildSkillsSection` L25: `if (params.isMinimal) return []`）
- Memory Recall section（`buildMemorySection` L49: `if (params.isMinimal) return []`）
- Reply Tags、Messaging、Voice、Docs sections
- Silent Replies 和 Heartbeats sections

子 Agent 通过 `src/agents/pi-embedded-runner/run/attempt.ts:497-500` 自动获得 minimal 模式：

```typescript
// src/agents/pi-embedded-runner/run/attempt.ts:497-500
const promptMode =
  isSubagentSessionKey(params.sessionKey) || isCronSessionKey(params.sessionKey)
    ? "minimal"
    : "full";
```

#### 2.3.4 Thinking Block 降级处理

`src/agents/pi-embedded-helpers/thinking.ts:22-45` 实现了 thinking level 的错误降级：

```typescript
// src/agents/pi-embedded-helpers/thinking.ts:22-45
export function pickFallbackThinkingLevel(params: {
  message?: string;
  attempted: Set<ThinkLevel>;
}): ThinkLevel | undefined {
  const supported = extractSupportedValues(params.message ?? "");
  for (const entry of supported) {
    const normalized = normalizeThinkLevel(entry);
    if (normalized && !params.attempted.has(normalized)) return normalized;
  }
  return undefined;
}
```

当 API 返回 "supported values are: low, medium, high" 错误时，自动从错误消息中解析支持的级别并降级重试。

#### 2.3.5 子 Agent Thinking 传递

`src/agents/subagent-spawn.ts:269-286` 处理子 Agent 的 thinking 级别继承：

```typescript
// src/agents/subagent-spawn.ts:269-286
const resolvedThinkingDefaultRaw =
  readStringParam(targetAgentConfig?.subagents ?? {}, "thinking") ??
  readStringParam(cfg.agents?.defaults?.subagents ?? {}, "thinking");

let thinkingOverride: string | undefined;
const thinkingCandidateRaw = thinkingOverrideRaw || resolvedThinkingDefaultRaw;
if (thinkingCandidateRaw) {
  const normalized = normalizeThinkLevel(thinkingCandidateRaw);
  if (!normalized) {
    return { status: "error", error: `Invalid thinking level "${thinkingCandidateRaw}"` };
  }
  thinkingOverride = normalized;
}
```

优先级：spawn 参数 > agent 子 Agent 配置 > 全局子 Agent 默认值。

---

## 第 3 章 迁移指南

### 3.1 迁移清单

**阶段 1：基础类型系统**
- [ ] 定义 ThinkLevel 枚举类型（6 级）
- [ ] 实现 normalizeThinkLevel() 归一化函数
- [ ] 实现 ReasoningLevel 类型（off/on/stream）

**阶段 2：模型适配层**
- [ ] 建立 ModelCatalog 数据结构（含 reasoning 字段）
- [ ] 实现 resolveThinkingDefault() 模型感知默认值
- [ ] 实现提供商适配器（Anthropic/OpenRouter/OpenAI）

**阶段 3：级联配置**
- [ ] 实现 session → agentConfig → modelDefault 级联
- [ ] 添加用户指令解析（/thinking, /reasoning）

**阶段 4：输出处理**
- [ ] 实现 reasoning tag 剥离（代码块感知）
- [ ] 实现推理内容与回答的分离投递（可选）

### 3.2 适配代码模板

```typescript
// thinking-levels.ts — 可直接复用的推理级别管理模块

export type ThinkLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
export type ReasoningLevel = "off" | "on" | "stream";

// 归一化用户输入
export function normalizeThinkLevel(raw?: string | null): ThinkLevel | undefined {
  if (!raw) return undefined;
  const key = raw.trim().toLowerCase().replace(/[\s_-]+/g, "");
  const map: Record<string, ThinkLevel> = {
    off: "off", minimal: "minimal", min: "minimal", think: "minimal",
    low: "low", on: "low", enable: "low", enabled: "low",
    medium: "medium", med: "medium", mid: "medium",
    high: "high", ultra: "high", max: "high",
    xhigh: "xhigh", extrahigh: "xhigh",
  };
  return map[key];
}

// 模型感知默认值
export function resolveThinkingDefault(params: {
  configDefault?: ThinkLevel;
  modelSupportsReasoning: boolean;
}): ThinkLevel {
  if (params.configDefault) return params.configDefault;
  return params.modelSupportsReasoning ? "low" : "off";
}

// 级联解析
export function resolveEffectiveThinkLevel(params: {
  sessionLevel?: ThinkLevel;
  agentDefault?: ThinkLevel;
  modelDefault: ThinkLevel;
}): ThinkLevel {
  return params.sessionLevel ?? params.agentDefault ?? params.modelDefault;
}

// 提供商适配
export function adaptForProvider(level: ThinkLevel, provider: string): Record<string, unknown> {
  if (provider === "anthropic") {
    // Anthropic: 通过 thinkingLevel 参数传递
    return { thinkingLevel: level };
  }
  if (provider === "openrouter") {
    // OpenRouter: reasoning.effort 格式
    return { reasoning: { effort: level === "off" ? "none" : level } };
  }
  if (provider === "openai") {
    // OpenAI: reasoning_effort 参数
    return { reasoning_effort: level === "off" ? "none" : level };
  }
  return {};
}
```

### 3.3 适用场景

| 场景 | 适用度 | 说明 |
|------|--------|------|
| 多模型 Agent 框架 | ⭐⭐⭐ | 核心场景：统一不同提供商的推理控制 |
| 聊天机器人（多渠道） | ⭐⭐⭐ | Reasoning Lane 适合 Telegram/Discord 等渠道 |
| 子 Agent 编排系统 | ⭐⭐⭐ | Prompt 降级 + thinking 传递减少子 Agent 开销 |
| 单模型应用 | ⭐⭐ | 级联配置仍有价值，但提供商适配层可简化 |
| 批处理/离线任务 | ⭐ | 推理可见性分离价值不大 |

---

## 第 4 章 测试用例

```typescript
import { describe, it, expect } from "vitest";
import {
  normalizeThinkLevel,
  resolveThinkingDefault,
  resolveEffectiveThinkLevel,
  adaptForProvider,
  type ThinkLevel,
} from "./thinking-levels";

describe("normalizeThinkLevel", () => {
  it("should normalize standard levels", () => {
    expect(normalizeThinkLevel("off")).toBe("off");
    expect(normalizeThinkLevel("minimal")).toBe("minimal");
    expect(normalizeThinkLevel("low")).toBe("low");
    expect(normalizeThinkLevel("medium")).toBe("medium");
    expect(normalizeThinkLevel("high")).toBe("high");
    expect(normalizeThinkLevel("xhigh")).toBe("xhigh");
  });

  it("should normalize aliases", () => {
    expect(normalizeThinkLevel("on")).toBe("low");
    expect(normalizeThinkLevel("enable")).toBe("low");
    expect(normalizeThinkLevel("think")).toBe("minimal");
    expect(normalizeThinkLevel("ultra")).toBe("high");
    expect(normalizeThinkLevel("max")).toBe("high");
    expect(normalizeThinkLevel("extrahigh")).toBe("xhigh");
  });

  it("should handle case insensitivity and whitespace", () => {
    expect(normalizeThinkLevel("  HIGH  ")).toBe("high");
    expect(normalizeThinkLevel("MEDIUM")).toBe("medium");
    expect(normalizeThinkLevel("x-high")).toBe("xhigh");
  });

  it("should return undefined for invalid input", () => {
    expect(normalizeThinkLevel(null)).toBeUndefined();
    expect(normalizeThinkLevel("")).toBeUndefined();
    expect(normalizeThinkLevel("invalid")).toBeUndefined();
  });
});

describe("resolveThinkingDefault", () => {
  it("should prefer config default", () => {
    expect(resolveThinkingDefault({
      configDefault: "high",
      modelSupportsReasoning: false,
    })).toBe("high");
  });

  it("should use low for reasoning-capable models", () => {
    expect(resolveThinkingDefault({
      modelSupportsReasoning: true,
    })).toBe("low");
  });

  it("should default to off", () => {
    expect(resolveThinkingDefault({
      modelSupportsReasoning: false,
    })).toBe("off");
  });
});

describe("resolveEffectiveThinkLevel", () => {
  it("should cascade: session > agent > model", () => {
    expect(resolveEffectiveThinkLevel({
      sessionLevel: "high",
      agentDefault: "low",
      modelDefault: "off",
    })).toBe("high");

    expect(resolveEffectiveThinkLevel({
      agentDefault: "medium",
      modelDefault: "off",
    })).toBe("medium");

    expect(resolveEffectiveThinkLevel({
      modelDefault: "low",
    })).toBe("low");
  });
});

describe("adaptForProvider", () => {
  it("should adapt for OpenRouter", () => {
    expect(adaptForProvider("high", "openrouter")).toEqual({
      reasoning: { effort: "high" },
    });
    expect(adaptForProvider("off", "openrouter")).toEqual({
      reasoning: { effort: "none" },
    });
  });

  it("should adapt for Anthropic", () => {
    expect(adaptForProvider("medium", "anthropic")).toEqual({
      thinkingLevel: "medium",
    });
  });
});
```

---

## 第 5 章 跨域关联

| 关联域 | 关系类型 | 说明 |
|--------|----------|------|
| PD-01 上下文管理 | 协同 | thinking blocks 占用上下文窗口，高推理级别需要更积极的上下文压缩策略 |
| PD-02 多 Agent 编排 | 协同 | 子 Agent 的 thinking 级别传递和 PromptMode 降级直接影响编排成本 |
| PD-03 容错与重试 | 依赖 | `pickFallbackThinkingLevel()` 从 API 错误消息中解析支持级别并降级重试 |
| PD-04 工具系统 | 协同 | thinking blocks 需要在 tool call 流中正确处理（dropThinkingBlocks） |
| PD-11 可观测性 | 协同 | ReasoningLevel "stream" 模式将推理过程实时暴露给用户，是可观测性的一部分 |

---

## 第 6 章 来源文件索引

| 文件 | 行范围 | 关键实现 |
|------|--------|----------|
| `src/auto-reply/thinking.ts` | L1-228 | ThinkLevel/ReasoningLevel 类型定义、归一化函数、xhigh 白名单 |
| `src/agents/model-selection.ts` | L513-545 | resolveThinkingDefault/resolveReasoningDefault 模型感知默认值 |
| `src/auto-reply/reply/directive-handling.levels.ts` | L1-41 | 三层级联默认值解析 |
| `src/agents/pi-embedded-runner/extra-params.ts` | L362-422 | OpenRouter reasoning.effort 适配 |
| `src/telegram/reasoning-lane-coordinator.ts` | L1-137 | Telegram 推理消息分离与状态机 |
| `src/shared/text/reasoning-tags.ts` | L1-93 | 代码块感知的 reasoning tag 剥离 |
| `src/agents/system-prompt.ts` | L13-17, L196-656 | PromptMode 三级模式、系统 prompt 构建 |
| `src/agents/pi-embedded-helpers/thinking.ts` | L22-45 | thinking level 错误降级 |
| `src/agents/subagent-spawn.ts` | L25-36, L269-286 | 子 Agent thinking 参数传递 |
| `src/agents/pi-embedded-runner/run/attempt.ts` | L497-500, L673 | 子 Agent minimal 模式、thinkingLevel 映射 |
| `src/agents/pi-embedded-runner/utils.ts` | L4-10 | ThinkLevel → pi-agent-core ThinkingLevel 映射 |
| `src/auto-reply/reply/model-selection.ts` | L382-414 | 异步 thinking/reasoning 默认值解析 |

---

## 第 7 章 横向对比维度

> **重要：** 本章用于自动填充 Butcher Wiki 的横向对比表。

```json comparison_data
{
  "project": "OpenClaw",
  "dimensions": {
    "推理方式": "6 级 ThinkLevel 枚举 + 3 级 ReasoningLevel，统一抽象多提供商差异",
    "模型策略": "ModelCatalog 驱动自动检测，reasoning 模型默认 low 级别",
    "成本控制": "子 Agent PromptMode minimal 跳过重型段落，thinking 级别可逐 session 调整",
    "适用场景": "多模型多渠道 Agent 框架，Telegram/Signal/CLI 多端推理可见性",
    "推理模式": "off/minimal/low/medium/high/xhigh 六级 + binary 提供商自动降级",
    "输出结构": "Reasoning Lane 分离推理与回答为独立消息流",
    "增强策略": "级联覆盖(session>agent>model) + 错误降级自动重试",
    "思考预算": "xhigh 白名单限制高成本模型，binary 提供商自动降为 on/off",
    "推理可见性": "ReasoningLevel stream 模式实时暴露推理过程"
  }
}
```

### 域元数据补充

```json domain_metadata
{
  "description": "多提供商推理级别统一抽象与渠道感知的推理内容投递",
  "sub_problems": [
    "推理级别归一化：将不同提供商的推理参数映射到统一枚举",
    "推理可见性控制：按渠道和用户偏好决定推理过程的展示方式",
    "子Agent推理降级：编排场景下子Agent的prompt和thinking级别优化"
  ],
  "best_practices": [
    "on 映射到 low 而非 high：推理增强的默认值应偏保守，避免意外高成本",
    "代码块感知的 tag 剥离：剥离 thinking 标签时必须跳过代码块内的同名标签",
    "错误驱动的级别降级：从 API 错误消息中解析支持级别并自动重试"
  ]
}
```
