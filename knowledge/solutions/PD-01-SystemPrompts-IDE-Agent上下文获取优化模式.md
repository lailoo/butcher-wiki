# PD-01.06 System-Prompts-and-Models — IDE Agent 上下文获取优化模式

> 文档编号：PD-01.06
> 来源：system-prompts-and-models-of-ai-tools `VSCode Agent/`, `Cursor Prompts/`, `Orchids.app/`, `Windsurf/`
> GitHub：https://github.com/x1xhlol/system-prompts-and-models-of-ai-tools
> 问题域：PD-01 上下文管理 Context Window Management
> 状态：可复用方案

---

## 第 1 章 问题与动机

### 1.1 核心问题

IDE Agent（VSCode Copilot、Cursor、Windsurf、Orchids 等）面临一个独特的上下文管理挑战：
它们不像传统 LLM Agent 那样处理"已有的长文本"，而是需要**主动获取**代码上下文。
整个代码库可能有数万个文件、数百万行代码，但 Agent 的上下文窗口只有 128K-200K tokens。

核心矛盾：**代码库无限大 vs 上下文窗口有限**。

这与 MiroThinker（PD-01.01）的"压缩已有上下文"、GPT-Researcher（PD-01.03）的"嵌入相似度压缩"
完全不同——IDE Agent 的问题不是"如何压缩"，而是"如何高效获取"。

错误的获取策略会导致：
- 多次小文件读取浪费 tool call 轮次，每轮都消耗 token 预算
- 读取无关文件污染上下文，挤占有效信息空间
- 串行搜索导致延迟爆炸，用户体验崩溃
- 缺乏上下文导致 Agent 产生幻觉或错误修改

### 1.2 System-Prompts 项目的解法概述

该项目收集了 2024-2025 年主流 IDE Agent 的真实 system prompt，揭示了四种核心上下文获取优化模式：

1. **大块读取原则** — "prefer reading a large section over calling read_file many times"
   出现在 `VSCode Agent/claude-sonnet-4.txt:29`、`VSCode Agent/gpt-4.1.txt:29`、`VSCode Agent/gpt-4o.txt:29`、`VSCode Agent/gpt-5.txt:15`

2. **并行工具调用** — "prefer calling them in parallel"
   出现在 `VSCode Agent/claude-sonnet-4.txt:28-30`、`Cursor Prompts/Agent Prompt 2025-09-03.txt:78-93`、`Orchids.app/System Prompt.txt:178-195`

3. **语义搜索优先** — "use semantic_search / codebase_search as MAIN exploration tool"
   出现在 `Cursor Prompts/Agent Prompt 2025-09-03.txt:72-77`、`Cursor Prompts/Agent Prompt v1.0.txt:19`、`VSCode Agent/gpt-4.1.txt:96-98`

4. **记忆持久化对冲** — "limited context window...create memories liberally"
   出现在 `Windsurf/Prompt Wave 11.txt:88-96`

### 1.3 设计思想

| 设计原则 | 具体实现 | 理由 | 替代方案 |
|----------|----------|------|----------|
| 大块优于多次 | read_file 一次读大段，不逐行读 | 每次 tool call 有固定 token 开销（函数签名+结果包装），大块读取摊薄开销 | 逐行读取（token 浪费严重） |
| 并行优于串行 | 多个 read_file/grep 同时发起 | 串行 N 次 = N 轮 API 往返延迟；并行 = 1 轮延迟 | 串行逐个读取（3-5x 慢） |
| 语义优于遍历 | codebase_search 替代 grep+read | 语义搜索一次定位相关代码，避免盲目遍历 | 全文 grep（噪声大、token 浪费） |
| 外部记忆兜底 | memory_db 持久化关键上下文 | 上下文窗口会被清空，记忆数据库跨会话保留 | 仅依赖窗口内上下文（会话间丢失） |
| 工具分层选择 | semantic→grep→read_file 三级策略 | 不同精度需求用不同工具，避免一刀切 | 只用一种搜索工具（效率低） |

---

## 第 2 章 源码实现分析

### 2.1 架构概览

IDE Agent 的上下文获取不是一个独立模块，而是通过 **system prompt 指令** 编码在 Agent 行为中。
这是一种"声明式上下文管理"——不写代码，而是用自然语言规则约束 LLM 的工具调用行为。

```
┌─────────────────────────────────────────────────────────┐
│                    IDE Agent System Prompt                │
├─────────────────────────────────────────────────────────┤
│                                                          │
│  ┌──────────────┐  ┌──────────────┐  ┌───────────────┐  │
│  │ 获取策略层    │  │ 并行控制层    │  │ 记忆持久层     │  │
│  │              │  │              │  │               │  │
│  │ • 大块读取    │  │ • 工具白名单  │  │ • create_mem  │  │
│  │ • 语义搜索    │  │ • 并行/串行   │  │ • 自动检索    │  │
│  │ • 分层工具    │  │ • 批次限制    │  │ • 跨会话      │  │
│  └──────┬───────┘  └──────┬───────┘  └───────┬───────┘  │
│         │                 │                   │          │
│  ┌──────▼─────────────────▼───────────────────▼───────┐  │
│  │              Tool Calling Runtime                   │  │
│  │  read_file | codebase_search | grep | list_dir     │  │
│  └────────────────────────────────────────────────────┘  │
│                          │                               │
│                          ▼                               │
│              ┌──────────────────────┐                    │
│              │   LLM Context Window  │                    │
│              │   (128K-200K tokens)  │                    │
│              └──────────────────────┘                    │
└─────────────────────────────────────────────────────────┘
```

<!-- PLACEHOLDER_CONTENT_PART2 -->
