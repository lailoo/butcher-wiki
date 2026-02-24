# PD-04.06 OpenClaw — 多层工具策略管道与插件 Hook 生命周期

> 文档编号：PD-04.06
> 来源：OpenClaw `src/agents/tool-policy-pipeline.ts`, `src/plugins/hooks.ts`, `src/agents/tool-loop-detection.ts`
> GitHub：https://github.com/openclaw/openclaw.git
> 问题域：PD-04 工具系统 Tool System Design
> 状态：可复用方案

---

## 第 1 章 问题与动机

### 1.1 核心问题

Agent 工具系统面临的核心挑战不仅是"如何注册和调用工具"，更是"如何在多租户、多渠道、多层级权限场景下精确控制工具的可用性"。当一个 Agent 平台同时服务于：

- 不同的模型提供商（Anthropic / OpenAI / Google）
- 不同的消息渠道（Telegram / Slack / WhatsApp）
- 不同的用户角色（owner / authorized sender / anonymous）
- 不同的执行环境（host / sandbox / subagent）

工具的可用集合必须根据上下文动态裁剪。传统的"全局 allow/deny 列表"无法满足这种多维度交叉的权限需求。

此外，Agent 在自主执行过程中容易陷入工具调用死循环（反复调用同一工具、两个工具交替调用无进展），这会浪费 token 和计算资源，需要系统级的循环检测与熔断机制。

### 1.2 OpenClaw 的解法概述

OpenClaw 构建了一套**多层工具策略管道 + 插件 Hook 生命周期 + 工具循环检测**的三位一体工具系统：

1. **7 层策略管道**（`tool-policy-pipeline.ts:28-63`）：profile → provider profile → global → agent → group → sandbox → subagent，每层可独立配置 allow/deny，逐层收窄工具集
2. **插件工具工厂**（`plugins/registry.ts:172-197`）：插件通过 `OpenClawPluginToolFactory` 注册工具，支持 optional 标记和名称冲突检测
3. **30+ 种 Hook 生命周期**（`plugins/hooks.ts:125-751`）：覆盖 Agent、Message、Tool、Session、Subagent、Gateway 六大类，支持 void（并行触发）和 modifying（串行合并）两种执行模式
4. **4 种循环检测器**（`tool-loop-detection.ts:9-13`）：generic_repeat / known_poll_no_progress / ping_pong / global_circuit_breaker，三级阈值（warning/critical/circuit_breaker）
5. **工具执行审批**（`infra/exec-approvals.ts:10-13`）：sandbox/gateway/node 三种执行宿主 + deny/allowlist/full 三种安全级别 + off/on-miss/always 三种审批模式

### 1.3 设计思想

| 设计原则 | 具体实现 | 理由 | 替代方案 |
|----------|----------|------|----------|
| 逐层收窄 | 7 层策略管道，每层只能进一步限制工具集 | 防止低优先级配置意外放大权限 | 单一 allow/deny 列表（无法表达多维度） |
| 插件隔离 | WeakMap 追踪插件工具元数据，`group:plugins` 虚拟分组 | 核心工具与插件工具独立管控 | 统一注册表（插件可覆盖核心工具） |
| Hook 双模式 | void hook 并行执行，modifying hook 串行合并 | 观察类 hook 不阻塞，修改类 hook 保证顺序 | 全部串行（性能差）或全部并行（无法合并） |
| 循环熔断 | 滑动窗口 + SHA256 哈希 + 三级阈值 | 精确识别重复模式，避免误判 | 简单计数器（无法区分参数变化） |
| Owner-Only | 敏感工具（whatsapp_login, cron, gateway）仅 owner 可用 | 多租户安全隔离 | 全局 admin 角色（粒度不够） |

---

## 第 2 章 源码实现分析

### 2.1 架构概览

```
┌─────────────────────────────────────────────────────────────────┐
│                    createOpenClawCodingTools()                    │
│                     src/agents/pi-tools.ts:171                   │
├─────────────────────────────────────────────────────────────────┤
│                                                                   │
│  ┌──────────┐   ┌──────────────┐   ┌───────────────────────┐   │
│  │ Core     │ + │ Plugin Tools  │ + │ Channel Agent Tools   │   │
│  │ Tools    │   │ (factory)     │   │ (login, etc.)         │   │
│  └────┬─────┘   └──────┬───────┘   └───────────┬───────────┘   │
│       │                │                         │               │
│       └────────────────┴─────────────────────────┘               │
│                          ↓                                       │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │         applyOwnerOnlyToolPolicy()                       │    │
│  │         src/agents/tool-policy.ts:41                      │    │
│  └──────────────────────┬──────────────────────────────────┘    │
│                          ↓                                       │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │         applyToolPolicyPipeline() — 7 层策略管道          │    │
│  │         src/agents/tool-policy-pipeline.ts:65             │    │
│  │                                                           │    │
│  │  Layer 1: tools.profile (e.g. "coding", "minimal")       │    │
│  │  Layer 2: tools.byProvider.profile                        │    │
│  │  Layer 3: tools.allow (global)                            │    │
│  │  Layer 4: tools.byProvider.allow                          │    │
│  │  Layer 5: agents.{id}.tools.allow                         │    │
│  │  Layer 6: agents.{id}.tools.byProvider.allow              │    │
│  │  Layer 7: group tools.allow                               │    │
│  │  Layer 8: sandbox tools.allow                             │    │
│  │  Layer 9: subagent tools.allow                            │    │
│  └──────────────────────┬──────────────────────────────────┘    │
│                          ↓                                       │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │  normalizeToolParameters() — 提供商适配                    │    │
│  └──────────────────────┬──────────────────────────────────┘    │
│                          ↓                                       │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │  wrapToolWithBeforeToolCallHook() — Hook + 循环检测       │    │
│  │  src/agents/pi-tools.before-tool-call.ts:175              │    │
│  └──────────────────────┬──────────────────────────────────┘    │
│                          ↓                                       │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │  wrapToolWithAbortSignal() — 中止信号                     │    │
│  └──────────────────────┬──────────────────────────────────┘    │
│                          ↓                                       │
│                    最终工具列表 → LLM                             │
└─────────────────────────────────────────────────────────────────┘
```

### 2.2 核心实现

#### 2.2.1 多层策略管道

策略管道的核心是 `applyToolPolicyPipeline()`（`src/agents/tool-policy-pipeline.ts:65-108`），它接收工具列表和策略步骤数组，逐层过滤：

```typescript
// src/agents/tool-policy-pipeline.ts:65-108
export function applyToolPolicyPipeline(params: {
  tools: AnyAgentTool[];
  toolMeta: (tool: AnyAgentTool) => { pluginId: string } | undefined;
  warn: (message: string) => void;
  steps: ToolPolicyPipelineStep[];
}): AnyAgentTool[] {
  const coreToolNames = new Set(
    params.tools
      .filter((tool) => !params.toolMeta(tool))
      .map((tool) => normalizeToolName(tool.name))
      .filter(Boolean),
  );
  const pluginGroups = buildPluginToolGroups({
    tools: params.tools,
    toolMeta: params.toolMeta,
  });

  let filtered = params.tools;
  for (const step of params.steps) {
    if (!step.policy) continue;
    let policy: ToolPolicyLike | undefined = step.policy;
    if (step.stripPluginOnlyAllowlist) {
      const resolved = stripPluginOnlyAllowlist(policy, pluginGroups, coreToolNames);
      if (resolved.unknownAllowlist.length > 0) {
        params.warn(`tools: ${step.label} allowlist contains unknown entries...`);
      }
      policy = resolved.policy;
    }
    const expanded = expandPolicyWithPluginGroups(policy, pluginGroups);
    filtered = expanded ? filterToolsByPolicy(filtered, expanded) : filtered;
  }
  return filtered;
}
```

关键设计：`stripPluginOnlyAllowlist` 防止用户在 allowlist 中只写插件工具名而意外屏蔽所有核心工具。当检测到 allowlist 全是插件工具时，自动忽略该 allowlist，保证核心工具可用。

#### 2.2.2 插件工具注册与元数据追踪

插件通过 `OpenClawPluginToolFactory` 工厂函数注册工具（`src/plugins/registry.ts:172-197`）：

```typescript
// src/plugins/registry.ts:172-197
const registerTool = (
  record: PluginRecord,
  tool: AnyAgentTool | OpenClawPluginToolFactory,
  opts?: { name?: string; names?: string[]; optional?: boolean },
) => {
  const names = opts?.names ?? (opts?.name ? [opts.name] : []);
  const optional = opts?.optional === true;
  const factory: OpenClawPluginToolFactory =
    typeof tool === "function" ? tool : (_ctx) => tool;
  if (typeof tool !== "function") {
    names.push(tool.name);
  }
  registry.tools.push({
    pluginId: record.id, factory, names: normalized,
    optional, source: record.source,
  });
};
```

插件工具通过 WeakMap 追踪元数据（`src/plugins/tools.ts:16-20`），实现插件工具与核心工具的隔离管控：

```typescript
// src/plugins/tools.ts:16-20
const pluginToolMeta = new WeakMap<AnyAgentTool, PluginToolMeta>();
export function getPluginToolMeta(tool: AnyAgentTool): PluginToolMeta | undefined {
  return pluginToolMeta.get(tool);
}
```

#### 2.2.3 Hook 生命周期系统

Hook Runner（`src/plugins/hooks.ts:125-751`）是整个插件生命周期的执行引擎，支持两种执行模式：

**Void Hook（并行触发）**：用于观察类事件，所有 handler 通过 `Promise.all` 并行执行：

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

**Modifying Hook（串行合并）**：用于可修改事件，按优先级顺序串行执行，结果通过 merge 函数合并：

```typescript
// src/plugins/hooks.ts:221-255
async function runModifyingHook<K extends PluginHookName, TResult>(
  hookName: K, event, ctx,
  mergeResults?: (accumulated: TResult | undefined, next: TResult) => TResult,
): Promise<TResult | undefined> {
  const hooks = getHooksForName(registry, hookName);
  let result: TResult | undefined;
  for (const hook of hooks) {
    const handlerResult = await (hook.handler as any)(event, ctx);
    if (handlerResult !== undefined && handlerResult !== null) {
      result = mergeResults && result !== undefined
        ? mergeResults(result, handlerResult) : handlerResult;
    }
  }
  return result;
}
```

Hook 按优先级排序（`src/plugins/hooks.ts:113-120`），高优先级 hook 先执行，在 modifying 模式下高优先级的结果优先保留。

30+ 种 Hook 类型覆盖完整生命周期：

| 类别 | Hook 名称 | 模式 | 用途 |
|------|-----------|------|------|
| Agent | `before_model_resolve` | modifying | 覆盖模型/提供商选择 |
| Agent | `before_prompt_build` | modifying | 注入系统 prompt 和上下文 |
| Agent | `before_agent_start` | modifying | 兼容旧版，合并 model+prompt |
| Agent | `llm_input` / `llm_output` | void | 观察 LLM 输入输出 |
| Agent | `before_compaction` / `after_compaction` | void | 上下文压缩前后 |
| Agent | `before_reset` | void | 会话重置前 |
| Message | `message_received` | void | 消息接收 |
| Message | `message_sending` | modifying | 修改/取消发送消息 |
| Message | `message_sent` | void | 消息发送后 |
| Tool | `before_tool_call` | modifying | 修改参数/阻止调用 |
| Tool | `after_tool_call` | void | 工具调用后 |
| Tool | `tool_result_persist` | sync modifying | 修改持久化的工具结果 |
| Write | `before_message_write` | sync modifying | 阻止/修改消息写入 |
| Session | `session_start` / `session_end` | void | 会话生命周期 |
| Subagent | `subagent_spawning` / `subagent_spawned` / `subagent_ended` | mixed | 子代理生命周期 |
| Gateway | `gateway_start` / `gateway_stop` | void | 网关生命周期 |

<!-- APPEND_PLACEHOLDER_3 -->
