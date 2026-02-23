# PD-02.03 MiroThinker — Orchestrator 单中心调度

> 文档编号：PD-02.03
> 来源：MiroThinker `orchestrator.py` / `agent_manager.py`
> GitHub：https://github.com/MiroMindAI/MiroThinker
> 问题域：PD-02 多 Agent 编排 Multi-Agent Orchestration
> 状态：可复用方案

---

## 第 1 章 问题与动机

### 1.1 核心问题

并非所有 Agent 系统都需要复杂的 DAG 编排或 Master-Worker 并行。很多场景下，一个中心调度器就够了：

```
用户: "帮我分析这段代码的性能问题"
  → Orchestrator 判断需要 code_analyzer 角色
  → 切换 system prompt 为代码分析专家
  → 调用代码分析工具
  → 返回分析结果
  → 判断是否需要进一步优化建议
  → 切换 system prompt 为优化专家
  → 返回优化建议
```

这种模式下，不需要多个独立 Agent 实例，不需要消息传递协议，不需要状态图。一个 Orchestrator + 角色切换就能完成。

### 1.2 MiroThinker 的解法概述

MiroThinker 采用单中心 Orchestrator 模式：

- **单一 LLM 实例**：所有"角色"共享同一个 LLM 连接
- **System Prompt 切换**：通过更换 system prompt 实现角色转换
- **工具路由**：Orchestrator 根据当前角色绑定不同的工具集
- **顺序执行**：任务按步骤顺序执行，每步可切换角色

### 1.3 设计思想

| 原则 | 说明 |
|------|------|
| 简单优先 | 能用一个 Agent 解决的不用多个 |
| 角色即 Prompt | 不同角色只是不同的 system prompt，不是不同的进程 |
| 工具绑定 | 每个角色有自己的工具集，避免工具污染 |
| 顺序可控 | 执行顺序由 Orchestrator 显式控制，可预测 |
| 低开销 | 无进程间通信、无状态同步、无消息队列 |

---

## 第 2 章 源码实现分析

### 2.1 整体架构

```
MiroThinker/
├── orchestrator.py       # 中心调度器：角色切换、工具路由、流程控制
├── agent_manager.py      # Agent 角色管理：角色定义、prompt 模板
├── tools/
│   ├── web_search.py     # 搜索工具
│   ├── code_executor.py  # 代码执行工具
│   └── file_reader.py    # 文件读取工具
└── config.py             # 角色配置、工具映射
```

### 2.2 角色定义与切换

```python
# 源码简化自 MiroThinker agent_manager.py
ROLE_DEFINITIONS = {
    "researcher": {
        "system_prompt": """你是一个专业的研究助手。
你的任务是搜索和分析信息，提供准确、全面的研究报告。
使用搜索工具获取最新信息，交叉验证多个来源。""",
        "tools": ["web_search", "url_scraper"],
        "temperature": 0.3,
    },
    "coder": {
        "system_prompt": """你是一个高级软件工程师。
你的任务是编写、分析和优化代码。
使用代码执行工具验证你的方案。""",
        "tools": ["code_executor", "file_reader"],
        "temperature": 0.0,
    },
    "writer": {
        "system_prompt": """你是一个专业的技术写作者。
你的任务是将研究数据和技术内容组织成清晰、结构化的文档。""",
        "tools": [],
        "temperature": 0.7,
    },
    "planner": {
        "system_prompt": """你是一个任务规划专家。
分析用户需求，将复杂任务拆解为可执行的步骤序列。
返回 JSON 格式的执行计划。""",
        "tools": [],
        "temperature": 0.5,
    },
}
```

### 2.3 Orchestrator 核心逻辑

```python
# 源码简化自 MiroThinker orchestrator.py
class Orchestrator:
    """单中心调度器：管理角色切换和工具调用"""

    def __init__(self, llm_client, tool_registry: dict):
        self.llm = llm_client
        self.tool_registry = tool_registry
        self.current_role: str | None = None
        self.conversation_history: list[dict] = []

    async def execute(self, query: str) -> str:
        """执行完整的任务流程"""
        # Step 1: 规划 — 用 planner 角色分析任务
        plan = await self._run_step("planner", f"分析并规划: {query}")

        # Step 2: 按计划执行每个步骤
        steps = self._parse_plan(plan)
        results = []
        for step in steps:
            role = step.get("role", "researcher")
            result = await self._run_step(role, step["instruction"])
            results.append(result)

        # Step 3: 汇总 — 用 writer 角色生成最终输出
        context = "\n\n".join(f"Step {i+1}: {r}" for i, r in enumerate(results))
        final = await self._run_step("writer", f"基于以下结果生成报告:\n{context}")
        return final

    async def _run_step(self, role: str, instruction: str) -> str:
        """执行单个步骤：切换角色 → 绑定工具 → 调用 LLM"""
        role_def = ROLE_DEFINITIONS[role]
        self.current_role = role

        # 构建消息
        messages = [
            {"role": "system", "content": role_def["system_prompt"]},
            *self.conversation_history[-10:],  # 保留最近 10 条上下文
            {"role": "user", "content": instruction},
        ]

        # 绑定工具
        tools = [self.tool_registry[t] for t in role_def["tools"]
                 if t in self.tool_registry]

        # 调用 LLM（带工具）
        response = await self.llm.chat(
            messages=messages,
            tools=tools if tools else None,
            temperature=role_def["temperature"],
        )

        # 处理工具调用
        while response.tool_calls:
            for tc in response.tool_calls:
                tool_result = await self._execute_tool(tc)
                messages.append({"role": "tool", "content": tool_result, "tool_call_id": tc.id})
            response = await self.llm.chat(messages=messages, tools=tools)

        # 记录历史
        self.conversation_history.append({"role": "assistant", "content": response.content})
        return response.content

    async def _execute_tool(self, tool_call) -> str:
        """执行工具调用"""
        tool = self.tool_registry.get(tool_call.function.name)
        if not tool:
            return f"工具 {tool_call.function.name} 不可用"
        args = json.loads(tool_call.function.arguments)
        return await tool.execute(**args)

    def _parse_plan(self, plan_text: str) -> list[dict]:
        """解析 LLM 生成的执行计划"""
        try:
            return json.loads(plan_text)
        except json.JSONDecodeError:
            return [{"role": "researcher", "instruction": plan_text}]
```

### 2.4 关键设计决策

| 决策 | MiroThinker 的选择 | 理由 |
|------|-------------------|------|
| 角色实现 | System prompt 切换 | 最简单，无需多实例 |
| 工具隔离 | 按角色绑定工具子集 | 避免 LLM 调用不相关工具 |
| 上下文传递 | 共享 conversation_history | 角色间自然共享上下文 |
| 执行模式 | 顺序执行 | 可预测，易调试 |
| 计划生成 | LLM 动态生成 | 灵活适应不同查询 |

---

## 第 3 章 可复用方案设计

> 从 MiroThinker 模式提炼的通用单中心调度方案。

### 3.1 通用架构图

```
用户查询
  │
  ▼
┌──────────────────────────────────────┐
│         SingleOrchestrator           │
│                                      │
│  ┌──────────┐  ┌──────────────────┐  │
│  │ RoleManager│  │ ToolRouter      │  │
│  │ 角色定义   │  │ 工具绑定/路由   │  │
│  └──────────┘  └──────────────────┘  │
│         │              │             │
│  ┌──────▼──────────────▼──────────┐  │
│  │      StepExecutor              │  │
│  │  system_prompt + tools → LLM   │  │
│  └────────────────────────────────┘  │
│                                      │
│  ┌────────────────────────────────┐  │
│  │    ConversationMemory          │  │
│  │    跨角色共享上下文             │  │
│  └────────────────────────────────┘  │
└──────────────────────────────────────┘
```

### 3.2 核心实现

```python
"""single_orchestrator.py — 单中心调度器"""
from __future__ import annotations

import json
import logging
import time
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any, Callable

logger = logging.getLogger(__name__)


@dataclass
class RoleDefinition:
    """角色定义"""
    name: str
    system_prompt: str
    tools: list[str] = field(default_factory=list)
    temperature: float = 0.7
    max_tokens: int = 4096


@dataclass
class StepResult:
    """步骤执行结果"""
    role: str
    instruction: str
    output: str
    tool_calls: list[str] = field(default_factory=list)
    duration_ms: float = 0.0


class Tool(ABC):
    """工具基类"""

    @property
    @abstractmethod
    def name(self) -> str: ...

    @property
    @abstractmethod
    def description(self) -> str: ...

    @abstractmethod
    async def execute(self, **kwargs) -> str: ...


class SingleOrchestrator:
    """单中心调度器 — 通过角色切换实现多 Agent 效果"""

    def __init__(
        self,
        roles: dict[str, RoleDefinition],
        tools: dict[str, Tool],
        llm_client,
        max_history: int = 20,
    ):
        self.roles = roles
        self.tools = tools
        self.llm = llm_client
        self.max_history = max_history
        self.history: list[dict] = []
        self.step_results: list[StepResult] = []

    async def run(self, query: str, plan_role: str = "planner",
                  report_role: str = "writer") -> dict:
        """
        完整执行流程：规划 → 逐步执行 → 汇总。

        Returns:
            {"query": str, "plan": list, "steps": list[StepResult],
             "report": str, "total_ms": float}
        """
        start = time.monotonic()

        # 1. 规划
        plan_text = await self.execute_step(
            plan_role,
            f"将以下任务拆解为执行步骤，返回 JSON 数组 "
            f'[{{"role": "...", "instruction": "..."}}]:\n{query}',
        )
        steps = self._parse_plan(plan_text.output)

        # 2. 逐步执行
        for step in steps:
            role = step.get("role", "researcher")
            if role not in self.roles:
                role = list(self.roles.keys())[0]
            await self.execute_step(role, step["instruction"])

        # 3. 汇总
        context = "\n\n".join(
            f"[{r.role}] {r.output[:500]}" for r in self.step_results
        )
        report_result = await self.execute_step(
            report_role,
            f"基于以下执行结果生成最终报告:\n{context}",
        )

        total_ms = (time.monotonic() - start) * 1000
        return {
            "query": query,
            "plan": steps,
            "steps": self.step_results,
            "report": report_result.output,
            "total_ms": total_ms,
        }

    async def execute_step(self, role: str, instruction: str) -> StepResult:
        """执行单个步骤"""
        role_def = self.roles[role]
        start = time.monotonic()

        messages = [
            {"role": "system", "content": role_def.system_prompt},
            *self.history[-self.max_history:],
            {"role": "user", "content": instruction},
        ]

        # 绑定角色对应的工具
        role_tools = [self.tools[t] for t in role_def.tools if t in self.tools]
        tool_calls_made = []

        response = await self.llm.chat(
            messages=messages,
            tools=role_tools or None,
            temperature=role_def.temperature,
            max_tokens=role_def.max_tokens,
        )

        # 工具调用循环
        while hasattr(response, "tool_calls") and response.tool_calls:
            for tc in response.tool_calls:
                tool = self.tools.get(tc.function.name)
                if tool:
                    args = json.loads(tc.function.arguments)
                    result = await tool.execute(**args)
                    tool_calls_made.append(tc.function.name)
                    messages.append({
                        "role": "tool",
                        "content": result,
                        "tool_call_id": tc.id,
                    })
            response = await self.llm.chat(messages=messages, tools=role_tools)

        output = response.content if hasattr(response, "content") else str(response)
        self.history.append({"role": "user", "content": instruction})
        self.history.append({"role": "assistant", "content": output})

        duration = (time.monotonic() - start) * 1000
        result = StepResult(
            role=role, instruction=instruction, output=output,
            tool_calls=tool_calls_made, duration_ms=duration,
        )
        self.step_results.append(result)
        logger.info(f"Step [{role}]: {duration:.0f}ms, tools={tool_calls_made}")
        return result

    def _parse_plan(self, text: str) -> list[dict]:
        """解析执行计划"""
        try:
            import re
            match = re.search(r'\[[\s\S]*\]', text)
            if match:
                return json.loads(match.group())
            return json.loads(text)
        except (json.JSONDecodeError, AttributeError):
            return [{"role": "researcher", "instruction": text}]

    def reset(self):
        """重置会话状态"""
        self.history.clear()
        self.step_results.clear()
```

### 3.3 预置角色模板

```python
"""roles.py — 预置角色定义"""

DEFAULT_ROLES = {
    "planner": RoleDefinition(
        name="planner",
        system_prompt="""你是任务规划专家。分析用户需求，拆解为可执行步骤。
返回 JSON 数组: [{"role": "角色名", "instruction": "具体指令"}]
可用角色: researcher, coder, writer, analyst""",
        tools=[],
        temperature=0.5,
    ),
    "researcher": RoleDefinition(
        name="researcher",
        system_prompt="你是研究助手。搜索和分析信息，提供准确的研究数据。",
        tools=["web_search"],
        temperature=0.3,
    ),
    "coder": RoleDefinition(
        name="coder",
        system_prompt="你是高级工程师。编写、分析和优化代码。",
        tools=["code_executor", "file_reader"],
        temperature=0.0,
    ),
    "writer": RoleDefinition(
        name="writer",
        system_prompt="你是技术写作者。将数据组织成清晰的结构化文档。",
        tools=[],
        temperature=0.7,
    ),
    "analyst": RoleDefinition(
        name="analyst",
        system_prompt="你是数据分析师。分析数据，发现模式和趋势。",
        tools=["code_executor"],
        temperature=0.2,
    ),
}
```

### 3.4 配置参数

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `max_history` | 20 | 保留的历史消息数 |
| `plan_role` | "planner" | 规划步骤使用的角色 |
| `report_role` | "writer" | 汇总步骤使用的角色 |
| `temperature` | 按角色 | 每个角色独立配置 |
| `max_tokens` | 4096 | 每步最大输出 token |

---

## 第 4 章 测试用例

```python
"""test_single_orchestrator.py — 单中心调度器测试"""
import json
import pytest
from unittest.mock import AsyncMock, MagicMock


# === Mock 对象 ===

class MockTool(Tool):
    def __init__(self, tool_name: str, result: str = "tool result"):
        self._name = tool_name
        self._result = result
        self.call_count = 0

    @property
    def name(self) -> str:
        return self._name

    @property
    def description(self) -> str:
        return f"Mock tool: {self._name}"

    async def execute(self, **kwargs) -> str:
        self.call_count += 1
        return self._result


def make_llm_response(content: str, tool_calls=None):
    resp = MagicMock()
    resp.content = content
    resp.tool_calls = tool_calls or []
    return resp


def make_roles():
    return {
        "planner": RoleDefinition(
            name="planner",
            system_prompt="Plan tasks",
            tools=[],
            temperature=0.5,
        ),
        "researcher": RoleDefinition(
            name="researcher",
            system_prompt="Research",
            tools=["web_search"],
            temperature=0.3,
        ),
        "writer": RoleDefinition(
            name="writer",
            system_prompt="Write",
            tools=[],
            temperature=0.7,
        ),
    }


# === 角色切换测试 ===

class TestRoleSwitching:

    @pytest.mark.asyncio
    async def test_step_uses_correct_role_prompt(self):
        """每步应使用对应角色的 system prompt"""
        llm = AsyncMock()
        llm.chat.return_value = make_llm_response("result")
        roles = make_roles()
        orch = SingleOrchestrator(roles=roles, tools={}, llm_client=llm)

        await orch.execute_step("researcher", "搜索信息")

        call_args = llm.chat.call_args
        messages = call_args.kwargs.get("messages", call_args[1].get("messages", []))
        system_msg = messages[0]
        assert system_msg["role"] == "system"
        assert system_msg["content"] == "Research"

    @pytest.mark.asyncio
    async def test_step_uses_correct_temperature(self):
        """每步应使用对应角色的 temperature"""
        llm = AsyncMock()
        llm.chat.return_value = make_llm_response("result")
        roles = make_roles()
        orch = SingleOrchestrator(roles=roles, tools={}, llm_client=llm)

        await orch.execute_step("writer", "写报告")

        call_args = llm.chat.call_args
        assert call_args.kwargs.get("temperature", call_args[1].get("temperature")) == 0.7


# === 工具路由测试 ===

class TestToolRouting:

    @pytest.mark.asyncio
    async def test_role_gets_correct_tools(self):
        """角色应只获得其定义的工具"""
        llm = AsyncMock()
        llm.chat.return_value = make_llm_response("result")
        roles = make_roles()
        search_tool = MockTool("web_search")
        code_tool = MockTool("code_executor")
        tools = {"web_search": search_tool, "code_executor": code_tool}
        orch = SingleOrchestrator(roles=roles, tools=tools, llm_client=llm)

        await orch.execute_step("researcher", "搜索")

        call_args = llm.chat.call_args
        passed_tools = call_args.kwargs.get("tools", call_args[1].get("tools"))
        assert len(passed_tools) == 1
        assert passed_tools[0].name == "web_search"

    @pytest.mark.asyncio
    async def test_role_without_tools_passes_none(self):
        """无工具的角色应传 None"""
        llm = AsyncMock()
        llm.chat.return_value = make_llm_response("result")
        roles = make_roles()
        orch = SingleOrchestrator(roles=roles, tools={}, llm_client=llm)

        await orch.execute_step("writer", "写报告")

        call_args = llm.chat.call_args
        passed_tools = call_args.kwargs.get("tools", call_args[1].get("tools"))
        assert passed_tools is None


# === 计划解析测试 ===

class TestPlanParsing:

    def test_valid_json_plan(self):
        roles = make_roles()
        orch = SingleOrchestrator(roles=roles, tools={}, llm_client=AsyncMock())
        plan = '[{"role": "researcher", "instruction": "搜索"}]'
        result = orch._parse_plan(plan)
        assert len(result) == 1
        assert result[0]["role"] == "researcher"

    def test_json_in_markdown(self):
        roles = make_roles()
        orch = SingleOrchestrator(roles=roles, tools={}, llm_client=AsyncMock())
        plan = '这是计划:\n[{"role": "writer", "instruction": "写"}]\n以上。'
        result = orch._parse_plan(plan)
        assert len(result) == 1

    def test_invalid_json_fallback(self):
        roles = make_roles()
        orch = SingleOrchestrator(roles=roles, tools={}, llm_client=AsyncMock())
        plan = "这不是 JSON"
        result = orch._parse_plan(plan)
        assert len(result) == 1
        assert result[0]["role"] == "researcher"


# === 历史管理测试 ===

class TestHistoryManagement:

    @pytest.mark.asyncio
    async def test_history_accumulates(self):
        """执行步骤后历史应增长"""
        llm = AsyncMock()
        llm.chat.return_value = make_llm_response("result")
        roles = make_roles()
        orch = SingleOrchestrator(roles=roles, tools={}, llm_client=llm)

        await orch.execute_step("writer", "step 1")
        await orch.execute_step("writer", "step 2")

        assert len(orch.history) == 4  # 2 user + 2 assistant

    @pytest.mark.asyncio
    async def test_history_limit(self):
        """历史消息应被截断到 max_history"""
        llm = AsyncMock()
        llm.chat.return_value = make_llm_response("result")
        roles = make_roles()
        orch = SingleOrchestrator(roles=roles, tools={}, llm_client=llm, max_history=2)

        for i in range(5):
            await orch.execute_step("writer", f"step {i}")

        # 虽然 history 有 10 条，但传给 LLM 的只有最近 2 条
        call_args = llm.chat.call_args
        messages = call_args.kwargs.get("messages", call_args[1].get("messages", []))
        # system(1) + history(2) + user(1) = 4
        assert len(messages) <= 4

    def test_reset_clears_state(self):
        roles = make_roles()
        orch = SingleOrchestrator(roles=roles, tools={}, llm_client=AsyncMock())
        orch.history = [{"role": "user", "content": "test"}]
        orch.step_results = [StepResult(role="r", instruction="i", output="o")]
        orch.reset()
        assert len(orch.history) == 0
        assert len(orch.step_results) == 0
```

---

## 第 5 章 跨域关联

| 关联域 | 关系 | 说明 |
|--------|------|------|
| PD-01 上下文管理 | 核心 | 共享 history 需要上下文裁剪，避免超出 token 限制 |
| PD-02.01 DAG 编排 | 替代 | 简单场景用 Orchestrator，复杂场景升级到 DAG |
| PD-02.02 Master-Worker | 替代 | 不需要并行时用 Orchestrator，需要并行时用 Master-Worker |
| PD-03 容错与重试 | 互补 | 单步失败时的重试和角色降级 |
| PD-04 工具系统 | 集成 | 工具注册和路由是 Orchestrator 的核心能力 |
| PD-12 推理增强 | 扩展 | planner 角色可结合 CoT 提升规划质量 |

---

## 第 6 章 来源文件索引

| 编号 | 文件 | 说明 |
|------|------|------|
| S1 | `orchestrator.py` | 中心调度器：角色切换、工具路由、流程控制 |
| S2 | `agent_manager.py` | Agent 角色管理：角色定义、prompt 模板 |
| S3 | `tools/` | 工具目录：搜索、代码执行、文件读取 |
| S4 | `config.py` | 角色配置、工具映射 |
