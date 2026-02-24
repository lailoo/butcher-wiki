# PD-34.01 OpenClaw — ChannelPlugin 适配器 + Gateway 双模投递多渠道消息网关

> 文档编号：PD-34.01
> 来源：OpenClaw `src/channels/plugins/types.plugin.ts`, `src/gateway/server-channels.ts`
> GitHub：https://github.com/openclaw/openclaw
> 问题域：PD-34 多渠道消息网关 Multi-Channel Messaging Gateway
> 状态：可复用方案

---

## 第 1 章 问题与动机

### 1.1 核心问题

Agent 系统需要同时接入多个即时通讯渠道（Telegram、WhatsApp、Discord、Slack、Signal、iMessage、IRC、Google Chat 等），每个渠道有不同的 API 协议、消息格式、认证方式、能力集（投票、反应、线程、媒体）和限制（消息长度、速率）。核心挑战是：

1. **渠道差异巨大**：Telegram 用 Bot API + HTML 格式，WhatsApp 用 QR 链接 + 纯文本，Discord 用 Bot API + Markdown，Signal 用 signal-cli + 富文本样式——每个渠道的消息格式化、分块、媒体处理逻辑完全不同
2. **生命周期管理复杂**：渠道连接可能断开、认证过期、服务不可用，需要自动重连和健康监控
3. **投递路径多样**：有些渠道可以进程内直接发送（direct），有些必须通过 Gateway RPC 中转（gateway），还有混合模式
4. **跨渠道会话绑定**：用户可能从 Telegram 发起对话，但 Agent 需要通过 WhatsApp 回复——需要会话绑定和路由

### 1.2 OpenClaw 的解法概述

OpenClaw 设计了一套 **ChannelPlugin 适配器体系 + Gateway 双模投递架构**：

1. **ChannelPlugin 接口**（`types.plugin.ts:49-85`）：定义了 ~20 个可选适配器槽位（config、setup、outbound、gateway、security、threading 等），每个渠道实现自己的适配器子集
2. **三层渠道抽象**：Registry（静态元数据）→ Dock（轻量行为）→ Plugin（完整实现），按需加载避免启动时拉入所有渠道的重依赖
3. **双模投递**：`deliveryMode: "direct" | "gateway" | "hybrid"`，direct 模式进程内发送，gateway 模式通过 WebSocket RPC 中转
4. **ChannelManager 生命周期管理**（`server-channels.ts:80-414`）：指数退避自动重启（5s→5min，最多 10 次），配合 HealthMonitor 定期巡检
5. **插件目录发现**（`catalog.ts`）：支持 bundled/global/workspace/config 四级来源，优先级去重，支持 38+ 外部扩展渠道

### 1.3 设计思想

| 设计原则 | 具体实现 | 理由 | 替代方案 |
|----------|----------|------|----------|
| 适配器模式 | ChannelPlugin 接口 ~20 个可选槽位 | 每个渠道只实现需要的能力，不强制全部实现 | 继承体系（过于僵硬） |
| 三层渐进加载 | Registry→Dock→Plugin 分离 | 避免 import 一个渠道就拉入所有重依赖（puppeteer、web login 等） | 单层 Plugin（启动慢） |
| 双模投递 | direct/gateway/hybrid deliveryMode | 本地渠道直接发送，远程渠道通过 Gateway RPC | 统一 Gateway（增加延迟） |
| 指数退避重启 | 5s→5min factor=2 jitter=0.1 max=10 | 避免雪崩式重连，给服务恢复时间 | 固定间隔（不够弹性） |
| 写前日志投递 | enqueueDelivery → send → ackDelivery | 崩溃恢复：发送前持久化，成功后清除 | 无持久化（消息丢失） |

---

## 第 2 章 源码实现分析

### 2.1 架构概览

```
┌─────────────────────────────────────────────────────────────────┐
│                        OpenClaw Core                            │
│                                                                 │
│  ┌──────────┐   ┌──────────────┐   ┌─────────────────────────┐ │
│  │ Registry │──→│  Dock (轻量)  │──→│  ChannelPlugin (完整)   │ │
│  │ 8 核心渠道│   │ 行为+元数据   │   │ ~20 适配器槽位          │ │
│  └──────────┘   └──────────────┘   └────────┬────────────────┘ │
│                                              │                  │
│  ┌───────────────────────────────────────────┼────────────────┐ │
│  │              Outbound Delivery            │                │ │
│  │                                           ▼                │ │
│  │  ┌─────────┐   ┌──────────────┐   ┌─────────────┐         │ │
│  │  │ Message │──→│ Channel      │──→│ Outbound    │         │ │
│  │  │ Gateway │   │ Selection    │   │ Adapter     │         │ │
│  │  └─────────┘   └──────────────┘   └──────┬──────┘         │ │
│  │                                          │                 │ │
│  │                    ┌─────────────────────┼───────┐         │ │
│  │                    │                     │       │         │ │
│  │                    ▼                     ▼       ▼         │ │
│  │              ┌──────────┐         ┌────────┐ ┌──────┐     │ │
│  │              │  direct   │         │gateway │ │hybrid│     │ │
│  │              │ (进程内)  │         │ (RPC)  │ │      │     │ │
│  │              └──────────┘         └────────┘ └──────┘     │ │
│  └────────────────────────────────────────────────────────────┘ │
│                                                                 │
│  ┌────────────────────┐   ┌──────────────────────────────────┐ │
│  │  ChannelManager    │   │  HealthMonitor                   │ │
│  │  · startAccount    │   │  · 5min 巡检间隔                 │ │
│  │  · stopAccount     │   │  · 60s 启动宽限                  │ │
│  │  · 指数退避重启    │   │  · 3次/小时 重启限制             │ │
│  │  · 手动停止追踪    │   │  · cooldown 冷却周期             │ │
│  └────────────────────┘   └──────────────────────────────────┘ │
│                                                                 │
│  ┌────────────────────┐   ┌──────────────────────────────────┐ │
│  │  Plugin Catalog    │   │  Session Binding Router          │ │
│  │  · bundled (优先3) │   │  · 跨渠道会话绑定               │ │
│  │  · global  (优先2) │   │  · requester 匹配               │ │
│  │  · workspace(优先1)│   │  · fallback 降级                 │ │
│  │  · config  (优先0) │   │                                  │ │
│  └────────────────────┘   └──────────────────────────────────┘ │
│                                                                 │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  38+ Extension Plugins                                   │   │
│  │  Feishu · LINE · Matrix · MS Teams · Nostr · Zalo · ...  │   │
│  └──────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

### 2.2 核心实现

#### 2.2.1 ChannelPlugin 接口：~20 个适配器槽位

ChannelPlugin 是整个多渠道体系的核心契约，定义在 `src/channels/plugins/types.plugin.ts:49-85`：

```typescript
// src/channels/plugins/types.plugin.ts:49-85
export type ChannelPlugin<ResolvedAccount = any, Probe = unknown, Audit = unknown> = {
  id: ChannelId;
  meta: ChannelMeta;
  capabilities: ChannelCapabilities;
  defaults?: { queue?: { debounceMs?: number } };
  reload?: { configPrefixes: string[]; noopPrefixes?: string[] };
  onboarding?: ChannelOnboardingAdapter;    // CLI 引导向导
  config: ChannelConfigAdapter<ResolvedAccount>;  // 账户配置（必选）
  configSchema?: ChannelConfigSchema;
  setup?: ChannelSetupAdapter;              // 初始化设置
  pairing?: ChannelPairingAdapter;          // 设备配对
  security?: ChannelSecurityAdapter<ResolvedAccount>;  // DM 安全策略
  groups?: ChannelGroupAdapter;             // 群组行为
  mentions?: ChannelMentionAdapter;         // @提及处理
  outbound?: ChannelOutboundAdapter;        // 出站发送（核心）
  status?: ChannelStatusAdapter<ResolvedAccount, Probe, Audit>;  // 状态探测
  gateway?: ChannelGatewayAdapter<ResolvedAccount>;  // 网关生命周期
  auth?: ChannelAuthAdapter;                // 认证流程
  streaming?: ChannelStreamingAdapter;      // 流式输出
  threading?: ChannelThreadingAdapter;      // 线程/话题
  messaging?: ChannelMessagingAdapter;      // 目标解析
  directory?: ChannelDirectoryAdapter;      // 联系人目录
  resolver?: ChannelResolverAdapter;        // 目标解析器
  actions?: ChannelMessageActionAdapter;    // 消息动作
  heartbeat?: ChannelHeartbeatAdapter;      // 心跳检测
  agentTools?: ChannelAgentToolFactory | ChannelAgentTool[];  // Agent 工具
};
```

关键设计：所有适配器槽位（除 `id`、`meta`、`capabilities`、`config`）都是可选的。一个最简渠道只需实现 `config` + `outbound`。

#### 2.2.2 三层渐进加载

OpenClaw 将渠道信息分为三层，避免启动时加载所有重依赖：

**第一层 Registry**（`src/channels/registry.ts:7-16`）：纯静态元数据，零依赖

```typescript
// src/channels/registry.ts:7-16
export const CHAT_CHANNEL_ORDER = [
  "telegram", "whatsapp", "discord", "irc",
  "googlechat", "slack", "signal", "imessage",
] as const;
```

**第二层 Dock**（`src/channels/dock.ts:229-564`）：轻量行为（allowFrom 格式化、mention 剥离、threading 默认值），不引入 monitor/puppeteer/web login

**第三层 Plugin**（`src/channels/plugins/*.ts`）：完整实现，包含 gateway 启动、状态探测、QR 登录等重逻辑

#### 2.2.3 双模投递：direct vs gateway

出站适配器通过 `deliveryMode` 声明投递路径（`src/channels/plugins/types.adapters.ts:97-114`）：

```typescript
// src/channels/plugins/types.adapters.ts:97-114
export type ChannelOutboundAdapter = {
  deliveryMode: "direct" | "gateway" | "hybrid";
  chunker?: ((text: string, limit: number) => string[]) | null;
  chunkerMode?: "text" | "markdown";
  textChunkLimit?: number;
  pollMaxOptions?: number;
  resolveTarget?: (params: { ... }) => { ok: true; to: string } | { ok: false; error: Error };
  sendPayload?: (ctx: ChannelOutboundPayloadContext) => Promise<OutboundDeliveryResult>;
  sendText?: (ctx: ChannelOutboundContext) => Promise<OutboundDeliveryResult>;
  sendMedia?: (ctx: ChannelOutboundContext) => Promise<OutboundDeliveryResult>;
  sendPoll?: (ctx: ChannelPollContext) => Promise<ChannelPollResult>;
};
```

`sendMessage`（`src/infra/outbound/message.ts:166-268`）根据 `deliveryMode` 分流：
- **direct**：调用 `deliverOutboundPayloads` → `createChannelHandler` → 插件的 `sendText`/`sendMedia`
- **gateway**：调用 `callMessageGateway` → WebSocket RPC → 远端 Gateway 服务器执行发送

#### 2.2.4 ChannelManager 生命周期管理

`createChannelManager`（`src/gateway/server-channels.ts:80-414`）管理所有渠道的启停和自动重启：

```typescript
// src/gateway/server-channels.ts:12-18
const CHANNEL_RESTART_POLICY: BackoffPolicy = {
  initialMs: 5_000,     // 首次重启等待 5 秒
  maxMs: 5 * 60_000,    // 最大等待 5 分钟
  factor: 2,            // 指数因子
  jitter: 0.1,          // 10% 抖动
};
const MAX_RESTART_ATTEMPTS = 10;  // 最多重启 10 次
```

核心流程（`server-channels.ts:118-264`）：
1. 遍历所有账户，检查 `isEnabled` + `isConfigured`
2. 创建 `AbortController`，调用 `plugin.gateway.startAccount(ctx)`
3. 启动后 `.catch` 记录错误，`.finally` 标记 `running: false`
4. `.then` 中检查是否手动停止，否则执行指数退避重启
5. 重启前检查 `manuallyStopped` 集合，避免重启被用户手动停止的渠道

#### 2.2.5 HealthMonitor 定期巡检

`startChannelHealthMonitor`（`src/gateway/channel-health-monitor.ts:53-177`）独立于 ChannelManager 的自动重启，提供额外的健康保障：

```typescript
// src/gateway/channel-health-monitor.ts:7-11
const DEFAULT_CHECK_INTERVAL_MS = 5 * 60_000;      // 5 分钟巡检
const DEFAULT_STARTUP_GRACE_MS = 60_000;            // 启动后 60 秒宽限
const DEFAULT_COOLDOWN_CYCLES = 2;                  // 冷却 2 个周期
const DEFAULT_MAX_RESTARTS_PER_HOUR = 3;            // 每小时最多重启 3 次
```

巡检逻辑：遍历所有 `channelAccounts`，对 `enabled && configured && (!running || connected===false)` 的账户触发重启，但受 cooldown 和每小时限制约束。

### 2.3 实现细节

#### 2.3.1 插件目录发现与优先级

`listChannelPluginCatalogEntries`（`src/channels/plugins/catalog.ts:259-296`）实现四级来源发现：

```typescript
// src/channels/plugins/catalog.ts:41-46
const ORIGIN_PRIORITY: Record<PluginOrigin, number> = {
  config: 0,      // 最高优先级：用户配置
  workspace: 1,   // 工作区插件
  global: 2,      // 全局安装
  bundled: 3,     // 内置
};
```

同一 `id` 的插件，低优先级数字的来源覆盖高优先级数字的来源。外部目录（`mpm/plugins.json`、`mpm/catalog.json`）作为补充，不覆盖已发现的插件。

#### 2.3.2 写前日志投递队列

`deliverOutboundPayloads`（`src/infra/outbound/deliver.ts:226-284`）实现了写前日志模式：

1. `enqueueDelivery()` — 发送前持久化到队列
2. `deliverOutboundPayloadsCore()` — 实际发送
3. `ackDelivery()` / `failDelivery()` — 成功/失败后清理

这确保了进程崩溃时消息不会丢失，可以从队列恢复重发。

#### 2.3.3 跨渠道会话绑定路由

`createBoundDeliveryRouter`（`src/infra/outbound/bound-delivery-router.ts:55-131`）实现跨渠道消息路由：

1. 根据 `targetSessionKey` 查找活跃绑定
2. 如果有 `requester`，优先匹配同渠道同账户的绑定
3. 精确匹配 `conversationId`，否则回退到同渠道唯一绑定
4. 无匹配时根据 `failClosed` 决定是否降级

#### 2.3.4 设备配对 QR 码流程

`extensions/device-pair/index.ts:461-644` 实现了移动端配对：

1. `/pair` 命令生成 setup code（Base64URL 编码的 `{url, token, password}`）
2. `/pair qr` 渲染 ASCII QR 码（通过 `qrcode-terminal` 库）
3. `/pair approve` 审批待处理的配对请求
4. 支持 Tailscale/LAN/自定义 URL 多种网络拓扑

---

## 第 3 章 迁移指南

### 3.1 迁移清单

**阶段 1：核心接口定义**
- [ ] 定义 `ChannelPlugin` 接口，至少包含 `id`、`meta`、`capabilities`、`config`、`outbound` 五个必要槽位
- [ ] 定义 `ChannelOutboundAdapter`，包含 `deliveryMode`、`sendText`、`sendMedia`
- [ ] 定义 `ChannelCapabilities` 类型，声明每个渠道支持的能力

**阶段 2：渠道注册与发现**
- [ ] 实现渠道注册表（静态 + 动态插件发现）
- [ ] 实现优先级去重逻辑（config > workspace > global > bundled）

**阶段 3：出站投递管道**
- [ ] 实现 `sendMessage` 统一入口，根据 `deliveryMode` 分流
- [ ] 实现消息分块（chunker）+ 媒体处理
- [ ] 实现写前日志队列（可选但推荐）

**阶段 4：生命周期管理**
- [ ] 实现 ChannelManager（启停 + 指数退避重启）
- [ ] 实现 HealthMonitor（定期巡检 + 限流）

### 3.2 适配代码模板

```typescript
// === 核心接口 ===
type ChannelPlugin<TAccount = unknown> = {
  id: string;
  meta: { label: string; blurb: string };
  capabilities: {
    chatTypes: Array<"direct" | "group" | "channel" | "thread">;
    media?: boolean;
    polls?: boolean;
    reactions?: boolean;
  };
  config: {
    listAccountIds: (cfg: AppConfig) => string[];
    resolveAccount: (cfg: AppConfig, accountId?: string | null) => TAccount;
    isEnabled?: (account: TAccount, cfg: AppConfig) => boolean;
    isConfigured?: (account: TAccount, cfg: AppConfig) => boolean | Promise<boolean>;
  };
  outbound?: {
    deliveryMode: "direct" | "gateway";
    textChunkLimit?: number;
    sendText: (ctx: OutboundContext) => Promise<DeliveryResult>;
    sendMedia: (ctx: OutboundContext) => Promise<DeliveryResult>;
  };
  gateway?: {
    startAccount: (ctx: GatewayContext<TAccount>) => Promise<void>;
    stopAccount?: (ctx: GatewayContext<TAccount>) => Promise<void>;
  };
};

// === 渠道管理器 ===
type BackoffPolicy = { initialMs: number; maxMs: number; factor: number; jitter: number };

function createChannelManager(plugins: ChannelPlugin[], loadConfig: () => AppConfig) {
  const restartAttempts = new Map<string, number>();
  const manuallyStopped = new Set<string>();
  const MAX_RESTARTS = 10;
  const POLICY: BackoffPolicy = { initialMs: 5000, maxMs: 300_000, factor: 2, jitter: 0.1 };

  async function startChannel(plugin: ChannelPlugin, accountId: string) {
    if (!plugin.gateway?.startAccount) return;
    const cfg = loadConfig();
    const account = plugin.config.resolveAccount(cfg, accountId);
    const abort = new AbortController();

    try {
      await plugin.gateway.startAccount({
        cfg, accountId, account, abortSignal: abort.signal,
        getStatus: () => ({ accountId, running: true }),
        setStatus: () => {},
      });
    } catch (err) {
      const key = `${plugin.id}:${accountId}`;
      const attempt = (restartAttempts.get(key) ?? 0) + 1;
      restartAttempts.set(key, attempt);
      if (attempt <= MAX_RESTARTS && !manuallyStopped.has(key)) {
        const delay = Math.min(
          POLICY.initialMs * POLICY.factor ** (attempt - 1),
          POLICY.maxMs
        ) * (1 + (Math.random() - 0.5) * POLICY.jitter * 2);
        await new Promise(r => setTimeout(r, delay));
        await startChannel(plugin, accountId);
      }
    }
  }

  return { startChannel, stopChannel: (id: string, accountId: string) => {
    manuallyStopped.add(`${id}:${accountId}`);
  }};
}

// === 健康监控器 ===
function createHealthMonitor(manager: ReturnType<typeof createChannelManager>, opts?: {
  intervalMs?: number; maxRestartsPerHour?: number;
}) {
  const intervalMs = opts?.intervalMs ?? 300_000;
  const maxPerHour = opts?.maxRestartsPerHour ?? 3;
  const restarts = new Map<string, number[]>();

  const timer = setInterval(async () => {
    // 遍历渠道快照，对不健康的触发重启（受限流约束）
  }, intervalMs);

  return { stop: () => clearInterval(timer) };
}
```

### 3.3 适用场景

| 场景 | 适用度 | 说明 |
|------|--------|------|
| 多渠道 AI 助手 | ⭐⭐⭐ | 核心场景：同时接入 5+ 即时通讯渠道 |
| 客服机器人 | ⭐⭐⭐ | 需要跨渠道会话绑定和统一消息格式 |
| 通知推送系统 | ⭐⭐ | 只需出站投递，不需要完整的双向通信 |
| 单渠道 Bot | ⭐ | 过度设计，直接用渠道 SDK 即可 |

---

## 第 4 章 测试用例

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";

// === ChannelPlugin 接口合规测试 ===
describe("ChannelPlugin contract", () => {
  const mockPlugin: ChannelPlugin = {
    id: "test-channel",
    meta: { label: "Test", blurb: "test channel" },
    capabilities: { chatTypes: ["direct", "group"] },
    config: {
      listAccountIds: () => ["default"],
      resolveAccount: (_, id) => ({ id: id ?? "default", token: "tok_xxx" }),
      isEnabled: () => true,
      isConfigured: () => true,
    },
    outbound: {
      deliveryMode: "direct",
      textChunkLimit: 4000,
      sendText: vi.fn().mockResolvedValue({ channel: "test", messageId: "msg_1" }),
      sendMedia: vi.fn().mockResolvedValue({ channel: "test", messageId: "msg_2" }),
    },
  };

  it("should list account IDs from config", () => {
    expect(mockPlugin.config.listAccountIds({} as any)).toEqual(["default"]);
  });

  it("should resolve account by ID", () => {
    const account = mockPlugin.config.resolveAccount({} as any, "default");
    expect(account).toHaveProperty("token");
  });

  it("should send text via outbound adapter", async () => {
    const result = await mockPlugin.outbound!.sendText!({
      cfg: {} as any, to: "user123", text: "hello",
    } as any);
    expect(result.messageId).toBe("msg_1");
  });
});

// === ChannelManager 重启逻辑测试 ===
describe("ChannelManager restart policy", () => {
  it("should apply exponential backoff on restart", () => {
    const policy = { initialMs: 5000, maxMs: 300_000, factor: 2, jitter: 0 };
    const delays = [1, 2, 3, 4, 5].map(attempt =>
      Math.min(policy.initialMs * policy.factor ** (attempt - 1), policy.maxMs)
    );
    expect(delays).toEqual([5000, 10000, 20000, 40000, 80000]);
  });

  it("should cap at maxMs", () => {
    const policy = { initialMs: 5000, maxMs: 300_000, factor: 2, jitter: 0 };
    const delay = Math.min(policy.initialMs * policy.factor ** 9, policy.maxMs);
    expect(delay).toBe(300_000);
  });

  it("should not restart manually stopped channels", () => {
    const stopped = new Set(["telegram:default"]);
    expect(stopped.has("telegram:default")).toBe(true);
  });
});

// === HealthMonitor 限流测试 ===
describe("HealthMonitor rate limiting", () => {
  it("should enforce max restarts per hour", () => {
    const maxPerHour = 3;
    const restarts = [
      { at: Date.now() - 30 * 60_000 },
      { at: Date.now() - 20 * 60_000 },
      { at: Date.now() - 10 * 60_000 },
    ];
    const recentRestarts = restarts.filter(r => Date.now() - r.at < 60 * 60_000);
    expect(recentRestarts.length).toBe(3);
    expect(recentRestarts.length >= maxPerHour).toBe(true); // 应跳过重启
  });

  it("should respect cooldown period", () => {
    const cooldownMs = 2 * 300_000; // 2 cycles × 5min
    const lastRestartAt = Date.now() - 500_000; // 8.3 min ago
    expect(Date.now() - lastRestartAt > cooldownMs).toBe(false); // 仍在冷却
  });
});

// === 插件目录优先级测试 ===
describe("Plugin catalog priority", () => {
  it("should prefer config over bundled", () => {
    const priorities = { config: 0, workspace: 1, global: 2, bundled: 3 };
    expect(priorities.config < priorities.bundled).toBe(true);
  });

  it("should deduplicate by ID keeping highest priority", () => {
    const candidates = [
      { id: "telegram", origin: "bundled", priority: 3 },
      { id: "telegram", origin: "config", priority: 0 },
    ];
    const resolved = new Map<string, typeof candidates[0]>();
    for (const c of candidates) {
      const existing = resolved.get(c.id);
      if (!existing || c.priority < existing.priority) {
        resolved.set(c.id, c);
      }
    }
    expect(resolved.get("telegram")!.origin).toBe("config");
  });
});

// === 会话绑定路由测试 ===
describe("BoundDeliveryRouter", () => {
  it("should match requester by channel + accountId + conversationId", () => {
    const bindings = [
      { status: "active", conversation: { channel: "telegram", accountId: "a1", conversationId: "c1" } },
      { status: "active", conversation: { channel: "whatsapp", accountId: "a2", conversationId: "c2" } },
    ];
    const requester = { channel: "telegram", accountId: "a1", conversationId: "c1" };
    const match = bindings.find(b =>
      b.conversation.channel === requester.channel &&
      b.conversation.accountId === requester.accountId &&
      b.conversation.conversationId === requester.conversationId
    );
    expect(match).toBeDefined();
    expect(match!.conversation.channel).toBe("telegram");
  });

  it("should fallback to single active binding when no requester", () => {
    const bindings = [
      { status: "active", conversation: { channel: "telegram", accountId: "a1", conversationId: "c1" } },
    ];
    expect(bindings.length).toBe(1);
    // 单一活跃绑定时直接使用
  });
});
```

---

## 第 5 章 跨域关联

| 关联域 | 关系类型 | 说明 |
|--------|----------|------|
| PD-04 工具系统 | 协同 | ChannelPlugin 的 `agentTools` 槽位允许渠道注册自己的 Agent 工具（如 `/pair` 命令） |
| PD-10 中间件管道 | 协同 | 出站投递管道中的 `message_sending` / `message_sent` hook 是中间件模式的应用 |
| PD-03 容错与重试 | 依赖 | ChannelManager 的指数退避重启和 HealthMonitor 是容错机制的具体实现 |
| PD-09 Human-in-the-Loop | 协同 | 设备配对的 `/pair approve` 流程是人工审批的典型场景 |
| PD-05 沙箱隔离 | 协同 | 渠道的 `security` 适配器实现 DM 策略和 allowFrom 白名单，是安全隔离的一部分 |
| PD-11 可观测性 | 协同 | ChannelManager 的 `setRuntime` 持续更新渠道状态快照，HealthMonitor 的日志提供运行时可观测性 |

---

## 第 6 章 来源文件索引

| 文件 | 行范围 | 关键实现 |
|------|--------|----------|
| `src/channels/plugins/types.plugin.ts` | L49-85 | ChannelPlugin 核心接口定义（~20 适配器槽位） |
| `src/channels/plugins/types.adapters.ts` | L23-311 | 所有适配器类型定义（Setup/Config/Outbound/Gateway/Status/Security 等） |
| `src/channels/plugins/types.core.ts` | L1-372 | 核心类型（ChannelMeta/Capabilities/AccountSnapshot/ThreadingContext 等） |
| `src/channels/registry.ts` | L7-190 | 8 核心渠道注册表 + 别名 + 元数据 |
| `src/channels/dock.ts` | L229-644 | 8 渠道的轻量 Dock 定义 + 插件 Dock 构建 |
| `src/channels/plugins/catalog.ts` | L41-307 | 插件目录发现（四级来源 + 优先级去重） |
| `src/infra/outbound/message.ts` | L22-340 | MessageGateway 统一发送入口（direct/gateway 分流） |
| `src/infra/outbound/deliver.ts` | L120-602 | 出站投递核心（写前日志 + 分块 + 媒体 + hook） |
| `src/infra/outbound/channel-selection.ts` | L1-93 | 渠道自动选择（单渠道自动、多渠道要求显式指定） |
| `src/infra/outbound/bound-delivery-router.ts` | L1-131 | 跨渠道会话绑定路由 |
| `src/infra/outbound/targets.ts` | L57-381 | 出站目标解析（session/heartbeat/explicit 模式） |
| `src/gateway/server-channels.ts` | L12-414 | ChannelManager 生命周期管理（指数退避重启） |
| `src/gateway/channel-health-monitor.ts` | L1-177 | 健康监控器（5min 巡检 + 限流） |
| `src/channels/plugins/outbound/telegram.ts` | L39-124 | Telegram 出站适配器示例（HTML 格式 + 4000 字分块） |
| `src/channels/plugins/outbound/load.ts` | L1-17 | 出站适配器懒加载器 |
| `extensions/device-pair/index.ts` | L461-644 | 设备配对插件（QR 码 + setup code + approve 流程） |

---

## 第 7 章 横向对比维度

```json comparison_data
{
  "project": "OpenClaw",
  "dimensions": {
    "渠道注册方式": "ChannelPlugin接口~20适配器槽位+四级来源插件目录发现",
    "消息投递模式": "双模投递(direct进程内/gateway RPC)+写前日志队列",
    "渠道生命周期": "ChannelManager指数退避重启(5s→5min max10)+HealthMonitor定期巡检(5min/3次每小时)",
    "渠道扩展性": "38+外部扩展插件+openclaw.plugin.json清单+npm/local双安装模式",
    "会话路由": "SessionBinding跨渠道绑定+requester匹配+failClosed降级策略",
    "渐进加载": "三层分离Registry→Dock→Plugin避免启动时加载重依赖"
  }
}
```

### 域元数据补充

```json domain_metadata
{
  "solution_summary": "OpenClaw用ChannelPlugin接口(~20适配器槽位)+双模投递(direct/gateway)+四级插件目录发现+指数退避ChannelManager实现8+38渠道消息网关",
  "description": "多渠道消息网关需要解决渐进加载、双模投递路径选择和跨渠道会话绑定问题",
  "sub_problems": [
    "渐进加载避免启动时拉入所有渠道重依赖",
    "写前日志保证崩溃恢复不丢消息",
    "跨渠道会话绑定与路由",
    "插件目录四级来源优先级去重"
  ],
  "best_practices": [
    "三层分离(Registry→Dock→Plugin)按需加载渠道实现",
    "双模投递(direct/gateway)适配本地和远程渠道",
    "写前日志队列(enqueue→send→ack)保证消息不丢失",
    "HealthMonitor独立于自动重启提供额外健康保障(cooldown+每小时限制)"
  ]
}
```
