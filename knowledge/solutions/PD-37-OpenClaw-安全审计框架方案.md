# PD-37.01 OpenClaw — 多层安全审计与自动修复框架

> 文档编号：PD-37.01
> 来源：OpenClaw `src/security/audit.ts`
> GitHub：https://github.com/openclaw/openclaw
> 问题域：PD-37 安全审计框架 Security Audit Framework
> 状态：可复用方案

---

## 第 1 章 问题与动机

### 1.1 核心问题

Agent 系统运行在用户本地环境中，拥有文件读写、命令执行、网络访问等高权限能力。一旦配置不当（如 state 目录 world-writable、gateway 无认证暴露、插件包含恶意代码），攻击者可通过 prompt injection、SSRF、本地提权等手段获取完整控制权。

传统安全审计依赖人工 checklist，无法覆盖 Agent 系统特有的攻击面：多渠道消息入口、工具策略配置、沙箱隔离状态、模型选择风险等。需要一个自动化框架，能在 CLI 一键运行，覆盖所有安全维度，并提供可执行的修复建议。

### 1.2 OpenClaw 的解法概述

OpenClaw 实现了一个生产级安全审计框架，核心设计：

1. **Collector 模式**：将审计逻辑拆分为 20+ 个独立 collector 函数，每个负责一个安全维度（`src/security/audit.ts:812-831`）
2. **三级严重度**：所有 finding 统一为 `info | warn | critical` 三级，驱动 CLI 输出和修复优先级（`src/security/audit.ts:51`）
3. **自动修复引擎**：`--fix` 模式自动修复文件权限、配置策略等常见问题（`src/security/fix.ts:387-473`）
4. **静态代码扫描**：对插件/技能代码进行规则匹配，检测 RCE、数据外泄、挖矿等恶意模式（`src/security/skill-scanner.ts:80-138`）
5. **外部内容安全边界**：用随机 ID 标记的 XML 边界包裹不可信内容，防止 prompt injection（`src/security/external-content.ts:219-245`）

### 1.3 设计思想

| 设计原则 | 具体实现 | 理由 | 替代方案 |
|----------|----------|------|----------|
| 关注点分离 | 每个 collector 独立函数，sync/async 分文件 | 便于单独测试和扩展新检查项 | 单一大函数遍历所有配置 |
| 声明式规则 | skill-scanner 用 LineRule/SourceRule 数组定义检测规则 | 新增规则只需追加数组元素 | 硬编码 if-else 链 |
| 防御性修复 | fix 引擎先检查 symlink/类型/当前权限再操作 | 避免修复操作本身引入安全问题 | 直接 chmod 不做前置检查 |
| 跨平台兼容 | POSIX chmod + Windows icacls 双路径 | 覆盖主流部署环境 | 仅支持 Linux |
| 依赖注入 | audit/fix 函数接受 exec/probe/platform 注入 | 测试可 mock，不依赖真实环境 | 直接调用系统命令 |

---

## 第 2 章 源码实现分析

### 2.1 架构概览

```
┌─────────────────────────────────────────────────────────────┐
│                    CLI: security audit                       │
│              src/cli/security-cli.ts:30-164                  │
└──────────────────────┬──────────────────────────────────────┘
                       │
          ┌────────────▼────────────────┐
          │   runSecurityAudit()        │
          │   src/security/audit.ts:803 │
          └────────────┬────────────────┘
                       │
    ┌──────────────────┼──────────────────────────┐
    │                  │                          │
    ▼                  ▼                          ▼
┌─────────┐   ┌──────────────┐   ┌──────────────────────┐
│ Sync    │   │ Async        │   │ Deep Probe           │
│Collectors│  │ Collectors   │   │ (optional --deep)    │
│ 15+ 个  │   │ 7 个         │   │ maybeProbeGateway()  │
└────┬────┘   └──────┬───────┘   └──────────┬───────────┘
     │               │                      │
     ▼               ▼                      ▼
┌─────────────────────────────────────────────────┐
│  SecurityAuditReport { ts, summary, findings }  │
│  findings: SecurityAuditFinding[]               │
│  { checkId, severity, title, detail, remediation}│
└─────────────────────────────────────────────────┘
                       │
          ┌────────────▼────────────────┐
          │   fixSecurityFootguns()     │
          │   (optional --fix)         │
          │   src/security/fix.ts:387  │
          └────────────────────────────┘
```

审计框架覆盖 8 大安全类别，50+ 个 checkId：

| 类别 | 前缀 | 典型检查 |
|------|------|----------|
| 文件系统 | `fs.*` | state 目录权限、config 可写性、symlink 检测 |
| 网关配置 | `gateway.*` | bind 地址+认证、token 长度、Tailscale 暴露 |
| 渠道安全 | `channels.*` | DM 策略、群组策略、allowlist 格式 |
| 工具策略 | `tools.*` | 提权工具白名单、exec host 沙箱匹配 |
| 沙箱配置 | `sandbox.*` | Docker 配置无效、危险 bind mount、网络隔离 |
| 插件/技能 | `plugins.*` / `skills.*` | 代码安全扫描、信任白名单 |
| 模型卫生 | `models.*` | 小模型+工具风险、遗留模型检测 |
| Webhook | `hooks.*` | token 长度、session key 覆盖风险 |

### 2.2 核心实现

#### 2.2.1 主编排器 — runSecurityAudit

`src/security/audit.ts:803-894` 是审计入口，按顺序收集所有 finding：

```typescript
// src/security/audit.ts:803-831
export async function runSecurityAudit(opts: SecurityAuditOptions): Promise<SecurityAuditReport> {
  const findings: SecurityAuditFinding[] = [];
  const cfg = opts.config;
  const env = opts.env ?? process.env;

  // 同步 collectors — 纯配置分析，无 I/O
  findings.push(...collectAttackSurfaceSummaryFindings(cfg));
  findings.push(...collectSyncedFolderFindings({ stateDir, configPath }));
  findings.push(...collectGatewayConfigFindings(cfg, env));
  findings.push(...collectBrowserControlFindings(cfg, env));
  findings.push(...collectLoggingFindings(cfg));
  findings.push(...collectElevatedFindings(cfg));
  findings.push(...collectExecRuntimeFindings(cfg));
  findings.push(...collectHooksHardeningFindings(cfg, env));
  findings.push(...collectSandboxDockerNoopFindings(cfg));
  findings.push(...collectSandboxDangerousConfigFindings(cfg));
  findings.push(...collectSecretsInConfigFindings(cfg));
  findings.push(...collectModelHygieneFindings(cfg));
  findings.push(...collectSmallModelRiskFindings({ cfg, env }));
  findings.push(...collectExposureMatrixFindings(cfg));

  // 异步 collectors — 需要文件系统 I/O
  if (opts.includeFilesystem !== false) {
    findings.push(...(await collectFilesystemFindings({ stateDir, configPath, env, platform })));
    findings.push(...(await collectPluginsTrustFindings({ cfg, stateDir })));
    if (opts.deep === true) {
      findings.push(...(await collectPluginsCodeSafetyFindings({ stateDir })));
      findings.push(...(await collectInstalledSkillsCodeSafetyFindings({ cfg, stateDir })));
    }
  }

  const summary = countBySeverity(findings);
  return { ts: Date.now(), summary, findings, deep };
}
```

关键设计：sync collector 先执行（快速、无副作用），async collector 后执行（需要磁盘/网络），deep probe 最后执行（可选的实时网关探测）。

#### 2.2.2 静态代码扫描器 — skill-scanner

`src/security/skill-scanner.ts:80-138` 定义了两类规则：

```typescript
// src/security/skill-scanner.ts:80-106 — 行级规则
const LINE_RULES: LineRule[] = [
  {
    ruleId: "dangerous-exec",
    severity: "critical",
    message: "Shell command execution detected (child_process)",
    pattern: /\b(exec|execSync|spawn|spawnSync|execFile|execFileSync)\s*\(/,
    requiresContext: /child_process/,  // 仅当文件包含 child_process 时触发
  },
  {
    ruleId: "dynamic-code-execution",
    severity: "critical",
    message: "Dynamic code execution detected",
    pattern: /\beval\s*\(|new\s+Function\s*\(/,
  },
  {
    ruleId: "crypto-mining",
    severity: "critical",
    message: "Possible crypto-mining reference detected",
    pattern: /stratum\+tcp|stratum\+ssl|coinhive|cryptonight|xmrig/i,
  },
];

// src/security/skill-scanner.ts:110-138 — 源码级规则（跨行匹配）
const SOURCE_RULES: SourceRule[] = [
  {
    ruleId: "potential-exfiltration",
    severity: "warn",
    message: "File read combined with network send — possible data exfiltration",
    pattern: /readFileSync|readFile/,
    requiresContext: /\bfetch\b|\bpost\b|http\.request/i,
  },
  {
    ruleId: "env-harvesting",
    severity: "critical",
    message: "Environment variable access combined with network send",
    pattern: /process\.env/,
    requiresContext: /\bfetch\b|\bpost\b|http\.request/i,
  },
];
```

`requiresContext` 是精妙设计：行级规则先检查全文是否包含上下文模式，避免误报（如 `exec` 在非 child_process 场景下不触发）。

#### 2.2.3 文件系统权限检查

`src/security/audit-fs.ts:62-142` 实现跨平台权限检查：

```typescript
// src/security/audit-fs.ts:62-142
export async function inspectPathPermissions(
  targetPath: string,
  opts?: PermissionCheckOptions,
): Promise<PermissionCheck> {
  const st = await safeStat(targetPath);
  const bits = modeBits(effectiveMode);
  const platform = opts?.platform ?? process.platform;

  if (platform === "win32") {
    // Windows: 解析 icacls 输出，分类 ACL 条目
    const acl = await inspectWindowsAcl(targetPath, { env: opts?.env, exec: opts?.exec });
    return {
      source: "windows-acl",
      worldWritable: acl.untrustedWorld.some((entry) => entry.canWrite),
      groupWritable: acl.untrustedGroup.some((entry) => entry.canWrite),
      // ...
    };
  }

  // POSIX: 直接位运算检查
  return {
    source: "posix",
    worldWritable: isWorldWritable(bits),   // (bits & 0o002) !== 0
    groupWritable: isGroupWritable(bits),   // (bits & 0o020) !== 0
    worldReadable: isWorldReadable(bits),   // (bits & 0o004) !== 0
    groupReadable: isGroupReadable(bits),   // (bits & 0o040) !== 0
  };
}
```

### 2.3 实现细节

#### 自动修复引擎

`src/security/fix.ts:387-473` 的 `fixSecurityFootguns()` 实现三层修复：

1. **配置修复**：`applyConfigFixes()` 将 `groupPolicy="open"` 翻转为 `"allowlist"`，将 `logging.redactSensitive="off"` 改为 `"tools"`
2. **权限修复**：对 stateDir (0o700)、configPath (0o600)、credentials (0o600) 执行 chmod/icacls
3. **深度修复**：遍历所有 agent 的 sessions 目录，修复 transcript 文件权限

每个修复操作返回 `SecurityFixAction`，记录 ok/skipped/error 状态，确保修复过程可审计。

#### 外部内容安全边界

`src/security/external-content.ts:219-245` 用随机 ID 防止 marker spoofing：

```typescript
// src/security/external-content.ts:219-245
export function wrapExternalContent(content: string, options: WrapExternalContentOptions): string {
  const sanitized = replaceMarkers(content);  // 先清除内容中的伪造 marker
  const markerId = createExternalContentMarkerId();  // randomBytes(8).toString("hex")
  return [
    warningBlock,
    `<<<EXTERNAL_UNTRUSTED_CONTENT id="${markerId}">>>`,
    metadata,
    "---",
    sanitized,
    `<<<END_EXTERNAL_UNTRUSTED_CONTENT id="${markerId}">>>`,
  ].join("\n");
}
```

`replaceMarkers()` 还处理 Unicode 全角字符绕过（如 `＜＜＜ＥＸＴＥＲＮＡＬ...`），通过 `foldMarkerText()` 将全角字符折叠为 ASCII 后再匹配。

#### 危险工具常量集中管理

`src/security/dangerous-tools.ts:1-38` 将工具风险常量集中定义，避免 gateway HTTP 限制、审计检查、ACP 提示之间的漂移：

```typescript
// src/security/dangerous-tools.ts:9-18
export const DEFAULT_GATEWAY_HTTP_TOOL_DENY = [
  "sessions_spawn",   // 远程 spawn agent = RCE
  "sessions_send",    // 跨 session 注入
  "gateway",          // 网关重配置
  "whatsapp_login",   // 交互式流程，HTTP 上会挂起
] as const;

// src/security/dangerous-tools.ts:24-37
export const DANGEROUS_ACP_TOOL_NAMES = [
  "exec", "spawn", "shell", "sessions_spawn", "sessions_send",
  "gateway", "fs_write", "fs_delete", "fs_move", "apply_patch",
] as const;
```

---

## 第 3 章 迁移指南

### 3.1 迁移清单

**阶段 1：核心审计框架（1-2 天）**
- [ ] 定义 `SecurityAuditFinding` 类型（checkId + severity + title + detail + remediation）
- [ ] 实现 `runSecurityAudit()` 编排器，按 sync → async → deep 顺序收集 findings
- [ ] 实现 `countBySeverity()` 汇总函数
- [ ] 实现 CLI 命令注册（`security audit` + `--deep` + `--fix` + `--json`）

**阶段 2：Collector 实现（2-3 天）**
- [ ] 文件系统权限 collector（POSIX + Windows）
- [ ] 配置敏感信息检测 collector
- [ ] 工具策略检查 collector
- [ ] 沙箱配置校验 collector

**阶段 3：高级功能（1-2 天）**
- [ ] 静态代码扫描器（LineRule + SourceRule）
- [ ] 自动修复引擎（chmod + config rewrite）
- [ ] 外部内容安全边界（marker wrapping）

### 3.2 适配代码模板

以下是一个可直接复用的最小审计框架：

```typescript
// types.ts
export type AuditSeverity = "info" | "warn" | "critical";

export type AuditFinding = {
  checkId: string;
  severity: AuditSeverity;
  title: string;
  detail: string;
  remediation?: string;
};

export type AuditReport = {
  ts: number;
  summary: { critical: number; warn: number; info: number };
  findings: AuditFinding[];
};

// collector 接口 — 每个安全维度实现一个
type SyncCollector = (config: AppConfig) => AuditFinding[];
type AsyncCollector = (config: AppConfig) => Promise<AuditFinding[]>;

// 主编排器
export async function runAudit(opts: {
  config: AppConfig;
  syncCollectors: SyncCollector[];
  asyncCollectors: AsyncCollector[];
}): Promise<AuditReport> {
  const findings: AuditFinding[] = [];

  // 同步 collectors 先执行
  for (const collector of opts.syncCollectors) {
    findings.push(...collector(opts.config));
  }

  // 异步 collectors 后执行
  for (const collector of opts.asyncCollectors) {
    findings.push(...(await collector(opts.config)));
  }

  const summary = {
    critical: findings.filter((f) => f.severity === "critical").length,
    warn: findings.filter((f) => f.severity === "warn").length,
    info: findings.filter((f) => f.severity === "info").length,
  };

  return { ts: Date.now(), summary, findings };
}
```

```typescript
// skill-scanner-template.ts — 可复用的规则引擎
type ScanRule = {
  ruleId: string;
  severity: "info" | "warn" | "critical";
  message: string;
  pattern: RegExp;
  requiresContext?: RegExp;  // 全文上下文约束，减少误报
};

export function scanSource(source: string, filePath: string, rules: ScanRule[]) {
  const findings = [];
  const lines = source.split("\n");

  for (const rule of rules) {
    if (rule.requiresContext && !rule.requiresContext.test(source)) continue;
    for (let i = 0; i < lines.length; i++) {
      if (rule.pattern.test(lines[i])) {
        findings.push({
          ruleId: rule.ruleId,
          severity: rule.severity,
          file: filePath,
          line: i + 1,
          message: rule.message,
          evidence: lines[i].trim().slice(0, 120),
        });
        break; // 每个规则每个文件只报一次
      }
    }
  }
  return findings;
}
```

### 3.3 适用场景

| 场景 | 适用度 | 说明 |
|------|--------|------|
| Agent 框架安全审计 | ⭐⭐⭐ | 完美匹配：多维度 collector + 自动修复 |
| CLI 工具安全检查 | ⭐⭐⭐ | collector 模式天然适合 CLI 集成 |
| 插件市场安全扫描 | ⭐⭐⭐ | skill-scanner 可直接复用 |
| Web 应用安全审计 | ⭐⭐ | 需要替换 collector 内容，框架可复用 |
| CI/CD 安全门禁 | ⭐⭐ | JSON 输出模式适合自动化集成 |

---

