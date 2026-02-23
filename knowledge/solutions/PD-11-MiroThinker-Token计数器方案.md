# PD-11.01 MiroThinker — Token 计数器 + 调用日志

> 文档编号：PD-11.01
> 来源：MiroThinker `openai_client.py` / `utils/metrics.py`
> GitHub：https://github.com/MiroMindAI/MiroThinker
> 问题域：PD-11 可观测性 Observability & Cost Tracking
> 状态：可复用方案

---

## 第 1 章 问题与动机

### 1.1 核心问题

Agent 系统在生产环境中面临成本失控和调试困难两大问题：

- **成本不可见**：每次 LLM 调用消耗多少 token？一个完整任务的总成本是多少？哪个节点最贵？
- **调试困难**：Agent 输出不符合预期时，无法回溯每次 LLM 调用的输入输出
- **预算失控**：没有成本预警机制，一个死循环可能烧掉大量 API 费用
- **性能盲区**：不知道哪个 LLM 调用最慢，无法针对性优化

### 1.2 MiroThinker 的解法概述

MiroThinker 在 LLM 客户端层实现了轻量级可观测性：

1. **Per-call Token 计数**：每次 API 调用记录 prompt_tokens 和 completion_tokens
2. **模型成本计算**：根据模型定价自动计算每次调用的美元成本
3. **累计追踪**：维护会话级别的累计 token 和成本
4. **结构化日志**：每次调用输出结构化日志，包含模型、token、耗时、成本
5. **成本预算告警**：累计成本超过阈值时触发告警

### 1.3 设计思想

| 原则 | 说明 |
|------|------|
| 零侵入 | 在客户端层拦截，不改变业务代码 |
| 实时计算 | 每次调用后立即计算成本，不依赖后处理 |
| 累计追踪 | 会话级别累计，支持任务粒度的成本分析 |
| 可配置告警 | 成本阈值可配置，超限时回调通知 |
| 结构化输出 | JSON 格式日志，便于后续分析和可视化 |

---

## 第 2 章 源码实现分析

### 2.1 整体架构

```
MiroThinker/
├── openai_client.py      # LLM 客户端：调用拦截 + token 记录
├── utils/
│   ├── metrics.py        # 指标收集器：累计统计 + 成本计算
│   └── pricing.py        # 模型定价表
└── config.py             # 配置：预算阈值、日志级别
```

### 2.2 模型定价表

```python
# utils/pricing.py（简化）

# 价格单位：美元 / 1M tokens
MODEL_PRICING = {
    "gpt-4o": {"prompt": 2.50, "completion": 10.00},
    "gpt-4o-mini": {"prompt": 0.15, "completion": 0.60},
    "gpt-4-turbo": {"prompt": 10.00, "completion": 30.00},
    "gpt-3.5-turbo": {"prompt": 0.50, "completion": 1.50},
    "claude-3-opus": {"prompt": 15.00, "completion": 75.00},
    "claude-3-sonnet": {"prompt": 3.00, "completion": 15.00},
    "claude-3-haiku": {"prompt": 0.25, "completion": 1.25},
    "claude-sonnet-4": {"prompt": 3.00, "completion": 15.00},
    "claude-opus-4": {"prompt": 15.00, "completion": 75.00},
}


def calculate_cost(model: str, prompt_tokens: int,
                   completion_tokens: int) -> float:
    """计算单次调用成本（美元）"""
    pricing = MODEL_PRICING.get(model)
    if not pricing:
        return 0.0
    prompt_cost = (prompt_tokens / 1_000_000) * pricing["prompt"]
    completion_cost = (completion_tokens / 1_000_000) * pricing["completion"]
    return prompt_cost + completion_cost
```

### 2.3 指标收集器

```python
# utils/metrics.py（简化）
import time
import logging
from dataclasses import dataclass, field
from typing import Callable

logger = logging.getLogger(__name__)


@dataclass
class CallMetrics:
    """单次 LLM 调用指标"""
    model: str
    prompt_tokens: int
    completion_tokens: int
    total_tokens: int
    cost_usd: float
    latency_ms: float
    timestamp: float
    success: bool
    error: str | None = None


@dataclass
class SessionMetrics:
    """会话级累计指标"""
    total_calls: int = 0
    successful_calls: int = 0
    failed_calls: int = 0
    total_prompt_tokens: int = 0
    total_completion_tokens: int = 0
    total_tokens: int = 0
    total_cost_usd: float = 0.0
    total_latency_ms: float = 0.0
    calls: list[CallMetrics] = field(default_factory=list)
    cost_by_model: dict[str, float] = field(default_factory=dict)
    tokens_by_model: dict[str, int] = field(default_factory=dict)


class MetricsCollector:
    """指标收集器：记录每次 LLM 调用并累计统计"""

    def __init__(self, budget_limit: float | None = None,
                 on_budget_exceeded: Callable | None = None):
        self.session = SessionMetrics()
        self.budget_limit = budget_limit
        self.on_budget_exceeded = on_budget_exceeded

    def record(self, metrics: CallMetrics) -> None:
        """记录一次调用指标"""
        self.session.total_calls += 1
        self.session.calls.append(metrics)

        if metrics.success:
            self.session.successful_calls += 1
            self.session.total_prompt_tokens += metrics.prompt_tokens
            self.session.total_completion_tokens += metrics.completion_tokens
            self.session.total_tokens += metrics.total_tokens
            self.session.total_cost_usd += metrics.cost_usd
            self.session.total_latency_ms += metrics.latency_ms

            # 按模型累计
            model = metrics.model
            self.session.cost_by_model[model] = (
                self.session.cost_by_model.get(model, 0.0) + metrics.cost_usd
            )
            self.session.tokens_by_model[model] = (
                self.session.tokens_by_model.get(model, 0) + metrics.total_tokens
            )
        else:
            self.session.failed_calls += 1

        # 预算检查
        self._check_budget()

        # 结构化日志
        self._log_call(metrics)

    def _check_budget(self) -> None:
        if (self.budget_limit is not None
                and self.session.total_cost_usd > self.budget_limit):
            logger.warning(
                f"预算超限！当前: ${self.session.total_cost_usd:.4f}, "
                f"限制: ${self.budget_limit:.4f}"
            )
            if self.on_budget_exceeded:
                self.on_budget_exceeded(self.session)

    def _log_call(self, m: CallMetrics) -> None:
        logger.info(
            f"LLM调用 | model={m.model} | tokens={m.total_tokens} "
            f"(prompt={m.prompt_tokens}, completion={m.completion_tokens}) | "
            f"cost=${m.cost_usd:.6f} | latency={m.latency_ms:.0f}ms | "
            f"cumulative=${self.session.total_cost_usd:.4f}"
        )

    def get_summary(self) -> dict:
        """获取会话摘要"""
        s = self.session
        return {
            "total_calls": s.total_calls,
            "successful_calls": s.successful_calls,
            "failed_calls": s.failed_calls,
            "total_tokens": s.total_tokens,
            "total_cost_usd": round(s.total_cost_usd, 6),
            "avg_latency_ms": round(s.total_latency_ms / max(s.successful_calls, 1), 1),
            "cost_by_model": {k: round(v, 6) for k, v in s.cost_by_model.items()},
            "tokens_by_model": s.tokens_by_model,
        }

    def reset(self) -> None:
        """重置会话指标"""
        self.session = SessionMetrics()
```

### 2.4 LLM 客户端集成

```python
# openai_client.py（简化）
import time
import openai


class TrackedOpenAIClient:
    """带指标追踪的 OpenAI 客户端"""

    def __init__(self, api_key: str, model: str = "gpt-4o",
                 metrics: MetricsCollector | None = None):
        self.client = openai.AsyncOpenAI(api_key=api_key)
        self.model = model
        self.metrics = metrics or MetricsCollector()

    async def chat(self, messages: list[dict], **kwargs) -> str:
        model = kwargs.pop("model", self.model)
        start = time.monotonic()

        try:
            response = await self.client.chat.completions.create(
                model=model, messages=messages, **kwargs
            )
            latency = (time.monotonic() - start) * 1000
            usage = response.usage

            self.metrics.record(CallMetrics(
                model=model,
                prompt_tokens=usage.prompt_tokens,
                completion_tokens=usage.completion_tokens,
                total_tokens=usage.total_tokens,
                cost_usd=calculate_cost(model, usage.prompt_tokens, usage.completion_tokens),
                latency_ms=latency,
                timestamp=time.time(),
                success=True,
            ))

            return response.choices[0].message.content

        except Exception as e:
            latency = (time.monotonic() - start) * 1000
            self.metrics.record(CallMetrics(
                model=model,
                prompt_tokens=0, completion_tokens=0, total_tokens=0,
                cost_usd=0.0, latency_ms=latency,
                timestamp=time.time(), success=False, error=str(e),
            ))
            raise
```

### 2.5 调用链路

```
业务代码 → TrackedOpenAIClient.chat()
              │
              ├─ 记录开始时间
              ├─ 调用 OpenAI API
              ├─ 提取 usage (prompt_tokens, completion_tokens)
              ├─ 计算成本 (calculate_cost)
              ├─ 记录 CallMetrics → MetricsCollector.record()
              │     ├─ 累计到 SessionMetrics
              │     ├─ 检查预算
              │     └─ 输出结构化日志
              └─ 返回响应内容
```

---

## 第 3 章 迁移指南

### 3.1 通用架构

```
┌─────────────────────────────────────────────────┐
│              ObservableLLMClient                 │
│                                                  │
│  [MetricsCollector] ← record() ← [LLM Call]     │
│       │                                          │
│       ├─ SessionMetrics (累计)                    │
│       ├─ CallMetrics (单次)                       │
│       ├─ BudgetGuard (预算)                       │
│       └─ StructuredLogger (日志)                  │
│                                                  │
│  输出: JSON 日志 / 摘要报告 / 预算告警             │
└─────────────────────────────────────────────────┘
```

### 3.2 最小集成示例

```python
"""minimal_tracking.py — 最小可运行的 token 追踪示例"""
import asyncio
from metrics import MetricsCollector, CallMetrics
from pricing import calculate_cost


# 创建收集器（设置 $1.00 预算）
collector = MetricsCollector(
    budget_limit=1.0,
    on_budget_exceeded=lambda s: print(f"预算超限！已花费 ${s.total_cost_usd:.4f}"),
)

# 创建追踪客户端
client = TrackedOpenAIClient(
    api_key="sk-...",
    model="gpt-4o",
    metrics=collector,
)

async def main():
    # 正常使用，自动追踪
    response = await client.chat([
        {"role": "user", "content": "什么是 Agent？"}
    ])
    print(response)

    # 查看统计
    summary = collector.get_summary()
    print(f"总调用: {summary['total_calls']}")
    print(f"总 token: {summary['total_tokens']}")
    print(f"总成本: ${summary['total_cost_usd']}")

asyncio.run(main())
```

### 3.3 与现有 LLM 客户端集成

```python
"""integration.py — 集成到现有代码"""

# 方式 1：装饰器包装
def track_llm_call(collector: MetricsCollector):
    """装饰器：为任意异步 LLM 调用添加追踪"""
    def decorator(func):
        async def wrapper(*args, **kwargs):
            model = kwargs.get("model", "unknown")
            start = time.monotonic()
            try:
                result = await func(*args, **kwargs)
                latency = (time.monotonic() - start) * 1000
                # 从结果中提取 usage
                usage = getattr(result, "usage", None)
                if usage:
                    collector.record(CallMetrics(
                        model=model,
                        prompt_tokens=usage.prompt_tokens,
                        completion_tokens=usage.completion_tokens,
                        total_tokens=usage.total_tokens,
                        cost_usd=calculate_cost(model, usage.prompt_tokens, usage.completion_tokens),
                        latency_ms=latency,
                        timestamp=time.time(),
                        success=True,
                    ))
                return result
            except Exception as e:
                latency = (time.monotonic() - start) * 1000
                collector.record(CallMetrics(
                    model=model, prompt_tokens=0, completion_tokens=0,
                    total_tokens=0, cost_usd=0.0, latency_ms=latency,
                    timestamp=time.time(), success=False, error=str(e),
                ))
                raise
        return wrapper
    return decorator


# 方式 2：中间件集成（与 PD-10 中间件管道配合）
class MetricsMiddleware(Middleware):
    """可观测性中间件"""
    def __init__(self, collector: MetricsCollector):
        self.collector = collector

    async def __call__(self, messages, call_next, **kwargs):
        model = kwargs.get("model", "unknown")
        start = time.monotonic()
        try:
            result = await call_next(messages, **kwargs)
            latency = (time.monotonic() - start) * 1000
            usage = getattr(result, "usage", None)
            if usage:
                self.collector.record(CallMetrics(
                    model=model,
                    prompt_tokens=usage.prompt_tokens,
                    completion_tokens=usage.completion_tokens,
                    total_tokens=usage.total_tokens,
                    cost_usd=calculate_cost(model, usage.prompt_tokens, usage.completion_tokens),
                    latency_ms=latency, timestamp=time.time(), success=True,
                ))
            return result
        except Exception as e:
            latency = (time.monotonic() - start) * 1000
            self.collector.record(CallMetrics(
                model=model, prompt_tokens=0, completion_tokens=0,
                total_tokens=0, cost_usd=0.0, latency_ms=latency,
                timestamp=time.time(), success=False, error=str(e),
            ))
            raise
```

### 3.4 预算守卫

```python
"""budget_guard.py — 预算守卫"""


class BudgetExceededError(Exception):
    """预算超限异常"""
    def __init__(self, current: float, limit: float):
        self.current = current
        self.limit = limit
        super().__init__(f"预算超限: ${current:.4f} > ${limit:.4f}")


class BudgetGuard:
    """预算守卫：超限时阻止后续调用"""

    def __init__(self, limit: float, action: str = "warn"):
        """
        Args:
            limit: 预算上限（美元）
            action: "warn"=仅告警, "block"=阻止调用, "callback"=回调
        """
        self.limit = limit
        self.action = action
        self._exceeded = False

    def check(self, session: SessionMetrics) -> bool:
        """检查是否超限。返回 True 表示超限。"""
        if session.total_cost_usd > self.limit:
            self._exceeded = True
            if self.action == "block":
                raise BudgetExceededError(session.total_cost_usd, self.limit)
            return True
        return False
```

### 3.5 配置参数

| 参数 | 默认值 | 说明 | 调优建议 |
|------|--------|------|----------|
| `budget_limit` | None | 预算上限（美元） | 开发环境 $1，生产环境按任务设置 |
| `on_budget_exceeded` | None | 超限回调 | 发送告警通知 |
| `log_level` | INFO | 日志级别 | 生产环境 WARNING，调试时 DEBUG |
| `MODEL_PRICING` | 内置表 | 模型定价 | 定期更新，各 provider 价格变动频繁 |

---

## 第 4 章 测试用例

```python
"""test_metrics.py — Token 计数与成本追踪完整测试套件"""
import time
import pytest
from unittest.mock import MagicMock, AsyncMock
from metrics import MetricsCollector, CallMetrics, SessionMetrics
from pricing import calculate_cost, MODEL_PRICING


# === 4.1 定价计算测试 ===

class TestPricing:

    def test_gpt4o_cost(self):
        """GPT-4o 成本计算正确"""
        cost = calculate_cost("gpt-4o", prompt_tokens=1000, completion_tokens=500)
        expected = (1000 / 1_000_000) * 2.50 + (500 / 1_000_000) * 10.00
        assert abs(cost - expected) < 1e-10

    def test_gpt4o_mini_cost(self):
        """GPT-4o-mini 成本计算正确"""
        cost = calculate_cost("gpt-4o-mini", prompt_tokens=10000, completion_tokens=2000)
        expected = (10000 / 1_000_000) * 0.15 + (2000 / 1_000_000) * 0.60
        assert abs(cost - expected) < 1e-10

    def test_unknown_model_returns_zero(self):
        """未知模型返回 0 成本"""
        cost = calculate_cost("unknown-model", prompt_tokens=1000, completion_tokens=500)
        assert cost == 0.0

    def test_zero_tokens_zero_cost(self):
        """零 token 零成本"""
        cost = calculate_cost("gpt-4o", prompt_tokens=0, completion_tokens=0)
        assert cost == 0.0

    def test_all_models_have_pricing(self):
        """所有注册模型都有定价"""
        for model, pricing in MODEL_PRICING.items():
            assert "prompt" in pricing
            assert "completion" in pricing
            assert pricing["prompt"] >= 0
            assert pricing["completion"] >= 0


# === 4.2 CallMetrics 数据结构测试 ===

class TestCallMetrics:

    def test_successful_call_metrics(self):
        m = CallMetrics(
            model="gpt-4o", prompt_tokens=100, completion_tokens=50,
            total_tokens=150, cost_usd=0.00075, latency_ms=500.0,
            timestamp=time.time(), success=True,
        )
        assert m.success is True
        assert m.error is None
        assert m.total_tokens == 150

    def test_failed_call_metrics(self):
        m = CallMetrics(
            model="gpt-4o", prompt_tokens=0, completion_tokens=0,
            total_tokens=0, cost_usd=0.0, latency_ms=100.0,
            timestamp=time.time(), success=False, error="timeout",
        )
        assert m.success is False
        assert m.error == "timeout"


# === 4.3 MetricsCollector 核心测试 ===

class TestMetricsCollector:

    def _make_call(self, model="gpt-4o", prompt=100, completion=50,
                   success=True, latency=500.0) -> CallMetrics:
        return CallMetrics(
            model=model, prompt_tokens=prompt, completion_tokens=completion,
            total_tokens=prompt + completion,
            cost_usd=calculate_cost(model, prompt, completion),
            latency_ms=latency, timestamp=time.time(), success=success,
        )

    def test_record_single_call(self):
        """记录单次调用"""
        collector = MetricsCollector()
        collector.record(self._make_call())
        assert collector.session.total_calls == 1
        assert collector.session.successful_calls == 1
        assert collector.session.total_tokens == 150

    def test_record_multiple_calls(self):
        """记录多次调用累计"""
        collector = MetricsCollector()
        collector.record(self._make_call(prompt=100, completion=50))
        collector.record(self._make_call(prompt=200, completion=100))
        assert collector.session.total_calls == 2
        assert collector.session.total_prompt_tokens == 300
        assert collector.session.total_completion_tokens == 150

    def test_record_failed_call(self):
        """记录失败调用"""
        collector = MetricsCollector()
        collector.record(self._make_call(success=False))
        assert collector.session.total_calls == 1
        assert collector.session.failed_calls == 1
        assert collector.session.total_tokens == 0  # 失败不计 token

    def test_cost_by_model(self):
        """按模型统计成本"""
        collector = MetricsCollector()
        collector.record(self._make_call(model="gpt-4o", prompt=1000, completion=500))
        collector.record(self._make_call(model="gpt-4o-mini", prompt=1000, completion=500))
        assert "gpt-4o" in collector.session.cost_by_model
        assert "gpt-4o-mini" in collector.session.cost_by_model
        assert collector.session.cost_by_model["gpt-4o"] > collector.session.cost_by_model["gpt-4o-mini"]

    def test_budget_exceeded_callback(self):
        """预算超限触发回调"""
        callback = MagicMock()
        collector = MetricsCollector(budget_limit=0.001, on_budget_exceeded=callback)
        # 大量 token 触发超限
        collector.record(self._make_call(prompt=100000, completion=50000))
        callback.assert_called_once()

    def test_budget_not_exceeded(self):
        """未超限不触发回调"""
        callback = MagicMock()
        collector = MetricsCollector(budget_limit=100.0, on_budget_exceeded=callback)
        collector.record(self._make_call(prompt=100, completion=50))
        callback.assert_not_called()

    def test_get_summary(self):
        """获取会话摘要"""
        collector = MetricsCollector()
        collector.record(self._make_call(latency=500.0))
        collector.record(self._make_call(latency=300.0))
        summary = collector.get_summary()
        assert summary["total_calls"] == 2
        assert summary["total_tokens"] == 300
        assert summary["avg_latency_ms"] == 400.0

    def test_reset(self):
        """重置会话指标"""
        collector = MetricsCollector()
        collector.record(self._make_call())
        collector.reset()
        assert collector.session.total_calls == 0
        assert collector.session.total_cost_usd == 0.0

    def test_tokens_by_model(self):
        """按模型统计 token"""
        collector = MetricsCollector()
        collector.record(self._make_call(model="gpt-4o", prompt=100, completion=50))
        collector.record(self._make_call(model="gpt-4o", prompt=200, completion=100))
        assert collector.session.tokens_by_model["gpt-4o"] == 450


# === 4.4 BudgetGuard 测试 ===

class TestBudgetGuard:

    def test_warn_mode(self):
        """warn 模式不抛异常"""
        from budget_guard import BudgetGuard
        guard = BudgetGuard(limit=0.01, action="warn")
        session = SessionMetrics(total_cost_usd=0.02)
        assert guard.check(session) is True  # 超限但不抛异常

    def test_block_mode_raises(self):
        """block 模式抛异常"""
        from budget_guard import BudgetGuard, BudgetExceededError
        guard = BudgetGuard(limit=0.01, action="block")
        session = SessionMetrics(total_cost_usd=0.02)
        with pytest.raises(BudgetExceededError):
            guard.check(session)

    def test_under_budget(self):
        """未超限返回 False"""
        from budget_guard import BudgetGuard
        guard = BudgetGuard(limit=1.0, action="block")
        session = SessionMetrics(total_cost_usd=0.5)
        assert guard.check(session) is False


# === 4.5 场景测试 ===

class TestScenarios:

    def test_multi_model_session(self):
        """场景：多模型混合调用的成本追踪"""
        collector = MetricsCollector()

        # 模拟 Agent 任务：coordinator(mini) → researcher(4o) → reporter(4o)
        collector.record(CallMetrics(
            model="gpt-4o-mini", prompt_tokens=500, completion_tokens=100,
            total_tokens=600, cost_usd=calculate_cost("gpt-4o-mini", 500, 100),
            latency_ms=200, timestamp=time.time(), success=True,
        ))
        collector.record(CallMetrics(
            model="gpt-4o", prompt_tokens=2000, completion_tokens=1000,
            total_tokens=3000, cost_usd=calculate_cost("gpt-4o", 2000, 1000),
            latency_ms=1500, timestamp=time.time(), success=True,
        ))
        collector.record(CallMetrics(
            model="gpt-4o", prompt_tokens=5000, completion_tokens=2000,
            total_tokens=7000, cost_usd=calculate_cost("gpt-4o", 5000, 2000),
            latency_ms=3000, timestamp=time.time(), success=True,
        ))

        summary = collector.get_summary()
        assert summary["total_calls"] == 3
        assert summary["total_tokens"] == 10600
        assert "gpt-4o" in summary["cost_by_model"]
        assert "gpt-4o-mini" in summary["cost_by_model"]
        # gpt-4o 应该比 gpt-4o-mini 贵得多
        assert summary["cost_by_model"]["gpt-4o"] > summary["cost_by_model"]["gpt-4o-mini"]

    def test_session_with_failures(self):
        """场景：包含失败调用的会话"""
        collector = MetricsCollector()
        collector.record(CallMetrics(
            model="gpt-4o", prompt_tokens=100, completion_tokens=50,
            total_tokens=150, cost_usd=calculate_cost("gpt-4o", 100, 50),
            latency_ms=500, timestamp=time.time(), success=True,
        ))
        collector.record(CallMetrics(
            model="gpt-4o", prompt_tokens=0, completion_tokens=0,
            total_tokens=0, cost_usd=0.0, latency_ms=5000,
            timestamp=time.time(), success=False, error="RateLimitError",
        ))
        summary = collector.get_summary()
        assert summary["successful_calls"] == 1
        assert summary["failed_calls"] == 1
        assert summary["total_tokens"] == 150  # 失败调用不计 token
```

---

## 第 5 章 跨域关联

| 关联域 | 关系 | 说明 |
|--------|------|------|
| PD-01 上下文管理 | 输入 | token 计数是上下文裁剪的决策依据 |
| PD-03 容错与重试 | 互补 | 重试调用也需要计入 token 和成本 |
| PD-10 中间件管道 | 实现 | MetricsMiddleware 可作为中间件集成到管道 |
| PD-11.02 LangSmith | 互补 | 本方案是轻量级自建追踪，LangSmith 是全链路追踪平台 |
| PD-12 推理增强 | 成本 | 多步推理的 token 消耗需要精确追踪 |

---

## 第 6 章 来源文件索引

| 编号 | 文件 | 说明 |
|------|------|------|
| S1 | `openai_client.py` | LLM 客户端：调用拦截 + token 记录 |
| S2 | `utils/metrics.py` | 指标收集器：CallMetrics + SessionMetrics + MetricsCollector |
| S3 | `utils/pricing.py` | 模型定价表 + calculate_cost() |
| S4 | `config.py` | 配置：预算阈值、日志级别 |