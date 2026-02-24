# PD-39.01 OpenClaw — 四模式配置热重载引擎

> 文档编号：PD-39.01
> 来源：OpenClaw `src/gateway/config-reload.ts`
> GitHub：https://github.com/openclaw/openclaw
> 问题域：PD-39 配置热重载 Config Hot Reload
> 状态：可复用方案

---

## 第 1 章 问题与动机

### 1.1 核心问题

长时间运行的 Agent Gateway 进程在生产环境中需要频繁调整配置——修改渠道 token、调整 cron 频率、切换 hook 行为等。传统做法是改完配置后手动重启进程，但这会导致：

- **服务中断**：重启期间所有正在处理的消息、嵌入式运行、待回复队列全部丢失
- **操作负担**：运维人员需要 SSH 登录、编辑文件、手动 kill/restart
- **粒度粗糙**：只改了一个 hook 配置却要重启整个 Gateway，影响所有渠道

OpenClaw 的核心洞察是：**绝大多数配置变更不需要重启进程**。只有涉及网络绑定（端口、TLS）、插件系统等底层基础设施的变更才真正需要重启。其余变更（hook、cron、渠道、浏览器控制等）都可以在进程内热替换。

### 1.2 OpenClaw 的解法概述

1. **四模式策略**：`hybrid`（默认）/ `hot` / `restart` / `off`，用户按需选择重载激进程度（`src/config/types.gateway.ts:165-172`）
2. **ReloadRule 前缀匹配引擎**：每条配置路径通过前缀匹配找到对应的 reload rule，决定 hot/restart/none 三种处置（`src/gateway/config-reload.ts:50-90`）
3. **插件贡献 reload 规则**：渠道插件通过 `reload.configPrefixes` 和 `reload.noopPrefixes` 声明自己关心的配置路径，实现渠道级精细重启（`src/channels/plugins/types.plugin.ts:58`）
4. **GatewayReloadPlan 决策树**：将所有变更路径汇总为一个结构化的重载计划，精确到每个子系统是否需要重启（`src/gateway/config-reload.ts:179-248`）
5. **优雅重启延迟**：当必须重启时，等待所有活跃操作（队列任务、待回复、嵌入式运行）完成后再发 SIGUSR1（`src/gateway/server-reload-handlers.ts:138-221`）

### 1.3 设计思想

| 设计原则 | 具体实现 | 理由 | 替代方案 |
|----------|----------|------|----------|
| 最小影响范围 | hybrid 模式：能 hot 就 hot，必须 restart 才 restart | 避免不必要的服务中断 | 全量 restart（简单但粗暴） |
| 声明式规则 | ReloadRule 前缀匹配表，插件可扩展 | 新增配置字段只需加一行规则 | if-else 硬编码（不可扩展） |
| 插件自治 | 渠道插件自己声明 configPrefixes | 插件最了解自己需要哪些配置 | 中心化维护所有插件的配置映射 |
| 安全降级 | 未匹配的路径默认触发 restart | 宁可多重启也不漏掉关键变更 | 默认 no-op（可能导致配置不生效） |
| 优雅中断 | deferGatewayRestartUntilIdle 等待活跃任务完成 | 避免丢失正在处理的消息 | 立即 kill（丢消息） |

---

## 第 2 章 源码实现分析

### 2.1 架构概览

```
┌─────────────────────────────────────────────────────────────┐
│                    Gateway Server                            │
│                                                              │
│  ┌──────────────┐    ┌──────────────────┐                   │
│  │  chokidar    │───→│ startGateway     │                   │
│  │  FSWatcher   │    │ ConfigReloader   │                   │
│  │              │    │                  │                   │
│  │ add/change/  │    │ ┌──────────────┐ │                   │
│  │ unlink events│    │ │ debounce     │ │                   │
│  └──────────────┘    │ │ (300ms)      │ │                   │
│                      │ └──────┬───────┘ │                   │
│                      │        ↓         │                   │
│                      │ ┌──────────────┐ │                   │
│  ┌───────────────┐   │ │ readSnapshot │ │                   │
│  │ Config File   │──→│ │ + validate   │ │                   │
│  │ openclaw.json │   │ └──────┬───────┘ │                   │
│  └───────────────┘   │        ↓         │                   │
│                      │ ┌──────────────┐ │                   │
│                      │ │ diffConfig   │ │                   │
│                      │ │ Paths()      │ │                   │
│                      │ └──────┬───────┘ │                   │
│                      │        ↓         │                   │
│                      │ ┌──────────────┐ │  ┌─────────────┐  │
│                      │ │ buildGateway │ │  │ ReloadRule[] │  │
│                      │ │ ReloadPlan() │←┼──│ (base+plugin │  │
│                      │ └──────┬───────┘ │  │  +tail)      │  │
│                      └────────┼─────────┘  └─────────────┘  │
│                               ↓                              │
│                    ┌─────────────────────┐                   │
│                    │  mode switch        │                   │
│                    │                     │                   │
│          ┌─────────┼─────────┐           │                   │
│          ↓         ↓         ↓           │                   │
│     ┌────────┐ ┌────────┐ ┌──────────┐  │                   │
│     │  hot   │ │restart │ │  hybrid   │  │                   │
│     │ apply  │ │gateway │ │ hot+defer │  │                   │
│     └────┬───┘ └────┬───┘ └────┬─────┘  │                   │
│          ↓          ↓          ↓         │                   │
│  ┌──────────────────────────────────┐    │                   │
│  │  applyHotReload()               │    │                   │
│  │  ├─ reloadHooks                 │    │                   │
│  │  ├─ restartHeartbeat            │    │                   │
│  │  ├─ restartCron                 │    │                   │
│  │  ├─ restartBrowserControl       │    │                   │
│  │  ├─ restartGmailWatcher         │    │                   │
│  │  └─ restartChannels (per-id)    │    │                   │
│  └──────────────────────────────────┘    │                   │
│                                          │                   │
│  ┌──────────────────────────────────┐    │                   │
│  │  requestGatewayRestart()         │    │                   │
│  │  ├─ check active operations      │    │                   │
│  │  ├─ deferUntilIdle (poll loop)   │    │                   │
│  │  └─ emit SIGUSR1                 │    │                   │
│  └──────────────────────────────────┘    │                   │
└──────────────────────────────────────────────────────────────┘
```

### 2.2 核心实现

#### 2.2.1 配置差异检测 — `diffConfigPaths()`

递归对比新旧配置对象，输出变更路径的点分字符串列表（`src/gateway/config-reload.ts:134-163`）：

```typescript
// src/gateway/config-reload.ts:134-163
export function diffConfigPaths(prev: unknown, next: unknown, prefix = ""): string[] {
  if (prev === next) {
    return [];
  }
  if (isPlainObject(prev) && isPlainObject(next)) {
    const keys = new Set([...Object.keys(prev), ...Object.keys(next)]);
    const paths: string[] = [];
    for (const key of keys) {
      const childPrefix = prefix ? `${prefix}.${key}` : key;
      const childPaths = diffConfigPaths(prev[key], next[key], childPrefix);
      if (childPaths.length > 0) {
        paths.push(...childPaths);
      }
    }
    return paths;
  }
  // 数组使用 isDeepStrictEqual 结构化比较，避免误报
  if (Array.isArray(prev) && Array.isArray(next)) {
    if (isDeepStrictEqual(prev, next)) {
      return [];
    }
  }
  return [prefix || "<root>"];
}
```

关键设计：对象递归展开到叶子节点，数组用 `isDeepStrictEqual` 整体比较。这样 `hooks.gmail.account` 变更不会误触发 `hooks` 整体重载。

#### 2.2.2 ReloadRule 前缀匹配引擎

三层规则表：BASE → Channel Plugin → TAIL（`src/gateway/config-reload.ts:50-123`）：

```typescript
// src/gateway/config-reload.ts:50-67 (BASE_RELOAD_RULES)
const BASE_RELOAD_RULES: ReloadRule[] = [
  { prefix: "gateway.remote", kind: "none" },
  { prefix: "gateway.reload", kind: "none" },
  { prefix: "hooks.gmail", kind: "hot", actions: ["restart-gmail-watcher"] },
  { prefix: "hooks", kind: "hot", actions: ["reload-hooks"] },
  { prefix: "agents.defaults.heartbeat", kind: "hot", actions: ["restart-heartbeat"] },
  { prefix: "agent.heartbeat", kind: "hot", actions: ["restart-heartbeat"] },
  { prefix: "cron", kind: "hot", actions: ["restart-cron"] },
  { prefix: "browser", kind: "hot", actions: ["restart-browser-control"] },
];

// src/gateway/config-reload.ts:69-90 (BASE_RELOAD_RULES_TAIL)
const BASE_RELOAD_RULES_TAIL: ReloadRule[] = [
  { prefix: "meta", kind: "none" },
  { prefix: "identity", kind: "none" },
  // ... 动态读取的字段标记为 none
  { prefix: "plugins", kind: "restart" },
  { prefix: "gateway", kind: "restart" },
  { prefix: "discovery", kind: "restart" },
];
```

插件贡献规则的关键机制（`src/gateway/config-reload.ts:95-123`）：

```typescript
// src/gateway/config-reload.ts:105-119
function listReloadRules(): ReloadRule[] {
  const registry = getActivePluginRegistry();
  // 插件注册表变更时清除缓存
  if (registry !== cachedRegistry) {
    cachedReloadRules = null;
    cachedRegistry = registry;
  }
  const channelReloadRules: ReloadRule[] = listChannelPlugins().flatMap((plugin) => [
    ...(plugin.reload?.configPrefixes ?? []).map(
      (prefix): ReloadRule => ({
        prefix,
        kind: "hot",
        actions: [`restart-channel:${plugin.id}` as ReloadAction],
      }),
    ),
    ...(plugin.reload?.noopPrefixes ?? []).map(
      (prefix): ReloadRule => ({ prefix, kind: "none" }),
    ),
  ]);
  // 三层拼接：BASE → Channel → TAIL
  return [...BASE_RELOAD_RULES, ...channelReloadRules, ...BASE_RELOAD_RULES_TAIL];
}
```

匹配逻辑是简单的前缀匹配（`src/gateway/config-reload.ts:125-132`）：路径等于前缀或以 `prefix.` 开头即命中。规则按数组顺序匹配，第一个命中的生效——这意味着 BASE 规则优先于 TAIL 规则，插件规则夹在中间。

#### 2.2.3 GatewayReloadPlan 构建

`buildGatewayReloadPlan()` 遍历所有变更路径，汇总为一个结构化计划（`src/gateway/config-reload.ts:179-248`）：

- `kind: "restart"` → 标记 `restartGateway = true`
- `kind: "hot"` → 执行对应 actions（reload-hooks / restart-cron / restart-channel:telegram 等）
- `kind: "none"` → 加入 `noopPaths`（动态读取的字段，无需任何操作）
- 未匹配任何规则 → 默认 `restartGateway = true`（安全降级）

### 2.3 实现细节

#### 文件监听与防抖

`startGatewayConfigReloader()` 使用 chokidar 监听配置文件（`src/gateway/config-reload.ts:390-407`）：

```typescript
// src/gateway/config-reload.ts:390-394
const watcher = chokidar.watch(opts.watchPath, {
  ignoreInitial: true,
  awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
  usePolling: Boolean(process.env.VITEST),  // 测试环境用轮询
});
```

`awaitWriteFinish` 确保文件写入完成后才触发事件（200ms 稳定阈值），加上应用层 300ms debounce，总延迟约 500ms。

#### 缺失配置重试

配置文件可能在编辑器保存时短暂消失（先删后写）。重载器最多重试 2 次，每次间隔 150ms（`src/gateway/config-reload.ts:297-312`）。

#### 优雅重启延迟

当 `restartGateway = true` 时，不立即发 SIGUSR1，而是轮询等待活跃任务完成（`src/gateway/server-reload-handlers.ts:152-213`）：

- 检查 `getTotalQueueSize()` + `getTotalPendingReplies()` + `getActiveEmbeddedRunCount()`
- 全部归零后才 `emitGatewayRestart()`
- 超时后强制重启（带日志警告）
- 重复的配置变更不会启动多个轮询循环（`restartPending` 标志位）

#### 浏览器配置双模式刷新

浏览器 profile 支持独立的热重载路径（`src/browser/resolved-config-refresh.ts:35-58`）：先尝试缓存读取，miss 后用 `createConfigIO().loadConfig()` 从磁盘重新加载，不污染全局配置缓存。

---

## 第 3 章 迁移指南

### 3.1 迁移清单

**阶段 1：配置差异检测**
- [ ] 实现 `diffConfigPaths()` 递归对比函数
- [ ] 为数组类型添加 `isDeepStrictEqual` 结构化比较

**阶段 2：规则引擎**
- [ ] 定义 `ReloadRule` 类型（prefix + kind + actions）
- [ ] 编写 BASE 规则表（覆盖核心子系统）
- [ ] 编写 TAIL 规则表（兜底规则）
- [ ] 实现前缀匹配函数 `matchRule()`

**阶段 3：重载计划**
- [ ] 定义 `ReloadPlan` 结构体
- [ ] 实现 `buildReloadPlan()` 遍历变更路径生成计划

**阶段 4：执行器**
- [ ] 实现 `applyHotReload()` 按计划热替换各子系统
- [ ] 实现 `requestRestart()` 优雅重启（等待活跃任务完成）
- [ ] 集成 chokidar 文件监听 + debounce

**阶段 5：插件扩展**
- [ ] 在插件接口中添加 `reload?: { configPrefixes, noopPrefixes }` 声明
- [ ] 在规则引擎中动态合并插件贡献的规则

### 3.2 适配代码模板

<!-- APPEND_MARKER_3 -->
