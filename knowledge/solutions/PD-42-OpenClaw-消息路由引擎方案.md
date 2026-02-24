# PD-42.01 OpenClaw — 多维度层级路由引擎

> 文档编号：PD-42.01
> 来源：OpenClaw `src/routing/resolve-route.ts`
> GitHub：https://github.com/openclaw/openclaw
> 问题域：PD-42 消息路由引擎 Message Routing Engine
> 状态：可复用方案

---

## 第 1 章 问题与动机

### 1.1 核心问题

多渠道 Agent 系统面临一个关键路由问题：当消息从 WhatsApp、Telegram、Discord、Slack、Signal、iMessage 等十余个渠道涌入时，系统需要在毫秒级内确定：

1. **哪个 Agent 处理这条消息？** — 不同渠道、不同用户、不同群组可能需要不同的 Agent
2. **消息上下文存储在哪里？** — session key 决定了对话历史的隔离粒度
3. **回复发往何处？** — 出站路由需要将 Agent 的回复精确投递回原始会话

这不是简单的 if-else 路由。真实场景中，一个 Discord 服务器可能有多个频道绑定不同 Agent，同一频道的不同角色用户需要路由到不同 Agent，线程需要继承父频道的绑定关系。路由规则之间存在优先级冲突，需要一套确定性的层级匹配机制。

### 1.2 OpenClaw 的解法概述

OpenClaw 实现了一套 **7 层优先级路由引擎**，核心设计：

1. **声明式绑定配置** — 通过 `AgentBinding` 类型定义路由规则，支持 channel/accountId/peer/guildId/teamId/roles 六个匹配维度 (`src/config/types.agents.ts:40-52`)
2. **确定性层级匹配** — 7 个优先级层（peer → parent peer → guild+roles → guild → team → account → channel），逐层扫描，首个匹配即返回 (`src/routing/resolve-route.ts:362-412`)
3. **session key 自动生成** — 根据 peer 类型和 dmScope 配置自动构建隔离粒度不同的 session key (`src/routing/session-key.ts:114-161`)
4. **跨渠道身份链接** — identityLinks 机制将不同渠道的同一用户映射到统一 session (`src/routing/session-key.ts:163-207`)
5. **出站路由对称性** — 16 个渠道各有专用的 session 解析器，确保出站 session key 与入站一致 (`src/infra/outbound/outbound-session.ts:880-923`)

### 1.3 设计思想

| 设计原则 | 具体实现 | 理由 | 替代方案 |
|----------|----------|------|----------|
| 确定性路由 | 7 层固定优先级，不依赖权重或评分 | 避免路由歧义，便于调试 | 权重评分系统（复杂度高） |
| 声明式配置 | JSON binding 数组，match 字段描述条件 | 非开发者可维护路由规则 | 代码级路由注册（灵活但难维护） |
| 渠道无关的核心 | resolve-route.ts 不含任何渠道特定逻辑 | 新增渠道无需修改路由核心 | 每个渠道独立路由器（代码重复） |
| ID 规范化前置 | normalizeAccountId/normalizeAgentId 在路由入口统一处理 | 避免大小写/空格导致的匹配失败 | 在每个匹配点分别处理（易遗漏） |
| 缓存热路径 | WeakMap 缓存 evaluated bindings，按 channel+account 分桶 | 高频消息场景下避免重复计算 | 无缓存（每次全量扫描） |

---

## 第 2 章 源码实现分析

### 2.1 架构概览

```
┌─────────────────────────────────────────────────────────────────┐
│                        入站消息流                                │
│  WhatsApp / Telegram / Discord / Slack / Signal / iMessage ...  │
└──────────────────────────┬──────────────────────────────────────┘
                           │
                           ▼
              ┌────────────────────────┐
              │   resolveAgentRoute()  │  ← src/routing/resolve-route.ts
              │                        │
              │  输入: channel,         │
              │    accountId, peer,     │
              │    guildId, teamId,     │
              │    memberRoleIds        │
              │                        │
              │  ┌──────────────────┐  │
              │  │ 7-Tier Matching  │  │
              │  │ 1. binding.peer  │  │
              │  │ 2. peer.parent   │  │
              │  │ 3. guild+roles   │  │
              │  │ 4. guild         │  │
              │  │ 5. team          │  │
              │  │ 6. account       │  │
              │  │ 7. channel (*)   │  │
              │  └──────────────────┘  │
              │         │              │
              │         ▼              │
              │  ┌──────────────────┐  │
              │  │ buildAgentSession│  │  ← src/routing/session-key.ts
              │  │ Key()            │  │
              │  └──────────────────┘  │
              └────────────┬───────────┘
                           │
                           ▼
              ┌────────────────────────┐
              │  ResolvedAgentRoute    │
              │  {                     │
              │    agentId,            │
              │    sessionKey,         │
              │    matchedBy,          │
              │    channel, accountId  │
              │  }                     │
              └────────────┬───────────┘
                           │
              ┌────────────┴───────────┐
              │                        │
              ▼                        ▼
    ┌──────────────────┐    ┌──────────────────────┐
    │ dispatchInbound  │    │ SessionBindingService │
    │ Message()        │    │ (出站路由绑定)         │
    │ auto-reply/      │    │ infra/outbound/       │
    │ dispatch.ts      │    │ session-binding-      │
    └──────────────────┘    │ service.ts            │
                            └──────────────────────┘
```

### 2.2 核心实现

#### 2.2.1 路由入口与层级匹配

`resolveAgentRoute()` 是整个路由系统的入口函数 (`src/routing/resolve-route.ts:291-435`)。它首先规范化所有输入参数，然后通过缓存获取当前 channel+account 的绑定列表，最后按 7 层优先级逐层匹配：

```typescript
// src/routing/resolve-route.ts:291-327 (简化)
export function resolveAgentRoute(input: ResolveAgentRouteInput): ResolvedAgentRoute {
  const channel = normalizeToken(input.channel);
  const accountId = normalizeAccountId(input.accountId);
  const peer = input.peer ? { kind: input.peer.kind, id: normalizeId(input.peer.id) } : null;

  const bindings = getEvaluatedBindingsForChannelAccount(input.cfg, channel, accountId);
  const dmScope = input.cfg.session?.dmScope ?? "main";

  const choose = (agentId: string, matchedBy: ResolvedAgentRoute["matchedBy"]) => {
    const resolvedAgentId = pickFirstExistingAgentId(input.cfg, agentId);
    const sessionKey = buildAgentSessionKey({
      agentId: resolvedAgentId, channel, accountId, peer, dmScope,
      identityLinks: input.cfg.session?.identityLinks,
    }).toLowerCase();
    return { agentId: resolvedAgentId, channel, accountId, sessionKey, mainSessionKey, matchedBy };
  };
  // ... 7-tier matching follows
}
```

7 层优先级定义为一个 `tiers` 数组 (`src/routing/resolve-route.ts:362-412`)，每层包含 `matchedBy` 标签、`enabled` 开关和 `predicate` 过滤器：

```typescript
// src/routing/resolve-route.ts:362-432 (核心层级定义)
const tiers: Array<{
  matchedBy: Exclude<ResolvedAgentRoute["matchedBy"], "default">;
  enabled: boolean;
  scopePeer: RoutePeer | null;
  predicate: (candidate: EvaluatedBinding) => boolean;
}> = [
  { matchedBy: "binding.peer",        enabled: Boolean(peer),
    scopePeer: peer,       predicate: (c) => c.match.peer.state === "valid" },
  { matchedBy: "binding.peer.parent", enabled: Boolean(parentPeer?.id),
    scopePeer: parentPeer, predicate: (c) => c.match.peer.state === "valid" },
  { matchedBy: "binding.guild+roles", enabled: Boolean(guildId && memberRoleIds.length > 0),
    scopePeer: peer,       predicate: (c) => hasGuildConstraint(c.match) && hasRolesConstraint(c.match) },
  { matchedBy: "binding.guild",       enabled: Boolean(guildId),
    scopePeer: peer,       predicate: (c) => hasGuildConstraint(c.match) && !hasRolesConstraint(c.match) },
  { matchedBy: "binding.team",        enabled: Boolean(teamId),
    scopePeer: peer,       predicate: (c) => hasTeamConstraint(c.match) },
  { matchedBy: "binding.account",     enabled: true,
    scopePeer: peer,       predicate: (c) => c.match.accountPattern !== "*" },
  { matchedBy: "binding.channel",     enabled: true,
    scopePeer: peer,       predicate: (c) => c.match.accountPattern === "*" },
];

for (const tier of tiers) {
  if (!tier.enabled) continue;
  const matched = bindings.find((candidate) =>
    tier.predicate(candidate) &&
    matchesBindingScope(candidate.match, { ...baseScope, peer: tier.scopePeer })
  );
  if (matched) return choose(matched.binding.agentId, tier.matchedBy);
}
return choose(resolveDefaultAgentId(input.cfg), "default");
```

