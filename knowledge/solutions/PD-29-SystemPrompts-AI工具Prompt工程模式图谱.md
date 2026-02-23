# PD-29.01 system-prompts-and-models-of-ai-tools — AI 工具 System Prompt 工程模式图谱

> 文档编号：PD-29.01
> 来源：system-prompts-and-models-of-ai-tools `Replit/Prompt.txt`, `Cursor Prompts/Agent Prompt 2.0.txt`, `Orchids.app/System Prompt.txt`, `Kiro/Vibe_Prompt.txt`, `Kiro/Spec_Prompt.txt`, `Anthropic/Claude Code/Prompt.txt`, `VSCode Agent/gpt-5.txt`, `Lovable/Agent Prompt.txt`, `Manus Agent Tools & Prompt/Prompt.txt`
> GitHub：https://github.com/x1xhlol/system-prompts-and-models-of-ai-tools
> 问题域：PD-29 Prompt 工程模式 Prompt Engineering Patterns
> 状态：可复用方案

---

## 第 1 章 问题与动机（≥ 30 行）

### 1.1 核心问题

AI Agent 产品的行为完全由 system prompt 决定。一个设计不良的 prompt 会导致：
- Agent 身份混乱，在不同上下文中表现不一致
- 行为约束失效，安全规则被绕过
- 输出格式不可控，下游解析频繁失败
- 工具调用混乱，该并行时串行、该串行时并行
- 用户体验割裂，语气风格在对话中漂移

system-prompts-and-models-of-ai-tools 仓库收集了 30+ 商业 AI 工具的真实 system prompt，是目前最全面的 prompt 工程实践样本库。通过横向对比这些 prompt，可以提取出经过大规模生产验证的设计模式。

### 1.2 仓库解法概述

该仓库本身不是一个可运行的软件项目，而是一个**模式采集场**。其核心价值在于：

1. **身份定义模式**：Replit 用 `<identity>` XML 标签（`Replit/Prompt.txt:1-4`），Kiro 用 `# Identity` Markdown 标题（`Kiro/Vibe_Prompt.txt:1-8`），Cursor 用自然语言嵌入（`Cursor Prompts/Agent Prompt 2.0.txt:511`），展示了三种主流身份定义范式
2. **结构化分区模式**：Orchids.app 用 `<reasoning_principles>`/`<tools_parallelization>`/`<best_practices>` 等 XML 标签将 prompt 分为 15+ 个功能区块（`Orchids.app/System Prompt.txt:43-196`），是最精细的分区实践
3. **行为约束层级模式**：Claude Code 将安全约束放在 prompt 最前部用 `IMPORTANT:` 前缀（`Anthropic/Claude Code/Prompt.txt:3-4`），Kiro 用 `# Rules` 独立区块（`Kiro/Vibe_Prompt.txt:23-36`），展示了约束优先级的不同策略
4. **工具调用治理模式**：Cursor 定义了 `<tool_calling>` 区块含 9 条规则（`Cursor Prompts/Agent Prompt 2.0.txt:526-537`），Orchids.app 定义了 `<tools_parallelization>` 明确哪些工具可并行（`Orchids.app/System Prompt.txt:178-195`）
5. **输出格式控制模式**：Cursor 用 `<citing_code>` 区块定义了两种代码引用格式（`Cursor Prompts/Agent Prompt 2.0.txt:567-760`），VSCode Agent 用 `<outputFormatting>` 控制 Markdown 层级（`VSCode Agent/gpt-5.txt:139-150`）

### 1.3 设计思想

| 设计原则 | 具体实现 | 理由 | 替代方案 |
|----------|----------|------|----------|
| 结构化分区 | XML 标签 `<identity>`/`<rules>`/`<tools>` 划分功能区 | LLM 对 XML 标签有天然的注意力权重，分区后各区块职责清晰 | Markdown 标题分区（Kiro）、纯自然语言（Manus） |
| 约束前置 | 安全规则放在 prompt 最前部，用 `IMPORTANT:` 标记 | LLM 对 prompt 开头内容注意力最强，确保安全约束不被覆盖 | 分散在各区块中（Orchids.app）、独立 Rules 区块（Kiro） |
| 示例驱动 | `<example>` 标签包裹 few-shot 示例 | 示例比规则描述更精确地传达期望行为 | 纯规则描述无示例（Manus）、Good/Bad 对比示例（Cursor） |
| 工具并行声明 | 显式列出可并行工具清单 | 避免 LLM 默认串行调用导致延迟 | 隐式依赖 LLM 判断（Claude Code v1） |
| 人格一致性 | 独立的 `# Response style` 区块定义语气、用词、格式 | 确保多轮对话中人格不漂移 | 分散在各处的零散语气指令（Cursor） |

---

## 第 2 章 源码实现分析（≥ 60 行，核心章节）

### 2.1 架构概览

通过分析 10+ 个 AI 工具的 system prompt，可以提取出一个通用的 prompt 架构模型：

```
┌─────────────────────────────────────────────────────────┐
│                    System Prompt 架构                      │
├─────────────────────────────────────────────────────────┤
│  Layer 1: 安全约束层 (Security Constraints)                │
│  ┌─────────────────────────────────────────────────────┐│
│  │ IMPORTANT: 安全规则 / 内容策略 / 拒绝条件            ││
│  └─────────────────────────────────────────────────────┘│
│  Layer 2: 身份定义层 (Identity Definition)                 │
│  ┌─────────────────────────────────────────────────────┐│
│  │ <identity> / # Identity / 角色描述                    ││
│  └─────────────────────────────────────────────────────┘│
│  Layer 3: 能力声明层 (Capabilities Declaration)            │
│  ┌─────────────────────────────────────────────────────┐│
│  │ <capabilities> / # Capabilities / 功能列表            ││
│  └─────────────────────────────────────────────────────┘│
│  Layer 4: 行为规则层 (Behavioral Rules)                    │
│  ┌─────────────────────────────────────────────────────┐│
│  │ <rules> / <behavioral_rules> / # Rules               ││
│  └─────────────────────────────────────────────────────┘│
│  Layer 5: 工具治理层 (Tool Governance)                     │
│  ┌─────────────────────────────────────────────────────┐│
│  │ <tool_calling> / <tools_parallelization> / 工具规则   ││
│  └─────────────────────────────────────────────────────┘│
│  Layer 6: 输出格式层 (Output Formatting)                   │
│  ┌─────────────────────────────────────────────────────┐│
│  │ <citing_code> / <outputFormatting> / 格式规范         ││
│  └─────────────────────────────────────────────────────┘│
│  Layer 7: 工作流层 (Workflow Definition)                    │
│  ┌─────────────────────────────────────────────────────┐│
│  │ <workflow-definition> / 任务管理 / 执行策略            ││
│  └─────────────────────────────────────────────────────┘│
│  Layer 8: 环境上下文层 (Environment Context)               │
│  ┌─────────────────────────────────────────────────────┐│
│  │ <env> / <environment> / 系统信息 / 日期时间            ││
│  └─────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────┘
```

<!-- PLACEHOLDER_CONTENT_CONTINUES -->
