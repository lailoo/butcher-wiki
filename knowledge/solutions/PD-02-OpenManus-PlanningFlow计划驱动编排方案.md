# PD-02.07 OpenManus — PlanningFlow 计划驱动多 Agent 编排

> 文档编号：PD-02.07
> 来源：OpenManus `app/flow/planning.py`, `app/flow/flow_factory.py`, `app/flow/base.py`
> GitHub：https://github.com/FoundationAgents/OpenManus.git
> 问题域：PD-02 多Agent编排 Multi-Agent Orchestration
> 状态：可复用方案

---

## 第 1 章 问题与动机（≥ 30 行）

### 1.1 核心问题

多 Agent 系统面临一个根本矛盾：任务的复杂性要求多个专业 Agent 协作，但编排逻辑本身不应比业务逻辑更复杂。常见的 DAG 编排（如 LangGraph）虽然灵活，但需要开发者预先定义节点和边，对于开放式任务（"帮我分析这份数据并生成报告"）难以预知执行路径。

OpenManus 提出了一种"计划驱动"的编排模式：让 LLM 自己生成执行计划，然后按计划步骤逐一分派给合适的 Agent 执行。这种模式的核心洞察是——**编排逻辑本身也是 LLM 的能力范围**，不需要硬编码。

### 1.2 OpenManus 的解法概述

1. **PlanningFlow 作为编排核心** — 不是 DAG，而是一个线性计划执行器。LLM 先生成步骤列表，再逐步执行（`app/flow/planning.py:94-134`）
2. **PlanningTool 作为状态存储** — 计划本身是一个工具（`app/tool/planning.py:14-363`），支持 create/update/get/mark_step 等 7 个命令，步骤状态机跟踪进度
3. **正则匹配路由 Agent** — 计划步骤文本中嵌入 `[AGENT_NAME]` 标记，通过正则提取后路由到对应 Agent（`app/flow/planning.py:243-247`）
4. **FlowFactory 工厂模式** — 通过 `FlowType` 枚举创建不同类型的 Flow，当前仅 PLANNING 一种（`app/flow/flow_factory.py:13-30`）
5. **Agent 继承体系支撑** — BaseAgent → ReActAgent → ToolCallAgent → Manus/DataAnalysis，每个 Agent 自带工具集和 system prompt，PlanningFlow 只负责调度（`app/agent/manus.py:18-166`）

### 1.3 设计思想

| 设计原则 | 具体实现 | 理由 | 替代方案 |
|----------|----------|------|----------|
| LLM 即编排器 | LLM 调用 PlanningTool 生成步骤列表 | 开放式任务无法预定义 DAG | 硬编码 DAG（LangGraph） |
| 步骤即路由 | `[MANUS]`/`[DATA_ANALYSIS]` 标记嵌入步骤文本 | 零额外配置，LLM 自然语言即路由规则 | 独立的路由 LLM 调用 |
| 工具即状态 | PlanningTool.plans 字典存储所有计划和步骤状态 | 复用工具调用协议，无需额外状态管理层 | 外部数据库/Redis |
| 串行保序 | while 循环逐步执行，每步完成后标记 completed | 简单可靠，避免并行带来的状态同步问题 | 并行执行 + 依赖图 |
| 宽松 Agent 注入 | BaseFlow 接受 single/list/dict 三种 Agent 输入 | 降低使用门槛，单 Agent 场景也能用 | 强制 Dict 输入 |

---

## 第 2 章 源码实现分析（≥ 60 行，核心章节）

### 2.1 架构概览

OpenManus 的编排架构分为三层：Flow 层（编排）、Agent 层（执行）、Tool 层（能力）。

```
┌─────────────────────────────────────────────────────────┐
│                     run_flow.py                          │
│  agents = {"manus": Manus(), "data_analysis": DataAna}  │
│  flow = FlowFactory.create_flow(PLANNING, agents)       │
│  flow.execute(prompt)                                    │
└──────────────────────┬──────────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────────┐
│                  PlanningFlow                             │
│                                                          │
│  1. _create_initial_plan(prompt)                         │
│     └─ LLM + PlanningTool → 生成步骤列表                  │
│                                                          │
│  2. while loop:                                          │
│     ├─ _get_current_step_info() → 找第一个未完成步骤       │
│     ├─ get_executor(step_type) → 按 [TYPE] 路由 Agent    │
│     ├─ _execute_step(executor, step_info)                │
│     │   └─ executor.run(step_prompt)                     │
│     └─ _mark_step_completed()                            │
│                                                          │
│  3. _finalize_plan() → LLM 生成总结                       │
└──────────────────────┬──────────────────────────────────┘
                       │
          ┌────────────┼────────────┐
          ▼            ▼            ▼
    ┌──────────┐ ┌──────────┐ ┌──────────┐
    │  Manus   │ │DataAnalys│ │ SWEAgent │
    │ (通用)    │ │ (数据)    │ │ (编程)    │
    └────┬─────┘ └────┬─────┘ └────┬─────┘
         │            │            │
    ┌────▼─────┐ ┌────▼─────┐ ┌────▼─────┐
    │Python    │ │NormalPy  │ │Bash      │
    │Browser   │ │VisPrepare│ │StrReplace│
    │StrReplace│ │DataVis   │ │Terminate │
    │AskHuman  │ │Terminate │ └──────────┘
    │MCP tools │ └──────────┘
    │Terminate │
    └──────────┘
```

### 2.2 核心实现

#### 2.2.1 计划生成：LLM + PlanningTool

PlanningFlow 的计划生成通过 `_create_initial_plan` 实现（`app/flow/planning.py:136-211`）。关键设计：当存在多个 executor Agent 时，system prompt 会注入所有 Agent 的名称和描述，要求 LLM 在步骤中标注 `[agent_name]`：

```python
# app/flow/planning.py:140-160
async def _create_initial_plan(self, request: str) -> None:
    system_message_content = (
        "You are a planning assistant. Create a concise, actionable plan "
        "with clear steps. Focus on key milestones rather than detailed sub-steps. "
        "Optimize for clarity and efficiency."
    )
    agents_description = []
    for key in self.executor_keys:
        if key in self.agents:
            agents_description.append(
                {"name": key.UPPER(), "description": self.agents[key].description}
            )
    if len(agents_description) > 1:
        system_message_content += (
            f"\nNow we have {agents_description} agents. "
            f"The infomation of them are below: {json.dumps(agents_description)}\n"
            "When creating steps in the planning tool, please specify the agent names "
            "using the format '[agent_name]'."
        )
```

#### 2.2.2 步骤路由：正则匹配 Agent 名

步骤执行的核心是 `get_executor` 方法（`app/flow/planning.py:77-92`），它实现了三级 fallback 路由：

```python
# app/flow/planning.py:77-92
def get_executor(self, step_type: Optional[str] = None) -> BaseAgent:
    """Get an appropriate executor agent for the current step."""
    # 第一优先：step_type 精确匹配 agent key
    if step_type and step_type in self.agents:
        return self.agents[step_type]

    # 第二优先：executor_keys 列表中第一个可用 agent
    for key in self.executor_keys:
        if key in self.agents:
            return self.agents[key]

    # 兜底：primary agent
    return self.primary_agent
```

步骤类型的提取通过正则从步骤文本中解析 `[TYPE]` 标记（`app/flow/planning.py:243-247`）：

```python
# app/flow/planning.py:239-247
step_info = {"text": step}
import re
type_match = re.search(r"\[([A-Z_]+)\]", step)
if type_match:
    step_info["type"] = type_match.group(1).lower()
```

#### 2.2.3 步骤状态机：4 态跟踪

PlanStepStatus 定义了 4 种步骤状态（`app/flow/planning.py:16-42`）：

| 状态 | 符号 | 含义 |
|------|------|------|
| `not_started` | `[ ]` | 未开始 |
| `in_progress` | `[→]` | 执行中 |
| `completed` | `[✓]` | 已完成 |
| `blocked` | `[!]` | 被阻塞 |

状态转换在 `_execute_step` 中完成（`app/flow/planning.py:277-304`）：进入时标记 `in_progress`，`executor.run()` 成功后标记 `completed`。

#### 2.2.4 Agent 继承体系与 ReAct 循环

所有执行 Agent 共享同一个 ReAct 执行模式（`app/agent/react.py:33-38`）：

```python
# app/agent/react.py:33-38
async def step(self) -> str:
    """Execute a single step: think and act."""
    should_act = await self.think()
    if not should_act:
        return "Thinking complete - no action needed"
    return await self.act()
```

BaseAgent.run() 提供了 max_steps 保护和卡死检测（`app/agent/base.py:116-154`）：
- 每个 Agent 有独立的 `max_steps`（Manus=20, DataAnalysis=20, SWE=20）
- `is_stuck()` 检测连续重复输出，触发策略切换提示
- `state_context` 上下文管理器确保状态安全转换

### 2.3 实现细节

#### 数据流：从用户输入到多 Agent 执行

完整调用链（`run_flow.py:11-52`）：

1. `run_flow()` 构建 agents 字典，按配置决定是否加入 DataAnalysis
2. `FlowFactory.create_flow(PLANNING, agents)` 创建 PlanningFlow
3. `flow.execute(prompt)` 启动编排循环
4. `_create_initial_plan()` — LLM 调用 PlanningTool.create 生成步骤
5. `while True` 循环 — 每轮取下一个未完成步骤
6. `get_executor(step_type)` — 按步骤标记选择 Agent
7. `executor.run(step_prompt)` — Agent 内部 ReAct 循环执行
8. `_mark_step_completed()` — 标记完成，继续下一步
9. `_finalize_plan()` — 所有步骤完成后 LLM 生成总结

#### PlanningTool 的双重角色

PlanningTool 既是 LLM 的工具（用于生成计划），也是 PlanningFlow 的状态存储（`app/tool/planning.py:69`）：

```python
plans: dict = {}  # Dictionary to store plans by plan_id
```

这个内存字典存储所有计划数据，PlanningFlow 通过 `self.planning_tool.plans[self.active_plan_id]` 直接访问。这种设计避免了额外的状态管理层，但也意味着计划数据不可持久化。

#### 全局超时保护

`run_flow.py:32-35` 使用 `asyncio.wait_for` 设置 3600 秒（1 小时）全局超时：

```python
result = await asyncio.wait_for(
    flow.execute(prompt),
    timeout=3600,
)
```

---

## 第 3 章 迁移指南（≥ 40 行）

### 3.1 迁移清单

**阶段 1：基础框架（必须）**
- [ ] 实现 `BaseFlow` 抽象类：agents 字典 + primary_agent + execute 抽象方法
- [ ] 实现 `PlanStepStatus` 枚举：4 态状态机
- [ ] 实现 `PlanningTool`：create/get/mark_step/update 核心命令
- [ ] 实现 `PlanningFlow`：计划生成 + while 循环执行 + 步骤路由

**阶段 2：Agent 体系（按需）**
- [ ] 实现 `ReActAgent`：think → act 循环
- [ ] 实现 `ToolCallAgent`：LLM tool_call 解析 + 工具执行
- [ ] 实现具体 Agent（如通用 Agent、数据分析 Agent）

**阶段 3：增强（可选）**
- [ ] FlowFactory 工厂模式支持多种 Flow 类型
- [ ] 步骤状态持久化（当前仅内存）
- [ ] 并行步骤执行支持

### 3.2 适配代码模板

以下是一个最小可运行的 PlanningFlow 迁移模板：

```python
"""最小 PlanningFlow 迁移模板 — 可直接运行"""
import asyncio
import json
import re
from abc import ABC, abstractmethod
from enum import Enum
from typing import Dict, List, Optional

# ---- Step Status ----
class StepStatus(str, Enum):
    NOT_STARTED = "not_started"
    IN_PROGRESS = "in_progress"
    COMPLETED = "completed"
    BLOCKED = "blocked"

# ---- Plan Store (替代 PlanningTool) ----
class PlanStore:
    def __init__(self):
        self.plans: Dict[str, dict] = {}

    def create(self, plan_id: str, title: str, steps: List[str]) -> dict:
        plan = {
            "plan_id": plan_id,
            "title": title,
            "steps": steps,
            "statuses": [StepStatus.NOT_STARTED.value] * len(steps),
        }
        self.plans[plan_id] = plan
        return plan

    def mark_step(self, plan_id: str, index: int, status: str):
        self.plans[plan_id]["statuses"][index] = status

    def get_next_step(self, plan_id: str) -> Optional[tuple[int, str]]:
        plan = self.plans[plan_id]
        for i, (step, status) in enumerate(zip(plan["steps"], plan["statuses"])):
            if status in (StepStatus.NOT_STARTED.value, StepStatus.IN_PROGRESS.value):
                return i, step
        return None

# ---- Base Agent ----
class BaseAgent(ABC):
    def __init__(self, name: str, description: str = ""):
        self.name = name
        self.description = description

    @abstractmethod
    async def run(self, prompt: str) -> str:
        """执行单个步骤"""

# ---- Planning Flow ----
class PlanningFlow:
    def __init__(self, agents: Dict[str, BaseAgent], primary_key: str = None):
        self.agents = agents
        self.primary_key = primary_key or next(iter(agents))
        self.store = PlanStore()

    def _route_agent(self, step_text: str) -> BaseAgent:
        """从步骤文本中提取 [AGENT_NAME] 并路由"""
        match = re.search(r"\[([A-Z_]+)\]", step_text)
        if match:
            agent_key = match.group(1).lower()
            if agent_key in self.agents:
                return self.agents[agent_key]
        return self.agents[self.primary_key]

    async def execute(self, plan_id: str, steps: List[str]) -> List[str]:
        self.store.create(plan_id, f"Plan {plan_id}", steps)
        results = []
        while True:
            next_step = self.store.get_next_step(plan_id)
            if next_step is None:
                break
            idx, step_text = next_step
            self.store.mark_step(plan_id, idx, StepStatus.IN_PROGRESS.value)
            agent = self._route_agent(step_text)
            result = await agent.run(step_text)
            self.store.mark_step(plan_id, idx, StepStatus.COMPLETED.value)
            results.append(f"Step {idx}: {result}")
        return results
```

### 3.3 适用场景

| 场景 | 适用度 | 说明 |
|------|--------|------|
| 开放式任务（用户 prompt 不确定） | ⭐⭐⭐ | LLM 动态生成计划，无需预定义 DAG |
| 多专业 Agent 协作 | ⭐⭐⭐ | 步骤标记路由，Agent 职责清晰 |
| 需要执行进度可视化 | ⭐⭐⭐ | 4 态状态机 + 进度百分比 |
| 需要并行执行的场景 | ⭐ | 当前仅串行，需自行扩展 |
| 需要步骤间依赖管理 | ⭐ | 无 DAG 依赖图，仅线性顺序 |
| 需要计划持久化/恢复 | ⭐ | 当前仅内存存储，需自行扩展 |

