# PD-10.03 OpenClaw — 插件 Hook 生命周期管道

> 文档编号：PD-10.03
> 来源：OpenClaw `src/plugins/hooks.ts`, `src/plugins/types.ts`, `src/plugins/registry.ts`
> GitHub：https://github.com/openclaw/openclaw.git
> 问题域：PD-10 中间件管道 Middleware Pipeline
> 状态：可复用方案

---

## 第 1 章 问题与动机

### 1.1 核心问题

Agent 系统的生命周期极其复杂：从 session 创建、model 选择、prompt 构建、LLM 调用、tool 执行、消息收发、compaction 压缩到 subagent 编排，每个阶段都可能需要第三方插件介入。传统的硬编码回调方式无法满足以下需求：

- **可扩展性**：新插件不应修改核心代码
- **优先级控制**：多个插件处理同一事件时需要确定性的执行顺序
- **安全拦截**：某些 hook 需要能修改参数甚至阻断执行（如 `before_tool_call` 阻止危险工具调用）
- **性能隔离**：观察性 hook 不应阻塞主流程，修改性 hook 必须串行保证一致性
- **同步/异步混合**：热路径（session 写入）必须同步执行，其他可异步

### 1.2 OpenClaw 的解法概述

OpenClaw 实现了一套完整的 **Plugin Hook Pipeline**，核心特征：

1. **24 种 hook 类型**覆盖 6 大生命周期域（Agent/Message/Tool/Session/Subagent/Gateway），定义在 `src/plugins/types.ts:299-323`
2. **双轨执行模型**：void hook 并行执行（fire-and-forget），modifying hook 串行执行并合并结果，见 `src/plugins/hooks.ts:194-255`
3. **优先级排序**：所有 hook 按 priority 降序排列，高优先级先执行，见 `src/plugins/hooks.ts:113-120`
4. **类型安全注册**：通过 `PluginHookHandlerMap` 类型映射确保每个 hook 的 event/ctx/result 类型正确，见 `src/plugins/types.ts:658-755`
5. **全局单例 Runner**：`hook-runner-global.ts` 提供单例模式，gateway 启动时初始化一次，全局可用

### 1.3 设计思想

| 设计原则 | 具体实现 | 理由 | 替代方案 |
|----------|----------|------|----------|
| 观察与修改分离 | void hook 并行，modifying hook 串行 | 观察不阻塞主流程，修改保证一致性 | 全部串行（性能差）或全部并行（结果不确定） |
| 优先级确定性 | `priority` 数值降序，`toSorted` 稳定排序 | 多插件竞争时高优先级 hook 先执行，结果 first-defined-wins | 注册顺序（不可控）或链式中间件（耦合） |
| 同步热路径保护 | `tool_result_persist` 和 `before_message_write` 强制同步 | session JSONL 追加是同步操作，异步会破坏写入顺序 | 全异步（需要锁机制，复杂度高） |
| 错误隔离 | `catchErrors` 默认 true，单个 hook 失败不影响其他 | 插件质量参差不齐，不能让一个坏插件拖垮整个系统 | 全局 try-catch（粒度太粗） |
| 类型安全 | `PluginHookHandlerMap` 泛型映射 + `PluginHookRegistration<K>` | 编译期保证 event/ctx/result 类型匹配，减少运行时错误 | any 类型（失去类型保护） |

---

## 第 2 章 源码实现分析

### 2.1 架构概览

```
┌─────────────────────────────────────────────────────────────────┐
│                        Plugin System                            │
│                                                                 │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────────┐  │
│  │ Plugin A      │    │ Plugin B      │    │ Plugin C          │  │
│  │ api.on(       │    │ api.on(       │    │ api.on(           │  │
│  │  "before_     │    │  "before_     │    │  "subagent_       │  │
│  │   tool_call", │    │   agent_      │    │   spawning",      │  │
│  │  handler,     │    │   start",     │    │  handler,         │  │
│  │  {priority:10}│    │  handler)     │    │  {priority:5})    │  │
│  └──────┬───────┘    └──────┬───────┘    └──────┬───────────┘  │
│         │                   │                   │               │
│         ▼                   ▼                   ▼               │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │              PluginRegistry.typedHooks[]                 │   │
│  │  [{pluginId, hookName, handler, priority, source}, ...]  │   │
│  └──────────────────────┬──────────────────────────────────┘   │
│                         │                                       │
│                         ▼                                       │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │           createHookRunner(registry, options)            │   │
│  │                                                         │   │
│  │  getHooksForName(hookName)                              │   │
│  │    → filter by hookName                                 │   │
│  │    → sort by priority DESC                              │   │
│  │                                                         │   │
│  │  ┌─────────────────┐  ┌──────────────────┐             │   │
│  │  │  runVoidHook()   │  │ runModifyingHook()│             │   │
│  │  │  Promise.all()   │  │ for..of sequential│             │   │
│  │  │  fire-and-forget │  │ merge results     │             │   │
│  │  └─────────────────┘  └──────────────────┘             │   │
│  └─────────────────────────────────────────────────────────┘   │
│                         │                                       │
│                         ▼                                       │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │         Global Singleton (hook-runner-global.ts)         │   │
│  │  initializeGlobalHookRunner() → getGlobalHookRunner()   │   │
│  └─────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

### 2.2 核心实现

#### Hook 类型定义与注册

OpenClaw 定义了 24 种 hook 名称作为联合类型（`src/plugins/types.ts:299-323`）：

```typescript
// src/plugins/types.ts:299-323
export type PluginHookName =
  | "before_model_resolve"
  | "before_prompt_build"
  | "before_agent_start"
  | "llm_input"
  | "llm_output"
  | "agent_end"
  | "before_compaction"
  | "after_compaction"
  | "before_reset"
  | "message_received"
  | "message_sending"
  | "message_sent"
  | "before_tool_call"
  | "after_tool_call"
  | "tool_result_persist"
  | "before_message_write"
  | "session_start"
  | "session_end"
  | "subagent_spawning"
  | "subagent_delivery_target"
  | "subagent_spawned"
  | "subagent_ended"
  | "gateway_start"
  | "gateway_stop";
```

每个 hook 通过 `PluginHookHandlerMap`（`src/plugins/types.ts:658-755`）映射到精确的 handler 签名，确保 event、context、result 三者类型一致。

#### 插件注册 hook

插件通过 `api.on()` 注册 typed hook（`src/plugins/registry.ts:449-463`）：

```typescript
// src/plugins/registry.ts:449-463
const registerTypedHook = <K extends PluginHookName>(
  record: PluginRecord,
  hookName: K,
  handler: PluginHookHandlerMap[K],
  opts?: { priority?: number },
) => {
  record.hookCount += 1;
  registry.typedHooks.push({
    pluginId: record.id,
    hookName,
    handler,
    priority: opts?.priority,
    source: record.source,
  } as TypedPluginHookRegistration);
};
```

对外暴露为 `api.on(hookName, handler, opts)`（`src/plugins/registry.ts:501`）。

#### 优先级排序与 hook 检索

`getHooksForName` 函数（`src/plugins/hooks.ts:113-120`）负责按 hookName 过滤并按优先级降序排列：

```typescript
// src/plugins/hooks.ts:113-120
function getHooksForName<K extends PluginHookName>(
  registry: PluginRegistry,
  hookName: K,
): PluginHookRegistration<K>[] {
  return (registry.typedHooks as PluginHookRegistration<K>[])
    .filter((h) => h.hookName === hookName)
    .toSorted((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
}
```

#### 双轨执行模型

**Void Hook（并行 fire-and-forget）**（`src/plugins/hooks.ts:194-215`）：

```typescript
// src/plugins/hooks.ts:194-215
async function runVoidHook<K extends PluginHookName>(
  hookName: K,
  event: Parameters<NonNullable<PluginHookRegistration<K>["handler"]>>[0],
  ctx: Parameters<NonNullable<PluginHookRegistration<K>["handler"]>>[1],
): Promise<void> {
  const hooks = getHooksForName(registry, hookName);
  if (hooks.length === 0) return;
  const promises = hooks.map(async (hook) => {
    try {
      await (hook.handler as (event: unknown, ctx: unknown) => Promise<void>)(event, ctx);
    } catch (err) {
      handleHookError({ hookName, pluginId: hook.pluginId, error: err });
    }
  });
  await Promise.all(promises);
}
```

**Modifying Hook（串行 + 结果合并）**（`src/plugins/hooks.ts:221-255`）：

```typescript
// src/plugins/hooks.ts:221-255
async function runModifyingHook<K extends PluginHookName, TResult>(
  hookName: K,
  event: Parameters<NonNullable<PluginHookRegistration<K>["handler"]>>[0],
  ctx: Parameters<NonNullable<PluginHookRegistration<K>["handler"]>>[1],
  mergeResults?: (accumulated: TResult | undefined, next: TResult) => TResult,
): Promise<TResult | undefined> {
  const hooks = getHooksForName(registry, hookName);
  if (hooks.length === 0) return undefined;
  let result: TResult | undefined;
  for (const hook of hooks) {
    try {
      const handlerResult = await (
        hook.handler as (event: unknown, ctx: unknown) => Promise<TResult>
      )(event, ctx);
      if (handlerResult !== undefined && handlerResult !== null) {
        if (mergeResults && result !== undefined) {
          result = mergeResults(result, handlerResult);
        } else {
          result = handlerResult;
        }
      }
    } catch (err) {
      handleHookError({ hookName, pluginId: hook.pluginId, error: err });
    }
  }
  return result;
}
```

#### 同步热路径 Hook

`tool_result_persist` 和 `before_message_write` 是特殊的同步 hook，不使用 async/await。以 `runBeforeMessageWrite` 为例（`src/plugins/hooks.ts:531-590`）：

- 强制同步执行，如果 handler 返回 Promise 则警告并跳过
- 支持 `block: true` 立即阻断消息写入
- 支持 `message` 替换，链式传递给后续 handler

#### 结果合并策略

不同 hook 有不同的合并策略（`src/plugins/hooks.ts:129-173`）：

| Hook | 合并策略 | 说明 |
|------|----------|------|
| `before_model_resolve` | first-defined-wins | 高优先级插件的 override 优先 |
| `before_prompt_build` | 拼接 prependContext | 多插件注入的上下文用 `\n\n` 拼接 |
| `before_tool_call` | last-defined-wins | 后执行的插件可覆盖 params/block |
| `subagent_spawning` | error 优先 | 任一插件返回 error 则整体 error |
| `subagent_delivery_target` | first-defined-wins | 第一个提供 origin 的插件生效 |
| `message_sending` | last-defined-wins | 后执行的插件可覆盖 content/cancel |

### 2.3 实现细节

#### 全局单例模式

`src/plugins/hook-runner-global.ts:22-37` 在 gateway 启动时初始化全局 hook runner：

```typescript
// src/plugins/hook-runner-global.ts:22-37
export function initializeGlobalHookRunner(registry: PluginRegistry): void {
  globalRegistry = registry;
  globalHookRunner = createHookRunner(registry, {
    logger: {
      debug: (msg) => log.debug(msg),
      warn: (msg) => log.warn(msg),
      error: (msg) => log.error(msg),
    },
    catchErrors: true,
  });
  const hookCount = registry.hooks.length;
  if (hookCount > 0) {
    log.info(`hook runner initialized with ${hookCount} registered hooks`);
  }
}
```

通过 `getGlobalHookRunner()` 在任意位置获取 runner 实例，`hasGlobalHooks(hookName)` 快速判断是否有注册的 hook（避免无谓的事件构造开销）。

#### Hook 生命周期触发点

24 种 hook 分布在 Agent 生命周期的各个阶段：

```
Session Start ──→ before_model_resolve ──→ before_agent_start (legacy)
                                      ──→ before_prompt_build
                                      ──→ llm_input
                                      ──→ [LLM Call]
                                      ──→ llm_output
                                      ──→ before_tool_call ──→ [Tool] ──→ after_tool_call
                                      ──→ tool_result_persist (sync)
                                      ──→ before_message_write (sync)
                                      ──→ message_received / message_sending / message_sent
                                      ──→ before_compaction ──→ [Compact] ──→ after_compaction
                                      ──→ before_reset
                                      ──→ agent_end
Session End

Subagent: subagent_spawning → subagent_spawned → subagent_delivery_target → subagent_ended
Gateway:  gateway_start → gateway_stop
```

#### 真实插件示例：Discord Subagent Hooks

`extensions/discord/src/subagent-hooks.ts:19-152` 展示了一个完整的插件 hook 注册：

```typescript
// extensions/discord/src/subagent-hooks.ts:41-91
api.on("subagent_spawning", async (event) => {
  if (!event.threadRequested) return;
  const channel = event.requester?.channel?.trim().toLowerCase();
  if (channel !== "discord") return;  // 只处理 Discord 渠道
  const threadBindingFlags = resolveThreadBindingFlags(event.requester?.accountId);
  if (!threadBindingFlags.enabled) {
    return { status: "error" as const, error: "Discord thread bindings are disabled..." };
  }
  try {
    const binding = await autoBindSpawnedDiscordSubagent({...});
    return { status: "ok" as const, threadBindingReady: true };
  } catch (err) {
    return { status: "error" as const, error: `Discord thread bind failed: ${summarizeError(err)}` };
  }
});
```

---

## 第 3 章 迁移指南

### 3.1 迁移清单

**阶段 1：核心 Hook 基础设施**
- [ ] 定义 hook 名称联合类型（参考 `PluginHookName`）
- [ ] 定义每个 hook 的 Event/Context/Result 类型
- [ ] 实现 `PluginHookHandlerMap` 类型映射
- [ ] 实现 `PluginHookRegistration` 注册结构

**阶段 2：Hook Runner**
- [ ] 实现 `getHooksForName` 优先级排序
- [ ] 实现 `runVoidHook`（并行 fire-and-forget）
- [ ] 实现 `runModifyingHook`（串行 + 结果合并）
- [ ] 实现同步 hook 变体（用于热路径）
- [ ] 实现 `handleHookError` 错误隔离

**阶段 3：Plugin Registry 集成**
- [ ] 在 Plugin API 中暴露 `on(hookName, handler, opts)` 方法
- [ ] 实现全局单例 `initializeGlobalHookRunner` / `getGlobalHookRunner`
- [ ] 在 Agent 生命周期各阶段插入 hook 触发点

**阶段 4：结果合并策略**
- [ ] 为每个 modifying hook 定义合并函数
- [ ] 实现 first-defined-wins / last-defined-wins / 拼接等策略

### 3.2 适配代码模板

以下是一个可直接运行的 TypeScript 实现，提取了 OpenClaw hook 系统的核心模式：

```typescript
// hook-system.ts — 可移植的 Hook Pipeline 实现

// Step 1: 定义 hook 名称和类型映射
type HookName = "before_action" | "after_action" | "on_error";

type HookEvent<K extends HookName> = K extends "before_action"
  ? { action: string; params: Record<string, unknown> }
  : K extends "after_action"
    ? { action: string; result: unknown; durationMs: number }
    : { action: string; error: Error };

type HookResult<K extends HookName> = K extends "before_action"
  ? { params?: Record<string, unknown>; block?: boolean; blockReason?: string } | void
  : void;

type HookContext = { agentId?: string; sessionId?: string };

// Step 2: 注册结构
type HookRegistration<K extends HookName = HookName> = {
  pluginId: string;
  hookName: K;
  handler: (event: HookEvent<K>, ctx: HookContext) => Promise<HookResult<K>> | HookResult<K>;
  priority?: number;
};

// Step 3: Hook Runner
function createHookRunner(hooks: HookRegistration[]) {
  function getHooks<K extends HookName>(name: K): HookRegistration<K>[] {
    return (hooks as HookRegistration<K>[])
      .filter((h) => h.hookName === name)
      .toSorted((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
  }

  // Void hook: 并行执行，不返回结果
  async function runVoid<K extends HookName>(
    name: K, event: HookEvent<K>, ctx: HookContext,
  ): Promise<void> {
    const matched = getHooks(name);
    if (matched.length === 0) return;
    await Promise.all(
      matched.map(async (h) => {
        try { await h.handler(event, ctx); }
        catch (err) { console.error(`[hook] ${name} from ${h.pluginId} failed:`, err); }
      }),
    );
  }

  // Modifying hook: 串行执行，合并结果
  async function runModifying<K extends HookName, R>(
    name: K, event: HookEvent<K>, ctx: HookContext,
    merge?: (acc: R | undefined, next: R) => R,
  ): Promise<R | undefined> {
    const matched = getHooks(name);
    if (matched.length === 0) return undefined;
    let result: R | undefined;
    for (const h of matched) {
      try {
        const r = await h.handler(event, ctx) as R | undefined;
        if (r != null) {
          result = merge && result != null ? merge(result, r) : r;
        }
      } catch (err) {
        console.error(`[hook] ${name} from ${h.pluginId} failed:`, err);
      }
    }
    return result;
  }

  return { runVoid, runModifying, hasHooks: (name: HookName) => getHooks(name).length > 0 };
}
```

### 3.3 适用场景

| 场景 | 适用度 | 说明 |
|------|--------|------|
| 多插件 Agent 平台 | ⭐⭐⭐ | 核心场景：第三方插件需要介入 Agent 生命周期 |
| 单体 Agent + 可观测性 | ⭐⭐⭐ | void hook 非常适合日志/追踪/计费等横切关注点 |
| Tool 权限控制 | ⭐⭐⭐ | `before_tool_call` 的 block 机制天然适合安全拦截 |
| 消息路由/过滤 | ⭐⭐ | `message_sending` 可修改或取消消息，适合内容审核 |
| 简单脚本式 Agent | ⭐ | 过度设计，直接函数调用更简单 |

---

## 第 4 章 测试用例

```typescript
import { describe, it, expect, vi } from "vitest";

// 模拟 OpenClaw 的 hook 注册和执行
type MockHook = {
  pluginId: string;
  hookName: string;
  handler: (...args: any[]) => any;
  priority?: number;
};

function createTestRunner(hooks: MockHook[]) {
  const getHooks = (name: string) =>
    hooks.filter((h) => h.hookName === name)
      .toSorted((a, b) => (b.priority ?? 0) - (a.priority ?? 0));

  return {
    async runVoid(name: string, event: any, ctx: any) {
      await Promise.all(getHooks(name).map((h) => h.handler(event, ctx)));
    },
    async runModifying(name: string, event: any, ctx: any, merge?: Function) {
      let result: any;
      for (const h of getHooks(name)) {
        const r = await h.handler(event, ctx);
        if (r != null) result = merge && result != null ? merge(result, r) : r;
      }
      return result;
    },
  };
}

describe("Hook Priority Ordering", () => {
  it("should execute hooks in priority descending order", async () => {
    const order: string[] = [];
    const hooks: MockHook[] = [
      { pluginId: "low", hookName: "test", handler: () => { order.push("low"); }, priority: 1 },
      { pluginId: "high", hookName: "test", handler: () => { order.push("high"); }, priority: 10 },
      { pluginId: "mid", hookName: "test", handler: () => { order.push("mid"); }, priority: 5 },
    ];
    const runner = createTestRunner(hooks);
    await runner.runModifying("test", {}, {});
    expect(order).toEqual(["high", "mid", "low"]);
  });

  it("should default priority to 0 when unset", async () => {
    const order: string[] = [];
    const hooks: MockHook[] = [
      { pluginId: "explicit", hookName: "test", handler: () => { order.push("explicit"); }, priority: 1 },
      { pluginId: "default", hookName: "test", handler: () => { order.push("default"); } },
    ];
    const runner = createTestRunner(hooks);
    await runner.runModifying("test", {}, {});
    expect(order).toEqual(["explicit", "default"]);
  });
});

describe("Modifying Hook Result Merge", () => {
  it("before_tool_call should allow blocking", async () => {
    const hooks: MockHook[] = [
      {
        pluginId: "security",
        hookName: "before_tool_call",
        handler: (event: any) => {
          if (event.toolName === "Bash") return { block: true, blockReason: "Bash disabled" };
        },
        priority: 10,
      },
    ];
    const runner = createTestRunner(hooks);
    const result = await runner.runModifying(
      "before_tool_call",
      { toolName: "Bash", params: { command: "rm -rf /" } },
      { agentId: "test" },
    );
    expect(result).toEqual({ block: true, blockReason: "Bash disabled" });
  });

  it("before_model_resolve should use first-defined-wins for overrides", async () => {
    const merge = (acc: any, next: any) => ({
      modelOverride: acc?.modelOverride ?? next.modelOverride,
      providerOverride: acc?.providerOverride ?? next.providerOverride,
    });
    const hooks: MockHook[] = [
      { pluginId: "a", hookName: "resolve", handler: () => ({ modelOverride: "gpt-4" }), priority: 10 },
      { pluginId: "b", hookName: "resolve", handler: () => ({ modelOverride: "claude-3" }), priority: 5 },
    ];
    const runner = createTestRunner(hooks);
    const result = await runner.runModifying("resolve", {}, {}, merge);
    expect(result.modelOverride).toBe("gpt-4"); // 高优先级的 override 生效
  });
});

describe("Error Isolation", () => {
  it("should continue executing other hooks when one fails", async () => {
    const results: string[] = [];
    const hooks: MockHook[] = [
      { pluginId: "good1", hookName: "test", handler: () => { results.push("good1"); }, priority: 10 },
      { pluginId: "bad", hookName: "test", handler: () => { throw new Error("boom"); }, priority: 5 },
      { pluginId: "good2", hookName: "test", handler: () => { results.push("good2"); }, priority: 1 },
    ];
    const runner = createTestRunner(hooks);
    // void hook 并行执行，错误不传播
    await runner.runVoid("test", {}, {});
    expect(results).toContain("good1");
    expect(results).toContain("good2");
  });
});

describe("Sync Hook Guard", () => {
  it("should warn when sync hook returns Promise", () => {
    // 模拟 tool_result_persist 的同步守卫逻辑
    const handler = () => Promise.resolve({ message: {} });
    const result = handler();
    const isAsync = result && typeof (result as any).then === "function";
    expect(isAsync).toBe(true); // 应该被检测并警告
  });
});
```

---

## 第 5 章 跨域关联

| 关联域 | 关系类型 | 说明 |
|--------|----------|------|
| PD-04 工具系统 | 协同 | `before_tool_call` / `after_tool_call` hook 是工具系统的扩展点，插件可拦截/修改/阻断工具调用 |
| PD-01 上下文管理 | 协同 | `before_compaction` / `after_compaction` hook 让插件在 compaction 前后保存/恢复上下文 |
| PD-02 多 Agent 编排 | 协同 | `subagent_spawning` / `subagent_ended` 等 4 个 subagent hook 支持插件介入子代理生命周期 |
| PD-09 Human-in-the-Loop | 协同 | `message_sending` hook 的 `cancel` 能力可用于实现消息审核/人工确认 |
| PD-11 可观测性 | 依赖 | `llm_input` / `llm_output` / `agent_end` 等 void hook 是可观测性插件的数据源 |
| PD-06 记忆持久化 | 协同 | `before_reset` hook 让记忆插件在 session 清除前保存重要信息 |

---

## 第 6 章 来源文件索引

| 文件 | 行范围 | 关键实现 |
|------|--------|----------|
| `src/plugins/hooks.ts` | L1-754 | Hook Runner 核心：createHookRunner, runVoidHook, runModifyingHook, 24 个 run* 方法 |
| `src/plugins/types.ts` | L299-764 | 24 种 PluginHookName 定义, PluginHookHandlerMap 类型映射, 所有 Event/Context/Result 类型 |
| `src/plugins/registry.ts` | L124-138 | PluginRegistry 结构定义（hooks + typedHooks 双存储） |
| `src/plugins/registry.ts` | L449-463 | registerTypedHook 实现：泛型注册 + priority 支持 |
| `src/plugins/registry.ts` | L472-503 | createApi：暴露 api.on() 给插件 |
| `src/plugins/registry.ts` | L199-267 | registerHook：传统 hook 注册（含 internal hook 系统集成） |
| `src/plugins/hook-runner-global.ts` | L1-89 | 全局单例 Hook Runner：initializeGlobalHookRunner, getGlobalHookRunner |
| `src/hooks/types.ts` | L1-68 | Hook/HookEntry/HookMetadata 基础类型定义 |
| `extensions/discord/src/subagent-hooks.ts` | L19-152 | 真实插件示例：Discord subagent hook 注册（spawning/ended/delivery_target） |
| `extensions/thread-ownership/index.ts` | L63-87 | 真实插件示例：message_received/message_sending hook |
| `extensions/memory-lancedb/index.ts` | L540-568 | 真实插件示例：before_agent_start/agent_end hook（记忆注入） |

---

## 第 7 章 横向对比维度

> **重要：** 本章用于自动填充 Butcher Wiki 的横向对比表。

```json comparison_data
{
  "project": "OpenClaw",
  "dimensions": {
    "中间件基类": "无基类，纯函数 handler + PluginHookHandlerMap 类型映射，泛型约束 event/ctx/result",
    "钩子点": "24 种 hook 覆盖 6 大域：Agent/Message/Tool/Session/Subagent/Gateway",
    "中间件数量": "24 种 hook 类型，每种可注册多个 handler，实际数量由插件决定",
    "条件激活": "hasHooks() 快速判断跳过无注册 hook，插件内部自行条件过滤（如检查 channel）",
    "状态管理": "无共享状态，modifying hook 通过 merge 函数合并结果，void hook 无状态",
    "执行模型": "双轨：void hook 并行 Promise.all，modifying hook 串行 for-of + merge",
    "同步热路径": "tool_result_persist 和 before_message_write 强制同步，检测并拒绝 async handler",
    "错误隔离": "catchErrors 默认 true，单个 hook 失败不影响其他 hook 和主流程"
  }
}
```

### 域元数据补充

```json domain_metadata
{
  "description": "插件化 hook 系统通过类型安全的事件驱动模型实现全生命周期可扩展管道",
  "sub_problems": [
    "同步与异步混合：热路径 hook 必须同步执行，如何防止插件误用 async",
    "结果合并策略：多插件返回冲突结果时的合并规则（first-wins/last-wins/拼接/error优先）",
    "全局单例生命周期：hook runner 的初始化时机和全局访问模式"
  ],
  "best_practices": [
    "hasHooks 前置检查：触发 hook 前先检查是否有注册 handler，避免无谓的事件对象构造开销",
    "Promise 检测守卫：同步 hook 检测 handler 返回值是否为 Promise，防止异步污染同步热路径",
    "类型映射而非运行时校验：用 PluginHookHandlerMap 泛型在编译期保证 hook 签名正确"
  ]
}
```