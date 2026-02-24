# PD-51.01 OpenManus — Google A2A 协议集成

> 文档编号：PD-51.01
> 来源：OpenManus `protocol/a2a/app/`
> GitHub：https://github.com/FoundationAgents/OpenManus.git
> 问题域：PD-51 Agent-to-Agent 协议 Agent-to-Agent Protocol
> 状态：可复用方案

---

## 第 1 章 问题与动机

### 1.1 核心问题

Agent 系统之间缺乏标准化通信协议。每个 Agent 框架（LangChain、AutoGen、CrewAI 等）都有自己的调用接口和数据格式，导致：

- **互操作性缺失**：不同框架构建的 Agent 无法直接对话
- **集成成本高**：每对接一个新系统就需要写一套适配代码
- **能力发现困难**：外部系统无法自动了解 Agent 具备哪些技能
- **生命周期不统一**：任务的创建、执行、完成、取消缺乏标准状态机

Google 提出的 A2A（Agent-to-Agent）协议试图解决这些问题，定义了 Agent Card（能力声明）、Task（任务生命周期）、Message/Part（消息格式）等标准化概念。

### 1.2 OpenManus 的解法概述

OpenManus 通过三层架构将已有的 Manus Agent 封装为 A2A 兼容服务：

1. **协议适配层 A2AManus**（`protocol/a2a/app/agent.py:15`）：继承 Manus，添加 `invoke`/`stream` 接口和响应格式化
2. **执行器层 ManusExecutor**（`protocol/a2a/app/agent_executor.py:23`）：实现 A2A SDK 的 `AgentExecutor` 接口，处理请求验证、Agent 工厂调用、事件队列写入
3. **服务入口层 main**（`protocol/a2a/app/main.py:27`）：组装 AgentCard、Skills、RequestHandler，启动 Starlette HTTP 服务

### 1.3 设计思想

| 设计原则 | 具体实现 | 理由 | 替代方案 |
|----------|----------|------|----------|
| 最小侵入封装 | A2AManus 仅添加 3 个方法，不修改 Manus 核心逻辑 | 保持原有 Agent 功能完整，降低耦合 | 重写 Agent 适配协议（侵入性高） |
| 工厂模式创建 Agent | `agent_factory=lambda: A2AManus.create(max_steps=3)` | 每次请求创建新实例，避免状态污染 | 单例复用（有并发状态冲突风险） |
| 事件队列解耦 | ManusExecutor 通过 EventQueue 异步推送结果 | 支持推送通知和异步任务完成 | 直接返回响应（不支持长时任务） |
| AgentCard 能力声明 | 在 main.py 中声明 skills、capabilities、content types | 外部系统可通过 `/.well-known/agent.json` 自动发现 | 文档描述（不可机器读取） |
| JSON-RPC 2.0 通信 | 使用 A2A SDK 的 `message/send` 方法 | 标准化请求/响应格式，与协议规范一致 | REST API（非协议标准） |

---

## 第 2 章 源码实现分析

### 2.1 架构概览

