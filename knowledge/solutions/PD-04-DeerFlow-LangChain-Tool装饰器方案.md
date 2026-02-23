# PD-04.01 DeerFlow — LangChain Tool 装饰器 + 动态绑定

> 文档编号：PD-04.01
> 来源：DeerFlow `src/tools/` / `src/graph/nodes.py`
> GitHub：https://github.com/bytedance/deer-flow
> 问题域：PD-04 工具系统 Tool System Design
> 状态：可复用方案

---

## 第 1 章 问题与动机

### 1.1 核心问题

Agent 需要调用外部工具（搜索、代码执行、文件读写、API 调用等）来完成任务，但工具系统面临四个结构性困难：

1. **工具注册散乱** — 没有统一的注册机制，工具定义散落在各处，新增工具需要改多处代码
2. **输入校验缺失** — 工具参数靠字符串拼接或 dict 传递，LLM 生成的参数格式错误时无法提前拦截
3. **工具绑定僵化** — 所有 Agent 节点共享同一套工具集，无法按角色分配不同工具（researcher 不需要代码执行，coder 不需要搜索）
4. **Schema 手写易错** — 工具的 JSON Schema 需要手动编写供 LLM 理解，与实际函数签名容易不同步

```
用户提问 "搜索 React 最新版本并写一个示例组件"
  → researcher 节点需要：web_search, crawl_website
  → coder 节点需要：python_repl, file_write
  → reporter 节点不需要任何工具
  → 如果所有节点都绑定全部工具，LLM 会困惑于过多选项
```

### 1.2 DeerFlow 的解法概述

DeerFlow 基于 LangChain 的 `@tool` 装饰器 + Pydantic BaseModel 构建工具系统：

- **`@tool` 装饰器**：一行代码将普通函数注册为 LangChain Tool，自动生成 name/description/schema
- **Pydantic BaseModel**：为每个工具定义强类型输入 Schema，LLM 生成的参数自动校验
- **动态绑定**：不同图节点在运行时通过 `llm.bind_tools(tools)` 绑定不同工具子集
- **工具分组**：按功能域将工具分组（search_tools / code_tools / file_tools），按需组合

### 1.3 设计思想

| 原则 | 说明 |
|------|------|
| 声明式注册 | `@tool` 装饰器 + docstring = 完整工具定义，零样板代码 |
| Schema 即代码 | Pydantic Model 既是校验器又是 JSON Schema 生成器，单一事实来源 |
| 按需绑定 | 每个节点只看到自己需要的工具，减少 LLM 选择困惑 |
| 分组管理 | 工具按功能域分组，新增工具只需放入对应分组 |
| 容错执行 | 工具调用失败返回错误信息而非抛异常，Agent 可自行决定重试或跳过 |

---

## 第 2 章 源码实现分析

### 2.1 工具目录结构

```
src/tools/
├── __init__.py              # 工具注册表：导出所有工具 + 分组
├── search.py                # 搜索工具：web_search, tavily_search
├── crawl.py                 # 爬取工具：crawl_website, extract_content
├── python_repl.py           # 代码执行：python_repl_tool
├── file_ops.py              # 文件操作：read_file, write_file
└── decorators.py            # 工具增强装饰器：超时、重试、日志
```

### 2.2 @tool 装饰器基础用法

LangChain 的 `@tool` 装饰器将普通 Python 函数转换为 `StructuredTool` 对象：

```python
# src/tools/search.py（简化自 DeerFlow 源码）
from langchain_core.tools import tool

@tool
def web_search(query: str, max_results: int = 5) -> str:
    """搜索互联网获取最新信息。

    Args:
        query: 搜索查询关键词
        max_results: 最大返回结果数，默认 5
    """
    # 实际调用搜索 API
    results = tavily_client.search(query, max_results=max_results)
    return "\n\n".join(
        f"**{r['title']}**\n{r['url']}\n{r['content'][:200]}"
        for r in results["results"]
    )
```

装饰器自动完成以下工作：

```python
# @tool 装饰器等价于手动创建 StructuredTool：
from langchain_core.tools import StructuredTool

web_search_tool = StructuredTool.from_function(
    func=web_search,
    name="web_search",                    # 从函数名推断
    description="搜索互联网获取最新信息。",  # 从 docstring 第一行提取
    args_schema=...,                       # 从类型注解自动生成 Pydantic Model
)
```

### 2.3 Pydantic BaseModel 输入 Schema

对于复杂输入，DeerFlow 使用显式的 Pydantic Model 替代类型注解：

```python
# src/tools/crawl.py（简化）
from pydantic import BaseModel, Field
from langchain_core.tools import tool

class CrawlWebsiteInput(BaseModel):
    """爬取网页内容的输入参数"""
    url: str = Field(description="要爬取的网页 URL")
    extract_mode: str = Field(
        default="text",
        description="提取模式：'text' 纯文本 / 'markdown' Markdown 格式 / 'html' 原始 HTML"
    )
    max_length: int = Field(
        default=5000,
        description="最大返回字符数",
        ge=100,
        le=50000,
    )

@tool(args_schema=CrawlWebsiteInput)
def crawl_website(url: str, extract_mode: str = "text", max_length: int = 5000) -> str:
    """爬取指定网页并提取内容。支持文本、Markdown、HTML 三种提取模式。"""
    # ... 实际爬取逻辑
    response = httpx.get(url, timeout=30)
    content = extract_content(response.text, mode=extract_mode)
    return content[:max_length]
```

Pydantic Model 自动生成的 JSON Schema（供 LLM 理解工具参数）：

```json
{
  "name": "crawl_website",
  "description": "爬取指定网页并提取内容。支持文本、Markdown、HTML 三种提取模式。",
  "parameters": {
    "type": "object",
    "properties": {
      "url": {
        "type": "string",
        "description": "要爬取的网页 URL"
      },
      "extract_mode": {
        "type": "string",
        "description": "提取模式：'text' 纯文本 / 'markdown' Markdown 格式 / 'html' 原始 HTML",
        "default": "text"
      },
      "max_length": {
        "type": "integer",
        "description": "最大返回字符数",
        "minimum": 100,
        "maximum": 50000,
        "default": 5000
      }
    },
    "required": ["url"]
  }
}
```

### 2.4 工具分组与注册表

```python
# src/tools/__init__.py（简化自 DeerFlow）
from .search import web_search, tavily_search
from .crawl import crawl_website, extract_content
from .python_repl import python_repl_tool
from .file_ops import read_file, write_file

# === 工具分组 ===
SEARCH_TOOLS = [web_search, tavily_search]
CRAWL_TOOLS = [crawl_website, extract_content]
CODE_TOOLS = [python_repl_tool]
FILE_TOOLS = [read_file, write_file]

# === 角色 → 工具映射 ===
ROLE_TOOLS = {
    "researcher": SEARCH_TOOLS + CRAWL_TOOLS,
    "coder": CODE_TOOLS + FILE_TOOLS,
    "reporter": [],  # reporter 不需要工具，纯 LLM 生成
    "reviewer": SEARCH_TOOLS,  # reviewer 只需搜索验证
}

# === 全量工具列表（用于调试/管理） ===
ALL_TOOLS = SEARCH_TOOLS + CRAWL_TOOLS + CODE_TOOLS + FILE_TOOLS

def get_tools_for_role(role: str) -> list:
    """根据角色获取工具列表"""
    return ROLE_TOOLS.get(role, [])

def get_tool_by_name(name: str):
    """按名称查找工具"""
    for t in ALL_TOOLS:
        if t.name == name:
            return t
    return None
```

### 2.5 动态工具绑定（核心机制）

DeerFlow 在图节点中根据角色动态绑定工具，而非全局共享：

```python
# src/graph/nodes.py（简化自 DeerFlow 源码）
from langchain_openai import ChatOpenAI
from src.tools import get_tools_for_role

async def researcher_node(state: ResearchState, config: dict) -> dict:
    """研究者节点：绑定搜索和爬取工具"""
    llm = ChatOpenAI(model="gpt-4o", temperature=0)

    # 关键：动态绑定该角色专属的工具集
    tools = get_tools_for_role("researcher")
    llm_with_tools = llm.bind_tools(tools)

    # LLM 现在知道可以调用 web_search 和 crawl_website
    response = await llm_with_tools.ainvoke([
        SystemMessage(content="你是一个研究助手。使用搜索工具收集信息。"),
        HumanMessage(content=state["query"]),
    ])
    return {"messages": [response]}


async def coder_node(state: ResearchState, config: dict) -> dict:
    """编码者节点：绑定代码执行和文件操作工具"""
    llm = ChatOpenAI(model="gpt-4o", temperature=0)

    # 不同角色绑定不同工具
    tools = get_tools_for_role("coder")
    llm_with_tools = llm.bind_tools(tools)

    response = await llm_with_tools.ainvoke([
        SystemMessage(content="你是一个编程助手。使用代码执行工具完成任务。"),
        HumanMessage(content=state["query"]),
    ])
    return {"messages": [response]}
```

### 2.6 工具调用结果处理

LLM 返回 `tool_calls` 后，需要实际执行工具并将结果反馈：

```python
# src/graph/nodes.py — 工具执行循环（简化）
from langchain_core.messages import ToolMessage

async def execute_tool_calls(state: ResearchState, config: dict) -> dict:
    """执行 LLM 返回的工具调用，将结果作为 ToolMessage 追加到消息列表"""
    last_message = state["messages"][-1]

    if not hasattr(last_message, "tool_calls") or not last_message.tool_calls:
        return {"messages": []}  # 无工具调用，直接返回

    tool_messages = []
    tools_by_name = {t.name: t for t in get_tools_for_role(state.get("role", "researcher"))}

    for tool_call in last_message.tool_calls:
        tool_name = tool_call["name"]
        tool_args = tool_call["args"]
        tool_id = tool_call["id"]

        tool = tools_by_name.get(tool_name)
        if tool is None:
            # 工具不存在：返回错误信息而非抛异常
            result = f"错误：工具 '{tool_name}' 不存在。可用工具：{list(tools_by_name.keys())}"
        else:
            try:
                result = await tool.ainvoke(tool_args)
            except Exception as e:
                result = f"工具 '{tool_name}' 执行失败：{type(e).__name__}: {e}"

        tool_messages.append(
            ToolMessage(content=str(result), tool_call_id=tool_id)
        )

    return {"messages": tool_messages}
```

### 2.7 工具调用的完整 ReAct 循环

DeerFlow 的 Agent 节点通常运行一个 ReAct 循环：LLM 思考 → 调用工具 → 观察结果 → 继续思考，直到 LLM 决定不再调用工具：

```python
# ReAct 循环（简化自 DeerFlow 的 agent executor 模式）
async def react_agent_node(
    state: ResearchState,
    config: dict,
    role: str = "researcher",
    max_iterations: int = 10,
) -> dict:
    """ReAct 循环：思考 → 行动 → 观察，直到完成"""
    llm = ChatOpenAI(model="gpt-4o", temperature=0)
    tools = get_tools_for_role(role)
    llm_with_tools = llm.bind_tools(tools)
    tools_by_name = {t.name: t for t in tools}

    messages = list(state["messages"])
    all_new_messages = []

    for i in range(max_iterations):
        # 1. LLM 思考（可能返回 tool_calls 或最终回答）
        response = await llm_with_tools.ainvoke(messages)
        all_new_messages.append(response)
        messages.append(response)

        # 2. 检查是否有工具调用
        if not response.tool_calls:
            break  # LLM 决定不再调用工具，循环结束

        # 3. 执行所有工具调用
        for tool_call in response.tool_calls:
            tool = tools_by_name.get(tool_call["name"])
            if tool:
                try:
                    result = await tool.ainvoke(tool_call["args"])
                except Exception as e:
                    result = f"执行失败：{e}"
            else:
                result = f"未知工具：{tool_call['name']}"

            tool_msg = ToolMessage(content=str(result), tool_call_id=tool_call["id"])
            all_new_messages.append(tool_msg)
            messages.append(tool_msg)

    return {"messages": all_new_messages}
```

### 2.8 条件启用工具

DeerFlow 支持根据运行时条件启用/禁用特定工具：

```python
# src/tools/__init__.py — 条件工具启用
import os

def get_available_tools(role: str, config: dict | None = None) -> list:
    """根据角色和运行时配置返回可用工具列表"""
    config = config or {}
    base_tools = ROLE_TOOLS.get(role, [])

    available = []
    for tool in base_tools:
        # 检查工具依赖的环境变量是否存在
        if tool.name == "tavily_search" and not os.getenv("TAVILY_API_KEY"):
            continue  # Tavily API Key 未配置，跳过
        if tool.name == "python_repl_tool" and not config.get("enable_code_execution", False):
            continue  # 代码执行未启用，跳过
        available.append(tool)

    return available
```

---

## 第 3 章 迁移指南

### 3.1 迁移检查清单

| # | 检查项 | 说明 |
|---|--------|------|
| 1 | 安装依赖 | `pip install langchain-core pydantic>=2.0` |
| 2 | 定义工具函数 | 使用 `@tool` 装饰器 + 类型注解 |
| 3 | 定义输入 Schema | 复杂参数用 Pydantic BaseModel |
| 4 | 创建工具分组 | 按功能域分组，建立角色映射 |
| 5 | 实现动态绑定 | 节点函数中 `llm.bind_tools(tools)` |
| 6 | 实现工具执行 | 处理 `tool_calls` → 执行 → `ToolMessage` |
| 7 | 实现 ReAct 循环 | 思考→行动→观察的迭代循环 |
| 8 | 添加错误处理 | 工具不存在/执行失败返回错误信息 |
| 9 | 条件启用 | 根据环境变量/配置动态启用工具 |

### 3.2 最小可用模板

以下是一个完整的最小工具系统实现，可直接复制使用：

```python
"""tool_system.py — 最小可用的 LangChain Tool 系统模板"""
from __future__ import annotations
from typing import Any
from pydantic import BaseModel, Field
from langchain_core.tools import tool, StructuredTool
from langchain_core.messages import ToolMessage, SystemMessage, HumanMessage


# ============================================================
# Part 1: 工具定义
# ============================================================

# --- 简单工具：直接用 @tool + 类型注解 ---

@tool
def calculator(expression: str) -> str:
    """计算数学表达式并返回结果。

    Args:
        expression: 数学表达式，如 '2 + 3 * 4'
    """
    try:
        # 安全的数学表达式求值
        allowed_names = {"__builtins__": {}}
        result = eval(expression, allowed_names)
        return f"计算结果：{expression} = {result}"
    except Exception as e:
        return f"计算错误：{e}"


# --- 复杂工具：用 Pydantic BaseModel 定义输入 ---

class SearchInput(BaseModel):
    """搜索工具的输入参数"""
    query: str = Field(description="搜索查询关键词")
    max_results: int = Field(default=5, description="最大返回结果数", ge=1, le=20)
    language: str = Field(default="zh", description="搜索语言：'zh' 中文 / 'en' 英文")

@tool(args_schema=SearchInput)
def web_search(query: str, max_results: int = 5, language: str = "zh") -> str:
    """搜索互联网获取最新信息。支持中英文搜索。"""
    # 替换为实际搜索 API 调用
    return f"搜索 '{query}' 的前 {max_results} 条结果（{language}）..."


class CodeExecutionInput(BaseModel):
    """代码执行工具的输入参数"""
    code: str = Field(description="要执行的 Python 代码")
    timeout: int = Field(default=30, description="执行超时时间（秒）", ge=1, le=300)

@tool(args_schema=CodeExecutionInput)
def execute_python(code: str, timeout: int = 30) -> str:
    """在沙箱中执行 Python 代码并返回输出。"""
    # 替换为实际沙箱执行逻辑
    return f"代码执行完成（超时设置：{timeout}s）"


# ============================================================
# Part 2: 工具分组与注册
# ============================================================

TOOL_GROUPS = {
    "search": [web_search],
    "code": [execute_python],
    "math": [calculator],
}

ROLE_TOOL_MAPPING = {
    "researcher": ["search"],
    "coder": ["code", "math"],
    "analyst": ["search", "math"],
    "general": ["search", "code", "math"],
}

def get_tools(role: str) -> list[StructuredTool]:
    """根据角色获取工具列表"""
    group_names = ROLE_TOOL_MAPPING.get(role, [])
    tools = []
    for name in group_names:
        tools.extend(TOOL_GROUPS.get(name, []))
    return tools


# ============================================================
# Part 3: 动态绑定与执行
# ============================================================

async def bind_and_invoke(llm, role: str, messages: list) -> Any:
    """将工具绑定到 LLM 并调用"""
    tools = get_tools(role)
    if tools:
        llm_with_tools = llm.bind_tools(tools)
    else:
        llm_with_tools = llm
    return await llm_with_tools.ainvoke(messages)


async def execute_tool_calls(response, role: str) -> list[ToolMessage]:
    """执行 LLM 返回的工具调用"""
    if not hasattr(response, "tool_calls") or not response.tool_calls:
        return []

    tools_map = {t.name: t for t in get_tools(role)}
    results = []

    for call in response.tool_calls:
        tool_obj = tools_map.get(call["name"])
        if tool_obj is None:
            content = f"工具 '{call['name']}' 不可用"
        else:
            try:
                content = await tool_obj.ainvoke(call["args"])
            except Exception as e:
                content = f"执行失败：{e}"

        results.append(ToolMessage(content=str(content), tool_call_id=call["id"]))

    return results
```

### 3.3 场景适配矩阵

| 场景 | 工具定义方式 | 绑定策略 | 说明 |
|------|-------------|----------|------|
| 简单工具（1-2 个参数） | `@tool` + 类型注解 | 静态绑定 | 最简方案，适合快速原型 |
| 复杂工具（多参数+校验） | `@tool` + Pydantic Model | 静态绑定 | 参数校验 + 自动 Schema |
| 多角色 Agent | `@tool` + 分组 | 动态绑定 | 按角色分配工具子集 |
| 条件启用工具 | `@tool` + 分组 + 过滤 | 运行时绑定 | 根据配置/环境动态启用 |
| ReAct 循环 Agent | `@tool` + 分组 | 动态绑定 + 循环执行 | 思考→行动→观察迭代 |
| 工具结果需后处理 | `@tool` + 自定义执行器 | 动态绑定 | 执行后格式化/过滤结果 |

### 3.4 工具定义最佳实践

```python
# === 好的工具定义 ===

@tool
def search_news(query: str, days: int = 7) -> str:
    """搜索最近 N 天的新闻报道。

    Args:
        query: 新闻搜索关键词
        days: 搜索最近多少天的新闻，默认 7 天
    """
    # 清晰的函数名、完整的 docstring、合理的默认值
    ...

# === 不好的工具定义 ===

@tool
def do_stuff(data: dict) -> str:
    """处理数据"""
    # 函数名不明确、参数类型太宽泛、docstring 太简略
    # LLM 无法理解该传什么参数
    ...
```

### 3.5 异步工具定义

```python
# 异步工具：适合 I/O 密集型操作（HTTP 请求、数据库查询等）
import httpx
from langchain_core.tools import tool

@tool
async def fetch_url(url: str) -> str:
    """获取指定 URL 的网页内容。

    Args:
        url: 要获取的网页 URL
    """
    async with httpx.AsyncClient(timeout=30) as client:
        response = await client.get(url)
        response.raise_for_status()
        return response.text[:5000]  # 截断过长内容
```

---

## 第 4 章 测试用例

```python
"""test_tool_system.py — 工具系统完整测试套件"""
import pytest
from unittest.mock import AsyncMock, MagicMock, patch
from pydantic import ValidationError
from langchain_core.tools import tool, StructuredTool
from langchain_core.messages import ToolMessage, AIMessage


# ============================================================
# 测试用工具定义
# ============================================================

from pydantic import BaseModel, Field

class MockSearchInput(BaseModel):
    query: str = Field(description="搜索关键词")
    max_results: int = Field(default=3, ge=1, le=10)

@tool(args_schema=MockSearchInput)
def mock_search(query: str, max_results: int = 3) -> str:
    """模拟搜索工具"""
    return f"搜索结果：{query}（共 {max_results} 条）"

@tool
def mock_calculator(expression: str) -> str:
    """模拟计算器工具"""
    try:
        return str(eval(expression, {"__builtins__": {}}))
    except Exception as e:
        return f"计算错误：{e}"

@tool
def mock_failing_tool(input_text: str) -> str:
    """总是失败的工具，用于测试错误处理"""
    raise RuntimeError("工具内部错误")


# ============================================================
# 5.1 工具注册与 Schema 生成测试
# ============================================================

class TestToolRegistration:
    """测试 @tool 装饰器的注册行为和 Schema 自动生成"""

    def test_tool_decorator_creates_structured_tool(self):
        """@tool 装饰器应将函数转换为 StructuredTool"""
        assert isinstance(mock_search, StructuredTool)
        assert mock_search.name == "mock_search"

    def test_tool_description_from_docstring(self):
        """工具描述应从 docstring 提取"""
        assert "模拟搜索工具" in mock_search.description

    def test_pydantic_schema_generates_json_schema(self):
        """Pydantic Model 应自动生成 JSON Schema"""
        schema = mock_search.args_schema.model_json_schema()
        assert "query" in schema["properties"]
        assert "max_results" in schema["properties"]
        assert schema["properties"]["max_results"]["default"] == 3

    def test_pydantic_schema_validates_input(self):
        """Pydantic Model 应校验输入参数"""
        # 合法输入
        valid = MockSearchInput(query="test", max_results=5)
        assert valid.query == "test"

        # 非法输入：max_results 超出范围
        with pytest.raises(ValidationError):
            MockSearchInput(query="test", max_results=100)

    def test_pydantic_schema_required_fields(self):
        """必填字段缺失应报错"""
        with pytest.raises(ValidationError):
            MockSearchInput()  # query 是必填的

    def test_tool_without_explicit_schema(self):
        """没有显式 Schema 的工具应从类型注解自动生成"""
        assert isinstance(mock_calculator, StructuredTool)
        schema = mock_calculator.args_schema.model_json_schema()
        assert "expression" in schema["properties"]

    def test_tool_invocation_returns_string(self):
        """工具调用应返回字符串结果"""
        result = mock_search.invoke({"query": "test", "max_results": 2})
        assert isinstance(result, str)
        assert "test" in result

    def test_calculator_tool_execution(self):
        """计算器工具应正确计算表达式"""
        result = mock_calculator.invoke({"expression": "2 + 3 * 4"})
        assert result == "14"

    def test_calculator_handles_invalid_expression(self):
        """计算器应优雅处理非法表达式"""
        result = mock_calculator.invoke({"expression": "invalid"})
        assert "计算错误" in result


# ============================================================
# 5.2 工具分组与动态绑定测试
# ============================================================

# 测试用工具分组
TEST_TOOL_GROUPS = {
    "search": [mock_search],
    "math": [mock_calculator],
    "unstable": [mock_failing_tool],
}

TEST_ROLE_MAPPING = {
    "researcher": ["search"],
    "analyst": ["search", "math"],
    "tester": ["unstable"],
    "empty": [],
}

def get_test_tools(role: str) -> list:
    group_names = TEST_ROLE_MAPPING.get(role, [])
    tools = []
    for name in group_names:
        tools.extend(TEST_TOOL_GROUPS.get(name, []))
    return tools


class TestToolGrouping:
    """测试工具分组和角色映射"""

    def test_researcher_gets_search_tools(self):
        """researcher 角色应只获得搜索工具"""
        tools = get_test_tools("researcher")
        assert len(tools) == 1
        assert tools[0].name == "mock_search"

    def test_analyst_gets_search_and_math_tools(self):
        """analyst 角色应获得搜索和数学工具"""
        tools = get_test_tools("analyst")
        assert len(tools) == 2
        names = {t.name for t in tools}
        assert names == {"mock_search", "mock_calculator"}

    def test_empty_role_gets_no_tools(self):
        """空角色应返回空工具列表"""
        tools = get_test_tools("empty")
        assert tools == []

    def test_unknown_role_gets_no_tools(self):
        """未知角色应返回空工具列表"""
        tools = get_test_tools("nonexistent_role")
        assert tools == []

    def test_tool_names_are_unique(self):
        """所有工具名称应唯一"""
        all_tools = []
        for group in TEST_TOOL_GROUPS.values():
            all_tools.extend(group)
        names = [t.name for t in all_tools]
        assert len(names) == len(set(names)), "工具名称有重复"

    def test_bind_tools_creates_new_llm_instance(self):
        """bind_tools 应返回新的 LLM 实例，不修改原始实例"""
        mock_llm = MagicMock()
        mock_llm.bind_tools.return_value = MagicMock()

        tools = get_test_tools("researcher")
        bound_llm = mock_llm.bind_tools(tools)

        mock_llm.bind_tools.assert_called_once_with(tools)
        assert bound_llm is not mock_llm


# ============================================================
# 5.3 工具执行与错误处理测试
# ============================================================

class TestToolExecution:
    """测试工具调用执行和错误处理"""

    def _make_ai_message_with_tool_calls(self, tool_calls: list) -> AIMessage:
        """构造带 tool_calls 的 AIMessage"""
        return AIMessage(
            content="",
            tool_calls=tool_calls,
        )

    @pytest.mark.asyncio
    async def test_execute_single_tool_call(self):
        """应正确执行单个工具调用"""
        tools_map = {t.name: t for t in get_test_tools("analyst")}
        call = {"name": "mock_calculator", "args": {"expression": "1+1"}, "id": "call_001"}

        tool_obj = tools_map[call["name"]]
        result = await tool_obj.ainvoke(call["args"])
        assert result == "2"

    @pytest.mark.asyncio
    async def test_execute_nonexistent_tool_returns_error(self):
        """调用不存在的工具应返回错误信息"""
        tools_map = {t.name: t for t in get_test_tools("researcher")}
        call_name = "nonexistent_tool"

        tool_obj = tools_map.get(call_name)
        assert tool_obj is None  # 工具不存在

        # 模拟错误处理逻辑
        error_msg = f"工具 '{call_name}' 不可用"
        assert "不可用" in error_msg

    @pytest.mark.asyncio
    async def test_failing_tool_returns_error_message(self):
        """工具执行失败应返回错误信息而非抛异常"""
        tools = get_test_tools("tester")
        tool_obj = tools[0]  # mock_failing_tool

        # 工具本身会抛异常，调用方应捕获
        try:
            result = await tool_obj.ainvoke({"input_text": "test"})
        except RuntimeError as e:
            result = f"执行失败：{e}"

        assert "错误" in result or "失败" in result

    def test_tool_message_format(self):
        """ToolMessage 应包含正确的 tool_call_id"""
        msg = ToolMessage(content="搜索结果", tool_call_id="call_001")
        assert msg.content == "搜索结果"
        assert msg.tool_call_id == "call_001"

    @pytest.mark.asyncio
    async def test_multiple_tool_calls_all_executed(self):
        """多个工具调用应全部执行"""
        tools_map = {t.name: t for t in get_test_tools("analyst")}
        calls = [
            {"name": "mock_search", "args": {"query": "test"}, "id": "call_001"},
            {"name": "mock_calculator", "args": {"expression": "2+2"}, "id": "call_002"},
        ]

        results = []
        for call in calls:
            tool_obj = tools_map.get(call["name"])
            assert tool_obj is not None
            result = await tool_obj.ainvoke(call["args"])
            results.append(ToolMessage(content=str(result), tool_call_id=call["id"]))

        assert len(results) == 2
        assert "test" in results[0].content
        assert "4" in results[1].content

    @pytest.mark.asyncio
    async def test_react_loop_terminates_without_tool_calls(self):
        """当 LLM 不返回 tool_calls 时，ReAct 循环应终止"""
        mock_llm = AsyncMock()
        # LLM 直接返回最终回答，不调用工具
        final_response = MagicMock()
        final_response.tool_calls = []
        final_response.content = "最终回答"
        mock_llm.ainvoke.return_value = final_response

        mock_llm_bound = AsyncMock()
        mock_llm_bound.ainvoke.return_value = final_response
        mock_llm.bind_tools.return_value = mock_llm_bound

        # 模拟 ReAct 循环
        tools = get_test_tools("researcher")
        llm_with_tools = mock_llm.bind_tools(tools)
        response = await llm_with_tools.ainvoke([])

        assert not response.tool_calls  # 无工具调用
        assert response.content == "最终回答"

    def test_tool_schema_matches_function_signature(self):
        """工具 Schema 应与函数签名一致"""
        schema = mock_search.args_schema.model_json_schema()
        props = schema["properties"]

        # query 是必填 string
        assert props["query"]["type"] == "string"
        # max_results 是可选 integer，有默认值
        assert props["max_results"]["type"] == "integer"
        assert props["max_results"]["default"] == 3
```

---

## 第 5 章 跨域关联

| 关联域 | 关系 | 说明 |
|--------|------|------|
| PD-01 上下文管理 | 输入 | 工具结果需要裁剪后放入 LLM 上下文，避免超出 token 限制 |
| PD-02 多 Agent 编排 | 架构 | 不同图节点绑定不同工具集，工具系统是编排的基础设施 |
| PD-03 容错与重试 | 互补 | 工具调用失败时需要重试机制，可复用指数退避方案 |
| PD-05 沙箱隔离 | 安全 | 代码执行工具（python_repl）必须在沙箱中运行 |
| PD-08 搜索与检索 | 实例 | 搜索工具是工具系统最常见的实例，搜索方案可作为工具实现 |
| PD-11 可观测性 | 监控 | 工具调用次数、延迟、成功率需要追踪和告警 |

---

## 第 6 章 来源文件索引

| 编号 | 文件 | 说明 |
|------|------|------|
| S1 | `src/tools/__init__.py` | 工具注册表：导出所有工具、分组定义、角色映射 |
| S2 | `src/tools/search.py` | 搜索工具：web_search, tavily_search 的 @tool 定义 |
| S3 | `src/tools/crawl.py` | 爬取工具：crawl_website + CrawlWebsiteInput Schema |
| S4 | `src/tools/python_repl.py` | 代码执行工具：python_repl_tool 沙箱执行 |
| S5 | `src/graph/nodes.py` | 图节点：动态工具绑定 + ReAct 循环 + 工具结果处理 |
| S6 | `src/graph/builder.py` | 图构建器：节点注册时关联工具配置 |
| S7 | LangChain `langchain_core/tools/structured.py` | StructuredTool 源码：@tool 装饰器实现 |
| S8 | LangChain `langchain_core/utils/function_calling.py` | Pydantic → JSON Schema 转换逻辑 |
