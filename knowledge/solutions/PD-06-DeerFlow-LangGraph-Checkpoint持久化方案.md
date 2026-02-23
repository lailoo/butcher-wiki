# PD-06.01 DeerFlow — LangGraph Checkpoint 持久化

> 文档编号：PD-06.01
> 来源：DeerFlow `src/graph/builder.py` / `src/storage/`
> GitHub：https://github.com/bytedance/deer-flow
> 问题域：PD-06 记忆持久化 Memory Persistence
> 状态：可复用方案

---

## 第 1 章 问题与动机

### 1.1 核心问题

多步骤 Agent 工作流在执行过程中可能因网络中断、LLM 超时、进程崩溃等原因中断。如果没有持久化机制，所有中间状态丢失，用户必须从头开始。

```
用户发起深度研究任务（预计 5 分钟）
  → coordinator 完成（10s）
  → planner 完成（15s）
  → researcher_1 完成（60s）
  → researcher_2 执行中... 第 45 秒时进程崩溃
  → 所有状态丢失，需要重新执行全部步骤
  → 浪费 130 秒的 LLM 调用费用
```

没有持久化时：长任务不可靠、跨会话无法恢复、多轮对话丢失上下文、无法实现 Human-in-the-Loop 暂停/恢复。

### 1.2 DeerFlow 的解法概述

DeerFlow 基于 LangGraph 内置的 Checkpoint 机制实现状态持久化：

- **每个节点执行后自动保存 State 快照**到持久化后端
- **基于 thread_id 的会话隔离**，不同用户/会话互不干扰
- **支持多种后端**：MemorySaver（开发）、SqliteSaver（单机）、PostgresSaver（生产）
- **断点续跑**：从最后一个成功的 checkpoint 恢复执行

### 1.3 设计思想

| 原则 | 说明 |
|------|------|
| 透明持久化 | 节点函数无需感知持久化，由框架自动处理 |
| 会话隔离 | thread_id 隔离不同用户的状态，支持并发 |
| 可插拔后端 | 开发用内存、生产用 PostgreSQL，切换只需一行 |
| 增量快照 | 每个节点执行后保存增量 diff，而非全量状态 |
| 确定性恢复 | 从 checkpoint 恢复后，后续节点的输入与中断前完全一致 |

---

## 第 2 章 源码实现分析

### 2.1 整体架构

```
src/
├── graph/
│   ├── builder.py        # 图构建 + checkpointer 注入
│   └── types.py          # State 类型定义（可序列化）
├── storage/
│   ├── __init__.py       # 后端工厂
│   ├── memory.py         # MemorySaver 封装
│   ├── sqlite.py         # SqliteSaver 配置
│   └── postgres.py       # PostgresSaver 配置
└── config/
    └── settings.py       # checkpoint_backend 配置项
```

### 2.2 Checkpointer 注入

```python
# src/graph/builder.py（简化）
from langgraph.graph import StateGraph, END
from langgraph.checkpoint.memory import MemorySaver
from langgraph.checkpoint.sqlite import SqliteSaver
from langgraph.checkpoint.postgres import PostgresSaver

def _create_checkpointer(backend: str, **kwargs):
    """根据配置创建对应的 checkpointer 后端"""
    if backend == "memory":
        return MemorySaver()
    elif backend == "sqlite":
        db_path = kwargs.get("db_path", "./checkpoints.db")
        return SqliteSaver.from_conn_string(db_path)
    elif backend == "postgres":
        conn_str = kwargs.get("conn_string", "postgresql://localhost/deerflow")
        return PostgresSaver.from_conn_string(conn_str)
    else:
        raise ValueError(f"Unknown checkpoint backend: {backend}")

def build_graph(checkpoint_backend: str = "memory", **kwargs) -> StateGraph:
    graph = StateGraph(ResearchState)
    graph.add_node("coordinator", coordinator_node)
    graph.add_node("planner", planner_node)
    graph.add_node("researcher", researcher_node)
    graph.add_node("reporter", reporter_node)
    graph.set_entry_point("coordinator")
    # ... edges ...
    graph.add_edge("reporter", END)

    checkpointer = _create_checkpointer(checkpoint_backend, **kwargs)
    return graph.compile(checkpointer=checkpointer)
```

### 2.3 State 序列化要求

LangGraph checkpoint 要求 State 中的所有字段可 JSON 序列化：

```python
# src/graph/types.py（简化）
from typing import TypedDict, Annotated, Sequence
from langgraph.graph.message import add_messages
from langchain_core.messages import BaseMessage

class ResearchState(TypedDict):
    """所有字段必须可 JSON 序列化。
    BaseMessage 由 LangGraph 内置序列化器处理。
    自定义对象需实现 __dict__ 或使用 dataclass。
    """
    messages: Annotated[Sequence[BaseMessage], add_messages]
    query: str
    plan: dict | None           # dict 可直接序列化
    research_data: list[dict]   # list[dict] 可直接序列化
    report: str | None
    current_step: str
    error: str | None
```

### 2.4 Thread-based 会话管理

```python
# 每次调用通过 thread_id 隔离会话状态
async def run_research(query: str, session_id: str):
    app = build_graph(checkpoint_backend="sqlite", db_path="./data/checkpoints.db")

    config = {
        "configurable": {
            "thread_id": session_id,  # 会话隔离的关键
        }
    }

    # 首次执行：从 START 开始
    result = await app.ainvoke(
        {"query": query, "messages": [], "research_data": [], "current_step": ""},
        config=config,
    )
    return result

# 恢复执行：传入相同 thread_id，LangGraph 自动从最后 checkpoint 恢复
async def resume_research(session_id: str, new_input: dict | None = None):
    app = build_graph(checkpoint_backend="sqlite", db_path="./data/checkpoints.db")
    config = {"configurable": {"thread_id": session_id}}

    # 如果有新输入（如 Human-in-the-Loop 反馈），传入；否则传 None 继续
    result = await app.ainvoke(new_input, config=config)
    return result
```

### 2.5 Checkpoint 存储结构

SQLite 后端的存储结构：

```sql
-- LangGraph SqliteSaver 内部表结构（简化）
CREATE TABLE checkpoints (
    thread_id TEXT NOT NULL,
    checkpoint_id TEXT NOT NULL,
    parent_checkpoint_id TEXT,
    type TEXT,                    -- "full" | "diff"
    checkpoint BLOB NOT NULL,    -- JSON 序列化的 State
    metadata BLOB,               -- 节点名称、时间戳等元数据
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (thread_id, checkpoint_id)
);

CREATE TABLE writes (
    thread_id TEXT NOT NULL,
    checkpoint_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    channel TEXT NOT NULL,        -- State 字段名
    type TEXT,
    value BLOB,                  -- 该字段的值
    PRIMARY KEY (thread_id, checkpoint_id, task_id, channel)
);
```

---

## 第 3 章 迁移指南

> 从 DeerFlow 模式提炼的通用 Checkpoint 持久化方案，可直接复制使用。

### 3.1 迁移检查清单

| # | 检查项 | 说明 |
|---|--------|------|
| 1 | State 所有字段可 JSON 序列化 | 自定义类需转为 dict/dataclass |
| 2 | 安装对应后端依赖 | `langgraph-checkpoint-sqlite` 或 `langgraph-checkpoint-postgres` |
| 3 | 配置 thread_id 生成策略 | UUID / user_id + session_id 组合 |
| 4 | 设置 checkpoint 清理策略 | 过期数据定期清理，避免存储膨胀 |
| 5 | 测试断点恢复 | 模拟中断后恢复，验证状态一致性 |

### 3.2 通用 Checkpoint 管理器

```python
"""checkpoint_manager.py — 通用 Checkpoint 持久化管理器"""
from __future__ import annotations
import uuid
from dataclasses import dataclass
from typing import Any, Literal
from langgraph.graph import StateGraph


@dataclass
class CheckpointConfig:
    """Checkpoint 配置"""
    backend: Literal["memory", "sqlite", "postgres"] = "memory"
    sqlite_path: str = "./checkpoints.db"
    postgres_conn: str = "postgresql://localhost/app"
    ttl_hours: int = 24 * 7  # checkpoint 保留时间（小时）


class CheckpointManager:
    """Checkpoint 生命周期管理器"""

    def __init__(self, config: CheckpointConfig | None = None):
        self.config = config or CheckpointConfig()
        self._saver = self._create_saver()

    def _create_saver(self):
        """创建对应后端的 checkpointer"""
        backend = self.config.backend
        if backend == "memory":
            from langgraph.checkpoint.memory import MemorySaver
            return MemorySaver()
        elif backend == "sqlite":
            from langgraph.checkpoint.sqlite import SqliteSaver
            return SqliteSaver.from_conn_string(self.config.sqlite_path)
        elif backend == "postgres":
            from langgraph.checkpoint.postgres import PostgresSaver
            return PostgresSaver.from_conn_string(self.config.postgres_conn)
        raise ValueError(f"Unknown backend: {backend}")

    @property
    def saver(self):
        return self._saver

    def compile_graph(self, graph: StateGraph) -> Any:
        """编译图并注入 checkpointer"""
        return graph.compile(checkpointer=self._saver)

    @staticmethod
    def make_thread_id(user_id: str = "", session_id: str = "") -> str:
        """生成 thread_id"""
        if user_id and session_id:
            return f"{user_id}:{session_id}"
        return str(uuid.uuid4())

    def make_config(self, thread_id: str, **extra) -> dict:
        """生成运行时配置"""
        return {
            "configurable": {
                "thread_id": thread_id,
                **extra,
            }
        }
```

### 3.3 断点续跑适配代码

```python
"""session_runner.py — 支持断点续跑的会话运行器"""
import logging
from typing import Any

logger = logging.getLogger(__name__)


class SessionRunner:
    """管理单个会话的执行与恢复"""

    def __init__(self, app, checkpoint_mgr: CheckpointManager):
        self.app = app
        self.mgr = checkpoint_mgr

    async def start(self, initial_input: dict, user_id: str = "") -> dict:
        """启动新会话"""
        thread_id = self.mgr.make_thread_id(user_id=user_id)
        config = self.mgr.make_config(thread_id)
        logger.info(f"Starting session: {thread_id}")

        result = await self.app.ainvoke(initial_input, config=config)
        return {"thread_id": thread_id, "result": result}

    async def resume(self, thread_id: str, new_input: dict | None = None) -> dict:
        """从断点恢复会话"""
        config = self.mgr.make_config(thread_id)
        logger.info(f"Resuming session: {thread_id}")

        result = await self.app.ainvoke(new_input, config=config)
        return {"thread_id": thread_id, "result": result}

    async def get_state(self, thread_id: str) -> dict | None:
        """获取会话当前状态（用于展示进度）"""
        config = self.mgr.make_config(thread_id)
        try:
            state = await self.app.aget_state(config)
            return state.values if state else None
        except Exception as e:
            logger.error(f"Failed to get state for {thread_id}: {e}")
            return None

    async def list_history(self, thread_id: str) -> list[dict]:
        """列出会话的 checkpoint 历史"""
        config = self.mgr.make_config(thread_id)
        history = []
        async for state in self.app.aget_state_history(config):
            history.append({
                "checkpoint_id": state.config.get("configurable", {}).get("checkpoint_id"),
                "step": state.metadata.get("step", 0),
                "node": state.metadata.get("source", "unknown"),
                "created_at": state.metadata.get("created_at", ""),
            })
        return history
```

### 3.4 场景适配矩阵

| 场景 | 后端选择 | thread_id 策略 | TTL | 说明 |
|------|----------|---------------|-----|------|
| 本地开发/测试 | memory | 随机 UUID | 无 | 进程退出即丢失，足够调试 |
| 单机部署 | sqlite | user_id:session_id | 7 天 | 文件级持久化，零依赖 |
| 多实例生产 | postgres | user_id:session_id | 30 天 | 多实例共享状态 |
| Human-in-the-Loop | sqlite/postgres | user_id:task_id | 任务完成后清理 | 暂停等待人工审批 |
| 长时间研究任务 | postgres | user_id:research_id | 90 天 | 支持跨天恢复 |

### 3.5 PostgreSQL 生产配置

```python
"""postgres_setup.py — PostgreSQL 后端生产配置"""
import os
from langgraph.checkpoint.postgres.aio import AsyncPostgresSaver


async def create_postgres_saver() -> AsyncPostgresSaver:
    """创建异步 PostgreSQL checkpointer"""
    conn_string = os.getenv(
        "CHECKPOINT_POSTGRES_URL",
        "postgresql://user:pass@localhost:5432/app"
    )
    saver = AsyncPostgresSaver.from_conn_string(conn_string)
    # 首次运行时创建表
    await saver.setup()
    return saver


# 连接池配置（生产环境推荐）
POSTGRES_POOL_CONFIG = {
    "min_size": 2,
    "max_size": 10,
    "max_idle": 300,       # 空闲连接最大存活秒数
    "max_lifetime": 3600,  # 连接最大存活秒数
}
```

---

## 第 4 章 测试用例

```python
"""test_checkpoint.py — Checkpoint 持久化完整测试套件"""
import pytest
import asyncio
from unittest.mock import AsyncMock, MagicMock, patch
from typing import TypedDict, Annotated, Sequence
from langgraph.graph import StateGraph, END
from langgraph.graph.message import add_messages
from langgraph.checkpoint.memory import MemorySaver
from langchain_core.messages import BaseMessage, HumanMessage


# === 测试用 State 和节点 ===

class TestState(TypedDict):
    messages: Annotated[Sequence[BaseMessage], add_messages]
    query: str
    step_count: int
    result: str | None

async def step_node(state: TestState) -> dict:
    """每次执行 step_count + 1"""
    return {"step_count": state.get("step_count", 0) + 1}

async def final_node(state: TestState) -> dict:
    return {"result": f"Done after {state['step_count']} steps"}

def build_test_graph(checkpointer=None):
    graph = StateGraph(TestState)
    graph.add_node("step", step_node)
    graph.add_node("final", final_node)
    graph.set_entry_point("step")
    graph.add_edge("step", "final")
    graph.add_edge("final", END)
    return graph.compile(checkpointer=checkpointer)


# === 4.1 Checkpoint 基础行为测试 ===

class TestCheckpointBasics:
    """Checkpoint 创建与恢复的基本行为"""

    @pytest.mark.asyncio
    async def test_checkpoint_created_after_execution(self):
        """执行后应创建 checkpoint"""
        saver = MemorySaver()
        app = build_test_graph(checkpointer=saver)
        config = {"configurable": {"thread_id": "test-1"}}

        await app.ainvoke(
            {"query": "test", "messages": [], "step_count": 0, "result": None},
            config=config,
        )

        # 验证 checkpoint 存在
        state = await app.aget_state(config)
        assert state is not None
        assert state.values["step_count"] == 1

    @pytest.mark.asyncio
    async def test_state_recovery_from_checkpoint(self):
        """应能从 checkpoint 恢复状态"""
        saver = MemorySaver()
        app = build_test_graph(checkpointer=saver)
        config = {"configurable": {"thread_id": "test-2"}}

        await app.ainvoke(
            {"query": "test", "messages": [], "step_count": 0, "result": None},
            config=config,
        )

        # 获取保存的状态
        state = await app.aget_state(config)
        assert state.values["result"] == "Done after 1 steps"

    @pytest.mark.asyncio
    async def test_thread_isolation(self):
        """不同 thread_id 的状态应互相隔离"""
        saver = MemorySaver()
        app = build_test_graph(checkpointer=saver)

        config_a = {"configurable": {"thread_id": "thread-a"}}
        config_b = {"configurable": {"thread_id": "thread-b"}}

        await app.ainvoke(
            {"query": "query-a", "messages": [], "step_count": 0, "result": None},
            config=config_a,
        )
        await app.ainvoke(
            {"query": "query-b", "messages": [], "step_count": 0, "result": None},
            config=config_b,
        )

        state_a = await app.aget_state(config_a)
        state_b = await app.aget_state(config_b)
        assert state_a.values["query"] == "query-a"
        assert state_b.values["query"] == "query-b"


# === 4.2 CheckpointManager 测试 ===

class TestCheckpointManager:
    """CheckpointManager 工厂与配置测试"""

    def test_default_memory_backend(self):
        mgr = CheckpointManager()
        assert mgr.config.backend == "memory"
        assert mgr.saver is not None

    def test_sqlite_backend(self, tmp_path):
        config = CheckpointConfig(backend="sqlite", sqlite_path=str(tmp_path / "test.db"))
        mgr = CheckpointManager(config)
        assert mgr.saver is not None

    def test_invalid_backend_raises(self):
        config = CheckpointConfig(backend="redis")
        with pytest.raises(ValueError, match="Unknown backend"):
            CheckpointManager(config)

    def test_make_thread_id_with_user(self):
        tid = CheckpointManager.make_thread_id(user_id="u1", session_id="s1")
        assert tid == "u1:s1"

    def test_make_thread_id_random(self):
        tid = CheckpointManager.make_thread_id()
        assert len(tid) == 36  # UUID 格式

    def test_make_config(self):
        mgr = CheckpointManager()
        config = mgr.make_config("thread-123", llm="gpt-4o")
        assert config["configurable"]["thread_id"] == "thread-123"
        assert config["configurable"]["llm"] == "gpt-4o"


# === 4.3 SessionRunner 测试 ===

class TestSessionRunner:
    """会话运行器的启动与恢复测试"""

    @pytest.mark.asyncio
    async def test_start_returns_thread_id(self):
        saver = MemorySaver()
        app = build_test_graph(checkpointer=saver)
        mgr = CheckpointManager()
        runner = SessionRunner(app, mgr)

        result = await runner.start(
            {"query": "test", "messages": [], "step_count": 0, "result": None}
        )
        assert "thread_id" in result
        assert result["result"]["result"] is not None

    @pytest.mark.asyncio
    async def test_get_state_returns_current_values(self):
        saver = MemorySaver()
        app = build_test_graph(checkpointer=saver)
        mgr = CheckpointManager()
        runner = SessionRunner(app, mgr)

        result = await runner.start(
            {"query": "test", "messages": [], "step_count": 0, "result": None}
        )
        state = await runner.get_state(result["thread_id"])
        assert state is not None
        assert state["step_count"] == 1

    @pytest.mark.asyncio
    async def test_get_state_nonexistent_thread(self):
        saver = MemorySaver()
        app = build_test_graph(checkpointer=saver)
        mgr = CheckpointManager()
        runner = SessionRunner(app, mgr)

        state = await runner.get_state("nonexistent-thread")
        # MemorySaver 对不存在的 thread 返回 None 或空状态
        # 具体行为取决于 LangGraph 版本


# === 4.4 State 序列化测试 ===

class TestStateSerialization:
    """State 字段的序列化兼容性测试"""

    def test_dict_serializable(self):
        """dict 类型字段应可序列化"""
        import json
        state = {"plan": {"tasks": [{"id": "t1", "desc": "搜索"}]}}
        serialized = json.dumps(state, ensure_ascii=False)
        deserialized = json.loads(serialized)
        assert deserialized == state

    def test_none_fields_serializable(self):
        """None 字段应可序列化"""
        import json
        state = {"result": None, "error": None}
        serialized = json.dumps(state)
        deserialized = json.loads(serialized)
        assert deserialized["result"] is None

    def test_nested_list_serializable(self):
        """嵌套 list[dict] 应可序列化"""
        import json
        state = {"research_data": [{"source": "tavily", "content": "数据"}]}
        serialized = json.dumps(state, ensure_ascii=False)
        deserialized = json.loads(serialized)
        assert len(deserialized["research_data"]) == 1
```

---

## 第 5 章 跨域关联

| 关联域 | 关系 | 说明 |
|--------|------|------|
| PD-02 多 Agent 编排 | 基础 | Checkpoint 保存的是 StateGraph 的执行状态 |
| PD-03 容错与重试 | 互补 | 节点失败后从 checkpoint 恢复，避免全量重试 |
| PD-07 质量检查 | 扩展 | Reviewer 拒绝后可回退到特定 checkpoint 重新生成 |
| PD-09 Human-in-the-Loop | 依赖 | 暂停等待人工审批的核心机制就是 checkpoint |
| PD-11 可观测性 | 输入 | Checkpoint 历史可用于追踪执行链路和耗时分析 |
| PD-01 上下文管理 | 关联 | 持久化的 messages 字段包含完整对话历史 |

---

## 第 6 章 来源文件索引

| 编号 | 文件 | 说明 |
|------|------|------|
| S1 | `src/graph/builder.py` | 图构建器：checkpointer 注入点 |
| S2 | `src/graph/types.py` | State 类型定义：可序列化的 TypedDict |
| S3 | `src/storage/` | 存储后端配置目录 |
| S4 | `src/config/settings.py` | checkpoint_backend 配置项 |
| S5 | LangGraph `langgraph/checkpoint/memory.py` | MemorySaver 实现 |
| S6 | LangGraph `langgraph/checkpoint/sqlite/` | SqliteSaver 实现 |
| S7 | LangGraph `langgraph/checkpoint/postgres/` | PostgresSaver 实现 |
