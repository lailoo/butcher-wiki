# PD-02.05 Nanobot — Spawn 子 Agent 异步编排方案

> 文档编号：PD-02.05
> 来源：Nanobot `nanobot/agent/subagent.py`, `nanobot/agent/tools/spawn.py`, `nanobot/agent/loop.py`
> GitHub：https://github.com/HKUDS/nanobot.git
> 问题域：PD-02 多 Agent 编排 Multi-Agent Orchestration
> 状态：可复用方案

---

## 第 1 章 问题与动机

### 1.1 核心问题

在单 Agent 架构中，当用户请求涉及耗时任务（文件搜索、Web 抓取、代码执行等）时，主 Agent 会被阻塞，无法响应新消息。用户体验退化为"发一条等半天"。

多 Agent 编排的核心挑战在于：
- **并行执行**：如何让多个任务同时运行而不阻塞主循环
- **结果回传**：子任务完成后如何通知主 Agent 并自然地呈现给用户
- **递归防护**：如何防止子 Agent 无限 spawn 新的子 Agent
- **工具隔离**：子 Agent 应该拥有哪些能力，哪些能力必须禁止

### 1.2 Nanobot 的解法概述

Nanobot 采用了一种极简的 **Spawn-and-Forget + MessageBus 回调** 模式：

1. **asyncio.create_task 异步派生**：主 Agent 通过 `spawn` 工具创建后台 asyncio Task，立即返回确认消息，不阻塞主循环 (`subagent.py:81-84`)
2. **独立工具注册表**：每个子 Agent 创建独立的 `ToolRegistry`，显式注册文件/Shell/Web 工具，但**不注册 message 和 spawn 工具**，从根本上防止递归 (`subagent.py:104-116`)
3. **MessageBus 结果注入**：子 Agent 完成后，通过 `bus.publish_inbound()` 将结果作为 system 消息注入主 Agent 的消息队列，触发主 Agent 自然回复用户 (`subagent.py:208-215`)
4. **迭代上限保护**：子 Agent 最多执行 15 轮工具调用循环，防止无限执行 (`subagent.py:126-127`)
5. **自动清理**：通过 `add_done_callback` 在任务完成时自动从 `_running_tasks` 字典中移除 (`subagent.py:87`)

### 1.3 设计思想

| 设计原则 | 具体实现 | 理由 | 替代方案 |
|----------|----------|------|----------|
| 最小权限 | 子 Agent 无 message/spawn 工具 | 防止递归 spawn 和直接发消息绕过主 Agent | 通过配置文件控制权限（更灵活但更复杂） |
| 异步非阻塞 | asyncio.create_task 后立即返回 | 主 Agent 可继续处理新消息 | 线程池/进程池（更重但隔离更好） |
| 消息总线解耦 | 结果通过 MessageBus 回传 | 子 Agent 不直接依赖主 Agent 实例 | 回调函数（耦合度高） |
| 有限迭代 | max_iterations=15 | 防止子 Agent 陷入无限循环 | 超时机制（时间不可预测） |
| 共享 Provider | 子 Agent 复用主 Agent 的 LLMProvider | 避免重复初始化，统一模型配置 | 独立 Provider 实例（资源浪费） |

---

## 第 2 章 源码实现分析

### 2.1 架构概览

Nanobot 的子 Agent 编排采用 **主 Agent + N 个后台子 Agent** 的扇出模型，通过 MessageBus 实现异步通信：

```
┌─────────────────────────────────────────────────────────┐
│                     AgentLoop (主 Agent)                 │
│                                                         │
│  ToolRegistry                    SubagentManager        │
│  ┌──────────┐                   ┌──────────────┐        │
│  │ message  │                   │ _running_tasks│        │
│  │ spawn ───┼──────────────────→│ {id: Task}   │        │
│  │ read_file│                   └──────┬───────┘        │
│  │ exec     │                          │                │
│  │ web_*    │                   spawn()│                │
│  └──────────┘                          ▼                │
│                              asyncio.create_task()      │
│                                   │    │    │           │
│                                   ▼    ▼    ▼           │
│                              ┌────┐ ┌────┐ ┌────┐      │
│                              │Sub1│ │Sub2│ │Sub3│      │
│                              │    │ │    │ │    │      │
│                              │独立 │ │独立 │ │独立 │      │
│                              │Tool│ │Tool│ │Tool│      │
│                              │Reg │ │Reg │ │Reg │      │
│                              └──┬─┘ └──┬─┘ └──┬─┘      │
│                                 │      │      │         │
│                                 ▼      ▼      ▼         │
│                           bus.publish_inbound()         │
│                                     │                   │
│  ┌──────────┐                       │                   │
│  │MessageBus│◄──────────────────────┘                   │
│  │ inbound  │──→ _process_message() → 回复用户          │
│  │ outbound │                                           │
│  └──────────┘                                           │
└─────────────────────────────────────────────────────────┘
```

关键组件关系：
- `AgentLoop` 持有 `SubagentManager` 实例 (`loop.py:82-92`)
- `SpawnTool` 持有 `SubagentManager` 引用，作为 LLM 可调用的工具 (`loop.py:117`)
- `SubagentManager` 持有 `MessageBus` 引用，用于结果回传 (`subagent.py:44`)
- 子 Agent 的工具注册表是独立创建的，不共享主 Agent 的注册表 (`subagent.py:104`)

### 2.2 核心实现

#### 2.2.1 SubagentManager — 子 Agent 生命周期管理

`SubagentManager` 是整个编排系统的核心，负责 spawn、执行、结果回传三个阶段 (`subagent.py:20-257`)：

```python
# subagent.py:53-90 — spawn 方法：创建后台任务并立即返回
async def spawn(
    self,
    task: str,
    label: str | None = None,
    origin_channel: str = "cli",
    origin_chat_id: str = "direct",
) -> str:
    task_id = str(uuid.uuid4())[:8]
    display_label = label or task[:30] + ("..." if len(task) > 30 else "")

    origin = {
        "channel": origin_channel,
        "chat_id": origin_chat_id,
    }

    # 关键：asyncio.create_task 创建后台协程，不阻塞当前执行
    bg_task = asyncio.create_task(
        self._run_subagent(task_id, task, display_label, origin)
    )
    self._running_tasks[task_id] = bg_task

    # 任务完成时自动清理引用
    bg_task.add_done_callback(lambda _: self._running_tasks.pop(task_id, None))

    return f"Subagent [{display_label}] started (id: {task_id})..."
```

#### 2.2.2 工具隔离 — 子 Agent 的受限工具集

子 Agent 的工具注册是编排安全性的关键设计点 (`subagent.py:103-116`)：

```python
# subagent.py:103-116 — 子 Agent 工具注册：显式排除 message 和 spawn
async def _run_subagent(self, task_id, task, label, origin):
    # Build subagent tools (no message tool, no spawn tool)
    tools = ToolRegistry()
    allowed_dir = self.workspace if self.restrict_to_workspace else None
    tools.register(ReadFileTool(workspace=self.workspace, allowed_dir=allowed_dir))
    tools.register(WriteFileTool(workspace=self.workspace, allowed_dir=allowed_dir))
    tools.register(EditFileTool(workspace=self.workspace, allowed_dir=allowed_dir))
    tools.register(ListDirTool(workspace=self.workspace, allowed_dir=allowed_dir))
    tools.register(ExecTool(
        working_dir=str(self.workspace),
        timeout=self.exec_config.timeout,
        restrict_to_workspace=self.restrict_to_workspace,
    ))
    tools.register(WebSearchTool(api_key=self.brave_api_key))
    tools.register(WebFetchTool())
```

对比主 Agent 的工具注册 (`loop.py:104-119`)，主 Agent 额外注册了：
- `MessageTool` — 直接向用户发消息
- `SpawnTool` — 创建子 Agent
- `CronTool` — 定时任务

这种**显式白名单**策略比黑名单更安全：子 Agent 只能使用被明确授予的工具。

#### 2.2.3 MessageBus 结果回传

子 Agent 完成后，通过 MessageBus 将结果注入主 Agent 的消息队列 (`subagent.py:186-216`)：

```python
# subagent.py:186-216 — 结果通过 MessageBus 回传
async def _announce_result(self, task_id, label, task, result, origin, status):
    status_text = "completed successfully" if status == "ok" else "failed"

    announce_content = f"""[Subagent '{label}' {status_text}]
Task: {task}
Result:
{result}
Summarize this naturally for the user. Keep it brief (1-2 sentences)."""

    # 构造 InboundMessage，channel="system" 标识为系统消息
    msg = InboundMessage(
        channel="system",
        sender_id="subagent",
        chat_id=f"{origin['channel']}:{origin['chat_id']}",
        content=announce_content,
    )
    await self.bus.publish_inbound(msg)
```

主 Agent 在 `_process_message` 中对 `channel="system"` 的消息做特殊处理 (`loop.py:297-313`)：解析 `chat_id` 中编码的原始 channel:chat_id，构建上下文后调用 LLM 生成自然语言回复，再发送到原始频道。

#### 2.2.4 SpawnTool — LLM 调用入口

`SpawnTool` 是 LLM 可见的工具接口，将 LLM 的 function call 转发给 `SubagentManager` (`spawn.py:11-65`)：

```python
# spawn.py:58-65 — SpawnTool.execute 委托给 SubagentManager
async def execute(self, task: str, label: str | None = None, **kwargs) -> str:
    return await self._manager.spawn(
        task=task,
        label=label,
        origin_channel=self._origin_channel,
        origin_chat_id=self._origin_chat_id,
    )
```

`set_context` 方法在每次消息处理前被 `AgentLoop._set_tool_context` 调用 (`loop.py:149-151`)，确保子 Agent 的结果能回传到正确的频道。

### 2.3 实现细节

#### 数据流完整路径

```
用户消息 → MessageBus.inbound → AgentLoop._process_message()
  → LLM 决定调用 spawn(task="搜索论文")
  → SpawnTool.execute() → SubagentManager.spawn()
  → asyncio.create_task(_run_subagent())
  → 立即返回 "Subagent started..."
  → LLM 继续对话："好的，我已经在后台启动了搜索任务"

[后台] _run_subagent():
  → 创建独立 ToolRegistry（无 message/spawn）
  → 构建 subagent system prompt
  → 循环调用 LLM + 执行工具（最多 15 轮）
  → 获得 final_result
  → _announce_result() → bus.publish_inbound(InboundMessage)

[主循环] AgentLoop.run() 消费到 system 消息
  → _process_message(channel="system")
  → 解析 origin channel:chat_id
  → LLM 生成自然语言摘要
  → 发送到原始频道
```

#### 子 Agent System Prompt 设计

子 Agent 的 prompt 明确约束了行为边界 (`subagent.py:218-253`)：
- 只完成指定任务，不发起对话
- 不能发消息给用户（无 message 工具）
- 不能 spawn 其他子 Agent
- 不能访问主 Agent 的对话历史
- 完成后提供清晰的结果摘要

---

## 第 3 章 迁移指南

### 3.1 迁移清单

**阶段 1：基础设施（必须）**

- [ ] 实现 `MessageBus`：双向异步队列（inbound + outbound），用于主 Agent 与子 Agent 解耦通信
- [ ] 实现 `ToolRegistry`：工具注册/执行中心，支持动态注册和 JSON Schema 验证
- [ ] 实现 `Tool` 基类：统一的工具接口（name, description, parameters, execute）

**阶段 2：子 Agent 管理器（核心）**

- [ ] 实现 `SubagentManager`：管理子 Agent 的 spawn、执行、结果回传
- [ ] 实现 `SpawnTool`：将 spawn 能力暴露为 LLM 可调用的工具
- [ ] 配置子 Agent 的工具白名单（排除 message/spawn 防止递归）

**阶段 3：主循环集成**

- [ ] 在主 Agent 循环中注册 `SpawnTool`
- [ ] 处理 `channel="system"` 的回传消息，解析 origin 并生成自然语言回复
- [ ] 实现 `_set_tool_context` 在每次消息处理前更新 spawn 工具的 origin 信息

### 3.2 适配代码模板

以下是一个可直接运行的最小实现，提取了 Nanobot 的核心模式：

```python
"""最小可运行的 Spawn 子 Agent 编排模板"""
import asyncio
import uuid
from dataclasses import dataclass, field
from typing import Any, Callable, Awaitable

# --- 消息总线 ---
@dataclass
class Message:
    channel: str
    sender: str
    chat_id: str
    content: str

class MessageBus:
    def __init__(self):
        self.inbound: asyncio.Queue[Message] = asyncio.Queue()
        self.outbound: asyncio.Queue[Message] = asyncio.Queue()

    async def publish_inbound(self, msg: Message):
        await self.inbound.put(msg)

    async def publish_outbound(self, msg: Message):
        await self.outbound.put(msg)

# --- 工具基类 ---
class Tool:
    name: str = ""
    description: str = ""

    async def execute(self, **kwargs) -> str:
        raise NotImplementedError

# --- 子 Agent 管理器 ---
class SubagentManager:
    def __init__(self, llm_call: Callable, bus: MessageBus, tools_factory: Callable):
        self.llm_call = llm_call
        self.bus = bus
        self.tools_factory = tools_factory  # 返回子 Agent 可用的工具列表
        self._running: dict[str, asyncio.Task] = {}

    async def spawn(self, task: str, origin_channel: str, origin_chat_id: str) -> str:
        task_id = str(uuid.uuid4())[:8]
        bg = asyncio.create_task(self._run(task_id, task, origin_channel, origin_chat_id))
        self._running[task_id] = bg
        bg.add_done_callback(lambda _: self._running.pop(task_id, None))
        return f"Subagent started (id: {task_id})"

    async def _run(self, task_id: str, task: str, channel: str, chat_id: str):
        try:
            tools = self.tools_factory()  # 独立工具集，无 spawn/message
            result = await self._agent_loop(task, tools, max_iter=15)
            status = "ok"
        except Exception as e:
            result = f"Error: {e}"
            status = "error"

        # 通过 MessageBus 回传结果
        await self.bus.publish_inbound(Message(
            channel="system",
            sender="subagent",
            chat_id=f"{channel}:{chat_id}",
            content=f"[Subagent {status}] Task: {task}\nResult: {result}",
        ))

    async def _agent_loop(self, task: str, tools: list, max_iter: int) -> str:
        messages = [{"role": "user", "content": task}]
        for _ in range(max_iter):
            response = await self.llm_call(messages, tools)
            if response.get("tool_calls"):
                # 执行工具并追加结果到 messages
                for tc in response["tool_calls"]:
                    result = await self._exec_tool(tools, tc)
                    messages.append({"role": "tool", "content": result})
            else:
                return response.get("content", "Done")
        return "Max iterations reached"

    async def _exec_tool(self, tools: list, tool_call: dict) -> str:
        for t in tools:
            if t.name == tool_call["name"]:
                return await t.execute(**tool_call["arguments"])
        return f"Tool {tool_call['name']} not found"
```

### 3.3 适用场景

| 场景 | 适用度 | 说明 |
|------|--------|------|
| 聊天机器人后台任务 | ⭐⭐⭐ | 最佳场景：用户发消息触发后台搜索/分析，主 Agent 继续对话 |
| CLI 工具并行执行 | ⭐⭐⭐ | 适合：多个独立文件操作、Web 抓取等可并行任务 |
| 多步骤研究流程 | ⭐⭐ | 可用但有限：子 Agent 间无直接通信，需通过主 Agent 中转 |
| DAG 工作流编排 | ⭐ | 不适合：无依赖管理、无条件分支，需要更复杂的编排框架 |
| 长时间运行任务 | ⭐⭐ | 有 15 轮迭代限制，超长任务需调整 max_iterations |

---

## 第 4 章 测试用例

```python
"""测试 Nanobot Spawn 子 Agent 编排核心逻辑"""
import asyncio
import pytest
from unittest.mock import AsyncMock, MagicMock, patch
from dataclasses import dataclass


# --- 模拟依赖 ---
@dataclass
class MockToolCallRequest:
    id: str
    name: str
    arguments: dict

@dataclass
class MockLLMResponse:
    content: str | None
    tool_calls: list = None
    finish_reason: str = "stop"
    usage: dict = None
    reasoning_content: str | None = None

    def __post_init__(self):
        self.tool_calls = self.tool_calls or []
        self.usage = self.usage or {}

    @property
    def has_tool_calls(self):
        return len(self.tool_calls) > 0


class TestSubagentManager:
    """测试 SubagentManager 的 spawn 和执行逻辑"""

    @pytest.fixture
    def bus(self):
        bus = MagicMock()
        bus.publish_inbound = AsyncMock()
        return bus

    @pytest.fixture
    def provider(self):
        provider = MagicMock()
        provider.get_default_model.return_value = "test-model"
        # 默认返回无工具调用的响应（子 Agent 直接完成）
        provider.chat = AsyncMock(return_value=MockLLMResponse(
            content="Task completed: found 3 relevant papers"
        ))
        return provider

    @pytest.fixture
    def manager(self, provider, bus):
        from pathlib import Path
        # 注意：实际使用时需要 import SubagentManager
        # 这里模拟其核心行为
        manager = MagicMock()
        manager.provider = provider
        manager.bus = bus
        manager._running_tasks = {}
        return manager

    @pytest.mark.asyncio
    async def test_spawn_returns_immediately(self, bus, provider):
        """spawn 应立即返回确认消息，不等待子 Agent 完成"""
        from nanobot.agent.subagent import SubagentManager
        from pathlib import Path

        mgr = SubagentManager(
            provider=provider, workspace=Path("/tmp"),
            bus=bus, model="test-model",
        )
        result = await mgr.spawn(task="Search for papers", label="paper-search")
        assert "started" in result
        assert "paper-search" in result
        assert mgr.get_running_count() == 1

        # 等待后台任务完成
        await asyncio.sleep(0.1)

    @pytest.mark.asyncio
    async def test_result_published_to_bus(self, bus, provider):
        """子 Agent 完成后应通过 MessageBus 发布结果"""
        from nanobot.agent.subagent import SubagentManager
        from pathlib import Path

        mgr = SubagentManager(
            provider=provider, workspace=Path("/tmp"),
            bus=bus, model="test-model",
        )
        await mgr.spawn(
            task="Analyze code",
            origin_channel="telegram",
            origin_chat_id="user123",
        )
        # 等待后台任务完成
        await asyncio.sleep(0.5)

        bus.publish_inbound.assert_called_once()
        msg = bus.publish_inbound.call_args[0][0]
        assert msg.channel == "system"
        assert msg.sender_id == "subagent"
        assert msg.chat_id == "telegram:user123"
        assert "completed successfully" in msg.content

    @pytest.mark.asyncio
    async def test_subagent_tools_exclude_spawn_and_message(self):
        """子 Agent 的工具集不应包含 spawn 和 message"""
        from nanobot.agent.subagent import SubagentManager
        from nanobot.agent.tools.registry import ToolRegistry
        from pathlib import Path

        provider = MagicMock()
        provider.get_default_model.return_value = "test"
        provider.chat = AsyncMock(return_value=MockLLMResponse(content="done"))
        bus = MagicMock()
        bus.publish_inbound = AsyncMock()

        mgr = SubagentManager(
            provider=provider, workspace=Path("/tmp"),
            bus=bus, model="test",
        )
        # 通过检查 _run_subagent 中创建的 ToolRegistry 来验证
        # 子 Agent 的工具列表不包含 spawn 和 message
        await mgr.spawn(task="test task")
        await asyncio.sleep(0.5)

        # 验证 provider.chat 被调用时传入的 tools 不含 spawn/message
        call_args = provider.chat.call_args
        tools_defs = call_args.kwargs.get("tools") or call_args[1].get("tools", [])
        tool_names = [t["function"]["name"] for t in tools_defs]
        assert "spawn" not in tool_names
        assert "message" not in tool_names

    @pytest.mark.asyncio
    async def test_max_iterations_limit(self, bus):
        """子 Agent 应在达到最大迭代次数后停止"""
        from nanobot.agent.subagent import SubagentManager
        from pathlib import Path

        provider = MagicMock()
        provider.get_default_model.return_value = "test"
        # 始终返回工具调用，模拟无限循环
        provider.chat = AsyncMock(return_value=MockLLMResponse(
            content="thinking...",
            tool_calls=[MockToolCallRequest(id="1", name="read_file", arguments={"path": "/tmp/x"})],
        ))

        mgr = SubagentManager(
            provider=provider, workspace=Path("/tmp"),
            bus=bus, model="test",
        )
        await mgr.spawn(task="infinite task")
        await asyncio.sleep(1.0)

        # provider.chat 最多被调用 15 次（max_iterations）
        assert provider.chat.call_count <= 15

    @pytest.mark.asyncio
    async def test_error_handling(self, bus):
        """子 Agent 执行出错时应回传错误信息"""
        from nanobot.agent.subagent import SubagentManager
        from pathlib import Path

        provider = MagicMock()
        provider.get_default_model.return_value = "test"
        provider.chat = AsyncMock(side_effect=RuntimeError("API timeout"))

        mgr = SubagentManager(
            provider=provider, workspace=Path("/tmp"),
            bus=bus, model="test",
        )
        await mgr.spawn(task="failing task", origin_channel="cli", origin_chat_id="direct")
        await asyncio.sleep(0.5)

        bus.publish_inbound.assert_called_once()
        msg = bus.publish_inbound.call_args[0][0]
        assert "failed" in msg.content
        assert "API timeout" in msg.content
```

---

## 第 5 章 跨域关联

| 关联域 | 关系类型 | 说明 |
|--------|----------|------|
| PD-01 上下文管理 | 协同 | 子 Agent 拥有独立上下文（独立 messages 列表），不共享主 Agent 的对话历史。主 Agent 的 `memory_window` 控制历史长度，子 Agent 的 `max_iterations=15` 间接限制上下文增长 |
| PD-04 工具系统 | 依赖 | 子 Agent 编排强依赖 `ToolRegistry` 和 `Tool` 基类。工具隔离（白名单注册）是防止递归 spawn 的核心机制 |
| PD-06 记忆持久化 | 协同 | 子 Agent 的结果通过 MessageBus 回传后，被主 Agent 存入 session history，可被 `MemoryStore.consolidate()` 归档为长期记忆 |
| PD-09 Human-in-the-Loop | 互斥 | 子 Agent 无 message 工具，不能直接与用户交互。所有用户通信必须通过主 Agent 中转，这是有意的设计约束 |
| PD-03 容错与重试 | 协同 | 子 Agent 的 `_run_subagent` 有 try/except 包裹，错误时通过 `_announce_result(status="error")` 回传。但无重试机制，失败即终止 |
| PD-11 可观测性 | 协同 | 子 Agent 使用 loguru 记录 spawn/执行/完成/失败事件，但无独立的 token 计量或成本追踪 |

---

## 第 6 章 来源文件索引

| 文件 | 行范围 | 关键实现 |
|------|--------|----------|
| `nanobot/agent/subagent.py` | L1-257 | SubagentManager 完整实现：spawn、_run_subagent、_announce_result、_build_subagent_prompt |
| `nanobot/agent/tools/spawn.py` | L1-65 | SpawnTool：LLM 可调用的 spawn 工具接口 |
| `nanobot/agent/loop.py` | L34-438 | AgentLoop：主循环，SubagentManager 初始化(L82-92)、SpawnTool 注册(L117)、system 消息处理(L297-313) |
| `nanobot/bus/queue.py` | L1-45 | MessageBus：双向异步队列，子 Agent 结果回传通道 |
| `nanobot/bus/events.py` | L1-38 | InboundMessage/OutboundMessage 数据结构 |
| `nanobot/agent/tools/base.py` | L1-102 | Tool 抽象基类：name/description/parameters/execute 接口 |
| `nanobot/agent/tools/registry.py` | L1-73 | ToolRegistry：工具注册/执行中心 |
| `nanobot/agent/tools/message.py` | L1-108 | MessageTool：主 Agent 独有的消息发送工具（子 Agent 不可用） |
| `nanobot/agent/context.py` | L1-239 | ContextBuilder：系统 prompt 构建，子 Agent 使用简化版 prompt |
| `nanobot/providers/base.py` | L1-111 | LLMProvider/LLMResponse：子 Agent 共享主 Agent 的 provider 实例 |

---

## 第 7 章 横向对比维度

> 本章用于自动填充 Butcher Wiki 的横向对比表。

```json comparison_data
{
  "project": "Nanobot",
  "dimensions": {
    "编排模式": "Spawn-and-Forget：主 Agent 通过 spawn 工具异步派生子 Agent",
    "并行能力": "原生并行：asyncio.create_task 支持多个子 Agent 同时运行",
    "状态管理": "完全隔离：子 Agent 独立 messages 列表，不共享主 Agent 上下文",
    "并发限制": "无显式限制：_running_tasks 字典跟踪但不限制数量",
    "工具隔离": "白名单注册：子 Agent 显式排除 message/spawn 工具防止递归",
    "模块自治": "高自治：子 Agent 独立运行 15 轮循环，完成后通过 MessageBus 回传",
    "懒初始化": "按需创建：每次 spawn 创建新的 ToolRegistry 和 messages",
    "结果回传": "MessageBus 注入：结果作为 system 消息触发主 Agent 自然回复"
  }
}
```

### 域元数据补充

```json domain_metadata
{
  "description": "通过工具白名单和消息总线实现安全的异步子 Agent 派生与结果回传",
  "sub_problems": [
    "递归防护：如何防止子 Agent 无限 spawn 新的子 Agent",
    "结果自然化：子 Agent 结果如何转化为面向用户的自然语言回复"
  ],
  "best_practices": [
    "工具白名单优于黑名单：子 Agent 只注册被明确授予的工具，比排除危险工具更安全",
    "结果通过消息总线回传：避免子 Agent 直接持有主 Agent 引用，降低耦合"
  ]
}
```
