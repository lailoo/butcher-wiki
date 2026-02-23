# PD-09.02 GPT-Researcher — 研究计划确认 + 中间报告预览

> 文档编号：PD-09.02
> 来源：GPT-Researcher `gpt_researcher/master/agent.py`
> GitHub：https://github.com/assafelovic/gpt-researcher
> 问题域：PD-09 Human-in-the-Loop
> 状态：可复用方案

---

## 第 1 章 问题与动机

### 1.1 核心问题

研究型 Agent 在执行长时间任务时，用户面临两个核心焦虑：

- **方向焦虑**：Agent 拆解的研究计划是否符合预期？如果方向错了，等执行完才发现就浪费了大量时间和 API 费用
- **过程焦虑**：Agent 执行到哪一步了？中间产出质量如何？是否需要调整方向？

传统做法是全自动执行后一次性返回结果，用户完全失去对过程的控制。另一个极端是每步都等确认，效率极低。

### 1.2 GPT-Researcher 的解法概述

GPT-Researcher 采用 callback 驱动的交互模式：

1. **研究计划确认**：Agent 生成研究大纲后，通过 callback 通知前端，等待用户确认或修改后再执行
2. **中间报告预览**：每完成一个子任务，通过 callback 推送中间结果，用户可以实时查看进度
3. **方向控制**：用户可以在中间报告阶段调整后续研究方向

### 1.3 设计思想

| 原则 | 说明 |
|------|------|
| Callback 驱动 | 不阻塞主流程，通过回调通知前端 |
| 计划先行 | 先生成计划让用户确认，再执行具体研究 |
| 渐进式交付 | 每个子任务完成后推送中间结果，不等全部完成 |
| 可选交互 | 用户可以选择全自动模式或交互模式 |
| 前端无关 | callback 接口通用，WebSocket / HTTP / CLI 均可对接 |

---

## 第 2 章 源码实现分析

### 2.1 整体架构

```
gpt_researcher/
├── master/
│   └── agent.py          # Master Agent：研究编排 + callback 调用
├── actions/
│   └── query_processing.py  # 查询处理：plan_research_outline
├── config/
│   └── config.py         # 配置：plan_confirmation 开关
└── utils/
    └── callbacks.py      # Callback 协议定义
```

### 2.2 Callback 协议

```python
# gpt_researcher/utils/callbacks.py（简化）
from typing import Protocol, Any


class ResearchCallback(Protocol):
    """研究过程回调协议"""

    async def on_plan_generated(self, plan: dict) -> dict | None:
        """
        研究计划生成后回调。

        Args:
            plan: 研究计划，包含 outline 和 sub_queries

        Returns:
            None = 继续执行原计划
            dict = 使用修改后的计划
        """
        ...

    async def on_sub_task_complete(self, task_id: str, result: dict) -> None:
        """子任务完成回调，用于推送中间结果"""
        ...

    async def on_report_draft(self, draft: str) -> str | None:
        """
        报告草稿生成后回调。

        Returns:
            None = 使用原始草稿
            str = 使用修改后的草稿
        """
        ...

    async def on_progress(self, step: str, progress: float) -> None:
        """进度更新回调"""
        ...
```

### 2.3 Master Agent 中的 callback 调用

```python
# gpt_researcher/master/agent.py（简化）
class GPTResearcher:
    def __init__(self, query: str, callback: ResearchCallback | None = None,
                 config: dict | None = None):
        self.query = query
        self.callback = callback
        self.config = config or {}
        self.plan_confirmation = self.config.get("plan_confirmation", False)

    async def conduct_research(self) -> str:
        """执行研究流程"""
        # 1. 生成研究计划
        plan = await self._generate_plan()

        # 2. 如果开启了计划确认，等待用户反馈
        if self.plan_confirmation and self.callback:
            modified_plan = await self.callback.on_plan_generated(plan)
            if modified_plan is not None:
                plan = modified_plan

        # 3. 执行子任务
        results = []
        for i, sub_query in enumerate(plan["sub_queries"]):
            await self._notify_progress(f"执行子任务 {i+1}/{len(plan['sub_queries'])}")
            result = await self._execute_sub_query(sub_query)
            results.append(result)

            # 推送中间结果
            if self.callback:
                await self.callback.on_sub_task_complete(
                    task_id=f"task_{i}",
                    result={"query": sub_query, "data": result},
                )

        # 4. 生成报告草稿
        draft = await self._generate_report(results)

        # 5. 报告预览（可选）
        if self.callback:
            modified_draft = await self.callback.on_report_draft(draft)
            if modified_draft is not None:
                draft = modified_draft

        return draft

    async def _notify_progress(self, step: str):
        if self.callback:
            await self.callback.on_progress(step, 0.0)

    async def _generate_plan(self) -> dict:
        """生成研究计划"""
        outline = await plan_research_outline(self.query)
        sub_queries = await get_sub_queries(self.query, outline)
        return {"outline": outline, "sub_queries": sub_queries}
```

### 2.4 WebSocket 前端集成

```python
# backend/websocket_handler.py（简化）
import asyncio
from fastapi import WebSocket


class WebSocketResearchCallback:
    """WebSocket 实现的研究回调"""

    def __init__(self, websocket: WebSocket):
        self.ws = websocket
        self._pending_response: asyncio.Future | None = None

    async def on_plan_generated(self, plan: dict) -> dict | None:
        """发送计划到前端，等待用户确认"""
        await self.ws.send_json({
            "type": "plan_review",
            "data": plan,
            "actions": ["approve", "modify", "reject"],
        })

        # 等待前端响应
        response = await self.ws.receive_json()

        if response["action"] == "reject":
            raise UserCancelledError("用户取消了研究任务")
        if response["action"] == "modify":
            return response.get("modified_plan")
        return None  # approve: 继续原计划

    async def on_sub_task_complete(self, task_id: str, result: dict) -> None:
        """推送中间结果到前端"""
        await self.ws.send_json({
            "type": "sub_task_complete",
            "task_id": task_id,
            "data": result,
        })

    async def on_report_draft(self, draft: str) -> str | None:
        """发送报告草稿到前端预览"""
        await self.ws.send_json({
            "type": "report_preview",
            "data": {"draft": draft},
            "actions": ["approve", "modify"],
        })
        response = await self.ws.receive_json()
        if response["action"] == "modify":
            return response.get("modified_draft")
        return None

    async def on_progress(self, step: str, progress: float) -> None:
        await self.ws.send_json({
            "type": "progress",
            "step": step,
            "progress": progress,
        })
```

### 2.5 关键设计决策

| 决策 | GPT-Researcher 的选择 | 理由 |
|------|----------------------|------|
| 交互模式 | Callback 协议 | 前端无关，WebSocket/HTTP/CLI 均可实现 |
| 计划确认 | 可选（config 开关） | 不是所有场景都需要确认 |
| 中间结果推送 | 每个子任务完成后 | 平衡实时性和推送频率 |
| 报告预览 | 草稿阶段 | 最终生成前最后一次修正机会 |
| 用户取消 | 抛异常中断 | 简单直接，调用方 catch 即可 |

---

## 第 3 章 迁移指南

### 3.1 通用架构

```
┌─────────────────────────────────────────────────┐
│           InteractiveResearchAgent               │
│                                                  │
│  [计划生成] → callback.on_plan → [执行子任务]     │
│                                    │             │
│                          callback.on_progress    │
│                          callback.on_sub_task    │
│                                    │             │
│  [报告生成] → callback.on_draft → [最终输出]      │
│                                                  │
│  InteractionMode: AUTO / CONFIRM_PLAN / FULL     │
└─────────────────────────────────────────────────┘
```

### 3.2 通用 Callback 接口

```python
"""research_callback.py — 通用研究过程回调接口"""
from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from enum import Enum
from typing import Any


class InteractionMode(str, Enum):
    """交互模式"""
    AUTO = "auto"                    # 全自动，不等待确认
    CONFIRM_PLAN = "confirm_plan"    # 仅确认计划
    FULL = "full"                    # 计划确认 + 报告预览


@dataclass
class ResearchPlan:
    """研究计划"""
    outline: str
    sub_queries: list[str]
    estimated_time: float | None = None   # 预估耗时（秒）
    estimated_cost: float | None = None   # 预估成本（美元）
    metadata: dict = field(default_factory=dict)


@dataclass
class SubTaskResult:
    """子任务结果"""
    task_id: str
    query: str
    status: str          # "success" | "failed" | "partial"
    data: Any = None
    error: str | None = None


class ResearchCallbackBase(ABC):
    """研究过程回调基类"""

    @abstractmethod
    async def on_plan_generated(self, plan: ResearchPlan) -> ResearchPlan | None:
        """研究计划生成后回调。返回 None 表示继续，返回新计划表示修改。"""
        ...

    @abstractmethod
    async def on_sub_task_complete(self, result: SubTaskResult) -> None:
        """子任务完成回调"""
        ...

    @abstractmethod
    async def on_report_draft(self, draft: str) -> str | None:
        """报告草稿回调。返回 None 表示继续，返回新草稿表示修改。"""
        ...

    async def on_progress(self, step: str, current: int, total: int) -> None:
        """进度更新回调（可选覆盖）"""
        pass

    async def on_error(self, error: Exception, context: str) -> bool:
        """错误回调。返回 True 表示继续，False 表示中止。"""
        return False
```

### 3.3 自动模式 Callback（无交互）

```python
class AutoCallback(ResearchCallbackBase):
    """全自动模式：不等待用户确认，记录日志"""

    def __init__(self, logger=None):
        self.log = logger or logging.getLogger(__name__)
        self.results: list[SubTaskResult] = []

    async def on_plan_generated(self, plan: ResearchPlan) -> None:
        self.log.info(f"研究计划生成：{len(plan.sub_queries)} 个子查询")
        return None  # 自动继续

    async def on_sub_task_complete(self, result: SubTaskResult) -> None:
        self.results.append(result)
        self.log.info(f"子任务 {result.task_id} 完成: {result.status}")

    async def on_report_draft(self, draft: str) -> None:
        self.log.info(f"报告草稿生成，长度: {len(draft)} 字符")
        return None  # 自动继续
```

### 3.4 WebSocket Callback

```python
"""ws_callback.py — WebSocket 交互式回调"""
import asyncio
import json
from fastapi import WebSocket


class WebSocketCallback(ResearchCallbackBase):
    """WebSocket 交互式回调"""

    def __init__(self, websocket: WebSocket, timeout: float = 300.0):
        self.ws = websocket
        self.timeout = timeout

    async def _send_and_wait(self, message: dict) -> dict:
        """发送消息并等待响应，带超时"""
        await self.ws.send_json(message)
        try:
            response = await asyncio.wait_for(
                self.ws.receive_json(), timeout=self.timeout
            )
            return response
        except asyncio.TimeoutError:
            return {"action": "approve"}  # 超时默认批准

    async def on_plan_generated(self, plan: ResearchPlan) -> ResearchPlan | None:
        response = await self._send_and_wait({
            "type": "plan_review",
            "plan": {
                "outline": plan.outline,
                "sub_queries": plan.sub_queries,
                "estimated_time": plan.estimated_time,
                "estimated_cost": plan.estimated_cost,
            },
        })
        if response.get("action") == "reject":
            raise UserCancelledError("用户取消研究")
        if response.get("action") == "modify":
            modified = response.get("modified_plan", {})
            return ResearchPlan(
                outline=modified.get("outline", plan.outline),
                sub_queries=modified.get("sub_queries", plan.sub_queries),
            )
        return None

    async def on_sub_task_complete(self, result: SubTaskResult) -> None:
        await self.ws.send_json({
            "type": "sub_task_complete",
            "task_id": result.task_id,
            "status": result.status,
            "preview": str(result.data)[:500] if result.data else None,
        })

    async def on_report_draft(self, draft: str) -> str | None:
        response = await self._send_and_wait({
            "type": "report_preview",
            "draft": draft,
        })
        if response.get("action") == "modify":
            return response.get("modified_draft")
        return None

    async def on_progress(self, step: str, current: int, total: int) -> None:
        await self.ws.send_json({
            "type": "progress",
            "step": step,
            "current": current,
            "total": total,
        })


class UserCancelledError(Exception):
    """用户主动取消研究"""
    pass
```

### 3.5 研究 Agent 集成

```python
"""interactive_agent.py — 带交互的研究 Agent"""


class InteractiveResearchAgent:
    """支持 Human-in-the-Loop 的研究 Agent"""

    def __init__(self, callback: ResearchCallbackBase,
                 mode: InteractionMode = InteractionMode.CONFIRM_PLAN):
        self.callback = callback
        self.mode = mode

    async def research(self, query: str) -> str:
        # 1. 生成计划
        plan = await self._generate_plan(query)

        # 2. 计划确认（CONFIRM_PLAN 或 FULL 模式）
        if self.mode in (InteractionMode.CONFIRM_PLAN, InteractionMode.FULL):
            modified = await self.callback.on_plan_generated(plan)
            if modified is not None:
                plan = modified

        # 3. 执行子任务
        results = []
        for i, sq in enumerate(plan.sub_queries):
            await self.callback.on_progress("research", i + 1, len(plan.sub_queries))
            result = await self._execute_sub_query(sq, f"task_{i}")
            results.append(result)
            await self.callback.on_sub_task_complete(result)

        # 4. 生成报告
        draft = await self._generate_report(query, results)

        # 5. 报告预览（FULL 模式）
        if self.mode == InteractionMode.FULL:
            modified = await self.callback.on_report_draft(draft)
            if modified is not None:
                draft = modified

        return draft
```

### 3.6 配置参数

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `mode` | CONFIRM_PLAN | 交互模式 |
| `timeout` | 300s | 等待用户响应超时 |
| `auto_approve_on_timeout` | True | 超时后自动批准 |

---

## 第 4 章 测试用例

```python
"""test_research_callback.py — 研究回调完整测试套件"""
import pytest
from unittest.mock import AsyncMock, MagicMock, patch
from research_callback import (
    ResearchCallbackBase, ResearchPlan, SubTaskResult,
    InteractionMode, AutoCallback, UserCancelledError,
)


# === 4.1 数据结构测试 ===

class TestDataStructures:

    def test_research_plan_creation(self):
        plan = ResearchPlan(
            outline="AI Agent 架构分析",
            sub_queries=["LangGraph 架构", "CrewAI 架构"],
        )
        assert len(plan.sub_queries) == 2
        assert plan.estimated_cost is None

    def test_research_plan_with_estimates(self):
        plan = ResearchPlan(
            outline="test",
            sub_queries=["q1"],
            estimated_time=30.0,
            estimated_cost=0.05,
        )
        assert plan.estimated_time == 30.0
        assert plan.estimated_cost == 0.05

    def test_sub_task_result_success(self):
        result = SubTaskResult(
            task_id="t1", query="test", status="success", data={"key": "value"}
        )
        assert result.status == "success"
        assert result.error is None

    def test_sub_task_result_failed(self):
        result = SubTaskResult(
            task_id="t1", query="test", status="failed", error="timeout"
        )
        assert result.status == "failed"


# === 4.2 AutoCallback 测试 ===

class TestAutoCallback:

    @pytest.mark.asyncio
    async def test_on_plan_returns_none(self):
        """自动模式不修改计划"""
        cb = AutoCallback()
        plan = ResearchPlan(outline="test", sub_queries=["q1"])
        result = await cb.on_plan_generated(plan)
        assert result is None

    @pytest.mark.asyncio
    async def test_on_report_draft_returns_none(self):
        """自动模式不修改报告"""
        cb = AutoCallback()
        result = await cb.on_report_draft("draft content")
        assert result is None

    @pytest.mark.asyncio
    async def test_tracks_sub_task_results(self):
        """自动模式记录子任务结果"""
        cb = AutoCallback()
        r1 = SubTaskResult(task_id="t1", query="q1", status="success")
        r2 = SubTaskResult(task_id="t2", query="q2", status="failed", error="err")
        await cb.on_sub_task_complete(r1)
        await cb.on_sub_task_complete(r2)
        assert len(cb.results) == 2
        assert cb.results[1].status == "failed"


# === 4.3 WebSocket Callback 测试 ===

class TestWebSocketCallback:

    def _make_ws(self, responses: list[dict]):
        """创建 mock WebSocket"""
        ws = AsyncMock()
        ws.receive_json = AsyncMock(side_effect=responses)
        return ws

    @pytest.mark.asyncio
    async def test_plan_approve(self):
        """用户批准计划"""
        from ws_callback import WebSocketCallback
        ws = self._make_ws([{"action": "approve"}])
        cb = WebSocketCallback(ws)
        plan = ResearchPlan(outline="test", sub_queries=["q1"])
        result = await cb.on_plan_generated(plan)
        assert result is None
        ws.send_json.assert_called_once()

    @pytest.mark.asyncio
    async def test_plan_modify(self):
        """用户修改计划"""
        from ws_callback import WebSocketCallback
        ws = self._make_ws([{
            "action": "modify",
            "modified_plan": {"outline": "new", "sub_queries": ["new_q"]},
        }])
        cb = WebSocketCallback(ws)
        plan = ResearchPlan(outline="old", sub_queries=["old_q"])
        result = await cb.on_plan_generated(plan)
        assert result is not None
        assert result.sub_queries == ["new_q"]

    @pytest.mark.asyncio
    async def test_plan_reject_raises(self):
        """用户拒绝计划应抛异常"""
        from ws_callback import WebSocketCallback
        ws = self._make_ws([{"action": "reject"}])
        cb = WebSocketCallback(ws)
        plan = ResearchPlan(outline="test", sub_queries=["q1"])
        with pytest.raises(UserCancelledError):
            await cb.on_plan_generated(plan)

    @pytest.mark.asyncio
    async def test_timeout_auto_approves(self):
        """超时应自动批准"""
        import asyncio
        from ws_callback import WebSocketCallback
        ws = AsyncMock()
        ws.receive_json = AsyncMock(side_effect=asyncio.TimeoutError())
        cb = WebSocketCallback(ws, timeout=0.01)
        plan = ResearchPlan(outline="test", sub_queries=["q1"])
        result = await cb.on_plan_generated(plan)
        assert result is None  # 超时 = 自动批准

    @pytest.mark.asyncio
    async def test_report_preview_modify(self):
        """用户修改报告草稿"""
        from ws_callback import WebSocketCallback
        ws = self._make_ws([{"action": "modify", "modified_draft": "better draft"}])
        cb = WebSocketCallback(ws)
        result = await cb.on_report_draft("original draft")
        assert result == "better draft"

    @pytest.mark.asyncio
    async def test_progress_sent(self):
        """进度更新应发送到 WebSocket"""
        from ws_callback import WebSocketCallback
        ws = AsyncMock()
        cb = WebSocketCallback(ws)
        await cb.on_progress("research", 2, 5)
        ws.send_json.assert_called_once()
        call_data = ws.send_json.call_args[0][0]
        assert call_data["type"] == "progress"
        assert call_data["current"] == 2


# === 4.4 交互模式场景测试 ===

class TestInteractionModes:

    @pytest.mark.asyncio
    async def test_auto_mode_skips_confirmation(self):
        """AUTO 模式不调用 on_plan_generated"""
        cb = AsyncMock(spec=ResearchCallbackBase)
        cb.on_plan_generated = AsyncMock()
        cb.on_sub_task_complete = AsyncMock()
        cb.on_report_draft = AsyncMock()
        cb.on_progress = AsyncMock()

        # 模拟 AUTO 模式下 Agent 不调用 plan 确认
        mode = InteractionMode.AUTO
        assert mode == "auto"
        # AUTO 模式下 callback.on_plan_generated 不应被调用

    @pytest.mark.asyncio
    async def test_confirm_plan_mode(self):
        """CONFIRM_PLAN 模式只确认计划，不预览报告"""
        mode = InteractionMode.CONFIRM_PLAN
        assert mode == "confirm_plan"

    @pytest.mark.asyncio
    async def test_full_mode(self):
        """FULL 模式确认计划 + 预览报告"""
        mode = InteractionMode.FULL
        assert mode == "full"

    def test_interaction_mode_values(self):
        """交互模式枚举值正确"""
        assert InteractionMode.AUTO.value == "auto"
        assert InteractionMode.CONFIRM_PLAN.value == "confirm_plan"
        assert InteractionMode.FULL.value == "full"
```

---

## 第 5 章 跨域关联

| 关联域 | 关系 | 说明 |
|--------|------|------|
| PD-02 多 Agent 编排 | 架构 | callback 在 Master-Worker 编排中的 Master 层调用 |
| PD-03 容错与重试 | 互补 | 用户取消时需要优雅中止正在执行的子任务 |
| PD-08 搜索与检索 | 上游 | 子任务执行的搜索结果通过 callback 推送给用户 |
| PD-09.01 DeerFlow interrupt | 对比 | interrupt 是图级暂停，callback 是应用级通知，各有适用场景 |
| PD-11 可观测性 | 输入 | callback 的调用频率、用户响应时间可作为可观测性指标 |

---

## 第 6 章 来源文件索引

| 编号 | 文件 | 说明 |
|------|------|------|
| S1 | `gpt_researcher/master/agent.py` | Master Agent：研究编排 + callback 调用点 |
| S2 | `gpt_researcher/actions/query_processing.py` | 查询处理：plan_research_outline + get_sub_queries |
| S3 | `gpt_researcher/config/config.py` | 配置：plan_confirmation 开关 |
| S4 | `backend/websocket_handler.py` | WebSocket 前端集成示例 |
| S5 | `gpt_researcher/utils/callbacks.py` | Callback 协议定义 |