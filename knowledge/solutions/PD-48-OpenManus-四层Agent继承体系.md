# PD-48.01 OpenManus — 四层 Agent 继承体系

> 文档编号：PD-48.01
> 来源：OpenManus `app/agent/base.py`, `app/agent/react.py`, `app/agent/toolcall.py`, `app/agent/manus.py`
> GitHub：https://github.com/FoundationAgents/OpenManus.git
> 问题域：PD-48 Agent 继承体系 Agent Inheritance Hierarchy
> 状态：可复用方案

---

## 第 1 章 问题与动机

### 1.1 核心问题

构建 Agent 系统时，不同类型的 Agent（浏览器操控、代码编写、数据分析、通用对话）共享大量基础能力（状态管理、记忆、LLM 调用），但又各自需要特定的工具集和行为逻辑。如果每个 Agent 独立实现全部功能，会导致：

- **代码重复**：状态机、执行循环、记忆管理在每个 Agent 中重复编写
- **行为不一致**：不同 Agent 对相同基础能力（如卡死检测、步数限制）的实现可能不同
- **扩展困难**：新增 Agent 类型需要从零开始，无法复用已有能力
- **维护成本高**：修复基础能力的 bug 需要在多处同步修改

核心挑战是：如何设计一个 Agent 能力体系，使得基础能力可复用、新 Agent 类型可快速组装、领域特化可灵活扩展？

### 1.2 OpenManus 的解法概述

OpenManus 构建了 **BaseAgent → ReActAgent → ToolCallAgent → 领域 Agent** 四层继承体系，每层严格只添加一个核心能力：

1. **BaseAgent**（`app/agent/base.py:13`）：Pydantic BaseModel + ABC，提供状态机、记忆管理、执行循环、卡死检测
2. **ReActAgent**（`app/agent/react.py:11`）：定义 think→act 双阶段抽象，将 `step()` 分解为思考和行动
3. **ToolCallAgent**（`app/agent/toolcall.py:18`）：实现 LLM tool calling 协议，管理工具集合、执行工具调用、处理特殊工具
4. **领域 Agent**（Manus/Browser/SWE/DataAnalysis/MCP）：声明式配置 prompt + 工具集，覆盖特定行为

### 1.3 设计思想

| 设计原则 | 具体实现 | 理由 | 替代方案 |
|----------|----------|------|----------|
| 单一职责分层 | 每层只添加一个核心能力（状态→ReAct→工具→领域） | 降低单层复杂度，便于独立测试和替换 | 扁平 mixin 组合（灵活但依赖关系混乱） |
| Pydantic 声明式配置 | Agent 属性用 `Field()` 声明，子类覆盖默认值即可特化 | 领域 Agent 只需 ~30 行声明即可创建 | 构造函数参数传递（冗长且易出错） |
| 模板方法模式 | `run()` 定义执行骨架，`step()`/`think()`/`act()` 由子类实现 | 保证执行流程一致性，子类只关注决策逻辑 | 策略模式（需要额外的策略对象管理） |
| 异步上下文状态管理 | `state_context()` 用 asynccontextmanager 保证状态安全转换 | 异常时自动回滚状态，避免状态泄漏 | 手动 try/finally（容易遗漏） |
| 工具集合组合 | `ToolCollection` 作为工具容器，领域 Agent 声明式组装 | 工具可热插拔，MCP 工具可动态添加 | 硬编码工具列表（无法运行时扩展） |

---

## 第 2 章 源码实现分析

### 2.1 架构概览

```
┌─────────────────────────────────────────────────────────────────┐
│                    BaseAgent (ABC + BaseModel)                   │
│  app/agent/base.py:13                                           │
│  ┌─────────────┐ ┌──────────┐ ┌───────────┐ ┌───────────────┐  │
│  │ AgentState   │ │ Memory   │ │ LLM       │ │ run() loop    │  │
│  │ IDLE→RUNNING │ │ messages │ │ instance  │ │ + is_stuck()  │  │
│  │ →FINISHED    │ │ max=100  │ │           │ │ + state_ctx   │  │
│  └─────────────┘ └──────────┘ └───────────┘ └───────────────┘  │
├─────────────────────────────────────────────────────────────────┤
│                    ReActAgent (ABC)                              │
│  app/agent/react.py:11                                          │
│  ┌──────────────────────────────────────────┐                   │
│  │ step() = think() → act()                 │                   │
│  │ 将单步执行分解为"思考"和"行动"两阶段         │                   │
│  └──────────────────────────────────────────┘                   │
├─────────────────────────────────────────────────────────────────┤
│                    ToolCallAgent                                 │
│  app/agent/toolcall.py:18                                       │
│  ┌──────────────┐ ┌──────────────┐ ┌────────────────────────┐  │
│  │ think():     │ │ act():       │ │ execute_tool():        │  │
│  │ LLM ask_tool │ │ iterate      │ │ parse JSON args        │  │
│  │ → tool_calls │ │ tool_calls   │ │ → tool.execute()       │  │
│  │ → memory     │ │ → execute    │ │ → handle_special_tool  │  │
│  └──────────────┘ └──────────────┘ └────────────────────────┘  │
│  ┌──────────────────┐ ┌─────────────────┐                      │
│  │ ToolCollection   │ │ special_tools   │                      │
│  │ available_tools  │ │ (Terminate等)    │                      │
│  └──────────────────┘ └─────────────────┘                      │
├──────────┬──────────┬──────────┬──────────┬────────────────────┤
│  Manus   │ Browser  │   SWE    │DataAnalys│    MCPAgent        │
│ 通用Agent │ 浏览器    │ 代码编写  │ 数据分析  │   MCP协议Agent     │
│ +MCP支持  │ +截图状态 │ +Bash    │ +可视化   │   +动态工具发现     │
└──────────┴──────────┴──────────┴──────────┴────────────────────┘
```

### 2.2 核心实现

#### 2.2.1 第一层：BaseAgent — 状态机 + 执行循环

BaseAgent（`app/agent/base.py:13-197`）继承 `BaseModel` 和 `ABC`，是整个体系的根基。核心设计：

**状态机**使用枚举 `AgentState`（`app/schema.py:32-38`）定义四态：IDLE → RUNNING → FINISHED / ERROR。状态转换通过异步上下文管理器保证安全：

```python
# app/agent/base.py:58-82
@asynccontextmanager
async def state_context(self, new_state: AgentState):
    if not isinstance(new_state, AgentState):
        raise ValueError(f"Invalid state: {new_state}")
    previous_state = self.state
    self.state = new_state
    try:
        yield
    except Exception as e:
        self.state = AgentState.ERROR
        raise e
    finally:
        self.state = previous_state
```

**执行循环**（`app/agent/base.py:116-154`）是模板方法的核心骨架：`run()` 驱动 `step()` 循环，内置步数限制和卡死检测。`step()` 是抽象方法，由子类实现。

**卡死检测**（`app/agent/base.py:170-186`）通过比较最近消息内容检测重复输出，超过 `duplicate_threshold`（默认 2）则注入策略变更提示：

```python
# app/agent/base.py:170-186
def is_stuck(self) -> bool:
    if len(self.memory.messages) < 2:
        return False
    last_message = self.memory.messages[-1]
    if not last_message.content:
        return False
    duplicate_count = sum(
        1 for msg in reversed(self.memory.messages[:-1])
        if msg.role == "assistant" and msg.content == last_message.content
    )
    return duplicate_count >= self.duplicate_threshold
```

#### 2.2.2 第二层：ReActAgent — Think-Act 双阶段抽象

ReActAgent（`app/agent/react.py:11-38`）是整个体系中最精简的一层，仅 28 行代码，职责单一：将 `step()` 分解为 `think()` + `act()` 两个抽象方法。

```python
# app/agent/react.py:11-38
class ReActAgent(BaseAgent, ABC):
    name: str
    description: Optional[str] = None
    system_prompt: Optional[str] = None
    next_step_prompt: Optional[str] = None
    llm: Optional[LLM] = Field(default_factory=LLM)
    memory: Memory = Field(default_factory=Memory)
    state: AgentState = AgentState.IDLE
    max_steps: int = 10
    current_step: int = 0

    @abstractmethod
    async def think(self) -> bool:
        """Process current state and decide next action"""

    @abstractmethod
    async def act(self) -> str:
        """Execute decided actions"""

    async def step(self) -> str:
        """Execute a single step: think and act."""
        should_act = await self.think()
        if not should_act:
            return "Thinking complete - no action needed"
        return await self.act()
```

关键设计：`think()` 返回 `bool` 控制是否执行 `act()`。这使得 Agent 可以在思考阶段就决定终止（如 token 超限），无需进入行动阶段。

#### 2.2.3 第三层：ToolCallAgent — LLM Tool Calling 协议

ToolCallAgent（`app/agent/toolcall.py:18-251`）是能力最密集的一层，实现了完整的 LLM 工具调用协议：

**think() 实现**（`app/agent/toolcall.py:39-129`）：调用 `llm.ask_tool()` 获取工具调用决策，处理三种 `tool_choices` 模式（NONE/AUTO/REQUIRED），并内置 TokenLimitExceeded 异常处理实现优雅降级。

**act() 实现**（`app/agent/toolcall.py:131-164`）：遍历 `tool_calls` 列表，逐个执行工具并收集结果。支持 `max_observe` 截断过长输出，支持 `base64_image` 多模态结果。

**execute_tool()**（`app/agent/toolcall.py:166-208`）：单个工具执行的完整流程——JSON 参数解析 → 工具执行 → 特殊工具处理 → 结果格式化。错误处理覆盖 JSON 解析失败和工具执行异常。

**特殊工具机制**（`app/agent/toolcall.py:210-227`）：`special_tool_names` 列表定义触发状态转换的工具（如 Terminate），执行后将 Agent 状态设为 FINISHED。子类可覆盖 `_should_finish_execution()` 自定义终止条件。

**资源清理**（`app/agent/toolcall.py:229-250`）：覆盖 `run()` 方法，在 `finally` 块中调用 `cleanup()` 遍历所有工具执行清理。

#### 2.2.4 第四层：领域 Agent — 声明式特化

领域 Agent 通过覆盖 Pydantic Field 默认值实现特化，代码极其精简：

**SWEAgent**（`app/agent/swe.py:10-24`）仅 15 行，声明 Bash + StrReplaceEditor + Terminate 工具集：

```python
# app/agent/swe.py:10-24
class SWEAgent(ToolCallAgent):
    name: str = "swe"
    description: str = "an autonomous AI programmer..."
    system_prompt: str = SYSTEM_PROMPT
    next_step_prompt: str = ""
    available_tools: ToolCollection = ToolCollection(
        Bash(), StrReplaceEditor(), Terminate()
    )
    special_tool_names: List[str] = Field(default_factory=lambda: [Terminate().name])
    max_steps: int = 20
```

**DataAnalysis**（`app/agent/data_analysis.py:12-37`）同样精简，声明 Python 执行 + 可视化工具集。

**BrowserAgent**（`app/agent/browser.py:87-130`）稍复杂，覆盖 `think()` 注入浏览器状态上下文，使用 `BrowserContextHelper` 辅助类获取页面截图和 DOM 状态。

**Manus**（`app/agent/manus.py:18-166`）是最复杂的领域 Agent，额外支持：
- MCP 服务器动态连接/断开（`connect_mcp_server`/`disconnect_mcp_server`）
- 异步工厂方法 `create()` 处理 MCP 初始化
- 覆盖 `think()` 根据浏览器使用状态动态切换 prompt

**MCPAgent**（`app/agent/mcp.py:13-186`）专注 MCP 协议，覆盖 `think()` 添加工具刷新逻辑，覆盖 `_should_finish_execution()` 自定义终止条件。

### 2.3 实现细节

**Pydantic Config 的关键配置**（`app/agent/base.py:45-47`）：

```python
class Config:
    arbitrary_types_allowed = True  # 允许 LLM、Memory 等非标准类型
    extra = "allow"                 # 允许子类添加额外字段
```

`extra = "allow"` 是继承体系的关键——它允许子类自由添加新字段（如 Manus 的 `mcp_clients`、`connected_servers`），无需修改基类。

**Memory 的滑动窗口**（`app/schema.py:159-168`）：`max_messages=100`，超出时保留最近 100 条。这是隐式的上下文管理策略。

**model_validator 初始化链**：每层都可以用 `@model_validator(mode="after")` 添加初始化逻辑。BaseAgent 初始化 LLM 和 Memory（`base.py:49-56`），Manus 初始化 BrowserContextHelper（`manus.py:53-57`），形成初始化链。

**ToolCollection 的动态扩展**（`app/tool/tool_collection.py:51-71`）：`add_tool()`/`add_tools()` 支持运行时添加工具，Manus 利用此能力动态注册 MCP 工具。工具名冲突时跳过并警告，保证幂等性。

---

## 第 3 章 迁移指南

### 3.1 迁移清单

**阶段一：基础框架（必须）**

- [ ] 定义 `AgentState` 枚举（IDLE/RUNNING/FINISHED/ERROR）
- [ ] 实现 `BaseAgent`：Pydantic BaseModel + ABC，包含状态机、Memory、LLM、执行循环
- [ ] 实现 `state_context()` 异步上下文管理器
- [ ] 实现卡死检测 `is_stuck()` + `handle_stuck_state()`

**阶段二：ReAct 层（必须）**

- [ ] 实现 `ReActAgent`：定义 `think()` → `act()` 抽象接口
- [ ] 实现 `step()` 模板方法：`think()` 返回 False 则跳过 `act()`

**阶段三：工具调用层（必须）**

- [ ] 实现 `ToolCollection` 工具容器（注册、查找、执行、动态添加）
- [ ] 实现 `ToolCallAgent`：LLM tool calling 协议、工具执行、特殊工具处理
- [ ] 实现三种 `tool_choices` 模式（NONE/AUTO/REQUIRED）

**阶段四：领域特化（按需）**

- [ ] 为每个领域创建子类，声明式配置 prompt + 工具集
- [ ] 需要行为定制的领域覆盖 `think()` 或 `act()`
- [ ] 需要资源管理的领域覆盖 `cleanup()`

### 3.2 适配代码模板

以下模板可直接复用，创建一个完整的四层 Agent 继承体系：

```python
"""阶段一：基础框架"""
from abc import ABC, abstractmethod
from contextlib import asynccontextmanager
from enum import Enum
from typing import List, Optional

from pydantic import BaseModel, Field


class AgentState(str, Enum):
    IDLE = "IDLE"
    RUNNING = "RUNNING"
    FINISHED = "FINISHED"
    ERROR = "ERROR"


class BaseAgent(BaseModel, ABC):
    """根基类：状态机 + 执行循环 + 卡死检测"""
    name: str = Field(..., description="Agent 名称")
    description: Optional[str] = None
    system_prompt: Optional[str] = None
    next_step_prompt: Optional[str] = None

    state: AgentState = AgentState.IDLE
    max_steps: int = 10
    current_step: int = 0
    duplicate_threshold: int = 2
    # memory 和 llm 按你的项目实际类型声明

    class Config:
        arbitrary_types_allowed = True
        extra = "allow"  # 关键：允许子类自由扩展字段

    @asynccontextmanager
    async def state_context(self, new_state: AgentState):
        previous_state = self.state
        self.state = new_state
        try:
            yield
        except Exception:
            self.state = AgentState.ERROR
            raise
        finally:
            self.state = previous_state

    async def run(self, request: Optional[str] = None) -> str:
        if self.state != AgentState.IDLE:
            raise RuntimeError(f"Cannot run from state: {self.state}")
        results = []
        async with self.state_context(AgentState.RUNNING):
            while self.current_step < self.max_steps and self.state != AgentState.FINISHED:
                self.current_step += 1
                step_result = await self.step()
                if self.is_stuck():
                    self.handle_stuck_state()
                results.append(step_result)
        return "\n".join(results)

    @abstractmethod
    async def step(self) -> str: ...

    def is_stuck(self) -> bool:
        # 实现重复内容检测逻辑
        return False

    def handle_stuck_state(self):
        self.next_step_prompt = f"检测到重复，请换策略。\n{self.next_step_prompt}"


"""阶段二：ReAct 层"""
class ReActAgent(BaseAgent, ABC):
    @abstractmethod
    async def think(self) -> bool: ...

    @abstractmethod
    async def act(self) -> str: ...

    async def step(self) -> str:
        should_act = await self.think()
        if not should_act:
            return "No action needed"
        return await self.act()


"""阶段三：工具调用层（简化版）"""
class ToolCallAgent(ReActAgent):
    available_tools: list = Field(default_factory=list)  # 替换为你的 ToolCollection
    tool_calls: list = Field(default_factory=list)
    special_tool_names: list = Field(default_factory=list)

    async def think(self) -> bool:
        # 调用 LLM 获取工具调用决策
        # response = await self.llm.ask_tool(...)
        # self.tool_calls = response.tool_calls
        return bool(self.tool_calls)

    async def act(self) -> str:
        results = []
        for call in self.tool_calls:
            result = await self.execute_tool(call)
            results.append(result)
        return "\n".join(results)

    async def execute_tool(self, call) -> str:
        # 工具执行 + 特殊工具处理
        ...


"""阶段四：领域 Agent（示例）"""
class MyDomainAgent(ToolCallAgent):
    name: str = "my_domain"
    description: str = "领域专用 Agent"
    system_prompt: str = "你是一个专注于 X 领域的 Agent..."
    # available_tools: ToolCollection = ToolCollection(ToolA(), ToolB(), Terminate())
    max_steps: int = 20
```

### 3.3 适用场景

| 场景 | 适用度 | 说明 |
|------|--------|------|
| 多类型 Agent 系统（≥3 种 Agent） | ⭐⭐⭐ | 继承体系的核心价值在于复用，Agent 类型越多收益越大 |
| 需要运行时动态扩展工具的系统 | ⭐⭐⭐ | ToolCollection + MCP 动态注册模式直接适用 |
| 单一 Agent 系统 | ⭐ | 过度设计，直接实现即可 |
| 需要跨 Agent 共享状态的系统 | ⭐⭐ | 继承体系不直接解决共享状态，需额外设计 |
| Agent 能力需要动态组合（非固定层级） | ⭐⭐ | 考虑 mixin 或组合模式替代继承 |

---

## 第 4 章 测试用例

```python
import pytest
from unittest.mock import AsyncMock, MagicMock, patch
from enum import Enum


class AgentState(str, Enum):
    IDLE = "IDLE"
    RUNNING = "RUNNING"
    FINISHED = "FINISHED"
    ERROR = "ERROR"


class TestBaseAgentStateContext:
    """测试 BaseAgent 的状态上下文管理器（对应 base.py:58-82）"""

    @pytest.mark.asyncio
    async def test_state_transitions_normally(self, base_agent):
        """正常执行时状态正确转换并恢复"""
        assert base_agent.state == AgentState.IDLE
        async with base_agent.state_context(AgentState.RUNNING):
            assert base_agent.state == AgentState.RUNNING
        assert base_agent.state == AgentState.IDLE

    @pytest.mark.asyncio
    async def test_state_transitions_to_error_on_exception(self, base_agent):
        """异常时状态转为 ERROR"""
        with pytest.raises(ValueError):
            async with base_agent.state_context(AgentState.RUNNING):
                raise ValueError("test error")
        # finally 块恢复到 previous_state
        assert base_agent.state == AgentState.IDLE

    @pytest.mark.asyncio
    async def test_invalid_state_raises_value_error(self, base_agent):
        """无效状态值抛出 ValueError"""
        with pytest.raises(ValueError, match="Invalid state"):
            async with base_agent.state_context("INVALID"):
                pass


class TestBaseAgentStuckDetection:
    """测试卡死检测（对应 base.py:170-186）"""

    def test_not_stuck_with_few_messages(self, base_agent):
        """消息不足时不判定为卡死"""
        base_agent.memory.messages = []
        assert base_agent.is_stuck() is False

    def test_stuck_with_duplicate_messages(self, base_agent):
        """连续重复消息触发卡死检测"""
        msg = MagicMock(role="assistant", content="same content")
        base_agent.memory.messages = [msg, msg, msg]
        base_agent.duplicate_threshold = 2
        assert base_agent.is_stuck() is True

    def test_not_stuck_with_different_messages(self, base_agent):
        """不同内容不触发卡死"""
        base_agent.memory.messages = [
            MagicMock(role="assistant", content="content A"),
            MagicMock(role="assistant", content="content B"),
        ]
        assert base_agent.is_stuck() is False


class TestReActAgentStep:
    """测试 ReAct 的 think→act 流程（对应 react.py:33-38）"""

    @pytest.mark.asyncio
    async def test_step_skips_act_when_think_returns_false(self, react_agent):
        """think() 返回 False 时跳过 act()"""
        react_agent.think = AsyncMock(return_value=False)
        react_agent.act = AsyncMock()
        result = await react_agent.step()
        react_agent.act.assert_not_called()
        assert "no action" in result.lower()

    @pytest.mark.asyncio
    async def test_step_calls_act_when_think_returns_true(self, react_agent):
        """think() 返回 True 时执行 act()"""
        react_agent.think = AsyncMock(return_value=True)
        react_agent.act = AsyncMock(return_value="action done")
        result = await react_agent.step()
        react_agent.act.assert_called_once()
        assert result == "action done"


class TestToolCallAgentExecuteTool:
    """测试工具执行（对应 toolcall.py:166-208）"""

    @pytest.mark.asyncio
    async def test_execute_unknown_tool_returns_error(self, toolcall_agent):
        """未知工具名返回错误"""
        command = MagicMock()
        command.function.name = "nonexistent_tool"
        command.function.arguments = "{}"
        result = await toolcall_agent.execute_tool(command)
        assert "Error" in result and "Unknown tool" in result

    @pytest.mark.asyncio
    async def test_execute_tool_with_invalid_json(self, toolcall_agent):
        """无效 JSON 参数返回解析错误"""
        command = MagicMock()
        command.function.name = "existing_tool"
        command.function.arguments = "not json"
        toolcall_agent.available_tools.tool_map = {"existing_tool": MagicMock()}
        result = await toolcall_agent.execute_tool(command)
        assert "Error" in result

    @pytest.mark.asyncio
    async def test_special_tool_triggers_finished_state(self, toolcall_agent):
        """特殊工具执行后 Agent 状态变为 FINISHED"""
        toolcall_agent.special_tool_names = ["terminate"]
        await toolcall_agent._handle_special_tool(name="terminate", result="done")
        assert toolcall_agent.state == AgentState.FINISHED


class TestDeclarativeSpecialization:
    """测试声明式领域特化"""

    def test_swe_agent_has_correct_tools(self):
        """SWEAgent 声明了正确的工具集"""
        # 验证子类只需声明即可获得完整能力
        from app.agent.swe import SWEAgent
        agent = SWEAgent()
        tool_names = list(agent.available_tools.tool_map.keys())
        assert "bash" in [n.lower() for n in tool_names]
        assert "terminate" in [n.lower() for n in tool_names]

    def test_domain_agent_inherits_base_capabilities(self):
        """领域 Agent 继承了基类的全部能力"""
        from app.agent.swe import SWEAgent
        agent = SWEAgent()
        assert hasattr(agent, 'state')
        assert hasattr(agent, 'memory')
        assert hasattr(agent, 'is_stuck')
        assert hasattr(agent, 'think')
        assert hasattr(agent, 'act')
```

---

## 第 5 章 跨域关联

| 关联域 | 关系类型 | 说明 |
|--------|----------|------|
| PD-01 上下文管理 | 协同 | BaseAgent 的 Memory（`max_messages=100` 滑动窗口）是隐式的上下文管理策略，ToolCallAgent 的 `max_observe` 截断工具输出也是上下文控制手段 |
| PD-03 容错与重试 | 协同 | BaseAgent 的 `is_stuck()` 卡死检测 + `handle_stuck_state()` 策略注入是容错机制；ToolCallAgent 的 TokenLimitExceeded 处理是优雅降级 |
| PD-04 工具系统 | 依赖 | ToolCallAgent 层依赖 ToolCollection 工具容器和 BaseTool 工具基类；领域 Agent 通过声明 `available_tools` 组装工具集 |
| PD-06 记忆持久化 | 协同 | BaseAgent 的 Memory 是短期记忆实现，但当前仅内存存储（`max_messages=100`），无持久化 |
| PD-09 Human-in-the-Loop | 协同 | Manus 的工具集包含 `AskHuman` 工具，通过工具调用机制实现人机交互 |

---

## 第 6 章 来源文件索引

| 文件 | 行范围 | 关键实现 |
|------|--------|----------|
| `app/agent/base.py` | L1-197 | BaseAgent 基类：状态机、Memory、执行循环、卡死检测 |
| `app/agent/react.py` | L1-38 | ReActAgent：think→act 双阶段抽象 |
| `app/agent/toolcall.py` | L1-251 | ToolCallAgent：LLM tool calling、工具执行、特殊工具、资源清理 |
| `app/agent/manus.py` | L1-166 | Manus：通用 Agent + MCP 动态工具 + 浏览器上下文 |
| `app/agent/browser.py` | L87-130 | BrowserAgent：浏览器状态注入 + BrowserContextHelper |
| `app/agent/swe.py` | L1-24 | SWEAgent：Bash + StrReplaceEditor 声明式特化 |
| `app/agent/data_analysis.py` | L1-37 | DataAnalysis：Python 执行 + 可视化工具 |
| `app/agent/mcp.py` | L1-186 | MCPAgent：MCP 协议 + 动态工具发现 + 工具刷新 |
| `app/schema.py` | L32-38 | AgentState 四态枚举 |
| `app/schema.py` | L159-187 | Memory：消息存储 + 滑动窗口 |
| `app/tool/tool_collection.py` | L1-71 | ToolCollection：工具容器 + 动态添加 |
| `app/tool/base.py` | L78-174 | BaseTool：工具基类 + ToolResult |

---

## 第 7 章 横向对比维度

```json comparison_data
{
  "project": "OpenManus",
  "dimensions": {
    "继承层数": "四层：BaseAgent→ReActAgent→ToolCallAgent→领域Agent",
    "配置方式": "Pydantic BaseModel + Field 声明式，extra=allow 允许子类扩展",
    "状态管理": "四态枚举 + asynccontextmanager 安全转换，异常自动回滚",
    "能力叠加模式": "每层严格单一职责：状态机→Think-Act→工具调用→领域特化",
    "工具组合方式": "ToolCollection 容器 + 声明式 Field 覆盖 + MCP 动态注册",
    "卡死检测": "重复消息计数 + 策略变更提示注入",
    "领域特化成本": "最少 15 行代码（SWEAgent），仅需声明 prompt + 工具集"
  }
}
```

### 域元数据补充

```json domain_metadata
{
  "solution_summary": "OpenManus 用 Pydantic BaseModel 四层继承（BaseAgent→ReActAgent→ToolCallAgent→领域Agent）实现声明式 Agent 特化，领域 Agent 最少仅需 15 行声明",
  "description": "通过 asynccontextmanager 实现安全状态转换和异常自动回滚",
  "sub_problems": [
    "卡死检测与策略自动切换",
    "异步资源清理链（工具→Agent→MCP 连接）",
    "MCP 工具动态发现与热注册"
  ],
  "best_practices": [
    "Pydantic Config extra=allow 允许子类自由扩展字段",
    "model_validator 构建初始化链替代 __init__ 覆盖",
    "特殊工具机制（special_tool_names）控制 Agent 终止条件"
  ]
}
```
