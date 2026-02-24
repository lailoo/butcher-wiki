# PD-38.01 OpenClaw — 守护进程跨平台服务管理方案

> 文档编号：PD-38.01
> 来源：OpenClaw `src/daemon/`
> GitHub：https://github.com/openclaw/openclaw
> 问题域：PD-38 守护进程管理 Daemon Service Management
> 状态：可复用方案

---

## 第 1 章 问题与动机

### 1.1 核心问题

Agent 系统通常需要一个常驻后台进程（Gateway）来接收外部请求、管理会话、转发消息。这个 Gateway 必须：

- **开机自启**：用户登录后自动运行，无需手动启动
- **崩溃自愈**：进程异常退出后由 OS 级服务管理器自动重启
- **跨平台**：macOS（launchd）、Linux（systemd）、Windows（Scheduled Tasks）三套完全不同的服务管理机制
- **运行时安全**：服务进程的 PATH 环境变量必须最小化，避免版本管理器（nvm/fnm/volta）路径污染导致升级后服务崩溃
- **配置漂移检测**：服务内嵌的 token/路径与配置文件可能不同步，需要审计机制

这不是一个简单的"写个 plist 文件"的问题。真正的难点在于：三个平台的服务管理 API 完全不同（launchctl vs systemctl vs schtasks），遗留服务清理、运行时二进制路径解析、环境变量传递策略各有陷阱。

### 1.2 OpenClaw 的解法概述

OpenClaw 采用 **GatewayService 统一接口 + 平台适配器** 模式，核心设计：

1. **统一接口抽象**（`service.ts:54-65`）：`GatewayService` 类型定义 8 个方法（install/uninstall/stop/restart/isLoaded/readCommand/readRuntime），三平台实现同一接口
2. **工厂函数路由**（`service.ts:67-114`）：`resolveGatewayService()` 根据 `process.platform` 返回对应平台实现，调用方无需感知平台差异
3. **服务配置文件生成器**：`launchd-plist.ts` 生成 XML plist、`systemd-unit.ts` 生成 INI 格式 unit 文件、`schtasks.ts` 生成 `.cmd` 批处理脚本
4. **运行时审计系统**（`service-audit.ts`）：13 种审计码覆盖 token 漂移、PATH 污染、运行时二进制兼容性、plist/unit 配置完整性
5. **遗留服务发现与清理**（`inspect.ts`）：扫描三平台的服务目录，识别 openclaw/clawdbot/moltbot 等历史品牌标记，自动清理

### 1.3 设计思想

| 设计原则 | 具体实现 | 理由 | 替代方案 |
|----------|----------|------|----------|
| 接口统一，实现分离 | `GatewayService` 类型 + `resolveGatewayService()` 工厂 | 调用方一套代码管理三平台 | 每个平台独立 CLI 命令（维护成本 3x） |
| 最小化 PATH | `service-env.ts` 构建精简 PATH，排除版本管理器 | 版本管理器路径在 node 升级后失效，导致服务崩溃 | 继承用户完整 PATH（不稳定） |
| 审计优于断言 | `service-audit.ts` 返回 issues 列表而非直接报错 | 允许用户选择性修复，区分 recommended/aggressive 级别 | 硬性校验阻断安装（用户体验差） |
| 遗留兼容 | `inspect.ts` 扫描多品牌标记（openclaw/clawdbot/moltbot） | 产品重命名后旧服务残留会冲突 | 忽略旧服务（端口冲突） |
| 声明式配置生成 | plist/unit/cmd 文件由代码生成而非手写模板 | 参数化生成避免模板变量遗漏 | Mustache/Handlebars 模板（额外依赖） |

---

## 第 2 章 源码实现分析

### 2.1 架构概览

```
┌─────────────────────────────────────────────────────────┐
│                    调用方 (CLI / Wizard)                  │
│              gateway install / status / restart           │
└──────────────────────┬──────────────────────────────────┘
                       │
                       ▼
┌──────────────────────────────────────────────────────────┐
│              resolveGatewayService()                      │
│              service.ts:67-114                            │
│  ┌─────────┬─────────────────┬────────────────────────┐  │
│  │ darwin  │     linux       │       win32             │  │
│  └────┬────┴────────┬────────┴───────────┬────────────┘  │
│       │             │                    │               │
│       ▼             ▼                    ▼               │
│  ┌─────────┐  ┌──────────┐  ┌──────────────────────┐    │
│  │ launchd │  │ systemd  │  │    schtasks          │    │
│  │  .ts    │  │  .ts     │  │     .ts              │    │
│  └────┬────┘  └────┬─────┘  └──────────┬───────────┘    │
│       │            │                   │                │
│       ▼            ▼                   ▼                │
│  launchd-plist  systemd-unit     cmd-argv/cmd-set       │
│  (XML 生成)     (INI 生成)       (.cmd 脚本生成)         │
└──────────────────────────────────────────────────────────┘
                       │
          ┌────────────┼────────────────┐
          ▼            ▼                ▼
   service-audit   service-env     inspect.ts
   (配置审计)      (PATH 构建)     (遗留服务发现)
```

### 2.2 核心实现

#### 2.2.1 GatewayService 统一接口（`service.ts:54-114`）

接口定义了三平台共有的 8 个操作，每个平台返回自己的实现：

```typescript
// service.ts:54-65
export type GatewayService = {
  label: string;                    // 平台标识："LaunchAgent" | "systemd" | "Scheduled Task"
  loadedText: string;               // 状态文本："loaded" | "enabled" | "registered"
  notLoadedText: string;
  install: (args: GatewayServiceInstallArgs) => Promise<void>;
  uninstall: (args: GatewayServiceManageArgs) => Promise<void>;
  stop: (args: GatewayServiceControlArgs) => Promise<void>;
  restart: (args: GatewayServiceControlArgs) => Promise<void>;
  isLoaded: (args: GatewayServiceEnvArgs) => Promise<boolean>;
  readCommand: (env: GatewayServiceEnv) => Promise<GatewayServiceCommandConfig | null>;
  readRuntime: (env: GatewayServiceEnv) => Promise<GatewayServiceRuntime>;
};

// service.ts:67-114
export function resolveGatewayService(): GatewayService {
  if (process.platform === "darwin") {
    return {
      label: "LaunchAgent",
      install: ignoreInstallResult(installLaunchAgent),
      uninstall: uninstallLaunchAgent,
      stop: stopLaunchAgent,
      restart: restartLaunchAgent,
      isLoaded: isLaunchAgentLoaded,
      readCommand: readLaunchAgentProgramArguments,
      readRuntime: readLaunchAgentRuntime,
    };
  }
  // ... linux → systemd, win32 → schtasks
  throw new Error(`Gateway service install not supported on ${process.platform}`);
}
```

关键设计：`ignoreInstallResult()` 包装器（`service.ts:46-52`）将平台 install 返回的 `{ plistPath }` / `{ unitPath }` 统一为 `void`，保持接口一致。

#### 2.2.2 macOS LaunchAgent 安装流程（`launchd.ts:344-415`）

安装流程包含 6 个关键步骤，处理了 launchd 的多个陷阱：

```typescript
// launchd.ts:344-415
export async function installLaunchAgent({
  env, stdout, programArguments, workingDirectory, environment, description,
}: GatewayServiceInstallArgs): Promise<{ plistPath: string }> {
  // 1. 创建日志目录
  const { logDir, stdoutPath, stderrPath } = resolveGatewayLogPaths(env);
  await fs.mkdir(logDir, { recursive: true });

  // 2. 清理遗留 LaunchAgent（品牌重命名后的残留）
  const domain = resolveGuiDomain();
  const label = resolveLaunchAgentLabel({ env });
  for (const legacyLabel of resolveLegacyGatewayLaunchAgentLabels(env.OPENCLAW_PROFILE)) {
    const legacyPlistPath = resolveLaunchAgentPlistPathForLabel(env, legacyLabel);
    await execLaunchctl(["bootout", domain, legacyPlistPath]);
    await execLaunchctl(["unload", legacyPlistPath]);
    try { await fs.unlink(legacyPlistPath); } catch { /* ignore */ }
  }

  // 3. 生成 plist XML 并写入
  const plist = buildLaunchAgentPlist({ label, comment: serviceDescription, ... });
  await fs.writeFile(plistPath, plist, "utf8");

  // 4. 先卸载旧版本（bootout + unload），再清除 disabled 状态
  await execLaunchctl(["bootout", domain, plistPath]);
  await execLaunchctl(["unload", plistPath]);
  await execLaunchctl(["enable", `${domain}/${label}`]);  // 关键！清除持久化的 disabled 状态

  // 5. bootstrap 注册 + kickstart 强制启动
  const boot = await execLaunchctl(["bootstrap", domain, plistPath]);
  if (boot.code !== 0) {
    // 检测 GUI domain 不可用（SSH/headless 环境）
    if (isUnsupportedGuiDomain(detail)) {
      throw new Error("LaunchAgent install requires a logged-in macOS GUI session...");
    }
  }
  await execLaunchctl(["kickstart", "-k", `${domain}/${label}`]);
  return { plistPath };
}
```

`resolveGuiDomain()`（`launchd.ts:107-112`）通过 `process.getuid()` 获取当前用户 UID，构造 `gui/501` 格式的 launchd domain。这是 macOS 10.10+ 的新 API，旧的 `launchctl load` 已被废弃。

#### 2.2.3 systemd Unit 文件生成（`systemd-unit.ts:38-75`）

```typescript
// systemd-unit.ts:38-75
export function buildSystemdUnit({
  description, programArguments, workingDirectory, environment,
}: GatewayServiceRenderArgs): string {
  const execStart = programArguments.map(systemdEscapeArg).join(" ");
  return [
    "[Unit]",
    `Description=${descriptionValue}`,
    "After=network-online.target",
    "Wants=network-online.target",
    "",
    "[Service]",
    `ExecStart=${execStart}`,
    "Restart=always",
    "RestartSec=5",
    "KillMode=process",  // 关键：只等主进程退出，不等 conmon 等子进程
    workingDirLine,
    ...envLines,          // Environment="KEY=VALUE" 格式
    "",
    "[Install]",
    "WantedBy=default.target",
  ].filter((line) => line !== null).join("\n");
}
```

`KillMode=process` 是一个重要的工程决策（`systemd-unit.ts:64-65`）：OpenClaw Gateway 可能通过 podman 启动容器，容器的 conmon 监控进程作为子进程运行在同一 cgroup 中。默认的 `KillMode=control-group` 会等待所有子进程退出，导致 systemd 重启时阻塞。

#### 2.2.4 Windows Scheduled Tasks 批处理脚本（`schtasks.ts:135-161`）

Windows 平台不使用原生服务（需要 Administrator），而是用 Scheduled Tasks + `.cmd` 脚本：

```typescript
// schtasks.ts:135-161
function buildTaskScript({
  description, programArguments, workingDirectory, environment,
}: GatewayServiceRenderArgs): string {
  const lines: string[] = ["@echo off"];
  if (trimmedDescription) lines.push(`rem ${trimmedDescription}`);
  if (workingDirectory) lines.push(`cd /d ${quoteCmdScriptArg(workingDirectory)}`);
  if (environment) {
    for (const [key, value] of Object.entries(environment)) {
      lines.push(renderCmdSetAssignment(key, value));  // set "KEY=VALUE"
    }
  }
  const command = programArguments.map(quoteCmdScriptArg).join(" ");
  lines.push(command);
  return `${lines.join("\r\n")}\r\n`;
}
```

注册时使用 `ONLOGON` 触发器 + `LIMITED` 权限级别（`schtasks.ts:194-205`），并尝试指定 `/RU` 用户参数。如果带用户参数失败（权限不足），自动降级为不指定用户的方式重试（`schtasks.ts:207-211`）。

### 2.3 实现细节

#### 2.3.1 服务审计系统（`service-audit.ts:384-405`）

审计系统是 OpenClaw 守护进程管理的核心差异化能力。`auditGatewayServiceConfig()` 组合 5 个子审计器：

```
auditGatewayServiceConfig()
  ├── auditGatewayCommand()      → 检查 programArguments 是否包含 gateway 子命令
  ├── auditGatewayToken()        → 检查服务 token 与配置文件 token 是否一致
  ├── auditGatewayServicePath()  → 检查 PATH 是否最小化、是否包含版本管理器路径
  ├── auditGatewayRuntime()      → 检查运行时二进制（Bun 不兼容、版本管理器 Node 不稳定）
  └── auditSystemdUnit() / auditLaunchdPlist()  → 平台特定配置检查
```

13 种审计码（`service-audit.ts:32-48`）覆盖了实际运维中遇到的所有常见问题：

| 审计码 | 检查内容 | 级别 |
|--------|----------|------|
| `gateway-runtime-bun` | Bun 运行时与 WhatsApp/Telegram 通道不兼容 | recommended |
| `gateway-runtime-node-version-manager` | 版本管理器的 Node 路径在升级后失效 | recommended |
| `gateway-path-nonminimal` | PATH 包含 .nvm/.fnm/.volta 等路径 | recommended |
| `gateway-token-drift` | 服务内嵌 token 与配置文件 token 不一致 | recommended |
| `launchd-keep-alive` | plist 缺少 KeepAlive=true | recommended |
| `systemd-after-network-online` | unit 缺少 After=network-online.target | recommended |

#### 2.3.2 最小化 PATH 构建（`service-env.ts:145-184`）

服务进程的 PATH 不能继承用户 shell 的完整 PATH（包含版本管理器路径），需要精心构建：

```
macOS PATH 构建顺序:
  1. extraDirs（调用方指定）
  2. 用户 bin 目录: ~/.local/bin, ~/.npm-global/bin, ~/Library/pnpm, ...
  3. 系统目录: /opt/homebrew/bin, /usr/local/bin, /usr/bin, /bin

Linux PATH 构建顺序:
  1. extraDirs
  2. 用户 bin 目录: ~/.local/bin, ~/.nvm/current/bin, ~/.fnm/current/bin, ...
  3. 系统目录: /usr/local/bin, /usr/bin, /bin
```

`resolveDarwinUserBinDirs()`（`service-env.ts:79-113`）和 `resolveLinuxUserBinDirs()`（`service-env.ts:119-143`）分别处理两个平台的版本管理器路径差异。例如 fnm 在 macOS 上默认路径是 `~/Library/Application Support/fnm`，而 Linux 上是 `~/.fnm`。

#### 2.3.3 遗留服务发现（`inspect.ts:315-432`）

`findExtraGatewayServices()` 扫描三平台的服务目录，通过品牌标记（openclaw/clawdbot/moltbot）识别遗留服务：

```
macOS 扫描路径:
  - ~/Library/LaunchAgents (user scope)
  - /Library/LaunchAgents (system scope, deep mode)
  - /Library/LaunchDaemons (system scope, deep mode)

Linux 扫描路径:
  - ~/.config/systemd/user (user scope)
  - /etc/systemd/system (system scope, deep mode)
  - /usr/lib/systemd/system (system scope, deep mode)

Windows:
  - schtasks /Query /FO LIST /V (deep mode only)
```

去重通过 `platform:label:detail:scope` 组合键实现（`inspect.ts:322-328`）。

#### 2.3.4 运行时二进制路径解析（`runtime-paths.ts`）

`resolvePreferredNodePath()`（`runtime-paths.ts:156-185`）的选择策略：

1. 优先使用当前运行 `openclaw gateway install` 的 Node（尊重用户的版本管理器选择）
2. 验证版本 >= 22（`isSupportedNodeVersion()`）
3. 如果当前 Node 不合格，降级到系统 Node（`/opt/homebrew/bin/node` 或 `/usr/local/bin/node`）
4. 系统 Node 也不合格则返回 undefined，由调用方决定

版本管理器检测通过路径特征匹配（`runtime-paths.ts:7-16`）：

```typescript
const VERSION_MANAGER_MARKERS = [
  "/.nvm/", "/.fnm/", "/.volta/", "/.asdf/",
  "/.n/", "/.nodenv/", "/.nodebrew/", "/nvs/",
];
```

---

## 第 3 章 迁移指南

### 3.1 迁移清单

**阶段 1：定义统一接口**

- [ ] 定义 `ServiceManager` 接口：install / uninstall / start / stop / restart / status
- [ ] 定义 `ServiceConfig` 类型：programArguments, workingDirectory, environment
- [ ] 实现 `resolveServiceManager()` 工厂函数，按 `process.platform` 路由

**阶段 2：实现平台适配器**

- [ ] macOS：实现 plist XML 生成 + launchctl bootstrap/bootout/kickstart 调用
- [ ] Linux：实现 systemd unit 生成 + systemctl --user daemon-reload/enable/restart
- [ ] Windows：实现 .cmd 脚本生成 + schtasks /Create /SC ONLOGON

**阶段 3：环境安全**

- [ ] 实现最小化 PATH 构建，排除版本管理器路径
- [ ] 实现运行时二进制解析（优先当前 Node → 降级系统 Node）
- [ ] 实现服务环境变量注入（token, port, state dir 等）

**阶段 4：运维能力**

- [ ] 实现服务配置审计（token 漂移、PATH 污染、配置完整性）
- [ ] 实现遗留服务发现与清理
- [ ] 实现日志路径管理和错误诊断

### 3.2 适配代码模板

以下是一个可直接复用的跨平台服务管理器骨架：

```typescript
// service-manager.ts — 跨平台服务管理器
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const execFileAsync = promisify(execFile);

// --- 统一接口 ---
type ServiceConfig = {
  label: string;
  programArguments: string[];
  workingDirectory?: string;
  environment?: Record<string, string>;
  stdoutPath: string;
  stderrPath: string;
};

type ServiceManager = {
  install(config: ServiceConfig): Promise<void>;
  uninstall(label: string): Promise<void>;
  restart(label: string): Promise<void>;
  isRunning(label: string): Promise<boolean>;
};

// --- 工厂函数 ---
function createServiceManager(): ServiceManager {
  switch (process.platform) {
    case "darwin": return createLaunchdManager();
    case "linux":  return createSystemdManager();
    case "win32":  return createSchtasksManager();
    default: throw new Error(`Unsupported platform: ${process.platform}`);
  }
}

// --- macOS 实现 ---
function createLaunchdManager(): ServiceManager {
  const uid = process.getuid?.() ?? 501;
  const domain = `gui/${uid}`;

  return {
    async install(config) {
      const plistPath = path.join(
        os.homedir(), "Library", "LaunchAgents", `${config.label}.plist`
      );
      const plist = buildPlist(config);
      await fs.mkdir(path.dirname(plistPath), { recursive: true });
      await fs.writeFile(plistPath, plist, "utf8");
      // 先清理旧状态
      await launchctl(["bootout", domain, plistPath]).catch(() => {});
      await launchctl(["enable", `${domain}/${config.label}`]);
      await launchctl(["bootstrap", domain, plistPath]);
      await launchctl(["kickstart", "-k", `${domain}/${config.label}`]);
    },
    async uninstall(label) {
      const plistPath = path.join(
        os.homedir(), "Library", "LaunchAgents", `${label}.plist`
      );
      await launchctl(["bootout", domain, plistPath]).catch(() => {});
      await fs.unlink(plistPath).catch(() => {});
    },
    async restart(label) {
      await launchctl(["kickstart", "-k", `${domain}/${label}`]);
    },
    async isRunning(label) {
      const { exitCode } = await launchctl(["print", `${domain}/${label}`]);
      return exitCode === 0;
    },
  };
}

async function launchctl(args: string[]) {
  try {
    const { stdout, stderr } = await execFileAsync("launchctl", args);
    return { stdout, stderr, exitCode: 0 };
  } catch (err: any) {
    return { stdout: err.stdout ?? "", stderr: err.stderr ?? "", exitCode: err.code ?? 1 };
  }
}

function buildPlist(config: ServiceConfig): string {
  const escape = (s: string) => s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
  const args = config.programArguments.map(a => `<string>${escape(a)}</string>`).join("\n      ");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key><string>${escape(config.label)}</string>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key><true/>
    <key>ProgramArguments</key>
    <array>${args}</array>
    <key>StandardOutPath</key><string>${escape(config.stdoutPath)}</string>
    <key>StandardErrorPath</key><string>${escape(config.stderrPath)}</string>
  </dict>
</plist>`;
}
```

### 3.3 适用场景

| 场景 | 适用度 | 说明 |
|------|--------|------|
| Agent Gateway 常驻服务 | ⭐⭐⭐ | 核心场景，开机自启 + 崩溃自愈 |
| CLI 工具后台守护进程 | ⭐⭐⭐ | 如 MCP server、本地 API proxy |
| 定时任务调度 | ⭐⭐ | systemd timer / launchd StartCalendarInterval 更合适 |
| 容器化部署 | ⭐ | 容器内通常用 supervisor/s6，不需要 OS 级服务管理 |
| 无 GUI 的 headless 服务器 | ⭐⭐ | macOS launchd 需要 GUI session，需改用 LaunchDaemon |

---

## 第 4 章 测试用例

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";

// --- 测试 GatewayService 工厂路由 ---
describe("resolveGatewayService", () => {
  it("darwin 返回 LaunchAgent 实现", () => {
    vi.stubGlobal("process", { ...process, platform: "darwin" });
    const svc = resolveGatewayService();
    expect(svc.label).toBe("LaunchAgent");
    expect(svc.loadedText).toBe("loaded");
  });

  it("linux 返回 systemd 实现", () => {
    vi.stubGlobal("process", { ...process, platform: "linux" });
    const svc = resolveGatewayService();
    expect(svc.label).toBe("systemd");
    expect(svc.loadedText).toBe("enabled");
  });

  it("不支持的平台抛出异常", () => {
    vi.stubGlobal("process", { ...process, platform: "freebsd" });
    expect(() => resolveGatewayService()).toThrow("not supported");
  });
});

// --- 测试 systemd unit 生成 ---
describe("buildSystemdUnit", () => {
  it("生成包含 KillMode=process 的 unit 文件", () => {
    const unit = buildSystemdUnit({
      description: "Test Gateway",
      programArguments: ["/usr/bin/node", "gateway.js"],
      workingDirectory: "/opt/app",
      environment: { PORT: "3000" },
    });
    expect(unit).toContain("KillMode=process");
    expect(unit).toContain("RestartSec=5");
    expect(unit).toContain("After=network-online.target");
    expect(unit).toContain('ExecStart=/usr/bin/node gateway.js');
    expect(unit).toContain('Environment="PORT=3000"');
  });
});

// --- 测试 launchctl 输出解析 ---
describe("parseLaunchctlPrint", () => {
  it("解析运行中的服务状态", () => {
    const output = "state = running\npid = 12345\nlast exit status = 0";
    const info = parseLaunchctlPrint(output);
    expect(info.state).toBe("running");
    expect(info.pid).toBe(12345);
    expect(info.lastExitStatus).toBe(0);
  });
});

// --- 测试审计系统 ---
describe("auditGatewayServiceConfig", () => {
  it("检测 Bun 运行时不兼容", async () => {
    const result = await auditGatewayServiceConfig({
      env: {},
      command: {
        programArguments: ["/usr/local/bin/bun", "gateway.js"],
        environment: {},
      },
    });
    expect(result.ok).toBe(false);
    expect(result.issues.some(i => i.code === "gateway-runtime-bun")).toBe(true);
  });

  it("检测版本管理器 Node 路径", async () => {
    const result = await auditGatewayServiceConfig({
      env: {},
      command: {
        programArguments: ["/home/user/.nvm/versions/node/v20.0.0/bin/node", "gateway.js"],
        environment: {},
      },
    });
    expect(result.issues.some(i => i.code === "gateway-runtime-node-version-manager")).toBe(true);
  });

  it("检测 token 漂移", () => {
    const issue = checkTokenDrift({
      serviceToken: "old-token",
      configToken: "new-token",
    });
    expect(issue).not.toBeNull();
    expect(issue!.code).toBe("gateway-token-drift");
  });
});

// --- 测试版本管理器路径检测 ---
describe("isVersionManagedNodePath", () => {
  it("识别 nvm 路径", () => {
    expect(isVersionManagedNodePath("/home/user/.nvm/versions/node/v20/bin/node", "linux")).toBe(true);
  });
  it("识别 fnm 路径", () => {
    expect(isVersionManagedNodePath("/home/user/.fnm/node-versions/v20/bin/node", "linux")).toBe(true);
  });
  it("系统路径不误判", () => {
    expect(isVersionManagedNodePath("/usr/local/bin/node", "linux")).toBe(false);
  });
});
```

---

## 第 5 章 跨域关联

| 关联域 | 关系类型 | 说明 |
|--------|----------|------|
| PD-04 工具系统 | 协同 | Gateway 作为 MCP server 的宿主进程，工具系统的可用性依赖 Gateway 服务的稳定运行 |
| PD-11 可观测性 | 协同 | 服务审计系统（service-audit）是可观测性的一部分，提供运行时健康检查数据 |
| PD-03 容错与重试 | 依赖 | 服务的 KeepAlive/Restart=always 是 OS 级容错机制，与应用层重试互补 |
| PD-05 沙箱隔离 | 协同 | 最小化 PATH 和环境变量传递是服务级别的隔离策略，与代码执行沙箱互补 |
| PD-09 Human-in-the-Loop | 协同 | 审计系统的 recommended/aggressive 分级允许用户选择性修复，体现 HITL 理念 |

---

## 第 6 章 来源文件索引

| 文件 | 行范围 | 关键实现 |
|------|--------|----------|
| `src/daemon/service.ts` | L54-L114 | GatewayService 统一接口 + resolveGatewayService 工厂 |
| `src/daemon/launchd.ts` | L98-L415 | macOS LaunchAgent 完整生命周期管理 |
| `src/daemon/systemd.ts` | L32-L410 | Linux systemd user service 管理 |
| `src/daemon/schtasks.ts` | L21-L318 | Windows Scheduled Tasks 管理 |
| `src/daemon/service-audit.ts` | L32-L405 | 13 种审计码 + 5 个子审计器 |
| `src/daemon/service-env.ts` | L61-L260 | 最小化 PATH 构建 + 服务环境变量组装 |
| `src/daemon/inspect.ts` | L12-L432 | 遗留服务发现（三平台扫描） |
| `src/daemon/runtime-paths.ts` | L7-L185 | 版本管理器检测 + 系统 Node 路径解析 |
| `src/daemon/launchd-plist.ts` | L82-L110 | plist XML 生成器 |
| `src/daemon/systemd-unit.ts` | L38-L75 | systemd unit INI 生成器 |
| `src/daemon/service-types.ts` | L1-L39 | 服务类型定义 |
| `src/daemon/service-runtime.ts` | L1-L13 | 运行时状态类型 |
| `src/daemon/diagnostics.ts` | L4-L44 | 日志错误模式匹配 |
| `src/process/supervisor/supervisor.ts` | L34-L282 | 进程 Supervisor（超时 + 作用域取消） |

---

## 第 7 章 横向对比维度

```json comparison_data
{
  "project": "OpenClaw",
  "dimensions": {
    "平台覆盖": "macOS launchd + Linux systemd + Windows schtasks 三平台统一接口",
    "服务抽象": "GatewayService 类型 + resolveGatewayService() 工厂函数路由",
    "配置生成": "代码生成 plist XML / systemd unit INI / .cmd 批处理，非模板引擎",
    "健康审计": "13 种审计码覆盖 token 漂移、PATH 污染、运行时兼容性、配置完整性",
    "遗留清理": "多品牌标记扫描（openclaw/clawdbot/moltbot）+ 自动 bootout/disable",
    "环境隔离": "最小化 PATH 构建，排除 nvm/fnm/volta 等 8 种版本管理器路径",
    "运行时解析": "优先当前 Node → 降级系统 Node，检测 Bun 不兼容场景"
  }
}
```

```json domain_metadata
{
  "solution_summary": "OpenClaw 用 GatewayService 统一接口 + 平台工厂路由抽象 launchd/systemd/schtasks 三平台，配合 13 种审计码检测 token 漂移与 PATH 污染",
  "description": "守护进程管理需要处理遗留品牌迁移、版本管理器路径污染和配置漂移检测",
  "sub_problems": [
    "遗留品牌服务迁移（产品重命名后旧服务残留冲突）",
    "launchd GUI domain 限制（SSH/headless 环境无法 bootstrap）",
    "systemd KillMode 与容器子进程的交互（conmon 阻塞重启）"
  ],
  "best_practices": [
    "launchctl enable 清除持久化 disabled 状态后再 bootstrap",
    "最小化 PATH 排除 8 种版本管理器路径防止升级后服务崩溃",
    "审计分 recommended/aggressive 两级允许用户选择性修复"
  ]
}
```
