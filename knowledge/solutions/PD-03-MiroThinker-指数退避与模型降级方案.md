# PD-03.01 MiroThinker — 指数退避 + 模型降级 + 格式修复

> 文档编号：PD-03.01
> 来源：MiroThinker `openai_client.py` / `utils/json_repair.py`
> GitHub：https://github.com/MiroMindAI/MiroThinker
> 问题域：PD-03 容错与重试 Fault Tolerance & Retry
> 状态：可复用方案

---

## 第 1 章 问题与动机

### 1.1 核心问题

LLM API 调用会因为多种原因失败：

- **网络层**：连接超时、DNS 解析失败、SSL 握手错误
- **速率限制**：429 Too Many Requests，触发 provider 的 RPM/TPM 限制
- **服务不可用**：500/502/503，模型过载或维护
- **响应格式错误**：LLM 返回的 JSON 不合法（缺少引号、多余逗号、截断）
- **内容过滤**：安全策略拦截导致空响应或拒绝响应

在 Agent 系统中，一次 API 失败可能导致整条任务链中断。如果没有容错机制，系统的可用性完全取决于最不稳定的那次 API 调用。

### 1.2 MiroThinker 的解法概述

三层容错，渐进降级：

1. **指数退避重试**：API 失败时按 `2^n` 秒间隔重试，加入随机抖动（jitter）避免惊群效应
2. **模型降级**：同一 provider 内连续失败后，自动切换到更便宜/更稳定的备选模型
3. **JSON 格式修复**：LLM 返回的 JSON 格式错误时，用正则和启发式规则自动修复后再解析

### 1.3 设计思想

| 原则 | 说明 |
|------|------|
| 渐进降级 | 先重试 → 再降级模型 → 最后返回错误，每层都尝试恢复 |
| 自动修复 | 能修的格式错误自动修，不能修的才报错 |
| 透明重试 | 调用方无需感知重试逻辑，接口不变 |
| 抖动防惊群 | 退避时间加随机偏移，避免多客户端同时重试打爆服务 |
| 幂等安全 | LLM 调用天然幂等，重试不会产生副作用 |

---

## 第 2 章 源码实现分析

### 2.1 指数退避重试器

**源文件**: `openai_client.py` — `_call_with_retry()` 方法

核心逻辑：`for attempt in range(max_retries+1)` 循环，捕获 `RateLimitError` / `APITimeoutError` 后按 `base_delay * 2^attempt + random.uniform(0,1)` 延迟重试。不可重试错误（如 400 参数错误）直接抛出。

**退避时间序列**（base_delay=1.0）：

| 重试次数 | 计算公式 | 延迟范围 |
|----------|----------|----------|
| 第 1 次 | 1 × 2^0 + jitter | 1.0 ~ 2.0 秒 |
| 第 2 次 | 1 × 2^1 + jitter | 2.0 ~ 3.0 秒 |
| 第 3 次 | 1 × 2^2 + jitter | 4.0 ~ 5.0 秒 |

关键决策：只对可重试错误重试；jitter 用 `uniform(0,1)` 而非 full jitter；最大 3 次重试，总等待不超过 10 秒。

### 2.2 模型降级链

**源文件**: `openai_client.py` — `_call_with_fallback()` 方法

维护一个 `MODEL_FALLBACK_CHAIN` 字典映射主模型到备选列表。调用时按 `[主模型] + fallback_list` 顺序尝试，每个模型都经过完整重试流程。

| 层级 | 模型 | 特点 | 触发条件 |
|------|------|------|----------|
| L0 | gpt-4o | 最强能力 | 默认首选 |
| L1 | gpt-4o-mini | 速度快、便宜 | L0 重试耗尽 |
| L2 | gpt-3.5-turbo | 最稳定、最便宜 | L1 也失败 |

### 2.3 JSON 格式修复器

**源文件**: `utils/json_repair.py` — `repair_json()` 函数

三阶段修复：直接 `json.loads` → 提取 Markdown 代码块后解析 → 启发式修复（尾部逗号、单引号替换、补全未闭合括号）后解析。

| 问题类型 | 示例 | 能否修复 |
|----------|------|----------|
| Markdown 代码块包裹 | `` ```json {...}``` `` | 能 |
| 尾部逗号 | `{"a": 1,}` | 能 |
| 单引号 | `{'a': 1}` | 能 |
| 未闭合括号 | `{"a": 1` | 能 |
| 键名无引号 | `{a: 1}` | 不能 |
| 截断的字符串值 | `{"a": "hel` | 不能 |

### 2.4 调用链路

```
调用方 → _call_with_fallback()
           ├── model_0: _call_with_retry() → 重试 0..N → 失败 → 下一模型
           ├── model_1: _call_with_retry() → 成功 → 返回响应
           └── model_2: (不需要)

响应 → repair_json() → 解析成功 → 返回结构化数据
                      → 解析失败 → 抛出异常
```

---

## 第 3 章 可复用方案设计

### 3.1 通用架构

```
┌─────────────────────────────────────────────┐
│              ResilientLLMClient              │
│                                             │
│  ┌─────────┐  ┌──────────┐  ┌───────────┐  │
│  │ Retry   │→ │ Fallback │→ │ JSON      │  │
│  │ Engine  │  │ Chain    │  │ Repair    │  │
│  └─────────┘  └──────────┘  └───────────┘  │
│                                             │
│  配置: RetryConfig + FallbackConfig         │
└─────────────────────────────────────────────┘
```

三个模块可独立使用，也可组合使用。下面给出完整的可复用实现。

### 3.2 配置与核心类

```python
"""
resilient_llm_client.py — 带指数退避、模型降级、JSON 修复的 LLM 客户端

用法：
    client = ResilientLLMClient(
        api_key="sk-...",
        model="gpt-4o",
        fallback_models=["gpt-4o-mini", "gpt-3.5-turbo"],
    )
    result = await client.chat("请生成一个 JSON 格式的用户列表")
"""

from __future__ import annotations

import asyncio
import json
import logging
import random
import re
import time
from dataclasses import dataclass, field
from typing import Any, Callable

import openai

logger = logging.getLogger(__name__)


# ─── 配置 ───────────────────────────────────────────────

@dataclass
class RetryConfig:
    """指数退避重试配置。"""
    max_retries: int = 3
    base_delay: float = 1.0
    max_delay: float = 60.0
    jitter: bool = True
    retryable_exceptions: tuple = (
        openai.RateLimitError,
        openai.APITimeoutError,
        openai.APIConnectionError,
        openai.InternalServerError,
    )


@dataclass
class FallbackConfig:
    """模型降级配置。"""
    fallback_models: list[str] = field(default_factory=list)
    fallback_on_all_errors: bool = False  # True=任何错误都降级, False=仅重试耗尽才降级


@dataclass
class JsonRepairConfig:
    """JSON 修复配置。"""
    enabled: bool = True
    strip_markdown: bool = True
    fix_trailing_commas: bool = True
    fix_single_quotes: bool = True
    fix_unclosed_brackets: bool = True
```


### 3.3 指数退避模块

```python
class ExponentialBackoff:
    """指数退避重试引擎。delay = min(base_delay * 2^attempt + jitter, max_delay)"""

    def __init__(self, config: RetryConfig | None = None):
        self.config = config or RetryConfig()

    def calculate_delay(self, attempt: int) -> float:
        delay = self.config.base_delay * (2 ** attempt)
        if self.config.jitter:
            delay += random.uniform(0, self.config.base_delay)
        return min(delay, self.config.max_delay)

    async def execute(self, func: Callable, *args, **kwargs) -> Any:
        """执行函数，失败时指数退避重试。"""
        last_error = None
        for attempt in range(self.config.max_retries + 1):
            try:
                return await func(*args, **kwargs)
            except self.config.retryable_exceptions as e:
                last_error = e
                if attempt == self.config.max_retries:
                    logger.error(f"All {self.config.max_retries} retries exhausted: {e}")
                    raise
                delay = self.calculate_delay(attempt)
                logger.warning(f"Attempt {attempt+1} failed: {e}. Retrying in {delay:.1f}s")
                await asyncio.sleep(delay)
            except Exception:
                raise
        raise last_error
```

### 3.4 模型降级模块

```python
class ModelFallbackChain:
    """模型降级链：主模型失败时按顺序尝试备选模型，每个模型经过完整重试。"""

    def __init__(self, primary_model: str, config: FallbackConfig | None = None,
                 retry_engine: ExponentialBackoff | None = None):
        self.primary_model = primary_model
        self.config = config or FallbackConfig()
        self.retry_engine = retry_engine or ExponentialBackoff()
        self._fallback_count = 0

    @property
    def models(self) -> list[str]:
        return [self.primary_model] + self.config.fallback_models

    async def execute(self, func: Callable, *args, **kwargs) -> Any:
        """沿降级链执行。func 签名: func(model, *args, **kwargs)"""
        last_error = None
        for i, model in enumerate(self.models):
            try:
                result = await self.retry_engine.execute(func, model, *args, **kwargs)
                if i > 0:
                    self._fallback_count += 1
                    logger.info(f"Fallback to {model} succeeded (total: {self._fallback_count})")
                return result
            except Exception as e:
                last_error = e
                if i < len(self.models) - 1:
                    logger.warning(f"Model {model} failed, falling back to {self.models[i+1]}")
                continue
        raise last_error
```


### 3.5 JSON 修复模块

```python
class JsonRepairer:
    """LLM 输出的 JSON 格式修复器。

    修复策略：直接解析 → 去 Markdown 代码块 → 启发式修复
    """

    def __init__(self, config: JsonRepairConfig | None = None):
        self.config = config or JsonRepairConfig()

    def parse(self, text: str) -> dict | list:
        """解析 JSON，自动修复常见格式错误。失败抛 ValueError。"""
        if not self.config.enabled:
            return json.loads(text)

        # 阶段 1：直接解析
        try:
            return json.loads(text)
        except json.JSONDecodeError:
            pass

        # 阶段 2：提取 Markdown 代码块中的 JSON
        if self.config.strip_markdown:
            match = re.search(r'```(?:json)?\s*([\s\S]*?)```', text)
            if match:
                extracted = match.group(1).strip()
                try:
                    return json.loads(extracted)
                except json.JSONDecodeError:
                    text = extracted

        # 阶段 3：启发式修复
        repaired = text.strip()
        if self.config.fix_trailing_commas:
            repaired = re.sub(r',\s*([}\]])', r'\1', repaired)
        if self.config.fix_single_quotes and '"' not in repaired:
            repaired = repaired.replace("'", '"')
        if self.config.fix_unclosed_brackets:
            open_b = repaired.count('{') - repaired.count('}')
            repaired += '}' * max(0, open_b)
            open_s = repaired.count('[') - repaired.count(']')
            repaired += ']' * max(0, open_s)

        try:
            return json.loads(repaired)
        except json.JSONDecodeError as e:
            raise ValueError(f"JSON repair failed: {e}. Text: {text[:200]}...") from e
```


### 3.6 组合：ResilientLLMClient

```python
class ResilientLLMClient:
    """组合了指数退避、模型降级、JSON 修复的 LLM 客户端。"""

    def __init__(self, api_key: str, model: str = "gpt-4o",
                 fallback_models: list[str] | None = None,
                 retry_config: RetryConfig | None = None,
                 json_repair_config: JsonRepairConfig | None = None,
                 base_url: str | None = None):
        self.client = openai.AsyncOpenAI(api_key=api_key, base_url=base_url)
        self.retry_engine = ExponentialBackoff(retry_config)
        self.fallback_chain = ModelFallbackChain(
            model, FallbackConfig(fallback_models=fallback_models or []), self.retry_engine
        )
        self.json_repairer = JsonRepairer(json_repair_config)

    async def chat(self, messages: list[dict], parse_json: bool = False, **kwargs) -> str | dict | list:
        """发送聊天请求，自动处理重试和降级。"""
        async def _call(model: str) -> str:
            response = await self.client.chat.completions.create(
                model=model, messages=messages, **kwargs
            )
            return response.choices[0].message.content

        content = await self.fallback_chain.execute(_call)
        return self.json_repairer.parse(content) if parse_json else content
```

### 3.7 配置参数速查

| 参数 | 默认值 | 说明 | 调优建议 |
|------|--------|------|----------|
| `max_retries` | 3 | 最大重试次数 | 生产环境 3-5，开发环境 1 |
| `base_delay` | 1.0s | 基础退避延迟 | 429 错误多时增大到 2-5s |
| `max_delay` | 60.0s | 退避延迟上限 | 防止指数爆炸 |
| `jitter` | True | 是否加随机抖动 | 多客户端并发时必须开启 |
| `fallback_models` | [] | 降级模型列表 | 按能力递减排列 |
| `strip_markdown` | True | 去除代码块标记 | LLM 常用 markdown 包裹 JSON |
| `fix_trailing_commas` | True | 修复尾部逗号 | LLM 最常见的 JSON 错误 |

---

## 第 4 章 集成指南

### 4.1 最小可运行示例

```python
import asyncio
from resilient_llm_client import ResilientLLMClient

async def main():
    client = ResilientLLMClient(
        api_key="sk-your-key",
        model="gpt-4o",
        fallback_models=["gpt-4o-mini", "gpt-3.5-turbo"],
    )

    # 普通文本调用
    response = await client.chat([
        {"role": "user", "content": "用一句话解释量子计算"}
    ])
    print(response)

    # JSON 解析调用
    data = await client.chat(
        [{"role": "user", "content": "返回 3 个用户的 JSON 数组，包含 name 和 age"}],
        parse_json=True,
    )
    print(data)  # [{"name": "...", "age": ...}, ...]

asyncio.run(main())
```


### 4.2 集成到现有 OpenAI 调用

```python
# 替换前
client = openai.AsyncOpenAI(api_key="sk-...")
response = await client.chat.completions.create(model="gpt-4o", messages=messages)
text = response.choices[0].message.content

# 替换后 — 接口几乎一致，自动获得重试+降级+修复
client = ResilientLLMClient(api_key="sk-...", model="gpt-4o", fallback_models=["gpt-4o-mini"])
text = await client.chat(messages)
```

### 4.3 集成到 LangChain

```python
from langchain_openai import ChatOpenAI
from resilient_llm_client import ExponentialBackoff, RetryConfig

# 用本方案的退避引擎包装 LangChain 调用
retry_engine = ExponentialBackoff(RetryConfig(max_retries=3, base_delay=2.0))

async def resilient_invoke(prompt: str) -> str:
    llm = ChatOpenAI(model="gpt-4o", max_retries=0)  # 关闭内置重试
    async def _call():
        return (await llm.ainvoke(prompt)).content
    return await retry_engine.execute(_call)
```

### 4.4 自定义降级策略

```python
# 跨 provider 降级：OpenAI → Anthropic → 本地模型
chain = ModelFallbackChain(
    primary_model="gpt-4o",
    config=FallbackConfig(fallback_models=["claude-3-sonnet", "local-llama"]),
)

async def multi_provider_call(model: str) -> str:
    if model.startswith("gpt"):
        return await call_openai(model)
    elif model.startswith("claude"):
        return await call_anthropic(model)
    return await call_local(model)

result = await chain.execute(multi_provider_call)
```

---

## 第 5 章 测试用例

完整的测试代码，覆盖所有核心场景：

```python
"""test_resilient_llm_client.py"""
import json
import pytest
from unittest.mock import AsyncMock
from resilient_llm_client import (
    ExponentialBackoff, JsonRepairer, ModelFallbackChain,
    RetryConfig, FallbackConfig, JsonRepairConfig,
)
import openai


class TestExponentialBackoff:

    @pytest.mark.asyncio
    async def test_success_on_first_attempt(self):
        engine = ExponentialBackoff(RetryConfig(max_retries=3))
        func = AsyncMock(return_value="ok")
        result = await engine.execute(func)
        assert result == "ok"
        assert func.call_count == 1

    @pytest.mark.asyncio
    async def test_success_after_retries(self):
        engine = ExponentialBackoff(RetryConfig(max_retries=3, base_delay=0.01))
        func = AsyncMock(side_effect=[
            openai.RateLimitError("rate limit", response=None, body=None),
            openai.APITimeoutError(request=None),
            "success",
        ])
        result = await engine.execute(func)
        assert result == "success"
        assert func.call_count == 3

    @pytest.mark.asyncio
    async def test_retries_exhausted(self):
        engine = ExponentialBackoff(RetryConfig(max_retries=2, base_delay=0.01))
        func = AsyncMock(side_effect=openai.RateLimitError("rate limit", response=None, body=None))
        with pytest.raises(openai.RateLimitError):
            await engine.execute(func)
        assert func.call_count == 3  # 1 初始 + 2 重试

    @pytest.mark.asyncio
    async def test_non_retryable_error_raises_immediately(self):
        engine = ExponentialBackoff(RetryConfig(max_retries=3))
        func = AsyncMock(side_effect=ValueError("bad input"))
        with pytest.raises(ValueError, match="bad input"):
            await engine.execute(func)
        assert func.call_count == 1

    def test_delay_calculation(self):
        engine = ExponentialBackoff(RetryConfig(base_delay=1.0, max_delay=60.0, jitter=False))
        assert engine.calculate_delay(0) == 1.0
        assert engine.calculate_delay(1) == 2.0
        assert engine.calculate_delay(2) == 4.0
        assert engine.calculate_delay(10) == 60.0  # 被 max_delay 截断


class TestModelFallbackChain:

    @pytest.mark.asyncio
    async def test_primary_model_succeeds(self):
        chain = ModelFallbackChain(
            primary_model="gpt-4o",
            config=FallbackConfig(fallback_models=["gpt-4o-mini"]),
            retry_engine=ExponentialBackoff(RetryConfig(max_retries=0)),
        )
        func = AsyncMock(return_value="primary response")
        result = await chain.execute(func)
        assert result == "primary response"
        func.assert_called_once_with("gpt-4o")

    @pytest.mark.asyncio
    async def test_fallback_to_secondary(self):
        chain = ModelFallbackChain(
            primary_model="gpt-4o",
            config=FallbackConfig(fallback_models=["gpt-4o-mini"]),
            retry_engine=ExponentialBackoff(RetryConfig(max_retries=0, base_delay=0.01)),
        )
        func = AsyncMock(side_effect=[
            openai.InternalServerError("server error", response=None, body=None),
            "fallback response",
        ])
        result = await chain.execute(func)
        assert result == "fallback response"
        assert func.call_count == 2

    @pytest.mark.asyncio
    async def test_all_models_fail(self):
        chain = ModelFallbackChain(
            primary_model="gpt-4o",
            config=FallbackConfig(fallback_models=["gpt-4o-mini", "gpt-3.5-turbo"]),
            retry_engine=ExponentialBackoff(RetryConfig(max_retries=0, base_delay=0.01)),
        )
        func = AsyncMock(side_effect=openai.InternalServerError("all down", response=None, body=None))
        with pytest.raises(openai.InternalServerError):
            await chain.execute(func)
        assert func.call_count == 3


class TestJsonRepairer:

    def setup_method(self):
        self.repairer = JsonRepairer()

    def test_valid_json(self):
        assert self.repairer.parse('{"name": "Alice", "age": 30}') == {"name": "Alice", "age": 30}

    def test_markdown_code_block(self):
        text = '结果：\n```json\n{"status": "ok"}\n```\n以上。'
        assert self.repairer.parse(text) == {"status": "ok"}

    def test_trailing_comma(self):
        assert self.repairer.parse('{"a": 1, "b": 2,}') == {"a": 1, "b": 2}

    def test_single_quotes(self):
        assert self.repairer.parse("{'name': 'Bob'}") == {"name": "Bob"}

    def test_unclosed_brace(self):
        assert self.repairer.parse('{"a": 1, "b": 2') == {"a": 1, "b": 2}

    def test_unclosed_bracket(self):
        assert self.repairer.parse('[1, 2, 3') == [1, 2, 3]

    def test_combined_errors(self):
        assert self.repairer.parse("```json\n{'items': [1, 2, 3,],}\n```") == {"items": [1, 2, 3]}

    def test_unrepairable_text(self):
        with pytest.raises(ValueError, match="JSON repair failed"):
            self.repairer.parse("This is not JSON at all")

    def test_nested_trailing_comma(self):
        text = '{"users": [{"name": "A",}, {"name": "B",},],}'
        assert self.repairer.parse(text) == {"users": [{"name": "A"}, {"name": "B"}]}

    def test_disabled_repair(self):
        repairer = JsonRepairer(JsonRepairConfig(enabled=False))
        with pytest.raises(json.JSONDecodeError):
            repairer.parse('{"a": 1,}')
```

---

## 第 6 章 风险与降级

### 6.1 风险矩阵

| 风险 | 概率 | 影响 | 缓解措施 |
|------|------|------|----------|
| 重试放大故障 | 中 | 高 | 指数退避 + jitter 分散请求；设置 max_delay 上限 |
| 降级模型能力不足 | 中 | 中 | 降级后记录日志，允许调用方检查实际使用的模型 |
| JSON 修复引入错误数据 | 低 | 高 | 修复后做 schema 校验；关键场景禁用自动修复 |
| 重试导致成本翻倍 | 中 | 低 | 监控重试率；设置每分钟最大重试次数 |
| 所有模型同时不可用 | 低 | 高 | 返回缓存结果或优雅降级提示 |

### 6.2 监控指标

生产环境建议监控：`llm_request_total`（总请求）、`llm_retry_total`（重试次数，按模型/错误分组）、`llm_fallback_total`（降级次数）、`llm_json_repair_total`（修复次数）、`llm_error_total`（最终失败数）。

### 6.3 熔断器扩展（可选）

当错误率持续过高时，可叠加熔断器模式（CLOSED → OPEN → HALF_OPEN → CLOSED）：

- 连续失败 N 次后进入 OPEN 状态，直接拒绝请求
- 超过恢复超时后进入 HALF_OPEN，放行一个探测请求
- 探测成功则回到 CLOSED，失败则回到 OPEN

实现约 30 行代码，核心是 `failure_count`、`state`、`last_failure_time` 三个状态变量。

---

## 第 7 章 适用场景与限制

### 7.1 适用场景

| 场景 | 推荐配置 |
|------|----------|
| Agent 多步推理 | max_retries=3, 降级链 2-3 个模型 |
| 批量数据处理 | max_retries=5, base_delay=2.0, 开启 JSON 修复 |
| 实时对话 | max_retries=1, 降级到快速模型, max_delay=5s |
| 代码生成 | max_retries=2, 不降级（能力差异大）, 关闭 JSON 修复 |
| 结构化数据提取 | max_retries=3, 开启 JSON 修复 + schema 校验 |

### 7.2 限制

| 限制 | 说明 | 替代方案 |
|------|------|----------|
| 非幂等操作 | 重试可能导致重复执行 | 加幂等键或去重逻辑 |
| 流式响应 | 流式调用中断后无法从断点续传 | 改用非流式 + 重试 |
| 跨 provider 降级 | 不同 provider 的 API 格式不同 | 用适配器统一接口 |
| JSON 修复的语义正确性 | 修复后语法正确但语义可能错误 | 叠加 schema 校验 |
| 长时间服务中断 | 指数退避有上限，无法无限等待 | 叠加熔断器 + 告警 |

### 7.3 与其他方案的对比

| 方案 | 指数退避 | 模型降级 | 格式修复 | 熔断器 | 复杂度 |
|------|----------|----------|----------|--------|--------|
| 本方案（MiroThinker） | 有 | 有 | 有 | 无（可扩展） | 中 |
| tenacity 库 | 有 | 无 | 无 | 无 | 低 |
| LangChain 内置重试 | 有 | 无 | 无 | 无 | 低 |
| LiteLLM | 有 | 有 | 无 | 无 | 中 |
| 自建完整方案 | 有 | 有 | 有 | 有 | 高 |

### 7.4 推荐的渐进采用路径

```
阶段 1: 只用 ExponentialBackoff（最小改动，立即提升可用性）
  ↓
阶段 2: 加入 ModelFallbackChain（应对单模型不可用）
  ↓
阶段 3: 加入 JsonRepairer（提升结构化输出成功率）
  ↓
阶段 4: 加入 CircuitBreaker + 监控（生产级容错）
```