# Butcher Wiki — 项目切割机

## 愿景

Butcher Wiki 是一个 Agent 工程知识库，核心能力是"屠夫"——输入一个开源项目代码，输出被切割成一个个 Agent 工程组件/特性的最佳方案与经验。

与 DeepWiki（纵向分析单个项目）不同，Butcher Wiki 是**横向**的：按工程问题域组织，展示不同项目对同一问题的不同解法，支持跨项目对比。

### 关键设计原则：问题域动态扩展

问题域（PD）不是固定的，而是**动态发现**的。分析一个新项目时，如果发现了当前域列表中没有的优秀特性，就自动创建新的问题域。域的增长是知识库成长的自然结果，不预设框架。

当前已发现的域从最初的 12 个开始，随着分析更多项目会持续扩展。

### 核心差异化

| 维度 | DeepWiki | Butcher Wiki | EvoMap |
|------|----------|-------------|--------|
| 分析轴 | 纵向：单项目深度分析 | 横向：跨项目同一问题对比 | 运行时：Agent 自动获取经验 |
| 输入 | 一个 Git 仓库 URL | 多个仓库 + 问题域定义 | Agent 运行日志 + 错误信号 |
| 输出 | 项目架构 Wiki | 问题域解决方案图谱 | Gene + Capsule（可执行经验） |
| 消费者 | 人类（了解项目） | 人类 + Agent（解决工程问题） | Agent（自动应用经验） |

### 终极目标

1. **知识沉淀**：每个方案文档详细到可以直接 copy 后指导实现（面向 spec + TDD 编程）
2. **Agent 可消费**：未来加 MCP 接口，让 Agent 按问题域查询解决方案
3. **自动切割**：Scanner + LLM 自动分析新项目，提取组件到知识库
4. **经验复用**：类似 EvoMap 的 Gene 概念，但以人类可读文档为载体

## 核心思想

> 把开源项目大卸八块，提取可移植的 Agent 工程组件。
> 这些组件的设计思想可以移植到其他项目上，作为可借鉴的开发与实践方案。
> 通过小组件的重组来实现新项目的整合和生成。

## 当前问题域（动态扩展）

> 以下域是从已分析项目中发现的，新项目分析时可能产生新域。

| ID | 域 | 严重度 |
|------|------|--------|
| PD-01 | 上下文管理 Context Window Management | critical |
| PD-02 | 多 Agent 编排 Multi-Agent Orchestration | critical |
| PD-03 | 容错与重试 Fault Tolerance & Retry | critical |
| PD-04 | 工具系统 Tool System Design | high |
| PD-05 | 沙箱隔离 Sandbox Isolation | high |
| PD-06 | 记忆持久化 Memory Persistence | high |
| PD-07 | 质量检查 Quality Assurance | high |
| PD-08 | 搜索与检索 Search & Retrieval | critical |
| PD-09 | Human-in-the-Loop | medium |
| PD-10 | 中间件管道 Middleware Pipeline | medium |
| PD-11 | 可观测性 Observability & Cost Tracking | high |
| PD-12 | 推理增强 Reasoning Enhancement | medium |

## 已分析项目

| 项目 | GitHub | 覆盖域 |
|------|--------|--------|
| MiroThinker | https://github.com/MiroMindAI/MiroThinker | PD-01,02,03,04,05,11,12 |
| DeerFlow | https://github.com/bytedance/deer-flow | PD-01~07,09,10 |
| GPT-Researcher | https://github.com/assafelovic/gpt-researcher | PD-01,02,06~09,12 |
| DeepResearch | https://github.com/Alibaba-NLP/DeepResearch | PD-01,05,08,12 |
| DeepWiki | https://github.com/AsyncFuncAI/deepwiki-open | PD-08 |

## 三大参考项目源

1. **DeepWiki** — git clone → 文件扫描 → RAG → Wiki 生成的流水线架构
2. **EvoMap** — Gene/Capsule 结构化经验协议、signals 匹配、GDI 评分
3. **vibe-blog-evolve** — scan → screen → deep-compare → assess → plan → implement → verify → record 全流程

## vibe-blog-evolve 迁移方案索引

以下 vibe-blog 方案文档可作为 Butcher Wiki 知识库的输入源：

<!-- PLACEHOLDER_REFS -->
| 域 | vibe-blog 方案 | 对应 Butcher Wiki 方案 |
|----|---------------|----------------------|
| PD-01 | 113.01 AgentFold-ReSum 上下文管理 | PD-01-MiroThinker, PD-01-DeerFlow |
| PD-02 | 102.01 Multi-Agent 并行编排 | PD-02-DeerFlow-LangGraph-DAG |
| PD-02 | 1002.13 子代理委托系统 | PD-02-GPT-Researcher-Master-Worker |
| PD-03 | 102.07 容错恢复与上下文压缩 | PD-03-MiroThinker, PD-03-DeerFlow |
| PD-04 | 102.08 配置驱动工具系统 | PD-04-DeerFlow, PD-04-MiroThinker |
| PD-04 | 1002.06 MCP 协议集成 | PD-04 MCP 扩展 |
| PD-05 | 102.04 沙箱隔离执行环境 | PD-05-DeerFlow, PD-05-MiroThinker |
| PD-06 | 102.03 持久化记忆系统 | PD-06-DeerFlow, PD-06-GPT-Researcher |
| PD-06 | 1002.05 记忆系统配置化 | PD-06 扩展 |
| PD-07 | 13 Reviewer 质量检查 | PD-07-DeerFlow, PD-07-GPT-Researcher |
| PD-08 | 41.02 多搜索源×树状递归 | PD-08-GPT-Researcher |
| PD-08 | 41.02 源可信度筛选 | PD-08 扩展 |
| PD-09 | 102.05 交互式澄清与计划审批 | PD-09-DeerFlow |
| PD-09 | 101.113 LangGraph interrupt 改造 | PD-09 扩展 |
| PD-10 | 102.02 中间件管道系统 | PD-10-DeerFlow |
| PD-11 | 41.08 成本追踪增强 | PD-11-MiroThinker |
| PD-12 | 41.06 三级 LLM 模型策略 | PD-12-DeepResearch |

## 技术栈

- **前端**: Next.js 15 + React 19 + Tailwind CSS
- **扫描引擎**: Claude Code CLI（child_process.spawn 调用 `claude` 命令）
- **知识库**: YAML/Markdown 文件（domains/solutions/comparisons）
- **风格**: visionOS 毛玻璃卡片 + EvoMap Market 列表卡片，暗色主题
- **字体**: IBM Plex Sans (正文) + JetBrains Mono (代码)

## 扫描架构

```
用户点击"开始切割" → POST /api/scan
  → CCRunner (src/lib/cc-runner.ts) spawn('claude', [...])
  → CC 自主执行: git clone → Glob/Grep 扫描 → Read 分析 → 输出 JSON
  → cc-runner 解析 stream-json stdout，提取结构化工具调用事件
  → SSE 实时推送到前端 ScanLogPanel
  → 前端展示工具调用卡片（工具名、输入、输出、耗时、退出码）
```

CC CLI 参数:
- `--output-format stream-json` 实时流式输出
- `--allowedTools "Bash Read Glob Grep"` 限制工具
- `--dangerously-skip-permissions` 跳过权限确认
- `--max-budget-usd 1` 单次扫描成本限制
- `--no-session-persistence` 不保存会话

CC 自动加载 `.claude/skills/butcher-scan/SKILL.md` 作为切割行为指引。

## 前端设计规范

- 背景色 `#0a0a0f`，毛玻璃卡片 `backdrop-blur(24px)`
- 每个问题域有独立主题色（indigo/violet/pink/amber/emerald 等）
- 卡片 hover 时显示彩色边缘光晕 + 微上浮
- 严重度徽章：critical(红) / high(橙) / medium(黄)
- 浮动导航栏，`top-4` 间距
- 响应式：移动端单列，桌面端 3 列网格

## 项目结构

```
butcher-wiki/
├── src/                    # Next.js 前端
│   ├── app/               # 页面路由
│   │   ├── page.tsx       # 首页：12 域卡片网格（数据驱动）
│   │   ├── domain/[slug]/ # 域详情：侧边栏 + 方案列表 + 对比表
│   │   ├── scan/          # 扫描页：输入 repo URL → CC 深度分析
│   │   ├── api/scan/      # SSE API：调用 CC CLI 并流式推送进度
│   │   ├── projects/      # 项目索引：已分析项目列表
│   │   └── layout.tsx     # 根布局 + 导航栏
│   ├── components/        # UI 组件
│   │   └── scan/          # 扫描相关组件
│   │       └── ScanLogPanel.tsx  # 结构化日志面板（工具调用卡片）
│   ├── lib/               # 核心库
│   │   ├── cc-runner.ts   # CC 进程管理（spawn + watchdog + 事件解析）
│   │   └── scan-prompt.ts # CC 指令 prompt 构建
│   ├── data/domains.ts    # 全局域数据（驱动首页 + 域详情）
│   └── types/             # TypeScript 类型
├── .claude/               # CC 配置
│   ├── settings.json      # 项目级 CC 权限配置
│   └── skills/            # CC 技能
│       └── butcher-scan/  # 项目切割技能
│           └── SKILL.md   # 7 阶段切割流程 + 12 域定义
├── knowledge/             # 知识库数据（所有方案文档在此）
│   ├── DESIGN.md         # 项目设计文档
│   ├── registry.yaml     # 全局索引
│   ├── domains/          # 域定义 YAML
│   ├── solutions/        # 方案详情 MD（核心！）
│   ├── comparisons/      # 对比文档 MD
│   └── references/       # vibe-blog 等外部方案引用索引
└── CLAUDE.md             # 本文件：项目记忆
```

## 方案文档规范

每个方案文档 (`knowledge/solutions/PD-XX-Project-方案名.md`) 遵循统一模板：

1. **第 1 章 问题与动机** — 核心问题、解法概述、设计思想表
2. **第 2 章 源码实现分析** — 架构图、关键代码（Python）、实现细节
3. **第 3 章 迁移指南** — 迁移清单、适配代码模板、场景矩阵
4. **第 4 章 测试用例** — pytest 代码（可直接运行）
5. **第 5 章 跨域关联** — 与其他问题域的关系
6. **第 6 章 来源文件索引** — 源项目文件路径

目标：copy 后直接就能实现对该功能的借鉴和复用。

## 开发指南

- `pnpm install && pnpm dev` 启动前端
- 扫描功能依赖本地安装的 `claude` CLI（`which claude` 可用）
- 前端数据源：`src/data/domains.ts`（首页 + 域详情共用）
- 域详情页使用 `[slug]` 动态路由 + `generateStaticParams` 预渲染所有 12 个域
- 所有方案文档放在 `knowledge/solutions/` 下，不放 `docs/`
