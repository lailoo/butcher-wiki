# PD-11.04 DeepTutor — 三层可观测性：统一日志 + Token 追踪 + 性能监控

> 文档编号：PD-11.04
> 来源：DeepTutor `src/logging/`, `src/agents/solve/utils/token_tracker.py`, `src/agents/solve/utils/performance_monitor.py`
> GitHub：https://github.com/HKUDS/DeepTutor.git
> 问题域：PD-11 可观测性 Observability & Cost Tracking
> 状态：可复用方案

---

## 第 1 章 问题与动机（≥ 30 行）

### 1.1 核心问题

在多 Agent 教育辅导系统中，可观测性面临三个层次的挑战：

1. **日志碎片化**：Solve、Research、Question 等多个模块各自输出日志，格式不统一，难以关联分析
2. **Token 成本不透明**：多个 Agent 并行调用不同模型（GPT-4o、DeepSeek、Claude），无法精确追踪每个 Agent 的 token 消耗和成本
3. **性能瓶颈难定位**：双循环（Analysis Loop + Solve Loop）架构中，不知道哪个 Agent 耗时最长、API 调用最多

DeepTutor 作为一个学术论文辅导系统，单次问答可能触发 5-10 次 LLM 调用（分解问题 → RAG 检索 → 分析 → 规划 → 执行 → 回答），成本控制和性能优化都依赖精确的可观测性数据。

### 1.2 DeepTutor 的解法概述

DeepTutor 构建了三层可观测性体系，每层独立又可协同：

1. **统一日志系统** (`src/logging/`)：自建 Logger 封装 Python logging，统一 `[Module] LEVEL: Message` 格式，支持 Console（彩色）、File（带时间戳）、JSON（结构化）、WebSocket（实时推送）四种输出通道 — `src/logging/logger.py:129`
2. **Token 追踪器** (`TokenTracker`)：支持 4 级精度降级（API 返回值 → tiktoken → litellm → 词数估算），内置多模型定价表自动估算成本，按 Agent/Model/Method 三维度聚合统计 — `src/agents/solve/utils/token_tracker.py:235`
3. **性能监控器** (`PerformanceMonitor`)：以 Agent 为粒度追踪执行时间、API 调用次数、错误计数，支持 context manager 和 decorator 两种接入方式 — `src/agents/solve/utils/performance_monitor.py:88`

### 1.3 设计思想

| 设计原则 | 具体实现 | 理由 | 替代方案 |
|----------|----------|------|----------|
| 三层分离 | Logger / TokenTracker / PerformanceMonitor 各自独立 | 关注点分离，可按需启用 | 单一 Tracker 全包（耦合度高） |
| 精度降级 | API > tiktoken > litellm > 词数估算 | 不同场景精度需求不同，保证总有数据 | 只用 API 返回值（流式场景无数据） |
| 双轨追踪 | BaseAgent 同时写入 TokenTracker + LLMStats | TokenTracker 给前端实时展示，LLMStats 给日志系统 | 单一追踪器（无法同时满足实时和持久化） |
| 回调驱动 | TokenTracker.set_on_usage_added_callback() | 每次 add_usage 自动推送到 DisplayManager/WebSocket | 轮询（延迟高、浪费资源） |
| 全局单例 | get_token_tracker() / get_monitor() | 跨模块共享同一追踪器实例 | 依赖注入（配置复杂） |

---

## 第 2 章 源码实现分析（≥ 60 行，核心章节）

### 2.1 架构概览

<!-- PLACEHOLDER_ARCH -->
