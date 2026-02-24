# PD-36.01 OpenClaw — 多凭证类型轮转 + 指数退避冷却 + 文件锁并发安全

> 文档编号：PD-36.01
> 来源：OpenClaw `src/agents/auth-profiles/`
> GitHub：https://github.com/openclaw/openclaw
> 问题域：PD-36 认证配置轮转 Auth Profile Rotation
> 状态：可复用方案

---

## 第 1 章 问题与动机

### 1.1 核心问题

Agent 系统通常需要调用多个 LLM Provider（Anthropic、OpenAI、Qwen、Google Gemini 等），每个 Provider 可能有多个凭证（个人 API Key、团队 Token、OAuth 登录等）。在生产环境中面临以下挑战：

1. **凭证类型异构**：API Key 是静态的，OAuth Token 会过期需要刷新，Bearer Token 有时效性——三种凭证的生命周期管理逻辑完全不同
2. **故障级联**：某个凭证因 rate limit 或 billing 问题失败后，如果不做隔离，后续请求会反复命中同一个坏凭证，导致整个 Provider 不可用
3. **并发安全**：多个 Agent（主 Agent + 子 Agent）可能同时读写同一份凭证存储，OAuth 刷新操作必须互斥
4. **凭证来源分散**：凭证可能来自环境变量、配置文件、外部 CLI 工具（如 Qwen CLI）、OAuth 登录流程——需要统一管理
5. **子 Agent 继承**：子 Agent 需要继承主 Agent 的凭证，但又要有独立的 cooldown 状态

### 1.2 OpenClaw 的解法概述

OpenClaw 构建了一套完整的 Auth Profile 系统，核心设计：

1. **三类凭证统一抽象**：`ApiKeyCredential`、`TokenCredential`、`OAuthCredential` 三种类型通过 `AuthProfileCredential` 联合类型统一管理（`src/agents/auth-profiles/types.ts:4-33`）
2. **双层冷却机制**：`cooldownUntil`（短期，rate limit 等瞬态错误）和 `disabledUntil`（长期，billing/auth 永久性错误）分别管理，互不干扰（`src/agents/auth-profiles/usage.ts:45-46`）
3. **文件锁保护并发**：所有 store 写操作通过 `withFileLock` + PID 检测实现互斥，支持重入和 stale lock 自动清理（`src/plugin-sdk/file-lock.ts:103-148`）
4. **Round-Robin + 类型优先级排序**：可用凭证按 `oauth > token > api_key` 类型优先级排序，同类型内按 `lastUsed` 最久未用优先（`src/agents/auth-profiles/order.ts:143-189`）
5. **子 Agent 凭证继承与自动采纳**：子 Agent 无凭证时自动继承主 Agent，OAuth 刷新失败时回退到主 Agent 的新鲜凭证（`src/agents/auth-profiles/oauth.ts:100-135`）

### 1.3 设计思想

| 设计原则 | 具体实现 | 理由 | 替代方案 |
|----------|----------|------|----------|
| 冷却窗口不可变 | `keepActiveWindowOrRecompute()` 确保活跃窗口内重试不延长冷却时间 | 防止重试风暴无限推迟恢复 | 每次失败重新计算（会导致永远无法恢复） |
| 双层故障分级 | billing → `disabledUntil`（5h-24h），其他 → `cooldownUntil`（1min-1h） | billing 问题需要人工介入，不应频繁重试 | 统一 cooldown（billing 问题会被过早重试） |
| 文件锁 + PID 检测 | `fs.open(lockPath, 'wx')` 原子创建 + PID alive 检测清理 stale lock | 跨进程安全，无需外部依赖 | Redis 分布式锁（过重）/ flock（不跨平台） |
| 凭证类型优先级 | oauth(0) > token(1) > api_key(2) | OAuth 通常有更高配额和更好的审计追踪 | 无优先级随机选择（浪费高价值凭证） |
| 错误计数窗口衰减 | `failureWindowMs`（默认 24h）外的错误不计入 | 避免历史错误永久影响凭证排序 | 永久累计（一次故障永远惩罚） |

---

## 第 2 章 源码实现分析

### 2.1 架构概览

OpenClaw 的认证配置轮转系统由 6 个核心模块组成，围绕一个 JSON 文件存储展开：

```
┌─────────────────────────────────────────────────────────────────┐
│                     Auth Profile System                         │
│                                                                 │
│  ┌──────────┐   ┌──────────┐   ┌──────────┐   ┌─────────────┐ │
│  │  types.ts │   │ store.ts │   │ order.ts │   │  usage.ts   │ │
│  │ 3种凭证   │   │ 持久化    │   │ 排序轮转  │   │ cooldown    │ │
│  │ 联合类型   │──→│ 文件锁    │──→│ round-   │──→│ 指数退避    │ │
│  │          │   │ 合并继承   │   │ robin    │   │ 双层分级    │ │
│  └──────────┘   └──────────┘   └──────────┘   └─────────────┘ │
│       │              │              │               │           │
│       ▼              ▼              ▼               ▼           │
│  ┌──────────┐   ┌──────────┐   ┌──────────────────────────┐   │
│  │ oauth.ts │   │ paths.ts │   │ session-override.ts      │   │
│  │ OAuth刷新 │   │ 路径解析  │   │ 会话级 profile 绑定      │   │
│  │ 主Agent   │   │ 主/子区分 │   │ compaction 触发轮转      │   │
│  │ 凭证采纳  │   │          │   │                          │   │
│  └──────────┘   └──────────┘   └──────────────────────────┘   │
│                                                                 │
│  Storage: ~/.openclaw/agents/{agentId}/auth-profiles.json       │
└─────────────────────────────────────────────────────────────────┘
```

### 2.2 核心实现

#### 2.2.1 凭证类型系统（`types.ts:4-67`）

三种凭证类型通过联合类型统一：

```typescript
// src/agents/auth-profiles/types.ts:4-33
export type ApiKeyCredential = {
  type: "api_key";
  provider: string;
  key?: string;
  email?: string;
  metadata?: Record<string, string>;
};

export type TokenCredential = {
  type: "token";
  provider: string;
  token: string;
  expires?: number; // ms since epoch
  email?: string;
};

export type OAuthCredential = OAuthCredentials & {
  type: "oauth";
  provider: string;
  clientId?: string;
  email?: string;
};

export type AuthProfileCredential = ApiKeyCredential | TokenCredential | OAuthCredential;
```

Store 结构将凭证、排序、使用统计统一存储：

```typescript
// src/agents/auth-profiles/types.ts:55-67
export type AuthProfileStore = {
  version: number;
  profiles: Record<string, AuthProfileCredential>;
  order?: Record<string, string[]>;       // 每 provider 的 profile 排序
  lastGood?: Record<string, string>;      // 每 provider 最后成功的 profile
  usageStats?: Record<string, ProfileUsageStats>; // 每 profile 的使用统计
};
```

#### 2.2.2 指数退避冷却计算（`usage.ts:270-339`）

两套独立的退避策略：

```typescript
// src/agents/auth-profiles/usage.ts:270-276
// 普通错误（rate_limit, timeout 等）：1min → 5min → 25min → 1h (max)
export function calculateAuthProfileCooldownMs(errorCount: number): number {
  const normalized = Math.max(1, errorCount);
  return Math.min(
    60 * 60 * 1000, // 1 hour max
    60 * 1000 * 5 ** Math.min(normalized - 1, 3),
  );
}

// src/agents/auth-profiles/usage.ts:328-339
// Billing 错误：5h → 10h → 20h → 24h (max)，支持 per-provider 覆盖
function calculateAuthProfileBillingDisableMsWithConfig(params: {
  errorCount: number;
  baseMs: number;  // 默认 5 * 3600 * 1000
  maxMs: number;   // 默认 24 * 3600 * 1000
}): number {
  const normalized = Math.max(1, params.errorCount);
  const baseMs = Math.max(60_000, params.baseMs);
  const maxMs = Math.max(baseMs, params.maxMs);
  const exponent = Math.min(normalized - 1, 10);
  return Math.min(maxMs, baseMs * 2 ** exponent);
}
```

#### 2.2.3 冷却窗口不可变性（`usage.ts:352-361`）

关键设计：活跃的冷却窗口一旦设定就不会被后续重试延长：

```typescript
// src/agents/auth-profiles/usage.ts:352-361
function keepActiveWindowOrRecompute(params: {
  existingUntil: number | undefined;
  now: number;
  recomputedUntil: number;
}): number {
  const { existingUntil, now, recomputedUntil } = params;
  const hasActiveWindow =
    typeof existingUntil === "number" && Number.isFinite(existingUntil) && existingUntil > now;
  return hasActiveWindow ? existingUntil : recomputedUntil;
}
```

#### 2.2.4 Round-Robin 排序与 Cooldown 分区（`order.ts:143-189`）

排序算法将 profile 分为"可用"和"冷却中"两组，可用组内按类型优先级 + lastUsed 排序：

```typescript
// src/agents/auth-profiles/order.ts:143-189
function orderProfilesByMode(order: string[], store: AuthProfileStore): string[] {
  const now = Date.now();
  const available: string[] = [];
  const inCooldown: string[] = [];

  for (const profileId of order) {
    if (isProfileInCooldown(store, profileId)) {
      inCooldown.push(profileId);
    } else {
      available.push(profileId);
    }
  }

  // 可用 profile：按类型优先级排序（oauth=0 > token=1 > api_key=2）
  // 同类型内按 lastUsed 最久未用优先（round-robin）
  const scored = available.map((profileId) => {
    const type = store.profiles[profileId]?.type;
    const typeScore = type === "oauth" ? 0 : type === "token" ? 1 : type === "api_key" ? 2 : 3;
    const lastUsed = store.usageStats?.[profileId]?.lastUsed ?? 0;
    return { profileId, typeScore, lastUsed };
  });

  const sorted = scored
    .toSorted((a, b) => {
      if (a.typeScore !== b.typeScore) return a.typeScore - b.typeScore;
      return a.lastUsed - b.lastUsed; // oldest first
    })
    .map((entry) => entry.profileId);

  // 冷却中的 profile 追加到末尾，按冷却到期时间排序（最快恢复的优先）
  const cooldownSorted = inCooldown
    .map((profileId) => ({
      profileId,
      cooldownUntil: resolveProfileUnusableUntil(store.usageStats?.[profileId] ?? {}) ?? now,
    }))
    .toSorted((a, b) => a.cooldownUntil - b.cooldownUntil)
    .map((entry) => entry.profileId);

  return [...sorted, ...cooldownSorted];
}
```

#### 2.2.5 OAuth 刷新与文件锁（`oauth.ts:137-194`）

OAuth 刷新操作在文件锁保护下执行，支持 Provider 特定的刷新逻辑：

```typescript
// src/agents/auth-profiles/oauth.ts:137-194
async function refreshOAuthTokenWithLock(params: {
  profileId: string;
  agentDir?: string;
}): Promise<{ apiKey: string; newCredentials: OAuthCredentials } | null> {
  const authPath = resolveAuthStorePath(params.agentDir);
  ensureAuthStoreFile(authPath);

  return await withFileLock(authPath, AUTH_STORE_LOCK_OPTIONS, async () => {
    const store = ensureAuthProfileStore(params.agentDir);
    const cred = store.profiles[params.profileId];
    if (!cred || cred.type !== "oauth") return null;

    // Double-check: 锁内再次检查是否已被其他进程刷新
    if (Date.now() < cred.expires) {
      return { apiKey: buildOAuthApiKey(cred.provider, cred), newCredentials: cred };
    }

    // Provider 特定刷新路由
    const result =
      String(cred.provider) === "chutes"
        ? await refreshChutesTokens({ credential: cred })
        : String(cred.provider) === "qwen-portal"
          ? await refreshQwenPortalCredentials(cred)
          : await getOAuthApiKey(resolveOAuthProvider(cred.provider)!, { [cred.provider]: cred });

    // 刷新成功后立即持久化
    store.profiles[params.profileId] = { ...cred, ...result.newCredentials, type: "oauth" };
    saveAuthProfileStore(store, params.agentDir);
    return result;
  });
}
```

### 2.3 实现细节

#### 文件锁实现（`plugin-sdk/file-lock.ts:103-148`）

文件锁基于 `fs.open(path, 'wx')` 原子创建，具备以下特性：
- **重入支持**：同进程内通过引用计数实现重入（`HELD_LOCKS` Map）
- **Stale 检测**：通过 PID alive 检测 + 创建时间判断锁是否过期（默认 30s stale）
- **指数退避重试**：最多 10 次重试，100ms-10s 退避，支持随机抖动

#### 子 Agent 凭证继承（`store.ts:253-334`）

子 Agent 的 store 加载逻辑：
1. 先尝试加载自己的 `auth-profiles.json`
2. 如果为空，从主 Agent 的 store 克隆一份
3. 最终通过 `mergeAuthProfileStores()` 合并主 Agent 和子 Agent 的 store（子 Agent 覆盖主 Agent）

#### 外部 CLI 凭证同步（`external-cli-sync.ts:89-135`）

每次加载 store 时自动从外部 CLI 工具同步凭证：
- Qwen Code CLI → `qwen-portal:qwen-cli` profile
- MiniMax CLI → `minimax-portal:minimax-cli` profile
- 同步条件：现有凭证不存在、已过期、或外部凭证更新
- TTL 缓存（15 分钟）避免频繁读取外部文件

#### 会话级 Profile 绑定（`session-override.ts:41-151`）

每个会话可以绑定一个特定的 profile，轮转触发条件：
- 新会话开始时自动选择下一个可用 profile
- 会话 compaction（上下文压缩）时触发轮转
- 当前 profile 进入 cooldown 时自动切换

---

## 第 3 章 迁移指南

### 3.1 迁移清单

**阶段 1：基础凭证存储**
- [ ] 定义 `AuthProfileCredential` 联合类型（api_key / token / oauth）
- [ ] 实现 `AuthProfileStore` JSON 文件读写
- [ ] 实现文件锁（`withFileLock`）保护并发写入

**阶段 2：冷却与故障追踪**
- [ ] 实现 `ProfileUsageStats` 数据结构
- [ ] 实现双层冷却：`cooldownUntil`（瞬态）+ `disabledUntil`（持久）
- [ ] 实现指数退避计算（普通 5^n，billing 2^n）
- [ ] 实现冷却窗口不可变性（`keepActiveWindowOrRecompute`）
- [ ] 实现过期冷却自动清理 + 错误计数重置

**阶段 3：排序与轮转**
- [ ] 实现 profile 有效性验证（空 key、过期 token 过滤）
- [ ] 实现可用/冷却分区排序
- [ ] 实现类型优先级 + lastUsed round-robin
- [ ] 实现显式 order 覆盖（config / store）

**阶段 4：OAuth 刷新**
- [ ] 实现 Provider 路由的 OAuth 刷新
- [ ] 实现锁内 double-check 避免重复刷新
- [ ] 实现子 Agent 凭证继承与主 Agent 回退

### 3.2 适配代码模板

以下是一个可直接运行的最小化实现：

```typescript
// auth-profile-store.ts — 最小化凭证轮转实现
import fs from "node:fs";

type CredentialType = "api_key" | "token" | "oauth";

interface Credential {
  type: CredentialType;
  provider: string;
  key?: string;
  token?: string;
  access?: string;
  refresh?: string;
  expires?: number;
}

interface UsageStats {
  lastUsed?: number;
  cooldownUntil?: number;
  disabledUntil?: number;
  errorCount?: number;
}

interface ProfileStore {
  profiles: Record<string, Credential>;
  usageStats: Record<string, UsageStats>;
}

// 指数退避冷却：1min → 5min → 25min → 1h
function calculateCooldownMs(errorCount: number): number {
  const n = Math.max(1, errorCount);
  return Math.min(3_600_000, 60_000 * 5 ** Math.min(n - 1, 3));
}

// 冷却窗口不可变：活跃窗口内不延长
function keepOrRecompute(existing: number | undefined, now: number, recomputed: number): number {
  return existing && existing > now ? existing : recomputed;
}

// 选择最佳 profile：可用优先，类型优先级 oauth > token > api_key
function selectBestProfile(store: ProfileStore, provider: string): string | null {
  const now = Date.now();
  const candidates = Object.entries(store.profiles)
    .filter(([, c]) => c.provider === provider)
    .map(([id, c]) => {
      const stats = store.usageStats[id] ?? {};
      const inCooldown = (stats.cooldownUntil ?? 0) > now || (stats.disabledUntil ?? 0) > now;
      const typeScore = c.type === "oauth" ? 0 : c.type === "token" ? 1 : 2;
      return { id, inCooldown, typeScore, lastUsed: stats.lastUsed ?? 0 };
    });

  const available = candidates.filter((c) => !c.inCooldown);
  const pool = available.length > 0 ? available : candidates;
  pool.sort((a, b) => a.typeScore - b.typeScore || a.lastUsed - b.lastUsed);
  return pool[0]?.id ?? null;
}

// 标记成功：重置所有冷却状态
function markUsed(store: ProfileStore, profileId: string): void {
  store.usageStats[profileId] = {
    ...store.usageStats[profileId],
    lastUsed: Date.now(),
    errorCount: 0,
    cooldownUntil: undefined,
    disabledUntil: undefined,
  };
}

// 标记失败：计算冷却时间
function markFailed(store: ProfileStore, profileId: string, isBilling: boolean): void {
  const now = Date.now();
  const stats = store.usageStats[profileId] ?? {};
  const errorCount = (stats.errorCount ?? 0) + 1;

  if (isBilling) {
    const backoff = Math.min(86_400_000, 18_000_000 * 2 ** Math.min(errorCount - 1, 10));
    store.usageStats[profileId] = {
      ...stats, errorCount,
      disabledUntil: keepOrRecompute(stats.disabledUntil, now, now + backoff),
    };
  } else {
    store.usageStats[profileId] = {
      ...stats, errorCount,
      cooldownUntil: keepOrRecompute(stats.cooldownUntil, now, now + calculateCooldownMs(errorCount)),
    };
  }
}
```

### 3.3 适用场景

| 场景 | 适用度 | 说明 |
|------|--------|------|
| 多 Provider LLM 网关 | ⭐⭐⭐ | 核心场景：多个 API Key 轮转避免 rate limit |
| 单 Provider 多 Key | ⭐⭐⭐ | 团队共享多个 Key，自动负载均衡 |
| OAuth + API Key 混合 | ⭐⭐⭐ | OAuth 优先使用，API Key 作为降级备选 |
| 单 Key 简单场景 | ⭐ | 过度设计，直接用环境变量即可 |
| 高频交易/低延迟 | ⭐⭐ | 文件锁有 IO 开销，可改用内存锁 |

---

## 第 4 章 测试用例

基于 OpenClaw 真实函数签名的测试代码：

```typescript
import { describe, it, expect, beforeEach } from "vitest";

// 模拟 OpenClaw 的核心函数签名
function calculateAuthProfileCooldownMs(errorCount: number): number {
  const normalized = Math.max(1, errorCount);
  return Math.min(60 * 60 * 1000, 60 * 1000 * 5 ** Math.min(normalized - 1, 3));
}

function keepActiveWindowOrRecompute(params: {
  existingUntil: number | undefined;
  now: number;
  recomputedUntil: number;
}): number {
  const hasActiveWindow =
    typeof params.existingUntil === "number" && params.existingUntil > params.now;
  return hasActiveWindow ? params.existingUntil : params.recomputedUntil;
}

type ProfileUsageStats = {
  lastUsed?: number;
  cooldownUntil?: number;
  disabledUntil?: number;
  errorCount?: number;
};

function clearExpiredCooldowns(
  usageStats: Record<string, ProfileUsageStats>,
  now: number,
): boolean {
  let mutated = false;
  for (const [id, stats] of Object.entries(usageStats)) {
    if (stats.cooldownUntil && now >= stats.cooldownUntil) {
      stats.cooldownUntil = undefined;
      stats.errorCount = 0;
      mutated = true;
    }
    if (stats.disabledUntil && now >= stats.disabledUntil) {
      stats.disabledUntil = undefined;
      mutated = true;
    }
  }
  return mutated;
}

describe("Auth Profile Cooldown", () => {
  it("指数退避：1min → 5min → 25min → 1h", () => {
    expect(calculateAuthProfileCooldownMs(1)).toBe(60_000);       // 1 min
    expect(calculateAuthProfileCooldownMs(2)).toBe(300_000);      // 5 min
    expect(calculateAuthProfileCooldownMs(3)).toBe(1_500_000);    // 25 min
    expect(calculateAuthProfileCooldownMs(4)).toBe(3_600_000);    // 1 hour (max)
    expect(calculateAuthProfileCooldownMs(100)).toBe(3_600_000);  // still max
  });

  it("冷却窗口不可变：活跃窗口内重试不延长", () => {
    const now = 1000;
    const existingUntil = 2000; // 活跃窗口
    const recomputed = 3000;    // 新计算的更长窗口

    expect(keepActiveWindowOrRecompute({
      existingUntil, now, recomputedUntil: recomputed,
    })).toBe(2000); // 保持原窗口，不延长
  });

  it("冷却窗口过期后重新计算", () => {
    const now = 3000;
    const existingUntil = 2000; // 已过期
    const recomputed = 4000;

    expect(keepActiveWindowOrRecompute({
      existingUntil, now, recomputedUntil: recomputed,
    })).toBe(4000); // 使用新计算值
  });

  it("过期冷却自动清理并重置错误计数", () => {
    const now = 5000;
    const stats: Record<string, ProfileUsageStats> = {
      "openai:key1": { cooldownUntil: 3000, errorCount: 5 },
      "openai:key2": { cooldownUntil: 8000, errorCount: 2 },
    };

    const mutated = clearExpiredCooldowns(stats, now);
    expect(mutated).toBe(true);
    expect(stats["openai:key1"]!.cooldownUntil).toBeUndefined();
    expect(stats["openai:key1"]!.errorCount).toBe(0);  // 重置
    expect(stats["openai:key2"]!.cooldownUntil).toBe(8000); // 未过期，保持
    expect(stats["openai:key2"]!.errorCount).toBe(2);       // 保持
  });

  it("errorCount 为 0 时退避仍为 1min（归一化）", () => {
    expect(calculateAuthProfileCooldownMs(0)).toBe(60_000);
    expect(calculateAuthProfileCooldownMs(-1)).toBe(60_000);
  });
});
```

---

<!-- APPEND_MARKER_6 -->
