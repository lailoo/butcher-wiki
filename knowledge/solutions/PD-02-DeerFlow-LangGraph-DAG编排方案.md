# PD-02.01 DeerFlow — LangGraph StateGraph DAG 编排

> 文档编号：PD-02.01
> 来源：DeerFlow `src/graph/builder.py` / `src/graph/nodes.py`
> GitHub：https://github.com/bytedance/deer-flow
> 问题域：PD-02 多 Agent 编排 Multi-Agent Orchestration
> 状态：可复用方案

---

## 第 1 章 问题与动机

### 1.1 核心问题

多个专职 Agent 如何协调执行顺序、并行分发任务、汇聚结果。

```
用户提问 "对比 React 和 Vue 的性能差异"
  → coordinator 判断需要深度研究
  → planner 拆解为 3 个子任务
  → 3 个 researcher 并行执行搜索
  → reporter 汇总生成最终报告
```

没有编排层时：手写 if/else 控制流散落各处、并行需手动 asyncio.gather、状态靠参数传递签名膨胀、新增节点需改多处逻辑。

### 1.2 DeerFlow 的解法概述

基于 LangGraph StateGraph 实现 DAG 编排：

- **coordinator → planner → researcher/coder → reporter** 流水线
- 条件分支（coordinator 判断是否需要规划）+ 并行执行（多 researcher 同时工作）
- 共享 State 对象在节点间传递，图拓扑构建时确定，运行时条件边动态选路

### 1.3 设计思想

| 原则 | 说明 |
|------|------|
| 图即流程 | StateGraph 显式定义数据流，拓扑一目了然 |
| 角色分离 | coordinator/planner/researcher/reporter 各司其职 |
| 状态驱动 | 共享 State 在节点间传递，避免参数爆炸 |
| 声明式编排 | 新节点只需 `add_node` + `add_edge`，不改已有逻辑 |
| 条件路由 | 纯函数决定走向，路由与业务解耦 |

---

## 第 2 章 源码实现分析

### 2.1 整体架构

```
src/graph/
├── builder.py    # 图构建器：节点、边、条件路由
├── nodes.py      # 节点函数：coordinator/planner/researcher/reporter
├── types.py      # State 类型定义
└── consts.py     # 节点名称常量
```

### 2.2 State 类型定义

```python
# src/graph/types.py（简化）
from typing import TypedDict, Annotated, Sequence
from langgraph.graph.message import add_messages
from langchain_core.messages import BaseMessage

class ResearchState(TypedDict):
    messages: Annotated[Sequence[BaseMessage], add_messages]  # 自动追加
    query: str
    plan: dict | None
    research_data: list[dict]
    report: str | None
    current_step: str
    error: str | None
```

关键：`messages` 用 `Annotated[..., add_messages]` 注解，LangGraph 自动追加而非覆盖。其他字段为覆盖语义。

### 2.3 节点函数

每个节点接收 State、返回 State 更新：

```python
# src/graph/nodes.py（简化）
async def coordinator_node(state: ResearchState) -> dict:
    """判断查询类型，决定是否需要深度研究"""
    response = await llm.ainvoke([
        SystemMessage(content="判断用户查询是否需要深度研究..."),
        HumanMessage(content=state["query"])
    ])
    need_research = "需要研究" in response.content
    return {"messages": [response], "current_step": "planner" if need_research else "reporter"}

async def planner_node(state: ResearchState) -> dict:
    """将查询拆解为子任务"""
    plan = await llm.ainvoke([...])
    return {"plan": parse_plan(plan.content), "current_step": "research"}

async def researcher_node(state: ResearchState) -> dict:
    """执行搜索和数据收集"""
    results = [await search_tool.ainvoke(t["query"]) for t in state["plan"]["tasks"]]
    return {"research_data": results, "current_step": "report"}

async def reporter_node(state: ResearchState) -> dict:
    """汇总研究数据生成最终报告"""
    report = await llm.ainvoke([...])
    return {"report": report.content, "current_step": "done"}
```

### 2.4 图构建与条件路由

```python
# src/graph/builder.py（简化）
from langgraph.graph import StateGraph, END

def build_graph() -> StateGraph:
    graph = StateGraph(ResearchState)
    graph.add_node("coordinator", coordinator_node)
    graph.add_node("planner", planner_node)
    graph.add_node("researcher", researcher_node)
    graph.add_node("reporter", reporter_node)
    graph.set_entry_point("coordinator")

    graph.add_conditional_edges(
        "coordinator", route_after_coordinator,
        {"planner": "planner", "reporter": "reporter"}
    )
    graph.add_edge("planner", "researcher")
    graph.add_edge("researcher", "reporter")
    graph.add_edge("reporter", END)
    return graph.compile()

def route_after_coordinator(state: ResearchState) -> str:
    return state.get("current_step", "planner")
```

### 2.5 并行执行（Send API）

```python
from langgraph.constants import Send

def route_research_tasks(state: ResearchState) -> list[Send]:
    """将 plan 中的每个子任务并行分发给 researcher 节点"""
    return [Send("researcher", {"task": t, "query": state["query"]}) for t in state["plan"]["tasks"]]
```

---

## 第 3 章 可复用方案设计

> 从 DeerFlow 模式提炼的通用实现，不依赖特定项目，可直接复制使用。

### 3.1 通用架构图

```
  START → [coordinator] → (条件路由)
                            ├→ [planner] → (Send API 并行分发)
                            │               ├→ [worker_1] ─┐
                            │               ├→ [worker_2] ─┤ 结果汇聚
                            │               └→ [worker_N] ─┘
                            │                       │
                            └───────────────→ [reporter] → END
```

### 3.2 State 类型定义

```python
"""state.py — 通用 DAG 编排状态定义"""
from __future__ import annotations
from typing import Any, TypedDict, Annotated, Sequence
from langgraph.graph.message import add_messages
from langchain_core.messages import BaseMessage


def _merge_lists(existing: list, new: list) -> list:
    """自定义 reducer：合并列表而非覆盖。用于并行节点结果汇聚。"""
    return (existing or []) + (new or [])


class AgentState(TypedDict):
    """DAG 编排共享状态。
    messages 使用 add_messages reducer 自动追加；其他字段为覆盖语义。
    """
    messages: Annotated[Sequence[BaseMessage], add_messages]
    query: str
    current_step: str
    plan: dict[str, Any] | None
    worker_results: Annotated[list[dict], _merge_lists]  # 并行结果自动合并
    final_output: str | None
    error: str | None
```

### 3.3 节点函数模板

```python
"""nodes.py — 通用节点函数模板"""
import json, re
from langchain_core.messages import SystemMessage, HumanMessage

def parse_json(text: str) -> dict:
    """从 LLM 输出提取 JSON，容错 markdown 代码块。"""
    match = re.search(r"```(?:json)?\s*(.*?)```", text, re.DOTALL)
    if match: text = match.group(1)
    try: return json.loads(text.strip())
    except json.JSONDecodeError: return {}

async def coordinator_node(state: AgentState, config: dict) -> dict:
    """协调者：分析输入复杂度，决定执行路径。"""
    llm = config["configurable"]["llm"]
    response = await llm.ainvoke([
        SystemMessage(content='分析查询复杂度。简单返回 {"need_plan": false}，复杂返回 {"need_plan": true}'),
        HumanMessage(content=state["query"]),
    ])
    result = parse_json(response.content)
    return {"messages": [response], "current_step": "planner" if result.get("need_plan") else "reporter"}

async def planner_node(state: AgentState, config: dict) -> dict:
    """规划者：将查询拆解为可并行执行的子任务。"""
    llm = config["configurable"]["llm"]
    response = await llm.ainvoke([
        SystemMessage(content='拆解为子任务，返回: {"tasks": [{"id": "t1", "description": "...", "type": "research|code"}]}'),
        HumanMessage(content=state["query"]),
    ])
    return {"plan": parse_json(response.content), "messages": [response]}

async def worker_node(state: AgentState, config: dict) -> dict:
    """工作者：执行单个子任务（researcher/coder 等角色）。"""
    llm = config["configurable"]["llm"]
    task = config["configurable"].get("task", {})
    tools = config["configurable"].get("tools", [])
    if tools: llm = llm.bind_tools(tools)
    response = await llm.ainvoke([
        SystemMessage(content=f"执行任务：{task.get('description', '')}"),
        HumanMessage(content=state["query"]),
    ])
    return {"worker_results": [{"task_id": task.get("id"), "result": response.content}]}

async def reporter_node(state: AgentState, config: dict) -> dict:
    """报告者：汇总工作结果，生成最终输出。"""
    llm = config["configurable"]["llm"]
    results = state.get("worker_results", [])
    context = "\n\n".join(f"### {r['task_id']}\n{r['result']}" for r in results) if results else "无研究数据，直接回答。"
    response = await llm.ainvoke([
        SystemMessage(content="基于研究数据生成结构化报告。"),
        HumanMessage(content=f"查询：{state['query']}\n\n数据：\n{context}"),
    ])
    return {"final_output": response.content, "messages": [response]}
```

### 3.4 图构建器与路由

```python
"""builder.py — 通用 DAG 图构建器"""
from langgraph.graph import StateGraph, END
from langgraph.constants import Send


def route_after_coordinator(state: AgentState) -> str:
    return state.get("current_step", "planner")


def route_to_workers(state: AgentState) -> list[Send]:
    """并行分发子任务到 worker 节点。"""
    plan = state.get("plan") or {}
    tasks = plan.get("tasks", [])
    if not tasks:
        return [Send("reporter", {})]
    return [Send("worker", {**state, "configurable": {"task": t}}) for t in tasks]


def build_agent_graph(
    state_class: type = AgentState,
    nodes: dict[str, callable] | None = None,
) -> StateGraph:
    """构建 DAG 编排图，返回编译后可直接 ainvoke 的对象。"""
    if nodes is None:
        nodes = {"coordinator": coordinator_node, "planner": planner_node,
                 "worker": worker_node, "reporter": reporter_node}

    graph = StateGraph(state_class)
    for name, func in nodes.items():
        graph.add_node(name, func)

    graph.set_entry_point("coordinator")
    graph.add_conditional_edges("coordinator", route_after_coordinator,
                                {"planner": "planner", "reporter": "reporter"})
    graph.add_conditional_edges("planner", route_to_workers, ["worker"])
    graph.add_edge("worker", "reporter")
    graph.add_edge("reporter", END)
    return graph.compile()
```

### 3.5 配置参数

```python
"""config.py — 运行时配置"""
from dataclasses import dataclass


@dataclass
class GraphConfig:
    llm_model: str = "gpt-4o"
    llm_temperature: float = 0.0
    max_parallel_workers: int = 5
    worker_timeout: float = 60.0
    max_retries: int = 3
    recursion_limit: int = 25           # 防止无限循环
    checkpoint_backend: str = "memory"  # "memory" | "sqlite" | "postgres"


def create_runnable_config(cfg: GraphConfig, **kwargs) -> dict:
    from langchain_openai import ChatOpenAI
    return {
        "configurable": {"llm": ChatOpenAI(model=cfg.llm_model, temperature=cfg.llm_temperature), **kwargs},
        "recursion_limit": cfg.recursion_limit,
    }
```

---

## 第 4 章 集成指南

### 4.1 最小可运行示例

```python
"""minimal_example.py"""
import asyncio
from typing import TypedDict, Annotated, Sequence
from langchain_core.messages import BaseMessage, HumanMessage, SystemMessage
from langchain_openai import ChatOpenAI
from langgraph.graph import StateGraph, END
from langgraph.graph.message import add_messages

class MinimalState(TypedDict):
    messages: Annotated[Sequence[BaseMessage], add_messages]
    query: str
    result: str | None

async def analyze_node(state: MinimalState) -> dict:
    llm = ChatOpenAI(model="gpt-4o-mini", temperature=0)
    response = await llm.ainvoke([
        SystemMessage(content="分析用户查询并给出简洁回答。"),
        HumanMessage(content=state["query"]),
    ])
    return {"result": response.content, "messages": [response]}

graph = StateGraph(MinimalState)
graph.add_node("analyze", analyze_node)
graph.set_entry_point("analyze")
graph.add_edge("analyze", END)
app = graph.compile()

async def main():
    result = await app.ainvoke({"query": "什么是 LangGraph？", "messages": [], "result": None})
    print(result["result"])

if __name__ == "__main__":
    asyncio.run(main())
```

```bash
pip install langgraph langchain-openai langchain-core
export OPENAI_API_KEY="sk-..."
python minimal_example.py
```

### 4.2 添加新 Agent 节点

在 worker → reporter 之间插入 `fact_checker`：

```python
class ExtendedState(AgentState):
    fact_check_result: dict | None

async def fact_checker_node(state: ExtendedState, config: dict) -> dict:
    llm = config["configurable"]["llm"]
    checks = []
    for r in state.get("worker_results", []):
        resp = await llm.ainvoke([SystemMessage(content="验证信息准确性。"), HumanMessage(content=r["result"])])
        checks.append({"task_id": r["task_id"], "check": resp.content})
    return {"fact_check_result": {"checks": checks}}

graph.add_node("fact_checker", fact_checker_node)
graph.add_edge("worker", "fact_checker")
graph.add_edge("fact_checker", "reporter")
```

### 4.3 添加条件分支

```python
def route_by_query_type(state: AgentState) -> str:
    route_map = {"simple": "reporter", "research": "planner", "code": "coder", "clarify": "clarifier"}
    return route_map.get(state.get("current_step", ""), "reporter")

graph.add_conditional_edges("coordinator", route_by_query_type,
    {"reporter": "reporter", "planner": "planner", "coder": "coder", "clarifier": "clarifier"})
```

### 4.4 添加并行执行

```python
from langgraph.constants import Send

def dispatch_parallel_tasks(state: AgentState) -> list[Send]:
    """map-reduce：并行分发子任务，LangGraph 自动通过 reducer 合并 worker_results。"""
    tasks = (state.get("plan") or {}).get("tasks", [])
    return [Send("worker", {"query": state["query"], "messages": state["messages"],
                             "worker_results": [], "configurable": {"task": t}}) for t in tasks]

graph.add_conditional_edges("planner", dispatch_parallel_tasks, ["worker"])
```

---

## 第 5 章 测试用例

```python
"""test_graph.py — 图构建、节点函数、路由的完整测试"""
import pytest
from unittest.mock import AsyncMock, MagicMock
from langgraph.graph import StateGraph, END
from langgraph.constants import Send

# --- 图构建测试 ---
class TestGraphBuilder:
    def test_graph_compiles(self):
        assert build_agent_graph() is not None

    def test_conditional_edges_valid(self):
        g = StateGraph(AgentState)
        g.add_node("coordinator", coordinator_node)
        g.add_node("planner", planner_node)
        g.add_node("reporter", reporter_node)
        g.set_entry_point("coordinator")
        g.add_conditional_edges("coordinator", route_after_coordinator,
                                {"planner": "planner", "reporter": "reporter"})
        g.add_edge("planner", "reporter")
        g.add_edge("reporter", END)
        assert g.compile() is not None

# --- 节点函数测试 ---
def _mock_config(content: str) -> dict:
    llm = AsyncMock()
    llm.ainvoke.return_value = MagicMock(content=content)
    return {"configurable": {"llm": llm}}

class TestNodes:
    @pytest.mark.asyncio
    async def test_coordinator_simple_skips_planner(self):
        r = await coordinator_node({"query": "简单", "messages": []}, _mock_config('{"need_plan": false}'))
        assert r["current_step"] == "reporter"

    @pytest.mark.asyncio
    async def test_coordinator_complex_goes_planner(self):
        r = await coordinator_node({"query": "对比", "messages": []}, _mock_config('{"need_plan": true}'))
        assert r["current_step"] == "planner"

    @pytest.mark.asyncio
    async def test_planner_generates_tasks(self):
        r = await planner_node({"query": "分析", "messages": []},
                               _mock_config('{"tasks": [{"id": "t1", "description": "搜索", "type": "research"}]}'))
        assert len(r["plan"]["tasks"]) == 1

    @pytest.mark.asyncio
    async def test_planner_invalid_json(self):
        r = await planner_node({"query": "test", "messages": []}, _mock_config("不是 JSON"))
        assert r["plan"] == {}

    @pytest.mark.asyncio
    async def test_reporter_generates_output(self):
        r = await reporter_node({"query": "test", "messages": [], "worker_results": [{"task_id": "t1", "result": "数据"}]},
                                _mock_config("最终报告"))
        assert r["final_output"] == "最终报告"

    @pytest.mark.asyncio
    async def test_reporter_empty_results(self):
        r = await reporter_node({"query": "简单", "messages": [], "worker_results": []}, _mock_config("直接回答"))
        assert r["final_output"] is not None

# --- 辅助函数与路由测试 ---
class TestUtils:
    def test_parse_json_plain(self):
        assert parse_json('{"key": "value"}') == {"key": "value"}

    def test_parse_json_code_block(self):
        assert parse_json('```json\n{"key": "value"}\n```') == {"key": "value"}

    def test_parse_json_invalid(self):
        assert parse_json("not json") == {}

    def test_merge_lists(self):
        assert _merge_lists([{"a": 1}], [{"b": 2}]) == [{"a": 1}, {"b": 2}]

    def test_merge_lists_none(self):
        assert _merge_lists(None, [{"a": 1}]) == [{"a": 1}]

    def test_route_to_planner(self):
        assert route_after_coordinator({"current_step": "planner"}) == "planner"

    def test_route_default(self):
        assert route_after_coordinator({}) == "planner"

    def test_workers_dispatch(self):
        r = route_to_workers({"query": "test", "plan": {"tasks": [{"id": "t1"}, {"id": "t2"}]}})
        assert len(r) == 2 and all(isinstance(x, Send) for x in r)

    def test_empty_plan_to_reporter(self):
        assert len(route_to_workers({"query": "test", "plan": {"tasks": []}})) == 1
```

---

## 第 6 章 风险与降级

### 6.1 风险矩阵

| 风险 | 概率 | 影响 | 缓解措施 |
|------|------|------|----------|
| LLM 调用超时 | 高 | 单节点阻塞整图 | `worker_timeout` + 超时返回部分结果 |
| 并行 worker 部分失败 | 中 | 结果不完整 | worker 内 try/catch，失败标记 error，reporter 跳过 |
| 路由返回未注册节点 | 低 | 运行时崩溃 | `dict.get(key, default)` 兜底 |
| 无限循环（图有环） | 中 | 资源耗尽 | `recursion_limit`（默认 25） |

### 6.2 降级装饰器

```python
"""fallback.py"""
import asyncio
from functools import wraps

def with_timeout(seconds: float = 60.0):
    def decorator(func):
        @wraps(func)
        async def wrapper(state, config=None):
            try:
                return await asyncio.wait_for(func(state, config) if config else func(state), timeout=seconds)
            except asyncio.TimeoutError:
                return {"error": f"{func.__name__} 超时（{seconds}s）", "current_step": "reporter"}
        return wrapper
    return decorator

def with_retry(max_retries: int = 3, delay: float = 1.0):
    def decorator(func):
        @wraps(func)
        async def wrapper(state, config=None):
            for attempt in range(max_retries):
                try:
                    return await func(state, config) if config else await func(state)
                except Exception as e:
                    if attempt == max_retries - 1:
                        return {"error": f"{func.__name__} 重试 {max_retries} 次失败: {e}"}
                    await asyncio.sleep(delay * (2 ** attempt))
        return wrapper
    return decorator
```

### 6.3 检查点（断点续跑）

```python
from langgraph.checkpoint.memory import MemorySaver

checkpointer = MemorySaver()  # 生产环境用 SqliteSaver / PostgresSaver
app = graph.compile(checkpointer=checkpointer)

# 恢复执行
result = await app.ainvoke(new_input, {"configurable": {"thread_id": "session-123"}})
```

---

## 第 7 章 适用场景与限制

### 7.1 适用场景

| 场景 | 适合度 | 理由 |
|------|--------|------|
| 多步骤研究（搜索→分析→报告） | 极高 | DAG 天然适合流水线 |
| 并行子任务 | 极高 | Send API 原生 fan-out/fan-in |
| 条件分支工作流 | 高 | conditional_edges 声明式路由 |
| 断点续跑长任务 | 高 | 内置 checkpointer |
| Human-in-the-Loop 审批 | 高 | 任意节点可暂停 |
| 简单单 Agent 对话 | 低 | 直接调 LLM 即可 |

### 7.2 限制

| 限制 | 替代方案 |
|------|----------|
| 学习曲线（State/Reducer/Send） | 简单场景用 asyncio + 函数 |
| 调试不如线性代码直观 | LangSmith 可视化追踪 |
| 图结构编译时确定，不能动态加节点 | Send API 模拟动态分发 |
| Python 生态绑定 | TypeScript 用 LangGraph.js |
| 并行是 asyncio 并发非多进程 | CPU 密集任务需 worker pool |

### 7.3 与其他方案对比

| 维度 | LangGraph DAG | CrewAI | AutoGen | 手写 asyncio |
|------|---------------|--------|---------|-------------|
| 编排模型 | 显式 DAG | 角色扮演 | 对话驱动 | 自由编排 |
| 并行 | Send API | 内置 | 手动 | asyncio.gather |
| 状态管理 | TypedDict+Reducer | Memory | 共享上下文 | 自行管理 |
| 检查点 | 内置 | 无 | 无 | 自行实现 |
| 可视化 | LangSmith | 无 | 无 | 无 |

---

## 跨域关联

| 关联域 | 关系 | 说明 |
|--------|------|------|
| PD-01 上下文管理 | 输入 | 每个节点的 LLM 调用需上下文管理 |
| PD-03 容错与重试 | 互补 | 节点失败的重试、超时、降级 |
| PD-04 工具系统 | 集成 | worker 通过 `bind_tools` 调用工具 |
| PD-09 Human-in-the-Loop | 扩展 | 任意节点插入人工审批断点 |
| PD-10 中间件管道 | 架构 | 中间件可作为节点前/后处理 |
| PD-11 可观测性 | 监控 | LangSmith 追踪执行链路和 token 消耗 |

---

## 来源文件索引

| 编号 | 文件 | 说明 |
|------|------|------|
| S1 | `src/graph/builder.py` | 图构建器：节点注册、边定义、条件路由 |
| S2 | `src/graph/nodes.py` | 节点函数：coordinator/planner/researcher/reporter |
| S3 | `src/graph/types.py` | State 类型定义：ResearchState TypedDict |
| S4 | `src/graph/consts.py` | 节点名称常量 |
| S5 | `src/config/` | 运行时配置：LLM 参数、并行限制、检查点 |
