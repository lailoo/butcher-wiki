# PD-04.06 SystemPromptsAndModels — Function Calling Schema 行业标准图谱

> 文档编号：PD-04.06
> 来源：system-prompts-and-models-of-ai-tools `17 个工具定义 JSON 文件`
> GitHub：https://github.com/x1xhlol/system-prompts-and-models-of-ai-tools
> 问题域：PD-04 工具系统 Tool System Design
> 状态：可复用方案

---

## 第 1 章 问题与动机（≥ 30 行）

### 1.1 核心问题

AI 编码工具（Cursor、Claude Code、Lovable、Replit、Manus、v0、Trae、Augment Code 等）都需要让 LLM 调用外部工具来完成文件操作、终端执行、代码搜索等任务。核心挑战是：

1. **Schema 标准化**：如何定义工具的 name/description/parameters 使 LLM 能准确理解和调用？
2. **工具分类与分组**：不同场景需要不同工具集，如何组织？
3. **描述工程**：description 的详细程度直接影响 LLM 的调用准确率，如何平衡信息量与 token 消耗？
4. **跨模型兼容**：同一工具集需要适配 OpenAI function calling 和 Anthropic tool_use 两种协议
5. **权限与安全**：如何在工具层面控制 Agent 的能力边界？

### 1.2 SystemPromptsAndModels 的解法概述

该仓库是一个**行业级工具定义样本库**，收集了 17+ 主流 AI 编码工具的真实 function calling schema。它不是一个运行时系统，而是一个**设计模式参考集**，揭示了行业在工具系统设计上的共识与分歧：

1. **统一四要素结构**：所有工具都遵循 `name` + `description` + `parameters`（JSON Schema）+ `required` 的基本结构（`Manus Agent Tools & Prompt/tools.json:1-25`、`Cursor Prompts/Agent Tools v1.0.json:1-28`）
2. **工具分类趋同**：文件读写、终端执行、代码搜索、Web 搜索、任务管理 5 大类工具在所有产品中都出现
3. **描述即 Prompt**：工具 description 实质上是嵌入式 prompt engineering，长度从 1 行到 100+ 行不等
4. **双协议适配**：Augment Code 同时维护 `claude-4-sonnet-tools.json` 和 `gpt-5-tools.json`，展示了跨模型适配策略
5. **模式化权限控制**：通过 `allowedTools` 白名单、`requires_approval` 标志、`sudo` 参数等机制实现分层权限

### 1.3 设计思想

| 设计原则 | 具体实现 | 理由 | 替代方案 |
|----------|----------|------|----------|
| Schema 即契约 | JSON Schema 定义参数类型、必填项、枚举值 | LLM 需要结构化约束才能生成合法调用 | 自然语言描述（不可靠） |
| Description 即 Prompt | 工具描述中嵌入使用场景、示例、注意事项 | 减少 LLM 误调用，提高首次调用成功率 | 依赖系统 prompt 中的全局指令 |
| 工具正交化 | 每个工具只做一件事（read/write/search 分离） | 降低 LLM 决策复杂度，减少参数冲突 | 多功能合一工具（参数爆炸） |
| 渐进式权限 | sudo 参数、approval 标志、工具白名单 | 安全边界清晰，用户可控 | 全开放或全禁止 |
| 跨模型兼容 | 同时维护 OpenAI/Anthropic 两套 schema | 不同模型对 schema 的解析能力不同 | 只支持单一模型 |

---

## 第 2 章 源码实现分析（≥ 60 行，核心章节）

### 2.1 架构概览

```
┌─────────────────────────────────────────────────────────────────┐
│                    AI Coding Tool 工具系统                        │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐        │
│  │ 文件操作  │  │ 终端执行  │  │ 代码搜索  │  │ Web/外部  │        │
│  │ read     │  │ bash     │  │ grep     │  │ search   │        │
│  │ write    │  │ shell    │  │ semantic │  │ fetch    │        │
│  │ edit     │  │ process  │  │ codebase │  │ browse   │        │
│  │ delete   │  │ kill     │  │ file_find│  │ deploy   │        │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘        │
│       │              │              │              │             │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐        │
│  │ 任务管理  │  │ 子代理   │  │ 诊断/Lint │  │ 平台特有  │        │
│  │ todo     │  │ agent    │  │ diagnostc│  │ secrets  │        │
│  │ progress │  │ task     │  │ lint     │  │ deploy   │        │
│  │ finish   │  │ search   │  │ errors   │  │ preview  │        │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘        │
│                                                                  │
├─────────────────────────────────────────────────────────────────┤
│  Schema 层：JSON Schema (type/properties/required/enum/default)  │
│  协议层：OpenAI function_call / Anthropic tool_use              │
│  权限层：allowedTools / requires_approval / sudo                │
└─────────────────────────────────────────────────────────────────┘
```

### 2.2 核心实现

#### 2.2.1 Schema 结构对比：OpenAI vs Anthropic 协议

<!-- PLACEHOLDER_MORE_CONTENT -->
