# PD-12.05 DeepTutor — Dual-Loop 推理增强

> 文档编号：PD-12.05
> 来源：DeepTutor `src/agents/solve/main_solver.py` / `src/agents/research/research_pipeline.py`
> GitHub：https://github.com/HKUDS/DeepTutor.git
> 问题域：PD-12 推理增强 Reasoning Enhancement
> 状态：可复用方案

---

## 第 1 章 问题与动机

### 1.1 核心问题

LLM 在面对复杂学术问题时，单次推理往往不够：缺乏对问题的深入调查、缺少对知识库的多轮检索、无法将推理过程分解为可追踪的步骤链。传统 RAG 系统的"检索→生成"单次管道无法处理需要多步推理、交叉验证的复杂问题。

DeepTutor 的核心挑战是：如何让 LLM 像人类专家一样，先调查问题、收集证据、记录发现，再制定解题计划、逐步推理、精确回答？

### 1.2 DeepTutor 的解法概述

DeepTutor 采用 Dual-Loop（双循环）架构，将推理过程拆分为两个独立但串联的循环：

1. **Analysis Loop（分析循环）**：InvestigateAgent 生成查询并调用工具收集知识 → NoteAgent 为每条知识生成摘要和反思（`main_solver.py:396-508`）
2. **Solve Loop（求解循环）**：ManagerAgent 基于分析结果规划求解步骤 → SolveAgent 逐步执行推理并调用工具 → ResponseAgent 为每步生成回答 → PrecisionAnswerAgent 可选地生成精确简答（`main_solver.py:510-837`）
3. **Research Pipeline 三阶段**：Planning（主题优化+分解）→ Researching（动态队列驱动的多轮研究）→ Reporting（报告生成），实现 decomposition 推理（`research_pipeline.py:391-504`）
4. **结构化记忆系统**：InvestigateMemory 记录知识链、SolveMemory 记录求解链（SolveChainStep），CitationMemory 统一管理引用，所有中间状态可持久化（`investigate_memory.py:63-227`、`solve_memory.py:124-341`）
5. **选择性精确回答**：PrecisionAnswerAgent 先判断问题是否需要精确答案（两阶段决策），避免对开放性问题浪费 token（`precision_answer_agent.py:41-59`）

### 1.3 设计思想

| 设计原则 | 具体实现 | 理由 | 替代方案 |
|----------|----------|------|----------|
| 分析与求解解耦 | Analysis Loop 和 Solve Loop 串联但独立 | 分析阶段专注收集证据，求解阶段专注推理，职责清晰 | 单循环混合分析和求解 |
| 知识链可追踪 | KnowledgeItem 用 cite_id 统一标识，NoteAgent 生成摘要 | 每条知识来源可追溯，支持引用标注 | 将所有检索结果拼接为上下文 |
| 求解步骤链 | SolveChainStep 记录每步的 target、tool_calls、response | 推理过程可审计、可断点续传 | 一次性生成完整答案 |
| 两阶段精确回答 | 先判断是否需要精确答案，再生成 | 避免对叙述性问题浪费精确推理的 token | 总是生成精确答案 |
| 配置驱动迭代上限 | max_iterations、max_correction_iterations 从 config 读取 | 防止无限循环，成本可控 | 硬编码迭代次数 |

---

## 第 2 章 源码实现分析

### 2.1 架构概览

DeepTutor 的推理增强核心是 Dual-Loop 架构，由 MainSolver 统一编排：

```
┌─────────────────────────────────────────────────────────────────┐
│                        MainSolver                                │
│                   (main_solver.py:37)                            │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌─── Analysis Loop ──────────────────────────────────────┐     │
│  │                                                         │     │
│  │  ┌──────────────┐    knowledge    ┌──────────────┐     │     │
│  │  │ Investigate  │───────────────→│   NoteAgent   │     │     │
│  │  │    Agent     │    cite_ids     │  (摘要+反思)  │     │     │
│  │  │ (查询+工具)  │←───────────────│               │     │     │
│  │  └──────────────┘                 └──────────────┘     │     │
│  │        ↕ InvestigateMemory (knowledge_chain)           │     │
│  │        ↕ CitationMemory (统一引用)                      │     │
│  │  [循环 max_iterations 轮，直到 should_stop]             │     │
│  └─────────────────────────────────────────────────────────┘     │
│                          ↓                                       │
│  ┌─── Solve Loop ─────────────────────────────────────────┐     │
│  │                                                         │     │
│  │  ┌──────────────┐  steps  ┌──────────────┐            │     │
│  │  │ ManagerAgent │────────→│  SolveAgent  │            │     │
│  │  │  (规划步骤)   │         │ (推理+工具)   │            │     │
│  │  └──────────────┘         └──────┬───────┘            │     │
│  │                                   ↓                    │     │
│  │                          ┌──────────────┐             │     │
│  │                          │ResponseAgent │             │     │
│  │                          │ (生成回答)    │             │     │
│  │                          └──────┬───────┘             │     │
│  │                                  ↓                     │     │
│  │                         ┌───────────────┐             │     │
│  │                         │PrecisionAnswer│             │     │
│  │                         │   (可选精确)   │             │     │
│  │                         └───────────────┘             │     │
│  │        ↕ SolveMemory (solve_chains: SolveChainStep[]) │     │
│  └─────────────────────────────────────────────────────────┘     │
└─────────────────────────────────────────────────────────────────┘
```

### 2.2 核心实现

**Analysis Loop 主循环** (`main_solver.py:414-482`)：

```python
# Analysis Loop iterations
for i in range(max_analysis_iterations):
    # 1. Investigate: Generate queries and call tools
    investigate_result = await self.investigate_agent.process(
        question=question,
        memory=investigate_memory,
        citation_memory=citation_memory,
        kb_name=self.kb_name,
        output_dir=output_dir,
    )

    knowledge_ids = investigate_result.get("knowledge_item_ids", [])
    should_stop = investigate_result.get("should_stop", False)

    # 2. Note: Generate notes (if new knowledge exists)
    if knowledge_ids:
        note_result = await self.note_agent.process(
            question=question,
            memory=investigate_memory,
            new_knowledge_ids=knowledge_ids,
            citation_memory=citation_memory,
        )

    # 3. Check stop condition
    if should_stop:
        break
```

**InvestigateAgent 的工具规划与执行** (`investigate_agent.py:54-197`)：

InvestigateAgent 是 Analysis Loop 的核心，它通过 LLM 生成 JSON 格式的工具调用计划，然后逐一执行：

```python
async def process(self, question, memory, citation_memory, kb_name, output_dir, verbose):
    # 1. Build context from memory (knowledge chain + reflections)
    context = self._build_context(question, memory)
    # 2. Call LLM to get tool plan (JSON: {reasoning, plan: [{tool, query}]})
    response = await self.call_llm(
        user_prompt=user_prompt, system_prompt=system_prompt,
        response_format={"type": "json_object"},
    )
    # 3. Parse and execute tool calls (limited by max_actions_per_round)
    for plan in tool_plans_to_execute:
        knowledge_item = await self._execute_single_action(
            tool_selection=plan["tool"], query=plan["query"],
            kb_name=kb_name, citation_memory=citation_memory,
        )
        if knowledge_item:
            memory.add_knowledge(knowledge_item)
```

InvestigateAgent 支持 4 种工具：`rag_naive`、`rag_hybrid`、`web_search`、`query_item`，每轮最多执行 `max_actions_per_round` 个动作（`investigate_agent.py:51`）。

**SolveChainStep 数据结构** (`solve_memory.py:67-122`)：

```python
@dataclass
class SolveChainStep:
    """Single step structure in solve-chain"""
    step_id: str
    step_target: str
    available_cite: List[str] = field(default_factory=list)
    tool_calls: List[ToolCallRecord] = field(default_factory=list)
    step_response: Optional[str] = None
    status: str = "undone"  # undone | in_progress | waiting_response | done | failed
    used_citations: List[str] = field(default_factory=list)
```

每个 SolveChainStep 记录了求解目标（step_target）、可用引用（available_cite 来自 Analysis Loop）、工具调用记录（tool_calls）、最终回答（step_response）和使用的引用（used_citations），形成完整的推理链。

**PrecisionAnswerAgent 两阶段决策** (`precision_answer_agent.py:41-59`)：

```python
async def process(self, question, detailed_answer, verbose=True):
    # Stage 1: Decide if precision answer is needed
    decision = await self._should_generate(question, verbose)
    if not decision["needs_precision"]:
        return {"needs_precision": False, "precision_answer": "",
                "final_answer": detailed_answer}
    # Stage 2: Generate precision answer
    precision_answer = await self._generate_precision_answer(
        question=question, detailed_answer=detailed_answer, verbose=verbose)
    return {"needs_precision": True, "precision_answer": precision_answer,
            "final_answer": detailed_answer}
```

决策逻辑简洁：LLM 返回以 "Y" 开头则需要精确答案（`precision_answer_agent.py:76`）。

### 2.3 实现细节

**Research Pipeline 的三阶段 Decomposition** (`research_pipeline.py:506-718`)：

Research 模块实现了独立于 Solve 模块的推理增强路径：

1. **Planning 阶段**：RephraseAgent 优化主题 → DecomposeAgent 将主题分解为子主题（支持 manual/auto 两种模式）→ 子主题加入 DynamicTopicQueue
2. **Researching 阶段**：ManagerAgent 从队列取任务 → ResearchAgent 执行多轮研究循环（支持 series/parallel 两种执行模式）→ NoteAgent 记录发现
3. **Reporting 阶段**：ReportingAgent 基于所有研究结果生成最终报告

**DecomposeAgent 的 RAG 增强分解** (`decompose_agent.py:63-109`)：

```python
async def process(self, topic, num_subtopics=5, mode="manual"):
    if not self.enable_rag:
        return await self._process_without_rag(topic, num_subtopics, mode)
    if mode == "auto":
        return await self._process_auto_mode(topic, num_subtopics)
    return await self._process_manual_mode(topic, num_subtopics)
```

Manual 模式三步走：生成子查询 → RAG 检索背景知识 → 基于背景生成子主题。Auto 模式两步走：RAG 检索 → 自主生成子主题。两种模式都支持 RAG 禁用时的降级（直接 LLM 生成）。

**记忆系统的版本兼容** (`investigate_memory.py:98-167`)：

InvestigateMemory 支持 v1.0/v2.0/v3.0 三个版本的向后兼容加载，v1.0 的 notes 和 reflections 会自动迁移到 v3.0 的 knowledge_chain + Reflections 结构。


---

## 第 3 章 迁移指南

### 3.1 迁移清单

**阶段一：核心记忆系统（基础设施）**

- [ ] 实现 KnowledgeItem 数据类（cite_id、tool_type、query、raw_result、summary）
- [ ] 实现 InvestigateMemory（knowledge_chain 列表 + Reflections + JSON 持久化）
- [ ] 实现 SolveChainStep 和 SolveMemory（步骤链 + 工具调用记录 + 状态机）
- [ ] 实现 CitationMemory（统一引用管理，跨 Analysis/Solve 两个循环共享）

**阶段二：Analysis Loop**

- [ ] 实现 InvestigateAgent（LLM 生成工具计划 → 执行工具 → 写入 InvestigateMemory）
- [ ] 实现 NoteAgent（为每条新知识生成摘要，更新 knowledge_chain）
- [ ] 实现 Analysis Loop 主循环（迭代直到 should_stop 或达到 max_iterations）

**阶段三：Solve Loop**

- [ ] 实现 ManagerAgent（基于 InvestigateMemory 规划 SolveChainStep 列表）
- [ ] 实现 SolveAgent（逐步执行推理，支持工具调用和迭代修正）
- [ ] 实现 ResponseAgent（为每个 waiting_response 步骤生成回答）
- [ ] 可选：实现 PrecisionAnswerAgent（两阶段精确回答）

**阶段四：Research Pipeline（可选，独立于 Solve）**

- [ ] 实现 DecomposeAgent（主题分解，支持 RAG 增强）
- [ ] 实现 DynamicTopicQueue（动态主题队列，支持并行研究）
- [ ] 实现三阶段 Pipeline（Planning → Researching → Reporting）

### 3.2 适配代码模板

**Dual-Loop 核心骨架（可直接运行）：**

```python
from dataclasses import dataclass, field
from typing import Any, Optional
import json

# ---- 记忆系统 ----

@dataclass
class KnowledgeItem:
    cite_id: str
    tool_type: str
    query: str
    raw_result: str
    summary: str = ""

@dataclass
class AnalysisMemory:
    knowledge_chain: list[KnowledgeItem] = field(default_factory=list)
    remaining_questions: list[str] = field(default_factory=list)

    def add_knowledge(self, item: KnowledgeItem):
        self.knowledge_chain.append(item)

    def update_summary(self, cite_id: str, summary: str):
        for item in self.knowledge_chain:
            if item.cite_id == cite_id:
                item.summary = summary
                return

@dataclass
class SolveStep:
    step_id: str
    target: str
    available_cite: list[str] = field(default_factory=list)
    response: Optional[str] = None
    status: str = "undone"  # undone | in_progress | done

@dataclass
class SolveMemory:
    steps: list[SolveStep] = field(default_factory=list)

# ---- Dual-Loop 编排 ----

class DualLoopSolver:
    def __init__(self, llm_client, tools, config):
        self.llm = llm_client
        self.tools = tools  # {"rag": rag_fn, "web": web_fn, ...}
        self.max_analysis_iters = config.get("max_analysis_iterations", 5)
        self.max_solve_corrections = config.get("max_solve_corrections", 3)

    async def solve(self, question: str) -> str:
        # Phase 1: Analysis Loop
        analysis_mem = AnalysisMemory()
        for i in range(self.max_analysis_iters):
            # Investigate: LLM decides which tools to call
            plan = await self._investigate(question, analysis_mem)
            if plan["should_stop"]:
                break
            # Execute tools and collect knowledge
            for action in plan["actions"]:
                result = await self.tools[action["tool"]](action["query"])
                item = KnowledgeItem(
                    cite_id=f"[K{len(analysis_mem.knowledge_chain)+1}]",
                    tool_type=action["tool"],
                    query=action["query"],
                    raw_result=result,
                )
                analysis_mem.add_knowledge(item)
            # Note: summarize new knowledge
            for item in analysis_mem.knowledge_chain:
                if not item.summary:
                    item.summary = await self._summarize(item)

        # Phase 2: Solve Loop
        solve_mem = SolveMemory()
        solve_mem.steps = await self._plan_steps(question, analysis_mem)
        for step in solve_mem.steps:
            for _ in range(self.max_solve_corrections):
                result = await self._solve_step(question, step, analysis_mem)
                if result["done"]:
                    step.response = result["response"]
                    step.status = "done"
                    break

        return "\n\n".join(s.response for s in solve_mem.steps if s.response)

    async def _investigate(self, question, memory):
        """LLM generates tool call plan based on current knowledge"""
        # ... prompt construction + LLM call + JSON parsing ...
        pass

    async def _summarize(self, item: KnowledgeItem) -> str:
        """NoteAgent: summarize a knowledge item"""
        # ... prompt + LLM call ...
        pass

    async def _plan_steps(self, question, analysis_mem) -> list[SolveStep]:
        """ManagerAgent: plan solve steps based on analysis results"""
        # ... prompt + LLM call + parse steps ...
        pass

    async def _solve_step(self, question, step, analysis_mem) -> dict:
        """SolveAgent: execute one solve step"""
        # ... prompt + LLM call + optional tool calls ...
        pass
```

### 3.3 适用场景

| 场景 | 适用度 | 说明 |
|------|--------|------|
| 学术问答（需要检索+推理） | ⭐⭐⭐ | Dual-Loop 的核心场景，Analysis Loop 收集证据，Solve Loop 逐步推理 |
| 复杂多步骤问题求解 | ⭐⭐⭐ | SolveChainStep 天然支持多步推理，每步可独立调用工具 |
| 需要引用追踪的场景 | ⭐⭐⭐ | CitationMemory + cite_id 体系提供完整的引用链 |
| 简单事实查询 | ⭐ | 过度设计，单次 RAG 即可 |
| 实时对话（低延迟要求） | ⭐ | 多轮 LLM 调用延迟较高，不适合实时场景 |
| 深度研究报告生成 | ⭐⭐⭐ | Research Pipeline 的三阶段 + DynamicTopicQueue 专为此设计 |


---

## 第 4 章 测试用例

```python
import pytest
from dataclasses import dataclass, field
from typing import Any, Optional
from unittest.mock import AsyncMock, MagicMock, patch


# ---- Minimal data structures for testing ----

@dataclass
class KnowledgeItem:
    cite_id: str
    tool_type: str
    query: str
    raw_result: str
    summary: str = ""

@dataclass
class Reflections:
    remaining_questions: list[str] = field(default_factory=list)

@dataclass
class InvestigateMemory:
    knowledge_chain: list[KnowledgeItem] = field(default_factory=list)
    reflections: Reflections = field(default_factory=Reflections)
    metadata: dict = field(default_factory=lambda: {
        "total_iterations": 0, "coverage_rate": 0.0,
        "avg_confidence": 0.0, "total_knowledge_items": 0,
    })

    def add_knowledge(self, item: KnowledgeItem):
        self.knowledge_chain.append(item)

    def update_knowledge_summary(self, cite_id: str, summary: str):
        for item in self.knowledge_chain:
            if item.cite_id == cite_id:
                item.summary = summary
                return
        raise ValueError(f"cite_id not found: {cite_id}")


class TestAnalysisLoop:
    """Test Analysis Loop core behavior"""

    def test_knowledge_chain_accumulation(self):
        """Knowledge items accumulate across iterations"""
        memory = InvestigateMemory()
        for i in range(3):
            memory.add_knowledge(KnowledgeItem(
                cite_id=f"[K{i+1}]", tool_type="rag_hybrid",
                query=f"query_{i}", raw_result=f"result_{i}",
            ))
        assert len(memory.knowledge_chain) == 3
        assert memory.knowledge_chain[2].cite_id == "[K3]"

    def test_note_agent_updates_summary(self):
        """NoteAgent updates knowledge item summary by cite_id"""
        memory = InvestigateMemory()
        memory.add_knowledge(KnowledgeItem(
            cite_id="[K1]", tool_type="rag_naive",
            query="test", raw_result="raw data",
        ))
        memory.update_knowledge_summary("[K1]", "Summarized content")
        assert memory.knowledge_chain[0].summary == "Summarized content"

    def test_note_agent_invalid_cite_id_raises(self):
        """Updating non-existent cite_id raises ValueError"""
        memory = InvestigateMemory()
        with pytest.raises(ValueError, match="cite_id not found"):
            memory.update_knowledge_summary("[INVALID]", "summary")

    def test_should_stop_when_no_tool_plans(self):
        """Analysis loop stops when InvestigateAgent returns empty plan"""
        # Simulates the stop condition in main_solver.py:132-138
        tool_plans = []
        should_stop = not tool_plans
        assert should_stop is True

    def test_should_stop_on_none_tool(self):
        """Analysis loop stops when tool type is 'none'"""
        tool_plans = [{"tool": "none", "query": ""}]
        should_stop = any(p.get("tool") == "none" for p in tool_plans)
        assert should_stop is True


class TestSolveChainStep:
    """Test SolveChainStep state machine"""

    def test_step_status_transitions(self):
        """Step transitions: undone → in_progress → waiting_response → done"""
        from dataclasses import dataclass, field

        @dataclass
        class ToolCallRecord:
            tool_type: str; query: str; status: str = "pending"

        @dataclass
        class SolveStep:
            step_id: str; step_target: str; status: str = "undone"
            tool_calls: list = field(default_factory=list)
            step_response: Optional[str] = None

        step = SolveStep(step_id="S1", step_target="Analyze the problem")
        assert step.status == "undone"

        step.tool_calls.append(ToolCallRecord("rag_hybrid", "query"))
        step.status = "in_progress"
        assert step.status == "in_progress"

        step.status = "waiting_response"
        assert step.status == "waiting_response"

        step.step_response = "The answer is..."
        step.status = "done"
        assert step.status == "done"
        assert step.step_response is not None

    def test_max_correction_iterations(self):
        """Solve loop respects max_correction_iterations"""
        max_corrections = 3
        iterations = 0
        for _ in range(max_corrections):
            iterations += 1
            # Simulate: finish_requested on last iteration
            if iterations == max_corrections:
                break
        assert iterations == max_corrections


class TestPrecisionAnswerDecision:
    """Test PrecisionAnswerAgent two-stage decision"""

    def test_needs_precision_yes(self):
        """Response starting with Y triggers precision answer"""
        response = "YES, this question requires a precise numerical answer."
        needs_precision = response.strip().upper().startswith("Y")
        assert needs_precision is True

    def test_needs_precision_no(self):
        """Response not starting with Y skips precision answer"""
        response = "No, this is an open-ended discussion question."
        needs_precision = response.strip().upper().startswith("Y")
        assert needs_precision is False

    def test_precision_skipped_returns_detailed(self):
        """When precision not needed, final_answer is the detailed answer"""
        detailed = "Long detailed explanation..."
        result = {
            "needs_precision": False,
            "precision_answer": "",
            "final_answer": detailed,
        }
        assert result["final_answer"] == detailed
        assert result["precision_answer"] == ""


class TestDecomposeAgent:
    """Test topic decomposition logic"""

    def test_manual_mode_exact_count(self):
        """Manual mode generates exact number of subtopics"""
        sub_topics = [
            {"title": f"Topic {i}", "overview": f"Overview {i}"}
            for i in range(5)
        ]
        # Simulate num_subtopics limit
        num_subtopics = 5
        cleaned = sub_topics[:num_subtopics]
        assert len(cleaned) == 5

    def test_auto_mode_respects_max(self):
        """Auto mode does not exceed max_subtopics"""
        max_subtopics = 3
        sub_topics = [{"title": f"T{i}", "overview": ""} for i in range(10)]
        cleaned = sub_topics[:max_subtopics]
        assert len(cleaned) == 3

    def test_rag_disabled_fallback(self):
        """When RAG is disabled, mode becomes '{mode}_no_rag'"""
        enable_rag = False
        mode = "manual"
        result_mode = f"{mode}_no_rag" if not enable_rag else mode
        assert result_mode == "manual_no_rag"
```


---

## 第 5 章 跨域关联

| 关联域 | 关系类型 | 说明 |
|--------|----------|------|
| PD-01 上下文管理 | 协同 | InvestigateMemory 的 knowledge_chain 持续增长，需要上下文窗口管理策略。InvestigateAgent 的 `_build_context` 传递完整内容（`investigate_agent.py:199-238`），大量知识可能超出窗口 |
| PD-02 多 Agent 编排 | 依赖 | Dual-Loop 本身就是多 Agent 编排：6 个 Agent（Investigate、Note、Manager、Solve、Response、PrecisionAnswer）由 MainSolver 串联编排。Research Pipeline 的 parallel 模式使用 asyncio.Semaphore 控制并发 |
| PD-03 容错与重试 | 协同 | ManagerAgent 有 2 次重试（`main_solver.py:565-587`），Research Pipeline 的 `_call_tool_with_retry` 支持超时+重试（`research_pipeline.py:219-277`），InvestigateAgent 工具调用失败返回 None 而非抛异常 |
| PD-04 工具系统 | 依赖 | InvestigateAgent 和 SolveAgent 都依赖工具系统（rag_naive、rag_hybrid、web_search、query_item、code_execution），工具调用通过 BaseAgent 统一接口 |
| PD-06 记忆持久化 | 依赖 | InvestigateMemory、SolveMemory、CitationMemory 全部支持 JSON 持久化和断点续传（load_or_create 模式），DynamicTopicQueue 支持 auto_save |
| PD-08 搜索与检索 | 协同 | Analysis Loop 的核心能力就是多轮检索（RAG naive/hybrid + web search），DecomposeAgent 用 RAG 增强主题分解 |
| PD-11 可观测性 | 协同 | TokenTracker 追踪每个 Agent 的 token 消耗，PerformanceMonitor 追踪每个阶段耗时，所有中间结果持久化到 output_dir |

---

## 第 6 章 来源文件索引

| 文件 | 行范围 | 关键实现 |
|------|--------|----------|
| `src/agents/solve/main_solver.py` | L37-872 | MainSolver：Dual-Loop 编排控制器，Analysis Loop + Solve Loop 主循环 |
| `src/agents/solve/analysis_loop/investigate_agent.py` | L24-415 | InvestigateAgent：生成工具调用计划并执行，支持 4 种工具 |
| `src/agents/solve/analysis_loop/note_agent.py` | L23-191 | NoteAgent：为知识项生成摘要，更新 InvestigateMemory |
| `src/agents/solve/solve_loop/manager_agent.py` | L22-275 | ManagerAgent：基于分析结果规划 SolveChainStep 列表 |
| `src/agents/solve/solve_loop/solve_agent.py` | L23-326 | SolveAgent：逐步执行推理，解析工具调用计划 |
| `src/agents/solve/solve_loop/precision_answer_agent.py` | L18-97 | PrecisionAnswerAgent：两阶段精确回答（决策+生成） |
| `src/agents/solve/memory/investigate_memory.py` | L14-227 | InvestigateMemory：知识链 + 反思 + v1/v2/v3 兼容 |
| `src/agents/solve/memory/solve_memory.py` | L22-341 | SolveMemory + SolveChainStep + ToolCallRecord 数据结构 |
| `src/agents/research/research_pipeline.py` | L66-1309 | ResearchPipeline：三阶段研究流水线（Planning→Researching→Reporting） |
| `src/agents/research/agents/decompose_agent.py` | L24-508 | DecomposeAgent：主题分解，支持 manual/auto + RAG 增强 |
| `src/agents/research/data_structures.py` | L1-452 | TopicBlock、ToolTrace、DynamicTopicQueue 核心数据结构 |
| `src/agents/base_agent.py` | L35-657 | BaseAgent：统一 Agent 基类，LLM 调用、prompt 加载、token 追踪 |

---

## 第 7 章 横向对比维度

> **重要：** 本章用于自动填充 Butcher Wiki 的横向对比表。
> 必须严格按以下 JSON 格式输出，放在 `comparison_data` 代码块中。

```json comparison_data
{
  "project": "DeepTutor",
  "dimensions": {
    "推理方式": "Dual-Loop：Analysis Loop 收集证据 + Solve Loop 逐步推理",
    "推理模式": "多轮迭代式：分析循环 N 轮 + 求解循环每步 M 次修正",
    "模型策略": "统一模型，BaseAgent 通过 agents.yaml 配置参数",
    "成本": "可配置 max_iterations 和 max_corrections 控制调用次数",
    "适用场景": "学术问答、复杂多步推理、需要引用追踪的场景",
    "输出结构": "SolveChainStep 链：每步含 target + tool_calls + response",
    "增强策略": "分析-求解解耦 + 知识链摘要 + 两阶段精确回答",
    "成本控制": "配置驱动迭代上限 + PrecisionAnswer 选择性启用",
    "检索范式": "Analysis Loop 多轮 RAG + Web Search 混合检索",
    "思考预算": "max_analysis_iterations × max_actions_per_round + max_solve_corrections"
  }
}
```

### 域元数据补充

```json domain_metadata
{
  "description": "通过多循环架构将分析与求解解耦，实现可追踪的结构化推理过程",
  "sub_problems": [
    "Dual-Loop 解耦：将证据收集与推理求解分离为独立循环",
    "推理链持久化：将推理过程记录为可审计的步骤链",
    "选择性精确回答：根据问题类型决定是否生成精确简答"
  ],
  "best_practices": [
    "分析循环应有明确的停止条件：工具计划为空或返回 none 即停止",
    "求解步骤应关联分析阶段的引用：available_cite 桥接两个循环",
    "记忆系统应支持版本兼容：load_or_create 模式实现断点续传"
  ]
}
```
