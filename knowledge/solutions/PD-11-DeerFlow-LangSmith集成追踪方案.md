# PD-11.02 DeerFlow — LangSmith 集成追踪

> 文档编号：PD-11.02
> 来源：DeerFlow `src/config/tracing.py`
> GitHub：https://github.com/bytedance/deer-flow
> 问题域：PD-11 可观测性 Observability & Cost Tracking
> 状态：可复用方案

---

## 第 1 章 问题与动机

### 1.1 核心问题

Agent 系统的调试和优化面临独特挑战：

- **链路不可见**：一个用户请求触发 coordinator → planner → researcher → reporter 多个节点，每个节点可能多次调用 LLM，整条链路的执行过程不可见
- **性能瓶颈定位难**：总耗时 30 秒，但不知道是哪个节点慢、哪次 LLM 调用慢
- **Prompt 调优无数据**：不知道每个节点的 prompt 实际内容、LLM 返回了什么、token 消耗多少
- **成本归因困难**：总成本 $0.50，但不知道哪个节点贡献了多少成本
- **回归检测缺失**：修改了 prompt 后，无法对比修改前后的效果差异

### 1.2 DeerFlow 的解法概述

DeerFlow 通过 LangSmith 集成实现零侵入的全链路追踪：

1. **环境变量激活**：只需设置 `LANGCHAIN_TRACING_V2=true`，无需修改任何业务代码
2. **自动追踪**：LangChain/LangGraph 的每次 LLM 调用、工具调用、节点执行自动上报
3. **Dashboard 可视化**：在 LangSmith Web UI 中查看完整执行链路、每个节点的输入输出
4. **Per-node 计时**：每个节点的执行时间、LLM 调用延迟自动记录
5. **成本分析**：按 chain/node/model 维度分析 token 消耗和成本

### 1.3 设计思想

| 原则 | 说明 |
|------|------|
| 零侵入 | 通过环境变量和 LangChain 内置 callback 实现，不改业务代码 |
| 全链路 | 从用户输入到最终输出，每一步都有 trace |
| 层次化 | Run → Chain → LLM Call → Tool Call 四层嵌套 |
| 可选启用 | 开发环境开启，生产环境可关闭或采样 |
| 标准协议 | 基于 OpenTelemetry 思想，trace_id + span_id + parent_id |

---

## 第 2 章 源码实现分析

### 2.1 整体架构

```
src/config/
├── tracing.py       # LangSmith 追踪配置
├── settings.py      # 环境变量读取
└── __init__.py

# LangSmith 追踪是通过 LangChain 内置机制实现的，
# DeerFlow 只需要配置环境变量和可选的自定义 callback。
```

### 2.2 环境变量配置

```python
# src/config/tracing.py（简化）
import os
import logging

logger = logging.getLogger(__name__)


def setup_tracing():
    """配置 LangSmith 追踪。

    必需环境变量：
    - LANGCHAIN_TRACING_V2=true          # 启用追踪
    - LANGCHAIN_API_KEY=ls-...           # LangSmith API Key
    - LANGCHAIN_PROJECT=deer-flow-prod   # 项目名称（用于分组）

    可选环境变量：
    - LANGCHAIN_ENDPOINT=https://api.smith.langchain.com  # 自托管时修改
    - LANGCHAIN_CALLBACKS_BACKGROUND=true                 # 后台异步上报
    """
    tracing_enabled = os.getenv("LANGCHAIN_TRACING_V2", "false").lower() == "true"

    if tracing_enabled:
        api_key = os.getenv("LANGCHAIN_API_KEY")
        project = os.getenv("LANGCHAIN_PROJECT", "default")

        if not api_key:
            logger.warning("LANGCHAIN_TRACING_V2=true 但未设置 LANGCHAIN_API_KEY")
            return False

        # 启用后台异步上报，避免阻塞主流程
        os.environ.setdefault("LANGCHAIN_CALLBACKS_BACKGROUND", "true")

        logger.info(f"LangSmith 追踪已启用: project={project}")
        return True

    logger.info("LangSmith 追踪未启用")
    return False
```

### 2.3 自动追踪机制

LangChain/LangGraph 内置了 LangSmith callback handler。当 `LANGCHAIN_TRACING_V2=true` 时，以下操作自动上报：

```python
# 以下代码无需修改，LangSmith 自动追踪

# 1. LLM 调用 — 自动记录 prompt, response, tokens, latency
from langchain_openai import ChatOpenAI
llm = ChatOpenAI(model="gpt-4o")
response = await llm.ainvoke(messages)  # 自动上报到 LangSmith

# 2. 工具调用 — 自动记录工具名、参数、返回值
from langchain_core.tools import tool
@tool
def search(query: str) -> str:
    return "results..."
result = await search.ainvoke("AI Agent")  # 自动上报

# 3. LangGraph 节点 — 自动记录节点名、输入 state、输出 state
graph = StateGraph(ResearchState)
graph.add_node("researcher", researcher_node)  # 节点执行自动上报
app = graph.compile()
result = await app.ainvoke(input_state)  # 整个图执行自动上报
```

### 2.4 自定义 Metadata 注入

```python
# src/config/tracing.py — 自定义 metadata

from langchain_core.runnables import RunnableConfig


def create_traced_config(
    user_id: str | None = None,
    session_id: str | None = None,
    task_type: str | None = None,
    tags: list[str] | None = None,
) -> RunnableConfig:
    """创建带自定义 metadata 的运行配置。

    这些 metadata 会附加到 LangSmith trace 中，
    便于按用户、会话、任务类型过滤和分析。
    """
    metadata = {}
    if user_id:
        metadata["user_id"] = user_id
    if session_id:
        metadata["session_id"] = session_id
    if task_type:
        metadata["task_type"] = task_type

    return RunnableConfig(
        metadata=metadata,
        tags=tags or [],
        callbacks=[],  # LangSmith callback 自动注入
    )


# 使用
config = create_traced_config(
    user_id="user-123",
    session_id="sess-456",
    task_type="deep_research",
    tags=["production", "v2.1"],
)
result = await app.ainvoke(input_state, config=config)
```

### 2.5 Trace 数据结构

```
LangSmith Trace 层次结构：

Run (顶层)
├── metadata: {user_id, session_id, task_type}
├── tags: ["production", "v2.1"]
├── total_tokens: 15000
├── total_cost: $0.045
├── latency: 12.5s
│
├── Chain: coordinator_node
│   ├── LLM Call: ChatOpenAI (gpt-4o-mini)
│   │   ├── prompt_tokens: 500
│   │   ├── completion_tokens: 100
│   │   ├── latency: 0.8s
│   │   └── cost: $0.000135
│   └── output: {"current_step": "planner"}
│
├── Chain: planner_node
│   ├── LLM Call: ChatOpenAI (gpt-4o)
│   │   ├── prompt_tokens: 1200
│   │   ├── completion_tokens: 800
│   │   ├── latency: 2.1s
│   │   └── cost: $0.011
│   └── output: {"plan": {...}}
│
├── Chain: researcher_node (×3 并行)
│   ├── Tool Call: tavily_search
│   │   ├── input: {"query": "..."}
│   │   ├── output: [...]
│   │   └── latency: 1.5s
│   ├── LLM Call: ChatOpenAI (gpt-4o)
│   │   └── ...
│   └── output: {"research_data": [...]}
│
└── Chain: reporter_node
    ├── LLM Call: ChatOpenAI (gpt-4o)
    │   ├── prompt_tokens: 8000
    │   ├── completion_tokens: 3000
    │   ├── latency: 5.2s
    │   └── cost: $0.050
    └── output: {"report": "..."}
```

### 2.6 Dashboard 功能

| 功能 | 说明 | 用途 |
|------|------|------|
| Trace 列表 | 按时间/状态/标签过滤所有 trace | 快速定位问题 trace |
| Trace 详情 | 展开每个 span 的输入输出 | 调试 prompt 和响应 |
| Latency 分析 | 每个节点的耗时瀑布图 | 定位性能瓶颈 |
| Token 统计 | 按模型/节点的 token 消耗 | 成本优化 |
| 对比视图 | 两个 trace 并排对比 | Prompt 调优前后对比 |
| 数据集 | 从 trace 中提取输入输出作为测试数据 | 回归测试 |

---

## 第 3 章 迁移指南

### 3.1 通用架构

```
┌─────────────────────────────────────────────────┐
│              Tracing Layer                       │
│                                                  │
│  方案 A: LangSmith（LangChain 生态）              │
│    → 零侵入，环境变量激活                          │
│                                                  │
│  方案 B: 自建追踪（通用）                          │
│    → TracingManager + SpanContext                 │
│    → 输出到 JSON 文件 / 控制台 / 自定义后端        │
│                                                  │
│  两种方案可共存，LangSmith 追踪全链路，             │
│  自建追踪补充业务指标                              │
└─────────────────────────────────────────────────┘
```

### 3.2 方案 A：LangSmith 快速集成

```python
"""langsmith_setup.py — LangSmith 一键集成"""
import os


def enable_langsmith(
    project: str = "my-agent",
    api_key: str | None = None,
    endpoint: str = "https://api.smith.langchain.com",
    background: bool = True,
    sampling_rate: float = 1.0,
):
    """
    一键启用 LangSmith 追踪。

    Args:
        project: LangSmith 项目名称
        api_key: API Key（也可通过环境变量设置）
        endpoint: LangSmith API 端点
        background: 是否后台异步上报
        sampling_rate: 采样率（0.0-1.0），生产环境建议 0.1
    """
    os.environ["LANGCHAIN_TRACING_V2"] = "true"
    os.environ["LANGCHAIN_PROJECT"] = project
    os.environ["LANGCHAIN_ENDPOINT"] = endpoint

    if api_key:
        os.environ["LANGCHAIN_API_KEY"] = api_key

    if background:
        os.environ["LANGCHAIN_CALLBACKS_BACKGROUND"] = "true"

    # 采样率控制（通过自定义 callback 实现）
    if sampling_rate < 1.0:
        os.environ["LANGSMITH_SAMPLING_RATE"] = str(sampling_rate)


def disable_langsmith():
    """关闭 LangSmith 追踪"""
    os.environ["LANGCHAIN_TRACING_V2"] = "false"


# 使用
enable_langsmith(project="my-agent-prod", sampling_rate=0.1)
```

### 3.3 方案 B：自建轻量追踪

```python
"""tracing.py — 自建轻量级追踪框架"""
from __future__ import annotations

import json
import time
import uuid
import logging
from contextlib import contextmanager
from dataclasses import dataclass, field
from typing import Any

logger = logging.getLogger(__name__)


@dataclass
class Span:
    """追踪 Span：记录一个操作的开始、结束、输入、输出"""
    span_id: str = field(default_factory=lambda: str(uuid.uuid4())[:8])
    parent_id: str | None = None
    trace_id: str = ""
    name: str = ""
    start_time: float = 0.0
    end_time: float = 0.0
    input_data: Any = None
    output_data: Any = None
    metadata: dict = field(default_factory=dict)
    error: str | None = None
    children: list["Span"] = field(default_factory=list)

    @property
    def duration_ms(self) -> float:
        return (self.end_time - self.start_time) * 1000

    def to_dict(self) -> dict:
        return {
            "span_id": self.span_id,
            "parent_id": self.parent_id,
            "trace_id": self.trace_id,
            "name": self.name,
            "duration_ms": round(self.duration_ms, 1),
            "metadata": self.metadata,
            "error": self.error,
            "children": [c.to_dict() for c in self.children],
        }


class TracingManager:
    """追踪管理器：管理 trace 和 span 的生命周期"""

    def __init__(self, project: str = "default"):
        self.project = project
        self._current_trace_id: str | None = None
        self._span_stack: list[Span] = []
        self._traces: list[Span] = []

    @contextmanager
    def trace(self, name: str, metadata: dict | None = None):
        """创建顶层 trace"""
        trace_id = str(uuid.uuid4())[:12]
        root_span = Span(
            trace_id=trace_id,
            name=name,
            start_time=time.time(),
            metadata=metadata or {},
        )
        self._current_trace_id = trace_id
        self._span_stack.append(root_span)

        try:
            yield root_span
        except Exception as e:
            root_span.error = str(e)
            raise
        finally:
            root_span.end_time = time.time()
            self._span_stack.pop()
            self._current_trace_id = None
            self._traces.append(root_span)
            self._log_trace(root_span)

    @contextmanager
    def span(self, name: str, input_data: Any = None, metadata: dict | None = None):
        """创建子 span"""
        parent = self._span_stack[-1] if self._span_stack else None
        s = Span(
            trace_id=self._current_trace_id or "",
            parent_id=parent.span_id if parent else None,
            name=name,
            start_time=time.time(),
            input_data=input_data,
            metadata=metadata or {},
        )
        if parent:
            parent.children.append(s)
        self._span_stack.append(s)

        try:
            yield s
        except Exception as e:
            s.error = str(e)
            raise
        finally:
            s.end_time = time.time()
            self._span_stack.pop()

    def _log_trace(self, root: Span) -> None:
        logger.info(
            f"Trace完成 | name={root.name} | duration={root.duration_ms:.0f}ms | "
            f"spans={self._count_spans(root)} | error={root.error}"
        )

    def _count_spans(self, span: Span) -> int:
        return 1 + sum(self._count_spans(c) for c in span.children)

    def get_traces(self) -> list[dict]:
        return [t.to_dict() for t in self._traces]
```

### 3.4 自建追踪与 LangGraph 集成

```python
"""langgraph_tracing.py — 自建追踪与 LangGraph 集成"""


def traced_node(tracer: TracingManager):
    """装饰器：为 LangGraph 节点添加追踪"""
    def decorator(func):
        async def wrapper(state, config=None):
            with tracer.span(func.__name__, input_data={"query": state.get("query")}):
                result = await func(state, config) if config else await func(state)
                return result
        wrapper.__name__ = func.__name__
        return wrapper
    return decorator


# 使用
tracer = TracingManager(project="my-agent")

@traced_node(tracer)
async def researcher_node(state, config):
    # 业务逻辑...
    return {"research_data": [...]}

# 在图执行时创建顶层 trace
with tracer.trace("research_task", metadata={"user_id": "u123"}):
    result = await app.ainvoke(input_state)
```

### 3.5 配置参数

| 参数 | 默认值 | 说明 | 调优建议 |
|------|--------|------|----------|
| `LANGCHAIN_TRACING_V2` | false | 是否启用 LangSmith | 开发环境 true，生产环境按需 |
| `LANGCHAIN_PROJECT` | default | 项目名称 | 按环境区分：dev/staging/prod |
| `LANGCHAIN_CALLBACKS_BACKGROUND` | false | 后台异步上报 | 生产环境必须 true |
| `sampling_rate` | 1.0 | 采样率 | 生产环境 0.05-0.1 |

---

## 第 4 章 测试用例

```python
"""test_tracing.py — 追踪框架完整测试套件"""
import time
import pytest
from tracing import TracingManager, Span


# === 4.1 Span 数据结构测试 ===

class TestSpan:

    def test_span_creation(self):
        s = Span(name="test_span", start_time=1000.0, end_time=1001.5)
        assert s.name == "test_span"
        assert s.duration_ms == 1500.0

    def test_span_with_error(self):
        s = Span(name="error_span", error="something failed")
        assert s.error == "something failed"

    def test_span_to_dict(self):
        s = Span(
            name="test", start_time=1000.0, end_time=1001.0,
            metadata={"key": "value"},
        )
        d = s.to_dict()
        assert d["name"] == "test"
        assert d["duration_ms"] == 1000.0
        assert d["metadata"]["key"] == "value"

    def test_span_children(self):
        parent = Span(name="parent")
        child = Span(name="child")
        parent.children.append(child)
        d = parent.to_dict()
        assert len(d["children"]) == 1
        assert d["children"][0]["name"] == "child"

    def test_span_id_unique(self):
        s1 = Span(name="a")
        s2 = Span(name="b")
        assert s1.span_id != s2.span_id


# === 4.2 TracingManager 核心测试 ===

class TestTracingManager:

    def test_trace_creates_root_span(self):
        tracer = TracingManager(project="test")
        with tracer.trace("my_task") as root:
            assert root.name == "my_task"
            assert root.trace_id != ""

    def test_trace_records_duration(self):
        tracer = TracingManager()
        with tracer.trace("task") as root:
            time.sleep(0.01)
        assert root.duration_ms > 0

    def test_trace_captures_error(self):
        tracer = TracingManager()
        with pytest.raises(ValueError):
            with tracer.trace("failing_task") as root:
                raise ValueError("test error")
        assert root.error == "test error"

    def test_nested_spans(self):
        tracer = TracingManager()
        with tracer.trace("task") as root:
            with tracer.span("step_1") as s1:
                pass
            with tracer.span("step_2") as s2:
                pass
        assert len(root.children) == 2
        assert root.children[0].name == "step_1"
        assert root.children[1].name == "step_2"

    def test_deeply_nested_spans(self):
        tracer = TracingManager()
        with tracer.trace("task") as root:
            with tracer.span("level_1") as l1:
                with tracer.span("level_2") as l2:
                    pass
        assert len(root.children) == 1
        assert len(root.children[0].children) == 1
        assert root.children[0].children[0].name == "level_2"

    def test_span_parent_id(self):
        tracer = TracingManager()
        with tracer.trace("task") as root:
            with tracer.span("child") as child:
                assert child.parent_id == root.span_id

    def test_span_metadata(self):
        tracer = TracingManager()
        with tracer.trace("task", metadata={"user": "u1"}) as root:
            assert root.metadata["user"] == "u1"

    def test_get_traces(self):
        tracer = TracingManager()
        with tracer.trace("task_1"):
            pass
        with tracer.trace("task_2"):
            pass
        traces = tracer.get_traces()
        assert len(traces) == 2

    def test_span_error_propagation(self):
        tracer = TracingManager()
        with pytest.raises(RuntimeError):
            with tracer.trace("task") as root:
                with tracer.span("failing_step") as s:
                    raise RuntimeError("step failed")
        assert s.error == "step failed"
        assert root.error == "step failed"

    def test_count_spans(self):
        tracer = TracingManager()
        with tracer.trace("task") as root:
            with tracer.span("a"):
                with tracer.span("a1"):
                    pass
                with tracer.span("a2"):
                    pass
            with tracer.span("b"):
                pass
        count = tracer._count_spans(root)
        assert count == 5  # root + a + a1 + a2 + b


# === 4.3 LangSmith 配置测试 ===

class TestLangSmithSetup:

    def test_enable_sets_env_vars(self, monkeypatch):
        from langsmith_setup import enable_langsmith
        monkeypatch.delenv("LANGCHAIN_TRACING_V2", raising=False)
        enable_langsmith(project="test-project", api_key="ls-test-key")
        import os
        assert os.environ["LANGCHAIN_TRACING_V2"] == "true"
        assert os.environ["LANGCHAIN_PROJECT"] == "test-project"
        assert os.environ["LANGCHAIN_API_KEY"] == "ls-test-key"

    def test_disable_clears_tracing(self, monkeypatch):
        from langsmith_setup import disable_langsmith
        monkeypatch.setenv("LANGCHAIN_TRACING_V2", "true")
        disable_langsmith()
        import os
        assert os.environ["LANGCHAIN_TRACING_V2"] == "false"

    def test_sampling_rate_set(self, monkeypatch):
        from langsmith_setup import enable_langsmith
        monkeypatch.delenv("LANGSMITH_SAMPLING_RATE", raising=False)
        enable_langsmith(project="test", sampling_rate=0.1)
        import os
        assert os.environ.get("LANGSMITH_SAMPLING_RATE") == "0.1"

    def test_background_enabled_by_default(self, monkeypatch):
        from langsmith_setup import enable_langsmith
        monkeypatch.delenv("LANGCHAIN_CALLBACKS_BACKGROUND", raising=False)
        enable_langsmith(project="test")
        import os
        assert os.environ["LANGCHAIN_CALLBACKS_BACKGROUND"] == "true"


# === 4.4 场景测试 ===

class TestScenarios:

    def test_agent_task_tracing(self):
        """场景：完整 Agent 任务追踪"""
        tracer = TracingManager(project="agent")
        with tracer.trace("research_task", metadata={"query": "AI Agent"}) as root:
            with tracer.span("coordinator"):
                time.sleep(0.001)
            with tracer.span("planner"):
                time.sleep(0.001)
            with tracer.span("researcher"):
                with tracer.span("search_tavily"):
                    time.sleep(0.001)
                with tracer.span("search_google"):
                    time.sleep(0.001)
            with tracer.span("reporter"):
                time.sleep(0.001)

        assert len(root.children) == 4
        assert root.children[2].name == "researcher"
        assert len(root.children[2].children) == 2  # 两个搜索子 span

    def test_trace_serialization(self):
        """场景：trace 序列化为 JSON"""
        import json
        tracer = TracingManager()
        with tracer.trace("task") as root:
            with tracer.span("step", metadata={"model": "gpt-4o"}):
                pass
        traces = tracer.get_traces()
        json_str = json.dumps(traces, ensure_ascii=False)
        parsed = json.loads(json_str)
        assert parsed[0]["name"] == "task"
        assert parsed[0]["children"][0]["metadata"]["model"] == "gpt-4o"

    def test_concurrent_traces(self):
        """场景：多个独立 trace"""
        tracer = TracingManager()
        with tracer.trace("task_1"):
            with tracer.span("step_1"):
                pass
        with tracer.trace("task_2"):
            with tracer.span("step_2"):
                pass
        traces = tracer.get_traces()
        assert len(traces) == 2
        assert traces[0]["name"] == "task_1"
        assert traces[1]["name"] == "task_2"
```

---

## 第 5 章 跨域关联

| 关联域 | 关系 | 说明 |
|--------|------|------|
| PD-02 多 Agent 编排 | 追踪对象 | LangGraph 图执行是主要追踪目标 |
| PD-03 容错与重试 | 可见性 | 重试次数、降级路径在 trace 中可见 |
| PD-08 搜索与检索 | 追踪对象 | 搜索工具调用的延迟和结果在 trace 中记录 |
| PD-10 中间件管道 | 互补 | 中间件执行可作为 span 记录到 trace |
| PD-11.01 Token 计数 | 互补 | LangSmith 提供全链路视图，Token 计数器提供精确成本计算 |

---

## 第 6 章 来源文件索引

| 编号 | 文件 | 说明 |
|------|------|------|
| S1 | `src/config/tracing.py` | LangSmith 追踪配置 + setup_tracing() |
| S2 | `src/config/settings.py` | 环境变量读取 |
| S3 | LangChain `langchain_core.tracers` | 内置 LangSmith tracer |
| S4 | LangSmith SDK `langsmith` | Python SDK：手动创建 run/span |
| S5 | LangSmith Web UI | Dashboard：trace 列表、详情、分析 |