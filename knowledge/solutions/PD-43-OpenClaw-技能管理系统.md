# PD-43.01 OpenClaw — 多源分层技能发现·资格评估·安全扫描管理系统

> 文档编号：PD-43.01
> 来源：OpenClaw `src/agents/skills/workspace.ts` `src/agents/skills/config.ts` `src/security/skill-scanner.ts`
> GitHub：https://github.com/openclaw/openclaw
> 问题域：PD-43 技能管理系统 Skills Management
> 状态：可复用方案

---

## 第 1 章 问题与动机

### 1.1 核心问题

Agent 系统需要一套可扩展的技能（Skill）管理机制，解决以下问题：

1. **技能来源多样化**：技能可能来自内置 bundled、用户全局安装 managed、项目级 workspace、插件 plugin、个人 agents-skills-personal、项目 agents-skills-project 等 6 个来源，需要统一发现和加载
2. **资格评估复杂**：技能可能依赖特定 OS 平台、二进制工具、环境变量、配置路径，甚至远程节点上的工具可用性，需要一套声明式的 eligibility 评估体系
3. **安全风险**：第三方技能可能包含恶意代码（shell 执行、动态 eval、加密挖矿、数据外泄），安装前需要自动化安全扫描
4. **Prompt 膨胀**：大量技能注入 system prompt 会消耗 token 预算，需要限流和截断机制
5. **多环境同步**：沙箱环境、cron 定时任务、远程节点等场景需要技能快照的一致性同步

### 1.2 OpenClaw 的解法概述

1. **6 源分层加载 + 优先级覆盖**：extra < bundled < managed < agents-skills-personal < agents-skills-project < workspace，同名技能高优先级覆盖低优先级（`src/agents/skills/workspace.ts:369-388`）
2. **声明式 Frontmatter 元数据**：每个 SKILL.md 通过 YAML frontmatter 声明 OS 限制、二进制依赖、环境变量需求、调用策略等（`src/agents/skills/frontmatter.ts:81-101`）
3. **多维资格评估引擎**：结合本地 binary 检测、远程节点 bin probe、环境变量、配置路径、bundled allowlist 等维度综合判定（`src/agents/skills/config.ts:70-102`）
4. **安装前安全扫描**：基于规则的静态代码分析，检测 child_process 调用、eval、加密挖矿、数据外泄等危险模式（`src/security/skill-scanner.ts:80-138`）
5. **SkillSnapshot 快照 + 版本化缓存**：将技能解析结果冻结为不可变快照，通过版本号和 filter 比对决定是否刷新（`src/cron/isolated-agent/skills-snapshot.ts:8-37`）

### 1.3 设计思想

| 设计原则 | 具体实现 | 理由 | 替代方案 |
|----------|----------|------|----------|
| 分层优先级覆盖 | 6 源 Map 按序 set，后写入覆盖先写入 | 允许 workspace 级技能覆盖 bundled 默认行为 | 命名空间隔离（更复杂但无冲突） |
| 声明式资格 | Frontmatter YAML 声明 requires.bins/env/config | 技能作者自描述依赖，运行时自动评估 | 命令式检查脚本（灵活但不安全） |
| 防御性限流 | maxSkillsInPrompt=150, maxSkillsPromptChars=30000 | 防止 prompt 膨胀超出上下文窗口 | 动态 token 计数（更精确但更慢） |
| 安装前扫描 | 规则引擎扫描 JS/TS 源码，分 critical/warn/info | 在安装阶段拦截恶意代码，而非运行时 | 沙箱执行（更安全但更重） |
| 快照不可变 | SkillSnapshot 冻结 prompt + skills 列表 | cron/agent 运行期间技能集不变，避免竞态 | 每次请求重新解析（一致性差） |

---

## 第 2 章 源码实现分析

### 2.1 架构概览

```
┌─────────────────────────────────────────────────────────────────┐
│                     Skills Management System                     │
├─────────────────────────────────────────────────────────────────┤
│                                                                   │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────┐   │
│  │ SKILL.md     │  │ SKILL.md     │  │ SKILL.md             │   │
│  │ (bundled)    │  │ (managed)    │  │ (workspace)          │   │
│  └──────┬───────┘  └──────┬───────┘  └──────────┬───────────┘   │
│         │                  │                      │               │
│         ▼                  ▼                      ▼               │
│  ┌─────────────────────────────────────────────────────────┐     │
│  │          loadSkillEntries() — 6源分层加载                │     │
│  │  extra < bundled < managed < personal < project < ws    │     │
│  │  同名覆盖: Map.set() 后写入胜出                          │     │
│  └────────────────────────┬────────────────────────────────┘     │
│                           │                                       │
│                           ▼                                       │
│  ┌─────────────────────────────────────────────────────────┐     │
│  │         filterSkillEntries() — 多维资格评估              │     │
│  │  shouldIncludeSkill():                                   │     │
│  │    ├─ enabled !== false (配置禁用检查)                    │     │
│  │    ├─ isBundledSkillAllowed() (allowlist 白名单)         │     │
│  │    └─ evaluateRuntimeEligibility():                      │     │
│  │        ├─ OS 平台匹配 (含远程节点)                       │     │
│  │        ├─ bins 二进制可用性 (本地 + 远程)                │     │
│  │        ├─ env 环境变量检查                               │     │
│  │        └─ config 配置路径检查                            │     │
│  └────────────────────────┬────────────────────────────────┘     │
│                           │                                       │
│              ┌────────────┼────────────┐                         │
│              ▼            ▼            ▼                         │
│  ┌──────────────┐ ┌────────────┐ ┌──────────────┐               │
│  │ Prompt 构建   │ │ Snapshot   │ │ Command 注册  │               │
│  │ (限流+截断)   │ │ (版本缓存) │ │ (去重+消毒)   │               │
│  └──────────────┘ └────────────┘ └──────────────┘               │
│                                                                   │
│  ┌─────────────────────────────────────────────────────────┐     │
│  │         Security Scanner — 安装前安全扫描                │     │
│  │  LINE_RULES: exec/eval/crypto-mining/suspicious-network  │     │
│  │  SOURCE_RULES: exfiltration/obfuscation/env-harvesting   │     │
│  └─────────────────────────────────────────────────────────┘     │
└─────────────────────────────────────────────────────────────────┘
```

### 2.2 核心实现

#### 2.2.1 六源分层加载与优先级覆盖

技能加载的核心在 `loadSkillEntries()` 函数（`src/agents/skills/workspace.ts:221-406`）。该函数从 6 个目录源加载技能，通过 Map 的 set 语义实现优先级覆盖：

```typescript
// src/agents/skills/workspace.ts:369-388
const merged = new Map<string, Skill>();
// Precedence: extra < bundled < managed < agents-skills-personal < agents-skills-project < workspace
for (const skill of extraSkills) {
  merged.set(skill.name, skill);
}
for (const skill of bundledSkills) {
  merged.set(skill.name, skill);
}
for (const skill of managedSkills) {
  merged.set(skill.name, skill);
}
for (const skill of personalAgentsSkills) {
  merged.set(skill.name, skill);
}
for (const skill of projectAgentsSkills) {
  merged.set(skill.name, skill);
}
for (const skill of workspaceSkills) {
  merged.set(skill.name, skill);
}
```

每个源的加载都经过嵌套根目录检测（`resolveNestedSkillsRoot`，`src/agents/skills/workspace.ts:178-206`），自动识别 `dir/skills/*/SKILL.md` 结构。同时有严格的限流保护：

- `maxCandidatesPerRoot = 300`：单个根目录最多扫描 300 个子目录
- `maxSkillsLoadedPerSource = 200`：单个源最多加载 200 个技能
- `maxSkillFileBytes = 256KB`：单个 SKILL.md 文件大小上限

<!-- PLACEHOLDER_2_2_2 -->

#### 2.2.2 声明式资格评估引擎

资格评估的入口是 `shouldIncludeSkill()`（`src/agents/skills/config.ts:70-102`），它串联了三层检查：

```typescript
// src/agents/skills/config.ts:70-102
export function shouldIncludeSkill(params: {
  entry: SkillEntry;
  config?: OpenClawConfig;
  eligibility?: SkillEligibilityContext;
}): boolean {
  const { entry, config, eligibility } = params;
  const skillKey = resolveSkillKey(entry.skill, entry);
  const skillConfig = resolveSkillConfig(config, skillKey);
  const allowBundled = normalizeAllowlist(config?.skills?.allowBundled);

  if (skillConfig?.enabled === false) {        // 第1层：配置显式禁用
    return false;
  }
  if (!isBundledSkillAllowed(entry, allowBundled)) {  // 第2层：bundled白名单
    return false;
  }
  return evaluateRuntimeEligibility({          // 第3层：运行时资格
    os: entry.metadata?.os,
    remotePlatforms: eligibility?.remote?.platforms,
    always: entry.metadata?.always,
    requires: entry.metadata?.requires,
    hasBin: hasBinary,
    hasRemoteBin: eligibility?.remote?.hasBin,
    hasAnyRemoteBin: eligibility?.remote?.hasAnyBin,
    hasEnv: (envName) => Boolean(
      process.env[envName] ||
      skillConfig?.env?.[envName] ||
      (skillConfig?.apiKey && entry.metadata?.primaryEnv === envName),
    ),
    isConfigPathTruthy: (configPath) => isConfigPathTruthy(config, configPath),
  });
}
```

运行时资格评估（`src/shared/config-eval.ts:60-106`）支持 4 种依赖声明：
- `requires.bins`：所有列出的二进制必须可用（本地或远程）
- `requires.anyBins`：至少一个二进制可用即可
- `requires.env`：所有环境变量必须存在
- `requires.config`：所有配置路径必须为 truthy

#### 2.2.3 安装前安全扫描

安全扫描器（`src/security/skill-scanner.ts:151-242`）采用双层规则引擎：

**行级规则（LINE_RULES）**：逐行匹配，每个规则每文件最多触发一次
- `dangerous-exec`（critical）：检测 child_process 的 exec/spawn 调用
- `dynamic-code-execution`（critical）：检测 eval() 和 new Function()
- `crypto-mining`（critical）：检测 stratum+tcp、coinhive、xmrig 等挖矿特征
- `suspicious-network`（warn）：检测非标准端口的 WebSocket 连接

**源级规则（SOURCE_RULES）**：全文匹配，支持双条件（pattern + requiresContext）
- `potential-exfiltration`（warn）：readFile + fetch/http.request 组合
- `obfuscated-code`（warn）：大量 hex 编码或 base64 payload
- `env-harvesting`（critical）：process.env + 网络发送组合

```typescript
// src/security/skill-scanner.ts:80-99 (LINE_RULES 示例)
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
  // ...
];
```

#### 2.2.4 Prompt 限流与路径压缩

技能注入 prompt 时有两道限流（`src/agents/skills/workspace.ts:408-444`）：

1. **数量限流**：`maxSkillsInPrompt = 150`，超出按字母序截断
2. **字符限流**：`maxSkillsPromptChars = 30000`，超出时用二分搜索找到最大可容纳前缀

路径压缩（`src/agents/skills/workspace.ts:45-53`）将 `/Users/alice/.bun/.../skills/github/SKILL.md` 压缩为 `~/.bun/.../skills/github/SKILL.md`，每个技能路径节省 5-6 个 token。

### 2.3 实现细节

#### 远程节点技能资格

OpenClaw 支持远程 macOS 节点的技能资格评估（`src/infra/skills-remote.ts:241-309`）。当远程节点连接时，系统通过 `system.which` 或 `system.run` 命令探测远程节点上的二进制可用性，将结果缓存到内存 Map 中。当远程 bin 集合变化时，自动 bump 快照版本号触发所有 agent 刷新技能集。

#### 插件技能集成

插件系统（`src/agents/skills/plugin-skills.ts:14-74`）通过 manifest registry 发现插件声明的技能目录，经过 enable/disable 状态检查和 memory slot 互斥逻辑后，将插件技能目录加入 extra 加载源。

#### 技能命令注册与去重

技能可注册为用户可调用的斜杠命令（`src/agents/skills/workspace.ts:654-760`）。命令名经过消毒（`sanitizeSkillCommandName`：小写 + 非字母数字替换为下划线 + 截断 32 字符）和去重（`resolveUniqueSkillCommandName`：冲突时追加 `_2`、`_3` 后缀）。命令描述截断到 100 字符以兼容 Discord 限制。

---

## 第 3 章 迁移指南

### 3.1 迁移清单

**阶段 1：基础技能加载**
- [ ] 定义 `SkillEntry` 类型（skill 对象 + frontmatter + metadata + invocation policy）
- [ ] 实现 SKILL.md frontmatter 解析器（YAML 头部提取）
- [ ] 实现单源技能目录扫描（`loadSkillsFromDir`）
- [ ] 实现多源合并逻辑（Map 按优先级覆盖）

**阶段 2：资格评估**
- [ ] 实现 `hasBinary()` 检测（PATH 遍历 + 缓存）
- [ ] 实现 `evaluateRuntimeEligibility()`（OS + bins + env + config 四维检查）
- [ ] 实现 bundled allowlist 白名单过滤

**阶段 3：安全扫描**
- [ ] 定义行级和源级扫描规则
- [ ] 实现目录递归扫描（带文件数和大小限制）
- [ ] 在安装流程中集成扫描结果

**阶段 4：Prompt 集成**
- [ ] 实现 prompt 限流（数量 + 字符双限制）
- [ ] 实现路径压缩（home 目录替换为 `~`）
- [ ] 实现 SkillSnapshot 快照机制

### 3.2 适配代码模板

```typescript
// 最小可用的技能加载 + 资格评估模板
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

// --- 类型定义 ---
interface SkillMetadata {
  os?: string[];
  requires?: { bins?: string[]; env?: string[] };
  always?: boolean;
}

interface SkillEntry {
  name: string;
  description: string;
  filePath: string;
  baseDir: string;
  source: string;
  metadata?: SkillMetadata;
  prompt: string;
}

// --- 二进制检测（带缓存） ---
const binCache = new Map<string, boolean>();
function hasBinary(bin: string): boolean {
  if (binCache.has(bin)) return binCache.get(bin)!;
  const pathEnv = process.env.PATH ?? "";
  const dirs = pathEnv.split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    try {
      fs.accessSync(path.join(dir, bin), fs.constants.X_OK);
      binCache.set(bin, true);
      return true;
    } catch { /* continue */ }
  }
  binCache.set(bin, false);
  return false;
}

// --- Frontmatter 解析 ---
function parseFrontmatter(content: string): Record<string, string> {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  const pairs: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const [key, ...rest] = line.split(":");
    if (key && rest.length > 0) pairs[key.trim()] = rest.join(":").trim();
  }
  return pairs;
}

// --- 资格评估 ---
function isEligible(entry: SkillEntry): boolean {
  const meta = entry.metadata;
  if (!meta) return true;
  if (meta.always) return true;
  if (meta.os?.length && !meta.os.includes(process.platform)) return false;
  if (meta.requires?.bins?.length) {
    for (const bin of meta.requires.bins) {
      if (!hasBinary(bin)) return false;
    }
  }
  if (meta.requires?.env?.length) {
    for (const env of meta.requires.env) {
      if (!process.env[env]) return false;
    }
  }
  return true;
}

// --- 多源加载 + 合并 ---
function loadSkillsFromDir(dir: string, source: string): SkillEntry[] {
  if (!fs.existsSync(dir)) return [];
  const entries: SkillEntry[] = [];
  for (const name of fs.readdirSync(dir)) {
    const skillMd = path.join(dir, name, "SKILL.md");
    if (!fs.existsSync(skillMd)) continue;
    const content = fs.readFileSync(skillMd, "utf-8");
    const fm = parseFrontmatter(content);
    entries.push({
      name, description: fm.description ?? name,
      filePath: skillMd, baseDir: path.join(dir, name),
      source, prompt: content,
    });
  }
  return entries;
}

function buildSkillSnapshot(workspaceDir: string): SkillEntry[] {
  const sources = [
    { dir: path.join(__dirname, "bundled-skills"), source: "bundled" },
    { dir: path.join(process.env.HOME!, ".config/myapp/skills"), source: "managed" },
    { dir: path.join(workspaceDir, "skills"), source: "workspace" },
  ];
  const merged = new Map<string, SkillEntry>();
  for (const { dir, source } of sources) {
    for (const entry of loadSkillsFromDir(dir, source)) {
      merged.set(entry.name, entry); // 后写入覆盖
    }
  }
  return [...merged.values()].filter(isEligible);
}
```

### 3.3 适用场景

| 场景 | 适用度 | 说明 |
|------|--------|------|
| CLI Agent 工具（类 Claude Code） | ⭐⭐⭐ | 完美匹配：多源技能、资格评估、安全扫描全套 |
| IDE 插件系统 | ⭐⭐⭐ | 分层优先级覆盖 + 声明式依赖非常适合 |
| 多租户 SaaS Agent | ⭐⭐ | 需要额外的租户隔离层，但核心模式可复用 |
| 嵌入式 Agent（单一技能） | ⭐ | 过度设计，直接硬编码即可 |
| 跨平台桌面应用 | ⭐⭐⭐ | 远程节点资格评估机制天然支持跨平台 |

---

## 第 4 章 测试用例

```python
import pytest
from dataclasses import dataclass, field
from typing import Optional

@dataclass
class SkillMetadata:
    os: list[str] = field(default_factory=list)
    bins: list[str] = field(default_factory=list)
    any_bins: list[str] = field(default_factory=list)
    env: list[str] = field(default_factory=list)
    always: bool = False

@dataclass
class SkillEntry:
    name: str
    source: str
    metadata: Optional[SkillMetadata] = None
    enabled: bool = True

def has_binary(bin_name: str, available: set[str]) -> bool:
    return bin_name in available

def is_eligible(entry: SkillEntry, platform: str, available_bins: set[str],
                env_vars: set[str], allowlist: list[str] | None = None) -> bool:
    if not entry.enabled:
        return False
    if allowlist is not None and entry.source == "bundled":
        if entry.name not in allowlist:
            return False
    meta = entry.metadata
    if not meta:
        return True
    if meta.always:
        return True
    if meta.os and platform not in meta.os:
        return False
    if meta.bins:
        for b in meta.bins:
            if not has_binary(b, available_bins):
                return False
    if meta.any_bins:
        if not any(has_binary(b, available_bins) for b in meta.any_bins):
            return False
    if meta.env:
        for e in meta.env:
            if e not in env_vars:
                return False
    return True


class TestSkillEligibility:
    def test_no_metadata_always_eligible(self):
        entry = SkillEntry(name="basic", source="workspace")
        assert is_eligible(entry, "linux", set(), set()) is True

    def test_os_mismatch_excluded(self):
        entry = SkillEntry(name="mac-only", source="bundled",
                           metadata=SkillMetadata(os=["darwin"]))
        assert is_eligible(entry, "linux", set(), set()) is False
        assert is_eligible(entry, "darwin", set(), set()) is True

    def test_missing_binary_excluded(self):
        entry = SkillEntry(name="needs-ffmpeg", source="managed",
                           metadata=SkillMetadata(bins=["ffmpeg"]))
        assert is_eligible(entry, "linux", set(), set()) is False
        assert is_eligible(entry, "linux", {"ffmpeg"}, set()) is True

    def test_any_bins_one_sufficient(self):
        entry = SkillEntry(name="browser", source="bundled",
                           metadata=SkillMetadata(any_bins=["chromium", "google-chrome"]))
        assert is_eligible(entry, "linux", {"google-chrome"}, set()) is True
        assert is_eligible(entry, "linux", set(), set()) is False

    def test_always_bypasses_requirements(self):
        entry = SkillEntry(name="core", source="bundled",
                           metadata=SkillMetadata(os=["darwin"], bins=["swift"], always=True))
        assert is_eligible(entry, "linux", set(), set()) is True

    def test_disabled_skill_excluded(self):
        entry = SkillEntry(name="disabled", source="workspace", enabled=False)
        assert is_eligible(entry, "linux", set(), set()) is False

    def test_bundled_allowlist_blocks(self):
        entry = SkillEntry(name="secret-skill", source="bundled")
        assert is_eligible(entry, "linux", set(), set(), allowlist=["other"]) is False
        assert is_eligible(entry, "linux", set(), set(), allowlist=["secret-skill"]) is True

    def test_env_requirement(self):
        entry = SkillEntry(name="openai", source="managed",
                           metadata=SkillMetadata(env=["OPENAI_API_KEY"]))
        assert is_eligible(entry, "linux", set(), set()) is False
        assert is_eligible(entry, "linux", set(), {"OPENAI_API_KEY"}) is True


class TestSkillPriorityMerge:
    def test_workspace_overrides_bundled(self):
        merged = {}
        for entry in [SkillEntry("tool", "bundled"), SkillEntry("tool", "workspace")]:
            merged[entry.name] = entry
        assert merged["tool"].source == "workspace"

    def test_six_source_precedence(self):
        sources = ["extra", "bundled", "managed", "personal", "project", "workspace"]
        merged = {}
        for src in sources:
            merged["skill"] = SkillEntry("skill", src)
        assert merged["skill"].source == "workspace"


class TestSecurityScanner:
    """基于 src/security/skill-scanner.ts 的规则测试"""
    import re

    DANGEROUS_EXEC = re.compile(r'\b(exec|execSync|spawn|spawnSync)\s*\(')
    DYNAMIC_CODE = re.compile(r'\beval\s*\(|new\s+Function\s*\(')
    CRYPTO_MINING = re.compile(r'stratum\+tcp|coinhive|xmrig', re.IGNORECASE)

    def test_detect_exec(self):
        assert self.DANGEROUS_EXEC.search('const p = spawn("ls")') is not None

    def test_detect_eval(self):
        assert self.DYNAMIC_CODE.search('eval(userInput)') is not None

    def test_detect_crypto(self):
        assert self.CRYPTO_MINING.search('connect to stratum+tcp://pool') is not None

    def test_safe_code_passes(self):
        safe = 'const x = 1 + 2; console.log(x);'
        assert self.DANGEROUS_EXEC.search(safe) is None
        assert self.DYNAMIC_CODE.search(safe) is None
        assert self.CRYPTO_MINING.search(safe) is None
```

---

## 第 5 章 跨域关联

| 关联域 | 关系类型 | 说明 |
|--------|----------|------|
| PD-04 工具系统 | 协同 | 技能本质上是工具的高级封装，技能通过 Frontmatter 声明工具依赖，技能命令可 dispatch 到具体工具 |
| PD-05 沙箱隔离 | 依赖 | `syncSkillsToWorkspace()` 将技能复制到沙箱目录，沙箱路径解析保证技能不逃逸 |
| PD-01 上下文管理 | 协同 | Prompt 限流（maxSkillsInPrompt/maxSkillsPromptChars）和路径压缩直接服务于上下文窗口管理 |
| PD-09 Human-in-the-Loop | 协同 | 技能命令注册为斜杠命令，用户通过 `/skill-name` 主动调用，是 HITL 的一种形式 |
| PD-10 中间件管道 | 协同 | 插件技能通过 plugin manifest registry 集成，插件的 enable/disable 状态影响技能可见性 |
| PD-37 安全审计 | 依赖 | 安装前安全扫描是安全审计框架的一部分，共享 scan-paths 工具函数 |

---

## 第 6 章 来源文件索引

| 文件 | 行范围 | 关键实现 |
|------|--------|----------|
| `src/agents/skills/types.ts` | L1-89 | 核心类型定义：SkillEntry, SkillSnapshot, SkillEligibilityContext, SkillInstallSpec |
| `src/agents/skills/workspace.ts` | L221-406 | 六源分层加载 loadSkillEntries()，Map 优先级覆盖 |
| `src/agents/skills/workspace.ts` | L446-517 | SkillSnapshot 构建，prompt 限流与路径压缩 |
| `src/agents/skills/workspace.ts` | L654-760 | 技能命令注册，名称消毒与去重 |
| `src/agents/skills/config.ts` | L70-102 | shouldIncludeSkill() 三层资格评估入口 |
| `src/shared/config-eval.ts` | L60-135 | evaluateRuntimeEligibility() 四维运行时检查 |
| `src/security/skill-scanner.ts` | L80-138 | LINE_RULES + SOURCE_RULES 安全扫描规则定义 |
| `src/security/skill-scanner.ts` | L151-242 | scanSource() 核心扫描逻辑 |
| `src/agents/skills-install.ts` | L392-470 | installSkill() 安装编排（含安全扫描集成） |
| `src/agents/skills/frontmatter.ts` | L81-117 | Frontmatter 元数据解析与调用策略解析 |
| `src/infra/skills-remote.ts` | L241-335 | 远程节点 bin probe 与资格评估 |
| `src/cron/isolated-agent/skills-snapshot.ts` | L8-37 | Cron 快照版本化刷新逻辑 |
| `src/agents/skills-status.ts` | L169-253 | 技能状态报告构建（含安装选项推荐） |
| `src/auto-reply/skill-commands.ts` | L109-147 | 斜杠命令解析与技能调用分发 |
| `src/config/types.skills.ts` | L1-45 | 技能配置类型：SkillsConfig, SkillsLimitsConfig |
| `src/agents/skills/plugin-skills.ts` | L14-74 | 插件技能目录解析 |

---

## 第 7 章 横向对比维度

```json comparison_data
{
  "project": "OpenClaw",
  "dimensions": {
    "技能发现机制": "6源分层目录扫描，SKILL.md 约定，Map 同名覆盖",
    "资格评估": "声明式 Frontmatter 四维检查（OS/bins/env/config）+ 远程节点 probe",
    "安全机制": "安装前双层规则引擎静态扫描（行级+源级，critical/warn/info）",
    "Prompt集成": "数量+字符双限流，二分搜索最大前缀，路径压缩节省token",
    "快照与缓存": "SkillSnapshot 不可变快照 + 版本号比对 + filter 匹配决定刷新",
    "安装系统": "声明式多包管理器（brew/node/go/uv/download）+ 依赖自动安装",
    "命令注册": "自动消毒+去重斜杠命令，支持 tool dispatch 和 raw arg 转发"
  }
}
```

```json domain_metadata
{
  "solution_summary": "OpenClaw 用 6 源分层 Map 覆盖加载 + Frontmatter 声明式四维资格评估 + 双层规则引擎安装前安全扫描实现技能全生命周期管理",
  "description": "技能系统需要平衡安全性（安装前扫描）与可扩展性（多源分层加载）的工程权衡",
  "sub_problems": [
    "远程节点技能资格探测与缓存同步",
    "插件系统技能目录集成与互斥控制",
    "Prompt token 预算下的技能截断策略",
    "技能命令名消毒与跨平台去重"
  ],
  "best_practices": [
    "二分搜索确定 prompt 字符预算内的最大技能前缀",
    "路径压缩（home→~）节省每技能 5-6 token",
    "安装前双层规则引擎（行级+源级）静态安全扫描",
    "声明式多包管理器安装规格（brew/node/go/uv/download）"
  ]
}
```
