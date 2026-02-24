# PD-47.01 OpenClaw — 分层 Zod Schema + 插件动态合并配置校验体系

> 文档编号：PD-47.01
> 来源：OpenClaw `src/config/zod-schema.ts`, `src/config/validation.ts`, `src/config/schema.ts`
> GitHub：https://github.com/openclaw/openclaw
> 问题域：PD-47 配置Schema校验 Config Schema Validation
> 状态：可复用方案

---

## 第 1 章 问题与动机

### 1.1 核心问题

Agent 系统的配置复杂度远超传统 Web 应用：多 Agent 定义、多渠道接入（WhatsApp/Telegram/Discord/Slack 等 12+ 渠道）、多模型提供商、插件系统、认证轮转、定时任务、浏览器自动化等数十个子系统各有独立配置需求。配置错误是生产事故的首要来源——一个拼写错误的字段名可能导致整个 Gateway 无法启动，一个类型错误的端口号可能让服务静默失败。

核心挑战：
1. **配置规模大**：OpenClaw 的主 Schema 定义超过 700 行，涵盖 20+ 顶级配置节
2. **动态扩展**：插件和渠道扩展可以贡献自己的配置 Schema，需要运行时合并
3. **敏感字段散布**：API Key、Token、Password 散布在配置各处，需要统一标记和脱敏
4. **环境变量替换**：生产环境用 `${VAR}` 引用环境变量，写回时需要恢复引用而非写入明文
5. **向后兼容**：配置结构持续演进，旧字段需要自动迁移而非直接报错

### 1.2 OpenClaw 的解法概述

OpenClaw 构建了一套完整的配置校验管线，从文件读取到运行时生效经过 7 个阶段：

1. **分模块 Zod Schema**：将 700+ 行的主 Schema 拆分为 15 个子模块（`zod-schema.agents.ts`、`zod-schema.channels.ts` 等），在 `zod-schema.ts:124` 组合为 `OpenClawSchema`
2. **`$include` 文件合并**：支持 `$include` 指令引入外部配置片段，带路径遍历防护和循环检测（`includes.ts:80-258`）
3. **`${VAR}` 环境变量替换**：加载时替换，写回时智能恢复引用（`env-substitution.ts:78-113`）
4. **Legacy 自动迁移**：30+ 条迁移规则自动将旧字段移到新位置（`legacy.rules.ts:3-136`）
5. **插件 Schema 动态合并**：插件通过 manifest 贡献 JSON Schema，运行时与核心 Schema 合并（`schema.ts:232-271`）
6. **敏感字段注册制**：通过 Zod registry 标记敏感字段，自动生成脱敏 UI hints（`zod-schema.sensitive.ts:5`）
7. **Merge-Patch 安全合并**：RFC 6902 JSON Merge Patch + 原型污染防护（`merge-patch.ts:62-97`）

### 1.3 设计思想

| 设计原则 | 具体实现 | 理由 | 替代方案 |
|----------|----------|------|----------|
| Schema 即文档 | Zod Schema → JSON Schema → UI hints 三层派生 | 单一数据源，Schema 变更自动同步到 UI 表单和文档 | 手动维护 JSON Schema + 文档（易过时） |
| 分模块组合 | 15 个 `zod-schema.*.ts` 文件各管一个子系统 | 避免单文件膨胀，团队可并行开发 | 单文件 monolithic schema（难维护） |
| 注册制敏感标记 | `z.string().register(sensitive)` 声明式标记 | 编译期可追踪，不依赖命名约定 | 正则匹配字段名（漏标风险高） |
| 防御性合并 | `isBlockedObjectKey()` 拦截 `__proto__` | 配置来自用户输入，必须防原型污染 | 信任输入（安全漏洞） |
| 渐进式迁移 | Legacy rules 检测 + 自动迁移 + 警告 | 用户无需手动改配置，平滑升级 | 直接报错要求手动修改（体验差） |

---

## 第 2 章 源码实现分析

### 2.1 架构概览

```
┌─────────────────────────────────────────────────────────────────┐
│                    Config Loading Pipeline                       │
│                                                                 │
│  config.json5                                                   │
│      │                                                          │
│      ▼                                                          │
│  ┌──────────┐   ┌──────────────┐   ┌───────────────┐           │
│  │ JSON5    │──→│  $include    │──→│  ${VAR}       │           │
│  │ Parse    │   │  Resolution  │   │  Substitution │           │
│  └──────────┘   └──────────────┘   └───────────────┘           │
│      │               │                    │                     │
│      │          includes.ts:80       env-substitution.ts:78     │
│      ▼                                    │                     │
│  ┌──────────────┐   ┌──────────────┐      ▼                    │
│  │ Legacy       │──→│ Zod Schema   │  ┌──────────────┐         │
│  │ Migration    │   │ Validation   │  │ Plugin Schema │         │
│  └──────────────┘   └──────────────┘  │ Merge (AJV)  │         │
│      │                    │           └──────────────┘          │
│  legacy.rules.ts:3  zod-schema.ts:124      │                   │
│      │                    │                │                    │
│      ▼                    ▼                ▼                    │
│  ┌──────────────────────────────────────────────┐              │
│  │         validation.ts — Unified Validator     │              │
│  │  validateConfigObjectWithPlugins()            │              │
│  │  ├─ findLegacyConfigIssues()                  │              │
│  │  ├─ OpenClawSchema.safeParse()                │              │
│  │  ├─ findDuplicateAgentDirs()                  │              │
│  │  ├─ validateIdentityAvatar()                  │              │
│  │  └─ validateJsonSchemaValue() (per plugin)    │              │
│  └──────────────────────────────────────────────┘              │
│      │                                                          │
│      ▼                                                          │
│  ┌──────────────┐   ┌──────────────┐   ┌──────────────┐       │
│  │ Apply        │──→│ Normalize    │──→│ Config       │       │
│  │ Defaults     │   │ Paths        │   │ Ready ✓      │       │
│  └──────────────┘   └──────────────┘   └──────────────┘       │
│                                                                 │
│  ┌─────────────────────────────────────────────────────┐       │
│  │  Write-back Pipeline (reverse)                       │       │
│  │  createMergePatch() → restoreEnvVarRefs()           │       │
│  │  → validateRaw() → stampVersion() → atomic write    │       │
│  └─────────────────────────────────────────────────────┘       │
└─────────────────────────────────────────────────────────────────┘
```

### 2.2 核心实现

#### 2.2.1 分模块 Zod Schema 组合

主 Schema 在 `src/config/zod-schema.ts:124-707` 定义，通过导入 15 个子模块组合而成：

```typescript
// src/config/zod-schema.ts:1-15 — 模块导入
import { z } from "zod";
import { ToolsSchema } from "./zod-schema.agent-runtime.js";
import { AgentsSchema, AudioSchema, BindingsSchema, BroadcastSchema } from "./zod-schema.agents.js";
import { ApprovalsSchema } from "./zod-schema.approvals.js";
import { HexColorSchema, ModelsConfigSchema } from "./zod-schema.core.js";
import { HookMappingSchema, HooksGmailSchema, InternalHooksSchema } from "./zod-schema.hooks.js";
import { InstallRecordShape } from "./zod-schema.installs.js";
import { ChannelsSchema } from "./zod-schema.providers.js";
import { sensitive } from "./zod-schema.sensitive.js";

// src/config/zod-schema.ts:124 — 主 Schema 定义
export const OpenClawSchema = z
  .object({
    $schema: z.string().optional(),
    meta: z.object({ /* ... */ }).strict().optional(),
    env: z.object({ /* ... */ }).catchall(z.string()).optional(),
    // ... 20+ 顶级配置节
    agents: AgentsSchema,        // 从子模块导入
    tools: ToolsSchema,          // 从子模块导入
    channels: ChannelsSchema,    // 从子模块导入
    // ...
  })
  .strict()  // 拒绝未知字段
  .superRefine((cfg, ctx) => {
    // 跨字段校验：broadcast 引用的 agent ID 必须存在
    const agentIds = new Set(cfg.agents?.list?.map(a => a.id) ?? []);
    for (const [peerId, ids] of Object.entries(cfg.broadcast ?? {})) {
      if (!Array.isArray(ids)) continue;
      for (const agentId of ids) {
        if (!agentIds.has(agentId)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["broadcast", peerId],
            message: `Unknown agent id "${agentId}"`,
          });
        }
      }
    }
  });
```

关键设计点：
- 每个子模块用 `.strict()` 拒绝未知字段，防止拼写错误静默通过
- `superRefine` 实现跨字段引用完整性校验（`zod-schema.ts:677-707`）
- 敏感字段用 `.register(sensitive)` 标记（如 `zod-schema.ts:325`：`webhookToken: z.string().optional().register(sensitive)`）

#### 2.2.2 敏感字段注册与自动脱敏

`src/config/zod-schema.sensitive.ts:5` 定义了全局 Zod registry：

```typescript
// src/config/zod-schema.sensitive.ts:5
export const sensitive = z.registry<undefined, z.ZodType>();
```

`src/config/schema.hints.ts:186-231` 递归遍历 Schema 树，收集所有标记了 `sensitive` 的路径：

```typescript
// src/config/schema.hints.ts:186-231
export function mapSensitivePaths(
  schema: z.ZodType, path: string, hints: ConfigUiHints,
): ConfigUiHints {
  let next = { ...hints };
  let currentSchema = schema;
  let isSensitive = sensitive.has(currentSchema);

  // 解包 Optional/Nullable 等包装类型
  while (isUnwrappable(currentSchema)) {
    currentSchema = currentSchema.unwrap();
    isSensitive ||= sensitive.has(currentSchema);
  }

  if (isSensitive) {
    next[path] = { ...next[path], sensitive: true };
  } else if (isSensitiveConfigPath(path) && !next[path]?.sensitive) {
    log.warn(`possibly sensitive key found: (${path})`);  // 兜底：命名匹配但未注册的字段发出警告
  }

  // 递归遍历 ZodObject/ZodArray/ZodRecord/ZodUnion
  if (currentSchema instanceof z.ZodObject) {
    for (const key in currentSchema.shape) {
      next = mapSensitivePaths(currentSchema.shape[key], `${path}.${key}`, next);
    }
  }
  // ... ZodArray, ZodRecord, ZodUnion 分支
  return next;
}
```

双重保险机制（`schema.hints.ts:112-125`）：
- **注册制**：`z.string().register(sensitive)` 显式标记
- **命名约定兜底**：正则 `/token$/i`, `/password/i`, `/secret/i`, `/api.?key/i` 匹配未注册字段并发出警告
- **白名单排除**：`maxTokens`、`tokenCount` 等非敏感字段通过后缀白名单排除误报

#### 2.2.3 插件 Schema 动态合并

插件通过 manifest 声明自己的 JSON Schema，运行时与核心 Schema 合并。核心逻辑在 `src/config/schema.ts:232-271`：

```typescript
// src/config/schema.ts:232-271
function applyPluginSchemas(schema: ConfigSchema, plugins: PluginUiMetadata[]): ConfigSchema {
  const next = cloneSchema(schema);
  const entriesNode = asSchemaObject(
    asSchemaObject(asSchemaObject(next)?.properties?.plugins)?.properties?.entries
  );
  if (!entriesNode) return next;

  const entryBase = asSchemaObject(entriesNode.additionalProperties);
  const entryProperties = entriesNode.properties ?? {};
  entriesNode.properties = entryProperties;

  for (const plugin of plugins) {
    if (!plugin.configSchema) continue;
    const entrySchema = entryBase ? cloneSchema(entryBase) : { type: "object" };
    const entryObject = asSchemaObject(entrySchema) ?? { type: "object" };
    // 合并插件 config schema 到 entry.config 节点
    const nextConfigSchema = mergeObjectSchema(
      asSchemaObject(entryObject.properties?.config),
      asSchemaObject(plugin.configSchema)
    );
    entryObject.properties = { ...entryObject.properties, config: nextConfigSchema };
    entryProperties[plugin.id] = entryObject;
  }
  return next;
}
```

插件配置校验使用 AJV（`src/plugins/schema-validator.ts:27-44`），带编译缓存：

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

### 2.3 实现细节

#### 2.3.1 $include 文件合并与安全防护

`src/config/includes.ts:80-258` 实现了 `$include` 指令处理器，关键安全措施：

- **路径遍历防护**（`includes.ts:186-192`）：`isPathInside()` 检查包含路径不超出配置根目录
- **符号链接防护**（`includes.ts:194-208`）：`realpathSync` 解析后二次验证
- **循环引用检测**（`includes.ts:213-216`）：`visited` Set 追踪已访问文件
- **深度限制**（`includes.ts:219-225`）：`MAX_INCLUDE_DEPTH = 10` 防止无限递归
- **原型污染防护**（`includes.ts:66`）：`deepMerge` 中调用 `isBlockedObjectKey()` 过滤 `__proto__`

#### 2.3.2 环境变量替换与写回恢复

加载时 `${VAR}` 替换（`env-substitution.ts:78-113`）：
- 仅匹配大写环境变量名 `[A-Z_][A-Z0-9_]*`
- `$${VAR}` 转义语法输出字面量 `${VAR}`
- 缺失变量抛出 `MissingEnvVarError` 含配置路径上下文

写回时恢复（`io.ts:1020-1039`）：
- 读取当前文件的原始内容（替换前）
- 对比变更路径，未变更的字段恢复 `${VAR}` 引用
- 使用加载时的 env snapshot 避免 TOCTOU 竞态

#### 2.3.3 Merge-Patch 安全合并

`src/config/merge-patch.ts:62-97` 实现 RFC 6902 JSON Merge Patch：

- `null` 值表示删除字段（`merge-patch.ts:77-79`）
- `isBlockedObjectKey()` 拦截 `__proto__`/`prototype`/`constructor`（`merge-patch.ts:74-76`）
- `mergeObjectArraysById()` 按 `id` 字段合并数组元素而非整体替换（`merge-patch.ts:25-60`）

#### 2.3.4 配置热重载

`src/gateway/config-reload.ts:254-420` 实现基于 chokidar 的文件监听 + 分级重载：

- **4 种重载模式**：off / restart / hot / hybrid
- **规则引擎**：`BASE_RELOAD_RULES` 定义每个配置前缀的重载策略（`config-reload.ts:50-90`）
- **插件贡献规则**：渠道插件可注册自己的 hot reload 前缀
- **防抖**：可配置 `debounceMs`（默认 300ms）
- **缺失文件重试**：最多 2 次重试，间隔 150ms

---

## 第 3 章 迁移指南

### 3.1 迁移清单

**阶段 1：基础 Schema 定义**
- [ ] 安装 `zod` 依赖
- [ ] 按子系统拆分 Schema 文件（建议每个顶级配置节一个文件）
- [ ] 在主 Schema 中组合子模块，使用 `.strict()` 拒绝未知字段
- [ ] 添加 `superRefine` 实现跨字段校验

**阶段 2：敏感字段管理**
- [ ] 创建 `sensitive` registry：`const sensitive = z.registry<undefined, z.ZodType>()`
- [ ] 在 Schema 定义中用 `.register(sensitive)` 标记敏感字段
- [ ] 实现 `mapSensitivePaths()` 递归收集敏感路径
- [ ] 添加命名约定兜底检测 + 白名单排除

**阶段 3：配置加载管线**
- [ ] 实现 `$include` 文件合并（含路径遍历防护）
- [ ] 实现 `${VAR}` 环境变量替换
- [ ] 实现写回时环境变量引用恢复

**阶段 4：插件扩展**
- [ ] 定义插件 manifest 中的 `configSchema` 字段
- [ ] 实现运行时 Schema 合并（Zod → JSON Schema → merge）
- [ ] 使用 AJV 校验插件配置（带编译缓存）

**阶段 5：Legacy 迁移**
- [ ] 定义迁移规则表（旧路径 → 新路径 + 迁移消息）
- [ ] 在校验前执行迁移检测，自动迁移或报告

### 3.2 适配代码模板

```typescript
import { z } from "zod";

// 1. 创建敏感字段 registry
const sensitive = z.registry<undefined, z.ZodType>();

// 2. 分模块定义 Schema
const DatabaseSchema = z.object({
  host: z.string().default("localhost"),
  port: z.number().int().min(1).max(65535).default(5432),
  password: z.string().register(sensitive),  // 标记敏感
  ssl: z.boolean().default(false),
}).strict();

const AgentSchema = z.object({
  id: z.string().min(1),
  model: z.string(),
  apiKey: z.string().register(sensitive),
  maxTokens: z.number().int().positive().optional(),
}).strict();

// 3. 组合主 Schema + 跨字段校验
const AppConfigSchema = z.object({
  database: DatabaseSchema.optional(),
  agents: z.array(AgentSchema).optional(),
  defaultAgent: z.string().optional(),
}).strict().superRefine((cfg, ctx) => {
  if (cfg.defaultAgent && cfg.agents) {
    const ids = new Set(cfg.agents.map(a => a.id));
    if (!ids.has(cfg.defaultAgent)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["defaultAgent"],
        message: `Unknown agent: ${cfg.defaultAgent}`,
      });
    }
  }
});

// 4. 校验函数
function validateConfig(raw: unknown) {
  const result = AppConfigSchema.safeParse(raw);
  if (!result.success) {
    return {
      ok: false as const,
      issues: result.error.issues.map(iss => ({
        path: iss.path.join("."),
        message: iss.message,
      })),
    };
  }
  return { ok: true as const, config: result.data };
}

// 5. 原型污染防护的 merge-patch
const BLOCKED_KEYS = new Set(["__proto__", "prototype", "constructor"]);

function safeMergePatch(base: unknown, patch: unknown): unknown {
  if (!isPlainObject(patch)) return patch;
  const result: Record<string, unknown> = isPlainObject(base) ? { ...base } : {};
  for (const [key, value] of Object.entries(patch)) {
    if (BLOCKED_KEYS.has(key)) continue;
    if (value === null) { delete result[key]; continue; }
    if (isPlainObject(value)) {
      result[key] = safeMergePatch(result[key], value);
      continue;
    }
    result[key] = value;
  }
  return result;
}
```

### 3.3 适用场景

| 场景 | 适用度 | 说明 |
|------|--------|------|
| 多插件/多渠道 Agent 系统 | ⭐⭐⭐ | 核心场景，插件动态贡献 Schema 是关键差异化 |
| 配置驱动的 SaaS 平台 | ⭐⭐⭐ | 分模块 Schema + UI hints 生成配置表单 |
| CLI 工具配置管理 | ⭐⭐ | 环境变量替换 + Legacy 迁移很实用，但插件合并可能过重 |
| 简单微服务配置 | ⭐ | 过度工程化，直接用 Zod 校验即可 |

---

## 第 4 章 测试用例

```typescript
import { describe, it, expect } from "vitest";
import { z } from "zod";

// 模拟 OpenClaw 的 Schema 校验模式
const sensitive = z.registry<undefined, z.ZodType>();

const TestConfigSchema = z.object({
  database: z.object({
    host: z.string(),
    port: z.number().int().min(1).max(65535),
    password: z.string().register(sensitive),
  }).strict().optional(),
  agents: z.array(z.object({
    id: z.string().min(1),
    model: z.string(),
  }).strict()).optional(),
  broadcast: z.record(z.string(), z.array(z.string())).optional(),
}).strict().superRefine((cfg, ctx) => {
  const agentIds = new Set(cfg.agents?.map(a => a.id) ?? []);
  for (const [key, ids] of Object.entries(cfg.broadcast ?? {})) {
    for (const id of ids) {
      if (!agentIds.has(id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["broadcast", key],
          message: `Unknown agent: ${id}`,
        });
      }
    }
  }
});

describe("Config Schema Validation", () => {
  it("accepts valid config", () => {
    const result = TestConfigSchema.safeParse({
      database: { host: "localhost", port: 5432, password: "secret" },
      agents: [{ id: "main", model: "gpt-4" }],
    });
    expect(result.success).toBe(true);
  });

  it("rejects unknown fields with .strict()", () => {
    const result = TestConfigSchema.safeParse({
      database: { host: "localhost", port: 5432, password: "s", typo: true },
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0].message).toContain("Unrecognized key");
  });

  it("validates cross-field references via superRefine", () => {
    const result = TestConfigSchema.safeParse({
      agents: [{ id: "main", model: "gpt-4" }],
      broadcast: { peer1: ["main", "nonexistent"] },
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0].message).toContain("Unknown agent");
  });

  it("rejects invalid port range", () => {
    const result = TestConfigSchema.safeParse({
      database: { host: "localhost", port: 99999, password: "s" },
    });
    expect(result.success).toBe(false);
  });
});

describe("Merge Patch with Prototype Pollution Protection", () => {
  const BLOCKED_KEYS = new Set(["__proto__", "prototype", "constructor"]);

  function safeMergePatch(base: unknown, patch: unknown): unknown {
    if (typeof patch !== "object" || patch === null || Array.isArray(patch)) return patch;
    const result: Record<string, unknown> = (
      typeof base === "object" && base !== null && !Array.isArray(base)
    ) ? { ...base as Record<string, unknown> } : {};
    for (const [key, value] of Object.entries(patch)) {
      if (BLOCKED_KEYS.has(key)) continue;
      if (value === null) { delete result[key]; continue; }
      result[key] = typeof value === "object" && !Array.isArray(value)
        ? safeMergePatch(result[key], value)
        : value;
    }
    return result;
  }

  it("blocks __proto__ injection", () => {
    const base = { safe: true };
    const patch = JSON.parse('{"__proto__": {"polluted": true}}');
    const result = safeMergePatch(base, patch) as Record<string, unknown>;
    expect(result.safe).toBe(true);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("deletes fields with null patch value", () => {
    const result = safeMergePatch({ a: 1, b: 2 }, { b: null });
    expect(result).toEqual({ a: 1 });
  });

  it("deep merges nested objects", () => {
    const result = safeMergePatch(
      { db: { host: "old", port: 5432 } },
      { db: { host: "new" } },
    );
    expect(result).toEqual({ db: { host: "new", port: 5432 } });
  });
});
```

---

## 第 5 章 跨域关联

| 关联域 | 关系类型 | 说明 |
|--------|----------|------|
| PD-39 配置热重载 | 强协同 | Schema 校验是热重载的前置条件——`config-reload.ts` 在应用变更前必须通过 `validateConfigObjectWithPlugins()` |
| PD-35 插件扩展系统 | 强依赖 | 插件通过 manifest 贡献 `configSchema`，由 `applyPluginSchemas()` 合并到核心 Schema |
| PD-36 认证配置轮转 | 协同 | `auth.profiles` 和 `auth.cooldowns` 的 Schema 定义在 `zod-schema.ts:275-301`，敏感字段标记确保 token 不泄露 |
| PD-37 安全审计框架 | 协同 | 配置写入审计日志（`io.ts:492-506`）记录每次配置变更的 hash、字节数、可疑原因 |
| PD-04 工具系统 | 依赖 | `ToolsSchema` 作为子模块被主 Schema 引用，工具权限配置依赖 Schema 校验 |
| PD-11 可观测性 | 协同 | `diagnostics.otel` 配置节的 Schema 定义了 OpenTelemetry 导出参数 |

---

## 第 6 章 来源文件索引

| 文件 | 行范围 | 关键实现 |
|------|--------|----------|
| `src/config/zod-schema.ts` | L1-707 | 主 Schema 定义，15 模块组合 + superRefine 跨字段校验 |
| `src/config/zod-schema.sensitive.ts` | L1-6 | 敏感字段 Zod registry 定义 |
| `src/config/validation.ts` | L85-433 | 统一校验入口，4 个校验函数 + 插件校验集成 |
| `src/config/schema.ts` | L232-371 | JSON Schema 生成 + 插件/渠道 Schema 动态合并 |
| `src/config/schema.hints.ts` | L1-237 | UI hints 生成 + 敏感路径映射 + 命名约定兜底 |
| `src/config/merge-patch.ts` | L1-97 | RFC 6902 Merge Patch + 原型污染防护 + 数组按 ID 合并 |
| `src/config/prototype-keys.ts` | L1-5 | 原型污染黑名单（`__proto__`, `prototype`, `constructor`） |
| `src/config/includes.ts` | L1-287 | `$include` 文件合并 + 路径遍历/符号链接/循环引用防护 |
| `src/config/env-substitution.ts` | L1-172 | `${VAR}` 环境变量替换 + `$${VAR}` 转义 |
| `src/config/legacy.rules.ts` | L1-137 | 30+ 条 Legacy 配置迁移规则 |
| `src/config/legacy-migrate.ts` | L1-19 | Legacy 迁移入口 |
| `src/config/io.ts` | L1-1302 | 配置 I/O 全流程：读取/解析/校验/写回/审计 |
| `src/plugins/schema-validator.ts` | L1-44 | AJV JSON Schema 校验 + 编译缓存 |
| `src/gateway/config-reload.ts` | L1-420 | 配置热重载：chokidar 监听 + 分级重载规则引擎 |

---

## 第 7 章 横向对比维度

```json comparison_data
{
  "project": "OpenClaw",
  "dimensions": {
    "Schema技术栈": "Zod 分模块定义 + .strict() 拒绝未知字段 + superRefine 跨字段校验",
    "插件Schema扩展": "插件 manifest 声明 JSON Schema，运行时 mergeObjectSchema 合并到核心 Schema",
    "敏感字段管理": "Zod registry 注册制标记 + 正则命名约定兜底 + 白名单排除误报",
    "配置合并策略": "RFC 6902 JSON Merge Patch + isBlockedObjectKey 原型污染防护 + 数组按 ID 合并",
    "环境变量处理": "${VAR} 加载时替换 + 写回时智能恢复引用 + env snapshot 防 TOCTOU",
    "Legacy迁移": "30+ 条声明式规则表 + 自动迁移 + 用户友好警告消息",
    "热重载集成": "chokidar 监听 + 4 模式分级重载 + 插件贡献重载规则"
  }
}
```

### 域元数据补充

```json domain_metadata
{
  "solution_summary": "OpenClaw 用 15 个 Zod 子模块组合 700+ 行主 Schema，配合 Zod registry 敏感标记、插件 JSON Schema 动态合并、$include 文件合并、${VAR} 环境变量替换与写回恢复，构建完整配置校验管线",
  "description": "配置从文件到运行时的完整校验管线，含动态扩展、安全防护与向后兼容",
  "sub_problems": [
    "跨字段引用完整性校验（superRefine）",
    "配置写回时环境变量引用恢复",
    "插件运行时Schema动态合并",
    "配置写入审计与异常检测",
    "JSON Schema到UI表单hints自动派生"
  ],
  "best_practices": [
    "Zod registry注册制标记敏感字段+命名约定兜底双保险",
    "$include路径遍历+符号链接+循环引用三重防护",
    "配置写回用env snapshot防TOCTOU竞态",
    "插件Schema用AJV编译缓存避免重复编译"
  ]
}
```
