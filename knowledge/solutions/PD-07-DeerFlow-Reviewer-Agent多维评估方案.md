# PD-07.01 DeerFlow — Reviewer Agent 多维评估

> 文档编号：PD-07.01
> 来源：DeerFlow `src/graph/nodes.py` / `src/prompts/reviewer.py`
> GitHub：https://github.com/bytedance/deer-flow
> 问题域：PD-07 质量检查 Quality Assurance
> 状态：可复用方案

---

## 第 1 章 问题与动机

### 1.1 核心问题

LLM 生成的研究报告存在三类质量问题：

1. **事实准确性不可控** — LLM 可能"幻觉"出不存在的数据、错误的统计数字、虚构的引用来源。
2. **完整性无法保证** — 报告可能遗漏用户查询的关键方面，只覆盖部分子问题。
3. **相关性漂移** — 长报告中后半段可能偏离原始查询主题。

```
用户查询: "对比 React 和 Vue 在大型项目中的性能表现"

低质量报告问题：
  - 准确性: 引用了不存在的 benchmark 数据
  - 完整性: 只讨论了渲染性能，遗漏了构建速度、内存占用
  - 相关性: 花了 30% 篇幅讨论 Angular（用户没问）
```

没有质量检查时：用户收到的报告质量完全取决于 LLM 的"运气"，无法系统性保证。

### 1.2 DeerFlow 的解法概述

DeerFlow 引入独立的 Reviewer Agent，在 Generator 输出后进行多维评估：

- **独立 Reviewer 节点**：与 Generator 分离，避免自我评估偏差
- **多维评分**：准确性（Accuracy）、完整性（Completeness）、相关性（Relevance）独立打分
- **Generator-Critic 迭代循环**：评分不达标时，Reviewer 给出具体修改建议，Generator 重新生成
- **最大迭代限制**：防止无限循环，超过上限后强制输出当前最佳版本

### 1.3 设计思想

| 原则 | 说明 |
|------|------|
| 角色分离 | Generator 和 Reviewer 使用不同 prompt，避免自我评估偏差 |
| 多维评估 | 单一分数无法定位问题，多维度评分精确定位薄弱环节 |
| 迭代改进 | 一次评估不够，循环迭代直到质量达标 |
| 有限迭代 | 设置上限防止无限循环和成本爆炸 |
| 结构化反馈 | Reviewer 输出结构化的修改建议，而非模糊的"需要改进" |

---

## 第 2 章 源码实现分析

### 2.1 整体架构

```
src/
├── graph/
│   ├── builder.py          # 图构建：reviewer 节点 + 条件循环边
│   └── nodes.py            # reviewer_node 实现
├── prompts/
│   ├── reviewer.py         # Reviewer prompt 模板
│   └── reporter.py         # Reporter/Generator prompt 模板
└── config/
    └── settings.py         # max_review_iterations 配置
```

### 2.2 Reviewer 节点实现

```python
# src/graph/nodes.py（简化）
import json
from langchain_core.messages import SystemMessage, HumanMessage


async def reviewer_node(state: ResearchState) -> dict:
    """独立 Reviewer Agent：多维评估报告质量"""
    report = state.get("report", "")
    query = state["query"]
    research_data = state.get("research_data", [])
    iteration = state.get("review_iteration", 0)

    # 构建评估上下文
    context = "\n".join(
        f"- [{d.get('source', 'unknown')}] {d.get('title', '')}: {d.get('snippet', '')[:200]}"
        for d in research_data[:10]
    )

    response = await llm.ainvoke([
        SystemMessage(content=REVIEWER_PROMPT),
        HumanMessage(content=f"""
原始查询：{query}

研究数据摘要：
{context}

待评估报告：
{report}

请从准确性、完整性、相关性三个维度评估，并给出结构化反馈。
"""),
    ])

    review = _parse_review(response.content)
    return {
        "review": review,
        "review_iteration": iteration + 1,
        "messages": [response],
    }


def _parse_review(content: str) -> dict:
    """解析 Reviewer 的结构化输出"""
    try:
        # 尝试 JSON 解析
        import re
        match = re.search(r"```(?:json)?\s*(.*?)```", content, re.DOTALL)
        text = match.group(1) if match else content
        return json.loads(text.strip())
    except (json.JSONDecodeError, AttributeError):
        # 降级：返回默认通过
        return {
            "accuracy": {"score": 0.7, "issues": [], "suggestions": []},
            "completeness": {"score": 0.7, "issues": [], "suggestions": []},
            "relevance": {"score": 0.7, "issues": [], "suggestions": []},
            "overall_pass": False,
            "summary": content,
        }
```

### 2.3 Reviewer Prompt 模板

```python
# src/prompts/reviewer.py（简化）
REVIEWER_PROMPT = """你是一个独立的研究报告质量审查员。你的任务是从三个维度评估报告质量。

## 评估维度

### 1. 准确性 (Accuracy) — 0.0~1.0
- 报告中的事实是否与提供的研究数据一致？
- 是否存在无法从研究数据中验证的断言？
- 数字、统计数据是否有来源支撑？

### 2. 完整性 (Completeness) — 0.0~1.0
- 报告是否覆盖了原始查询的所有方面？
- 是否有明显遗漏的子主题？
- 结论是否充分？

### 3. 相关性 (Relevance) — 0.0~1.0
- 报告内容是否紧扣原始查询？
- 是否有偏离主题的段落？
- 篇幅分配是否合理？

## 输出格式（JSON）

```json
{
  "accuracy": {
    "score": 0.85,
    "issues": ["第3段引用的数据在研究资料中未找到"],
    "suggestions": ["删除未验证的统计数据，或标注为'待验证'"]
  },
  "completeness": {
    "score": 0.70,
    "issues": ["缺少性能对比的具体 benchmark 数据"],
    "suggestions": ["补充 React 和 Vue 的渲染性能对比数据"]
  },
  "relevance": {
    "score": 0.90,
    "issues": [],
    "suggestions": []
  },
  "overall_pass": false,
  "summary": "报告整体质量中等，主要问题是完整性不足..."
}
```

## 评分标准
- overall_pass = true 当且仅当三个维度均 >= 0.8
- 如果 overall_pass = false，suggestions 必须给出具体可操作的修改建议
"""
```

### 2.4 Generator-Critic 迭代循环

```python
# src/graph/builder.py（简化）
from langgraph.graph import StateGraph, END

MAX_REVIEW_ITERATIONS = 3

def route_after_review(state: ResearchState) -> str:
    """根据评审结果决定是否重新生成"""
    review = state.get("review", {})
    iteration = state.get("review_iteration", 0)

    # 评审通过 → 结束
    if review.get("overall_pass", False):
        return "end"

    # 超过最大迭代次数 → 强制结束
    if iteration >= MAX_REVIEW_ITERATIONS:
        return "end"

    # 评审未通过 → 重新生成
    return "regenerate"


def build_graph_with_reviewer():
    graph = StateGraph(ResearchState)
    graph.add_node("researcher", researcher_node)
    graph.add_node("reporter", reporter_node)
    graph.add_node("reviewer", reviewer_node)

    graph.set_entry_point("researcher")
    graph.add_edge("researcher", "reporter")
    graph.add_edge("reporter", "reviewer")

    # 条件循环：reviewer → reporter（重新生成）或 END
    graph.add_conditional_edges(
        "reviewer",
        route_after_review,
        {"regenerate": "reporter", "end": END},
    )

    return graph.compile()
```

### 2.5 带反馈的重新生成

```python
# src/graph/nodes.py — reporter 接收 review 反馈
async def reporter_node(state: ResearchState) -> dict:
    """Reporter 生成报告，如果有 review 反馈则据此改进"""
    review = state.get("review")
    research_data = state.get("research_data", [])

    if review and not review.get("overall_pass", True):
        # 有评审反馈 → 改进模式
        feedback = _format_feedback(review)
        prompt = f"""基于以下评审反馈改进报告：

{feedback}

原始报告：
{state.get('report', '')}

研究数据：
{_format_research_data(research_data)}

请针对评审指出的问题进行修改，保留评审认可的部分。"""
    else:
        # 首次生成
        prompt = f"""基于研究数据生成报告：\n{_format_research_data(research_data)}"""

    response = await llm.ainvoke([
        SystemMessage(content="你是一个研究报告撰写专家。"),
        HumanMessage(content=prompt),
    ])
    return {"report": response.content, "messages": [response]}


def _format_feedback(review: dict) -> str:
    """将结构化评审转为可读反馈"""
    lines = []
    for dim in ["accuracy", "completeness", "relevance"]:
        info = review.get(dim, {})
        score = info.get("score", 0)
        lines.append(f"**{dim}** ({score:.1f}/1.0):")
        for issue in info.get("issues", []):
            lines.append(f"  - 问题: {issue}")
        for sug in info.get("suggestions", []):
            lines.append(f"  - 建议: {sug}")
    return "\n".join(lines)
```

---

## 第 3 章 迁移指南

### 3.1 迁移检查清单

| # | 检查项 | 说明 |
|---|--------|------|
| 1 | 定义评估维度 | 根据业务场景选择维度（准确性/完整性/相关性/格式等） |
| 2 | 设置通过阈值 | 每个维度的最低分数（建议 0.8） |
| 3 | 配置最大迭代次数 | 防止无限循环（建议 2-3 次） |
| 4 | 设计 Reviewer Prompt | 明确评分标准和输出格式 |
| 5 | 实现反馈注入机制 | Generator 能接收并利用 Reviewer 反馈 |
| 6 | 添加迭代成本监控 | 追踪每次迭代的 token 消耗 |

### 3.2 通用 Reviewer 框架

```python
"""reviewer.py — 通用多维评估 Reviewer 框架"""
from __future__ import annotations
import json
import re
import logging
from dataclasses import dataclass, field
from typing import Any, Protocol

logger = logging.getLogger(__name__)


@dataclass
class DimensionScore:
    """单个评估维度的评分"""
    name: str
    score: float                    # 0.0 ~ 1.0
    issues: list[str] = field(default_factory=list)
    suggestions: list[str] = field(default_factory=list)

    @property
    def passed(self) -> bool:
        return self.score >= 0.8


@dataclass
class ReviewResult:
    """完整评审结果"""
    dimensions: list[DimensionScore]
    overall_pass: bool
    summary: str
    iteration: int = 0

    @property
    def min_score(self) -> float:
        return min(d.score for d in self.dimensions) if self.dimensions else 0.0

    @property
    def avg_score(self) -> float:
        return sum(d.score for d in self.dimensions) / len(self.dimensions) if self.dimensions else 0.0

    def failed_dimensions(self) -> list[DimensionScore]:
        return [d for d in self.dimensions if not d.passed]

    def to_feedback_text(self) -> str:
        """转为可读的反馈文本，供 Generator 使用"""
        lines = [f"评审结果（第 {self.iteration} 轮）：{'通过' if self.overall_pass else '未通过'}"]
        for d in self.dimensions:
            lines.append(f"\n**{d.name}** ({d.score:.2f}/1.0) {'PASS' if d.passed else 'FAIL'}")
            for issue in d.issues:
                lines.append(f"  - 问题: {issue}")
            for sug in d.suggestions:
                lines.append(f"  - 建议: {sug}")
        lines.append(f"\n总结: {self.summary}")
        return "\n".join(lines)


@dataclass
class ReviewConfig:
    """评审配置"""
    dimensions: list[str] = field(default_factory=lambda: ["accuracy", "completeness", "relevance"])
    pass_threshold: float = 0.8
    max_iterations: int = 3
    require_all_pass: bool = True  # True: 所有维度都需达标; False: 平均分达标即可


class LLMProtocol(Protocol):
    async def ainvoke(self, messages: list) -> Any: ...


class MultiDimensionReviewer:
    """多维评估 Reviewer"""

    REVIEW_PROMPT_TEMPLATE = """你是一个独立的质量审查员。请从以下维度评估内容质量。

## 评估维度
{dimensions_desc}

## 评分标准
- 每个维度 0.0~1.0，>= {threshold} 为通过
- 必须给出具体的 issues 和 suggestions
- overall_pass = true 当且仅当{pass_condition}

## 输出格式（严格 JSON）
```json
{{
  "dimensions": [
    {{"name": "维度名", "score": 0.85, "issues": ["问题1"], "suggestions": ["建议1"]}}
  ],
  "overall_pass": false,
  "summary": "总结评价"
}}
```"""

    DIMENSION_DESCRIPTIONS = {
        "accuracy": "准确性 (Accuracy): 内容是否与提供的数据一致？是否有无法验证的断言？",
        "completeness": "完整性 (Completeness): 是否覆盖了查询的所有方面？是否有遗漏？",
        "relevance": "相关性 (Relevance): 内容是否紧扣主题？是否有偏离？",
        "format": "格式规范 (Format): 结构是否清晰？标题层级是否合理？",
        "citation": "引用规范 (Citation): 关键断言是否有来源支撑？引用格式是否正确？",
    }

    def __init__(self, llm: LLMProtocol, config: ReviewConfig | None = None):
        self.llm = llm
        self.config = config or ReviewConfig()

    def _build_prompt(self) -> str:
        dims_desc = "\n".join(
            f"### {i+1}. {self.DIMENSION_DESCRIPTIONS.get(d, d)}"
            for i, d in enumerate(self.config.dimensions)
        )
        pass_cond = "所有维度均达标" if self.config.require_all_pass else "平均分达标"
        return self.REVIEW_PROMPT_TEMPLATE.format(
            dimensions_desc=dims_desc,
            threshold=self.config.pass_threshold,
            pass_condition=pass_cond,
        )

    async def review(self, content: str, context: str, query: str, iteration: int = 0) -> ReviewResult:
        """执行多维评估"""
        from langchain_core.messages import SystemMessage, HumanMessage

        response = await self.llm.ainvoke([
            SystemMessage(content=self._build_prompt()),
            HumanMessage(content=f"原始查询：{query}\n\n参考数据：\n{context}\n\n待评估内容：\n{content}"),
        ])

        return self._parse_response(response.content, iteration)

    def _parse_response(self, content: str, iteration: int) -> ReviewResult:
        """解析 LLM 的评审输出"""
        try:
            match = re.search(r"```(?:json)?\s*(.*?)```", content, re.DOTALL)
            text = match.group(1) if match else content
            data = json.loads(text.strip())

            dimensions = [
                DimensionScore(
                    name=d["name"],
                    score=float(d.get("score", 0)),
                    issues=d.get("issues", []),
                    suggestions=d.get("suggestions", []),
                )
                for d in data.get("dimensions", [])
            ]

            return ReviewResult(
                dimensions=dimensions,
                overall_pass=data.get("overall_pass", False),
                summary=data.get("summary", ""),
                iteration=iteration,
            )
        except (json.JSONDecodeError, KeyError, TypeError) as e:
            logger.warning(f"Failed to parse review response: {e}")
            return ReviewResult(
                dimensions=[DimensionScore(name=d, score=0.5) for d in self.config.dimensions],
                overall_pass=False,
                summary=f"解析失败，原始输出: {content[:200]}",
                iteration=iteration,
            )
```

### 3.3 Generator-Critic 迭代循环

```python
"""review_loop.py — Generator-Critic 迭代循环"""
import logging

logger = logging.getLogger(__name__)


class GeneratorCriticLoop:
    """Generator-Critic 迭代循环控制器"""

    def __init__(self, generator, reviewer: MultiDimensionReviewer, config: ReviewConfig | None = None):
        self.generator = generator
        self.reviewer = reviewer
        self.config = config or ReviewConfig()

    async def run(self, query: str, context: str, initial_content: str = "") -> dict:
        """执行迭代循环直到质量达标或达到最大迭代次数"""
        content = initial_content or await self.generator.generate(query, context)
        history = []

        for i in range(self.config.max_iterations):
            # Critic: 评估
            review = await self.reviewer.review(content, context, query, iteration=i)
            history.append({"iteration": i, "review": review, "content_length": len(content)})

            logger.info(
                f"Review iteration {i}: pass={review.overall_pass}, "
                f"avg={review.avg_score:.2f}, min={review.min_score:.2f}"
            )

            if review.overall_pass:
                return {"content": content, "review": review, "iterations": i + 1, "history": history}

            # Generator: 根据反馈重新生成
            feedback = review.to_feedback_text()
            content = await self.generator.regenerate(query, context, content, feedback)

        # 达到最大迭代次数，返回最后版本
        final_review = await self.reviewer.review(content, context, query, iteration=self.config.max_iterations)
        history.append({"iteration": self.config.max_iterations, "review": final_review})

        logger.warning(f"Max iterations reached ({self.config.max_iterations}), returning best effort")
        return {
            "content": content,
            "review": final_review,
            "iterations": self.config.max_iterations,
            "history": history,
            "max_iterations_reached": True,
        }
```

### 3.4 场景适配矩阵

| 场景 | 评估维度 | 通过阈值 | 最大迭代 | 说明 |
|------|----------|----------|----------|------|
| 研究报告 | accuracy, completeness, relevance | 0.8 | 3 | 标准配置 |
| 代码生成 | correctness, completeness, style | 0.9 | 2 | 代码质量要求更高 |
| 客服回复 | accuracy, helpfulness, tone | 0.85 | 2 | 语气维度很重要 |
| 新闻摘要 | accuracy, completeness, objectivity | 0.85 | 2 | 客观性是关键 |
| 学术论文 | accuracy, citation, completeness, format | 0.9 | 3 | 引用规范严格 |

---

## 第 4 章 测试用例

```python
"""test_reviewer.py — Reviewer Agent 多维评估完整测试套件"""
import json
import pytest
from unittest.mock import AsyncMock, MagicMock
from dataclasses import dataclass


# === 4.1 DimensionScore 测试 ===

class TestDimensionScore:
    """评估维度评分测试"""

    def test_passed_above_threshold(self):
        score = DimensionScore(name="accuracy", score=0.85)
        assert score.passed is True

    def test_failed_below_threshold(self):
        score = DimensionScore(name="accuracy", score=0.6)
        assert score.passed is False

    def test_boundary_score(self):
        score = DimensionScore(name="accuracy", score=0.8)
        assert score.passed is True

    def test_issues_and_suggestions(self):
        score = DimensionScore(
            name="completeness",
            score=0.5,
            issues=["缺少性能数据"],
            suggestions=["补充 benchmark 对比"],
        )
        assert len(score.issues) == 1
        assert len(score.suggestions) == 1


# === 4.2 ReviewResult 测试 ===

class TestReviewResult:
    """评审结果测试"""

    def test_min_score(self):
        result = ReviewResult(
            dimensions=[
                DimensionScore(name="a", score=0.9),
                DimensionScore(name="b", score=0.6),
                DimensionScore(name="c", score=0.8),
            ],
            overall_pass=False,
            summary="test",
        )
        assert result.min_score == 0.6

    def test_avg_score(self):
        result = ReviewResult(
            dimensions=[
                DimensionScore(name="a", score=0.9),
                DimensionScore(name="b", score=0.6),
            ],
            overall_pass=False,
            summary="test",
        )
        assert result.avg_score == pytest.approx(0.75)

    def test_failed_dimensions(self):
        result = ReviewResult(
            dimensions=[
                DimensionScore(name="accuracy", score=0.9),
                DimensionScore(name="completeness", score=0.5),
                DimensionScore(name="relevance", score=0.7),
            ],
            overall_pass=False,
            summary="test",
        )
        failed = result.failed_dimensions()
        assert len(failed) == 2
        assert failed[0].name == "completeness"

    def test_to_feedback_text(self):
        result = ReviewResult(
            dimensions=[
                DimensionScore(name="accuracy", score=0.9, issues=[], suggestions=[]),
                DimensionScore(name="completeness", score=0.5,
                               issues=["缺少数据"], suggestions=["补充 benchmark"]),
            ],
            overall_pass=False,
            summary="需要改进完整性",
            iteration=1,
        )
        text = result.to_feedback_text()
        assert "第 1 轮" in text
        assert "未通过" in text
        assert "缺少数据" in text
        assert "补充 benchmark" in text

    def test_empty_dimensions(self):
        result = ReviewResult(dimensions=[], overall_pass=True, summary="empty")
        assert result.min_score == 0.0
        assert result.avg_score == 0.0


# === 4.3 MultiDimensionReviewer 测试 ===

class TestMultiDimensionReviewer:
    """多维评估 Reviewer 测试"""

    def _mock_llm(self, response_content: str):
        llm = AsyncMock()
        llm.ainvoke = AsyncMock(return_value=MagicMock(content=response_content))
        return llm

    @pytest.mark.asyncio
    async def test_review_parses_valid_json(self):
        """有效 JSON 响应应正确解析"""
        response = json.dumps({
            "dimensions": [
                {"name": "accuracy", "score": 0.9, "issues": [], "suggestions": []},
                {"name": "completeness", "score": 0.85, "issues": [], "suggestions": []},
            ],
            "overall_pass": True,
            "summary": "质量良好",
        })
        llm = self._mock_llm(f"```json\n{response}\n```")
        reviewer = MultiDimensionReviewer(llm)

        result = await reviewer.review("报告内容", "参考数据", "查询")
        assert result.overall_pass is True
        assert len(result.dimensions) == 2
        assert result.dimensions[0].score == 0.9

    @pytest.mark.asyncio
    async def test_review_handles_invalid_json(self):
        """无效 JSON 应降级处理"""
        llm = self._mock_llm("这不是 JSON 格式的输出")
        reviewer = MultiDimensionReviewer(llm)

        result = await reviewer.review("报告", "数据", "查询")
        assert result.overall_pass is False
        assert len(result.dimensions) == 3  # 默认 3 个维度

    @pytest.mark.asyncio
    async def test_review_with_code_block(self):
        """包裹在代码块中的 JSON 应正确提取"""
        response = json.dumps({
            "dimensions": [{"name": "accuracy", "score": 0.95, "issues": [], "suggestions": []}],
            "overall_pass": True,
            "summary": "ok",
        })
        llm = self._mock_llm(f"评审结果如下：\n```json\n{response}\n```\n以上是评审。")
        reviewer = MultiDimensionReviewer(llm, ReviewConfig(dimensions=["accuracy"]))

        result = await reviewer.review("内容", "数据", "查询")
        assert result.overall_pass is True

    @pytest.mark.asyncio
    async def test_custom_dimensions(self):
        """自定义评估维度应生效"""
        config = ReviewConfig(dimensions=["correctness", "style"])
        llm = self._mock_llm(json.dumps({
            "dimensions": [
                {"name": "correctness", "score": 0.9, "issues": [], "suggestions": []},
                {"name": "style", "score": 0.8, "issues": [], "suggestions": []},
            ],
            "overall_pass": True,
            "summary": "ok",
        }))
        reviewer = MultiDimensionReviewer(llm, config)
        result = await reviewer.review("code", "spec", "query")
        assert result.dimensions[0].name == "correctness"


# === 4.4 GeneratorCriticLoop 测试 ===

class TestGeneratorCriticLoop:
    """Generator-Critic 迭代循环测试"""

    @pytest.mark.asyncio
    async def test_passes_on_first_try(self):
        """首次评审通过应只迭代一次"""
        generator = AsyncMock()
        generator.generate = AsyncMock(return_value="初始报告")

        llm = AsyncMock()
        llm.ainvoke = AsyncMock(return_value=MagicMock(content=json.dumps({
            "dimensions": [{"name": "accuracy", "score": 0.9, "issues": [], "suggestions": []}],
            "overall_pass": True,
            "summary": "ok",
        })))
        reviewer = MultiDimensionReviewer(llm, ReviewConfig(dimensions=["accuracy"]))
        loop = GeneratorCriticLoop(generator, reviewer)

        result = await loop.run("query", "context")
        assert result["iterations"] == 1
        assert result["review"].overall_pass is True

    @pytest.mark.asyncio
    async def test_iterates_on_failure(self):
        """评审未通过应触发重新生成"""
        generator = AsyncMock()
        generator.generate = AsyncMock(return_value="初始报告")
        generator.regenerate = AsyncMock(return_value="改进后的报告")

        call_count = 0
        async def mock_review(*args, **kwargs):
            nonlocal call_count
            call_count += 1
            passed = call_count >= 2
            return MagicMock(content=json.dumps({
                "dimensions": [{"name": "accuracy", "score": 0.9 if passed else 0.5,
                                "issues": [] if passed else ["问题"],
                                "suggestions": [] if passed else ["建议"]}],
                "overall_pass": passed,
                "summary": "ok" if passed else "需改进",
            }))

        llm = AsyncMock()
        llm.ainvoke = mock_review
        reviewer = MultiDimensionReviewer(llm, ReviewConfig(dimensions=["accuracy"]))
        loop = GeneratorCriticLoop(generator, reviewer)

        result = await loop.run("query", "context")
        assert result["iterations"] == 2
        generator.regenerate.assert_called_once()

    @pytest.mark.asyncio
    async def test_max_iterations_respected(self):
        """应遵守最大迭代次数限制"""
        generator = AsyncMock()
        generator.generate = AsyncMock(return_value="报告")
        generator.regenerate = AsyncMock(return_value="改进报告")

        llm = AsyncMock()
        llm.ainvoke = AsyncMock(return_value=MagicMock(content=json.dumps({
            "dimensions": [{"name": "accuracy", "score": 0.3, "issues": ["差"], "suggestions": ["改"]}],
            "overall_pass": False,
            "summary": "质量差",
        })))
        reviewer = MultiDimensionReviewer(llm, ReviewConfig(dimensions=["accuracy"], max_iterations=2))
        loop = GeneratorCriticLoop(generator, reviewer, ReviewConfig(max_iterations=2))

        result = await loop.run("query", "context")
        assert result.get("max_iterations_reached") is True
        assert result["iterations"] == 2


# === 4.5 路由函数测试 ===

class TestRouting:
    """评审后路由决策测试"""

    def test_pass_routes_to_end(self):
        state = {"review": {"overall_pass": True}, "review_iteration": 1}
        assert route_after_review(state) == "end"

    def test_fail_routes_to_regenerate(self):
        state = {"review": {"overall_pass": False}, "review_iteration": 1}
        assert route_after_review(state) == "regenerate"

    def test_max_iterations_routes_to_end(self):
        state = {"review": {"overall_pass": False}, "review_iteration": 3}
        assert route_after_review(state) == "end"

    def test_no_review_routes_to_regenerate(self):
        state = {"review_iteration": 0}
        assert route_after_review(state) == "regenerate"
```

---

## 第 5 章 跨域关联

| 关联域 | 关系 | 说明 |
|--------|------|------|
| PD-02 多 Agent 编排 | 架构 | Reviewer 作为 DAG 中的独立节点，通过条件边实现循环 |
| PD-06 记忆持久化 | 扩展 | 评审历史可持久化，用于分析质量趋势 |
| PD-07.02 源引用验证 | 互补 | 本方案做宏观多维评估，07.02 做微观引用验证 |
| PD-01 上下文管理 | 输入 | 评审需要原始查询 + 研究数据作为上下文 |
| PD-11 可观测性 | 监控 | 迭代次数、各维度分数需要追踪 |
| PD-03 容错与重试 | 互补 | Reviewer LLM 调用失败时的降级策略 |

---

## 第 6 章 来源文件索引

| 编号 | 文件 | 说明 |
|------|------|------|
| S1 | `src/graph/nodes.py` | reviewer_node 实现 |
| S2 | `src/graph/builder.py` | 图构建：reviewer 条件循环边 |
| S3 | `src/prompts/reviewer.py` | Reviewer prompt 模板 |
| S4 | `src/prompts/reporter.py` | Reporter prompt（接收反馈改进） |
| S5 | `src/graph/types.py` | State 类型：review 字段定义 |
| S6 | `src/config/settings.py` | max_review_iterations 配置 |