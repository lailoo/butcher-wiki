# PD-04.02 MiroThinker — OpenAI Function Calling 原生集成

> 文档编号：PD-04.02
> 来源：MiroThinker `openai_client.py` / `tools/`
> GitHub：https://github.com/MiroMindAI/MiroThinker
> 问题域：PD-04 工具系统 Tool System Design
> 状态：可复用方案

---

## 第 1 章 问题与动机

### 1.1 核心问题

LLM Agent 需要调用外部工具（搜索、代码执行、文件操作等）来完成任务。工具系统的设计面临几个关键挑战：

- **工具定义**：如何让 LLM 知道有哪些工具可用、每个工具的参数格式？
- **调用解析**：如何从 LLM 的输出中提取工具调用意图和参数？
- **结果回传**：工具执行结果如何以正确格式返回给 LLM 继续推理？
- **多轮循环**：Agent 可能需要连续调用多个工具，如何管理调用-结果-推理的循环？

常见的错误做法：

```
方案 A: 在 system prompt 中用自然语言描述工具，让 LLM 输出特定格式的文本
  → 解析不稳定，LLM 经常输出格式错误的调用
  → 需要大量 prompt engineering 和正则解析

方案 B: 引入 LangChain / CrewAI 等框架
  → 框架抽象层厚，调试困难
  → 版本升级频繁导致 breaking changes
  → 对 OpenAI 原生特性的支持滞后
```

### 1.2 MiroThinker 的解法概述

直接使用 OpenAI Function Calling API（`tools` 参数），零框架依赖：

1. **JSON Schema 定义工具**：每个工具用标准 JSON Schema 描述名称、描述、参数
2. **API 原生解析**：OpenAI 返回结构化的 `tool_calls` 字段，无需正则解析
3. **tool message 回传**：工具结果以 `role: "tool"` 消息格式回传，带 `tool_call_id` 关联
4. **字典分发**：`name → function` 映射表实现工具路由，简单直接

### 1.3 设计思想

| 原则 | 说明 |
|------|------|
| 原生优于框架 | 直接用 OpenAI SDK 的 `tools` 参数，不引入中间抽象层 |
| Schema 即文档 | JSON Schema 既是 LLM 的工具说明，也是参数校验规则 |
| 结构化优于文本 | API 返回结构化 `tool_calls`，不需要从文本中解析调用意图 |
| 显式分发 | 字典映射 `{name: func}` 比 if/elif 链更清晰、更易扩展 |
| 最小依赖 | 只依赖 `openai` SDK，不引入 LangChain / pydantic-ai 等框架 |

### 1.4 与框架方案的对比

| 维度 | 原生 Function Calling | LangChain Tools | CrewAI Tools |
|------|----------------------|-----------------|--------------|
| 依赖 | `openai` SDK | `langchain` + `langchain-openai` + ... | `crewai` + `langchain` + ... |
| 工具定义 | JSON Schema dict | `@tool` 装饰器 / `BaseTool` 子类 | `BaseTool` 子类 |
| 调用解析 | API 原生返回 `tool_calls` | 框架内部处理 | 框架内部处理 |
| 结果回传 | `role: "tool"` message | 框架自动处理 | 框架自动处理 |
| 调试难度 | 低（直接看 API 请求/响应） | 高（多层抽象） | 高（多层抽象） |
| 灵活性 | 完全控制 | 受框架约束 | 受框架约束 |
| 学习成本 | 低（只需了解 OpenAI API） | 高（框架概念多） | 中 |
| 适合场景 | 工具数 < 20 的 Agent | 复杂编排 + 多 provider | 多 Agent 协作 |

---

## 第 2 章 源码实现分析

### 2.1 工具定义：JSON Schema

**源文件**: `tools/__init__.py` / `openai_client.py`

MiroThinker 用标准 JSON Schema 定义每个工具，作为 `tools` 参数传给 OpenAI API：

```python
# tools/definitions.py — 工具定义

TOOL_DEFINITIONS = [
    {
        "type": "function",
        "function": {
            "name": "web_search",
            "description": "Search the web for current information on a topic. "
                           "Use this when you need up-to-date facts, news, or data.",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "The search query string"
                    },
                    "num_results": {
                        "type": "integer",
                        "description": "Number of results to return (default: 5)",
                        "default": 5
                    }
                },
                "required": ["query"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "read_file",
            "description": "Read the contents of a file at the given path.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "Absolute or relative file path"
                    },
                    "encoding": {
                        "type": "string",
                        "description": "File encoding (default: utf-8)",
                        "default": "utf-8"
                    }
                },
                "required": ["path"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "execute_code",
            "description": "Execute Python code in a sandboxed environment and return the output.",
            "parameters": {
                "type": "object",
                "properties": {
                    "code": {
                        "type": "string",
                        "description": "Python code to execute"
                    },
                    "timeout": {
                        "type": "integer",
                        "description": "Execution timeout in seconds (default: 30)",
                        "default": 30
                    }
                },
                "required": ["code"]
            }
        }
    }
]
```

**关键设计决策**：

| 决策 | 选择 | 理由 |
|------|------|------|
| 定义格式 | 原生 dict（非 Pydantic model） | 与 OpenAI API 直接兼容，无需序列化转换 |
| description 写法 | 动作导向 + 使用场景 | LLM 根据 description 决定何时调用，场景描述提高准确率 |
| parameters.required | 显式列出必填参数 | 避免 LLM 遗漏关键参数 |
| default 值 | 在 schema 中声明 | LLM 可以看到默认值，减少不必要的参数传递 |

### 2.2 Function Calling API 调用

**源文件**: `openai_client.py` — `chat_completion()` 方法

将工具定义通过 `tools` 参数传给 API，可选 `tool_choice` 控制调用策略：

```python
# openai_client.py — 核心调用逻辑

class OpenAIClient:
    def __init__(self, api_key: str, model: str = "gpt-4o"):
        self.client = openai.OpenAI(api_key=api_key)
        self.model = model

    def chat_completion(
        self,
        messages: list[dict],
        tools: list[dict] | None = None,
        tool_choice: str | dict = "auto",
        **kwargs,
    ) -> openai.types.chat.ChatCompletion:
        """调用 OpenAI Chat Completion API，支持 function calling。

        Args:
            messages: 消息列表（OpenAI 格式）
            tools: 工具定义列表（JSON Schema）
            tool_choice: 工具调用策略
                - "auto": LLM 自行决定是否调用工具（默认）
                - "none": 禁止调用工具
                - "required": 强制调用至少一个工具
                - {"type": "function", "function": {"name": "xxx"}}: 强制调用指定工具
        """
        params = {
            "model": self.model,
            "messages": messages,
            **kwargs,
        }
        if tools:
            params["tools"] = tools
            params["tool_choice"] = tool_choice

        return self.client.chat.completions.create(**params)
```

**`tool_choice` 策略矩阵**：

| 值 | 行为 | 适用场景 |
|----|------|----------|
| `"auto"` | LLM 自行判断是否需要工具 | 通用 Agent，大多数场景 |
| `"none"` | 禁止调用工具，只生成文本 | 最终总结、纯对话回复 |
| `"required"` | 强制调用至少一个工具 | 第一步必须搜索的场景 |
| `{"type": "function", "function": {"name": "web_search"}}` | 强制调用指定工具 | 明确知道下一步该做什么 |

### 2.3 响应解析：提取 tool_calls

OpenAI 返回的 `ChatCompletion` 中，`message.tool_calls` 是结构化的工具调用列表：

```python
# 响应结构示例
response = client.chat_completion(messages, tools=TOOL_DEFINITIONS)
message = response.choices[0].message

# message.tool_calls 结构：
# [
#     ChatCompletionMessageToolCall(
#         id="call_abc123",           # 唯一 ID，用于关联结果
#         type="function",
#         function=Function(
#             name="web_search",      # 工具名称
#             arguments='{"query": "Python 3.12 new features", "num_results": 3}'
#         )
#     )
# ]

if message.tool_calls:
    for tool_call in message.tool_calls:
        func_name = tool_call.function.name          # str
        func_args = json.loads(tool_call.function.arguments)  # dict
        call_id = tool_call.id                        # str
        print(f"Tool: {func_name}, Args: {func_args}, ID: {call_id}")
```

**关键点**：
- `tool_call.function.arguments` 是 JSON 字符串，需要 `json.loads` 解析
- `tool_call.id` 是 OpenAI 生成的唯一标识，回传结果时必须携带
- 一次响应可能包含多个 `tool_calls`（parallel function calling）

### 2.4 工具分发：name → function 映射

**源文件**: `tools/dispatcher.py`

用字典实现工具名称到实际函数的映射，比 if/elif 链更清晰：

```python
# tools/dispatcher.py — 工具分发器

import json
import logging
from typing import Any, Callable

logger = logging.getLogger(__name__)


class ToolDispatcher:
    """工具分发器：将 LLM 的 tool_calls 路由到实际函数实现。"""

    def __init__(self):
        self._registry: dict[str, Callable[..., str]] = {}

    def register(self, name: str, func: Callable[..., str]) -> None:
        """注册工具函数。"""
        self._registry[name] = func
        logger.debug("Registered tool: %s", name)

    def dispatch(self, name: str, arguments: dict[str, Any]) -> str:
        """分发工具调用，返回结果字符串。

        Args:
            name: 工具名称（来自 tool_call.function.name）
            arguments: 参数字典（来自 json.loads(tool_call.function.arguments)）

        Returns:
            工具执行结果的字符串表示。

        Raises:
            KeyError: 工具未注册。
        """
        if name not in self._registry:
            raise KeyError(f"Unknown tool: {name}. Available: {list(self._registry.keys())}")

        func = self._registry[name]
        try:
            result = func(**arguments)
            logger.info("Tool %s executed successfully", name)
            return str(result)
        except Exception as e:
            error_msg = f"Tool {name} failed: {type(e).__name__}: {e}"
            logger.error(error_msg)
            return error_msg  # 返回错误信息而非抛异常，让 LLM 决定如何处理

    @property
    def available_tools(self) -> list[str]:
        """返回已注册的工具名称列表。"""
        return list(self._registry.keys())


# 使用示例
dispatcher = ToolDispatcher()
dispatcher.register("web_search", web_search_impl)
dispatcher.register("read_file", read_file_impl)
dispatcher.register("execute_code", execute_code_impl)
```

**设计要点**：
- 工具执行失败时返回错误字符串而非抛异常 → LLM 可以看到错误并决定重试或换策略
- `available_tools` 属性方便运行时检查已注册工具
- 注册与分发分离，支持动态添加/移除工具

### 2.5 结果回传：tool message 格式

工具执行结果必须以 `role: "tool"` 消息格式回传，并携带 `tool_call_id`：

```python
# 工具结果回传格式

def build_tool_result_message(tool_call_id: str, content: str) -> dict:
    """构建工具结果消息。

    Args:
        tool_call_id: 来自 tool_call.id 的唯一标识
        content: 工具执行结果的字符串

    Returns:
        OpenAI 格式的 tool message dict
    """
    return {
        "role": "tool",
        "tool_call_id": tool_call_id,
        "content": content,
    }


# 完整的工具调用-结果回传流程
def process_tool_calls(message, dispatcher: ToolDispatcher) -> list[dict]:
    """处理一次响应中的所有工具调用，返回结果消息列表。"""
    results = []
    for tool_call in message.tool_calls:
        func_name = tool_call.function.name
        func_args = json.loads(tool_call.function.arguments)
        call_id = tool_call.id

        # 执行工具
        output = dispatcher.dispatch(func_name, func_args)

        # 构建结果消息
        results.append(build_tool_result_message(call_id, output))

    return results
```

**关键约束**：
- `tool_call_id` 必须与请求中的 `tool_call.id` 一一对应，否则 API 报错
- `content` 必须是字符串，非字符串需要 `json.dumps` 序列化
- 多个工具调用的结果按顺序追加到 messages 列表

### 2.6 完整 Agent 循环

将以上组件组合成完整的 Agent 工具调用循环：

```python
# orchestrator.py — Agent 主循环

class AgentOrchestrator:
    """Agent 编排器：管理 LLM 调用 + 工具执行的循环。"""

    def __init__(
        self,
        client: OpenAIClient,
        dispatcher: ToolDispatcher,
        tools: list[dict],
        max_steps: int = 20,
    ):
        self.client = client
        self.dispatcher = dispatcher
        self.tools = tools
        self.max_steps = max_steps

    def run(self, system_prompt: str, user_message: str) -> str:
        """执行 Agent 任务，返回最终文本响应。"""
        messages = [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_message},
        ]

        for step in range(self.max_steps):
            # 1. 调用 LLM
            response = self.client.chat_completion(
                messages=messages,
                tools=self.tools,
                tool_choice="auto",
            )
            assistant_msg = response.choices[0].message

            # 2. 将 assistant 消息追加到历史
            messages.append(assistant_msg.model_dump())

            # 3. 检查是否有工具调用
            if not assistant_msg.tool_calls:
                # 没有工具调用 → Agent 完成，返回文本
                return assistant_msg.content

            # 4. 执行所有工具调用并回传结果
            for tool_call in assistant_msg.tool_calls:
                func_name = tool_call.function.name
                func_args = json.loads(tool_call.function.arguments)

                result = self.dispatcher.dispatch(func_name, func_args)

                messages.append({
                    "role": "tool",
                    "tool_call_id": tool_call.id,
                    "content": result,
                })

            logger.info("Step %d: executed %d tool(s)", step, len(assistant_msg.tool_calls))

        return "Agent reached maximum steps without completing."
```

**调用链路图**：

```
用户请求
  │
  ▼
orchestrator.run()
  │
  ├─ 构建 messages [system, user]
  │
  ├─ Loop (max_steps):
  │   │
  │   ├─ 1. client.chat_completion(messages, tools)
  │   │     → OpenAI API 返回 ChatCompletion
  │   │
  │   ├─ 2. 检查 message.tool_calls
  │   │     ├─ 无 → 返回 message.content（完成）
  │   │     └─ 有 → 继续
  │   │
  │   ├─ 3. 追加 assistant message 到 messages
  │   │
  │   ├─ 4. 遍历 tool_calls:
  │   │     ├─ json.loads(arguments) → 解析参数
  │   │     ├─ dispatcher.dispatch(name, args) → 执行工具
  │   │     └─ 追加 tool message 到 messages
  │   │
  │   └─ 回到 Loop 顶部
  │
  └─ 超过 max_steps → 返回超时提示
```

---

## 第 3 章 迁移指南

### 3.1 迁移检查清单

从框架方案（LangChain / CrewAI）迁移到原生 Function Calling 的步骤：

```
[ ] 1. 梳理现有工具列表，提取每个工具的 name / description / parameters
[ ] 2. 将工具定义转换为 OpenAI JSON Schema 格式（TOOL_DEFINITIONS）
[ ] 3. 实现 ToolDispatcher，注册所有工具函数
[ ] 4. 替换框架的 LLM 调用为 openai.chat.completions.create(tools=...)
[ ] 5. 实现 tool message 回传逻辑（role: "tool" + tool_call_id）
[ ] 6. 实现 Agent 主循环（调用 → 解析 → 分发 → 回传 → 循环）
[ ] 7. 处理 parallel function calling（一次响应多个 tool_calls）
[ ] 8. 添加错误处理：工具执行失败时返回错误信息给 LLM
[ ] 9. 运行测试套件确认所有工具正常工作
[ ] 10. 移除框架依赖（langchain / crewai）
```

### 3.2 从 LangChain @tool 迁移

LangChain 的 `@tool` 装饰器迁移到原生 JSON Schema：

```python
# === 迁移前：LangChain @tool ===
from langchain_core.tools import tool

@tool
def web_search(query: str, num_results: int = 5) -> str:
    """Search the web for current information on a topic."""
    return search_engine.search(query, num_results)

# LangChain 自动从函数签名 + docstring 生成 schema
# 但你无法精确控制 description 和 parameter 描述


# === 迁移后：原生 JSON Schema ===
TOOL_WEB_SEARCH = {
    "type": "function",
    "function": {
        "name": "web_search",
        "description": "Search the web for current information on a topic. "
                       "Use this when you need up-to-date facts, news, or data.",
        "parameters": {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "The search query string"
                },
                "num_results": {
                    "type": "integer",
                    "description": "Number of results to return",
                    "default": 5
                }
            },
            "required": ["query"]
        }
    }
}

def web_search_impl(query: str, num_results: int = 5) -> str:
    """工具实现函数，与 schema 分离。"""
    return search_engine.search(query, num_results)

# 注册到分发器
dispatcher.register("web_search", web_search_impl)
```

### 3.3 适配代码模板：ToolRegistry

将工具定义和实现统一管理的注册表模式：

```python
"""
tool_registry.py — 工具注册表

统一管理工具的 JSON Schema 定义和实现函数。
支持动态注册、按名称查找、批量导出。
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field
from typing import Any, Callable

logger = logging.getLogger(__name__)


@dataclass
class ToolEntry:
    """工具注册条目。"""
    name: str
    description: str
    parameters: dict[str, Any]
    func: Callable[..., str]

    def to_openai_schema(self) -> dict:
        """导出为 OpenAI tools 参数格式。"""
        return {
            "type": "function",
            "function": {
                "name": self.name,
                "description": self.description,
                "parameters": self.parameters,
            }
        }


class ToolRegistry:
    """工具注册表：统一管理定义 + 实现。

    用法:
        registry = ToolRegistry()
        registry.register(
            name="web_search",
            description="Search the web...",
            parameters={...},
            func=web_search_impl,
        )

        # 导出给 OpenAI API
        tools = registry.export_schemas()

        # 分发调用
        result = registry.dispatch("web_search", {"query": "test"})
    """

    def __init__(self):
        self._entries: dict[str, ToolEntry] = {}

    def register(
        self,
        name: str,
        description: str,
        parameters: dict[str, Any],
        func: Callable[..., str],
    ) -> None:
        """注册一个工具。"""
        self._entries[name] = ToolEntry(
            name=name,
            description=description,
            parameters=parameters,
            func=func,
        )

    def export_schemas(self) -> list[dict]:
        """导出所有工具的 OpenAI JSON Schema 定义。"""
        return [entry.to_openai_schema() for entry in self._entries.values()]

    def dispatch(self, name: str, arguments: dict[str, Any]) -> str:
        """分发工具调用。"""
        if name not in self._entries:
            available = list(self._entries.keys())
            raise KeyError(f"Unknown tool: {name}. Available: {available}")

        entry = self._entries[name]
        try:
            result = entry.func(**arguments)
            return str(result) if not isinstance(result, str) else result
        except Exception as e:
            error_msg = f"Tool '{name}' execution failed: {type(e).__name__}: {e}"
            logger.error(error_msg)
            return error_msg

    def get(self, name: str) -> ToolEntry | None:
        """按名称获取工具条目。"""
        return self._entries.get(name)

    @property
    def names(self) -> list[str]:
        """已注册的工具名称列表。"""
        return list(self._entries.keys())

    def __len__(self) -> int:
        return len(self._entries)
```

### 3.4 场景矩阵

| 场景 | tool_choice | 工具数 | 说明 |
|------|-------------|--------|------|
| 通用 Agent 对话 | `"auto"` | 3-10 | LLM 自行决定是否调用工具 |
| 强制首步搜索 | `"required"` | 1-3 | 确保 Agent 先获取信息再回答 |
| 纯文本总结 | `"none"` | 0 | 最后一步禁用工具，只生成文本 |
| 指定工具调用 | `{"type": "function", ...}` | 1 | 明确知道该调用哪个工具 |
| 并行工具调用 | `"auto"` | 5+ | LLM 可能一次返回多个 tool_calls |
| 工具密集型 Agent | `"auto"` | 10-20 | 需要配合 PD-01 上下文管理 |

---

## 第 4 章 测试用例

完整的 pytest 测试套件，覆盖工具定义、分发、Agent 循环三个层面：

```python
"""
test_tool_system.py — OpenAI Function Calling 工具系统测试套件

运行: pytest test_tool_system.py -v
依赖: pip install pytest openai
"""

import json
import pytest
from unittest.mock import MagicMock, patch, PropertyMock
from tool_registry import ToolRegistry, ToolEntry


# ─── TestToolRegistry: 工具注册与分发 ───

class TestToolRegistry:
    """工具注册表测试：注册、导出、分发。"""

    def setup_method(self):
        self.registry = ToolRegistry()
        self.registry.register(
            name="add",
            description="Add two numbers",
            parameters={
                "type": "object",
                "properties": {
                    "a": {"type": "number"},
                    "b": {"type": "number"},
                },
                "required": ["a", "b"],
            },
            func=lambda a, b: str(a + b),
        )
        self.registry.register(
            name="greet",
            description="Greet a person",
            parameters={
                "type": "object",
                "properties": {
                    "name": {"type": "string"},
                },
                "required": ["name"],
            },
            func=lambda name: f"Hello, {name}!",
        )

    def test_register_and_count(self):
        """注册后工具数量正确。"""
        assert len(self.registry) == 2
        assert "add" in self.registry.names
        assert "greet" in self.registry.names

    def test_export_schemas(self):
        """导出的 schema 符合 OpenAI tools 格式。"""
        schemas = self.registry.export_schemas()
        assert len(schemas) == 2
        for schema in schemas:
            assert schema["type"] == "function"
            assert "name" in schema["function"]
            assert "description" in schema["function"]
            assert "parameters" in schema["function"]

    def test_export_schema_structure(self):
        """单个 schema 的结构完整。"""
        schemas = self.registry.export_schemas()
        add_schema = next(s for s in schemas if s["function"]["name"] == "add")
        assert add_schema["function"]["description"] == "Add two numbers"
        assert "a" in add_schema["function"]["parameters"]["properties"]
        assert "b" in add_schema["function"]["parameters"]["properties"]
        assert add_schema["function"]["parameters"]["required"] == ["a", "b"]

    def test_dispatch_success(self):
        """正常分发返回正确结果。"""
        result = self.registry.dispatch("add", {"a": 3, "b": 5})
        assert result == "8"

    def test_dispatch_string_result(self):
        """字符串结果直接返回。"""
        result = self.registry.dispatch("greet", {"name": "Alice"})
        assert result == "Hello, Alice!"

    def test_dispatch_unknown_tool(self):
        """未注册的工具抛出 KeyError。"""
        with pytest.raises(KeyError, match="Unknown tool: unknown"):
            self.registry.dispatch("unknown", {})

    def test_dispatch_execution_error(self):
        """工具执行失败返回错误信息（不抛异常）。"""
        def failing_tool(**kwargs):
            raise ValueError("something went wrong")

        self.registry.register(
            name="fail",
            description="A tool that fails",
            parameters={"type": "object", "properties": {}},
            func=failing_tool,
        )
        result = self.registry.dispatch("fail", {})
        assert "execution failed" in result
        assert "ValueError" in result

    def test_get_existing_tool(self):
        """按名称获取已注册工具。"""
        entry = self.registry.get("add")
        assert entry is not None
        assert entry.name == "add"

    def test_get_nonexistent_tool(self):
        """获取不存在的工具返回 None。"""
        assert self.registry.get("nonexistent") is None


# ─── TestToolEntry: 工具条目 ───

class TestToolEntry:
    """工具条目测试：schema 导出。"""

    def test_to_openai_schema(self):
        """ToolEntry 导出为 OpenAI 格式。"""
        entry = ToolEntry(
            name="test_tool",
            description="A test tool",
            parameters={
                "type": "object",
                "properties": {
                    "input": {"type": "string"},
                },
                "required": ["input"],
            },
            func=lambda input: input,
        )
        schema = entry.to_openai_schema()
        assert schema == {
            "type": "function",
            "function": {
                "name": "test_tool",
                "description": "A test tool",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "input": {"type": "string"},
                    },
                    "required": ["input"],
                },
            },
        }

    def test_schema_no_required(self):
        """无必填参数的 schema。"""
        entry = ToolEntry(
            name="optional_tool",
            description="All params optional",
            parameters={
                "type": "object",
                "properties": {
                    "limit": {"type": "integer", "default": 10},
                },
            },
            func=lambda limit=10: str(limit),
        )
        schema = entry.to_openai_schema()
        assert "required" not in schema["function"]["parameters"]


# ─── TestAgentToolLoop: Agent 工具调用循环 ───

class TestAgentToolLoop:
    """Agent 工具调用循环的集成测试。

    模拟 OpenAI API 响应，验证完整的调用-分发-回传流程。
    """

    def setup_method(self):
        self.registry = ToolRegistry()
        self.registry.register(
            name="web_search",
            description="Search the web",
            parameters={
                "type": "object",
                "properties": {
                    "query": {"type": "string"},
                },
                "required": ["query"],
            },
            func=lambda query: f"Search results for: {query}",
        )

    def _make_tool_call_response(self, tool_calls: list[dict]):
        """构造模拟的 tool_calls 响应。"""
        mock_response = MagicMock()
        mock_message = MagicMock()
        mock_message.content = None

        mock_tool_calls = []
        for tc in tool_calls:
            mock_tc = MagicMock()
            mock_tc.id = tc["id"]
            mock_tc.type = "function"
            mock_tc.function.name = tc["name"]
            mock_tc.function.arguments = json.dumps(tc["arguments"])
            mock_tool_calls.append(mock_tc)

        mock_message.tool_calls = mock_tool_calls
        mock_message.model_dump.return_value = {
            "role": "assistant",
            "content": None,
            "tool_calls": [
                {
                    "id": tc["id"],
                    "type": "function",
                    "function": {
                        "name": tc["name"],
                        "arguments": json.dumps(tc["arguments"]),
                    },
                }
                for tc in tool_calls
            ],
        }
        mock_response.choices = [MagicMock(message=mock_message)]
        return mock_response

    def _make_text_response(self, content: str):
        """构造模拟的纯文本响应。"""
        mock_response = MagicMock()
        mock_message = MagicMock()
        mock_message.content = content
        mock_message.tool_calls = None
        mock_message.model_dump.return_value = {
            "role": "assistant",
            "content": content,
        }
        mock_response.choices = [MagicMock(message=mock_message)]
        return mock_response

    def test_single_tool_call_cycle(self):
        """单次工具调用：LLM 调用工具 → 执行 → 回传 → LLM 生成文本。"""
        messages = [
            {"role": "system", "content": "You are helpful."},
            {"role": "user", "content": "Search for Python news"},
        ]

        # 模拟第一次响应：LLM 请求调用 web_search
        tool_response = self._make_tool_call_response([
            {"id": "call_001", "name": "web_search", "arguments": {"query": "Python news"}}
        ])

        # 处理工具调用
        msg = tool_response.choices[0].message
        messages.append(msg.model_dump())

        for tc in msg.tool_calls:
            args = json.loads(tc.function.arguments)
            result = self.registry.dispatch(tc.function.name, args)
            messages.append({
                "role": "tool",
                "tool_call_id": tc.id,
                "content": result,
            })

        # 验证 messages 结构
        assert len(messages) == 4  # system + user + assistant + tool
        assert messages[-1]["role"] == "tool"
        assert messages[-1]["tool_call_id"] == "call_001"
        assert "Search results for: Python news" in messages[-1]["content"]

    def test_parallel_tool_calls(self):
        """并行工具调用：一次响应包含多个 tool_calls。"""
        self.registry.register(
            name="read_file",
            description="Read a file",
            parameters={
                "type": "object",
                "properties": {"path": {"type": "string"}},
                "required": ["path"],
            },
            func=lambda path: f"Contents of {path}",
        )

        # 模拟并行调用
        tool_response = self._make_tool_call_response([
            {"id": "call_001", "name": "web_search", "arguments": {"query": "test"}},
            {"id": "call_002", "name": "read_file", "arguments": {"path": "/tmp/data.txt"}},
        ])

        msg = tool_response.choices[0].message
        results = []
        for tc in msg.tool_calls:
            args = json.loads(tc.function.arguments)
            result = self.registry.dispatch(tc.function.name, args)
            results.append({
                "role": "tool",
                "tool_call_id": tc.id,
                "content": result,
            })

        assert len(results) == 2
        assert results[0]["tool_call_id"] == "call_001"
        assert results[1]["tool_call_id"] == "call_002"
        assert "Search results" in results[0]["content"]
        assert "Contents of" in results[1]["content"]

    def test_tool_error_returns_message(self):
        """工具执行失败时，错误信息作为 tool message 返回给 LLM。"""
        self.registry.register(
            name="broken_tool",
            description="A broken tool",
            parameters={"type": "object", "properties": {}},
            func=lambda: (_ for _ in ()).throw(RuntimeError("disk full")),
        )

        result = self.registry.dispatch("broken_tool", {})
        # 错误信息应该是字符串，可以作为 tool message content
        assert isinstance(result, str)
        assert "RuntimeError" in result
        assert "disk full" in result

    def test_tool_call_id_consistency(self):
        """tool_call_id 在请求和响应中保持一致。"""
        call_id = "call_unique_abc123"
        tool_response = self._make_tool_call_response([
            {"id": call_id, "name": "web_search", "arguments": {"query": "test"}}
        ])

        msg = tool_response.choices[0].message
        tc = msg.tool_calls[0]

        result_msg = {
            "role": "tool",
            "tool_call_id": tc.id,
            "content": self.registry.dispatch(tc.function.name, json.loads(tc.function.arguments)),
        }

        assert result_msg["tool_call_id"] == call_id
```

### 4.1 测试覆盖目标

| 模块 | 目标覆盖率 | 关键路径 |
|------|-----------|---------|
| ToolRegistry | 95%+ | 注册、导出 schema、分发、错误处理 |
| ToolEntry | 100% | schema 导出格式 |
| Agent 循环 | 90%+ | 单次调用、并行调用、错误回传、ID 一致性 |
| JSON Schema 定义 | 80%+ | 必填/可选参数、default 值 |

---

## 第 5 章 跨域关联

### 5.1 与其他问题域的关系

```
PD-04 工具系统
  │
  ├── → PD-01 上下文管理
  │     工具结果是上下文膨胀的主要来源。
  │     每次工具调用的结果（搜索结果、文件内容等）可能占 2-5K tokens。
  │     需要配合 PD-01 的滑动窗口和分级裁剪管理工具结果。
  │
  ├── → PD-03 容错与重试
  │     工具执行可能失败（网络超时、API 限流、文件不存在等）。
  │     工具分发器返回错误字符串而非抛异常，让 LLM 决定重试策略。
  │     可配合 PD-03 的指数退避对外部 API 工具做重试。
  │
  ├── → PD-02 多 Agent 编排
  │     不同 Agent 可能需要不同的工具集。
  │     ToolRegistry 支持按 Agent 角色注册不同工具子集。
  │     coordinator Agent 可能只需 "delegate" 工具，
  │     researcher Agent 需要 "web_search" + "read_file" 工具。
  │
  ├── → PD-05 沙箱隔离
  │     execute_code 工具必须在沙箱中运行。
  │     工具实现函数内部调用沙箱 API，对 ToolRegistry 透明。
  │
  └── → PD-11 可观测性
        工具调用是 Agent 行为的核心可观测数据。
        每次 dispatch 可记录：工具名、参数、耗时、结果长度、是否失败。
        配合 PD-11 的成本追踪，统计工具调用频率和成本。
```

### 5.2 与 LangChain 方案的互补

| 场景 | 推荐方案 | 理由 |
|------|----------|------|
| 工具数 < 15，单 provider | 本方案（原生 FC） | 简单直接，无框架开销 |
| 工具数 > 30，多 provider | LangChain Tools | 框架提供统一抽象 |
| 需要 MCP 协议集成 | 本方案 + MCP adapter | 原生 FC 更容易适配 MCP |
| 需要工具链（tool chaining） | LangChain LCEL | 框架原生支持 |
| 需要工具审批（human-in-loop） | 本方案 + PD-09 | 在 dispatch 前插入审批逻辑 |

### 5.3 推荐组合

```
最小可用: PD-04 原生 FC（本方案）
  ↓ 加入上下文管理
标准配置: PD-04 + PD-01（工具结果管理）
  ↓ 加入容错
生产配置: PD-04 + PD-01 + PD-03（工具调用重试）
  ↓ 加入可观测性
完整配置: PD-04 + PD-01 + PD-03 + PD-11（全链路追踪）
```

---

## 第 6 章 来源文件索引

| 编号 | 文件 | 说明 |
|------|------|------|
| S1 | `openai_client.py` | `chat_completion()` — Function Calling API 调用入口 |
| S2 | `openai_client.py` | `tools` 参数传递、`tool_choice` 策略控制 |
| S3 | `tools/__init__.py` | 工具定义列表（JSON Schema 格式） |
| S4 | `tools/web_search.py` | web_search 工具实现 |
| S5 | `tools/file_ops.py` | read_file / write_file 工具实现 |
| S6 | `tools/code_exec.py` | execute_code 工具实现（沙箱执行） |
| S7 | `orchestrator.py` | Agent 主循环：调用 → 解析 tool_calls → 分发 → 回传 |

---

## 附录 A 快速接入检查清单

```
[ ] 1. pip install openai（确保 >= 1.0.0，支持 tools 参数）
[ ] 2. 定义工具 JSON Schema（参考 2.1 节模板）
[ ] 3. 实现工具函数（每个函数接收 kwargs，返回 str）
[ ] 4. 创建 ToolRegistry 并注册所有工具
[ ] 5. 在 chat.completions.create() 中传入 tools=registry.export_schemas()
[ ] 6. 解析 response.choices[0].message.tool_calls
[ ] 7. 对每个 tool_call: dispatch → 构建 tool message → 追加到 messages
[ ] 8. 循环调用直到 tool_calls 为空（Agent 完成）
[ ] 9. 运行测试套件确认通过
[ ] 10. 配合 PD-01 管理工具结果的上下文占用
```

## 附录 B JSON Schema 常用模式速查

```python
# 字符串参数
{"type": "string", "description": "..."}

# 整数参数（带默认值）
{"type": "integer", "description": "...", "default": 10}

# 枚举参数
{"type": "string", "enum": ["asc", "desc"], "description": "Sort order"}

# 数组参数
{"type": "array", "items": {"type": "string"}, "description": "List of tags"}

# 嵌套对象
{
    "type": "object",
    "properties": {
        "name": {"type": "string"},
        "age": {"type": "integer"},
    },
    "required": ["name"],
}

# 可选参数（不在 required 中）
{
    "type": "object",
    "properties": {
        "query": {"type": "string"},           # 必填
        "limit": {"type": "integer", "default": 10},  # 可选
    },
    "required": ["query"],  # 只列 query
}
```

## 附录 C tool_choice 用法速查

```python
import openai

client = openai.OpenAI()

# 1. auto — LLM 自行决定（默认）
response = client.chat.completions.create(
    model="gpt-4o",
    messages=messages,
    tools=tools,
    tool_choice="auto",
)

# 2. none — 禁止工具调用
response = client.chat.completions.create(
    model="gpt-4o",
    messages=messages,
    tools=tools,
    tool_choice="none",
)

# 3. required — 强制调用至少一个工具
response = client.chat.completions.create(
    model="gpt-4o",
    messages=messages,
    tools=tools,
    tool_choice="required",
)

# 4. 强制调用指定工具
response = client.chat.completions.create(
    model="gpt-4o",
    messages=messages,
    tools=tools,
    tool_choice={
        "type": "function",
        "function": {"name": "web_search"},
    },
)
```
