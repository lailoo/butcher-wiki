# PD-05.05 OpenClaw — Docker 容器沙箱：多 Scope 隔离 + 浏览器沙箱 + 配置 Hash 驱动重建

> 文档编号：PD-05.05
> 来源：OpenClaw `src/agents/sandbox/docker.ts` / `config.ts` / `validate-sandbox-security.ts`
> GitHub：https://github.com/openclaw/openclaw.git
> 问题域：PD-05 沙箱隔离 Sandbox Isolation
> 状态：可复用方案

---

## 第 1 章 问题与动机

### 1.1 核心问题

Agent 系统中，多个 Agent 会话可能并发运行，每个会话执行用户代码、操作文件系统、甚至控制浏览器。如果所有会话共享同一个执行环境，会面临以下问题：

- **会话间干扰**：Agent A 修改的文件被 Agent B 意外读取或覆盖
- **凭证泄露**：宿主机的 API Key、Token 等环境变量被沙箱内代码读取
- **容器配置漂移**：运行中的容器配置与期望配置不一致，但无法感知
- **浏览器隔离缺失**：Agent 控制的浏览器可以访问宿主机网络和文件
- **资源泄漏**：长期运行的容器占用资源但无人清理
- **挂载逃逸**：恶意 bind mount 可以暴露 `/etc`、Docker socket 等系统路径

### 1.2 OpenClaw 的解法概述

OpenClaw 实现了一套完整的 Docker 容器沙箱系统，核心特点：

1. **三种 Scope 模式**（`session` / `agent` / `shared`）：按会话、Agent 或全局共享容器，灵活控制隔离粒度（`config.ts:43-54`）
2. **配置 Hash 驱动容器重建**：SHA256 哈希检测配置变更，冷容器自动重建、热容器提示手动重建（`docker.ts:419-494`）
3. **多层安全校验**：bind mount 路径黑名单 + symlink 逃逸防护 + 网络模式/seccomp/apparmor 校验（`validate-sandbox-security.ts:125-195`）
4. **环境变量清洗**：正则黑名单拦截 API Key/Token，base64 凭证检测（`sanitize-env-vars.ts:1-56`）
5. **独立浏览器沙箱**：CDP + noVNC 的浏览器容器，独立网络 + 认证令牌（`browser.ts`）
6. **文件系统桥接**：通过 `docker exec` 实现宿主机与容器间的文件操作，支持读写权限控制（`fs-bridge.ts:55-228`）

### 1.3 设计思想

| 设计原则 | 具体实现 | 理由 | 替代方案 |
|----------|----------|------|----------|
| 配置即状态 | SHA256 hash 检测配置变更，驱动容器重建 | 避免配置漂移导致安全降级 | 每次都重建容器（浪费资源） |
| 纵深防御 | 5 层安全校验（bind/network/seccomp/apparmor/env） | 单层被绕过不会导致完全失守 | 仅依赖 Docker 默认安全 |
| Scope 分级 | session/agent/shared 三级隔离粒度 | 不同场景需要不同隔离强度 | 固定一种隔离模式 |
| 热容器保护 | 5 分钟内使用过的容器不自动重建 | 防止正在执行的任务被中断 | 无条件重建（可能丢失状态） |
| 最小权限 | `--cap-drop ALL` + `--read-only` + `no-new-privileges` | 容器内进程无法提权 | 仅 drop 部分 capability |

---

## 第 2 章 源码实现分析

### 2.1 架构概览

```
┌─────────────────────────────────────────────────────────────────┐
│                     resolveSandboxContext()                       │
│                       context.ts:108-186                         │
├──────────┬──────────┬──────────┬──────────┬──────────────────────┤
│ Config   │ Docker   │ Browser  │ FsBridge │ Prune               │
│ Resolution│ Lifecycle│ Sandbox  │          │                     │
├──────────┼──────────┼──────────┼──────────┼──────────────────────┤
│config.ts │docker.ts │browser.ts│fs-bridge │prune.ts             │
│          │          │          │.ts       │                     │
│resolve   │ensure    │ensure    │create    │maybePrune           │
│SandboxCfg│Container │Browser   │FsBridge  │Sandboxes            │
│ForAgent  │          │          │          │                     │
├──────────┴──────────┴──────────┴──────────┴──────────────────────┤
│                     Security Layer                               │
│  validate-sandbox-security.ts  │  sanitize-env-vars.ts          │
├────────────────────────────────┴────────────────────────────────┤
│                     Registry & State                             │
│  registry.ts (JSON file + write lock)  │  config-hash.ts        │
└─────────────────────────────────────────────────────────────────┘
```

### 2.2 核心实现

#### 2.2.1 三种 Scope 模式（`config.ts:43-54`）

OpenClaw 的沙箱隔离粒度由 `SandboxScope` 类型控制：

```typescript
// types.ts:53
export type SandboxScope = "session" | "agent" | "shared";
```

Scope 解析逻辑（`config.ts:43-54`）：

```typescript
export function resolveSandboxScope(params: {
  scope?: SandboxScope;
  perSession?: boolean;
}): SandboxScope {
  if (params.scope) {
    return params.scope;
  }
  if (typeof params.perSession === "boolean") {
    return params.perSession ? "session" : "shared";
  }
  return "agent";  // 默认：每个 Agent 独立容器
}
```

Scope Key 的计算（`shared.ts:24-34`）决定了容器名称的唯一性：
- `shared` → 固定 key `"shared"`，所有会话共用一个容器
- `session` → 使用原始 sessionKey，每个会话独立容器
- `agent` → 提取 agentId，格式 `agent:<agentId>`，同一 Agent 的不同会话共用容器

#### 2.2.2 配置 Hash 驱动容器重建（`docker.ts:419-494`）

这是 OpenClaw 沙箱最精巧的设计。每次 `ensureSandboxContainer` 被调用时：

```typescript
// docker.ts:429-434
const expectedHash = computeSandboxConfigHash({
  docker: params.cfg.docker,
  workspaceAccess: params.cfg.workspaceAccess,
  workspaceDir: params.workspaceDir,
  agentWorkspaceDir: params.agentWorkspaceDir,
});
```

Hash 计算（`config-hash.ts:44-56`）将配置对象 normalize（排序 key、过滤 undefined）后 JSON.stringify 再 SHA256：

```typescript
function computeHash(input: unknown): string {
  const payload = normalizeForHash(input);
  const raw = JSON.stringify(payload);
  return hashTextSha256(raw);
}
```

容器重建决策（`docker.ts:447-471`）：

1. 容器存在 → 读取 registry 和容器 label 中的 configHash
2. Hash 不匹配 → 检查是否"热容器"（running 且最近 5 分钟内使用过）
3. 热容器 → 仅日志警告 + 提示 CLI 命令手动重建
4. 冷容器 → `docker rm -f` 后自动重建

#### 2.2.3 多层安全校验（`validate-sandbox-security.ts`）

安全校验在容器创建时强制执行（`docker.ts:269`）：

```typescript
// docker.ts:268-269
// Runtime security validation: blocks dangerous bind mounts, network modes, and profiles.
validateSandboxSecurity(params.cfg);
```

**Bind Mount 校验**（`validate-sandbox-security.ts:125-153`）：

路径黑名单（`validate-sandbox-security.ts:13-28`）：
```typescript
export const BLOCKED_HOST_PATHS = [
  "/etc", "/private/etc", "/proc", "/sys", "/dev", "/root", "/boot",
  "/run", "/var/run", "/private/var/run",
  "/var/run/docker.sock", "/private/var/run/docker.sock", "/run/docker.sock",
];
```

校验流程：
1. 拒绝非绝对路径（防止 volume name 注入）
2. 拒绝挂载 `/`（覆盖系统根目录）
3. 字符串匹配黑名单路径（含子路径）
4. **Symlink 逃逸防护**（`validate-sandbox-security.ts:91-104`）：`realpathSync.native()` 解析符号链接后再次检查

```typescript
function tryRealpathAbsolute(path: string): string {
  if (!path.startsWith("/")) return path;
  if (!existsSync(path)) return path;
  try {
    return normalizeHostPath(realpathSync.native(path));
  } catch {
    return path;
  }
}
```

#### 2.2.4 环境变量清洗（`sanitize-env-vars.ts`）

在 `buildSandboxCreateArgs`（`docker.ts:296-304`）中调用：

```typescript
const envSanitization = sanitizeEnvVars(params.cfg.env ?? {});
if (envSanitization.blocked.length > 0) {
  log.warn(`Blocked sensitive environment variables: ${envSanitization.blocked.join(", ")}`);
}
```

三层过滤：
1. **黑名单正则**（18 条规则）：匹配 `*_API_KEY`、`*_TOKEN`、`*_PASSWORD` 等模式
2. **严格模式白名单**：仅允许 `LANG`、`PATH`、`HOME` 等 9 个系统变量
3. **值校验**：拒绝 null bytes、超长值（>32KB）、疑似 base64 凭证（80+ 字符的 base64 字母表）

#### 2.2.5 容器创建参数（`docker.ts:259-352`）

`buildSandboxCreateArgs` 构建完整的 `docker create` 命令：

```typescript
// docker.ts:284-315 核心安全参数
if (params.cfg.readOnlyRoot) {
  args.push("--read-only");           // 只读根文件系统
}
for (const entry of params.cfg.tmpfs) {
  args.push("--tmpfs", entry);        // /tmp, /var/tmp, /run 可写
}
for (const cap of params.cfg.capDrop) {
  args.push("--cap-drop", cap);       // 默认 drop ALL
}
args.push("--security-opt", "no-new-privileges");  // 禁止提权
```

默认安全配置（`config.ts:74-98`）：
- 镜像：`openclaw-sandbox:bookworm-slim`
- 网络：`none`（完全隔离）
- 根文件系统：只读
- tmpfs：`/tmp`、`/var/tmp`、`/run`
- Capability：全部 drop
- 资源限制：可配置 pidsLimit、memory、memorySwap、cpus、ulimits

### 2.3 实现细节

#### 文件系统桥接（`fs-bridge.ts`）

`SandboxFsBridgeImpl` 通过 `docker exec` 在容器内执行 shell 命令实现文件操作：

```typescript
// fs-bridge.ts:191-212
private async runCommand(script: string, options: RunCommandOptions = {}): Promise<ExecDockerRawResult> {
  const dockerArgs = ["exec", "-i", this.sandbox.containerName, "sh", "-c", script, "moltbot-sandbox-fs"];
  if (options.args?.length) {
    dockerArgs.push(...options.args);
  }
  return execDockerRaw(dockerArgs, { input: options.stdin, allowFailure: options.allowFailure, signal: options.signal });
}
```

写入前强制检查权限（`fs-bridge.ts:214-218`）：
```typescript
private ensureWriteAccess(target: SandboxResolvedFsPath, action: string) {
  if (!allowsWrites(this.sandbox.workspaceAccess) || !target.writable) {
    throw new Error(`Sandbox path is read-only; cannot ${action}: ${target.containerPath}`);
  }
}
```

#### 路径解析与挂载点匹配（`fs-paths.ts:130-191`）

路径解析支持双向翻译：
1. 容器绝对路径 → 匹配 containerRoot 最长前缀 → 计算 hostPath
2. 宿主机路径 → 匹配 hostRoot 最长前缀 → 计算 containerPath
3. 路径逃逸检测：超出所有挂载点范围则抛出错误

挂载点优先级（`fs-paths.ts:211-219`）：`bind` > `agent` > `workspace`，自定义 bind 可以 shadow 默认挂载。

#### 容器注册表（`registry.ts`）

JSON 文件持久化 + 写锁保护并发：

```typescript
// registry.ts:72-79
async function withRegistryLock<T>(registryPath: string, fn: () => Promise<T>): Promise<T> {
  const lock = await acquireSessionWriteLock({ sessionFile: registryPath, allowReentrant: false });
  try {
    return await fn();
  } finally {
    await lock.release();
  }
}
```

原子写入（`registry.ts:110-128`）：先写临时文件，再 `rename` 替换，失败时清理临时文件。

#### 容器修剪（`prune.ts`）

基于空闲时间和最大年龄的双条件修剪，节流 5 分钟一次：

```typescript
// prune.ts:22-34
function shouldPruneSandboxEntry(cfg: SandboxConfig, now: number, entry: PruneableRegistryEntry) {
  const idleMs = now - entry.lastUsedAtMs;
  const ageMs = now - entry.createdAtMs;
  return (
    (idleHours > 0 && idleMs > idleHours * 60 * 60 * 1000) ||
    (maxAgeDays > 0 && ageMs > maxAgeDays * 24 * 60 * 60 * 1000)
  );
}
```

默认：空闲 24 小时或存活 7 天即修剪。

---

## 第 3 章 迁移指南

### 3.1 迁移清单

**阶段 1：基础容器隔离**
- [ ] 实现 `buildSandboxCreateArgs` — 构建 `docker create` 安全参数
- [ ] 实现 `ensureSandboxContainer` — 幂等容器创建/启动
- [ ] 实现 `validateSandboxSecurity` — bind mount / network / seccomp 校验
- [ ] 实现 `sanitizeEnvVars` — 环境变量黑名单过滤

**阶段 2：配置管理**
- [ ] 实现 config hash 计算 — SHA256(normalize(config))
- [ ] 实现 config resolution 层级 — agent > global > default
- [ ] 实现 scope 模式 — session / agent / shared

**阶段 3：生命周期管理**
- [ ] 实现 registry — JSON 文件 + 写锁 + 原子写入
- [ ] 实现 prune — 空闲时间 + 最大年龄 + 节流
- [ ] 实现热容器保护 — 5 分钟窗口内不自动重建

**阶段 4：文件系统桥接（可选）**
- [ ] 实现 fs-bridge — docker exec 封装
- [ ] 实现 fs-paths — 双向路径翻译 + 挂载点匹配

**阶段 5：浏览器沙箱（可选）**
- [ ] 实现浏览器容器 — CDP + noVNC
- [ ] 实现 noVNC 认证 — 一次性 token + TTL

### 3.2 适配代码模板

#### 最小可用的安全容器创建

```typescript
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";

// --- 环境变量清洗 ---
const BLOCKED_ENV_PATTERNS = [
  /^ANTHROPIC_API_KEY$/i, /^OPENAI_API_KEY$/i,
  /_?(API_KEY|TOKEN|PASSWORD|PRIVATE_KEY|SECRET)$/i,
];

function sanitizeEnv(env: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (BLOCKED_ENV_PATTERNS.some(p => p.test(key))) continue;
    if (value.includes("\0") || value.length > 32768) continue;
    result[key] = value;
  }
  return result;
}

// --- 安全校验 ---
const BLOCKED_PATHS = ["/etc", "/proc", "/sys", "/dev", "/root", "/var/run/docker.sock"];

function validateBindMount(bind: string): void {
  const source = bind.split(":")[0];
  if (!source?.startsWith("/")) throw new Error(`Non-absolute bind: ${bind}`);
  if (source === "/") throw new Error("Cannot mount root");
  for (const blocked of BLOCKED_PATHS) {
    if (source === blocked || source.startsWith(blocked + "/")) {
      throw new Error(`Blocked path: ${source}`);
    }
  }
}

// --- 配置 Hash ---
function configHash(config: object): string {
  const sorted = JSON.stringify(config, Object.keys(config).sort());
  return createHash("sha256").update(sorted).digest("hex");
}

// --- 容器创建 ---
function buildCreateArgs(params: {
  name: string;
  image: string;
  workdir: string;
  workspaceDir: string;
  env?: Record<string, string>;
  binds?: string[];
}): string[] {
  const args = ["create", "--name", params.name];
  args.push("--read-only");
  args.push("--tmpfs", "/tmp", "--tmpfs", "/var/tmp", "--tmpfs", "/run");
  args.push("--cap-drop", "ALL");
  args.push("--security-opt", "no-new-privileges");
  args.push("--network", "none");
  args.push("--workdir", params.workdir);
  args.push("-v", `${params.workspaceDir}:${params.workdir}`);

  const safeEnv = sanitizeEnv(params.env ?? {});
  for (const [k, v] of Object.entries(safeEnv)) {
    args.push("--env", `${k}=${v}`);
  }
  for (const bind of params.binds ?? []) {
    validateBindMount(bind);
    args.push("-v", bind);
  }
  args.push(params.image, "sleep", "infinity");
  return args;
}
```

### 3.3 适用场景

| 场景 | 适用度 | 说明 |
|------|--------|------|
| 多 Agent 并发执行代码 | ⭐⭐⭐ | 三种 scope 模式精确控制隔离粒度 |
| 需要浏览器自动化的 Agent | ⭐⭐⭐ | 独立浏览器沙箱 + CDP + noVNC |
| 长期运行的 Agent 服务 | ⭐⭐⭐ | 配置 hash 检测漂移 + 自动修剪 |
| 单次脚本执行 | ⭐⭐ | 体系较重，简单场景可用 subprocess |
| 无 Docker 环境 | ⭐ | 强依赖 Docker CLI，无法降级 |

---

## 第 4 章 测试用例

```typescript
import { describe, it, expect } from "vitest";

// --- sanitize-env-vars 测试 ---
describe("sanitizeEnvVars", () => {
  it("should block API keys", () => {
    const result = sanitizeEnvVars({
      OPENAI_API_KEY: "sk-xxx",
      ANTHROPIC_API_KEY: "sk-ant-xxx",
      LANG: "C.UTF-8",
    });
    expect(result.blocked).toContain("OPENAI_API_KEY");
    expect(result.blocked).toContain("ANTHROPIC_API_KEY");
    expect(result.allowed).toEqual({ LANG: "C.UTF-8" });
  });

  it("should detect base64 credentials", () => {
    const longBase64 = "A".repeat(100);
    const result = sanitizeEnvVars({ SOME_VAR: longBase64 });
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings[0]).toContain("base64");
  });

  it("should reject null bytes", () => {
    const result = sanitizeEnvVars({ BAD_VAR: "hello\0world" });
    expect(result.blocked).toContain("BAD_VAR");
  });

  it("should block in strict mode if not in allowlist", () => {
    const result = sanitizeEnvVars(
      { CUSTOM_VAR: "value", LANG: "en_US" },
      { strictMode: true },
    );
    expect(result.blocked).toContain("CUSTOM_VAR");
    expect(result.allowed).toHaveProperty("LANG");
  });
});

// --- validate-sandbox-security 测试 ---
describe("validateBindMounts", () => {
  it("should block /etc mount", () => {
    expect(() => validateBindMounts(["/etc:/container/etc"])).toThrow("blocked path");
  });

  it("should block Docker socket", () => {
    expect(() => validateBindMounts(["/var/run/docker.sock:/docker.sock"])).toThrow("blocked path");
  });

  it("should block root mount", () => {
    expect(() => validateBindMounts(["/:/rootfs"])).toThrow("covers");
  });

  it("should block non-absolute paths", () => {
    expect(() => validateBindMounts(["relative/path:/container"])).toThrow("non-absolute");
  });

  it("should allow safe project paths", () => {
    expect(() => validateBindMounts(["/home/user/project:/workspace"])).not.toThrow();
  });
});

describe("validateNetworkMode", () => {
  it("should block host network", () => {
    expect(() => validateNetworkMode("host")).toThrow("blocked");
  });

  it("should allow bridge network", () => {
    expect(() => validateNetworkMode("bridge")).not.toThrow();
  });

  it("should allow none network", () => {
    expect(() => validateNetworkMode("none")).not.toThrow();
  });
});

// --- config-hash 测试 ---
describe("computeSandboxConfigHash", () => {
  it("should produce same hash for same config", () => {
    const config = { docker: { image: "test", network: "none" }, workspaceAccess: "rw" };
    const hash1 = computeSandboxConfigHash(config as any);
    const hash2 = computeSandboxConfigHash(config as any);
    expect(hash1).toBe(hash2);
  });

  it("should produce different hash for different config", () => {
    const config1 = { docker: { image: "test", network: "none" } };
    const config2 = { docker: { image: "test", network: "bridge" } };
    expect(computeSandboxConfigHash(config1 as any)).not.toBe(computeSandboxConfigHash(config2 as any));
  });
});

// --- scope 解析测试 ---
describe("resolveSandboxScope", () => {
  it("should default to agent scope", () => {
    expect(resolveSandboxScope({})).toBe("agent");
  });

  it("should respect explicit scope", () => {
    expect(resolveSandboxScope({ scope: "session" })).toBe("session");
  });

  it("should map perSession=true to session", () => {
    expect(resolveSandboxScope({ perSession: true })).toBe("session");
  });
});
```

---

## 第 5 章 跨域关联

| 关联域 | 关系类型 | 说明 |
|--------|----------|------|
| PD-01 上下文管理 | 协同 | 沙箱工作区目录可作为 Agent 上下文的持久化存储位置 |
| PD-04 工具系统 | 依赖 | 沙箱的 tool-policy 控制哪些工具可在沙箱内使用，`isToolAllowed` 基于 glob 模式匹配 |
| PD-06 记忆持久化 | 协同 | `shared` scope 的沙箱工作区可跨会话保留文件，实现简单的文件级记忆 |
| PD-09 Human-in-the-Loop | 协同 | 热容器保护机制提示用户手动重建，而非自动中断；noVNC 允许人类观察浏览器操作 |
| PD-11 可观测性 | 协同 | registry 记录容器创建时间、最后使用时间、configHash，可用于审计和成本追踪 |

---

## 第 6 章 来源文件索引

| 文件 | 行范围 | 关键实现 |
|------|--------|----------|
| `src/agents/sandbox/types.ts` | L1-91 | 核心类型定义：SandboxConfig, SandboxScope, SandboxContext |
| `src/agents/sandbox/constants.ts` | L1-55 | 默认值常量：镜像名、端口、超时、工具白名单/黑名单 |
| `src/agents/sandbox/config.ts` | L43-195 | 配置解析：scope/docker/browser/prune 四层 resolve |
| `src/agents/sandbox/docker.ts` | L259-494 | 容器创建参数构建 + 幂等 ensure + hash 驱动重建 |
| `src/agents/sandbox/validate-sandbox-security.ts` | L13-195 | 安全校验：bind mount 黑名单 + symlink 防护 + 网络/seccomp/apparmor |
| `src/agents/sandbox/sanitize-env-vars.ts` | L1-111 | 环境变量清洗：正则黑名单 + base64 检测 + null byte 拒绝 |
| `src/agents/sandbox/config-hash.ts` | L1-57 | 配置 hash：normalize + JSON.stringify + SHA256 |
| `src/agents/sandbox/registry.ts` | L1-206 | 容器注册表：JSON 持久化 + 写锁 + 原子写入 |
| `src/agents/sandbox/prune.ts` | L1-113 | 容器修剪：空闲时间/最大年龄 + 5 分钟节流 |
| `src/agents/sandbox/fs-bridge.ts` | L1-248 | 文件系统桥接：docker exec 封装 + 读写权限控制 |
| `src/agents/sandbox/fs-paths.ts` | L1-295 | 路径解析：双向翻译 + 挂载点匹配 + 逃逸检测 |
| `src/agents/sandbox/context.ts` | L108-211 | 上下文组装：workspace layout + docker user + browser + fsBridge |
| `src/agents/sandbox/tool-policy.ts` | L1-110 | 工具策略：glob 匹配 + agent/global/default 三级 |
| `src/agents/sandbox/runtime-status.ts` | L1-139 | 运行时状态：sandbox 决策 + 工具阻断消息 |
| `src/agents/sandbox/shared.ts` | L1-47 | 共享工具：slugify + scope key + workspace dir |

---

## 第 7 章 横向对比维度

> **重要：** 本章用于自动填充 Butcher Wiki 的横向对比表。

```json comparison_data
{
  "project": "OpenClaw",
  "dimensions": {
    "隔离级别": "Docker 容器级：read-only root + cap-drop ALL + no-new-privileges + 独立浏览器容器",
    "虚拟路径": "双向翻译：host↔container 路径通过挂载点匹配，支持 workspace/agent/bind 三种挂载源",
    "生命周期管理": "配置 hash 驱动重建 + JSON registry 持久化 + 空闲24h/存活7天自动修剪",
    "防御性设计": "5 层纵深防御：bind 黑名单 + symlink 逃逸防护 + env 清洗 + 网络/seccomp/apparmor 校验",
    "代码修复": "热容器保护：5 分钟窗口内不自动重建，提示 CLI 命令手动操作",
    "Scope 粒度": "三种模式：session（每会话）/ agent（每 Agent）/ shared（全局共享）",
    "工具访问控制": "glob 模式 allow/deny 列表，agent > global > default 三级优先级"
  }
}
```

### 域元数据补充

```json domain_metadata
{
  "description": "配置 hash 驱动容器重建，防止运行时配置漂移导致安全降级",
  "sub_problems": [
    "配置漂移检测：运行中容器的配置与期望配置不一致时如何感知和修复",
    "浏览器隔离：Agent 控制的浏览器需要独立网络和认证机制",
    "工具访问控制：沙箱内 Agent 可使用的工具需要细粒度 allow/deny 策略"
  ],
  "best_practices": [
    "配置 hash 检测漂移：SHA256(normalize(config)) 对比容器 label，冷容器自动重建",
    "热容器保护窗口：最近使用的容器不自动重建，避免中断正在执行的任务",
    "环境变量三层过滤：正则黑名单 + 值校验（null byte/超长/base64）+ 可选严格白名单",
    "原子注册表写入：临时文件 + rename 防止并发写入损坏，写锁防止竞态",
    "Symlink 逃逸防护：realpathSync 解析符号链接后再次校验黑名单"
  ]
}
```
