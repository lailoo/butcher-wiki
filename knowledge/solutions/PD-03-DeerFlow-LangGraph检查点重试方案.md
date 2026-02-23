# PD-03.02 DeerFlow — LangGraph 检查点 + 节点级重试

> 文档编号：PD-03.02
> 来源：DeerFlow `src/graph/builder.py` / `src/graph/nodes.py`
> GitHub：https://github.com/bytedance/deer-flow
> 问题域：PD-03 容错与重试 Fault Tolerance & Retry
> 状态：可复用方案

---

## 第 1 章 问题与动机

### 1.1 核心问题

Agent 工作流通常包含多个步骤，每个步骤都可能失败。在长流程中（如 10 分钟的深度研究），如果第 8 步失败导致从头重来，用户体验和成本都不可接受：

```
coordinator(2s) → planner(3s) → researcher_1(30s) → researcher_2(25s)
  → researcher_3(35s) → fact_checker(10s) → reporter(15s) → ❌ 失败
  → 从头重来？已花费 120s + $0.50 的 API 调用
```

需要两个能力：
1. **检查点恢复**：失败后从最近成功的节点继续，而非从头开始
2. **节点级重试**：单个节点失败时自动重试，不影响其他节点

### 1.2 DeerFlow 的解法概述

DeerFlow 基于 LangGraph 的内置机制实现容错：

- **Checkpointer**：每个节点执行后自动保存状态快照，失败后可从任意检查点恢复
- **节点级 try/catch**：每个节点函数内部捕获异常，返回错误状态而非抛出
- **条件重试**：路由函数检测错误状态，决定重试还是跳过
- **状态持久化**：支持 Memory / SQLite / PostgreSQL 多种后端

### 1.3 设计思想

| 原则 | 说明 |
|------|------|
| 检查点即保险 | 每步完成后自动存档，失败不丢失已完成的工作 |
| 节点自治 | 每个节点自己处理异常，不依赖全局错误处理 |
| 渐进恢复 | 先重试当前节点，再跳过，最后降级 |
| 状态可追溯 | 检查点记录完整状态历史，支持回放和调试 |
| 后端可插拔 | 开发用 Memory，生产用 PostgreSQL |

---

## 第 2 章 源码实现分析

### 2.1 LangGraph Checkpointer 机制

```python
# LangGraph 内置的检查点机制
from langgraph.checkpoint.memory import MemorySaver
from langgraph.checkpoint.sqlite import SqliteSaver
from langgraph.checkpoint.postgres import PostgresSaver

# 开发环境：内存检查点
checkpointer = MemorySaver()

# 生产环境：持久化检查点
# checkpointer = SqliteSaver.from_conn_string("checkpoints.db")
# checkpointer = PostgresSaver.from_conn_string("postgresql://...")

# 编译图时注入 checkpointer
app = graph.compile(checkpointer=checkpointer)
```

检查点的工作原理：
1. 每个节点执行完毕后，LangGraph 自动将当前 State 序列化并保存
2. 保存的 key 是 `(thread_id, checkpoint_id)`
3. 恢复时，从指定 checkpoint 加载 State，继续执行后续节点

### 2.2 DeerFlow 的节点级容错

```python
# 源码简化自 DeerFlow src/graph/nodes.py
async def researcher_node(state: ResearchState) -> dict:
    """研究节点 — 内置容错"""
    try:
        results = await search_and_analyze(state["query"])
        return {
            "research_data": results,
            "current_step": "reporter",
            "error": None,
        }
    except Exception as e:
        logger.error(f"Researcher failed: {e}")
        return {
            "research_data": [],
            "current_step": "error_handler",
            "error": f"researcher_failed: {str(e)}",
        }
```

### 2.3 条件路由与重试

```python
# 源码简化自 DeerFlow src/graph/builder.py
def route_after_researcher(state: ResearchState) -> str:
    """根据研究结果决定下一步"""
    error = state.get("error")
    retry_count = state.get("retry_count", 0)

    if error and retry_count < MAX_RETRIES:
        logger.info(f"重试 researcher (attempt {retry_count + 1})")
        return "researcher"  # 重试
    elif error:
        logger.warning("重试耗尽，跳过 researcher")
        return "reporter"  # 跳过，用已有数据生成报告
    else:
        return "reporter"  # 正常流转

graph.add_conditional_edges(
    "researcher",
    route_after_researcher,
    {"researcher": "researcher", "reporter": "reporter"},
)
```

### 2.4 检查点恢复流程

```python
# 恢复执行示例
async def resume_research(thread_id: str, new_input: dict = None):
    """从检查点恢复执行"""
    config = {"configurable": {"thread_id": thread_id}}

    if new_input:
        # 从最新检查点继续，注入新输入
        result = await app.ainvoke(new_input, config)
    else:
        # 从最新检查点继续，无新输入
        result = await app.ainvoke(None, config)

    return result
```

### 2.5 关键设计决策

| 决策 | DeerFlow 的选择 | 理由 |
|------|-----------------|------|
| 检查点粒度 | 节点级 | LangGraph 默认行为，每个节点后自动保存 |
| 错误传递 | State 字段 | 通过 `error` 字段传递，路由函数决策 |
| 重试策略 | 条件路由回环 | 利用图的边实现重试，无需额外框架 |
| 持久化后端 | 可配置 | 开发用 Memory，生产用 PostgreSQL |
| 重试上限 | State 计数器 | `retry_count` 字段防止无限重试 |

---

## 第 3 章 可复用方案设计

### 3.1 通用架构

```
┌─────────────────────────────────────────────┐
│              Resilient Graph                 │
│                                             │
│  ┌─────────┐  ┌──────────┐  ┌───────────┐  │
│  │ Node    │→ │Checkpoint│→ │ Retry     │  │
│  │ Wrapper │  │ Saver    │  │ Router    │  │
│  └─────────┘  └──────────┘  └───────────┘  │
│                                             │
│  每个节点: try/catch → 保存检查点 → 路由决策  │
└─────────────────────────────────────────────┘
```

### 3.2 节点容错装饰器

```python
"""resilient_nodes.py — 节点级容错装饰器"""
from __future__ import annotations

import asyncio
import logging
import time
from functools import wraps
from typing import Any, Callable

logger = logging.getLogger(__name__)


def resilient_node(
    max_retries: int = 3,
    retry_delay: float = 1.0,
    fallback_value: dict | None = None,
    error_field: str = "error",
):
    """
    节点容错装饰器。

    功能：
    1. 捕获节点异常，写入 State 的 error 字段
    2. 节点内重试（指数退避）
    3. 重试耗尽后返回 fallback 值

    Args:
        max_retries: 节点内最大重试次数
        retry_delay: 基础重试延迟（秒）
        fallback_value: 重试耗尽后的降级返回值
        error_field: State 中存储错误信息的字段名
    """
    def decorator(func: Callable):
        @wraps(func)
        async def wrapper(state: dict, *args, **kwargs) -> dict:
            last_error = None
            for attempt in range(max_retries + 1):
                try:
                    result = await func(state, *args, **kwargs)
                    # 成功：清除错误状态
                    if isinstance(result, dict):
                        result[error_field] = None
                    return result
                except Exception as e:
                    last_error = e
                    if attempt < max_retries:
                        delay = retry_delay * (2 ** attempt)
                        logger.warning(
                            f"节点 {func.__name__} 第 {attempt+1} 次失败: {e}，"
                            f"{delay:.1f}s 后重试"
                        )
                        await asyncio.sleep(delay)
                    else:
                        logger.error(
                            f"节点 {func.__name__} 重试 {max_retries} 次后仍失败: {e}"
                        )

            # 重试耗尽：返回 fallback 或错误状态
            if fallback_value is not None:
                return {**fallback_value, error_field: str(last_error)}
            return {error_field: f"{func.__name__}_failed: {last_error}"}

        return wrapper
    return decorator


def timeout_node(seconds: float = 60.0, error_field: str = "error"):
    """节点超时装饰器"""
    def decorator(func: Callable):
        @wraps(func)
        async def wrapper(state: dict, *args, **kwargs) -> dict:
            try:
                return await asyncio.wait_for(
                    func(state, *args, **kwargs),
                    timeout=seconds,
                )
            except asyncio.TimeoutError:
                logger.error(f"节点 {func.__name__} 超时 ({seconds}s)")
                return {error_field: f"{func.__name__}_timeout: {seconds}s"}
        return wrapper
    return decorator
```

### 3.3 重试路由器

```python
"""retry_router.py — 基于 State 的重试路由"""
from typing import Callable


class RetryRouter:
    """重试路由器 — 检查 State 中的错误字段，决定重试或继续"""

    def __init__(
        self,
        max_retries: int = 3,
        retry_count_field: str = "retry_count",
        error_field: str = "error",
    ):
        self.max_retries = max_retries
        self.retry_count_field = retry_count_field
        self.error_field = error_field

    def create_router(
        self,
        retry_target: str,
        success_target: str,
        skip_target: str | None = None,
    ) -> Callable:
        """
        创建条件路由函数。

        Args:
            retry_target: 重试时跳转的节点名
            success_target: 成功时跳转的节点名
            skip_target: 重试耗尽时跳转的节点名（默认同 success_target）
        """
        skip = skip_target or success_target
        max_r = self.max_retries
        error_f = self.error_field
        count_f = self.retry_count_field

        def route(state: dict) -> str:
            error = state.get(error_f)
            count = state.get(count_f, 0)

            if not error:
                return success_target
            if count < max_r:
                return retry_target
            return skip

        return route


def increment_retry_count(state: dict, field: str = "retry_count") -> dict:
    """重试计数器递增节点 — 插入在重试边上"""
    return {field: state.get(field, 0) + 1}
```

### 3.4 检查点配置

```python
"""checkpoint_config.py — 检查点后端配置"""
from dataclasses import dataclass
from typing import Literal


@dataclass
class CheckpointConfig:
    """检查点配置"""
    backend: Literal["memory", "sqlite", "postgres"] = "memory"
    connection_string: str = ""
    ttl_seconds: int = 86400  # 检查点保留时间（秒）


def create_checkpointer(config: CheckpointConfig):
    """根据配置创建检查点后端"""
    if config.backend == "memory":
        from langgraph.checkpoint.memory import MemorySaver
        return MemorySaver()
    elif config.backend == "sqlite":
        from langgraph.checkpoint.sqlite import SqliteSaver
        return SqliteSaver.from_conn_string(
            config.connection_string or "checkpoints.db"
        )
    elif config.backend == "postgres":
        from langgraph.checkpoint.postgres import PostgresSaver
        return PostgresSaver.from_conn_string(config.connection_string)
    raise ValueError(f"未知后端: {config.backend}")
```

### 3.5 完整示例：带容错的研究图

```python
"""resilient_graph_example.py — 带检查点和重试的完整研究图"""
from langgraph.graph import StateGraph, END
from typing import TypedDict, Annotated, Sequence
from langgraph.graph.message import add_messages
from langchain_core.messages import BaseMessage


class ResilientState(TypedDict):
    messages: Annotated[Sequence[BaseMessage], add_messages]
    query: str
    research_data: list[dict]
    report: str | None
    error: str | None
    retry_count: int


@resilient_node(max_retries=2, retry_delay=1.0,
                fallback_value={"research_data": []})
async def researcher_node(state: ResilientState) -> dict:
    results = await search_and_analyze(state["query"])
    return {"research_data": results}


@timeout_node(seconds=30.0)
@resilient_node(max_retries=1)
async def reporter_node(state: ResilientState) -> dict:
    report = await generate_report(state["research_data"])
    return {"report": report}


# 构建图
retry_router = RetryRouter(max_retries=3)

graph = StateGraph(ResilientState)
graph.add_node("researcher", researcher_node)
graph.add_node("reporter", reporter_node)
graph.set_entry_point("researcher")

graph.add_conditional_edges(
    "researcher",
    retry_router.create_router(
        retry_target="researcher",
        success_target="reporter",
        skip_target="reporter",
    ),
    {"researcher": "researcher", "reporter": "reporter"},
)
graph.add_edge("reporter", END)

# 编译（带检查点）
checkpointer = create_checkpointer(CheckpointConfig(backend="memory"))
app = graph.compile(checkpointer=checkpointer)
```

### 3.6 配置参数

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `max_retries` (装饰器) | 3 | 节点内重试次数 |
| `retry_delay` | 1.0s | 基础重试延迟 |
| `max_retries` (路由器) | 3 | 图级重试次数 |
| `checkpoint_backend` | "memory" | 检查点后端 |
| `timeout` | 60.0s | 节点超时时间 |

---

## 第 4 章 测试用例

```python
"""test_resilient_graph.py — 容错机制测试"""
import asyncio
import pytest
from unittest.mock import AsyncMock, MagicMock, patch


# === 装饰器测试 ===

class TestResilientNode:

    @pytest.mark.asyncio
    async def test_success_on_first_attempt(self):
        """首次成功时直接返回结果"""
        @resilient_node(max_retries=3)
        async def good_node(state):
            return {"data": "ok"}

        result = await good_node({"query": "test"})
        assert result["data"] == "ok"
        assert result["error"] is None

    @pytest.mark.asyncio
    async def test_success_after_retry(self):
        """重试后成功"""
        call_count = 0

        @resilient_node(max_retries=3, retry_delay=0.01)
        async def flaky_node(state):
            nonlocal call_count
            call_count += 1
            if call_count < 3:
                raise ConnectionError("暂时失败")
            return {"data": "recovered"}

        result = await flaky_node({"query": "test"})
        assert result["data"] == "recovered"
        assert call_count == 3

    @pytest.mark.asyncio
    async def test_fallback_on_exhaustion(self):
        """重试耗尽后返回 fallback"""
        @resilient_node(max_retries=2, retry_delay=0.01,
                       fallback_value={"data": "default"})
        async def bad_node(state):
            raise RuntimeError("永远失败")

        result = await bad_node({"query": "test"})
        assert result["data"] == "default"
        assert "永远失败" in result["error"]

    @pytest.mark.asyncio
    async def test_error_state_on_failure(self):
        """无 fallback 时返回错误状态"""
        @resilient_node(max_retries=0)
        async def bad_node(state):
            raise ValueError("参数错误")

        result = await bad_node({"query": "test"})
        assert "bad_node_failed" in result["error"]


class TestTimeoutNode:

    @pytest.mark.asyncio
    async def test_timeout_returns_error(self):
        """超时应返回错误状态"""
        @timeout_node(seconds=0.1)
        async def slow_node(state):
            await asyncio.sleep(5.0)
            return {"data": "never"}

        result = await slow_node({"query": "test"})
        assert "timeout" in result["error"]

    @pytest.mark.asyncio
    async def test_fast_node_succeeds(self):
        """未超时的节点正常返回"""
        @timeout_node(seconds=5.0)
        async def fast_node(state):
            return {"data": "quick"}

        result = await fast_node({"query": "test"})
        assert result["data"] == "quick"


# === 路由器测试 ===

class TestRetryRouter:

    def test_success_routes_forward(self):
        """无错误时路由到成功目标"""
        router = RetryRouter(max_retries=3)
        route = router.create_router("retry", "next", "skip")
        assert route({"error": None, "retry_count": 0}) == "next"

    def test_error_routes_to_retry(self):
        """有错误且未超限时路由到重试"""
        router = RetryRouter(max_retries=3)
        route = router.create_router("retry", "next", "skip")
        assert route({"error": "some error", "retry_count": 1}) == "retry"

    def test_exhausted_routes_to_skip(self):
        """重试耗尽时路由到跳过目标"""
        router = RetryRouter(max_retries=3)
        route = router.create_router("retry", "next", "skip")
        assert route({"error": "some error", "retry_count": 3}) == "skip"

    def test_default_skip_equals_success(self):
        """未指定 skip_target 时默认等于 success_target"""
        router = RetryRouter(max_retries=1)
        route = router.create_router("retry", "next")
        assert route({"error": "err", "retry_count": 1}) == "next"


# === 检查点测试 ===

class TestCheckpoint:

    def test_memory_checkpointer_creation(self):
        """Memory 后端应正常创建"""
        cp = create_checkpointer(CheckpointConfig(backend="memory"))
        assert cp is not None

    def test_invalid_backend_raises(self):
        """无效后端应抛异常"""
        with pytest.raises(ValueError, match="未知后端"):
            create_checkpointer(CheckpointConfig(backend="redis"))


# === 重试计数器测试 ===

class TestRetryCounter:

    def test_increment_from_zero(self):
        result = increment_retry_count({"retry_count": 0})
        assert result["retry_count"] == 1

    def test_increment_existing(self):
        result = increment_retry_count({"retry_count": 2})
        assert result["retry_count"] == 3

    def test_increment_missing_field(self):
        result = increment_retry_count({})
        assert result["retry_count"] == 1
```

---

## 第 5 章 跨域关联

| 关联域 | 关系 | 说明 |
|--------|------|------|
| PD-02 多 Agent 编排 | 基础 | 容错机制嵌入 DAG 图的节点和边中 |
| PD-03.01 指数退避 | 互补 | 节点内重试用指数退避，图级重试用条件路由 |
| PD-06 记忆持久化 | 集成 | 检查点后端可复用记忆持久化的存储层 |
| PD-09 Human-in-the-Loop | 扩展 | 检查点支持暂停/恢复，天然适配人工审批 |
| PD-11 可观测性 | 监控 | 重试次数、失败率、恢复时间需要追踪 |

---

## 第 6 章 来源文件索引

| 编号 | 文件 | 说明 |
|------|------|------|
| S1 | `src/graph/builder.py` | 图构建器：检查点注入、条件路由 |
| S2 | `src/graph/nodes.py` | 节点函数：内置 try/catch 容错 |
| S3 | `src/graph/types.py` | State 类型：error / retry_count 字段 |
| S4 | LangGraph `checkpoint/` | 检查点后端：Memory / SQLite / PostgreSQL |
