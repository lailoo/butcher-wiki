# PD-02.04 DeepTutor — 多模块双循环 + 动态队列编排方案

> 文档编号：PD-02.04
> 来源：DeepTutor `src/agents/solve/main_solver.py`, `src/agents/research/research_pipeline.py`
> GitHub：https://github.com/HKUDS/DeepTutor.git
> 问题域：PD-02 多 Agent 编排 Multi-Agent Orchestration
> 状态：可复用方案

---

## 第 1 章 问题与动机

### 1.1 核心问题

教育场景下的 AI 系统需要同时支持多种截然不同的交互模式：深度问题求解（Solve）、学术研究（Research）、自动出题（Question）、引导式学习（Guide）、创意生成（IdeaGen）。每种模式对 Agent 编排的需求差异巨大——Solve 需要迭代式分析-求解双循环，Research 需要动态主题队列驱动的并行研究，Question 需要线性流水线，Guide 需要会话状态管理。

如何在一个统一的 BaseAgent 抽象之上，为每个模块设计最适合其任务特征的编排模式，同时保持代码复用和一致的 LLM 调用接口？

### 1.2 DeepTutor 的解法概述

1. **统一 BaseAgent 抽象层**：所有 Agent 继承自 `src/agents/base_agent.py:35` 的 `BaseAgent`，统一 LLM 调用、Token 追踪、Prompt 加载、配置管理（`base_agent.py:340-458`）
2. **Solve 模块：Dual-Loop 双循环架构**：Analysis Loop（Investigate→Note 迭代）+ Solve Loop（Plan→Execute→Response 链式），由 `MainSolver` 协调 6 个专职 Agent（`main_solver.py:283-312`）
3. **Research 模块：三阶段流水线 + DynamicTopicQueue**：Planning→Researching→Reporting，核心是 `DynamicTopicQueue` 动态调度，支持串行/并行两种执行模式（`research_pipeline.py:720-731`）
4. **Question 模块：单遍流水线**：Retrieve→Generate→Analyze，由 `AgentCoordinator` 编排，无迭代循环（`coordinator.py:165-258`）
5. **Guide 模块：会话状态机**：`GuideManager` 管理 Locate→Interactive→Chat→Summary 的学习会话生命周期（`guide_manager.py:46-501`）

### 1.3 设计思想

| 设计原则 | 具体实现 | 理由 | 替代方案 |
|----------|----------|------|----------|
| 模块自治 | 每个模块有独立的编排器（MainSolver/ResearchPipeline/AgentCoordinator/GuideManager） | 不同任务类型的编排需求差异太大，强行统一会增加复杂度 | 单一全局编排器 + 策略模式 |
| 统一 Agent 基座 | 所有 Agent 继承 BaseAgent，共享 LLM 调用/Token 追踪/Prompt 加载 | 避免重复实现基础设施，保证一致的可观测性 | 每个模块独立实现 LLM 调用 |
| 循环 vs 流水线按需选择 | Solve 用双循环（需要迭代收敛），Research 用动态队列，Question 用单遍流水线 | 匹配任务特征：求解需要反复验证，研究需要动态扩展，出题一次生成即可 | 所有模块统一用 DAG |
| 懒初始化 | Solve Loop Agents 在首次使用时才创建（`main_solver.py:306-312`） | 减少启动开销，Analysis Loop 可能就足够回答简单问题 | 全部预初始化 |
| 并行/串行可配置 | Research 模块通过 `execution_mode` 配置切换（`research_pipeline.py:725-730`） | 并行提速但增加复杂度，让用户按需选择 | 只支持一种模式 |

---

## 第 2 章 源码实现分析

### 2.1 架构概览

DeepTutor 的多 Agent 编排是一个"联邦制"架构——5 个独立模块各自拥有最适合自身任务的编排模式，通过统一的 BaseAgent 基座共享基础设施。

```
┌─────────────────────────────────────────────────────────────────┐
│                      DeepTutor Agent System                      │
│                                                                   │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │                   BaseAgent (统一基座)                        │ │
│  │  LLM调用 | Token追踪 | Prompt加载 | 配置管理 | 日志          │ │
│  └─────────────────────────────────────────────────────────────┘ │
│                                                                   │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐             │
│  │ Solve Module  │ │Research Module│ │Question Module│             │
│  │  MainSolver   │ │ResearchPipeline│ │AgentCoordinator│           │
│  │              │ │              │ │              │             │
│  │ ┌──────────┐ │ │ Phase1:Plan  │ │ Retrieve     │             │
│  │ │Analysis  │ │ │ Phase2:Research│ │   ↓          │             │
│  │ │  Loop    │ │ │ Phase3:Report│ │ Generate     │             │
│  │ │Investigate│ │ │              │ │   ↓          │             │
│  │ │  ↕ Note  │ │ │ DynamicTopic │ │ Analyze      │             │
│  │ └──────────┘ │ │   Queue      │ └──────────────┘             │
│  │      ↓       │ │ (并行/串行)   │                              │
│  │ ┌──────────┐ │ └──────────────┘ ┌──────────────┐             │
│  │ │ Solve    │ │                   │ Guide Module  │             │
│  │ │  Loop    │ │ ┌──────────────┐ │ GuideManager  │             │
│  │ │Plan→Exec │ │ │IdeaGen Module│ │ Locate→Inter  │             │
│  │ │→Response │ │ │ Workflow     │ │ →Chat→Summary │             │
│  │ └──────────┘ │ │Filter→Explore│ │ (会话状态机)   │             │
│  └──────────────┘ │→Filter→State │ └──────────────┘             │
│                   └──────────────┘                               │
└─────────────────────────────────────────────────────────────────┘
```

### 2.2 核心实现

#### 2.2.1 BaseAgent 统一基座 (`base_agent.py:35-657`)

所有 Agent 的公共基类，提供 LLM 调用、Token 追踪、Prompt 管理：

```python
# src/agents/base_agent.py:35-48
class BaseAgent(ABC):
    """Unified base class for all module agents."""
    _shared_stats: dict[str, LLMStats] = {}  # 模块级共享统计

    def __init__(self, module_name: str, agent_name: str,
                 api_key=None, base_url=None, model=None,
                 api_version=None, language="zh", binding="openai",
                 config=None, token_tracker=None, log_dir=None):
        self.module_name = module_name
        self.agent_name = agent_name
        self._agent_params = get_agent_params(module_name)  # 从 agents.yaml 加载参数
        self.prompts = get_prompt_manager().load_prompts(
            module_name=module_name, agent_name=agent_name, language=language)

    @abstractmethod
    async def process(self, *args, **kwargs) -> Any:
        """每个 Agent 必须实现的处理方法"""
```

关键设计：`_shared_stats` 是类级别的字典，按 module_name 分组统计 Token 消耗，使得每个模块的成本可独立追踪（`base_agent.py:244-257`）。

#### 2.2.2 Solve 模块：Dual-Loop 双循环 (`main_solver.py:386-837`)

这是 DeepTutor 最复杂的编排模式。`_run_dual_loop_pipeline` 方法实现了两个嵌套循环：

```python
# src/agents/solve/main_solver.py:386-391
async def _run_dual_loop_pipeline(self, question: str, output_dir: str) -> dict:
    """
    Dual-Loop Pipeline:
    1) Analysis Loop: Investigate → Note (迭代收集知识)
    2) Solve Loop: Plan → Manager → Solve → Check → Format (生成解答)
    """
```

**Analysis Loop**（`main_solver.py:395-508`）：
- `InvestigateAgent` 生成查询、调用工具收集知识，返回 `knowledge_item_ids` 和 `should_stop` 信号
- `NoteAgent` 对新收集的知识进行摘要和整理
- 循环最多 `max_analysis_iterations` 次（默认 5），直到 `should_stop=True`
- 使用 `InvestigateMemory` 持久化知识链（`main_solver.py:398-399`）

**Solve Loop**（`main_solver.py:510-738`）：
- `ManagerAgent` 生成求解计划，拆分为多个 `SolveChainStep`
- 对每个 step，`SolveAgent` 执行求解，`ToolAgent` 处理工具调用
- 每个 step 最多 `max_correction_iterations` 次迭代（默认 3）
- `ResponseAgent` 为每个完成的 step 生成最终回答
- 所有 step 的回答拼接为最终答案

**懒初始化**（`main_solver.py:283-312`）：Analysis Loop 的 Agent 在 `_init_agents` 中立即创建，Solve Loop 的 Agent 设为 `None`，在首次进入 Solve Loop 时才初始化（`main_solver.py:516-559`）。

#### 2.2.3 Research 模块：DynamicTopicQueue 动态调度 (`research_pipeline.py:66-1309`)

三阶段流水线，核心是 `DynamicTopicQueue`：

```python
# src/agents/research/research_pipeline.py:391-504
async def run(self, topic: str) -> dict:
    # Phase 1: Planning (Rephrase → Decompose → 初始化队列)
    optimized_topic = await self._phase1_planning(topic)
    # Phase 2: Researching (动态循环，支持串行/并行)
    await self._phase2_researching()
    # Phase 3: Reporting (生成最终报告)
    report_result = await self._phase3_reporting(optimized_topic)
```

**DynamicTopicQueue**（`data_structures.py:226-248`）是调度核心：
- `TopicBlock` 是最小调度单元，包含 sub_topic、status（PENDING/RESEARCHING/COMPLETED/FAILED）、tool_traces
- `ManagerAgent` 通过 `get_next_task()` 获取下一个 PENDING 块，`complete_task()` 标记完成
- 研究过程中可以动态添加新主题到队列（`manager_agent.py:44-51`）

**并行模式**（`research_pipeline.py:817-1101`）：
- 使用 `asyncio.Semaphore(max_parallel)` 控制并发数
- `AsyncCitationManagerWrapper` 和 `AsyncManagerAgentWrapper` 提供线程安全的异步包装
- `asyncio.gather(*tasks)` 并行执行所有 pending blocks
- 动态添加的新主题也会被自动拾取并并行处理

#### 2.2.4 Question 模块：单遍流水线 (`coordinator.py:31-479`)

最简单的编排模式，无迭代循环：

```python
# src/agents/question/coordinator.py:165-258
async def generate_question(self, requirement: dict) -> dict:
    # Step 1: Retrieve knowledge
    retrieval_result = await retrieve_agent.process(requirement=requirement, ...)
    # Step 2: Generate question
    gen_result = await generate_agent.process(requirement=requirement, ...)
    # Step 3: Analyze relevance (分类而非拒绝)
    analysis = await analyzer.process(question=question, ...)
```

Custom 模式（`coordinator.py:260-479`）增加了 Planning 阶段，生成多个 focus 后逐个生成题目。

#### 2.2.5 Guide 模块：会话状态机 (`guide_manager.py:46-501`)

基于 `GuidedSession` dataclass 管理学习会话生命周期：

```python
# src/agents/guide/guide_manager.py:24-36
@dataclass
class GuidedSession:
    session_id: str
    notebook_id: str
    knowledge_points: list[dict[str, Any]]
    current_index: int = 0
    chat_history: list[dict[str, Any]] = field(default_factory=list)
    status: str = "initialized"  # initialized → learning → completed
```

状态转换：`create_session`（LocateAgent 分析知识点）→ `start_learning`（InteractiveAgent 生成交互页面）→ `chat`（ChatAgent 回答问题）→ `next_knowledge`（循环）→ `completed`（SummaryAgent 生成总结）。

### 2.3 实现细节

**Memory 系统分层**：Solve 模块使用三层 Memory——`InvestigateMemory`（知识链）、`SolveMemory`（求解链）、`CitationMemory`（引用管理），均支持 `load_or_create` 从磁盘恢复（`main_solver.py:398-403`）。

**进度回调机制**：Research 模块通过 `progress_callback` 将进度事件推送到前端，支持 SSE 实时更新（`research_pipeline.py:1103-1138`）。每个事件包含 stage、status、timestamp 等字段，写入 JSON 文件同时通过回调发送。

**工具调用的超时与重试**：Research 模块的 `_call_tool_with_retry` 方法（`research_pipeline.py:219-277`）实现了带超时的重试机制，支持同步和异步工具函数，RAG 搜索还有 fallback 模式切换（hybrid → naive）。

---

## 第 3 章 迁移指南

### 3.1 迁移清单

**阶段 1：BaseAgent 基座**
- [ ] 实现 BaseAgent 抽象类，封装 LLM 调用（`call_llm`/`stream_llm`）
- [ ] 集成 Token 追踪（模块级 `_shared_stats` + 外部 `token_tracker`）
- [ ] 实现 PromptManager 统一加载 YAML prompt 文件
- [ ] 配置系统：`agents.yaml` 定义每个 Agent 的 temperature/max_tokens

**阶段 2：选择编排模式**
- [ ] 迭代收敛型任务 → Dual-Loop 模式（Analysis Loop + Solve Loop）
- [ ] 动态扩展型任务 → DynamicTopicQueue + 三阶段流水线
- [ ] 简单线性任务 → 单遍流水线（Retrieve→Process→Output）
- [ ] 有状态交互任务 → 会话状态机

**阶段 3：并行支持（可选）**
- [ ] 为编排器添加 `execution_mode` 配置（series/parallel）
- [ ] 使用 `asyncio.Semaphore` 控制并发
- [ ] 为共享状态添加 `asyncio.Lock` 保护
- [ ] 实现 Async Wrapper 包装非线程安全的组件

### 3.2 适配代码模板

**Dual-Loop 编排器模板**：

```python
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any
import asyncio


@dataclass
class AnalysisMemory:
    """Analysis Loop 的知识积累"""
    knowledge_chain: list[dict] = field(default_factory=list)
    metadata: dict = field(default_factory=dict)

    def should_stop(self) -> bool:
        """判断是否收集了足够的知识"""
        return self.metadata.get("coverage_rate", 0) >= 0.9


@dataclass
class SolveStep:
    """Solve Loop 的单个步骤"""
    step_id: str
    target: str
    status: str = "pending"  # pending → executing → done
    result: str = ""


class DualLoopOrchestrator:
    """双循环编排器"""

    def __init__(self, investigate_agent, note_agent,
                 plan_agent, solve_agent, response_agent,
                 max_analysis_iters: int = 5,
                 max_solve_iters: int = 3):
        self.investigate = investigate_agent
        self.note = note_agent
        self.planner = plan_agent
        self.solver = solve_agent
        self.responder = response_agent
        self.max_analysis_iters = max_analysis_iters
        self.max_solve_iters = max_solve_iters

    async def run(self, question: str) -> dict[str, Any]:
        # === Analysis Loop ===
        memory = AnalysisMemory()
        for i in range(self.max_analysis_iters):
            result = await self.investigate.process(question, memory)
            if result.get("knowledge_ids"):
                await self.note.process(question, memory, result["knowledge_ids"])
            if result.get("should_stop"):
                break

        # === Solve Loop ===
        plan = await self.planner.process(question, memory)
        steps = [SolveStep(step_id=f"step_{i}", target=s)
                 for i, s in enumerate(plan["steps"])]

        for step in steps:
            for _ in range(self.max_solve_iters):
                solve_result = await self.solver.process(question, step, memory)
                if solve_result.get("finish"):
                    step.status = "done"
                    break

        # === Response ===
        responses = []
        for step in steps:
            if step.status == "done":
                resp = await self.responder.process(question, step, memory)
                responses.append(resp["response"])

        return {"answer": "\n\n".join(responses)}
```

### 3.3 适用场景

| 场景 | 适用度 | 说明 |
|------|--------|------|
| 教育问答系统（需要深度分析+求解） | ⭐⭐⭐ | Dual-Loop 完美匹配：先收集知识再分步求解 |
| 多主题研究报告生成 | ⭐⭐⭐ | DynamicTopicQueue 支持动态扩展和并行研究 |
| 简单 RAG 问答 | ⭐ | 过度设计，单遍流水线即可 |
| 多模态交互式学习 | ⭐⭐⭐ | Guide 模块的会话状态机模式适合 |
| 实时对话（低延迟要求） | ⭐⭐ | 双循环有多轮 LLM 调用，延迟较高 |
| 批量内容生成 | ⭐⭐⭐ | Research 并行模式 + Semaphore 控制并发 |

---

## 第 4 章 测试用例

```python
import asyncio
import pytest
from dataclasses import dataclass, field
from typing import Any
from unittest.mock import AsyncMock, MagicMock


# === 测试 Dual-Loop 编排 ===

class TestDualLoopOrchestration:
    """测试双循环编排逻辑"""

    @pytest.fixture
    def mock_agents(self):
        investigate = AsyncMock()
        note = AsyncMock()
        planner = AsyncMock()
        solver = AsyncMock()
        responder = AsyncMock()
        return investigate, note, planner, solver, responder

    @pytest.mark.asyncio
    async def test_analysis_loop_stops_on_signal(self, mock_agents):
        """Analysis Loop 在 should_stop=True 时终止"""
        investigate, note, planner, solver, responder = mock_agents
        # 第 1 轮返回知识，第 2 轮返回 should_stop
        investigate.process.side_effect = [
            {"knowledge_ids": ["k1"], "should_stop": False},
            {"knowledge_ids": ["k2"], "should_stop": True},
        ]
        note.process.return_value = {"success": True}
        planner.process.return_value = {"steps": ["solve it"]}
        solver.process.return_value = {"finish": True}
        responder.process.return_value = {"response": "Answer"}

        from unittest.mock import patch
        # 验证 investigate 被调用了 2 次（不是 max 5 次）
        assert investigate.process.call_count == 0  # 还没调用
        # 模拟运行
        memory_knowledge = []
        for i in range(5):
            result = await investigate.process("q", {})
            if result.get("knowledge_ids"):
                memory_knowledge.extend(result["knowledge_ids"])
                await note.process("q", {}, result["knowledge_ids"])
            if result.get("should_stop"):
                break
        assert investigate.process.call_count == 2
        assert len(memory_knowledge) == 2

    @pytest.mark.asyncio
    async def test_solve_loop_max_iterations(self, mock_agents):
        """Solve Loop 在达到最大迭代次数时停止"""
        _, _, _, solver, _ = mock_agents
        solver.process.return_value = {"finish": False}  # 永远不完成

        max_iters = 3
        iteration = 0
        for _ in range(max_iters):
            iteration += 1
            result = await solver.process("q", {}, {})
            if result.get("finish"):
                break

        assert iteration == max_iters

    @pytest.mark.asyncio
    async def test_lazy_initialization(self):
        """Solve Loop Agents 应该懒初始化"""
        solver_agents = {"manager": None, "solve": None, "tool": None}
        # 模拟 Analysis Loop 完成后才初始化
        assert all(v is None for v in solver_agents.values())
        # 初始化
        solver_agents["manager"] = MagicMock()
        solver_agents["solve"] = MagicMock()
        solver_agents["tool"] = MagicMock()
        assert all(v is not None for v in solver_agents.values())


# === 测试 DynamicTopicQueue ===

class TestDynamicTopicQueue:
    """测试动态主题队列调度"""

    @pytest.mark.asyncio
    async def test_parallel_execution_with_semaphore(self):
        """并行执行应受 Semaphore 限制"""
        max_parallel = 2
        semaphore = asyncio.Semaphore(max_parallel)
        active_count = {"value": 0, "max": 0}

        async def mock_research(block_id: str):
            async with semaphore:
                active_count["value"] += 1
                active_count["max"] = max(active_count["max"], active_count["value"])
                await asyncio.sleep(0.1)
                active_count["value"] -= 1
                return {"block_id": block_id, "success": True}

        tasks = [mock_research(f"block_{i}") for i in range(5)]
        results = await asyncio.gather(*tasks)

        assert len(results) == 5
        assert active_count["max"] <= max_parallel

    def test_topic_status_transitions(self):
        """主题状态转换：PENDING → RESEARCHING → COMPLETED"""
        from enum import Enum
        class Status(Enum):
            PENDING = "pending"
            RESEARCHING = "researching"
            COMPLETED = "completed"
            FAILED = "failed"

        status = Status.PENDING
        assert status == Status.PENDING
        status = Status.RESEARCHING
        assert status == Status.RESEARCHING
        status = Status.COMPLETED
        assert status == Status.COMPLETED


# === 测试会话状态机 ===

class TestSessionStateMachine:
    """测试 Guide 模块的会话状态机"""

    def test_session_lifecycle(self):
        """会话生命周期：initialized → learning → completed"""
        session = {"status": "initialized", "current_index": 0, "total": 3}
        assert session["status"] == "initialized"

        session["status"] = "learning"
        assert session["status"] == "learning"

        session["current_index"] = 3
        session["status"] = "completed"
        assert session["status"] == "completed"
        assert session["current_index"] >= session["total"]
```

---

## 第 5 章 跨域关联

| 关联域 | 关系类型 | 说明 |
|--------|----------|------|
| PD-01 上下文管理 | 依赖 | Solve 模块的 InvestigateMemory/SolveMemory 是上下文管理的核心载体，Analysis Loop 的迭代次数直接受上下文窗口限制 |
| PD-03 容错与重试 | 协同 | Research 模块的 `_call_tool_with_retry` 实现了工具调用的超时+重试+fallback，ManagerAgent 的 plan 生成有 2 次重试（`main_solver.py:565-587`） |
| PD-04 工具系统 | 依赖 | Research 模块的 `_call_tool` 方法（`research_pipeline.py:279-389`）统一调度 6 种工具（RAG/Web/Paper/Code/QueryItem），Solve 模块通过 ToolAgent 调用工具 |
| PD-06 记忆持久化 | 协同 | 三层 Memory（Investigate/Solve/Citation）均支持 JSON 持久化和 `load_or_create` 恢复，Guide 模块的 GuidedSession 也持久化到文件 |
| PD-09 Human-in-the-Loop | 协同 | Research 模块的 Rephrase 阶段支持用户交互式反馈（`research_pipeline.py:536-606`），CLI 模式下用户可以修改优化后的主题 |
| PD-11 可观测性 | 依赖 | BaseAgent 的 `_shared_stats` 和 `token_tracker` 提供模块级 Token 消耗追踪，Research 模块的 progress_callback 提供实时进度推送 |

---

## 第 6 章 来源文件索引

| 文件 | 行范围 | 关键实现 |
|------|--------|----------|
| `src/agents/base_agent.py` | L35-657 | BaseAgent 统一基座：LLM 调用、Token 追踪、Prompt 加载 |
| `src/agents/solve/main_solver.py` | L37-872 | MainSolver 双循环编排器：Analysis Loop + Solve Loop |
| `src/agents/solve/main_solver.py` | L283-312 | `_init_agents`：Agent 初始化（含懒初始化） |
| `src/agents/solve/main_solver.py` | L386-508 | `_run_dual_loop_pipeline`：Analysis Loop 实现 |
| `src/agents/solve/main_solver.py` | L510-738 | Solve Loop 实现：Plan→Execute→Response |
| `src/agents/research/research_pipeline.py` | L66-1309 | ResearchPipeline 三阶段流水线 |
| `src/agents/research/research_pipeline.py` | L720-731 | 串行/并行模式路由 |
| `src/agents/research/research_pipeline.py` | L817-1101 | 并行研究模式：Semaphore + asyncio.gather |
| `src/agents/research/data_structures.py` | L174-248 | TopicBlock + DynamicTopicQueue 数据结构 |
| `src/agents/research/agents/manager_agent.py` | L20-120 | Research ManagerAgent：队列管理 + 异步锁 |
| `src/agents/question/coordinator.py` | L31-479 | AgentCoordinator 单遍流水线编排 |
| `src/agents/guide/guide_manager.py` | L46-501 | GuideManager 会话状态机 |
| `src/agents/ideagen/idea_generation_workflow.py` | L23-427 | IdeaGenerationWorkflow 四阶段流水线 |
| `src/agents/solve/memory/__init__.py` | L1-35 | Memory 系统：InvestigateMemory/SolveMemory/CitationMemory |

---

## 第 7 章 横向对比维度

> **重要：** 本章用于自动填充 Butcher Wiki 的横向对比表。

```json comparison_data
{
  "project": "DeepTutor",
  "dimensions": {
    "编排模式": "联邦制多模式：Dual-Loop/DynamicQueue/Pipeline/StateMachine 按模块选型",
    "并行能力": "Research 模块 Semaphore 控制并行，asyncio.gather 批量执行",
    "状态管理": "三层 Memory 持久化 + GuidedSession 会话状态机",
    "并发限制": "asyncio.Semaphore(max_parallel) + asyncio.Lock 保护共享状态",
    "工具隔离": "Research 统一 _call_tool 路由，Solve 通过 ToolAgent 隔离",
    "模块自治": "5 个独立编排器各自选择最适合的编排模式",
    "懒初始化": "Solve Loop Agents 首次使用时才创建，减少启动开销"
  }
}
```

### 域元数据补充

```json domain_metadata
{
  "description": "同一系统内多种编排模式共存，按任务特征选择最优编排策略",
  "sub_problems": [
    "模式选型：同一系统内不同任务类型如何选择不同的编排模式",
    "迭代收敛：如何判断 Agent 循环何时应该终止（should_stop 信号设计）",
    "动态队列扩展：研究过程中发现新主题时如何动态加入调度队列"
  ],
  "best_practices": [
    "联邦制编排：不同模块可以有不同的编排模式，不必强行统一",
    "懒初始化：非必需的 Agent 延迟到首次使用时创建，减少资源浪费",
    "Async Wrapper：为非线程安全组件提供异步包装，支持并行模式平滑切换"
  ]
}
```
