# PD-10.01 DeerFlow — LangGraph Middleware 链

> 文档编号：PD-10.01
> 来源：DeerFlow `src/middleware/`
> GitHub：https://github.com/bytedance/deer-flow
> 问题域：PD-10 中间件管道 Middleware Pipeline
> 状态：可复用方案

---

## 第 1 章 问题与动机

### 1.1 核心问题

Agent 系统中，LLM 调用前后需要执行大量横切关注点（cross-cutting concerns）：

- **调用前**：上下文裁剪（防止超 token 限制）、prompt 注入检测、参数校验、日志记录
- **调用后**：响应格式校验、悬挂工具调用修复、token 计数、结果缓存
- **全链路**：耗时统计、错误捕获、重试包装

这些逻辑如果散落在每个节点函数中，会导致：节点函数臃肿、逻辑重复、新增横切关注点需要改所有节点。

### 1.2 DeerFlow 的解法概述

DeerFlow 实现了洋葱模型（Onion Model）中间件链：

1. **SummarizationMiddleware**：LLM 调用前检查消息长度，超限时自动摘要压缩
2. **DanglingToolCallMiddleware**：修复 LLM 返回的悬挂工具调用（有 tool_call 但无对应 tool_result）
3. **中间件注册表**：按顺序注册中间件，形成 pre → call → post 的管道
4. **可组合管道**：中间件可独立使用，也可组合成链

### 1.3 设计思想

| 原则 | 说明 |
|------|------|
| 洋葱模型 | 请求从外到内穿过中间件，响应从内到外返回 |
| 单一职责 | 每个中间件只处理一个关注点 |
| 可插拔 | 中间件通过注册表管理，新增/移除不影响其他中间件 |
| 顺序敏感 | 中间件执行顺序影响行为（如摘要必须在 token 计数之前） |
| 透明传递 | 中间件不改变调用接口，对节点函数透明 |

---

## 第 2 章 源码实现分析

### 2.1 整体架构

```
src/middleware/
├── __init__.py              # 中间件注册表
├── base.py                  # 中间件基类
├── summarization.py         # 摘要压缩中间件
├── dangling_tool_call.py    # 悬挂工具调用修复
└── pipeline.py              # 中间件管道组装
```

### 2.2 中间件基类

```python
# src/middleware/base.py（简化）
from abc import ABC, abstractmethod
from typing import Any, Callable, Awaitable


class Middleware(ABC):
    """中间件基类 — 洋葱模型"""

    @abstractmethod
    async def __call__(
        self,
        messages: list[dict],
        call_next: Callable[..., Awaitable[Any]],
        **kwargs,
    ) -> Any:
        """
        处理消息并调用下一层。

        Args:
            messages: 当前消息列表
            call_next: 下一个中间件或最终的 LLM 调用
            **kwargs: 额外参数（model, temperature 等）

        Returns:
            LLM 响应（可能被后续中间件修改）
        """
        ...
```

### 2.3 SummarizationMiddleware

```python
# src/middleware/summarization.py（简化）
import tiktoken


class SummarizationMiddleware(Middleware):
    """
    摘要压缩中间件：当消息总 token 数超过阈值时，
    自动将早期消息摘要为一条 summary 消息。
    """

    def __init__(self, max_tokens: int = 100_000, summary_ratio: float = 0.3,
                 model: str = "gpt-4o"):
        self.max_tokens = max_tokens
        self.summary_ratio = summary_ratio
        self.encoder = tiktoken.encoding_for_model(model)

    def _count_tokens(self, messages: list[dict]) -> int:
        return sum(len(self.encoder.encode(m.get("content", ""))) for m in messages)

    async def __call__(self, messages, call_next, **kwargs):
        token_count = self._count_tokens(messages)

        if token_count > self.max_tokens:
            # 将前 N 条消息摘要为一条
            split_point = int(len(messages) * self.summary_ratio)
            early_messages = messages[:split_point]
            recent_messages = messages[split_point:]

            summary = await self._summarize(early_messages, **kwargs)
            messages = [{"role": "system", "content": f"[历史摘要] {summary}"}] + recent_messages

        # 调用下一层
        return await call_next(messages, **kwargs)

    async def _summarize(self, messages: list[dict], **kwargs) -> str:
        """调用 LLM 生成消息摘要"""
        content = "\n".join(m.get("content", "") for m in messages)
        # 实际实现中调用 LLM 生成摘要
        return f"摘要：{content[:200]}..."
```

### 2.4 DanglingToolCallMiddleware

```python
# src/middleware/dangling_tool_call.py（简化）


class DanglingToolCallMiddleware(Middleware):
    """
    悬挂工具调用修复中间件：

    问题：LLM 有时返回 tool_call 但消息历史中缺少对应的 tool_result，
    导致下一轮调用时 API 报错。

    修复：检测消息列表中未配对的 tool_call，为其补充一个
    "工具调用已过期" 的 tool_result 占位消息。
    """

    async def __call__(self, messages, call_next, **kwargs):
        messages = self._fix_dangling_calls(messages)
        return await call_next(messages, **kwargs)

    def _fix_dangling_calls(self, messages: list[dict]) -> list[dict]:
        """检测并修复悬挂的 tool_call"""
        # 收集所有 tool_call ID
        pending_calls = {}
        for msg in messages:
            if msg.get("role") == "assistant" and msg.get("tool_calls"):
                for tc in msg["tool_calls"]:
                    pending_calls[tc["id"]] = tc

            if msg.get("role") == "tool":
                call_id = msg.get("tool_call_id")
                if call_id in pending_calls:
                    del pending_calls[call_id]

        if not pending_calls:
            return messages

        # 为悬挂的 tool_call 补充占位 tool_result
        fixed = list(messages)
        for call_id, tc in pending_calls.items():
            fixed.append({
                "role": "tool",
                "tool_call_id": call_id,
                "content": f"[工具调用 {tc['function']['name']} 已过期，请重新调用]",
            })

        return fixed
```

### 2.5 中间件管道

```python
# src/middleware/pipeline.py（简化）
from functools import reduce


class MiddlewarePipeline:
    """中间件管道：按注册顺序组装洋葱模型"""

    def __init__(self):
        self._middlewares: list[Middleware] = []

    def use(self, middleware: Middleware) -> "MiddlewarePipeline":
        """注册中间件（按调用顺序）"""
        self._middlewares.append(middleware)
        return self

    async def execute(self, messages: list[dict],
                      final_call: Callable, **kwargs) -> Any:
        """
        执行中间件链。

        洋葱模型：middleware_1 → middleware_2 → ... → final_call
                  middleware_1 ← middleware_2 ← ... ← response
        """
        async def _build_chain(remaining: list[Middleware], messages, **kw):
            if not remaining:
                return await final_call(messages, **kw)

            current = remaining[0]
            rest = remaining[1:]

            async def next_fn(msgs, **next_kw):
                return await _build_chain(rest, msgs, **next_kw)

            return await current(messages, next_fn, **kw)

        return await _build_chain(self._middlewares, messages, **kwargs)
```

### 2.6 调用链路

```
消息列表
  │
  ▼
SummarizationMiddleware (pre: 检查 token → 摘要压缩)
  │
  ▼
DanglingToolCallMiddleware (pre: 修复悬挂 tool_call)
  │
  ▼
LLM API 调用 (final_call)
  │
  ▼
DanglingToolCallMiddleware (post: 无操作)
  │
  ▼
SummarizationMiddleware (post: 无操作)
  │
  ▼
响应返回
```

---

## 第 3 章 迁移指南

### 3.1 通用架构

```
┌─────────────────────────────────────────────────┐
│              MiddlewarePipeline                  │
│                                                  │
│  [Middleware A] → [Middleware B] → [LLM Call]     │
│       pre            pre           execute       │
│       post           post          return        │
│                                                  │
│  注册: pipeline.use(A).use(B)                     │
│  执行: pipeline.execute(messages, llm_call)       │
└─────────────────────────────────────────────────┘
```

### 3.2 通用中间件基类

```python
"""middleware.py — 通用中间件框架"""
from __future__ import annotations

import logging
import time
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any, Callable, Awaitable

logger = logging.getLogger(__name__)


class Middleware(ABC):
    """中间件基类 — 洋葱模型"""

    @property
    def name(self) -> str:
        return self.__class__.__name__

    @abstractmethod
    async def __call__(
        self,
        messages: list[dict],
        call_next: Callable[..., Awaitable[Any]],
        **kwargs,
    ) -> Any:
        """处理消息并调用下一层"""
        ...


class MiddlewarePipeline:
    """中间件管道：按注册顺序组装洋葱模型"""

    def __init__(self):
        self._middlewares: list[Middleware] = []

    def use(self, middleware: Middleware) -> "MiddlewarePipeline":
        self._middlewares.append(middleware)
        return self

    def remove(self, middleware_class: type) -> "MiddlewarePipeline":
        self._middlewares = [m for m in self._middlewares
                            if not isinstance(m, middleware_class)]
        return self

    @property
    def middlewares(self) -> list[Middleware]:
        return list(self._middlewares)

    async def execute(
        self, messages: list[dict], final_call: Callable, **kwargs
    ) -> Any:
        async def _chain(remaining: list[Middleware], msgs, **kw):
            if not remaining:
                return await final_call(msgs, **kw)
            current = remaining[0]
            async def next_fn(m, **nkw):
                return await _chain(remaining[1:], m, **nkw)
            return await current(msgs, next_fn, **kw)

        return await _chain(self._middlewares, messages, **kwargs)
```

### 3.3 常用中间件实现

```python
"""common_middlewares.py — 常用中间件集合"""
import json
import time


class LoggingMiddleware(Middleware):
    """日志中间件：记录每次 LLM 调用的输入输出和耗时"""

    async def __call__(self, messages, call_next, **kwargs):
        start = time.monotonic()
        msg_count = len(messages)
        logger.info(f"[{self.name}] 调用开始: {msg_count} 条消息")

        try:
            result = await call_next(messages, **kwargs)
            elapsed = time.monotonic() - start
            logger.info(f"[{self.name}] 调用完成: {elapsed:.2f}s")
            return result
        except Exception as e:
            elapsed = time.monotonic() - start
            logger.error(f"[{self.name}] 调用失败: {e} ({elapsed:.2f}s)")
            raise


class TokenCountMiddleware(Middleware):
    """Token 计数中间件：统计每次调用的 token 消耗"""

    def __init__(self):
        self.total_prompt_tokens = 0
        self.total_completion_tokens = 0
        self.call_count = 0

    async def __call__(self, messages, call_next, **kwargs):
        result = await call_next(messages, **kwargs)

        # 从响应中提取 token 使用量
        if hasattr(result, "usage") and result.usage:
            self.total_prompt_tokens += result.usage.prompt_tokens
            self.total_completion_tokens += result.usage.completion_tokens
            self.call_count += 1

        return result


class ContentFilterMiddleware(Middleware):
    """内容过滤中间件：检测并过滤敏感内容"""

    def __init__(self, blocked_patterns: list[str] | None = None):
        self.blocked_patterns = blocked_patterns or []

    async def __call__(self, messages, call_next, **kwargs):
        # Pre: 检查输入
        for msg in messages:
            content = msg.get("content", "")
            for pattern in self.blocked_patterns:
                if pattern.lower() in content.lower():
                    raise ValueError(f"输入包含被阻止的内容模式: {pattern}")

        result = await call_next(messages, **kwargs)
        return result


class CacheMiddleware(Middleware):
    """缓存中间件：相同输入直接返回缓存结果"""

    def __init__(self, cache: dict | None = None):
        self._cache = cache if cache is not None else {}

    def _cache_key(self, messages: list[dict]) -> str:
        import hashlib
        content = json.dumps(messages, sort_keys=True, ensure_ascii=False)
        return hashlib.sha256(content.encode()).hexdigest()[:16]

    async def __call__(self, messages, call_next, **kwargs):
        key = self._cache_key(messages)
        if key in self._cache:
            logger.debug(f"[Cache] 命中: {key}")
            return self._cache[key]

        result = await call_next(messages, **kwargs)
        self._cache[key] = result
        return result
```

### 3.4 管道组装示例

```python
"""example_pipeline.py — 管道组装示例"""


def create_default_pipeline() -> MiddlewarePipeline:
    """创建默认中间件管道"""
    pipeline = MiddlewarePipeline()
    pipeline.use(LoggingMiddleware())
    pipeline.use(TokenCountMiddleware())
    pipeline.use(SummarizationMiddleware(max_tokens=100_000))
    pipeline.use(DanglingToolCallMiddleware())
    return pipeline


# 使用
pipeline = create_default_pipeline()

async def llm_call(messages, **kwargs):
    """最终的 LLM 调用"""
    response = await openai_client.chat.completions.create(
        model=kwargs.get("model", "gpt-4o"),
        messages=messages,
    )
    return response

result = await pipeline.execute(messages, llm_call, model="gpt-4o")
```

### 3.5 与 LangGraph 节点集成

```python
"""langgraph_integration.py — 中间件与 LangGraph 节点集成"""


def with_middleware(pipeline: MiddlewarePipeline):
    """装饰器：为 LangGraph 节点函数添加中间件管道"""
    def decorator(node_func):
        async def wrapper(state, config=None):
            llm = config["configurable"]["llm"] if config else None

            async def final_call(messages, **kwargs):
                return await llm.ainvoke(messages)

            # 通过中间件管道调用 LLM
            messages = state.get("messages", [])
            result = await pipeline.execute(messages, final_call)
            return await node_func(state, config, llm_result=result)

        return wrapper
    return decorator


# 使用
pipeline = create_default_pipeline()

@with_middleware(pipeline)
async def researcher_node(state, config, llm_result=None):
    return {"research_data": llm_result.content}
```

### 3.6 配置参数

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `max_tokens` (Summarization) | 100,000 | 触发摘要的 token 阈值 |
| `summary_ratio` | 0.3 | 摘要前 30% 的消息 |
| `blocked_patterns` (Filter) | [] | 被阻止的内容模式列表 |
| 中间件顺序 | Logging → Token → Summarization → Fix | 外层先执行 pre，内层先执行 post |

---

## 第 4 章 测试用例

```python
"""test_middleware.py — 中间件框架完整测试套件"""
import pytest
from unittest.mock import AsyncMock, MagicMock
from middleware import Middleware, MiddlewarePipeline


# === 4.1 中间件基类测试 ===

class PassthroughMiddleware(Middleware):
    """测试用：直接传递"""
    def __init__(self):
        self.called = False
        self.received_messages = None

    async def __call__(self, messages, call_next, **kwargs):
        self.called = True
        self.received_messages = messages
        return await call_next(messages, **kwargs)


class ModifyingMiddleware(Middleware):
    """测试用：修改消息"""
    def __init__(self, prefix: str = "[modified]"):
        self.prefix = prefix

    async def __call__(self, messages, call_next, **kwargs):
        modified = [
            {**m, "content": f"{self.prefix} {m.get('content', '')}"}
            for m in messages
        ]
        return await call_next(modified, **kwargs)


class TestMiddlewarePipeline:

    @pytest.mark.asyncio
    async def test_empty_pipeline_calls_final(self):
        """空管道直接调用 final_call"""
        pipeline = MiddlewarePipeline()
        final = AsyncMock(return_value="response")
        result = await pipeline.execute([{"role": "user", "content": "hi"}], final)
        assert result == "response"
        final.assert_called_once()

    @pytest.mark.asyncio
    async def test_single_middleware(self):
        """单个中间件正确执行"""
        pipeline = MiddlewarePipeline()
        mw = PassthroughMiddleware()
        pipeline.use(mw)

        final = AsyncMock(return_value="ok")
        result = await pipeline.execute([{"role": "user", "content": "test"}], final)

        assert result == "ok"
        assert mw.called
        assert mw.received_messages[0]["content"] == "test"

    @pytest.mark.asyncio
    async def test_middleware_order(self):
        """中间件按注册顺序执行"""
        order = []

        class OrderMiddleware(Middleware):
            def __init__(self, name):
                self._name = name
            async def __call__(self, messages, call_next, **kwargs):
                order.append(f"pre_{self._name}")
                result = await call_next(messages, **kwargs)
                order.append(f"post_{self._name}")
                return result

        pipeline = MiddlewarePipeline()
        pipeline.use(OrderMiddleware("A"))
        pipeline.use(OrderMiddleware("B"))

        await pipeline.execute([], AsyncMock(return_value="ok"))
        assert order == ["pre_A", "pre_B", "post_B", "post_A"]

    @pytest.mark.asyncio
    async def test_middleware_modifies_messages(self):
        """中间件可以修改消息"""
        pipeline = MiddlewarePipeline()
        pipeline.use(ModifyingMiddleware("[prefix]"))

        received = []
        async def capture_final(messages, **kwargs):
            received.extend(messages)
            return "ok"

        await pipeline.execute(
            [{"role": "user", "content": "hello"}], capture_final
        )
        assert received[0]["content"] == "[prefix] hello"

    @pytest.mark.asyncio
    async def test_middleware_can_short_circuit(self):
        """中间件可以短路（不调用 call_next）"""
        class ShortCircuitMiddleware(Middleware):
            async def __call__(self, messages, call_next, **kwargs):
                return "short_circuited"

        pipeline = MiddlewarePipeline()
        pipeline.use(ShortCircuitMiddleware())

        final = AsyncMock(return_value="should_not_reach")
        result = await pipeline.execute([], final)
        assert result == "short_circuited"
        final.assert_not_called()

    @pytest.mark.asyncio
    async def test_remove_middleware(self):
        """可以移除指定类型的中间件"""
        pipeline = MiddlewarePipeline()
        pipeline.use(PassthroughMiddleware())
        pipeline.use(ModifyingMiddleware())
        assert len(pipeline.middlewares) == 2

        pipeline.remove(ModifyingMiddleware)
        assert len(pipeline.middlewares) == 1
        assert isinstance(pipeline.middlewares[0], PassthroughMiddleware)

    @pytest.mark.asyncio
    async def test_error_propagation(self):
        """中间件中的错误应正确传播"""
        class ErrorMiddleware(Middleware):
            async def __call__(self, messages, call_next, **kwargs):
                raise ValueError("middleware error")

        pipeline = MiddlewarePipeline()
        pipeline.use(ErrorMiddleware())

        with pytest.raises(ValueError, match="middleware error"):
            await pipeline.execute([], AsyncMock())


# === 4.2 DanglingToolCallMiddleware 测试 ===

class TestDanglingToolCallMiddleware:

    def _make_middleware(self):
        from common_middlewares import DanglingToolCallMiddleware
        return DanglingToolCallMiddleware()

    def test_no_tool_calls_unchanged(self):
        """无 tool_call 时消息不变"""
        mw = self._make_middleware()
        messages = [
            {"role": "user", "content": "hello"},
            {"role": "assistant", "content": "hi"},
        ]
        fixed = mw._fix_dangling_calls(messages)
        assert len(fixed) == 2

    def test_paired_tool_call_unchanged(self):
        """已配对的 tool_call 不修改"""
        mw = self._make_middleware()
        messages = [
            {"role": "assistant", "tool_calls": [
                {"id": "call_1", "function": {"name": "search", "arguments": "{}"}}
            ]},
            {"role": "tool", "tool_call_id": "call_1", "content": "result"},
        ]
        fixed = mw._fix_dangling_calls(messages)
        assert len(fixed) == 2

    def test_dangling_tool_call_fixed(self):
        """悬挂的 tool_call 应被修复"""
        mw = self._make_middleware()
        messages = [
            {"role": "assistant", "tool_calls": [
                {"id": "call_1", "function": {"name": "search", "arguments": "{}"}}
            ]},
            # 缺少 tool_call_id=call_1 的 tool result
            {"role": "user", "content": "继续"},
        ]
        fixed = mw._fix_dangling_calls(messages)
        assert len(fixed) == 3  # 补充了一条 tool result
        assert fixed[-1]["role"] == "tool"
        assert fixed[-1]["tool_call_id"] == "call_1"

    def test_multiple_dangling_calls(self):
        """多个悬挂 tool_call 都应被修复"""
        mw = self._make_middleware()
        messages = [
            {"role": "assistant", "tool_calls": [
                {"id": "call_1", "function": {"name": "search", "arguments": "{}"}},
                {"id": "call_2", "function": {"name": "calc", "arguments": "{}"}},
            ]},
        ]
        fixed = mw._fix_dangling_calls(messages)
        assert len(fixed) == 3  # 原始 1 条 + 补充 2 条


# === 4.3 CacheMiddleware 测试 ===

class TestCacheMiddleware:

    @pytest.mark.asyncio
    async def test_cache_miss_calls_next(self):
        """缓存未命中时调用 call_next"""
        from common_middlewares import CacheMiddleware
        mw = CacheMiddleware()
        final = AsyncMock(return_value="fresh_result")
        result = await mw([{"role": "user", "content": "q1"}], final)
        assert result == "fresh_result"
        final.assert_called_once()

    @pytest.mark.asyncio
    async def test_cache_hit_skips_next(self):
        """缓存命中时不调用 call_next"""
        from common_middlewares import CacheMiddleware
        cache = {}
        mw = CacheMiddleware(cache=cache)

        final = AsyncMock(return_value="result")
        msgs = [{"role": "user", "content": "q1"}]

        # 第一次：缓存未命中
        await mw(msgs, final)
        assert final.call_count == 1

        # 第二次：缓存命中
        final2 = AsyncMock(return_value="should_not_call")
        result = await mw(msgs, final2)
        assert result == "result"
        final2.assert_not_called()


# === 4.4 集成场景测试 ===

class TestPipelineScenarios:

    @pytest.mark.asyncio
    async def test_logging_plus_cache(self):
        """日志 + 缓存中间件组合"""
        from common_middlewares import LoggingMiddleware, CacheMiddleware
        pipeline = MiddlewarePipeline()
        pipeline.use(LoggingMiddleware())
        pipeline.use(CacheMiddleware())

        final = AsyncMock(return_value="result")
        msgs = [{"role": "user", "content": "test"}]

        r1 = await pipeline.execute(msgs, final)
        r2 = await pipeline.execute(msgs, final)
        assert r1 == r2 == "result"
        assert final.call_count == 1  # 第二次走缓存

    @pytest.mark.asyncio
    async def test_full_pipeline(self):
        """完整管道：日志 → Token → 修复 → LLM"""
        pipeline = MiddlewarePipeline()
        pipeline.use(PassthroughMiddleware())
        pipeline.use(PassthroughMiddleware())

        final = AsyncMock(return_value="final_result")
        result = await pipeline.execute(
            [{"role": "user", "content": "test"}], final
        )
        assert result == "final_result"
```

---

## 第 5 章 跨域关联

| 关联域 | 关系 | 说明 |
|--------|------|------|
| PD-01 上下文管理 | 实现 | SummarizationMiddleware 是上下文管理的中间件实现 |
| PD-02 多 Agent 编排 | 集成 | 中间件管道可包装 LangGraph 节点的 LLM 调用 |
| PD-03 容错与重试 | 互补 | 重试逻辑可实现为 RetryMiddleware |
| PD-09 Human-in-the-Loop | 扩展 | 可在中间件中插入人工审批检查点 |
| PD-11 可观测性 | 实现 | LoggingMiddleware + TokenCountMiddleware 提供可观测性 |

---

## 第 6 章 来源文件索引

| 编号 | 文件 | 说明 |
|------|------|------|
| S1 | `src/middleware/base.py` | 中间件基类定义 |
| S2 | `src/middleware/summarization.py` | 摘要压缩中间件 |
| S3 | `src/middleware/dangling_tool_call.py` | 悬挂工具调用修复中间件 |
| S4 | `src/middleware/pipeline.py` | 中间件管道组装 |
| S5 | `src/middleware/__init__.py` | 中间件注册表 |