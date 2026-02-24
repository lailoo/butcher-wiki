# PD-12.07 OpenManus — ReAct 循环推理与计划驱动任务分解

> 文档编号：PD-12.07
> 来源：OpenManus `app/agent/react.py`, `app/agent/base.py`, `app/flow/planning.py`
> GitHub：https://github.com/FoundationAgents/OpenManus.git
> 问题域：PD-12 推理增强 Reasoning Enhancement
> 状态：可复用方案

---

## 第 1 章 问题与动机（≥ 30 行）

### 1.1 核心问题

Agent 系统在执行复杂任务时面临两个核心推理挑战：

1. **单步推理的结构化**：Agent 需要在每一步中先"想"再"做"，但如何将 think→act 循环形式化为可复用的抽象？如果 Agent 只是盲目调用工具而不经过推理判断，会导致无效操作和资源浪费。
2. **多步推理的任务分解**：面对复杂任务，Agent 需要将其分解为有序步骤并跟踪执行进度。没有结构化计划，Agent 容易迷失在子任务中，重复执行或遗漏关键步骤。
3. **推理循环检测**：Agent 在推理过程中可能陷入重复循环——反复生成相同的回复而无法推进。需要自动检测并打破这种死循环。

### 1.2 OpenManus 的解法概述

OpenManus 采用双层推理架构，将单步推理和多步计划分离为两个独立层次：

- **ReAct Agent 层**（`app/agent/react.py:11-38`）：定义 `think()` → `act()` 的抽象循环，每一步先推理再执行，子类实现具体的推理和执行逻辑
- **BaseAgent 执行循环**（`app/agent/base.py:116-154`）：`run()` 方法驱动 step 循环，内置 `is_stuck()` 重复检测 + `handle_stuck_state()` 策略注入
- **PlanningFlow 层**（`app/flow/planning.py:45-134`）：通过 LLM 生成结构化计划，将复杂任务分解为带状态跟踪的步骤序列，每步委派给合适的 Agent 执行
- **ToolCallAgent 桥接**（`app/agent/toolcall.py:18-130`）：将 ReAct 的 think/act 抽象映射到 LLM tool calling API，实现"推理=选工具，执行=调工具"
- **PlanningTool 持久化**（`app/tool/planning.py:14-363`）：计划的 CRUD 操作封装为工具，支持 4 态步骤状态机（not_started → in_progress → completed/blocked）

### 1.3 设计思想

| 设计原则 | 具体实现 | 理由 | 替代方案 |
|----------|----------|------|----------|
| Think-Act 分离 | `ReActAgent` 定义 `think()` 和 `act()` 为独立抽象方法 | 推理与执行解耦，子类可独立定制推理策略 | 单一 `step()` 方法混合推理和执行 |
| 循环检测自愈 | `is_stuck()` 检测重复内容，`handle_stuck_state()` 注入策略变更提示 | 避免 Agent 陷入无限循环浪费 token | 简单的 max_steps 硬截断 |
| 计划即工具 | `PlanningTool` 作为 LLM 可调用的工具实现 | LLM 自主创建和管理计划，无需硬编码分解逻辑 | 在 prompt 中要求 LLM 输出 JSON 计划 |
| 步骤状态机 | 4 态枚举 `PlanStepStatus`（not_started/in_progress/completed/blocked） | 精确跟踪每步进度，支持断点续执行 | 布尔完成标记 |
| Agent-Flow 分层 | Agent 负责单步推理，Flow 负责多步编排 | 关注点分离，同一 Agent 可在不同 Flow 中复用 | Agent 自身管理多步计划 |

---

## 第 2 章 源码实现分析（≥ 60 行，核心章节）

### 2.1 架构概览

OpenManus 的推理增强架构分为三层：

```
┌─────────────────────────────────────────────────────────┐
│                    PlanningFlow                          │
│  LLM 生成计划 → 逐步委派 → 状态跟踪 → 动态调整          │
│  ┌─────────┐  ┌─────────┐  ┌─────────┐                 │
│  │ Step 0  │→ │ Step 1  │→ │ Step 2  │→ ...            │
│  │[→]      │  │[ ]      │  │[ ]      │                 │
│  └────┬────┘  └─────────┘  └─────────┘                 │
│       │ 委派                                             │
├───────▼─────────────────────────────────────────────────┤
│              ToolCallAgent (ReAct)                        │
│  think(): LLM 推理 → 选择工具                            │
│  act():   执行工具 → 返回结果                            │
│  ┌──────────────────────────────────┐                    │
│  │  while step < max_steps:         │                    │
│  │    should_act = think()          │                    │
│  │    if should_act: act()          │                    │
│  │    if is_stuck(): inject_prompt  │                    │
│  └──────────────────────────────────┘                    │
├──────────────────────────────────────────────────────────┤
│                    BaseAgent                              │
│  run() 循环 + 状态机 + 重复检测 + Memory                 │
└──────────────────────────────────────────────────────────┘
```

继承链：`BaseAgent` → `ReActAgent` → `ToolCallAgent` → `Manus/SWEAgent`

### 2.2 核心实现

#### 2.2.1 ReAct 循环：think → act 抽象

`ReActAgent`（`app/agent/react.py:11-38`）定义了推理增强的核心抽象：

```python
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

关键设计：`think()` 返回 `bool` 决定是否需要执行 `act()`。这允许 Agent 在推理后判断"无需行动"，避免不必要的工具调用。

#### 2.2.2 ToolCallAgent：推理映射到工具选择

`ToolCallAgent`（`app/agent/toolcall.py:39-129`）将 ReAct 抽象映射到 LLM tool calling：

```python
class ToolCallAgent(ReActAgent):
    available_tools: ToolCollection = ToolCollection(
        CreateChatCompletion(), Terminate()
    )
    tool_choices: TOOL_CHOICE_TYPE = ToolChoice.AUTO
    tool_calls: List[ToolCall] = Field(default_factory=list)
    max_steps: int = 30

    async def think(self) -> bool:
        """Process current state and decide next actions using tools"""
        if self.next_step_prompt:
            user_msg = Message.user_message(self.next_step_prompt)
            self.messages += [user_msg]

        response = await self.llm.ask_tool(
            messages=self.messages,
            system_msgs=([Message.system_message(self.system_prompt)]
                         if self.system_prompt else None),
            tools=self.available_tools.to_params(),
            tool_choice=self.tool_choices,
        )
        self.tool_calls = response.tool_calls if response and response.tool_calls else []
        # ... 处理不同 tool_choice 模式
        return bool(self.tool_calls)
```

`think()` 的核心逻辑：每步注入 `next_step_prompt` 引导 LLM 推理，LLM 返回 tool_calls 作为推理结果。

#### 2.2.3 循环检测与自愈

`BaseAgent`（`app/agent/base.py:170-186`）内置重复检测机制：

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
        1 for msg in reversed(self.memory.messages[:-1])
        if msg.role == "assistant" and msg.content == last_message.content
    )
    return duplicate_count >= self.duplicate_threshold
```

检测到循环后，`handle_stuck_state()`（`app/agent/base.py:163-168`）通过修改 `next_step_prompt` 注入策略变更提示：

```python
def handle_stuck_state(self):
    stuck_prompt = "Observed duplicate responses. Consider new strategies and avoid repeating ineffective paths already attempted."
    self.next_step_prompt = f"{stuck_prompt}\n{self.next_step_prompt}"
```

