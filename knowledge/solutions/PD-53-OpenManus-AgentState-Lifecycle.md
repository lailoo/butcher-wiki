# PD-53.01 OpenManus — AgentState 四态生命周期管理

> 文档编号：PD-53.01
> 来源：OpenManus `app/schema.py` `app/agent/base.py` `app/agent/toolcall.py`
> GitHub：https://github.com/FoundationAgents/OpenManus.git
> 问题域：PD-53 Agent 状态机 Agent State Machine
> 状态：可复用方案

---

## 第 1 章 问题与动机

### 1.1 核心问题

Agent 在执行多步任务时，需要一个可靠的生命周期模型来回答三个关键问题：

1. **当前能做什么？** — Agent 处于 IDLE 才能接受新任务，处于 RUNNING 时不应被重入
2. **出错了怎么办？** — 异常发生时状态必须可观测（ERROR），且不能污染后续执行
3. **什么时候该停？** — 正常完成（FINISHED）、超步数限制、陷入循环，都需要明确的终止语义

没有状态机的 Agent 容易出现：重入执行导致消息混乱、异常后状态不一致无法恢复、无限循环消耗 token。

### 1.2 OpenManus 的解法概述

OpenManus 用一个极简的四态枚举 + asynccontextmanager 模式解决了上述问题：

1. **四态枚举 `AgentState`**（`app/schema.py:32-38`）：IDLE → RUNNING → FINISHED/ERROR，覆盖完整生命周期
2. **`state_context` 异步上下文管理器**（`app/agent/base.py:58-82`）：进入时设置新状态，异常时转 ERROR，finally 恢复前态
3. **IDLE 前置守卫**（`app/agent/base.py:128-129`）：`run()` 入口检查必须为 IDLE，防止重入
4. **多层终止信号**：子类通过直接赋值 `self.state = AgentState.FINISHED` 触发终止（`app/agent/toolcall.py:71,218`）
5. **循环检测 `is_stuck()`**（`app/agent/base.py:170-186`）：检测重复输出并注入策略变更提示

### 1.3 设计思想

| 设计原则 | 具体实现 | 理由 | 替代方案 |
|----------|----------|------|----------|
| 状态即枚举 | `AgentState(str, Enum)` 四个值 | str 枚举可序列化、可比较、IDE 友好 | 整数常量（不可读）、字符串字面量（无约束） |
| 上下文管理器守护转换 | `asynccontextmanager` + try/except/finally | 保证异常时状态可观测，finally 恢复前态 | 手动 try/finally（易遗漏）、装饰器（不够灵活） |
| 重入防护 | `run()` 入口 `if state != IDLE: raise` | 防止并发调用导致消息交错 | 锁机制（过重）、忽略（危险） |
| 子类自由终止 | 直接赋值 `self.state = FINISHED` | 简单直接，子类无需了解状态机内部 | 事件总线（过度设计）、回调（耦合） |
| 循环检测 | 比较最近 N 条 assistant 消息内容 | 低成本检测，不依赖外部工具 | embedding 相似度（成本高）、计时器（不精确） |

---

## 第 2 章 源码实现分析

### 2.1 架构概览

OpenManus 的状态机分布在三层继承体系中，每层负责不同的状态管理职责：

```
┌─────────────────────────────────────────────────────────┐
│                    AgentState (Enum)                     │
│            IDLE ──→ RUNNING ──→ FINISHED                │
│              ↑         │                                │
│              └── finally ←── ERROR ←── exception        │
└─────────────────────────────────────────────────────────┘
                          │
          ┌───────────────┼───────────────┐
          ▼               ▼               ▼
   ┌─────────────┐ ┌───────────┐ ┌──────────────┐
   │  BaseAgent   │ │ ReActAgent│ │ToolCallAgent │
   │              │ │           │ │              │
   │ state_context│ │ step()    │ │ think()→act()│
   │ run() loop   │ │ think+act │ │ FINISHED on  │
   │ is_stuck()   │ │           │ │ special tool │
   │ IDLE guard   │ │           │ │ cleanup()    │
   └──────┬───────┘ └─────┬────┘ └──────┬───────┘
          │               │              │
          │         ┌─────┴────┐   ┌─────┴──────┐
          │         │ MCPAgent │   │ Manus/SWE  │
          │         │ FINISHED │   │ max_steps  │
          │         │ on MCP   │   │ = 20       │
          │         │ shutdown │   └────────────┘
          │         └──────────┘
          │
   ┌──────┴───────┐
   │ PlanningFlow │
   │ checks       │
   │ executor     │
   │ .state ==    │
   │ FINISHED     │
   └──────────────┘
```

### 2.2 核心实现

#### 2.2.1 AgentState 枚举定义

`app/schema.py:32-38` — 四态枚举，继承 `str` 使其可直接序列化：

```python
class AgentState(str, Enum):
    """Agent execution states"""

    IDLE = "IDLE"
    RUNNING = "RUNNING"
    FINISHED = "FINISHED"
    ERROR = "ERROR"
```

关键设计：使用 `str` 作为基类，使枚举值可以直接用于 JSON 序列化和字符串比较，无需 `.value` 访问。Pydantic BaseModel 的 Field 直接接受该枚举作为默认值（`app/agent/base.py:35-37`）。

#### 2.2.2 state_context 异步上下文管理器

`app/agent/base.py:58-82` — 状态转换的核心守护机制：

```python
@asynccontextmanager
async def state_context(self, new_state: AgentState):
    if not isinstance(new_state, AgentState):
        raise ValueError(f"Invalid state: {new_state}")

    previous_state = self.state
    self.state = new_state
    try:
        yield
    except Exception as e:
        self.state = AgentState.ERROR  # Transition to ERROR on failure
        raise e
    finally:
        self.state = previous_state  # Revert to previous state
```

这段代码的状态转换语义：
- **进入**：保存 `previous_state`，立即切换到 `new_state`
- **异常**：先设为 ERROR（使异常期间状态可观测），然后 re-raise
- **finally**：无论成功还是异常，都恢复到 `previous_state`

注意一个微妙点：异常时 ERROR 状态只在 `except` 和 `finally` 之间短暂存在。finally 执行后状态回到 `previous_state`（通常是 IDLE）。这意味着 ERROR 是一个**瞬态**，不是终态——Agent 异常后可以被重新 `run()`。

#### 2.2.3 run() 主循环与 IDLE 守卫

`app/agent/base.py:116-154` — 执行入口，包含重入防护和步数限制：

```python
async def run(self, request: Optional[str] = None) -> str:
    if self.state != AgentState.IDLE:
        raise RuntimeError(f"Cannot run agent from state: {self.state}")

    if request:
        self.update_memory("user", request)

    results: List[str] = []
    async with self.state_context(AgentState.RUNNING):
        while (
            self.current_step < self.max_steps
            and self.state != AgentState.FINISHED
        ):
            self.current_step += 1
            logger.info(f"Executing step {self.current_step}/{self.max_steps}")
            step_result = await self.step()

            if self.is_stuck():
                self.handle_stuck_state()

            results.append(f"Step {self.current_step}: {step_result}")

        if self.current_step >= self.max_steps:
            self.current_step = 0
            self.state = AgentState.IDLE
            results.append(f"Terminated: Reached max steps ({self.max_steps})")
    await SANDBOX_CLIENT.cleanup()
    return "\n".join(results) if results else "No steps executed"
```

循环终止条件有两个：`current_step < max_steps`（步数限制）和 `state != FINISHED`（子类主动终止）。while 循环内部，子类的 `step()` 实现可以随时将 `self.state` 设为 `FINISHED` 来中断循环。

不同 Agent 子类的 `max_steps` 配置差异显著：
- `BaseAgent` 默认 10 步（`app/agent/base.py:40`）
- `ReActAgent` 默认 10 步（`app/agent/react.py:22`）
- `ToolCallAgent` 覆盖为 30 步（`app/agent/toolcall.py:36`）
- `Manus`/`SWE`/`MCPAgent` 等覆盖为 20 步

#### 2.2.4 循环检测与策略注入

`app/agent/base.py:170-186` — 通过比较最近消息内容检测重复：

```python
def is_stuck(self) -> bool:
    """Check if the agent is stuck in a loop by detecting duplicate content"""
    if len(self.memory.messages) < 2:
        return False

    last_message = self.memory.messages[-1]
    if not last_message.content:
        return False

    # Count identical content occurrences
    duplicate_count = sum(
        1
        for msg in reversed(self.memory.messages[:-1])
        if msg.role == "assistant" and msg.content == last_message.content
    )

    return duplicate_count >= self.duplicate_threshold
```

`duplicate_threshold` 默认为 2（`app/agent/base.py:43`），即同一内容出现 3 次（当前 1 次 + 历史 2 次）才判定为卡住。

检测到卡住后，`handle_stuck_state()`（`app/agent/base.py:163-168`）将策略变更提示**前置拼接**到 `next_step_prompt`：

```python
def handle_stuck_state(self):
    stuck_prompt = "Observed duplicate responses. Consider new strategies..."
    self.next_step_prompt = f"{stuck_prompt}\n{self.next_step_prompt}"
```

这是一个**累积式**设计——每次检测到卡住都会在 prompt 前面追加提示，不会覆盖之前的。

#### 2.2.5 子类终止信号：ToolCallAgent 的多路径 FINISHED

`ToolCallAgent` 有两个路径可以触发 FINISHED：

**路径 1 — Token 限制**（`app/agent/toolcall.py:60-72`）：
当 LLM 调用抛出 `TokenLimitExceeded`（包括被 RetryError 包裹的情况），直接设置 FINISHED 并返回 False：

```python
if hasattr(e, "__cause__") and isinstance(e.__cause__, TokenLimitExceeded):
    self.memory.add_message(
        Message.assistant_message(
            f"Maximum token limit reached, cannot continue execution: {str(token_limit_error)}"
        )
    )
    self.state = AgentState.FINISHED
    return False
```

**路径 2 — 特殊工具触发**（`app/agent/toolcall.py:210-218`）：
当执行的工具名在 `special_tool_names` 列表中（默认包含 `Terminate`），调用 `_handle_special_tool` 设置 FINISHED：

```python
async def _handle_special_tool(self, name: str, result: Any, **kwargs):
    if not self._is_special_tool(name):
        return
    if self._should_finish_execution(name=name, result=result, **kwargs):
        logger.info(f"🏁 Special tool '{name}' has completed the task!")
        self.state = AgentState.FINISHED
```

#### 2.2.6 资源清理：ToolCallAgent.cleanup()

`app/agent/toolcall.py:229-243` — 遍历所有工具实例，调用其 `cleanup()` 方法：

```python
async def cleanup(self):
    for tool_name, tool_instance in self.available_tools.tool_map.items():
        if hasattr(tool_instance, "cleanup") and asyncio.iscoroutinefunction(
            tool_instance.cleanup
        ):
            try:
                await tool_instance.cleanup()
            except Exception as e:
                logger.error(f"Error cleaning up tool '{tool_name}': {e}", exc_info=True)
```

`run()` 方法通过 `try/finally` 确保 cleanup 一定执行（`app/agent/toolcall.py:245-250`）。
`BaseAgent.run()` 也在循环结束后调用 `SANDBOX_CLIENT.cleanup()`（`app/agent/base.py:153`）。

### 2.3 实现细节

#### 状态转换全景图

```
                    ┌──────────────────────────────────────────┐
                    │           BaseAgent.run()                │
                    │                                          │
  run(request) ────→│  [1] IDLE guard: state != IDLE → raise   │
                    │  [2] state_context(RUNNING) enter        │
                    │       ┌─────────────────────────────┐    │
                    │       │  while loop                 │    │
                    │       │  ├─ step()                  │    │
                    │       │  │   └─ think() → act()     │    │
                    │       │  │       ├─ TokenLimit →     │    │
                    │       │  │       │  FINISHED [A]     │    │
                    │       │  │       └─ special tool →   │    │
                    │       │  │          FINISHED [B]     │    │
                    │       │  ├─ is_stuck() check         │    │
                    │       │  │   └─ inject stuck prompt  │    │
                    │       │  └─ break if FINISHED        │    │
                    │       │      or max_steps reached    │    │
                    │       └─────────────────────────────┘    │
                    │  [3] max_steps → reset step, IDLE        │
                    │  [4] state_context finally → restore     │
                    │  [5] SANDBOX_CLIENT.cleanup()             │
                    │  [6] ToolCallAgent.cleanup() (finally)    │
                    └──────────────────────────────────────────┘
```

#### Flow 层的状态检查

`PlanningFlow`（`app/flow/planning.py:128`）在执行每个计划步骤后检查 executor 的状态：

```python
if hasattr(executor, "state") and executor.state == AgentState.FINISHED:
    break
```

这使得 Flow 编排层可以感知 Agent 的终止信号，实现跨层状态传播。

#### MCPAgent 的额外终止路径

`MCPAgent`（`app/agent/mcp.py:134-149`）在 `think()` 中增加了 MCP 服务可用性检查：
- MCP session 断开 → FINISHED
- 工具列表为空（服务关闭）→ FINISHED

这是对基类状态机的**扩展**，不是修改——通过在 `think()` 中提前设置 FINISHED，利用基类 while 循环的退出条件自然终止。

---

## 第 3 章 迁移指南

### 3.1 迁移清单

**阶段 1：核心状态枚举（必须）**
- [ ] 定义 `AgentState(str, Enum)` 四态枚举
- [ ] 在 Agent 基类中添加 `state` 字段，默认 IDLE

**阶段 2：状态转换守护（必须）**
- [ ] 实现 `state_context` asynccontextmanager
- [ ] 在 `run()` 入口添加 IDLE 守卫
- [ ] 在 `run()` 中用 `async with state_context(RUNNING)` 包裹主循环

**阶段 3：终止机制（必须）**
- [ ] 实现 `max_steps` 步数限制
- [ ] 子类通过 `self.state = FINISHED` 触发终止
- [ ] 处理 token 限制等异常情况的终止

**阶段 4：循环检测（推荐）**
- [ ] 实现 `is_stuck()` 重复消息检测
- [ ] 实现 `handle_stuck_state()` 策略注入

**阶段 5：资源清理（推荐）**
- [ ] 在 `run()` 的 finally 块中调用 cleanup
- [ ] 遍历工具实例逐个清理，捕获单个工具的异常不影响其他

### 3.2 适配代码模板

以下是一个可直接运行的最小实现，提取了 OpenManus 状态机的核心模式：

```python
import asyncio
from abc import ABC, abstractmethod
from contextlib import asynccontextmanager
from enum import Enum
from typing import List, Optional


class AgentState(str, Enum):
    IDLE = "IDLE"
    RUNNING = "RUNNING"
    FINISHED = "FINISHED"
    ERROR = "ERROR"


class StatefulAgent(ABC):
    """Minimal agent with OpenManus-style state machine."""

    def __init__(
        self,
        name: str,
        max_steps: int = 10,
        duplicate_threshold: int = 2,
    ):
        self.name = name
        self.state = AgentState.IDLE
        self.max_steps = max_steps
        self.current_step = 0
        self.duplicate_threshold = duplicate_threshold
        self._history: List[str] = []

    @asynccontextmanager
    async def state_context(self, new_state: AgentState):
        """Safe state transition with automatic rollback."""
        if not isinstance(new_state, AgentState):
            raise ValueError(f"Invalid state: {new_state}")
        previous_state = self.state
        self.state = new_state
        try:
            yield
        except Exception:
            self.state = AgentState.ERROR
            raise
        finally:
            self.state = previous_state

    def is_stuck(self) -> bool:
        """Detect repeated outputs."""
        if len(self._history) < 2:
            return False
        last = self._history[-1]
        count = sum(1 for h in self._history[:-1] if h == last)
        return count >= self.duplicate_threshold

    def handle_stuck_state(self):
        """Inject strategy change hint (override in subclass)."""
        pass  # Subclass can modify next prompt

    async def run(self, request: Optional[str] = None) -> str:
        if self.state != AgentState.IDLE:
            raise RuntimeError(f"Cannot run from state: {self.state}")

        results: List[str] = []
        async with self.state_context(AgentState.RUNNING):
            while (
                self.current_step < self.max_steps
                and self.state != AgentState.FINISHED
            ):
                self.current_step += 1
                result = await self.step()
                self._history.append(result)

                if self.is_stuck():
                    self.handle_stuck_state()

                results.append(result)

            if self.current_step >= self.max_steps:
                self.current_step = 0
                results.append(f"Terminated: max steps ({self.max_steps})")

        return "\n".join(results)

    @abstractmethod
    async def step(self) -> str:
        """Single execution step. Set self.state = FINISHED to stop."""
        ...
```

### 3.3 适用场景

| 场景 | 适用度 | 说明 |
|------|--------|------|
| 单 Agent 多步任务执行 | ⭐⭐⭐ | 核心场景，状态机保证执行安全 |
| 多 Agent 编排中的子 Agent | ⭐⭐⭐ | Flow 层可通过检查 state 感知子 Agent 终止 |
| 需要重入防护的 Agent | ⭐⭐⭐ | IDLE 守卫天然防止并发调用 |
| 需要优雅降级的长任务 | ⭐⭐ | max_steps + token limit 提供两层保护 |
| 需要持久化状态的 Agent | ⭐ | 当前设计是内存态，需额外实现序列化 |
| 需要复杂状态转换规则的场景 | ⭐ | 四态模型较简单，复杂场景需扩展 |

---

## 第 4 章 测试用例

```python
import asyncio
import pytest
from enum import Enum
from contextlib import asynccontextmanager
from typing import List, Optional


# --- 被测代码（从 OpenManus 提取的核心逻辑） ---

class AgentState(str, Enum):
    IDLE = "IDLE"
    RUNNING = "RUNNING"
    FINISHED = "FINISHED"
    ERROR = "ERROR"


class MockAgent:
    """Minimal agent reproducing OpenManus BaseAgent state logic."""

    def __init__(self, max_steps=10, duplicate_threshold=2):
        self.state = AgentState.IDLE
        self.max_steps = max_steps
        self.current_step = 0
        self.duplicate_threshold = duplicate_threshold
        self.messages: List[str] = []
        self.stuck_handled = False

    @asynccontextmanager
    async def state_context(self, new_state: AgentState):
        if not isinstance(new_state, AgentState):
            raise ValueError(f"Invalid state: {new_state}")
        previous_state = self.state
        self.state = new_state
        try:
            yield
        except Exception:
            self.state = AgentState.ERROR
            raise
        finally:
            self.state = previous_state

    def is_stuck(self) -> bool:
        if len(self.messages) < 2:
            return False
        last = self.messages[-1]
        count = sum(1 for m in self.messages[:-1] if m == last)
        return count >= self.duplicate_threshold

    def handle_stuck_state(self):
        self.stuck_handled = True


# --- 测试用例 ---

class TestAgentState:
    def test_enum_values(self):
        assert AgentState.IDLE == "IDLE"
        assert AgentState.RUNNING == "RUNNING"
        assert AgentState.FINISHED == "FINISHED"
        assert AgentState.ERROR == "ERROR"

    def test_str_serialization(self):
        """AgentState inherits str, so it serializes directly."""
        import json
        data = {"state": AgentState.RUNNING}
        assert json.dumps(data) == '{"state": "RUNNING"}'


class TestStateContext:
    @pytest.mark.asyncio
    async def test_normal_transition(self):
        agent = MockAgent()
        assert agent.state == AgentState.IDLE
        async with agent.state_context(AgentState.RUNNING):
            assert agent.state == AgentState.RUNNING
        assert agent.state == AgentState.IDLE  # Restored

    @pytest.mark.asyncio
    async def test_error_transition(self):
        agent = MockAgent()
        with pytest.raises(RuntimeError):
            async with agent.state_context(AgentState.RUNNING):
                assert agent.state == AgentState.RUNNING
                raise RuntimeError("test error")
        # After exception, state is restored to previous (IDLE)
        assert agent.state == AgentState.IDLE

    @pytest.mark.asyncio
    async def test_invalid_state_rejected(self):
        agent = MockAgent()
        with pytest.raises(ValueError, match="Invalid state"):
            async with agent.state_context("INVALID"):  # type: ignore
                pass

    @pytest.mark.asyncio
    async def test_nested_context(self):
        """Verify nested state_context restores correctly."""
        agent = MockAgent()
        async with agent.state_context(AgentState.RUNNING):
            assert agent.state == AgentState.RUNNING
            # Nested context (e.g., sub-operation)
            async with agent.state_context(AgentState.FINISHED):
                assert agent.state == AgentState.FINISHED
            assert agent.state == AgentState.RUNNING
        assert agent.state == AgentState.IDLE


class TestStuckDetection:
    def test_not_stuck_with_few_messages(self):
        agent = MockAgent()
        agent.messages = ["hello"]
        assert agent.is_stuck() is False

    def test_not_stuck_with_different_messages(self):
        agent = MockAgent()
        agent.messages = ["a", "b", "c"]
        assert agent.is_stuck() is False

    def test_stuck_when_threshold_reached(self):
        agent = MockAgent(duplicate_threshold=2)
        agent.messages = ["same", "same", "same"]
        assert agent.is_stuck() is True

    def test_not_stuck_below_threshold(self):
        agent = MockAgent(duplicate_threshold=2)
        agent.messages = ["same", "same"]
        assert agent.is_stuck() is False

    def test_handle_stuck_called(self):
        agent = MockAgent(duplicate_threshold=1)
        agent.messages = ["dup", "dup"]
        assert agent.is_stuck() is True
        agent.handle_stuck_state()
        assert agent.stuck_handled is True
```

---

## 第 5 章 跨域关联

| 关联域 | 关系类型 | 说明 |
|--------|----------|------|
| PD-01 上下文管理 | 协同 | Memory 的 `max_messages` 滑动窗口（`app/schema.py:162-168`）是上下文管理的一部分，状态机的 `is_stuck()` 依赖 memory 中的消息历史 |
| PD-03 容错与重试 | 依赖 | `state_context` 的异常处理是容错的基础；`TokenLimitExceeded` 的捕获和优雅终止属于容错策略 |
| PD-04 工具系统 | 协同 | `ToolCallAgent` 的 `special_tool_names` 机制将工具执行结果与状态转换关联；`cleanup()` 遍历工具实例进行资源清理 |
| PD-02 多 Agent 编排 | 协同 | `PlanningFlow` 通过检查 `executor.state == FINISHED` 实现跨层状态传播，编排层依赖 Agent 状态机的终止信号 |
| PD-05 沙箱隔离 | 协同 | `BaseAgent.run()` 结束时调用 `SANDBOX_CLIENT.cleanup()`，状态机的生命周期管理与沙箱资源清理绑定 |

---

## 第 6 章 来源文件索引

| 文件 | 行范围 | 关键实现 |
|------|--------|----------|
| `app/schema.py` | L32-38 | `AgentState` 四态枚举定义 |
| `app/schema.py` | L159-187 | `Memory` 类，滑动窗口消息管理 |
| `app/agent/base.py` | L13-47 | `BaseAgent` 类定义，state/max_steps/duplicate_threshold 字段 |
| `app/agent/base.py` | L58-82 | `state_context` asynccontextmanager |
| `app/agent/base.py` | L116-154 | `run()` 主循环，IDLE 守卫 + 步数限制 + 沙箱清理 |
| `app/agent/base.py` | L163-186 | `is_stuck()` + `handle_stuck_state()` 循环检测 |
| `app/agent/react.py` | L11-38 | `ReActAgent`，think/act 分离的 step 实现 |
| `app/agent/toolcall.py` | L39-73 | `think()` 中 TokenLimitExceeded → FINISHED |
| `app/agent/toolcall.py` | L210-228 | `_handle_special_tool` 特殊工具触发 FINISHED |
| `app/agent/toolcall.py` | L229-250 | `cleanup()` 工具资源清理 + run() finally |
| `app/agent/mcp.py` | L134-149 | MCPAgent 的 MCP 服务可用性检查 → FINISHED |
| `app/flow/planning.py` | L128 | PlanningFlow 检查 executor.state == FINISHED |
| `app/exceptions.py` | L8-13 | `TokenLimitExceeded` 异常定义 |

---

## 第 7 章 横向对比维度

```json comparison_data
{
  "project": "OpenManus",
  "dimensions": {
    "状态模型": "4 态 str 枚举（IDLE/RUNNING/FINISHED/ERROR），ERROR 为瞬态非终态",
    "转换守护": "asynccontextmanager + try/except/finally，异常时 ERROR 后自动恢复前态",
    "重入防护": "run() 入口 IDLE 守卫，非 IDLE 直接 raise RuntimeError",
    "终止信号": "子类直接赋值 self.state=FINISHED，多路径：special tool / token limit / max_steps",
    "循环检测": "精确字符串匹配最近 N 条 assistant 消息，threshold=2，累积式 prompt 注入",
    "资源清理": "两层清理：ToolCallAgent 遍历工具 cleanup + BaseAgent 调用 SANDBOX_CLIENT.cleanup"
  }
}
```

### 域元数据补充

```json domain_metadata
{
  "solution_summary": "OpenManus 用 4 态 str 枚举 + asynccontextmanager 守护状态转换，ERROR 为瞬态自动恢复，子类通过直接赋值 FINISHED 触发多路径终止",
  "description": "Agent 执行生命周期的状态建模、转换守护与异常恢复",
  "sub_problems": [
    "多路径终止信号协调",
    "跨层状态传播（Flow→Agent）",
    "步数限制与 token 限制双重保护"
  ],
  "best_practices": [
    "str 枚举使状态值可直接 JSON 序列化",
    "run() 入口 IDLE 守卫防止重入",
    "两层资源清理：工具级 + 沙箱级"
  ]
}
```
