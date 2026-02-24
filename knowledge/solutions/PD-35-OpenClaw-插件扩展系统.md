# PD-35.01 OpenClaw — Manifest-Registry 插件扩展系统

> 文档编号：PD-35.01
> 来源：OpenClaw `src/plugins/`, `extensions/`, `src/plugin-sdk/`
> GitHub：https://github.com/openclaw/openclaw
> 问题域：PD-35 插件扩展系统 Plugin Extension System
> 状态：可复用方案

---

## 第 1 章 问题与动机（≥ 30 行）

### 1.1 核心问题

Agent 系统需要在不修改核心代码的前提下扩展能力——接入新的消息渠道（Telegram、Discord、Slack 等）、注册自定义工具、注入 LLM 提示词、拦截生命周期事件、提供 CLI 子命令。传统做法是硬编码 if-else 分支或在核心代码中直接 import 各渠道实现，导致：

1. **耦合膨胀**：每新增一个渠道/能力就要改核心代码，合并冲突频繁
2. **安全边界模糊**：第三方代码与核心代码共享同一进程空间，无法控制权限
3. **配置碎片化**：每个扩展的配置格式不统一，校验逻辑散落各处
4. **发现与安装困难**：用户不知道有哪些可用扩展，安装流程不标准化

OpenClaw 的插件系统解决了这些问题：通过 `openclaw.plugin.json` manifest 声明元数据，`jiti` 动态加载 TypeScript 插件，统一的 `OpenClawPluginApi` 注册接口，以及 24 种生命周期 hook 实现全方位扩展。

### 1.2 OpenClaw 的解法概述

1. **Manifest-Registry 双层架构**：每个插件必须有 `openclaw.plugin.json` 声明 id、configSchema 等元数据（`src/plugins/manifest.ts:7`），ManifestRegistry 负责发现和索引（`src/plugins/manifest-registry.ts:134`），PluginRegistry 负责加载和注册（`src/plugins/registry.ts:164`）
2. **jiti 动态加载**：使用 `jiti`（JIT TypeScript Importer）直接加载 `.ts` 插件源码，无需预编译（`src/plugins/loader.ts:424-438`）
3. **统一注册 API**：`OpenClawPluginApi` 提供 `registerTool`、`registerHook`、`registerChannel`、`registerProvider`、`registerCommand` 等 12 种注册方法（`src/plugins/types.ts:245-284`）
4. **24 种生命周期 Hook**：覆盖 Agent、Message、Tool、Session、Gateway 五大类生命周期（`src/plugins/hooks.ts:113-750`），支持 void（并行 fire-and-forget）和 modifying（串行合并结果）两种执行模式
5. **四级发现优先级**：config > workspace > global > bundled，高优先级覆盖低优先级（`src/plugins/manifest-registry.ts:16-21`）

### 1.3 设计思想

| 设计原则 | 具体实现 | 理由 | 替代方案 |
|----------|----------|------|----------|
| Manifest-first | `openclaw.plugin.json` 必须包含 id + configSchema | 在加载代码前就能校验配置、展示 UI | 代码内 export metadata（需执行代码才能获取） |
| 零编译加载 | jiti 直接加载 .ts/.js | 插件开发者无需 build 步骤 | esbuild/rollup 预编译（增加开发摩擦） |
| 同步注册 | register() 必须同步返回，async 会被警告忽略 | 确保加载顺序确定性，避免竞态 | 允许 async register（增加复杂度） |
| Slot 互斥 | memory 类型插件只能激活一个 | 避免多个 memory 插件冲突 | 允许多个并存（需要复杂的合并逻辑） |
| 安全纵深 | 路径逃逸检测 + 世界可写检测 + UID 所有权检查 | 防止恶意插件通过符号链接等手段注入代码 | 仅信任 allowlist（不够安全） |

---

## 第 2 章 源码实现分析（≥ 60 行，核心章节）

### 2.1 架构概览

```
┌─────────────────────────────────────────────────────────────────┐
│                        Plugin Lifecycle                         │
│                                                                 │
│  ┌──────────┐    ┌───────────────┐    ┌──────────────────────┐  │
│  │ Discovery │───→│ManifestRegistry│───→│   PluginRegistry     │  │
│  │ 4-level   │    │ parse manifest │    │ jiti load + register │  │
│  │ scan      │    │ validate schema│    │ createApi per plugin │  │
│  └──────────┘    └───────────────┘    └──────────────────────┘  │
│       │                                        │                │
│       ▼                                        ▼                │
│  ┌──────────┐                         ┌──────────────────────┐  │
│  │ Security  │                         │   Registration API   │  │
│  │ Checks   │                         │                      │  │
│  │ • path   │                         │ registerTool()       │  │
│  │   escape │                         │ registerHook()       │  │
│  │ • world  │                         │ registerChannel()    │  │
│  │   write  │                         │ registerProvider()   │  │
│  │ • uid    │                         │ registerCommand()    │  │
│  │   owner  │                         │ registerService()    │  │
│  └──────────┘                         │ registerCli()        │  │
│                                       │ registerHttpRoute()  │  │
│                                       │ registerGatewayMethod│  │
│                                       │ on() (typed hooks)   │  │
│                                       └──────────────────────┘  │
│                                                │                │
│                                                ▼                │
│                                       ┌──────────────────────┐  │
│                                       │    Hook Runner        │  │
│                                       │ • void hooks (‖)     │  │
│                                       │ • modifying hooks (→) │  │
│                                       │ • sync hooks (⚡)     │  │
│                                       │ priority ordering     │  │
│                                       └──────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

### 2.2 核心实现

#### 2.2.1 插件发现（Discovery）

插件发现按四级优先级扫描目录（`src/plugins/discovery.ts:557-625`）：

```typescript
// src/plugins/discovery.ts:557-625
export function discoverOpenClawPlugins(params: {
  workspaceDir?: string;
  extraPaths?: string[];
  ownershipUid?: number | null;
}): PluginDiscoveryResult {
  const candidates: PluginCandidate[] = [];
  // 1. config 级：用户在 plugins.load.paths 中指定的路径
  for (const extraPath of extra) {
    discoverFromPath({ rawPath: trimmed, origin: "config", ... });
  }
  // 2. workspace 级：.openclaw/extensions/ 目录
  if (workspaceDir) {
    discoverInDirectory({ dir: workspaceExtDirs, origin: "workspace", ... });
  }
  // 3. global 级：~/.config/openclaw/extensions/
  discoverInDirectory({ dir: globalDir, origin: "global", ... });
  // 4. bundled 级：内置插件目录
  if (bundledDir) {
    discoverInDirectory({ dir: bundledDir, origin: "bundled", ... });
  }
  return { candidates, diagnostics };
}
```

每个候选插件在加入列表前都经过安全检查（`src/plugins/discovery.ts:177-199`）：路径逃逸检测、世界可写权限检测、文件所有权 UID 检查。

#### 2.2.2 Manifest 解析与 Registry

`openclaw.plugin.json` 是插件的身份证（`src/plugins/manifest.ts:7-10`）：

```typescript
// src/plugins/manifest.ts:7-10
export const PLUGIN_MANIFEST_FILENAME = "openclaw.plugin.json";

export type PluginManifest = {
  id: string;                              // 唯一标识
  configSchema: Record<string, unknown>;   // JSON Schema 配置校验
  kind?: PluginKind;                       // "memory" 等互斥类型
  channels?: string[];                     // 声明的渠道
  providers?: string[];                    // 声明的 LLM 提供商
  skills?: string[];                       // 声明的技能目录
  name?: string;
  description?: string;
  version?: string;
  uiHints?: Record<string, PluginConfigUiHint>; // UI 渲染提示
};
```

ManifestRegistry 负责去重和优先级仲裁（`src/plugins/manifest-registry.ts:16-21`）：

```typescript
// src/plugins/manifest-registry.ts:16-21
const PLUGIN_ORIGIN_RANK: Readonly<Record<PluginOrigin, number>> = {
  config: 0,    // 最高优先级
  workspace: 1,
  global: 2,
  bundled: 3,   // 最低优先级
};
```

#### 2.2.3 jiti 动态加载

加载器使用 `jiti`（JIT TypeScript Importer）直接执行 `.ts` 源码（`src/plugins/loader.ts:417-438`）：

```typescript
// src/plugins/loader.ts:417-438
const getJiti = () => {
  if (jitiLoader) return jitiLoader;
  const pluginSdkAlias = resolvePluginSdkAlias();
  jitiLoader = createJiti(import.meta.url, {
    interopDefault: true,
    extensions: [".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs", ".json"],
    alias: {
      "openclaw/plugin-sdk": pluginSdkAlias,  // SDK 路径别名
    },
  });
  return jitiLoader;
};
// 实际加载：
mod = getJiti()(candidate.source) as OpenClawPluginModule;
```

jiti 的 `alias` 配置让插件可以 `import { ... } from "openclaw/plugin-sdk"` 而无需关心实际路径。

#### 2.2.4 统一注册 API

每个插件加载后获得一个 `OpenClawPluginApi` 实例（`src/plugins/registry.ts:472-503`）：

```typescript
// src/plugins/registry.ts:472-503
const createApi = (record: PluginRecord, params): OpenClawPluginApi => ({
  id: record.id,
  name: record.name,
  config: params.config,
  pluginConfig: params.pluginConfig,
  runtime: registryParams.runtime,
  logger: normalizeLogger(registryParams.logger),
  registerTool: (tool, opts) => registerTool(record, tool, opts),
  registerHook: (events, handler, opts) => registerHook(record, events, handler, opts, params.config),
  registerChannel: (registration) => registerChannel(record, registration),
  registerProvider: (provider) => registerProvider(record, provider),
  registerCommand: (command) => registerCommand(record, command),
  registerService: (service) => registerService(record, service),
  registerCli: (registrar, opts) => registerCli(record, registrar, opts),
  registerHttpRoute: (params) => registerHttpRoute(record, params),
  registerGatewayMethod: (method, handler) => registerGatewayMethod(record, method, handler),
  registerHttpHandler: (handler) => registerHttpHandler(record, handler),
  on: (hookName, handler, opts) => registerTypedHook(record, hookName, handler, opts),
  resolvePath: (input) => resolveUserPath(input),
});
```

插件通过 `register()` 或 `activate()` 函数使用此 API。示例——memory-core 插件（`extensions/memory-core/index.ts:1-38`）：

```typescript
// extensions/memory-core/index.ts:1-38
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";

const memoryCorePlugin = {
  id: "memory-core",
  name: "Memory (Core)",
  kind: "memory",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    api.registerTool(
      (ctx) => {
        const memorySearchTool = api.runtime.tools.createMemorySearchTool({
          config: ctx.config, agentSessionKey: ctx.sessionKey,
        });
        return memorySearchTool ? [memorySearchTool, memoryGetTool] : null;
      },
      { names: ["memory_search", "memory_get"] },
    );
    api.registerCli(({ program }) => {
      api.runtime.tools.registerMemoryCli(program);
    }, { commands: ["memory"] });
  },
};
export default memoryCorePlugin;
```

#### 2.2.5 Hook 系统

Hook Runner 支持三种执行模式（`src/plugins/hooks.ts:125-255`）：

1. **Void Hook（并行）**：`runVoidHook` — 所有 handler 通过 `Promise.all` 并行执行，用于观察性 hook（如 `llm_input`、`message_sent`）
2. **Modifying Hook（串行）**：`runModifyingHook` — 按 priority 降序串行执行，每个 handler 的返回值通过 merge 函数合并，用于可修改的 hook（如 `before_model_resolve`、`before_tool_call`）
3. **Sync Hook（同步）**：`runToolResultPersist`、`runBeforeMessageWrite` — 在热路径上同步执行，如果 handler 返回 Promise 会被警告忽略

24 种 hook 覆盖完整生命周期（`src/plugins/types.ts:299-323`）：

| 类别 | Hook 名称 | 执行模式 |
|------|-----------|----------|
| Agent | before_model_resolve, before_prompt_build, before_agent_start, llm_input, llm_output, agent_end, before_compaction, after_compaction, before_reset | modifying / void |
| Message | message_received, message_sending, message_sent | void / modifying |
| Tool | before_tool_call, after_tool_call, tool_result_persist | modifying / void / sync |
| Session | session_start, session_end, subagent_spawning, subagent_delivery_target, subagent_spawned, subagent_ended | void / modifying |
| Gateway | gateway_start, gateway_stop | void |
| Write | before_message_write | sync |

### 2.3 实现细节

#### 配置校验

每个插件的 `configSchema` 是标准 JSON Schema，通过 Ajv 校验（`src/plugins/schema-validator.ts:27-44`）：

```typescript
// src/plugins/schema-validator.ts:27-44
export function validateJsonSchemaValue(params: {
  schema: Record<string, unknown>;
  cacheKey: string;
  value: unknown;
}): { ok: true } | { ok: false; errors: string[] } {
  let cached = schemaCache.get(params.cacheKey);
  if (!cached || cached.schema !== params.schema) {
    const validate = ajv.compile(params.schema);
    cached = { validate, schema: params.schema };
    schemaCache.set(params.cacheKey, cached);
  }
  const ok = cached.validate(params.value);
  if (ok) return { ok: true };
  return { ok: false, errors: formatAjvErrors(cached.validate.errors) };
}
```

#### Slot 互斥机制

`kind: "memory"` 类型的插件只能激活一个（`src/plugins/slots.ts:37-108`）。当用户选择新的 memory 插件时，`applyExclusiveSlotSelection` 自动禁用其他同类插件并更新配置。

#### 插件安装

支持四种安装源（`src/plugins/install.ts`）：
- **npm 包**：`installPluginFromNpmSpec` — 从 npm registry 下载
- **归档文件**：`installPluginFromArchive` — .tgz/.tar/.zip
- **目录**：`installPluginFromDir` — 本地目录
- **单文件**：`installPluginFromFile` — 单个 .ts/.js 文件

安装时会执行安全扫描（`src/plugins/install.ts:181-202`），检测危险代码模式。

#### 插件命令系统

插件可注册自定义命令绕过 LLM（`src/plugins/commands.ts:108-141`）。命令名不能与内置命令冲突（30+ 保留名），执行时有参数长度限制（4096 字符）和控制字符过滤。

