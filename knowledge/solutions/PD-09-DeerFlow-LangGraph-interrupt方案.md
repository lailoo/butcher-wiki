# PD-09.01 DeerFlow — LangGraph interrupt + human_feedback 节点

> 文档编号：PD-09.01
> 来源：DeerFlow `src/graph/builder.py` / `src/graph/nodes.py`
> GitHub：https://github.com/bytedance/deer-flow
> 问题域：PD-09 Human-in-the-Loop
> 状态：可复用方案

---

## 第 1 章 问题与动机

### 1.1 核心问题

Agent 系统在执行多步任务时，某些关键决策需要人类确认才能继续：

- **高风险操作**：Agent 准备执行删除数据、发送邮件、调用付费 API 等不可逆操作
- **方向确认**：研究型 Agent 拆解出的子任务是否符合用户预期
- **质量把关**：中间产出（如研究报告草稿）需要人工审阅后再进入下一阶段
- **纠偏干预**：Agent 推理方向偏离时，人类需要实时修正

没有 Human-in-the-Loop 机制时，Agent 要么全自动执行（风险不可控），要么每步都等待确认（效率极低）。需要一种机制在"关键节点暂停、等待人类反馈、恢复执行"之间取得平衡。

### 1.2 DeerFlow 的解法概述

DeerFlow 基于 LangGraph 的 `interrupt` 原语实现 Human-in-the-Loop：

1. **interrupt() 暂停**：在图执行的任意节点调用 `interrupt()`，冻结当前状态
2. **human_feedback 节点**：专门的反馈收集节点，接收 approve / reject / modify 三种响应
3. **Command(resume=...) 恢复**：前端通过 WebSocket 发送用户决策，图从暂停点恢复执行
4. **Checkpointer 状态持久化**：暂停期间状态持久化到存储后端，支持跨会话恢复

### 1.3 设计思想

| 原则 | 说明 |
|------|------|
| 最小侵入 | 只在关键节点插入 interrupt，不改变图的整体拓扑 |
| 状态完整保存 | 暂停时所有中间状态持久化，恢复后无信息丢失 |
| 三态响应 | approve（继续）/ reject（终止）/ modify（修改后继续）覆盖所有场景 |
| 异步友好 | 暂停不占用服务端资源，通过 checkpointer 实现无状态恢复 |
| 前端解耦 | interrupt 只负责暂停，展示和交互由前端自行实现 |

---

## 第 2 章 源码实现分析

### 2.1 整体架构

```
src/graph/
├── builder.py       # 图构建：在 planner 后插入 human_feedback 节点
├── nodes.py         # 节点函数：human_feedback_node 使用 interrupt()
├── types.py         # State 定义：包含 human_feedback 字段
└── consts.py        # 节点名称常量

src/api/
└── websocket.py     # WebSocket 端点：接收前端反馈，调用 Command(resume=...)
```

### 2.2 State 中的 human_feedback 字段

```python
# src/graph/types.py（简化）
from typing import TypedDict, Annotated, Sequence, Literal
from langgraph.graph.message import add_messages
from langchain_core.messages import BaseMessage


class HumanFeedback(TypedDict):
    """人类反馈结构"""
    action: Literal["approve", "reject", "modify"]
    message: str | None          # 用户附加说明
    modified_plan: dict | None   # action=modify 时的修改后计划


class ResearchState(TypedDict):
    messages: Annotated[Sequence[BaseMessage], add_messages]
    query: str
    plan: dict | None
    human_feedback: HumanFeedback | None   # 人类反馈
    research_data: list[dict]
    report: str | None
    current_step: str
```

关键：`human_feedback` 字段在 interrupt 恢复后由 `Command(resume=value)` 注入，节点通过读取此字段获取用户决策。

### 2.3 interrupt() 暂停机制

```python
# src/graph/nodes.py（简化）
from langgraph.types import interrupt, Command


async def human_feedback_node(state: ResearchState) -> dict:
    """
    人类反馈节点：暂停图执行，等待用户确认研究计划。

    工作流程：
    1. 调用 interrupt() 暂停执行，将当前计划发送给前端
    2. 前端展示计划，用户选择 approve/reject/modify
    3. 用户决策通过 Command(resume=feedback) 注入
    4. 节点根据反馈决定后续路由
    """
    # interrupt() 暂停执行，参数作为"暂停原因"发送给前端
    feedback = interrupt({
        "type": "plan_review",
        "plan": state["plan"],
        "message": "请审阅研究计划，选择批准、拒绝或修改",
    })

    # --- 以下代码在用户响应后才执行 ---

    if feedback["action"] == "reject":
        return {
            "human_feedback": feedback,
            "current_step": "end",
            "report": "用户取消了研究任务。",
        }

    if feedback["action"] == "modify":
        return {
            "human_feedback": feedback,
            "plan": feedback["modified_plan"],  # 使用用户修改后的计划
            "current_step": "research",
        }

    # approve: 继续执行原计划
    return {
        "human_feedback": feedback,
        "current_step": "research",
    }
```

`interrupt()` 的语义：
- 调用时立即冻结图执行，将参数序列化后返回给调用方
- 图的完整状态通过 Checkpointer 持久化
- 当 `Command(resume=value)` 被调用时，`interrupt()` 返回 `value`，节点继续执行

### 2.4 图构建与条件路由

```python
# src/graph/builder.py（简化）
from langgraph.graph import StateGraph, END


def build_graph() -> StateGraph:
    graph = StateGraph(ResearchState)

    graph.add_node("coordinator", coordinator_node)
    graph.add_node("planner", planner_node)
    graph.add_node("human_feedback", human_feedback_node)  # 人类反馈节点
    graph.add_node("researcher", researcher_node)
    graph.add_node("reporter", reporter_node)

    graph.set_entry_point("coordinator")
    graph.add_conditional_edges(
        "coordinator", route_after_coordinator,
        {"planner": "planner", "reporter": "reporter"}
    )
    # planner 完成后进入 human_feedback 等待确认
    graph.add_edge("planner", "human_feedback")
    graph.add_conditional_edges(
        "human_feedback", route_after_feedback,
        {"research": "researcher", "end": END}
    )
    graph.add_edge("researcher", "reporter")
    graph.add_edge("reporter", END)

    return graph.compile(checkpointer=MemorySaver())


def route_after_feedback(state: ResearchState) -> str:
    """根据人类反馈决定路由"""
    return state.get("current_step", "research")
```

### 2.5 WebSocket 前端集成

```python
# src/api/websocket.py（简化）
from langgraph.types import Command


async def handle_websocket(websocket, graph_app, thread_id: str):
    """WebSocket 处理：接收用户反馈，恢复图执行"""

    # 1. 启动图执行（会在 human_feedback 节点暂停）
    config = {"configurable": {"thread_id": thread_id}}

    async for event in graph_app.astream(
        {"query": "用户查询...", "messages": []},
        config=config,
        stream_mode="updates",
    ):
        # 检测到 interrupt 事件
        if "__interrupt" in event:
            interrupt_data = event["__interrupt"]
            # 将暂停信息发送给前端
            await websocket.send_json({
                "type": "interrupt",
                "data": interrupt_data,
            })

            # 等待前端用户响应
            user_response = await websocket.receive_json()

            # 用 Command(resume=...) 恢复图执行
            async for resume_event in graph_app.astream(
                Command(resume=user_response),
                config=config,
                stream_mode="updates",
            ):
                await websocket.send_json({
                    "type": "update",
                    "data": resume_event,
                })
        else:
            await websocket.send_json({"type": "update", "data": event})
```

### 2.6 状态持久化与跨会话恢复

```python
# Checkpointer 确保暂停期间状态不丢失
from langgraph.checkpoint.memory import MemorySaver
from langgraph.checkpoint.sqlite import SqliteSaver

# 开发环境：内存
checkpointer = MemorySaver()

# 生产环境：SQLite / PostgreSQL
checkpointer = SqliteSaver.from_conn_string("checkpoints.db")

# 编译图时注入 checkpointer
app = graph.compile(checkpointer=checkpointer)

# 恢复执行：只需相同的 thread_id
config = {"configurable": {"thread_id": "session-abc-123"}}
result = await app.ainvoke(Command(resume=user_feedback), config=config)
```

### 2.7 调用链路

```
用户提交查询
  → coordinator → planner → human_feedback
                              │
                              ├─ interrupt() 暂停 ──→ 前端展示计划
                              │                        用户选择操作
                              ├─ Command(resume=approve) → researcher → reporter → END
                              ├─ Command(resume=modify)  → researcher(修改后计划) → reporter → END
                              └─ Command(resume=reject)  → END
```

---

## 第 3 章 迁移指南

### 3.1 通用架构

```
┌──────────────────────────────────────────────────┐
│              HumanInTheLoopGraph                 │
│                                                  │
│  [任意节点] → [approval_gate] → [后续节点]        │
│                    │                             │
│              interrupt()暂停                      │
│              Command(resume=)恢复                 │
│                                                  │
│  Checkpointer: 状态持久化                         │
│  FeedbackHandler: 反馈收集与路由                   │
└──────────────────────────────────────────────────┘
```

### 3.2 通用反馈处理器

```python
"""human_feedback.py — 通用 Human-in-the-Loop 反馈处理器"""
from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from typing import Any, Callable

from langgraph.types import interrupt


class FeedbackAction(str, Enum):
    APPROVE = "approve"
    REJECT = "reject"
    MODIFY = "modify"


@dataclass
class FeedbackRequest:
    """发送给前端的反馈请求"""
    request_type: str           # 请求类型标识，如 "plan_review", "report_preview"
    data: dict[str, Any]        # 需要用户审阅的数据
    message: str                # 提示信息
    allowed_actions: list[FeedbackAction] = None

    def __post_init__(self):
        if self.allowed_actions is None:
            self.allowed_actions = list(FeedbackAction)


@dataclass
class FeedbackResponse:
    """用户返回的反馈"""
    action: FeedbackAction
    message: str | None = None
    modified_data: dict[str, Any] | None = None


class ApprovalGate:
    """
    通用审批门：在图的任意位置插入人工审批节点。

    用法：
        gate = ApprovalGate(request_type="plan_review")
        # 在 LangGraph 节点中调用
        response = gate.request_feedback(plan_data, "请审阅研究计划")
    """

    def __init__(self, request_type: str,
                 on_approve: Callable | None = None,
                 on_reject: Callable | None = None,
                 on_modify: Callable | None = None):
        self.request_type = request_type
        self._handlers = {
            FeedbackAction.APPROVE: on_approve or self._default_approve,
            FeedbackAction.REJECT: on_reject or self._default_reject,
            FeedbackAction.MODIFY: on_modify or self._default_modify,
        }

    def request_feedback(
        self, data: dict[str, Any], message: str = "请确认是否继续"
    ) -> FeedbackResponse:
        """
        暂停图执行，等待人类反馈。

        Args:
            data: 需要用户审阅的数据
            message: 提示信息

        Returns:
            FeedbackResponse 用户反馈
        """
        request = FeedbackRequest(
            request_type=self.request_type,
            data=data,
            message=message,
        )
        # interrupt() 暂停执行，将请求发送给前端
        raw_response = interrupt(request.__dict__)
        return FeedbackResponse(
            action=FeedbackAction(raw_response.get("action", "approve")),
            message=raw_response.get("message"),
            modified_data=raw_response.get("modified_data"),
        )

    def handle(self, response: FeedbackResponse, state: dict) -> dict:
        """根据反馈执行对应处理器"""
        handler = self._handlers.get(response.action, self._default_approve)
        return handler(response, state)

    @staticmethod
    def _default_approve(response: FeedbackResponse, state: dict) -> dict:
        return {"current_step": "continue"}

    @staticmethod
    def _default_reject(response: FeedbackResponse, state: dict) -> dict:
        return {"current_step": "end", "error": response.message or "用户拒绝"}

    @staticmethod
    def _default_modify(response: FeedbackResponse, state: dict) -> dict:
        updates = {"current_step": "continue"}
        if response.modified_data:
            updates.update(response.modified_data)
        return updates
```

### 3.3 节点工厂函数

```python
"""node_factory.py — 快速创建带审批的节点"""


def create_approval_node(
    gate: ApprovalGate,
    data_extractor: Callable[[dict], dict],
    prompt_message: str = "请确认是否继续",
):
    """
    工厂函数：创建一个 LangGraph 审批节点。

    Args:
        gate: ApprovalGate 实例
        data_extractor: 从 state 中提取需要审阅的数据
        prompt_message: 提示信息

    Returns:
        可直接注册到 StateGraph 的节点函数
    """
    async def approval_node(state: dict) -> dict:
        data = data_extractor(state)
        response = gate.request_feedback(data, prompt_message)
        return gate.handle(response, state)

    approval_node.__name__ = f"approval_{gate.request_type}"
    return approval_node


# 使用示例
plan_gate = ApprovalGate(request_type="plan_review")
plan_approval_node = create_approval_node(
    gate=plan_gate,
    data_extractor=lambda s: {"plan": s.get("plan")},
    prompt_message="请审阅研究计划，确认后开始执行",
)

report_gate = ApprovalGate(request_type="report_preview")
report_approval_node = create_approval_node(
    gate=report_gate,
    data_extractor=lambda s: {"report": s.get("report")},
    prompt_message="请预览报告草稿，确认后生成最终版本",
)
```

### 3.4 图构建集成

```python
"""builder.py — 带 Human-in-the-Loop 的图构建"""
from langgraph.graph import StateGraph, END
from langgraph.checkpoint.memory import MemorySaver


def build_hitl_graph(
    nodes: dict[str, callable],
    approval_points: dict[str, tuple[str, callable]] | None = None,
) -> StateGraph:
    """
    构建带审批节点的 DAG 图。

    Args:
        nodes: {"name": node_func} 常规节点
        approval_points: {"after_node": ("approval_name", approval_func)}
                         在指定节点后插入审批节点

    Returns:
        编译后的图
    """
    graph = StateGraph(dict)

    # 注册常规节点
    for name, func in nodes.items():
        graph.add_node(name, func)

    # 注册审批节点
    if approval_points:
        for after_node, (approval_name, approval_func) in approval_points.items():
            graph.add_node(approval_name, approval_func)

    return graph.compile(checkpointer=MemorySaver())
```

### 3.5 配置参数

| 参数 | 默认值 | 说明 | 调优建议 |
|------|--------|------|----------|
| `checkpointer` | MemorySaver | 状态持久化后端 | 生产环境用 SqliteSaver/PostgresSaver |
| `request_type` | - | 审批类型标识 | 每个审批点用不同类型，前端据此渲染不同 UI |
| `allowed_actions` | 全部 | 允许的反馈操作 | 只需确认的场景可只允许 approve/reject |
| `timeout` | 无 | 等待超时 | 可在前端实现超时自动 approve |

---

## 第 4 章 测试用例

```python
"""test_human_feedback.py — Human-in-the-Loop 完整测试套件"""
import pytest
from unittest.mock import patch, MagicMock
from human_feedback import (
    ApprovalGate, FeedbackAction, FeedbackRequest, FeedbackResponse,
)


# === 4.1 FeedbackRequest / FeedbackResponse 数据结构测试 ===

class TestFeedbackDataStructures:

    def test_feedback_request_defaults(self):
        """FeedbackRequest 默认允许所有操作"""
        req = FeedbackRequest(
            request_type="plan_review",
            data={"plan": "test"},
            message="请确认",
        )
        assert req.allowed_actions == list(FeedbackAction)

    def test_feedback_request_custom_actions(self):
        """可限制允许的操作类型"""
        req = FeedbackRequest(
            request_type="confirm",
            data={},
            message="确认？",
            allowed_actions=[FeedbackAction.APPROVE, FeedbackAction.REJECT],
        )
        assert FeedbackAction.MODIFY not in req.allowed_actions

    def test_feedback_response_approve(self):
        resp = FeedbackResponse(action=FeedbackAction.APPROVE)
        assert resp.action == FeedbackAction.APPROVE
        assert resp.message is None
        assert resp.modified_data is None

    def test_feedback_response_modify_with_data(self):
        resp = FeedbackResponse(
            action=FeedbackAction.MODIFY,
            message="调整子任务",
            modified_data={"plan": {"tasks": [{"id": "t1"}]}},
        )
        assert resp.modified_data is not None


# === 4.2 ApprovalGate 核心逻辑测试 ===

class TestApprovalGate:

    def test_handle_approve_returns_continue(self):
        """approve 操作应返回 continue"""
        gate = ApprovalGate(request_type="test")
        response = FeedbackResponse(action=FeedbackAction.APPROVE)
        result = gate.handle(response, {"plan": "test"})
        assert result["current_step"] == "continue"

    def test_handle_reject_returns_end(self):
        """reject 操作应返回 end 并记录原因"""
        gate = ApprovalGate(request_type="test")
        response = FeedbackResponse(
            action=FeedbackAction.REJECT,
            message="方向不对",
        )
        result = gate.handle(response, {})
        assert result["current_step"] == "end"
        assert "方向不对" in result.get("error", "")

    def test_handle_modify_updates_state(self):
        """modify 操作应将修改数据合并到返回值"""
        gate = ApprovalGate(request_type="test")
        response = FeedbackResponse(
            action=FeedbackAction.MODIFY,
            modified_data={"plan": {"tasks": [{"id": "new_task"}]}},
        )
        result = gate.handle(response, {"plan": {"tasks": []}})
        assert result["plan"]["tasks"][0]["id"] == "new_task"
        assert result["current_step"] == "continue"

    def test_custom_handlers(self):
        """支持自定义处理器"""
        custom_approve = lambda resp, state: {"custom": True, "current_step": "next"}
        gate = ApprovalGate(
            request_type="test",
            on_approve=custom_approve,
        )
        response = FeedbackResponse(action=FeedbackAction.APPROVE)
        result = gate.handle(response, {})
        assert result["custom"] is True

    @patch("human_feedback.interrupt")
    def test_request_feedback_calls_interrupt(self, mock_interrupt):
        """request_feedback 应调用 interrupt 暂停执行"""
        mock_interrupt.return_value = {"action": "approve"}
        gate = ApprovalGate(request_type="plan_review")
        response = gate.request_feedback({"plan": "test"}, "请确认")

        mock_interrupt.assert_called_once()
        call_args = mock_interrupt.call_args[0][0]
        assert call_args["request_type"] == "plan_review"
        assert response.action == FeedbackAction.APPROVE

    @patch("human_feedback.interrupt")
    def test_request_feedback_parses_modify_response(self, mock_interrupt):
        """interrupt 返回 modify 时应正确解析 modified_data"""
        mock_interrupt.return_value = {
            "action": "modify",
            "message": "改一下",
            "modified_data": {"plan": "new_plan"},
        }
        gate = ApprovalGate(request_type="test")
        response = gate.request_feedback({}, "确认")

        assert response.action == FeedbackAction.MODIFY
        assert response.modified_data == {"plan": "new_plan"}

    @patch("human_feedback.interrupt")
    def test_request_feedback_defaults_to_approve(self, mock_interrupt):
        """interrupt 返回无 action 时默认 approve"""
        mock_interrupt.return_value = {}
        gate = ApprovalGate(request_type="test")
        response = gate.request_feedback({}, "确认")
        assert response.action == FeedbackAction.APPROVE


# === 4.3 节点工厂测试 ===

class TestNodeFactory:

    @patch("human_feedback.interrupt")
    @pytest.mark.asyncio
    async def test_created_node_calls_gate(self, mock_interrupt):
        """工厂创建的节点应调用 gate 的 request_feedback"""
        mock_interrupt.return_value = {"action": "approve"}
        gate = ApprovalGate(request_type="plan_review")

        from node_factory import create_approval_node
        node = create_approval_node(
            gate=gate,
            data_extractor=lambda s: {"plan": s.get("plan")},
            prompt_message="请确认",
        )
        result = await node({"plan": {"tasks": []}})
        assert result["current_step"] == "continue"

    @patch("human_feedback.interrupt")
    @pytest.mark.asyncio
    async def test_created_node_handles_reject(self, mock_interrupt):
        """工厂创建的节点应正确处理 reject"""
        mock_interrupt.return_value = {"action": "reject", "message": "不需要"}
        gate = ApprovalGate(request_type="test")

        from node_factory import create_approval_node
        node = create_approval_node(
            gate=gate,
            data_extractor=lambda s: s,
        )
        result = await node({})
        assert result["current_step"] == "end"


# === 4.4 场景测试 ===

class TestScenarios:

    @patch("human_feedback.interrupt")
    def test_plan_review_approve_flow(self, mock_interrupt):
        """场景：用户批准研究计划"""
        mock_interrupt.return_value = {"action": "approve"}
        gate = ApprovalGate(request_type="plan_review")

        plan = {"tasks": [{"id": "t1", "desc": "搜索 AI Agent"}]}
        response = gate.request_feedback({"plan": plan}, "请审阅")
        result = gate.handle(response, {"plan": plan})

        assert result["current_step"] == "continue"

    @patch("human_feedback.interrupt")
    def test_plan_review_modify_flow(self, mock_interrupt):
        """场景：用户修改研究计划后继续"""
        new_plan = {"tasks": [{"id": "t1", "desc": "搜索 LangGraph 架构"}]}
        mock_interrupt.return_value = {
            "action": "modify",
            "message": "请聚焦 LangGraph",
            "modified_data": {"plan": new_plan},
        }
        gate = ApprovalGate(request_type="plan_review")
        response = gate.request_feedback({}, "请审阅")
        result = gate.handle(response, {})

        assert result["current_step"] == "continue"
        assert result["plan"] == new_plan

    @patch("human_feedback.interrupt")
    def test_multi_gate_sequential(self, mock_interrupt):
        """场景：多个审批门顺序执行"""
        # 第一个门：计划审批
        mock_interrupt.return_value = {"action": "approve"}
        plan_gate = ApprovalGate(request_type="plan_review")
        r1 = plan_gate.request_feedback({"plan": "test"}, "审阅计划")
        assert r1.action == FeedbackAction.APPROVE

        # 第二个门：报告预览
        mock_interrupt.return_value = {"action": "modify", "modified_data": {"report": "v2"}}
        report_gate = ApprovalGate(request_type="report_preview")
        r2 = report_gate.request_feedback({"report": "v1"}, "预览报告")
        assert r2.action == FeedbackAction.MODIFY
```

---

## 第 5 章 跨域关联

| 关联域 | 关系 | 说明 |
|--------|------|------|
| PD-02 多 Agent 编排 | 架构基础 | interrupt 依赖 LangGraph StateGraph 的图执行模型 |
| PD-03 容错与重试 | 互补 | 暂停期间 checkpointer 确保状态不丢失，等同于断点续跑 |
| PD-06 记忆持久化 | 依赖 | Checkpointer 是 interrupt 的必要组件，无持久化则无法跨会话恢复 |
| PD-10 中间件管道 | 扩展 | 可在 interrupt 前后插入中间件做日志、权限校验 |
| PD-11 可观测性 | 监控 | 需要追踪暂停时长、用户响应时间、approve/reject 比例 |

---

## 第 6 章 来源文件索引

| 编号 | 文件 | 说明 |
|------|------|------|
| S1 | `src/graph/builder.py` | 图构建器：human_feedback 节点注册与边定义 |
| S2 | `src/graph/nodes.py` | 节点函数：human_feedback_node 使用 interrupt() |
| S3 | `src/graph/types.py` | State 类型定义：HumanFeedback TypedDict |
| S4 | `src/api/websocket.py` | WebSocket 端点：接收前端反馈，调用 Command(resume=...) |
| S5 | LangGraph `langgraph.types` | interrupt() 和 Command 原语定义 |
| S6 | LangGraph `langgraph.checkpoint` | Checkpointer 接口：MemorySaver / SqliteSaver |
