# PD-12.03 GPT-Researcher — Chain-of-Thought 研究推理

> 文档编号：PD-12.03
> 来源：GPT-Researcher `gpt_researcher/master/agent.py` / `gpt_researcher/actions/`
> GitHub：https://github.com/assafelovic/gpt-researcher
> 问题域：PD-12 推理增强 Reasoning Enhancement
> 状态：可复用方案

---

## 第 1 章 问题与动机

### 1.1 核心问题

Agent 在执行研究任务时，如果直接搜索用户的原始查询，往往得到浅层结果：

```
用户: "AI Agent 的安全风险有哪些？"

直接搜索 → 返回 10 篇泛泛而谈的文章
  → 缺乏系统性：遗漏 prompt injection、数据泄露等关键方面
  → 缺乏深度：每个风险只有一句话描述
  → 缺乏结构：结果无逻辑组织
```

人类研究员不会这样做。他们会：
1. 先思考"AI Agent 安全"涉及哪些维度
2. 识别知识缺口：哪些维度我还不了解？
3. 制定搜索策略：每个维度用什么关键词搜索？
4. 逐步执行：搜索 → 分析 → 发现新问题 → 再搜索

这就是 Chain-of-Thought (CoT) 研究推理。

### 1.2 GPT-Researcher 的解法概述

GPT-Researcher 将 CoT 推理嵌入研究流程：

- **研究大纲生成**：LLM 先生成结构化研究大纲，明确需要覆盖的维度
- **知识缺口识别**：分析已有信息，识别缺失的关键知识点
- **搜索策略制定**：为每个知识缺口生成针对性的搜索查询
- **迭代深入**：每轮搜索后重新评估，决定是否需要进一步研究

### 1.3 设计思想

| 原则 | 说明 |
|------|------|
| 先思考后行动 | 搜索前先规划，避免盲目搜索 |
| 知识缺口驱动 | 搜索方向由"不知道什么"决定，而非"想知道什么" |
| 结构化推理 | 大纲 → 子问题 → 搜索 → 验证，每步有明确输出 |
| 迭代收敛 | 每轮搜索缩小知识缺口，直到覆盖率满足要求 |
| 可解释性 | 推理链路完整记录，支持回溯和审计 |

---

## 第 2 章 源码实现分析

### 2.1 研究大纲生成

```python
# 源码简化自 gpt_researcher/actions/query_processing.py
async def plan_research_outline(query: str, llm) -> dict:
    """LLM 生成结构化研究大纲"""
    prompt = f"""You are a research planner. Given the research topic,
create a structured outline that covers all important aspects.

Topic: {query}

Return a JSON object:
{{
  "title": "研究标题",
  "sections": [
    {{
      "heading": "章节标题",
      "key_questions": ["需要回答的关键问题"],
      "search_queries": ["建议的搜索查询"]
    }}
  ],
  "expected_depth": "shallow|medium|deep"
}}"""

    response = await llm.ainvoke(prompt)
    return json.loads(response.content)
```

### 2.2 知识缺口识别

```python
# 源码简化自 gpt_researcher/master/agent.py
async def identify_knowledge_gaps(
    query: str,
    outline: dict,
    collected_data: list[dict],
    llm,
) -> list[dict]:
    """分析已收集数据，识别知识缺口"""
    collected_summary = "\n".join(
        f"- {d['sub_query']}: {d.get('summary', '无摘要')[:200]}"
        for d in collected_data
    )

    sections_summary = "\n".join(
        f"- {s['heading']}: {', '.join(s['key_questions'])}"
        for s in outline.get("sections", [])
    )

    prompt = f"""分析以下研究进度，识别知识缺口。

研究主题: {query}

研究大纲要求覆盖:
{sections_summary}

已收集的数据:
{collected_summary}

识别尚未覆盖或覆盖不足的方面。返回 JSON:
[
  {{
    "gap": "缺口描述",
    "importance": "high|medium|low",
    "suggested_queries": ["建议搜索查询"]
  }}
]"""

    response = await llm.ainvoke(prompt)
    try:
        return json.loads(response.content)
    except json.JSONDecodeError:
        return []
```

### 2.3 搜索策略制定

```python
# 源码简化自 gpt_researcher/actions/query_processing.py
async def formulate_search_strategy(
    gaps: list[dict],
    existing_queries: list[str],
    llm,
) -> list[dict]:
    """为知识缺口制定搜索策略"""
    gaps_text = "\n".join(
        f"- [{g['importance']}] {g['gap']}" for g in gaps
    )
    existing_text = "\n".join(f"- {q}" for q in existing_queries)

    prompt = f"""为以下知识缺口制定搜索策略。

知识缺口:
{gaps_text}

已执行的搜索:
{existing_text}

要求:
1. 避免与已执行搜索重复
2. 高重要性缺口优先
3. 每个缺口 1-2 个精准搜索查询

返回 JSON:
[
  {{
    "gap": "对应的缺口",
    "query": "搜索查询",
    "strategy": "keyword|question|comparison",
    "expected_result": "期望获取的信息类型"
  }}
]"""

    response = await llm.ainvoke(prompt)
    try:
        return json.loads(response.content)
    except json.JSONDecodeError:
        # 降级：直接使用缺口中的建议查询
        fallback = []
        for gap in gaps:
            for q in gap.get("suggested_queries", []):
                fallback.append({"gap": gap["gap"], "query": q,
                                "strategy": "keyword", "expected_result": ""})
        return fallback
```

### 2.4 迭代研究循环

```python
# 源码简化自 gpt_researcher/master/agent.py
async def iterative_research(self, max_iterations: int = 3) -> str:
    """迭代式 CoT 研究：大纲 → 搜索 → 缺口分析 → 再搜索"""
    # Step 1: 生成研究大纲
    outline = await plan_research_outline(self.query, self.llm)
    collected_data = []
    executed_queries = []

    for iteration in range(max_iterations):
        # Step 2: 识别知识缺口
        if iteration == 0:
            # 首轮：从大纲生成初始查询
            queries = [
                q for section in outline["sections"]
                for q in section["search_queries"]
            ]
        else:
            # 后续轮：基于缺口生成查询
            gaps = await identify_knowledge_gaps(
                self.query, outline, collected_data, self.llm
            )
            if not gaps:
                break  # 无缺口，研究完成

            strategies = await formulate_search_strategy(
                gaps, executed_queries, self.llm
            )
            queries = [s["query"] for s in strategies]

        # Step 3: 执行搜索
        for query in queries:
            if query in executed_queries:
                continue
            results = await self._search_and_summarize(query)
            collected_data.append(results)
            executed_queries.append(query)

    # Step 4: 生成最终报告
    return await self._generate_report(outline, collected_data)
```

### 2.5 关键设计决策

| 决策 | GPT-Researcher 的选择 | 理由 |
|------|----------------------|------|
| 推理入口 | 研究大纲 | 结构化覆盖，避免遗漏 |
| 迭代次数 | 默认 3 轮 | 平衡深度与成本 |
| 缺口识别 | LLM 对比大纲与已有数据 | 灵活，适应各种主题 |
| 终止条件 | 无缺口或达到上限 | 自动收敛 |
| 查询去重 | 集合检查 | 避免重复搜索 |

---

## 第 3 章 可复用方案设计

### 3.1 通用架构

```
用户查询
  │
  ▼
┌──────────────────────────────────────────┐
│          CoT Research Engine              │
│                                          │
│  ┌──────────┐  ┌──────────┐  ┌────────┐ │
│  │ Outline  │→ │ Gap      │→ │Strategy│ │
│  │ Planner  │  │ Analyzer │  │ Maker  │ │
│  └──────────┘  └──────────┘  └────────┘ │
│       │              ▲            │      │
│       │              │            ▼      │
│       │         ┌────┴─────┐  ┌──────┐  │
│       └────────→│ Research │←─│Search│  │
│                 │ Memory   │  │Engine│  │
│                 └──────────┘  └──────┘  │
│                      │                   │
│                      ▼                   │
│               ┌────────────┐             │
│               │  Reporter  │             │
│               └────────────┘             │
└──────────────────────────────────────────┘
```

### 3.2 核心实现

```python
"""cot_research.py — Chain-of-Thought 研究推理引擎"""
from __future__ import annotations

import json
import logging
import re
import time
from dataclasses import dataclass, field
from typing import Any, Callable

logger = logging.getLogger(__name__)


@dataclass
class ResearchOutline:
    """研究大纲"""
    title: str
    sections: list[dict]  # [{"heading": str, "key_questions": list, "search_queries": list}]
    expected_depth: str = "medium"


@dataclass
class KnowledgeGap:
    """知识缺口"""
    description: str
    importance: str  # high, medium, low
    suggested_queries: list[str] = field(default_factory=list)


@dataclass
class SearchStrategy:
    """搜索策略"""
    gap: str
    query: str
    strategy_type: str  # keyword, question, comparison
    expected_result: str = ""


@dataclass
class ResearchMemory:
    """研究记忆 — 记录整个推理过程"""
    outline: ResearchOutline | None = None
    collected_data: list[dict] = field(default_factory=list)
    executed_queries: list[str] = field(default_factory=list)
    identified_gaps: list[list[KnowledgeGap]] = field(default_factory=list)
    strategies: list[list[SearchStrategy]] = field(default_factory=list)
    iterations: int = 0


@dataclass
class CoTConfig:
    """CoT 研究配置"""
    max_iterations: int = 3
    max_queries_per_iteration: int = 5
    min_gap_importance: str = "medium"  # 只处理此级别以上的缺口
    convergence_threshold: int = 0  # 缺口数 <= 此值时停止


def _parse_json(text: str) -> Any:
    """从 LLM 输出提取 JSON"""
    match = re.search(r'```(?:json)?\s*([\s\S]*?)```', text)
    if match:
        text = match.group(1)
    try:
        return json.loads(text.strip())
    except json.JSONDecodeError:
        return None


class CoTResearchEngine:
    """Chain-of-Thought 研究推理引擎"""

    def __init__(self, llm, search_func: Callable,
                 config: CoTConfig | None = None):
        """
        Args:
            llm: LLM 客户端（需实现 ainvoke 方法）
            search_func: 搜索函数，签名 async (query: str) -> list[dict]
            config: CoT 配置
        """
        self.llm = llm
        self.search = search_func
        self.config = config or CoTConfig()
        self.memory = ResearchMemory()

    async def research(self, query: str) -> dict:
        """执行完整的 CoT 研究流程"""
        start = time.monotonic()

        # Phase 1: 规划
        self.memory.outline = await self._plan_outline(query)
        logger.info(f"大纲生成完成: {len(self.memory.outline.sections)} 个章节")

        # Phase 2: 迭代研究
        for iteration in range(self.config.max_iterations):
            self.memory.iterations = iteration + 1
            logger.info(f"=== 迭代 {iteration + 1} ===")

            # 获取搜索查询
            if iteration == 0:
                queries = self._initial_queries()
            else:
                gaps = await self._identify_gaps(query)
                self.memory.identified_gaps.append(gaps)

                if len(gaps) <= self.config.convergence_threshold:
                    logger.info("知识缺口已收敛，停止迭代")
                    break

                strategies = await self._formulate_strategies(gaps)
                self.memory.strategies.append(strategies)
                queries = [s.query for s in strategies]

            # 执行搜索
            new_queries = [q for q in queries if q not in self.memory.executed_queries]
            new_queries = new_queries[:self.config.max_queries_per_iteration]

            for q in new_queries:
                try:
                    results = await self.search(q)
                    self.memory.collected_data.append({
                        "query": q, "results": results,
                        "iteration": iteration,
                    })
                    self.memory.executed_queries.append(q)
                except Exception as e:
                    logger.warning(f"搜索失败: {q} — {e}")

        # Phase 3: 生成报告
        report = await self._generate_report(query)

        total_ms = (time.monotonic() - start) * 1000
        return {
            "query": query,
            "report": report,
            "outline": self.memory.outline,
            "iterations": self.memory.iterations,
            "total_queries": len(self.memory.executed_queries),
            "total_data_points": len(self.memory.collected_data),
            "duration_ms": total_ms,
        }

    async def _plan_outline(self, query: str) -> ResearchOutline:
        """生成研究大纲"""
        prompt = f"""作为研究规划专家，为以下主题创建结构化研究大纲。

主题: {query}

返回 JSON:
{{
  "title": "研究标题",
  "sections": [
    {{
      "heading": "章节标题",
      "key_questions": ["关键问题1", "关键问题2"],
      "search_queries": ["搜索查询1", "搜索查询2"]
    }}
  ],
  "expected_depth": "shallow|medium|deep"
}}"""

        response = await self.llm.ainvoke(prompt)
        data = _parse_json(response.content)
        if data:
            return ResearchOutline(
                title=data.get("title", query),
                sections=data.get("sections", []),
                expected_depth=data.get("expected_depth", "medium"),
            )
        return ResearchOutline(title=query, sections=[
            {"heading": query, "key_questions": [query], "search_queries": [query]}
        ])

    def _initial_queries(self) -> list[str]:
        """从大纲提取初始搜索查询"""
        queries = []
        for section in self.memory.outline.sections:
            queries.extend(section.get("search_queries", []))
        return queries

    async def _identify_gaps(self, query: str) -> list[KnowledgeGap]:
        """识别知识缺口"""
        collected = "\n".join(
            f"- {d['query']}: {len(d.get('results', []))} 条结果"
            for d in self.memory.collected_data[-10:]
        )
        sections = "\n".join(
            f"- {s['heading']}" for s in self.memory.outline.sections
        )

        prompt = f"""分析研究进度，识别知识缺口。

主题: {query}
大纲章节: {sections}
已收集数据: {collected}

返回 JSON 数组:
[{{"gap": "缺口描述", "importance": "high|medium|low", "suggested_queries": ["查询"]}}]"""

        response = await self.llm.ainvoke(prompt)
        data = _parse_json(response.content)
        if data and isinstance(data, list):
            return [
                KnowledgeGap(
                    description=g.get("gap", ""),
                    importance=g.get("importance", "medium"),
                    suggested_queries=g.get("suggested_queries", []),
                )
                for g in data
                if g.get("importance", "low") >= self.config.min_gap_importance
            ]
        return []

    async def _formulate_strategies(
        self, gaps: list[KnowledgeGap]
    ) -> list[SearchStrategy]:
        """制定搜索策略"""
        strategies = []
        for gap in gaps:
            for q in gap.suggested_queries[:2]:
                strategies.append(SearchStrategy(
                    gap=gap.description, query=q,
                    strategy_type="keyword",
                ))
        return strategies

    async def _generate_report(self, query: str) -> str:
        """生成最终报告"""
        data_summary = "\n\n".join(
            f"### {d['query']}\n结果数: {len(d.get('results', []))}"
            for d in self.memory.collected_data
        )

        prompt = f"""基于以下研究数据，生成关于 "{query}" 的综合报告。

研究大纲: {self.memory.outline.title}
迭代次数: {self.memory.iterations}
收集数据:
{data_summary}

生成结构化、有深度的研究报告。"""

        response = await self.llm.ainvoke(prompt)
        return response.content
```

### 3.3 配置参数

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `max_iterations` | 3 | 最大迭代轮数 |
| `max_queries_per_iteration` | 5 | 每轮最大搜索数 |
| `min_gap_importance` | "medium" | 最低处理的缺口级别 |
| `convergence_threshold` | 0 | 缺口数收敛阈值 |

---

## 第 4 章 测试用例

```python
"""test_cot_research.py — CoT 研究推理测试"""
import json
import pytest
from unittest.mock import AsyncMock, MagicMock


# === Mock 对象 ===

def mock_llm(response: str):
    llm = AsyncMock()
    llm.ainvoke.return_value = MagicMock(content=response)
    return llm


async def mock_search(query: str) -> list[dict]:
    return [{"title": f"Result for {query}", "url": "http://example.com"}]


# === 大纲生成测试 ===

class TestOutlinePlanning:

    @pytest.mark.asyncio
    async def test_generates_outline(self):
        """应生成结构化大纲"""
        outline_json = json.dumps({
            "title": "AI 安全研究",
            "sections": [
                {"heading": "Prompt Injection",
                 "key_questions": ["什么是 prompt injection?"],
                 "search_queries": ["prompt injection attacks"]},
                {"heading": "数据泄露",
                 "key_questions": ["Agent 如何泄露数据?"],
                 "search_queries": ["AI agent data leakage"]},
            ],
            "expected_depth": "deep",
        })
        llm = mock_llm(outline_json)
        engine = CoTResearchEngine(llm, mock_search)
        outline = await engine._plan_outline("AI Agent 安全风险")
        assert len(outline.sections) == 2
        assert outline.expected_depth == "deep"

    @pytest.mark.asyncio
    async def test_fallback_on_invalid_json(self):
        """无效 JSON 时降级为单章节大纲"""
        llm = mock_llm("这不是 JSON")
        engine = CoTResearchEngine(llm, mock_search)
        outline = await engine._plan_outline("测试主题")
        assert len(outline.sections) == 1


# === 知识缺口测试 ===

class TestGapIdentification:

    @pytest.mark.asyncio
    async def test_identifies_gaps(self):
        """应识别知识缺口"""
        gaps_json = json.dumps([
            {"gap": "缺少性能数据", "importance": "high",
             "suggested_queries": ["AI agent performance benchmark"]},
        ])
        llm = mock_llm(gaps_json)
        engine = CoTResearchEngine(llm, mock_search)
        engine.memory.outline = ResearchOutline(
            title="test", sections=[{"heading": "性能"}]
        )
        engine.memory.collected_data = [{"query": "q1", "results": []}]
        gaps = await engine._identify_gaps("test")
        assert len(gaps) == 1
        assert gaps[0].importance == "high"

    @pytest.mark.asyncio
    async def test_empty_gaps_means_convergence(self):
        """无缺口表示研究已收敛"""
        llm = mock_llm("[]")
        engine = CoTResearchEngine(llm, mock_search)
        engine.memory.outline = ResearchOutline(title="test", sections=[])
        engine.memory.collected_data = []
        gaps = await engine._identify_gaps("test")
        assert len(gaps) == 0


# === 搜索策略测试 ===

class TestSearchStrategy:

    @pytest.mark.asyncio
    async def test_generates_strategies(self):
        """应为每个缺口生成搜索策略"""
        llm = mock_llm("")
        engine = CoTResearchEngine(llm, mock_search)
        gaps = [
            KnowledgeGap("缺口1", "high", ["query1", "query2"]),
            KnowledgeGap("缺口2", "medium", ["query3"]),
        ]
        strategies = await engine._formulate_strategies(gaps)
        assert len(strategies) >= 2


# === 迭代研究测试 ===

class TestIterativeResearch:

    @pytest.mark.asyncio
    async def test_initial_queries_from_outline(self):
        """首轮查询应来自大纲"""
        llm = mock_llm("")
        engine = CoTResearchEngine(llm, mock_search)
        engine.memory.outline = ResearchOutline(
            title="test",
            sections=[
                {"heading": "A", "key_questions": [], "search_queries": ["q1", "q2"]},
                {"heading": "B", "key_questions": [], "search_queries": ["q3"]},
            ],
        )
        queries = engine._initial_queries()
        assert queries == ["q1", "q2", "q3"]

    @pytest.mark.asyncio
    async def test_query_deduplication(self):
        """已执行的查询不应重复执行"""
        llm = mock_llm("")
        engine = CoTResearchEngine(llm, mock_search)
        engine.memory.executed_queries = ["q1"]
        engine.memory.outline = ResearchOutline(
            title="test",
            sections=[{"heading": "A", "search_queries": ["q1", "q2"]}],
        )
        queries = engine._initial_queries()
        new = [q for q in queries if q not in engine.memory.executed_queries]
        assert "q1" not in new
        assert "q2" in new


# === 端到端测试 ===

class TestEndToEnd:

    @pytest.mark.asyncio
    async def test_full_research_flow(self):
        """完整 CoT 研究流程"""
        call_count = {"value": 0}

        async def counting_llm_invoke(prompt):
            call_count["value"] += 1
            if call_count["value"] == 1:
                # 大纲
                return MagicMock(content=json.dumps({
                    "title": "Test",
                    "sections": [{"heading": "A", "key_questions": ["q?"],
                                  "search_queries": ["search A"]}],
                    "expected_depth": "medium",
                }))
            elif "缺口" in prompt or "gap" in prompt.lower():
                # 缺口分析 — 返回空表示收敛
                return MagicMock(content="[]")
            else:
                # 报告
                return MagicMock(content="最终研究报告")

        llm = AsyncMock()
        llm.ainvoke.side_effect = counting_llm_invoke

        engine = CoTResearchEngine(llm, mock_search, CoTConfig(max_iterations=2))
        result = await engine.research("测试主题")

        assert result["report"] is not None
        assert result["iterations"] >= 1
        assert result["total_queries"] >= 1


# === 辅助函数测试 ===

class TestParseJson:

    def test_plain_json(self):
        assert _parse_json('{"key": "value"}') == {"key": "value"}

    def test_json_in_code_block(self):
        assert _parse_json('```json\n{"key": "value"}\n```') == {"key": "value"}

    def test_invalid_json(self):
        assert _parse_json("not json") is None

    def test_json_array(self):
        result = _parse_json('[1, 2, 3]')
        assert result == [1, 2, 3]


# === 研究记忆测试 ===

class TestResearchMemory:

    def test_initial_state(self):
        memory = ResearchMemory()
        assert memory.outline is None
        assert len(memory.collected_data) == 0
        assert memory.iterations == 0

    def test_tracks_queries(self):
        memory = ResearchMemory()
        memory.executed_queries.append("q1")
        memory.executed_queries.append("q2")
        assert len(memory.executed_queries) == 2
```

---

## 第 5 章 跨域关联

| 关联域 | 关系 | 说明 |
|--------|------|------|
| PD-01 上下文管理 | 核心 | 迭代研究积累大量数据，需要上下文裁剪 |
| PD-02 多 Agent 编排 | 架构 | CoT 引擎可作为 planner 节点嵌入 DAG |
| PD-08 搜索与检索 | 集成 | CoT 生成的查询由搜索引擎执行 |
| PD-08.02 树状搜索 | 互补 | CoT 提供搜索方向，树状搜索提供搜索深度 |
| PD-12.02 分层 LLM | 互补 | 大纲生成用强模型，缺口分析用中等模型 |

---

## 第 6 章 来源文件索引

| 编号 | 文件 | 说明 |
|------|------|------|
| S1 | `gpt_researcher/master/agent.py` | Master Agent — 迭代研究循环 |
| S2 | `gpt_researcher/actions/query_processing.py` | 大纲生成、子查询生成 |
| S3 | `gpt_researcher/master/functions.py` | 报告生成、知识缺口分析 |
| S4 | `gpt_researcher/config/` | 迭代次数、查询数量配置 |
