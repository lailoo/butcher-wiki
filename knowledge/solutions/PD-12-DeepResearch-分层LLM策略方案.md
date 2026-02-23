# PD-12.02 DeepResearch — 分层 LLM 策略

> 文档编号：PD-12.02
> 来源：DeepResearch `src/llm_client.py` / `config.py`
> GitHub：https://github.com/Alibaba-NLP/DeepResearch
> 问题域：PD-12 推理增强 Reasoning Enhancement
> 状态：可复用方案

---

## 第 1 章 问题与动机

### 1.1 核心问题

不是所有任务都需要最强（最贵）的模型。一个典型的 Agent 工作流中，任务复杂度分布极不均匀：

```
Agent 单次研究流程中的任务分布（示例）：

  简单任务 (60%)          中等任务 (30%)       复杂任务 (10%)
  ─────────────────────   ──────────────────   ──────────────
  - 格式化输出             - 信息综合           - 多步推理
  - 关键词提取             - 摘要生成           - 研究规划
  - 模板填充               - 内容改写           - 矛盾检测
  - JSON 结构化            - 翻译               - 创意生成
```

如果所有任务都用最强模型（如 GPT-4o / Claude Opus）：

| 场景 | 全用强模型 | 分层路由 | 节省 |
|------|-----------|---------|------|
| 100 次调用/研究 | $2.50 | $0.45 | 82% |
| 1000 次调用/天 | $25.00 | $4.50 | 82% |
| 月度成本 | $750 | $135 | $615 |

### 1.2 DeepResearch 的解法概述

DeepResearch 采用分层 LLM 策略，核心思路：

1. **定义任务复杂度分级**：simple / medium / complex 三级
2. **模型注册表**：每个级别映射到不同的模型（及其参数）
3. **路由决策器**：根据任务特征（关键词、token 长度、显式标注）自动选择模型
4. **降级兜底**：高级模型不可用时自动降级到低级模型

### 1.3 设计思想

| 原则 | 说明 |
|------|------|
| 按需分配 | 简单任务用小模型，复杂任务用大模型，不浪费算力 |
| 成本优先 | 默认走最便宜的路径，只在必要时升级 |
| 透明路由 | 调用方不需要关心模型选择，路由器自动决策 |
| 可降级 | 任何模型不可用时，自动 fallback 到下一级 |
| 可观测 | 每次路由决策都记录，支持成本分析和策略调优 |

---

## 第 2 章 源码实现分析

### 2.1 模型配置层

DeepResearch 在配置中定义了多个模型槽位，不同任务类型绑定不同模型：

```python
# 配置结构（简化自 DeepResearch 实际实现）
MODEL_CONFIG = {
    "planning_model": "qwen-plus",        # 复杂：研究规划、推理
    "summary_model": "qwen-turbo",        # 中等：摘要、综合
    "utility_model": "qwen-turbo-mini",   # 简单：格式化、提取
}
```

关键设计：不是用一个 `model` 字段，而是按任务角色定义多个模型槽位。这让路由逻辑内嵌在配置中，调用方只需指定任务类型。

### 2.2 任务分类器

DeepResearch 的任务分类是隐式的——通过调用不同的函数来区分任务类型，每个函数内部硬编码使用哪个模型：

```python
# 规划类任务 → 用强模型
async def generate_research_plan(query: str) -> dict:
    response = await call_llm(
        model=config.planning_model,  # qwen-plus
        messages=[{"role": "user", "content": plan_prompt}],
        temperature=0.7,
    )
    return parse_plan(response)

# 摘要类任务 → 用中等模型
async def summarize_content(text: str) -> str:
    response = await call_llm(
        model=config.summary_model,   # qwen-turbo
        messages=[{"role": "user", "content": summary_prompt}],
        temperature=0.3,
    )
    return response

# 工具类任务 → 用轻量模型
async def extract_keywords(text: str) -> list:
    response = await call_llm(
        model=config.utility_model,   # qwen-turbo-mini
        messages=[{"role": "user", "content": extract_prompt}],
        temperature=0.0,
    )
    return parse_keywords(response)
```

### 2.3 路由决策器

DeepResearch 的路由是静态的（函数级绑定），没有动态路由器。这是最简单的分层策略——在代码层面硬编码任务到模型的映射。

优点：简单、可预测、无额外开销。
缺点：新增任务类型需要改代码，无法根据运行时特征动态调整。

### 2.4 调用链路

```
用户查询
  │
  ├─► generate_research_plan()  ──► planning_model (强)
  │     │
  │     ├─► search_web()         ──► [不需要 LLM]
  │     │
  │     ├─► summarize_content()  ──► summary_model (中)
  │     │
  │     ├─► extract_keywords()   ──► utility_model (弱)
  │     │
  │     └─► ... 循环多轮 ...
  │
  └─► generate_final_report()    ──► planning_model (强)
```

一次完整研究流程中，强模型只在规划和最终报告时使用（约 2-3 次），中等模型用于摘要（约 5-10 次），轻量模型用于提取和格式化（约 10-20 次）。成本分布从均匀变为长尾。

---

## 第 3 章 可复用方案设计

> 以下方案从 DeepResearch 的静态分层策略出发，扩展为通用的动态路由方案。
> 代码可直接复制到任何 Python 项目中使用。

### 3.1 通用架构

```
┌─────────────────────────────────────────────────┐
│                  调用方代码                        │
│         router.call("summarize", prompt)          │
└──────────────────────┬──────────────────────────┘
                       │
                       ▼
┌──────────────────────────────────────────────────┐
│              TieredLLMRouter                      │
│  ┌────────────┐  ┌──────────┐  ┌──────────────┐ │
│  │ 任务分类器  │→│ 路由策略  │→│ 模型注册表    │ │
│  │ Classifier │  │ Strategy │  │ Registry     │ │
│  └────────────┘  └──────────┘  └──────────────┘ │
│                       │                          │
│                  ┌────┴────┐                     │
│                  │成本追踪器│                     │
│                  │ Tracker │                     │
│                  └─────────┘                     │
└──────────────────────┬──────────────────────────┘
                       │
          ┌────────────┼────────────┐
          ▼            ▼            ▼
     ┌─────────┐ ┌─────────┐ ┌─────────┐
     │ GPT-4o  │ │ GPT-4o  │ │ GPT-4o  │
     │  mini   │ │         │ │  (强)   │
     │ (简单)  │ │ (中等)  │ │ Claude  │
     └─────────┘ └─────────┘ └─────────┘
```

### 3.2 核心类：TieredLLMRouter

```python
"""
分层 LLM 路由器 — 按任务复杂度动态路由到不同模型。

用法：
    router = TieredLLMRouter(config)
    result = await router.call("summarize", messages)
"""

from __future__ import annotations

import time
import logging
from enum import Enum
from dataclasses import dataclass, field
from typing import Any, Callable, Optional

logger = logging.getLogger(__name__)


class TaskComplexity(Enum):
    """任务复杂度分级。"""
    SIMPLE = "simple"
    MEDIUM = "medium"
    COMPLEX = "complex"


@dataclass
class ModelSpec:
    """单个模型的规格定义。"""
    name: str                          # 模型标识，如 "gpt-4o-mini"
    provider: str                      # 提供商，如 "openai", "anthropic"
    complexity: TaskComplexity         # 适用的复杂度级别
    cost_per_1k_input: float           # 每 1K input tokens 成本（美元）
    cost_per_1k_output: float          # 每 1K output tokens 成本（美元）
    max_tokens: int = 4096             # 默认最大输出 tokens
    temperature: float = 0.7           # 默认温度
    fallback: Optional[str] = None     # 降级模型名称


@dataclass
class RoutingRecord:
    """单次路由决策记录。"""
    task_type: str
    complexity: TaskComplexity
    model_used: str
    input_tokens: int
    output_tokens: int
    cost_usd: float
    latency_ms: float
    timestamp: float = field(default_factory=time.time)
    fallback_used: bool = False


class TieredLLMRouter:
    """分层 LLM 路由器。"""

    def __init__(self, models: list[ModelSpec], classifier: TaskClassifier | None = None):
        self._registry: dict[str, ModelSpec] = {m.name: m for m in models}
        self._tier_map: dict[TaskComplexity, ModelSpec] = {}
        for m in models:
            if m.complexity not in self._tier_map:
                self._tier_map[m.complexity] = m
        self._classifier = classifier or KeywordTaskClassifier()
        self._records: list[RoutingRecord] = []
        self._budget_limit: Optional[float] = None

    def set_budget(self, max_usd: float) -> None:
        """设置成本预算上限（美元）。"""
        self._budget_limit = max_usd

    @property
    def total_cost(self) -> float:
        """累计总成本。"""
        return sum(r.cost_usd for r in self._records)

    def _select_model(self, task_type: str, content: str) -> ModelSpec:
        """根据任务类型和内容选择模型。"""
        complexity = self._classifier.classify(task_type, content)

        # 预算检查：如果接近预算上限，强制降级到最便宜的模型
        if self._budget_limit and self.total_cost > self._budget_limit * 0.9:
            logger.warning("接近预算上限 (%.2f/%.2f)，强制降级", self.total_cost, self._budget_limit)
            complexity = TaskComplexity.SIMPLE

        model = self._tier_map.get(complexity)
        if model is None:
            # 找不到对应级别的模型，向下降级
            for fallback_level in [TaskComplexity.MEDIUM, TaskComplexity.SIMPLE]:
                model = self._tier_map.get(fallback_level)
                if model:
                    break
        if model is None:
            raise ValueError("没有可用的模型")
        return model

    async def call(
        self,
        task_type: str,
        messages: list[dict[str, str]],
        llm_client: Any = None,
        **kwargs,
    ) -> dict[str, Any]:
        """
        路由并调用 LLM。

        Args:
            task_type: 任务类型标识，如 "summarize", "plan", "extract"
            messages: OpenAI 格式的消息列表
            llm_client: 实际的 LLM 客户端（需实现 async chat() 方法）
            **kwargs: 传递给 LLM 客户端的额外参数

        Returns:
            {"content": str, "model": str, "usage": dict, "cost": float}
        """
        content = messages[-1].get("content", "") if messages else ""
        model = self._select_model(task_type, content)

        # 预算硬限制
        if self._budget_limit and self.total_cost >= self._budget_limit:
            raise BudgetExceededError(
                f"预算已耗尽: ${self.total_cost:.4f} >= ${self._budget_limit:.4f}"
            )

        start = time.monotonic()
        fallback_used = False

        try:
            result = await self._do_call(llm_client, model, messages, **kwargs)
        except Exception as e:
            # 尝试降级
            logger.warning("模型 %s 调用失败: %s，尝试降级", model.name, e)
            if model.fallback and model.fallback in self._registry:
                model = self._registry[model.fallback]
                result = await self._do_call(llm_client, model, messages, **kwargs)
                fallback_used = True
            else:
                raise

        latency_ms = (time.monotonic() - start) * 1000
        usage = result.get("usage", {})
        input_tokens = usage.get("prompt_tokens", 0)
        output_tokens = usage.get("completion_tokens", 0)
        cost = self._calc_cost(model, input_tokens, output_tokens)

        record = RoutingRecord(
            task_type=task_type,
            complexity=self._classifier.classify(task_type, content),
            model_used=model.name,
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            cost_usd=cost,
            latency_ms=latency_ms,
            fallback_used=fallback_used,
        )
        self._records.append(record)
        logger.info(
            "路由: %s → %s (%.1fms, $%.4f)",
            task_type, model.name, latency_ms, cost,
        )

        return {
            "content": result.get("content", ""),
            "model": model.name,
            "usage": usage,
            "cost": cost,
        }

    async def _do_call(
        self, client: Any, model: ModelSpec, messages: list, **kwargs
    ) -> dict:
        """实际调用 LLM 客户端。需要适配你的 LLM SDK。"""
        if client is None:
            raise ValueError("需要提供 llm_client")
        return await client.chat(
            model=model.name,
            messages=messages,
            max_tokens=kwargs.get("max_tokens", model.max_tokens),
            temperature=kwargs.get("temperature", model.temperature),
        )

    def _calc_cost(self, model: ModelSpec, input_tokens: int, output_tokens: int) -> float:
        """计算单次调用成本。"""
        return (
            model.cost_per_1k_input * input_tokens / 1000
            + model.cost_per_1k_output * output_tokens / 1000
        )

    def get_stats(self) -> dict:
        """获取路由统计信息。"""
        if not self._records:
            return {"total_calls": 0, "total_cost": 0.0}

        by_model: dict[str, dict] = {}
        for r in self._records:
            if r.model_used not in by_model:
                by_model[r.model_used] = {"calls": 0, "cost": 0.0, "tokens": 0}
            by_model[r.model_used]["calls"] += 1
            by_model[r.model_used]["cost"] += r.cost_usd
            by_model[r.model_used]["tokens"] += r.input_tokens + r.output_tokens

        return {
            "total_calls": len(self._records),
            "total_cost": self.total_cost,
            "by_model": by_model,
            "fallback_count": sum(1 for r in self._records if r.fallback_used),
        }


class BudgetExceededError(Exception):
    """预算超限异常。"""
    pass
```

### 3.3 任务复杂度分类器

```python
from abc import ABC, abstractmethod
import re


class TaskClassifier(ABC):
    """任务分类器基类。"""

    @abstractmethod
    def classify(self, task_type: str, content: str) -> TaskComplexity:
        """根据任务类型和内容判断复杂度。"""
        ...


class KeywordTaskClassifier(TaskClassifier):
    """
    基于关键词 + 规则的任务分类器。
    适用于任务类型可枚举的场景。
    """

    # 任务类型 → 复杂度的静态映射
    TASK_TYPE_MAP: dict[str, TaskComplexity] = {
        # 简单任务
        "extract": TaskComplexity.SIMPLE,
        "format": TaskComplexity.SIMPLE,
        "classify": TaskComplexity.SIMPLE,
        "keyword": TaskComplexity.SIMPLE,
        "template": TaskComplexity.SIMPLE,
        # 中等任务
        "summarize": TaskComplexity.MEDIUM,
        "translate": TaskComplexity.MEDIUM,
        "rewrite": TaskComplexity.MEDIUM,
        "qa": TaskComplexity.MEDIUM,
        # 复杂任务
        "plan": TaskComplexity.COMPLEX,
        "reason": TaskComplexity.COMPLEX,
        "analyze": TaskComplexity.COMPLEX,
        "create": TaskComplexity.COMPLEX,
        "debate": TaskComplexity.COMPLEX,
    }

    # 内容特征 → 复杂度升级的关键词
    COMPLEXITY_KEYWORDS: dict[TaskComplexity, list[str]] = {
        TaskComplexity.COMPLEX: [
            "step by step", "分步", "推理", "比较.*优劣",
            "设计方案", "架构", "权衡", "trade-off",
        ],
        TaskComplexity.MEDIUM: [
            "总结", "概括", "summarize", "翻译", "改写",
        ],
    }

    def classify(self, task_type: str, content: str) -> TaskComplexity:
        # 1. 先查静态映射
        base = self.TASK_TYPE_MAP.get(task_type, TaskComplexity.MEDIUM)

        # 2. 内容关键词可以升级复杂度（但不降级）
        for level in [TaskComplexity.COMPLEX, TaskComplexity.MEDIUM]:
            for pattern in self.COMPLEXITY_KEYWORDS.get(level, []):
                if re.search(pattern, content, re.IGNORECASE):
                    if level.value > base.value or (
                        level == TaskComplexity.COMPLEX
                    ):
                        return level

        # 3. 长内容自动升级（超过 2000 字符视为中等以上）
        if len(content) > 5000 and base == TaskComplexity.SIMPLE:
            return TaskComplexity.MEDIUM
        if len(content) > 10000:
            return TaskComplexity.COMPLEX

        return base
```

### 3.4 模型注册表

```python
# ============================================================
# 预置模型注册表 — 按需选用，价格为 2025 年参考值
# ============================================================

OPENAI_MODELS = [
    ModelSpec(
        name="gpt-4o-mini",
        provider="openai",
        complexity=TaskComplexity.SIMPLE,
        cost_per_1k_input=0.00015,
        cost_per_1k_output=0.0006,
        max_tokens=4096,
        temperature=0.0,
        fallback=None,  # 最底层，无降级
    ),
    ModelSpec(
        name="gpt-4o",
        provider="openai",
        complexity=TaskComplexity.MEDIUM,
        cost_per_1k_input=0.0025,
        cost_per_1k_output=0.01,
        max_tokens=4096,
        temperature=0.5,
        fallback="gpt-4o-mini",
    ),
    ModelSpec(
        name="o3-mini",
        provider="openai",
        complexity=TaskComplexity.COMPLEX,
        cost_per_1k_input=0.0011,
        cost_per_1k_output=0.0044,
        max_tokens=8192,
        temperature=1.0,  # reasoning 模型固定 temperature
        fallback="gpt-4o",
    ),
]

ANTHROPIC_MODELS = [
    ModelSpec(
        name="claude-haiku",
        provider="anthropic",
        complexity=TaskComplexity.SIMPLE,
        cost_per_1k_input=0.00025,
        cost_per_1k_output=0.00125,
        max_tokens=4096,
        temperature=0.0,
    ),
    ModelSpec(
        name="claude-sonnet",
        provider="anthropic",
        complexity=TaskComplexity.MEDIUM,
        cost_per_1k_input=0.003,
        cost_per_1k_output=0.015,
        max_tokens=4096,
        temperature=0.5,
        fallback="claude-haiku",
    ),
    ModelSpec(
        name="claude-opus",
        provider="anthropic",
        complexity=TaskComplexity.COMPLEX,
        cost_per_1k_input=0.015,
        cost_per_1k_output=0.075,
        max_tokens=4096,
        temperature=0.7,
        fallback="claude-sonnet",
    ),
]
```

### 3.5 路由策略

除了默认的关键词分类器，还可以实现更高级的路由策略：

```python
class LLMBasedClassifier(TaskClassifier):
    """
    用小模型对任务进行复杂度分类。
    适用于任务类型不可枚举、需要语义理解的场景。
    注意：每次路由会额外消耗一次 LLM 调用（用最便宜的模型）。
    """

    CLASSIFICATION_PROMPT = """判断以下任务的复杂度级别。

任务类型: {task_type}
任务内容: {content_preview}

复杂度定义:
- simple: 格式转换、信息提取、模板填充，不需要推理
- medium: 摘要、改写、问答，需要理解但不需要深度推理
- complex: 多步推理、规划、创意生成、矛盾分析

只回复一个词: simple / medium / complex"""

    def __init__(self, llm_client: Any, classifier_model: str = "gpt-4o-mini"):
        self._client = llm_client
        self._model = classifier_model

    def classify(self, task_type: str, content: str) -> TaskComplexity:
        # 同步版本，实际使用中建议改为异步
        prompt = self.CLASSIFICATION_PROMPT.format(
            task_type=task_type,
            content_preview=content[:500],  # 只取前 500 字符节省成本
        )
        try:
            response = self._client.chat_sync(
                model=self._model,
                messages=[{"role": "user", "content": prompt}],
                max_tokens=10,
                temperature=0.0,
            )
            level = response.strip().lower()
            return TaskComplexity(level)
        except (ValueError, Exception):
            return TaskComplexity.MEDIUM  # 分类失败默认中等
```

### 3.6 成本追踪

```python
class CostTracker:
    """
    独立的成本追踪器，可与路由器配合使用，也可独立使用。
    支持按时间窗口、按模型、按任务类型的多维度统计。
    """

    def __init__(self):
        self._records: list[RoutingRecord] = []

    def record(self, entry: RoutingRecord) -> None:
        self._records.append(entry)

    def cost_by_model(self) -> dict[str, float]:
        result: dict[str, float] = {}
        for r in self._records:
            result[r.model_used] = result.get(r.model_used, 0) + r.cost_usd
        return result

    def cost_by_task_type(self) -> dict[str, float]:
        result: dict[str, float] = {}
        for r in self._records:
            result[r.task_type] = result.get(r.task_type, 0) + r.cost_usd
        return result

    def cost_by_complexity(self) -> dict[str, float]:
        result: dict[str, float] = {}
        for r in self._records:
            key = r.complexity.value
            result[key] = result.get(key, 0) + r.cost_usd
        return result

    def savings_estimate(self, single_model_cost_per_1k: float = 0.01) -> dict:
        """
        估算相比全部使用单一强模型节省了多少成本。

        Args:
            single_model_cost_per_1k: 如果全用强模型，每 1K tokens 的平均成本
        """
        total_tokens = sum(r.input_tokens + r.output_tokens for r in self._records)
        single_model_cost = single_model_cost_per_1k * total_tokens / 1000
        actual_cost = sum(r.cost_usd for r in self._records)
        return {
            "single_model_cost": single_model_cost,
            "tiered_cost": actual_cost,
            "saved": single_model_cost - actual_cost,
            "saved_pct": (
                (single_model_cost - actual_cost) / single_model_cost * 100
                if single_model_cost > 0 else 0
            ),
        }

    def summary(self) -> str:
        """生成人类可读的成本摘要。"""
        stats = self.savings_estimate()
        lines = [
            f"总调用次数: {len(self._records)}",
            f"总成本: ${sum(r.cost_usd for r in self._records):.4f}",
            f"预估节省: ${stats['saved']:.4f} ({stats['saved_pct']:.1f}%)",
            "",
            "按模型分布:",
        ]
        for model, cost in sorted(self.cost_by_model().items()):
            count = sum(1 for r in self._records if r.model_used == model)
            lines.append(f"  {model}: {count} 次, ${cost:.4f}")
        return "\n".join(lines)
```

### 3.7 配置参数

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `models` | 必填 | `ModelSpec` 列表，至少包含一个 SIMPLE 级别模型 |
| `classifier` | `KeywordTaskClassifier` | 任务分类器实例 |
| `budget_limit` | `None` | 成本预算上限（美元），`None` 表示不限制 |
| `budget_warning_pct` | `0.9` | 预算告警阈值，超过此比例自动降级 |
| `fallback_enabled` | `True` | 是否启用模型降级 |
| `log_level` | `INFO` | 路由日志级别 |

---

## 第 4 章 集成指南

### 4.1 最小可运行示例

```python
import asyncio


# --- 1. 模拟 LLM 客户端（替换为你的实际 SDK）---
class MockLLMClient:
    async def chat(self, model: str, messages: list, **kwargs) -> dict:
        content = f"[{model}] 模拟回复: {messages[-1]['content'][:50]}..."
        return {
            "content": content,
            "usage": {"prompt_tokens": 100, "completion_tokens": 50},
        }


# --- 2. 初始化路由器 ---
router = TieredLLMRouter(models=OPENAI_MODELS)
router.set_budget(max_usd=1.0)  # 可选：设置预算上限
client = MockLLMClient()


# --- 3. 使用 ---
async def main():
    # 简单任务 → 自动路由到 gpt-4o-mini
    r1 = await router.call(
        task_type="extract",
        messages=[{"role": "user", "content": "提取以下文本的关键词: ..."}],
        llm_client=client,
    )
    print(f"提取: {r1['model']} → ${r1['cost']:.4f}")

    # 中等任务 → 自动路由到 gpt-4o
    r2 = await router.call(
        task_type="summarize",
        messages=[{"role": "user", "content": "总结以下文章: ..."}],
        llm_client=client,
    )
    print(f"摘要: {r2['model']} → ${r2['cost']:.4f}")

    # 复杂任务 → 自动路由到 o3-mini
    r3 = await router.call(
        task_type="plan",
        messages=[{"role": "user", "content": "设计一个分布式系统架构方案..."}],
        llm_client=client,
    )
    print(f"规划: {r3['model']} → ${r3['cost']:.4f}")

    # 查看统计
    print("\n--- 路由统计 ---")
    stats = router.get_stats()
    print(f"总调用: {stats['total_calls']}")
    print(f"总成本: ${stats['total_cost']:.4f}")
    for model, info in stats["by_model"].items():
        print(f"  {model}: {info['calls']} 次, ${info['cost']:.4f}")


asyncio.run(main())
```

预期输出：

```
提取: gpt-4o-mini → $0.0000
摘要: gpt-4o → $0.0008
规划: o3-mini → $0.0003

--- 路由统计 ---
总调用: 3
总成本: $0.0011
  gpt-4o-mini: 1 次, $0.0000
  gpt-4o: 1 次, $0.0008
  o3-mini: 1 次, $0.0003
```

### 4.2 添加新模型

```python
# 添加 DeepSeek 模型
deepseek_models = [
    ModelSpec(
        name="deepseek-chat",
        provider="deepseek",
        complexity=TaskComplexity.MEDIUM,
        cost_per_1k_input=0.00014,
        cost_per_1k_output=0.00028,
        max_tokens=4096,
        temperature=0.5,
        fallback="gpt-4o-mini",  # 降级到 OpenAI 的便宜模型
    ),
    ModelSpec(
        name="deepseek-reasoner",
        provider="deepseek",
        complexity=TaskComplexity.COMPLEX,
        cost_per_1k_input=0.00055,
        cost_per_1k_output=0.0022,
        max_tokens=8192,
        temperature=1.0,
        fallback="deepseek-chat",
    ),
]

# 混合使用多家模型
router = TieredLLMRouter(
    models=[OPENAI_MODELS[0]] + deepseek_models  # mini + deepseek
)
```

### 4.3 自定义路由规则

```python
class ProjectSpecificClassifier(TaskClassifier):
    """项目专用分类器示例：电商场景。"""

    def classify(self, task_type: str, content: str) -> TaskComplexity:
        # 商品描述生成 → 简单
        if task_type in ("product_desc", "tag_extract"):
            return TaskComplexity.SIMPLE

        # 用户评论分析 → 中等
        if task_type in ("review_analysis", "sentiment"):
            return TaskComplexity.MEDIUM

        # 竞品分析、定价策略 → 复杂
        if task_type in ("competitor_analysis", "pricing_strategy"):
            return TaskComplexity.COMPLEX

        # 默认：根据内容长度判断
        if len(content) > 3000:
            return TaskComplexity.MEDIUM
        return TaskComplexity.SIMPLE


router = TieredLLMRouter(
    models=OPENAI_MODELS,
    classifier=ProjectSpecificClassifier(),
)
```

### 4.4 成本预算控制

```python
# 场景：每日预算 $5，超出后降级到最便宜模型
router = TieredLLMRouter(models=OPENAI_MODELS)
router.set_budget(max_usd=5.0)

# 路由器行为：
# - 成本 < $4.50 (90%): 正常路由
# - $4.50 <= 成本 < $5.00: 所有任务强制降级到 SIMPLE 模型
# - 成本 >= $5.00: 抛出 BudgetExceededError

# 在应用层捕获预算异常
async def safe_call(router, task_type, messages, client):
    try:
        return await router.call(task_type, messages, llm_client=client)
    except BudgetExceededError:
        # 预算耗尽的处理策略：
        # 1. 返回缓存结果
        # 2. 排队等待次日预算重置
        # 3. 通知管理员
        logger.error("预算耗尽，任务 %s 被拒绝", task_type)
        return None
```

---

## 第 5 章 测试用例

```python
"""
分层 LLM 路由器测试套件。
运行: pytest test_tiered_router.py -v
"""

import pytest
import asyncio
from unittest.mock import AsyncMock, MagicMock


# ============================================================
# Fixtures
# ============================================================

@pytest.fixture
def simple_models():
    """最小模型配置：三个级别各一个模型。"""
    return [
        ModelSpec(
            name="cheap-model",
            provider="test",
            complexity=TaskComplexity.SIMPLE,
            cost_per_1k_input=0.0001,
            cost_per_1k_output=0.0002,
        ),
        ModelSpec(
            name="mid-model",
            provider="test",
            complexity=TaskComplexity.MEDIUM,
            cost_per_1k_input=0.001,
            cost_per_1k_output=0.002,
            fallback="cheap-model",
        ),
        ModelSpec(
            name="strong-model",
            provider="test",
            complexity=TaskComplexity.COMPLEX,
            cost_per_1k_input=0.01,
            cost_per_1k_output=0.02,
            fallback="mid-model",
        ),
    ]


@pytest.fixture
def mock_client():
    """模拟 LLM 客户端。"""
    client = AsyncMock()
    client.chat.return_value = {
        "content": "test response",
        "usage": {"prompt_tokens": 100, "completion_tokens": 50},
    }
    return client


@pytest.fixture
def router(simple_models):
    return TieredLLMRouter(models=simple_models)


# ============================================================
# 路由决策测试
# ============================================================

class TestRouting:
    """测试任务到模型的路由决策。"""

    @pytest.mark.asyncio
    async def test_simple_task_routes_to_cheap_model(self, router, mock_client):
        result = await router.call("extract", [{"role": "user", "content": "提取关键词"}], llm_client=mock_client)
        assert result["model"] == "cheap-model"

    @pytest.mark.asyncio
    async def test_medium_task_routes_to_mid_model(self, router, mock_client):
        result = await router.call("summarize", [{"role": "user", "content": "总结文章"}], llm_client=mock_client)
        assert result["model"] == "mid-model"

    @pytest.mark.asyncio
    async def test_complex_task_routes_to_strong_model(self, router, mock_client):
        result = await router.call("plan", [{"role": "user", "content": "设计架构"}], llm_client=mock_client)
        assert result["model"] == "strong-model"

    @pytest.mark.asyncio
    async def test_unknown_task_defaults_to_medium(self, router, mock_client):
        result = await router.call("unknown_task", [{"role": "user", "content": "随便"}], llm_client=mock_client)
        assert result["model"] == "mid-model"

    @pytest.mark.asyncio
    async def test_long_content_upgrades_complexity(self, router, mock_client):
        long_content = "x" * 6000  # 超过 5000 字符
        result = await router.call("extract", [{"role": "user", "content": long_content}], llm_client=mock_client)
        # extract 本来是 SIMPLE，但长内容应升级到 MEDIUM
        assert result["model"] == "mid-model"


# ============================================================
# 降级测试
# ============================================================

class TestFallback:
    """测试模型不可用时的降级行为。"""

    @pytest.mark.asyncio
    async def test_fallback_on_failure(self, router, mock_client):
        # 第一次调用失败，第二次成功（降级到 fallback 模型）
        mock_client.chat.side_effect = [
            Exception("模型不可用"),
            {"content": "fallback response", "usage": {"prompt_tokens": 50, "completion_tokens": 25}},
        ]
        result = await router.call("plan", [{"role": "user", "content": "test"}], llm_client=mock_client)
        assert result["model"] == "mid-model"  # 从 strong 降级到 mid
        assert result["content"] == "fallback response"

    @pytest.mark.asyncio
    async def test_no_fallback_raises(self, simple_models, mock_client):
        # cheap-model 没有 fallback，失败时应抛异常
        router = TieredLLMRouter(models=[simple_models[0]])  # 只有 cheap-model
        mock_client.chat.side_effect = Exception("模型不可用")
        with pytest.raises(Exception, match="模型不可用"):
            await router.call("extract", [{"role": "user", "content": "test"}], llm_client=mock_client)


# ============================================================
# 预算控制测试
# ============================================================

class TestBudget:
    """测试成本预算控制。"""

    @pytest.mark.asyncio
    async def test_budget_warning_forces_downgrade(self, router, mock_client):
        router.set_budget(max_usd=0.001)
        # 手动注入已有成本记录，使其超过 90% 阈值
        router._records.append(RoutingRecord(
            task_type="test", complexity=TaskComplexity.SIMPLE,
            model_used="cheap-model", input_tokens=0, output_tokens=0,
            cost_usd=0.00095, latency_ms=0,
        ))
        # 此时 total_cost = 0.00095 > 0.001 * 0.9 = 0.0009
        # 应强制降级到 SIMPLE
        result = await router.call("plan", [{"role": "user", "content": "test"}], llm_client=mock_client)
        assert result["model"] == "cheap-model"

    @pytest.mark.asyncio
    async def test_budget_exceeded_raises(self, router, mock_client):
        router.set_budget(max_usd=0.001)
        router._records.append(RoutingRecord(
            task_type="test", complexity=TaskComplexity.SIMPLE,
            model_used="cheap-model", input_tokens=0, output_tokens=0,
            cost_usd=0.001, latency_ms=0,
        ))
        with pytest.raises(BudgetExceededError):
            await router.call("extract", [{"role": "user", "content": "test"}], llm_client=mock_client)


# ============================================================
# 统计测试
# ============================================================

class TestStats:
    """测试路由统计功能。"""

    @pytest.mark.asyncio
    async def test_stats_after_calls(self, router, mock_client):
        await router.call("extract", [{"role": "user", "content": "a"}], llm_client=mock_client)
        await router.call("summarize", [{"role": "user", "content": "b"}], llm_client=mock_client)
        await router.call("plan", [{"role": "user", "content": "c"}], llm_client=mock_client)

        stats = router.get_stats()
        assert stats["total_calls"] == 3
        assert stats["total_cost"] > 0
        assert len(stats["by_model"]) == 3

    def test_empty_stats(self, router):
        stats = router.get_stats()
        assert stats["total_calls"] == 0
        assert stats["total_cost"] == 0.0


# ============================================================
# 分类器测试
# ============================================================

class TestClassifier:
    """测试任务分类器。"""

    def test_keyword_classifier_static_mapping(self):
        c = KeywordTaskClassifier()
        assert c.classify("extract", "短文本") == TaskComplexity.SIMPLE
        assert c.classify("summarize", "短文本") == TaskComplexity.MEDIUM
        assert c.classify("plan", "短文本") == TaskComplexity.COMPLEX

    def test_keyword_classifier_content_upgrade(self):
        c = KeywordTaskClassifier()
        # "推理" 关键词应升级到 COMPLEX
        assert c.classify("extract", "请分步推理这个问题") == TaskComplexity.COMPLEX

    def test_keyword_classifier_length_upgrade(self):
        c = KeywordTaskClassifier()
        # 超长内容应升级
        assert c.classify("extract", "x" * 6000) == TaskComplexity.MEDIUM
        assert c.classify("extract", "x" * 11000) == TaskComplexity.COMPLEX

    def test_keyword_classifier_unknown_task(self):
        c = KeywordTaskClassifier()
        # 未知任务类型默认 MEDIUM
        assert c.classify("unknown", "短文本") == TaskComplexity.MEDIUM
```

---

## 第 6 章 风险与降级

### 6.1 风险矩阵

| 风险 | 概率 | 影响 | 缓解措施 |
|------|------|------|----------|
| 分类器误判（简单任务被路由到弱模型导致质量差） | 中 | 中 | 关键任务硬编码为 COMPLEX；监控质量指标 |
| 模型提供商宕机 | 低 | 高 | fallback 链跨提供商（OpenAI → Anthropic → 本地） |
| 预算耗尽导致服务中断 | 中 | 高 | 预算告警 + 降级而非拒绝；预留 10% 紧急预算 |
| 新模型定价变化 | 高 | 低 | ModelSpec 中的价格参数化，定期更新 |
| 路由器本身的延迟开销 | 低 | 低 | 关键词分类器延迟 < 1ms，可忽略 |

### 6.2 降级策略

```
正常模式:
  COMPLEX → strong-model
  MEDIUM  → mid-model
  SIMPLE  → cheap-model

降级模式 1（强模型不可用）:
  COMPLEX → mid-model (fallback)
  MEDIUM  → mid-model
  SIMPLE  → cheap-model

降级模式 2（预算告警）:
  COMPLEX → cheap-model (强制降级)
  MEDIUM  → cheap-model (强制降级)
  SIMPLE  → cheap-model

降级模式 3（全面降级 / 灾难恢复）:
  所有任务 → 本地模型 (如 Ollama + Qwen-7B)
```

### 6.3 质量监控建议

分层路由的最大风险是质量下降不可见。建议：

1. 对每个复杂度级别抽样评估输出质量（人工或 LLM-as-Judge）
2. 记录每次路由决策，定期分析分类器准确率
3. 设置质量基线：如果某个模型的输出质量低于阈值，自动升级到更强模型

---

## 第 7 章 适用场景与限制

### 7.1 适用场景

| 场景 | 说明 | 预期收益 |
|------|------|----------|
| Agent 工作流 | 规划用强模型，执行用弱模型 | 成本降低 60-80% |
| 批量处理 | 大量简单任务（分类、提取）混合少量复杂任务 | 成本降低 70-90% |
| 多租户 SaaS | 免费用户用弱模型，付费用户用强模型 | 按用户分级控制成本 |
| 开发/测试环境 | 开发时全用弱模型，生产时按需路由 | 开发成本趋近于零 |

### 7.2 不适用场景

| 场景 | 原因 | 替代方案 |
|------|------|----------|
| 所有任务都是复杂推理 | 分层无意义，全部需要强模型 | 直接用强模型 + 缓存 |
| 调用量极低（< 10 次/天） | 成本差异可忽略，路由器增加复杂度 | 直接用一个模型 |
| 对延迟极度敏感 | 路由决策增加微量延迟 | 静态绑定（DeepResearch 方式） |
| 输出质量零容忍 | 弱模型可能产生低质量输出 | 全用强模型 + 质量检查 |

### 7.3 与其他方案的关系

| 相关方案 | 关系 |
|----------|------|
| PD-01 上下文管理 | 分层路由可与上下文裁剪配合：裁剪后的短上下文用弱模型，完整上下文用强模型 |
| PD-03 容错与重试 | fallback 链是容错的一种形式；重试时可升级模型 |
| PD-11 可观测性 | 路由记录是可观测性的数据源；成本追踪是可观测性的子集 |
| PD-12.01 Extended Thinking | 分层路由决定用哪个模型，Extended Thinking 决定模型内部如何推理 |

---

## 附录 A：快速接入清单

```
[ ] 1. 复制 TieredLLMRouter + ModelSpec + TaskClassifier 到项目
[ ] 2. 根据你的模型选择，配置 ModelSpec 列表
[ ] 3. 根据你的任务类型，配置 KeywordTaskClassifier.TASK_TYPE_MAP
[ ] 4. 实现 _do_call() 方法适配你的 LLM SDK
[ ] 5. 设置预算上限（可选）
[ ] 6. 运行测试套件确认路由行为正确
[ ] 7. 部署后监控成本追踪数据，调优分类规则
```

## 附录 B：成本速查表（2025 参考价）

| 模型 | Input $/1M tokens | Output $/1M tokens | 适用级别 |
|------|-------------------|---------------------|----------|
| GPT-4o-mini | $0.15 | $0.60 | SIMPLE |
| Claude Haiku | $0.25 | $1.25 | SIMPLE |
| DeepSeek-Chat | $0.14 | $0.28 | MEDIUM |
| GPT-4o | $2.50 | $10.00 | MEDIUM |
| Claude Sonnet | $3.00 | $15.00 | MEDIUM |
| o3-mini | $1.10 | $4.40 | COMPLEX |
| DeepSeek-Reasoner | $0.55 | $2.19 | COMPLEX |
| Claude Opus | $15.00 | $75.00 | COMPLEX |
