# PD-41.01 OpenClaw — Playwright+CDP 双通道浏览器自动化方案

> 文档编号：PD-41.01
> 来源：OpenClaw `src/browser/`
> GitHub：https://github.com/openclaw/openclaw
> 问题域：PD-41 浏览器自动化 Browser Automation
> 状态：可复用方案

---

## 第 1 章 问题与动机

### 1.1 核心问题

Agent 系统需要与真实浏览器交互——导航网页、填写表单、截取屏幕、读取页面状态。这不是简单的 HTTP 请求，而是需要控制一个有状态的、带 GUI 的浏览器实例。核心挑战包括：

1. **Chrome 实例生命周期管理**：启动、探活、重启、优雅关闭，跨平台可执行文件发现
2. **双通道控制**：既要支持 OpenClaw 自管理的隔离浏览器（`openclaw` profile），又要支持接管用户已有的 Chrome 标签页（`chrome` profile + 扩展中继）
3. **安全边界**：SSRF 防护、导航白名单、认证令牌、loopback 限制
4. **AI 友好的页面表示**：将 DOM 转换为 ARIA 快照 + 角色引用（ref），让 LLM 能"看懂"页面并精确操作元素
5. **多 profile 并行**：不同 Agent 可能同时操作不同浏览器实例，需要端口隔离和状态隔离

### 1.2 OpenClaw 的解法概述

OpenClaw 构建了一个完整的浏览器自动化子系统，核心设计：

1. **Express 控制服务器**（`server.ts:21-81`）：HTTP API 统一暴露所有浏览器操作，监听 `127.0.0.1:18791`
2. **双驱动架构**：`driver: "openclaw"` 直接 spawn Chrome 进程 + CDP；`driver: "extension"` 通过 Chrome 扩展 WebSocket 中继接管用户浏览器（`extension-relay.ts`）
3. **Playwright-core 作为高级操作层**（`pw-session.ts`）：连接到 CDP 端点，提供 click/type/snapshot 等 AI 友好操作
4. **Navigation Guard**（`navigation-guard.ts:32-63`）：所有导航操作必须通过 SSRF 策略检查
5. **Profile 系统**（`config.ts:262-297`）：每个 profile 独立 CDP 端口、颜色标识、驱动类型，支持配置热重载

### 1.3 设计思想

| 设计原则 | 具体实现 | 理由 | 替代方案 |
|----------|----------|------|----------|
| 双通道控制 | openclaw driver 直接管理 Chrome 进程；extension driver 通过 WebSocket 中继 | 既支持隔离自动化，又支持接管用户已登录的浏览器会话 | 仅用 Puppeteer 连接（无法接管已有浏览器） |
| CDP 优先 + Playwright 增强 | 底层用原始 CDP 做截图/JS执行/ARIA树；高层用 Playwright 做 click/type/snapshot | CDP 轻量无依赖；Playwright 提供稳定的元素定位和等待机制 | 纯 CDP（需自己实现等待逻辑）或纯 Playwright（无法做扩展中继） |
| ref 引用系统 | ARIA 快照生成 `e1/e2/...` 引用，后续操作通过 ref 定位元素 | LLM 无法直接操作 CSS 选择器，ref 是 AI 友好的元素标识 | XPath（太脆弱）、坐标点击（不稳定） |
| 安全纵深防御 | navigation-guard + SSRF 策略 + loopback 限制 + 令牌认证 | 浏览器是高权限组件，必须防止 Agent 被注入恶意导航 | 仅靠 Agent prompt 约束（不可靠） |
| 配置热重载 | `resolved-config-refresh.ts` 从磁盘重新加载 profile 配置 | 运行时添加/修改 profile 无需重启服务 | 重启服务（中断所有连接） |

---

## 第 2 章 源码实现分析

### 2.1 架构概览

```
┌─────────────────────────────────────────────────────────────────┐
│                     Agent Tool Layer                            │
│  browser-tool.ts → createBrowserTool() → action dispatcher      │
└──────────────────────────┬──────────────────────────────────────┘
                           │ HTTP API
┌──────────────────────────▼──────────────────────────────────────┐
│              Browser Control Server (Express)                    │
│  server.ts:21 → startBrowserControlServerFromConfig()           │
│  ┌─────────────┐  ┌──────────────┐  ┌────────────────────┐     │
│  │ Auth Middle  │→ │ Route Layer  │→ │ server-context.ts  │     │
│  │ ware        │  │ routes/*.ts  │  │ ProfileContext     │     │
│  └─────────────┘  └──────────────┘  └────────┬───────────┘     │
└──────────────────────────────────────────────┼──────────────────┘
                                               │
              ┌────────────────────────────────┼────────────────┐
              │                                │                │
    ┌─────────▼──────────┐          ┌──────────▼─────────┐      │
    │  driver: "openclaw" │          │ driver: "extension" │      │
    │                     │          │                     │      │
    │  chrome.ts:163      │          │ extension-relay.ts  │      │
    │  launchOpenClawChrome│         │ WebSocket relay     │      │
    │  spawn(chrome, args)│          │ ┌───────────────┐  │      │
    │  CDP port 18800+    │          │ │Chrome Extension│  │      │
    └─────────┬───────────┘          │ │(Manifest V3)  │  │      │
              │                      │ │background.js  │  │      │
              │ CDP WebSocket        │ └───────┬───────┘  │      │
              │                      │         │ WS       │      │
    ┌─────────▼───────────┐          │ ┌───────▼───────┐  │      │
    │  Playwright-core    │          │ │ /extension WS │  │      │
    │  pw-session.ts      │◄─────────┤ │ /cdp WS       │  │      │
    │  connectOverCDP()   │          │ └───────────────┘  │      │
    │  ┌───────────────┐  │          └────────────────────┘      │
    │  │ Page State    │  │                                      │
    │  │ console/net/  │  │                                      │
    │  │ roleRefs      │  │                                      │
    │  └───────────────┘  │                                      │
    └─────────────────────┘                                      │
              │                                                  │
    ┌─────────▼───────────────────────────────────────────┐      │
    │  pw-tools-core.*.ts                                 │      │
    │  interactions: click/type/hover/drag/fill            │      │
    │  snapshot: ARIA/AI/Role snapshot + ref generation    │      │
    │  storage: cookies/localStorage                       │      │
    │  downloads: file download handling                   │      │
    └─────────────────────────────────────────────────────┘      │
```

### 2.2 核心实现

#### Chrome 进程管理 (`chrome.ts:163-321`)

`launchOpenClawChrome` 是 Chrome 实例启动的核心函数。它实现了一个两阶段启动策略：

```typescript
// chrome.ts:163-236 — Chrome 启动核心逻辑
export async function launchOpenClawChrome(
  resolved: ResolvedBrowserConfig,
  profile: ResolvedBrowserProfile,
): Promise<RunningChrome> {
  if (!profile.cdpIsLoopback) {
    throw new Error(`Profile "${profile.name}" is remote; cannot launch local Chrome.`);
  }
  await ensurePortAvailable(profile.cdpPort);

  const exe = resolveBrowserExecutable(resolved);
  if (!exe) {
    throw new Error(
      "No supported browser found (Chrome/Brave/Edge/Chromium on macOS, Linux, or Windows).",
    );
  }

  const userDataDir = resolveOpenClawUserDataDir(profile.name);
  fs.mkdirSync(userDataDir, { recursive: true });

  const spawnOnce = () => {
    const args: string[] = [
      `--remote-debugging-port=${profile.cdpPort}`,
      `--user-data-dir=${userDataDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-sync",
      "--disable-background-networking",
      "--disable-blink-features=AutomationControlled", // 反检测
    ];
    // ... headless, noSandbox, extraArgs
    args.push("about:blank");
    return spawn(exe.path, args, { stdio: "pipe" });
  };

  // 两阶段启动：先 bootstrap 创建 profile 文件，再 decorate + 正式启动
  if (needsBootstrap) {
    const bootstrap = spawnOnce();
    // 等待 Local State + Preferences 文件创建
    while (Date.now() < deadline) {
      if (exists(localStatePath) && exists(preferencesPath)) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    bootstrap.kill("SIGTERM");
  }

  // 装饰 profile（设置颜色标识等）
  if (needsDecorate) {
    decorateOpenClawProfile(userDataDir, { name: profile.name, color: profile.color });
  }

  const proc = spawnOnce();
  // 轮询等待 CDP 就绪（最多 15 秒）
  while (Date.now() < readyDeadline) {
    if (await isChromeReachable(profile.cdpUrl, 500)) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  return { pid, exe, userDataDir, cdpPort: profile.cdpPort, startedAt, proc };
}
```

#### 扩展中继系统 (`extension-relay.ts:208-811`)

扩展中继是 OpenClaw 最独特的设计——通过 Chrome 扩展（Manifest V3）接管用户已有的浏览器标签页。中继服务器同时维护两个 WebSocket 通道：

- `/extension` — Chrome 扩展连接端点（仅允许 `chrome-extension://` origin）
- `/cdp` — Playwright/CDP 客户端连接端点

```typescript
// extension-relay.ts:294-361 — CDP 命令路由核心
const routeCdpCommand = async (cmd: CdpCommand): Promise<unknown> => {
  switch (cmd.method) {
    case "Browser.getVersion":
      return {
        protocolVersion: "1.3",
        product: "Chrome/OpenClaw-Extension-Relay",
      };
    case "Target.setAutoAttach":
    case "Target.setDiscoverTargets":
      return {}; // 本地拦截，不转发
    case "Target.getTargets":
      return {
        targetInfos: Array.from(connectedTargets.values()).map((t) => ({
          ...t.targetInfo, attached: true,
        })),
      };
    case "Target.attachToTarget": {
      // 从已连接目标中查找 sessionId
      const targetId = (cmd.params as { targetId?: string })?.targetId;
      for (const t of connectedTargets.values()) {
        if (t.targetId === targetId) return { sessionId: t.sessionId };
      }
      throw new Error("target not found");
    }
    default: {
      // 其他命令转发给 Chrome 扩展
      const id = nextExtensionId++;
      return await sendToExtension({
        id, method: "forwardCDPCommand",
        params: { method: cmd.method, sessionId: cmd.sessionId, params: cmd.params },
      });
    }
  }
};
```

关键安全设计（`extension-relay.ts:474-532`）：
- WebSocket 升级时验证 `remoteAddress` 必须是 loopback
- 扩展连接验证 `origin` 必须以 `chrome-extension://` 开头
- 所有连接需要 `x-openclaw-relay-token` 认证令牌
- `/json/*` HTTP 端点同样需要令牌认证

#### Playwright 会话管理 (`pw-session.ts:318-364`)

Playwright 通过 `connectOverCDP` 连接到 Chrome 的 CDP 端点，实现了带重试的连接策略：

```typescript
// pw-session.ts:327-357 — 带重试的 CDP 连接
const connectWithRetry = async (): Promise<ConnectedBrowser> => {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const timeout = 5000 + attempt * 2000; // 递增超时
      const wsUrl = await getChromeWebSocketUrl(normalized, timeout).catch(() => null);
      const endpoint = wsUrl ?? normalized;
      const headers = getHeadersWithAuth(endpoint);
      const browser = await chromium.connectOverCDP(endpoint, { timeout, headers });
      const onDisconnected = () => {
        if (cached?.browser === browser) cached = null;
      };
      cached = { browser, cdpUrl: normalized, onDisconnected };
      browser.on("disconnected", onDisconnected);
      observeBrowser(browser);
      return cached;
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 250 + attempt * 250));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("CDP connect failed");
};
```

#### AI 友好的页面快照 (`pw-tools-core.snapshot.ts:42-84`)

OpenClaw 提供三种快照模式，核心是将页面转换为 LLM 可理解的文本表示：

- **AI 快照**（`snapshotAiViaPlaywright`）：使用 Playwright 内置的 `_snapshotForAI` 方法，生成带 `aria-ref` 的结构化文本
- **Role 快照**（`snapshotRoleViaPlaywright`）：基于 `ariaSnapshot()` 生成角色+名称的引用映射
- **ARIA 快照**（`snapshotAriaViaPlaywright`）：通过 CDP `Accessibility.getFullAXTree` 获取完整无障碍树

每次快照都会生成 ref 映射（如 `e1 → {role: "button", name: "Submit"}`），存储在 `pageStates` WeakMap 中，后续操作通过 `refLocator()` 解析 ref 到 Playwright Locator。

### 2.3 实现细节

#### Profile 系统与端口分配

每个 profile 独立分配 CDP 端口（`constants.ts` 定义范围 18800-18899），配置结构：

```typescript
// config.ts:19-47 — Profile 配置类型
export type ResolvedBrowserProfile = {
  name: string;           // "openclaw" | "chrome" | 自定义
  cdpPort: number;        // 18800-18899
  cdpUrl: string;         // "http://127.0.0.1:18800"
  cdpHost: string;        // "127.0.0.1"
  cdpIsLoopback: boolean; // 是否本地
  color: string;          // "#FF4500" 用于 profile 装饰
  driver: "openclaw" | "extension"; // 驱动类型
};
```

内置两个默认 profile：
- `openclaw`：OpenClaw 自管理的隔离 Chrome 实例（`driver: "openclaw"`）
- `chrome`：Chrome 扩展中继（`driver: "extension"`，端口 = controlPort + 1）

#### 强制断连机制 (`pw-session.ts:648-679`)

当 Playwright 的 `evaluate` 操作卡住时（如页面执行了无限循环的 JS），OpenClaw 实现了一个精巧的强制断连机制：

1. 先通过原始 CDP WebSocket 发送 `Runtime.terminateExecution` 终止卡住的 JS
2. 清空 `cached` 连接引用，让下次请求触发全新的 `connectOverCDP`
3. Fire-and-forget 调用 `browser.close()`（可能会 hang，但不阻塞新连接）

这避免了关闭 Playwright 的 `Connection` 对象（会腐蚀整个 Playwright 实例）。

#### Navigation Guard (`navigation-guard.ts:32-63`)

所有浏览器导航操作都必须通过安全检查：

```typescript
// navigation-guard.ts:32-63
export async function assertBrowserNavigationAllowed(opts: {
  url: string;
  lookupFn?: LookupFn;
} & BrowserNavigationPolicyOptions): Promise<void> {
  const rawUrl = String(opts.url ?? "").trim();
  if (!rawUrl) throw new InvalidBrowserNavigationUrlError("url is required");

  let parsed: URL;
  try { parsed = new URL(rawUrl); }
  catch { throw new InvalidBrowserNavigationUrlError(`Invalid URL: ${rawUrl}`); }

  if (!NETWORK_NAVIGATION_PROTOCOLS.has(parsed.protocol)) {
    if (isAllowedNonNetworkNavigationUrl(parsed)) return; // 仅允许 about:blank
    throw new InvalidBrowserNavigationUrlError(
      `Navigation blocked: unsupported protocol "${parsed.protocol}"`
    );
  }
  // SSRF 策略检查：DNS 解析 + 私有网络检测
  await resolvePinnedHostnameWithPolicy(parsed.hostname, {
    lookupFn: opts.lookupFn, policy: opts.ssrfPolicy,
  });
}
```

---

## 第 3 章 迁移指南

### 3.1 迁移清单

**阶段 1：基础 Chrome 管理**
- [ ] 实现跨平台 Chrome 可执行文件发现（参考 `chrome.executables.ts`）
- [ ] 实现 Chrome 进程 spawn + CDP 端口分配 + 探活轮询
- [ ] 实现 profile 目录隔离（`~/.config/<app>/browser/<profile>/user-data`）

**阶段 2：控制服务器**
- [ ] 搭建 Express HTTP 服务器，暴露 start/stop/status/tabs/snapshot 端点
- [ ] 实现认证中间件（token 或 password）
- [ ] 实现 Navigation Guard（SSRF 防护）

**阶段 3：Playwright 集成**
- [ ] 通过 `playwright-core` 的 `connectOverCDP` 连接到 Chrome
- [ ] 实现 ARIA 快照 + ref 引用系统
- [ ] 实现 click/type/hover/fill 等交互操作

**阶段 4：扩展中继（可选）**
- [ ] 开发 Chrome 扩展（Manifest V3），实现 CDP 命令转发
- [ ] 搭建 WebSocket 中继服务器（双通道：extension + cdp）
- [ ] 实现中继认证和 target 管理

### 3.2 适配代码模板

最小可用的浏览器控制服务器：

```typescript
import { chromium, type Browser, type Page } from "playwright-core";
import { spawn, type ChildProcess } from "node:child_process";
import express from "express";

// --- Chrome 管理 ---
interface ManagedChrome {
  proc: ChildProcess;
  cdpPort: number;
  cdpUrl: string;
}

async function launchChrome(cdpPort: number): Promise<ManagedChrome> {
  const userDataDir = `/tmp/browser-profile-${cdpPort}`;
  const proc = spawn("google-chrome", [
    `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${userDataDir}`,
    "--no-first-run",
    "--disable-sync",
    "--disable-blink-features=AutomationControlled",
    "about:blank",
  ], { stdio: "pipe" });

  const cdpUrl = `http://127.0.0.1:${cdpPort}`;
  // 等待 CDP 就绪
  for (let i = 0; i < 30; i++) {
    try {
      const res = await fetch(`${cdpUrl}/json/version`);
      if (res.ok) return { proc, cdpPort, cdpUrl };
    } catch {}
    await new Promise(r => setTimeout(r, 500));
  }
  proc.kill("SIGKILL");
  throw new Error(`Chrome CDP not ready on port ${cdpPort}`);
}

// --- Playwright 连接 ---
let browser: Browser | null = null;

async function connectPlaywright(cdpUrl: string): Promise<Browser> {
  if (browser) return browser;
  const res = await fetch(`${cdpUrl}/json/version`);
  const { webSocketDebuggerUrl } = await res.json() as { webSocketDebuggerUrl: string };
  browser = await chromium.connectOverCDP(webSocketDebuggerUrl);
  browser.on("disconnected", () => { browser = null; });
  return browser;
}

// --- ARIA 快照 + Ref 系统 ---
type RefMap = Record<string, { role: string; name?: string }>;

async function snapshotPage(page: Page): Promise<{ snapshot: string; refs: RefMap }> {
  const snapshot = await page.locator(":root").ariaSnapshot();
  const refs: RefMap = {};
  let idx = 1;
  for (const line of snapshot.split("\n")) {
    const match = line.match(/- (\w+) "([^"]*)"/);
    if (match) {
      refs[`e${idx}`] = { role: match[1], name: match[2] };
      idx++;
    }
  }
  return { snapshot, refs };
}

// --- Express 控制服务器 ---
const app = express();
app.use(express.json());

let chrome: ManagedChrome | null = null;

app.post("/start", async (_req, res) => {
  chrome = await launchChrome(18800);
  res.json({ ok: true, cdpUrl: chrome.cdpUrl });
});

app.get("/snapshot", async (_req, res) => {
  if (!chrome) return res.status(400).json({ error: "not started" });
  const b = await connectPlaywright(chrome.cdpUrl);
  const page = b.contexts()[0]?.pages()[0];
  if (!page) return res.status(404).json({ error: "no page" });
  const result = await snapshotPage(page);
  res.json(result);
});

app.listen(18791, "127.0.0.1", () => {
  console.log("Browser control on http://127.0.0.1:18791");
});
```

### 3.3 适用场景

| 场景 | 适用度 | 说明 |
|------|--------|------|
| Agent 自动化网页操作 | ⭐⭐⭐ | 核心场景：导航、填表、截图、读取页面 |
| 接管用户已登录会话 | ⭐⭐⭐ | 扩展中继方案独有优势，无需重新登录 |
| 无头浏览器测试 | ⭐⭐ | 支持 headless 模式，但非主要设计目标 |
| 多浏览器并行爬取 | ⭐⭐ | profile 隔离支持，但无内置并发调度 |
| 移动端模拟 | ⭐ | 需要额外配置 viewport 和 user-agent |

---

<!-- APPEND_PLACEHOLDER_3 -->
