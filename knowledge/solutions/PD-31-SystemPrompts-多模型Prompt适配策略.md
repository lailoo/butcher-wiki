# PD-31.01 system-prompts-and-models-of-ai-tools — 多模型 Prompt 适配策略

> 文档编号：PD-31.01
> 来源：system-prompts-and-models-of-ai-tools `VSCode Agent/`, `Augment Code/`, `Amp/`
> GitHub：https://github.com/x1xhlol/system-prompts-and-models-of-ai-tools
> 问题域：PD-31 多模型适配 Multi-Model Adaptation
> 状态：可复用方案

---

## 第 1 章 问题与动机（Problem & Motivation）

### 1.1 核心问题

当同一个 AI Coding Agent 框架需要支持多个 LLM 后端（GPT-5、GPT-4.1、GPT-4o、Claude Sonnet 4、Gemini 2.5 Pro、GPT-5-mini 等）时，面临以下工程挑战：

1. **Prompt 格式偏好差异**：不同模型对指令结构、XML 标签、Markdown 格式的响应能力不同
2. **能力层级差异**：旗舰模型（GPT-5）vs 轻量模型（GPT-5-mini）在推理深度、工具调用可靠性上有显著差距
3. **工具调用协议差异**：OpenAI function calling vs Anthropic tool_use vs Google function declarations 的 schema 格式不同
4. **行为一致性保证**：用户期望无论选择哪个模型，Agent 的核心行为（代码编辑、搜索、终端操作）保持一致
5. **成本与质量权衡**：需要根据模型能力调整 prompt 复杂度，避免对弱模型过度指令、对强模型指令不足

### 1.2 system-prompts-and-models-of-ai-tools 的解法概述

该仓库收集了 30+ 个 AI Coding Agent 产品的真实 system prompt，其中三个框架展示了完整的多模型适配策略：

1. **VSCode Agent（GitHub Copilot）**：为 6 个模型维护独立 prompt 文件，共享基础身份声明 + 模型特定行为指令（`VSCode Agent/gpt-5.txt:1-233`, `VSCode Agent/gpt-4.1.txt:1-140`）
2. **Augment Code**：为 Claude Sonnet 4 和 GPT-5 维护独立的 agent prompt + tools 定义，在 prompt 层声明模型身份（`Augment Code/claude-4-sonnet-agent-prompts.txt:8-9`, `Augment Code/gpt-5-agent-prompts.txt:8`）
3. **Amp（Sourcegraph）**：通过 YAML 配置文件为不同模型定义完整的 system prompt + tools schema + 推理参数（`Amp/gpt-5.yaml:4`, `Amp/claude-4-sonnet.yaml:5-6`）

### 1.3 设计思想

| 设计原则 | 具体实现 | 理由 | 替代方案 |
|----------|----------|------|----------|
| 文件级隔离 | 每个模型一个独立 prompt 文件 | 避免条件分支地狱，便于独立迭代 | 单文件 + if/else 模板（维护困难） |
| 共享基座 + 差异层 | 公共身份声明 + 模型特定行为指令 | 保证核心行为一致，允许模型特化 | 完全独立（重复代码多） |
| 工具 schema 统一 | 工具定义在所有模型间保持相同 JSON schema | 降低工具层维护成本 | 每模型独立工具定义（同步困难） |
| 能力分级指令 | 旗舰模型增加高级指令（工程思维、质量门控） | 充分利用强模型能力 | 统一最低公约数（浪费强模型） |
| 声明式模型身份 | prompt 中显式声明 "The base model is X" | 让模型自我认知，影响行为风格 | 隐式推断（不可控） |

---

## 第 2 章 源码实现分析（Source Code Analysis）

### 2.1 架构概览

```
┌─────────────────────────────────────────────────────────────┐
│                    Agent Framework Layer                      │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐                   │
│  │ VSCode   │  │ Augment  │  │   Amp    │                   │
│  │ Agent    │  │  Code    │  │(Sourcegraph)│                │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘                   │
│       │              │              │                         │
│  ┌────▼──────────────▼──────────────▼─────┐                  │
│  │         Model Router / Selector         │                  │
│  └────┬──────┬──────┬──────┬──────┬───────┘                  │
│       │      │      │      │      │                          │
│  ┌────▼──┐┌──▼──┐┌──▼──┐┌──▼───┐┌─▼────┐                   │
│  │GPT-5  ││GPT  ││GPT  ││Claude││Gemini│                    │
│  │prompt ││4.1  ││4o   ││Son.4 ││2.5Pro│                    │
│  │+tools ││prom.││prom.││prom. ││prom. │                    │
│  └───────┘└─────┘└─────┘└──────┘└──────┘                    │
│       │      │      │      │      │                          │
│  ┌────▼──────▼──────▼──────▼──────▼───────┐                  │
│  │        Shared Tool Schema Layer         │                  │
│  │  (read_file, edit, terminal, search)    │                  │
│  └────────────────────────────────────────┘                  │
└─────────────────────────────────────────────────────────────┘
```

