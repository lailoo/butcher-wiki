# PD-34.01 OpenClaw — 多渠道消息网关插件化架构

> 文档编号：PD-34.01
> 来源：OpenClaw `src/channels/plugins/types.plugin.ts`, `src/channels/dock.ts`, `src/gateway/channel-health-monitor.ts`
> GitHub：https://github.com/openclaw/openclaw
> 问题域：PD-34 多渠道消息网关 Multi-Channel Messaging
> 状态：可复用方案

---

## 第 1 章 问题与动机

### 1.1 核心问题

AI Agent 需要通过多种即时通讯渠道（Telegram、WhatsApp、Discord、Slack、Signal、iMessage、飞书、Line 等）与用户交互。每个渠道有不同的 API 协议、消息格式、能力限制（线程、反应、投票、媒体）和认证方式。核心挑战在于：

- **协议碎片化**：38+ 渠道各有独立 API，消息格式、发送限制、线程模型完全不同
- **能力差异**：有的渠道支持投票/反应/线程，有的不支持；文本长度限制从 350（IRC）到 4000（Telegram）不等
- **生命周期管理**：渠道连接需要启动、停止、健康检查、自动重启，且每个渠道可有多个账号
- **消息路由**：入站消息需要统一归一化后分发，出站消息需要按渠道适配格式再投递

### 1.2 OpenClaw 的解法概述

OpenClaw 采用**三层插件化架构**解决多渠道问题：

1. **ChannelPlugin 全量接口**（`src/channels/plugins/types.plugin.ts:49`）：定义 25+ 个可选适配器槽位，每个渠道按需实现
2. **ChannelDock 轻量元数据**（`src/channels/dock.ts:47`）：从 Plugin 中提取配置/线程/分组等轻量信息，供共享代码路径使用，避免加载重型依赖
3. **Extension 动态注册**（`src/channels/plugins/index.ts:12`）：渠道通过 extensions/ 目录动态注册，运行时去重排序后统一暴露

出站投递通过 `deliverOutboundPayloads`（`src/infra/outbound/deliver.ts:226`）统一入口，内部按渠道加载对应的 OutboundAdapter 执行分块和发送。

健康监控通过 `startChannelHealthMonitor`（`src/gateway/channel-health-monitor.ts:53`）定时巡检所有渠道账号，自动重启不健康的连接，带 cooldown 和限流保护。

### 1.3 设计思想

| 设计原则 | 具体实现 | 理由 | 替代方案 |
|----------|----------|------|----------|
| 适配器模式 | ChannelPlugin 定义 25+ 可选适配器槽位 | 每个渠道只实现需要的能力，零耦合 | 继承体系（僵化） |
| 轻重分离 | Dock（轻）vs Plugin（重）两层抽象 | 共享代码路径不加载 monitor/gateway 等重型模块 | 单层抽象（启动慢） |
| 能力声明 | ChannelCapabilities 显式声明支持的功能 | 上层代码按能力分支，不按渠道名硬编码 | if/switch 渠道名（脆弱） |
| 多账号支持 | 每个渠道可配置多个 accountId | 同一渠道多 bot/多号场景 | 单账号（不够灵活） |
| 写前日志 | 出站投递前 enqueueDelivery 持久化 | 崩溃恢复时可重投未确认消息 | 纯内存（丢消息） |

---

## 第 2 章 源码实现分析

### 2.1 架构概览

```
┌─────────────────────────────────────────────────────────────────┐
│                        Gateway Server                           │
│  ┌──────────────────┐  ┌──────────────────┐  ┌───────────────┐ │
│  │ ChannelManager   │  │ HealthMonitor    │  │ Protocol/RPC  │ │
│  │ start/stop/reset │  │ 5min interval    │  │ schema/methods│ │
│  └────────┬─────────┘  └────────┬─────────┘  └───────────────┘ │
└───────────┼──────────────────────┼──────────────────────────────┘
            │                      │
            ▼                      ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Plugin Registry (Runtime)                     │
│  listChannelPlugins() → dedupe → sort by order                  │
│  getChannelPlugin(id) → find by id                              │
└────────────────────────────┬────────────────────────────────────┘
                             │
         ┌───────────────────┼───────────────────┐
         ▼                   ▼                   ▼
┌─────────────┐    ┌─────────────┐    ┌─────────────────┐
│  Core Docks │    │  Extension  │    │  Extension       │
│  (8 built-in)│   │  Plugins    │    │  Plugins         │
│  telegram   │    │  feishu     │    │  line            │
│  whatsapp   │    │  msteams    │    │  matrix          │
│  discord    │    │  nostr      │    │  mattermost      │
│  slack      │    │  ...30+     │    │  ...             │
│  signal     │    └─────────────┘    └─────────────────┘
│  imessage   │
│  irc        │
│  googlechat │
└──────┬──────┘
       │
       ▼
┌─────────────────────────────────────────────────────────────────┐
│                    ChannelPlugin Interface                       │
│  ┌────────┐ ┌──────────┐ ┌──────────┐ ┌────────┐ ┌──────────┐ │
│  │config  │ │outbound  │ │gateway   │ │status  │ │security  │ │
│  │setup   │ │normalize │ │heartbeat │ │pairing │ │threading │ │
│  │groups  │ │actions   │ │directory │ │auth    │ │streaming │ │
│  │mentions│ │messaging │ │resolver  │ │commands│ │agentTools│ │
│  └────────┘ └──────────┘ └──────────┘ └────────┘ └──────────┘ │
└─────────────────────────────────────────────────────────────────┘
       │                        │
       ▼                        ▼
┌──────────────┐    ┌───────────────────────────────┐
│  Inbound     │    │  Outbound Delivery Pipeline   │
│  Normalize   │    │  channel-selection → handler   │
│  → Dispatch  │    │  → chunk → send → queue ack   │
│  → Reply     │    │  → hook (message_sending/sent) │
└──────────────┘    └───────────────────────────────┘
```

### 2.2 核心实现

#### 2.2.1 ChannelPlugin 全量接口

ChannelPlugin 是整个多渠道系统的核心契约，定义在 `src/channels/plugins/types.plugin.ts:49-85`：

```typescript
// src/channels/plugins/types.plugin.ts:49
export type ChannelPlugin<ResolvedAccount = any, Probe = unknown, Audit = unknown> = {
  id: ChannelId;
  meta: ChannelMeta;
  capabilities: ChannelCapabilities;
  defaults?: { queue?: { debounceMs?: number } };
  reload?: { configPrefixes: string[]; noopPrefixes?: string[] };
  onboarding?: ChannelOnboardingAdapter;
  config: ChannelConfigAdapter<ResolvedAccount>;
  configSchema?: ChannelConfigSchema;
  setup?: ChannelSetupAdapter;
  pairing?: ChannelPairingAdapter;
  security?: ChannelSecurityAdapter<ResolvedAccount>;
  groups?: ChannelGroupAdapter;
  mentions?: ChannelMentionAdapter;
  outbound?: ChannelOutboundAdapter;
  status?: ChannelStatusAdapter<ResolvedAccount, Probe, Audit>;
  gateway?: ChannelGatewayAdapter<ResolvedAccount>;
  auth?: ChannelAuthAdapter;
  elevated?: ChannelElevatedAdapter;
  commands?: ChannelCommandAdapter;
  streaming?: ChannelStreamingAdapter;
  threading?: ChannelThreadingAdapter;
  messaging?: ChannelMessagingAdapter;
  agentPrompt?: ChannelAgentPromptAdapter;
  directory?: ChannelDirectoryAdapter;
  resolver?: ChannelResolverAdapter;
  actions?: ChannelMessageActionAdapter;
  heartbeat?: ChannelHeartbeatAdapter;
  agentTools?: ChannelAgentToolFactory | ChannelAgentTool[];
};
```

关键设计：除 `id`、`meta`、`capabilities`、`config` 为必选外，其余 20+ 适配器均为可选。一个最简渠道只需实现 config + outbound 即可工作。

#### 2.2.2 ChannelCapabilities 能力声明

每个渠道通过 `ChannelCapabilities`（`src/channels/plugins/types.core.ts:171-184`）显式声明支持的功能：

```typescript
// src/channels/plugins/types.core.ts:171
export type ChannelCapabilities = {
  chatTypes: Array<ChatType | "thread">;  // "direct" | "group" | "channel" | "thread"
  polls?: boolean;
  reactions?: boolean;
  edit?: boolean;
  unsend?: boolean;
  reply?: boolean;
  effects?: boolean;
  groupManagement?: boolean;
  threads?: boolean;
  media?: boolean;
  nativeCommands?: boolean;
  blockStreaming?: boolean;
};
```

实际使用示例——Discord 声明（`src/channels/dock.ts:331-339`）：

```typescript
// src/channels/dock.ts:331
discord: {
  id: "discord",
  capabilities: {
    chatTypes: ["direct", "channel", "thread"],
    polls: true,
    reactions: true,
    media: true,
    nativeCommands: true,
    threads: true,
  },
  outbound: { textChunkLimit: 2000 },
  streaming: DEFAULT_BLOCK_STREAMING_COALESCE,
  // ...
}
```

#### 2.2.3 Dock 轻量元数据层

`ChannelDock`（`src/channels/dock.ts:47-64`）是 Plugin 的轻量投影，只保留配置读取、线程、分组等共享代码需要的字段：

```typescript
// src/channels/dock.ts:47
export type ChannelDock = {
  id: ChannelId;
  capabilities: ChannelCapabilities;
  commands?: ChannelCommandAdapter;
  outbound?: { textChunkLimit?: number };
  streaming?: ChannelDockStreaming;
  elevated?: ChannelElevatedAdapter;
  config?: Pick<ChannelConfigAdapter<unknown>,
    "resolveAllowFrom" | "formatAllowFrom" | "resolveDefaultTo">;
  groups?: ChannelGroupAdapter;
  mentions?: ChannelMentionAdapter;
  threading?: ChannelThreadingAdapter;
  agentPrompt?: ChannelAgentPromptAdapter;
};
```

8 个核心渠道的 Dock 在 `DOCKS` 常量中静态定义（`src/channels/dock.ts:229-564`），扩展渠道通过 `buildDockFromPlugin()`（`src/channels/dock.ts:566-590`）从 Plugin 动态生成。

#### 2.2.4 出站投递管道

出站消息统一通过 `deliverOutboundPayloads`（`src/infra/outbound/deliver.ts:226-284`）处理：

```typescript
// src/infra/outbound/deliver.ts:226
export async function deliverOutboundPayloads(
  params: DeliverOutboundPayloadsParams,
): Promise<OutboundDeliveryResult[]> {
  const { channel, to, payloads } = params;
  // 1. 写前日志：持久化到 delivery queue
  const queueId = params.skipQueue ? null
    : await enqueueDelivery({ channel, to, accountId, payloads, ... })
        .catch(() => null);
  try {
    // 2. 核心投递逻辑
    const results = await deliverOutboundPayloadsCore(params);
    // 3. 成功后确认
    if (queueId) await ackDelivery(queueId).catch(() => {});
    return results;
  } catch (err) {
    // 4. 失败标记
    if (queueId) await failDelivery(queueId, err.message).catch(() => {});
    throw err;
  }
}
```

核心投递流程（`src/infra/outbound/deliver.ts:287-602`）：
1. `createChannelHandler()` 按渠道 ID 加载 OutboundAdapter
2. 按渠道的 `textChunkLimit` 和 `chunkerMode` 分块
3. 逐 payload 发送，支持 text/media/poll 三种类型
4. 触发 `message_sending`（可修改/取消）和 `message_sent` 钩子

