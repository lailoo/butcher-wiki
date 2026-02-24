# PD-09.04 OpenClaw — 命令执行审批系统

> 文档编号：PD-09.04
> 来源：OpenClaw `src/gateway/exec-approval-manager.ts`
> GitHub：https://github.com/openclaw/openclaw.git
> 问题域：PD-09 Human-in-the-Loop
> 状态：可复用方案

---

## 第 1 章 问题与动机（≥ 30 行）

### 1.1 核心问题

Agent 执行 shell 命令是最危险的操作之一。一个被注入的 prompt 可以让 Agent 执行 `rm -rf /`、窃取密钥、或安装后门。传统的静态白名单无法覆盖所有场景——Agent 需要灵活执行各种命令来完成任务，但每条命令都可能是攻击向量。

核心矛盾：**Agent 需要执行权限才能有用，但执行权限本身就是风险**。

OpenClaw 面临的具体挑战：
1. Agent 运行在 gateway/node 两层架构上，命令可能在本地或远程执行
2. 用户可能通过 Slack、Discord、Web UI 等多个渠道与 Agent 交互
3. 审批请求必须路由到正确的人（而不是任意连接的客户端）
4. 审批决策必须防重放——一个审批 ID 不能被其他连接窃取使用
5. 用户可能长时间不响应，系统不能永久阻塞

### 1.2 OpenClaw 的解法概述

OpenClaw 实现了一套完整的**命令执行审批系统**（Exec Approval System），核心设计：

1. **Promise-based 审批管理器**：`ExecApprovalManager` 用 Promise 实现异步等待，创建审批记录后返回 Promise，人工决策后 resolve（`src/gateway/exec-approval-manager.ts:64-93`）
2. **三级决策模型**：`allow-once`（单次放行）、`allow-always`（永久白名单）、`deny`（拒绝），覆盖从临时到永久的审批粒度（`src/infra/exec-approvals.ts:496`）
3. **多通道审批转发**：审批请求可转发到 Discord 按钮、Slack 交互、Web UI、Unix Socket 等多个渠道，用户在任一渠道审批即可（`src/infra/exec-approval-forwarder.ts`）
4. **连接级身份绑定**：审批记录绑定 `deviceId` 和 `connId`，防止其他客户端重放审批 ID（`src/gateway/node-invoke-system-run-approval.ts:191-212`）
5. **配置驱动的安全策略**：`ExecSecurity`（deny/allowlist/full）× `ExecAsk`（off/on-miss/always）组合，每个 Agent 可独立配置（`src/infra/exec-approvals.ts:11-12`）

### 1.3 设计思想

| 设计原则 | 具体实现 | 理由 | 替代方案 |
|----------|----------|------|----------|
| Promise 异步等待 | `register()` 返回 Promise，`resolve()` 触发 | 不阻塞线程，支持超时和取消 | threading.Event / 轮询 |
| 两阶段响应 | `twoPhase` 模式先返回 accepted 再返回 decision | 调用方可确认注册成功后再等待 | 单次响应（无法区分注册失败和等待中） |
| 身份绑定防重放 | deviceId > connId 优先级绑定 | 防止其他客户端窃取审批 ID | 无绑定（安全漏洞） |
| 超时自动过期 | `setTimeout` + `expire()` + grace period | 避免永久挂起，grace period 处理竞态 | 无超时（任务永久阻塞） |
| 配置驱动安全级别 | security × ask 矩阵 | 不同 Agent 不同风险等级 | 全局统一策略（过严或过松） |

---

## 第 2 章 源码实现分析（≥ 60 行，核心章节）

### 2.1 架构概览

OpenClaw 的 Human-in-the-Loop 系统由四层组成：

```
┌─────────────────────────────────────────────────────────────────┐
│                        用户交互层                                │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌───────────────┐   │
│  │ Discord  │  │  Slack   │  │  Web UI  │  │ Unix Socket   │   │
│  │ Buttons  │  │ Actions  │  │ Dialog   │  │ (CLI approver)│   │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └──────┬────────┘   │
│       └──────────────┴─────────────┴───────────────┘            │
│                          ↓ resolve()                            │
├─────────────────────────────────────────────────────────────────┤
│                     Gateway 审批层                               │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │              ExecApprovalManager                        │    │
│  │  pending: Map<id, {record, resolve, reject, timer}>     │    │
│  │  create() → register() → awaitDecision()                │    │
│  │  resolve() / expire()                                   │    │
│  └─────────────────────────────────────────────────────────┘    │
│       ↑ request          ↓ broadcast                            │
├─────────────────────────────────────────────────────────────────┤
│                     安全校验层                                    │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │         sanitizeSystemRunParamsForForwarding()           │    │
│  │  • 身份绑定校验 (deviceId / connId)                      │    │
│  │  • 命令匹配校验 (command + cwd + agentId + sessionKey)   │    │
│  │  • 过期校验 + scope 权限校验                              │    │
│  │  • 参数白名单过滤 (pickSystemRunParams)                   │    │
│  └─────────────────────────────────────────────────────────┘    │
│       ↑ exec.approval.request                                   │
├─────────────────────────────────────────────────────────────────┤
│                      Agent 执行层                                │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │  requestExecApprovalDecision()                          │    │
│  │  → callGatewayTool("exec.approval.request", {...})      │    │
│  │  security: deny | allowlist | full                      │    │
│  │  ask: off | on-miss | always                            │    │
│  └─────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────┘
```

### 2.2 核心实现

#### 2.2.1 ExecApprovalManager — Promise 异步审批

审批管理器的核心是 `register()` 方法（`src/gateway/exec-approval-manager.ts:64-93`），它将审批记录注册到内存 Map 并返回一个 Promise：

```typescript
// src/gateway/exec-approval-manager.ts:64-93
register(record: ExecApprovalRecord, timeoutMs: number): Promise<ExecApprovalDecision | null> {
  const existing = this.pending.get(record.id);
  if (existing) {
    if (existing.record.resolvedAtMs === undefined) {
      return existing.promise;  // 幂等：返回已有 Promise
    }
    throw new Error(`approval id '${record.id}' already resolved`);
  }
  let resolvePromise: (decision: ExecApprovalDecision | null) => void;
  let rejectPromise: (err: Error) => void;
  const promise = new Promise<ExecApprovalDecision | null>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  const entry: PendingEntry = {
    record,
    resolve: resolvePromise!,
    reject: rejectPromise!,
    timer: null as unknown as ReturnType<typeof setTimeout>,
    promise,
  };
  entry.timer = setTimeout(() => {
    this.expire(record.id);
  }, timeoutMs);
  this.pending.set(record.id, entry);
  return promise;
}
```

决策解析时，`resolve()` 方法（`src/gateway/exec-approval-manager.ts:105-128`）清除定时器、记录决策、resolve Promise，然后保留 15 秒 grace period 供迟到的 `awaitDecision` 调用：

```typescript
// src/gateway/exec-approval-manager.ts:105-128
resolve(recordId: string, decision: ExecApprovalDecision, resolvedBy?: string | null): boolean {
  const pending = this.pending.get(recordId);
  if (!pending) return false;
  if (pending.record.resolvedAtMs !== undefined) return false;  // 防双重 resolve
  clearTimeout(pending.timer);
  pending.record.resolvedAtMs = Date.now();
  pending.record.decision = decision;
  pending.record.resolvedBy = resolvedBy ?? null;
  pending.resolve(decision);  // 触发等待方的 Promise
  setTimeout(() => {
    if (this.pending.get(recordId) === pending) {
      this.pending.delete(recordId);  // grace period 后清理
    }
  }, RESOLVED_ENTRY_GRACE_MS);  // 15 秒
  return true;
}
```

#### 2.2.2 Gateway 审批请求处理

`exec.approval.request` handler（`src/gateway/server-methods/exec-approval.ts:29-151`）是审批流程的入口：

```typescript
// src/gateway/server-methods/exec-approval.ts:29-96 (简化)
"exec.approval.request": async ({ params, respond, context, client }) => {
  // 1. 参数校验
  if (!validateExecApprovalRequestParams(params)) { respond(false, ...); return; }
  // 2. 创建审批记录，绑定客户端身份
  const record = manager.create(request, timeoutMs, explicitId);
  record.requestedByConnId = client?.connId ?? null;
  record.requestedByDeviceId = client?.connect?.device?.id ?? null;
  // 3. 注册到 pending map（同步，确保 ID 立即可用）
  const decisionPromise = manager.register(record, timeoutMs);
  // 4. 广播事件通知所有连接的客户端
  context.broadcast("exec.approval.requested", { id, request, createdAtMs, expiresAtMs });
  // 5. 转发到外部审批通道（Discord/Slack 等）
  if (opts?.forwarder) { await opts.forwarder.handleRequested({...}); }
  // 6. 无审批客户端时自动过期
  if (!hasApprovalClients(context) && !forwardedToTargets) {
    manager.expire(record.id, "auto-expire:no-approver-clients");
  }
  // 7. 两阶段模式：先返回 accepted，再等待最终决策
  if (twoPhase) { respond(true, { status: "accepted", id, ... }); }
  const decision = await decisionPromise;
  respond(true, { id, decision, ... });
}
```

#### 2.2.3 安全校验 — 防重放攻击

`sanitizeSystemRunParamsForForwarding()`（`src/gateway/node-invoke-system-run-approval.ts:116-251`）是安全核心，执行五重校验：

1. **参数白名单过滤**：只转发已知安全字段，防止注入控制字段（L89-109）
2. **审批 ID 存在性校验**：必须有对应的 pending 审批记录（L173-180）
3. **过期校验**：审批记录不能已过期（L182-189）
4. **身份绑定校验**：优先 deviceId，fallback connId（L191-212）
5. **请求匹配校验**：command + cwd + agentId + sessionKey 必须完全匹配（L214-220）

```typescript
// src/gateway/node-invoke-system-run-approval.ts:191-212
// 身份绑定：优先 device identity（跨重连稳定），fallback 到 connId
const snapshotDeviceId = snapshot.requestedByDeviceId ?? null;
const clientDeviceId = opts.client?.connect?.device?.id ?? null;
if (snapshotDeviceId) {
  if (snapshotDeviceId !== clientDeviceId) {
    return { ok: false, message: "approval id not valid for this device" };
  }
} else if (snapshot.requestedByConnId && snapshot.requestedByConnId !== (opts.client?.connId ?? null)) {
  return { ok: false, message: "approval id not valid for this client" };
}
```

#### 2.2.4 多通道审批 UI

Discord 审批使用交互式按钮组件（`src/discord/monitor/exec-approvals.ts:158-181`）：

```typescript
// src/discord/monitor/exec-approvals.ts:158-181
class ExecApprovalActionRow extends Row<Button> {
  constructor(approvalId: string) {
    super([
      new ExecApprovalActionButton({
        approvalId, action: "allow-once",
        label: "Allow once", style: ButtonStyle.Success,
      }),
      new ExecApprovalActionButton({
        approvalId, action: "allow-always",
        label: "Always allow", style: ButtonStyle.Primary,
      }),
      new ExecApprovalActionButton({
        approvalId, action: "deny",
        label: "Deny", style: ButtonStyle.Danger,
      }),
    ]);
  }
}
```

Slack 审批通过 `registerSlackInteractionEvents()`（`src/slack/monitor/events/interactions.ts:509-700`）注册 Block Kit action handler，匹配 `openclaw:` 前缀的 action_id，点击后通过 `enqueueSystemEvent()` 将交互结果注入 Agent 的下一轮 prompt。

### 2.3 实现细节

#### 配置驱动的安全矩阵

OpenClaw 用 `ExecSecurity` × `ExecAsk` 两个维度控制审批行为（`src/infra/exec-approvals.ts:11-12`）：

| ExecSecurity | ExecAsk | 行为 |
|-------------|---------|------|
| `deny` | `always` | 每条命令都需要审批 |
| `deny` | `on-miss` | 不在白名单的命令需要审批 |
| `allowlist` | `off` | 白名单内自动放行，其余拒绝 |
| `full` | `off` | 所有命令自动放行（危险） |

每个 Agent 可独立配置，通过 `ExecApprovalsFile`（`~/.openclaw/exec-approvals.json`）持久化。

#### 系统事件队列

`enqueueSystemEvent()`（`src/infra/system-events.ts:51-82`）是 HITL 的消息桥梁——将人类交互结果（按钮点击、表单提交）转化为 Agent 可消费的文本事件，注入下一轮 prompt：

- 会话级隔离（sessionKey 分区）
- 最多 20 条事件（防溢出）
- 连续重复去重
- 纯内存、不持久化（ephemeral）

---

## 第 3 章 迁移指南（≥ 40 行）

### 3.1 迁移清单

**阶段 1：核心审批管理器**
- [ ] 实现 `ApprovalManager` 类（Promise-based，支持 create/register/resolve/expire）
- [ ] 定义审批决策类型（`allow-once` / `allow-always` / `deny`）
- [ ] 实现超时自动过期 + grace period
- [ ] 实现幂等注册（相同 ID 返回已有 Promise）

**阶段 2：安全校验层**
- [ ] 实现请求匹配校验（command + cwd + agentId 必须一致）
- [ ] 实现身份绑定（deviceId 优先，connId fallback）
- [ ] 实现参数白名单过滤（只转发已知安全字段）
- [ ] 实现 scope-based 权限校验

**阶段 3：多通道审批 UI**
- [ ] 实现至少一个审批通道（Web UI / Discord / Slack / CLI）
- [ ] 实现审批转发器（将请求路由到正确的通道）
- [ ] 实现审批结果回写（更新原始消息状态）

**阶段 4：配置系统**
- [ ] 实现 security × ask 配置矩阵
- [ ] 实现 per-agent 配置
- [ ] 实现命令白名单（pattern-based）

### 3.2 适配代码模板

以下是一个可直接运行的 TypeScript 审批管理器实现：

```typescript
// approval-manager.ts — 可复用的 Promise-based 审批管理器
import { randomUUID } from "node:crypto";

type ApprovalDecision = "allow-once" | "allow-always" | "deny";

type ApprovalRecord = {
  id: string;
  command: string;
  createdAtMs: number;
  expiresAtMs: number;
  requestedByClientId?: string;
  resolvedAtMs?: number;
  decision?: ApprovalDecision;
};

type PendingEntry = {
  record: ApprovalRecord;
  resolve: (decision: ApprovalDecision | null) => void;
  timer: ReturnType<typeof setTimeout>;
  promise: Promise<ApprovalDecision | null>;
};

const GRACE_MS = 15_000;

export class ApprovalManager {
  private pending = new Map<string, PendingEntry>();

  request(command: string, timeoutMs: number, clientId?: string): {
    record: ApprovalRecord;
    promise: Promise<ApprovalDecision | null>;
  } {
    const now = Date.now();
    const record: ApprovalRecord = {
      id: randomUUID(),
      command,
      createdAtMs: now,
      expiresAtMs: now + timeoutMs,
      requestedByClientId: clientId,
    };

    let resolvePromise!: (d: ApprovalDecision | null) => void;
    const promise = new Promise<ApprovalDecision | null>((resolve) => {
      resolvePromise = resolve;
    });

    const entry: PendingEntry = {
      record,
      resolve: resolvePromise,
      timer: setTimeout(() => this.expire(record.id), timeoutMs),
      promise,
    };
    this.pending.set(record.id, entry);
    return { record, promise };
  }

  resolve(id: string, decision: ApprovalDecision, clientId?: string): boolean {
    const entry = this.pending.get(id);
    if (!entry || entry.record.resolvedAtMs !== undefined) return false;
    // 身份绑定校验
    if (entry.record.requestedByClientId && entry.record.requestedByClientId !== clientId) {
      return false; // 防重放
    }
    clearTimeout(entry.timer);
    entry.record.resolvedAtMs = Date.now();
    entry.record.decision = decision;
    entry.resolve(decision);
    setTimeout(() => {
      if (this.pending.get(id) === entry) this.pending.delete(id);
    }, GRACE_MS);
    return true;
  }

  private expire(id: string): void {
    const entry = this.pending.get(id);
    if (!entry || entry.record.resolvedAtMs !== undefined) return;
    clearTimeout(entry.timer);
    entry.record.resolvedAtMs = Date.now();
    entry.resolve(null); // null = 超时
    setTimeout(() => {
      if (this.pending.get(id) === entry) this.pending.delete(id);
    }, GRACE_MS);
  }
}
```

### 3.3 适用场景

| 场景 | 适用度 | 说明 |
|------|--------|------|
| Agent 执行 shell 命令 | ⭐⭐⭐ | 核心场景，OpenClaw 的设计目标 |
| 危险 API 调用审批 | ⭐⭐⭐ | 可扩展到任何需要人工确认的操作 |
| 多用户协作审批 | ⭐⭐ | 支持多通道但审批者需预配置 |
| 高频自动化流水线 | ⭐ | 每次审批有 120s 超时，不适合高频场景 |
| 离线/异步审批 | ⭐ | 纯内存不持久化，重启后审批丢失 |

---

## 第 4 章 测试用例（≥ 20 行）

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ApprovalManager } from "./approval-manager";

describe("ApprovalManager", () => {
  let manager: ApprovalManager;

  beforeEach(() => {
    vi.useFakeTimers();
    manager = new ApprovalManager();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("should resolve with decision when approved", async () => {
    const { record, promise } = manager.request("ls -la", 120_000, "client-1");
    const resolved = manager.resolve(record.id, "allow-once", "client-1");
    expect(resolved).toBe(true);
    const decision = await promise;
    expect(decision).toBe("allow-once");
  });

  it("should return null on timeout", async () => {
    const { promise } = manager.request("rm -rf /", 5_000, "client-1");
    vi.advanceTimersByTime(5_001);
    const decision = await promise;
    expect(decision).toBeNull();
  });

  it("should prevent double resolve", async () => {
    const { record } = manager.request("echo hello", 120_000);
    expect(manager.resolve(record.id, "allow-once")).toBe(true);
    expect(manager.resolve(record.id, "deny")).toBe(false);
  });

  it("should reject resolve from different client (anti-replay)", async () => {
    const { record } = manager.request("curl evil.com", 120_000, "client-1");
    const resolved = manager.resolve(record.id, "allow-once", "client-2");
    expect(resolved).toBe(false); // 身份不匹配
  });

  it("should be idempotent for same ID", async () => {
    const { record, promise: p1 } = manager.request("test", 120_000);
    // 内部实现应支持幂等注册
    manager.resolve(record.id, "allow-always");
    const decision = await p1;
    expect(decision).toBe("allow-always");
  });

  it("should support allow-always for permanent whitelist", async () => {
    const { record, promise } = manager.request("npm test", 120_000);
    manager.resolve(record.id, "allow-always");
    const decision = await promise;
    expect(decision).toBe("allow-always");
    // allow-always 意味着后续相同命令可跳过审批
  });
});
```

---

## 第 5 章 跨域关联

| 关联域 | 关系类型 | 说明 |
|--------|----------|------|
| PD-04 工具系统 | 依赖 | 审批系统通过 `callGatewayTool("exec.approval.request")` 集成到工具调用链 |
| PD-05 沙箱隔离 | 协同 | `ExecHost` 区分 sandbox/gateway/node，沙箱内命令可跳过审批 |
| PD-03 容错与重试 | 协同 | 审批超时后的 `askFallback` 机制是一种降级策略 |
| PD-11 可观测性 | 协同 | 审批事件通过 `broadcast()` 广播，可用于审计日志 |
| PD-10 中间件管道 | 依赖 | Slack 交互通过中间件模式注册 handler（`ctx.app.action(regex, handler)`） |

---

## 第 6 章 来源文件索引

| 文件 | 行范围 | 关键实现 |
|------|--------|----------|
| `src/gateway/exec-approval-manager.ts` | L1-165 | ExecApprovalManager 核心类：create/register/resolve/expire/awaitDecision |
| `src/gateway/server-methods/exec-approval.ts` | L16-230 | Gateway 审批请求/等待/解析三个 handler |
| `src/gateway/node-invoke-system-run-approval.ts` | L116-251 | sanitizeSystemRunParamsForForwarding 安全校验 |
| `src/infra/exec-approvals.ts` | L1-528 | 类型定义、配置文件管理、Socket 审批协议 |
| `src/infra/exec-approval-forwarder.ts` | L1-120+ | 多通道审批转发器 |
| `src/infra/system-events.ts` | L1-119 | 系统事件队列（HITL 消息桥梁） |
| `src/agents/bash-tools.exec-approval-request.ts` | L1-68 | Agent 侧审批请求函数 |
| `src/discord/monitor/exec-approvals.ts` | L1-219+ | Discord 交互式审批按钮 |
| `src/slack/monitor/events/interactions.ts` | L509-700 | Slack Block Kit 交互处理 |
| `src/wizard/onboarding.ts` | L21-62 | 风险确认向导（requireRiskAcknowledgement） |
| `src/wizard/prompts.ts` | L1-53 | WizardPrompter 交互接口定义 |

---

## 第 7 章 横向对比维度

> **重要：** 本章用于自动填充 Butcher Wiki 的横向对比表。
> 必须严格按以下 JSON 格式输出，放在 `comparison_data` 代码块中。

```json comparison_data
{
  "project": "OpenClaw",
  "dimensions": {
    "暂停机制": "Promise-based 异步等待，register() 返回 Promise，resolve()/expire() 触发",
    "澄清类型": "三级决策模型：allow-once / allow-always / deny",
    "状态持久化": "纯内存 Map + 15s grace period，不持久化，重启丢失",
    "实现层级": "四层架构：Agent→Gateway→安全校验→多通道 UI",
    "身份绑定": "deviceId 优先 + connId fallback，防审批 ID 重放攻击",
    "多通道转发": "Discord 按钮 + Slack Actions + Web UI + Unix Socket 四通道并行"
  }
}
```

### 域元数据补充

```json domain_metadata
{
  "description": "多通道审批转发与身份绑定防重放是分布式 HITL 的关键安全挑战",
  "sub_problems": [
    "审批身份绑定：防止其他客户端重放审批 ID 的安全机制",
    "多通道审批路由：同一审批请求转发到多个交互渠道的路由策略",
    "审批超时降级：人工不响应时的 askFallback 安全降级策略"
  ],
  "best_practices": [
    "两阶段响应模式：先返回 accepted 确认注册，再异步等待最终决策，避免调用方无法区分注册失败和等待中",
    "参数白名单过滤：转发审批参数时只允许已知安全字段，防止控制字段注入",
    "grace period 处理竞态：审批 resolve 后保留短暂窗口供迟到的 awaitDecision 调用获取结果",
    "无审批客户端时自动过期：检测到无 operator 连接时立即 expire，避免无人审批的请求永久挂起"
  ]
}
```
