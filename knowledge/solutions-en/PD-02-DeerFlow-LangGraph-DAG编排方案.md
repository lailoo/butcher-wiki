# PD-02.01 DeerFlow — LangGraph StateGraph DAG Orchestration

> Document Number: PD-02.01
> Source: DeerFlow `src/graph/builder.py` / `src/graph/nodes.py`
> GitHub: https://github.com/bytedance/deer-flow
> Problem Domain: PD-02 Multi-Agent Orchestration
> Status: Reusable Solution

---

## Chapter 1 Problem and Motivation

### 1.1 Core Problem

How do multiple specialized Agents coordinate execution order, distribute tasks in parallel, and aggregate results.

```
User query "Compare React and Vue performance differences"
  → coordinator determines deep research needed
  → planner breaks down into 3 subtasks
  → 3 researchers execute searches in parallel
  → reporter aggregates and generates final report
```

Without an orchestration layer: control flow scattered across if/else statements, parallelism requires manual asyncio.gather, state passed via parameters causing signature bloat, adding new nodes requires changes in multiple places.

### 1.2 DeerFlow Solution Overview

DAG orchestration based on LangGraph StateGraph:

- **coordinator → planner → researcher/coder → reporter** pipeline
- Conditional branching (coordinator decides if planning is needed) + parallel execution (multiple researchers work simultaneously)
- Shared State object passed between nodes, graph topology determined at build time, runtime conditional edges dynamically route

### 1.3 Design Principles

| Principle | Description |
|-----------|-------------|
| Graph as Process | StateGraph explicitly defines data flow, topology at a glance |
| Role Separation | coordinator/planner/researcher/reporter each with distinct responsibilities |
| State-Driven | Shared State passed between nodes, avoids parameter explosion |
| Declarative Orchestration | New nodes only need `add_node` + `add_edge`, no changes to existing logic |
| Conditional Routing | Pure functions determine flow, routing decoupled from business logic |

---

## Chapter 2 Source Code Implementation Analysis

### 2.1 Overall Architecture

```
src/graph/
├── builder.py    # Graph builder: nodes, edges, conditional routing
├── nodes.py      # Node functions: coordinator/planner/researcher/reporter
├── types.py      # State type definitions
└── consts.py     # Node name constants
```

### 2.2 State Type Definition

```python
# src/graph/types.py (simplified)
from typing import TypedDict, Annotated, Sequence
from langgraph.graph.message import add_messages
from langchain_core.messages import BaseMessage

class ResearchState(TypedDict):
    messages: Annotated[Sequence[BaseMessage], add_messages]  # Auto-append
    query: str
    plan: dict | None
    research_data: list[dict]
    report: str | None
    current_step: str
    error: str | None
```

Key: `messages` annotated with `Annotated[..., add_messages]`, LangGraph automatically appends rather than overwrites. Other fields use overwrite semantics.

### 2.3 Node Functions

Each node receives State and returns State updates:

```python
# src/graph/nodes.py (simplified)
async def coordinator_node(state: ResearchState) -> dict:
    """Determine query type, decide if deep research is needed"""
    response = await llm.ainvoke([
        SystemMessage(content="Determine if user query requires deep research..."),
        HumanMessage(content=state["query"])
    ])
    need_research = "research needed" in response.content
    return {"messages": [response], "current_step": "planner" if need_research else "reporter"}

async def planner_node(state: ResearchState) -> dict:
    """Break down query into subtasks"""
    plan = await llm.ainvoke([...])
    return {"plan": parse_plan(plan.content), "current_step": "research"}

async def researcher_node(state: ResearchState) -> dict:
    """Execute search and data collection"""
    results = [await search_tool.ainvoke(t["query"]) for t in state["plan"]["tasks"]]
    return {"research_data": results, "current_step": "report"}

async def reporter_node(state: ResearchState) -> dict:
    """Aggregate research data and generate final report"""
    report = await llm.ainvoke([...])
    return {"report": report.content, "current_step": "done"}
```

### 2.4 Graph Building and Conditional Routing

```python
# src/graph/builder.py (simplified)
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

### 2.5 Parallel Execution (Send API)

```python
from langgraph.constants import Send

def route_research_tasks(state: ResearchState) -> list[Send]:
    """Distribute each subtask from plan to researcher nodes in parallel"""
    return [Send("researcher", {"task": t, "query": state["query"]}) for t in state["plan"]["tasks"]]
```

---

## Chapter 3 Reusable Solution Design

> Principles extracted from DeerFlow pattern for generic implementation, independent of specific projects, directly copyable.

### 3.1 Generic Architecture Diagram

```
  START → [coordinator] → (conditional routing)
                            ├→ [planner] → (Send API parallel dispatch)
                            │               ├→ [worker_1] ─┐
                            │               ├→ [worker_2] ─┤ result aggregation
                            │               └→ [worker_N] ─┘
                            │                       │
                            └───────────────→ [reporter] → END
```

### 3.2 State Type Definition

```python
"""state.py — Generic DAG orchestration state definition"""
from __future__ import annotations
from typing import Any, TypedDict, Annotated, Sequence
from langgraph.graph.message import add_messages
from langchain_core.messages import BaseMessage


def _merge_lists(existing: list, new: list) -> list:
    """Custom reducer: merge lists rather than overwrite. Used for parallel node result aggregation."""
    return (existing or []) + (new or [])


class AgentState(TypedDict):
    """DAG orchestration shared state.
    messages uses add_messages reducer for auto-append; other fields use overwrite semantics.
    """
    messages: Annotated[Sequence[BaseMessage], add_messages]
    query: str
    current_step: str
    plan: dict[str, Any] | None
    worker_results: Annotated[list[dict], _merge_lists]  # Parallel results auto-merged
    final_output: str | None
    error: str | None
```

### 3.3 Node Function Templates

```python
"""nodes.py — Generic node function templates"""
import json, re
from langchain_core.messages import SystemMessage, HumanMessage

def parse_json(text: str) -> dict:
    """Extract JSON from LLM output, fault-tolerant for markdown code blocks."""
    match = re.search(r"```(?:json)?\s*(.*?)```", text, re.DOTALL)
    if match: text = match.group(1)
    try: return json.loads(text.strip())
    except json.JSONDecodeError: return {}

async def coordinator_node(state: AgentState, config: dict) -> dict:
    """Coordinator: analyze input complexity, decide execution path."""
    llm = config["configurable"]["llm"]
    response = await llm.ainvoke([
        SystemMessage(content='Analyze query complexity. Simple returns {"need_plan": false}, complex returns {"need_plan": true}'),
        HumanMessage(content=state["query"]),
    ])
    result = parse_json(response.content)
    return {"messages": [response], "current_step": "planner" if result.get("need_plan") else "reporter"}

async def planner_node(state: AgentState, config: dict) -> dict:
    """Planner: break down query into parallelizable subtasks."""
    llm = config["configurable"]["llm"]
    response = await llm.ainvoke([
        SystemMessage(content='Break down into subtasks, return: {"tasks": [{"id": "t1", "description": "...", "type": "research|code"}]}'),
        HumanMessage(content=state["query"]),
    ])
    return {"plan": parse_json(response.content), "messages": [response]}

async def worker_node(state: AgentState, config: dict) -> dict:
    """Worker: execute single subtask (researcher/coder roles, etc.)."""
    llm = config["configurable"]["llm"]
    task = config["configurable"].get("task", {})
    tools = config["configurable"].get("tools", [])
    if tools: llm = llm.bind_tools(tools)
    response = await llm.ainvoke([
        SystemMessage(content=f"Execute task: {task.get('description', '')}"),
        HumanMessage(content=state["query"]),
    ])
    return {"worker_results": [{"task_id": task.get("id"), "result": response.content}]}

async def reporter_node(state: AgentState, config: dict) -> dict:
    """Reporter: aggregate work results, generate final output."""
    llm = config["configurable"]["llm"]
    results = state.get("worker_results", [])
    context = "\n\n".join(f"### {r['task_id']}\n{r['result']}" for r in results) if results else "No research data, answer directly."
    response = await llm.ainvoke([
        SystemMessage(content="Generate structured report based on research data."),
        HumanMessage(content=f"Query: {state['query']}\n\nData:\n{context}"),
    ])
    return {"final_output": response.content, "messages": [response]}
```

### 3.4 Graph Builder and Routing

```python
"""builder.py — Generic DAG graph builder"""
from langgraph.graph import StateGraph, END
from langgraph.constants import Send


def route_after_coordinator(state: AgentState) -> str:
    return state.get("current_step", "planner")


def route_to_workers(state: AgentState) -> list[Send]:
    """Distribute subtasks to worker nodes in parallel."""
    plan = state.get("plan") or {}
    tasks = plan.get("tasks", [])
    if not tasks:
        return [Send("reporter", {})]
    return [Send("worker", {**state, "configurable": {"task": t}}) for t in tasks]


def build_agent_graph(
    state_class: type = AgentState,
    nodes: dict[str, callable] | None = None,
) -> StateGraph:
    """Build DAG orchestration graph, return compiled object ready for ainvoke."""
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

### 3.5 Configuration Parameters

```python
"""config.py — Runtime configuration"""
from dataclasses import dataclass


@dataclass
class GraphConfig:
    llm_model: str = "gpt-4o"
    llm_temperature: float = 0.0
    max_parallel_workers: int = 5
    worker_timeout: float = 60.0
    max_retries: int = 3
    recursion_limit: int = 25           # Prevent infinite loops
    checkpoint_backend: str = "memory"  # "memory" | "sqlite" | "postgres"


def create_runnable_config(cfg: GraphConfig, **kwargs) -> dict:
    from langchain_openai import ChatOpenAI
    return {
        "configurable": {"llm": ChatOpenAI(model=cfg.llm_model, temperature=cfg.llm_temperature), **kwargs},
        "recursion_limit": cfg.recursion_limit,
    }
```

---

## Chapter 4 Integration Guide

### 4.1 Minimal Runnable Example

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
        SystemMessage(content="Analyze user query and provide concise answer."),
        HumanMessage(content=state["query"]),
    ])
    return {"result": response.content, "messages": [response]}

graph = StateGraph(MinimalState)
graph.add_node("analyze", analyze_node)
graph.set_entry_point("analyze")
graph.add_edge("analyze", END)
app = graph.compile()

async def main():
    result = await app.ainvoke({"query": "What is LangGraph?", "messages": [], "result": None})
    print(result["result"])

if __name__ == "__main__":
    asyncio.run(main())
```

```bash
pip install langgraph langchain-openai langchain-core
export OPENAI_API_KEY="sk-..."
python minimal_example.py
```

### 4.2 Adding New Agent Node

Insert `fact_checker` between worker and reporter:

```python
class ExtendedState(AgentState):
    fact_check_result: dict | None

async def fact_checker_node(state: ExtendedState, config: dict) -> dict:
    llm = config["configurable"]["llm"]
    checks = []
    for r in state.get("worker_results", []):
        resp = await llm.ainvoke([SystemMessage(content="Verify information accuracy."), HumanMessage(content=r["result"])])
        checks.append({"task_id": r["task_id"], "check": resp.content})
    return {"fact_check_result": {"checks": checks}}

graph.add_node("fact_checker", fact_checker_node)
graph.add_edge("worker", "fact_checker")
graph.add_edge("fact_checker", "reporter")
```

### 4.3 Adding Conditional Branches

```python
def route_by_query_type(state: AgentState) -> str:
    route_map = {"simple": "reporter", "research": "planner", "code": "coder", "clarify": "clarifier"}
    return route_map.get(state.get("current_step", ""), "reporter")

graph.add_conditional_edges("coordinator", route_by_query_type,
    {"reporter": "reporter", "planner": "planner", "coder": "coder", "clarifier": "clarifier"})
```

### 4.4 Adding Parallel Execution

```python
from langgraph.constants import Send

def dispatch_parallel_tasks(state: AgentState) -> list[Send]:
    """Map-reduce: distribute subtasks in parallel, LangGraph auto-merges worker_results via reducer."""
    tasks = (state.get("plan") or {}).get("tasks", [])
    return [Send("worker", {"query": state["query"], "messages": state["messages"],
                             "worker_results": [], "configurable": {"task": t}}) for t in tasks]

graph.add_conditional_edges("planner", dispatch_parallel_tasks, ["worker"])
```

---

## Chapter 5 Test Cases

```python
"""test_graph.py — Complete tests for graph building, node functions, routing"""
import pytest
from unittest.mock import AsyncMock, MagicMock
from langgraph.graph import StateGraph, END
from langgraph.constants import Send

# --- Graph building tests ---
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

# --- Node function tests ---
def _mock_config(content: str) -> dict:
    llm = AsyncMock()
    llm.ainvoke.return_value = MagicMock(content=content)
    return {"configurable": {"llm": llm}}

class TestNodes:
    @pytest.mark.asyncio
    async def test_coordinator_simple_skips_planner(self):
        r = await coordinator_node({"query": "simple", "messages": []}, _mock_config('{"need_plan": false}'))
        assert r["current_step"] == "reporter"

    @pytest.mark.asyncio
    async def test_coordinator_complex_goes_planner(self):
        r = await coordinator_node({"query": "compare", "messages": []}, _mock_config('{"need_plan": true}'))
        assert r["current_step"] == "planner"

    @pytest.mark.asyncio
    async def test_planner_generates_tasks(self):
        r = await planner_node({"query": "analyze", "messages": []},
                               _mock_config('{"tasks": [{"id": "t1", "description": "search", "type": "research"}]}'))
        assert len(r["plan"]["tasks"]) == 1

    @pytest.mark.asyncio
    async def test_planner_invalid_json(self):
        r = await planner_node({"query": "test", "messages": []}, _mock_config("not JSON"))
        assert r["plan"] == {}

    @pytest.mark.asyncio
    async def test_reporter_generates_output(self):
        r = await reporter_node({"query": "test", "messages": [], "worker_results": [{"task_id": "t1", "result": "data"}]},
                                _mock_config("final report"))
        assert r["final_output"] == "final report"

    @pytest.mark.asyncio
    async def test_reporter_empty_results(self):
        r = await reporter_node({"query": "simple", "messages": [], "worker_results": []}, _mock_config("direct answer"))
        assert r["final_output"] is not None

# --- Utility and routing tests ---
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

## Chapter 6 Risks and Fallback

### 6.1 Risk Matrix

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|-----------|
| LLM call timeout | High | Single node blocks entire graph | `worker_timeout` + return partial results on timeout |
| Partial worker failure in parallel | Medium | Incomplete results | try/catch in worker, mark error, reporter skips |
| Routing returns unregistered node | Low | Runtime crash | `dict.get(key, default)` fallback |
| Infinite loop (graph has cycle) | Medium | Resource exhaustion | `recursion_limit` (default 25) |

### 6.2 Fallback Decorators

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
                return {"error": f"{func.__name__} timeout ({seconds}s)", "current_step": "reporter"}
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
                        return {"error": f"{func.__name__} failed after {max_retries} retries: {e}"}
                    await asyncio.sleep(delay * (2 ** attempt))
        return wrapper
    return decorator
```

### 6.3 Checkpoints (Resumable Execution)

```python
from langgraph.checkpoint.memory import MemorySaver

checkpointer = MemorySaver()  # Use SqliteSaver / PostgresSaver in production
app = graph.compile(checkpointer=checkpointer)

# Resume execution
result = await app.ainvoke(new_input, {"configurable": {"thread_id": "session-123"}})
```

---

## Chapter 7 Applicable Scenarios and Limitations

### 7.1 Applicable Scenarios

| Scenario | Suitability | Reason |
|----------|-------------|--------|
| Multi-step research (search→analyze→report) | Excellent | DAG naturally fits pipelines |
| Parallel subtasks | Excellent | Send API native fan-out/fan-in |
| Conditional branch workflows | High | conditional_edges declarative routing |
| Resumable long-running tasks | High | Built-in checkpointer |
| Human-in-the-Loop approval | High | Any node can pause |
| Simple single Agent conversation | Low | Direct LLM call sufficient |

### 7.2 Limitations

| Limitation | Alternative |
|-----------|-------------|
| Learning curve (State/Reducer/Send) | Use asyncio + functions for simple cases |
| Debugging less intuitive than linear code | LangSmith visualization tracing |
| Graph structure fixed at compile time, cannot dynamically add nodes | Send API simulates dynamic dispatch |
| Python ecosystem binding | TypeScript use LangGraph.js |
| Parallelism is asyncio concurrency not multiprocessing | CPU-intensive tasks need worker pool |

### 7.3 Comparison with Other Solutions

| Dimension | LangGraph DAG | CrewAI | AutoGen | Manual asyncio |
|-----------|---------------|--------|---------|-------------|
| Orchestration Model | Explicit DAG | Role-based | Conversation-driven | Free-form |
| Parallelism | Send API | Built-in | Manual | asyncio.gather |
| State Management | TypedDict+Reducer | Memory | Shared context | Self-managed |
| Checkpoints | Built-in | None | None | Self-implemented |
| Visualization | LangSmith | None | None | None |

---

## Cross-Domain Associations

| Related Domain | Relationship | Description |
|----------------|-------------|-------------|
| PD-01 Context Management | Input | Each node's LLM call requires context management |
| PD-03 Fault Tolerance and Retry | Complementary | Node failure retry, timeout, fallback |
| PD-04 Tool System | Integration | Worker calls tools via `bind_tools` |
| PD-09 Human-in-the-Loop | Extension | Insert human approval breakpoint at any node |
| PD-10 Middleware Pipeline | Architecture | Middleware can serve as pre/post-processing for nodes |
| PD-11 Observability | Monitoring | LangSmith traces execution chain and token consumption |

---

## Source File Index

| Number | File | Description |
|--------|------|-------------|
| S1 | `src/graph/builder.py` | Graph builder: node registration, edge definition, conditional routing |
| S2 | `src/graph/nodes.py` | Node functions: coordinator/planner/researcher/reporter |
| S3 | `src/graph/types.py` | State type definition: ResearchState TypedDict |
| S4 | `src/graph/consts.py` | Node name constants |
| S5 | `src/config/` | Runtime configuration: LLM parameters, parallelism limits, checkpoints |