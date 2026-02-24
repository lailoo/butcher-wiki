# PD-04.07 OpenManus — BaseTool 抽象基类 + ToolCollection 注册表 + MCP 双向桥接

> 文档编号：PD-04.07
> 来源：OpenManus `app/tool/base.py` `app/tool/tool_collection.py` `app/tool/mcp.py` `app/mcp/server.py`
> GitHub：https://github.com/FoundationAgents/OpenManus.git
> 问题域：PD-04 工具系统 Tool System Design
> 状态：可复用方案

---

## 第 1 章 问题与动机

### 1.1 核心问题

Agent 工具系统面临三个层次的挑战：

1. **工具定义标准化** — 每个工具需要统一的 schema 描述（名称、参数、返回值），才能让 LLM 通过 function calling 正确选择和调用
2. **工具集合管理** — Agent 需要一个注册表来管理可用工具集，支持按名称查找、批量转换为 LLM 参数格式、统一执行入口
3. **远程工具集成** — 本地工具有限，需要通过 MCP 协议动态发现和代理远程服务器上的工具，同时也需要将本地工具反向暴露给外部 MCP 客户端

### 1.2 OpenManus 的解法概述

OpenManus 采用三层架构解决上述问题：

1. **BaseTool 抽象基类**（`app/tool/base.py:78-137`）— Pydantic BaseModel + ABC 双继承，定义 `name/description/parameters` 三元组，提供 `to_param()` 转换为 OpenAI function calling 格式，`execute()` 抽象方法强制子类实现
2. **ToolCollection 注册表**（`app/tool/tool_collection.py:9-72`）— 基于 `tool_map: Dict[str, BaseTool]` 的 O(1) 查找，`to_params()` 批量转换，`execute()` 统一执行入口，支持 `add_tool/add_tools` 动态扩展
3. **MCP 双向桥接** — 客户端（`app/tool/mcp.py:37-194`）继承 ToolCollection，通过 SSE/stdio 双传输连接远程 MCP 服务器，动态发现工具并包装为 MCPClientTool 代理；服务端（`app/mcp/server.py:24-161`）基于 FastMCP，将本地 BaseTool 反向注册为 MCP 工具，自动构建 docstring 和 Python 签名
4. **ToolResult 标准化返回**（`app/tool/base.py:38-75`）— 统一的 `output/error/base64_image/system` 四字段结构，支持 `__add__` 合并、`__str__` 格式化、`replace()` 不可变更新
5. **Agent 层工具编排**（`app/agent/toolcall.py:18-251`）— ToolCallAgent 持有 ToolCollection，think() 阶段将工具列表传给 LLM，act() 阶段按 LLM 返回的 tool_calls 逐个执行

### 1.3 设计思想

| 设计原则 | 具体实现 | 理由 | 替代方案 |
|----------|----------|------|----------|
| Pydantic + ABC 双继承 | `BaseTool(ABC, BaseModel)` 同时获得类型校验和抽象约束 | Pydantic 提供参数校验和序列化，ABC 强制子类实现 execute() | 纯 dataclass（无校验）或纯 ABC（无序列化） |
| OpenAI function calling 原生格式 | `to_param()` 直接输出 `{"type":"function","function":{...}}` | 与 OpenAI API 零转换对接，减少中间层 | 自定义 schema 格式再转换 |
| 注册表模式 | ToolCollection 用 dict 做 O(1) 查找 + tuple 做不可变工具列表 | 工具数量有限（通常 < 20），dict 查找足够高效 | 基于装饰器的全局注册（如 LangChain @tool） |
| MCP 继承复用 | MCPClients 继承 ToolCollection，复用 tool_map 和 execute | 远程工具和本地工具统一管理，无需额外适配层 | 独立的 MCP 管理器 + 适配器模式 |
| 代理模式桥接远程工具 | MCPClientTool 持有 session 引用，execute() 委托给 session.call_tool() | 远程工具对 Agent 透明，与本地工具接口一致 | 直接在 Agent 层处理 MCP 调用 |

---

## 第 2 章 源码实现分析

### 2.1 架构概览

```
┌─────────────────────────────────────────────────────────────────┐
│                        Manus Agent                              │
│  available_tools: ToolCollection                                │
│  mcp_clients: MCPClients                                        │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌──────────────────────┐    ┌──────────────────────────────┐  │
│  │   ToolCollection     │    │      MCPClients              │  │
│  │                      │    │   (extends ToolCollection)   │  │
│  │  tool_map: Dict      │    │                              │  │
│  │  ┌────────────────┐  │    │  sessions: Dict[str,Session] │  │
│  │  │ PythonExecute  │  │    │  ┌────────────────────────┐  │  │
│  │  │ BrowserUseTool │  │    │  │ MCPClientTool (proxy)  │  │  │
│  │  │ StrReplaceEdit │  │    │  │   session → remote     │  │  │
│  │  │ AskHuman       │  │    │  │ MCPClientTool (proxy)  │  │  │
│  │  │ Terminate      │  │    │  │   session → remote     │  │  │
│  │  └────────────────┘  │    │  └────────────────────────┘  │  │
│  └──────────────────────┘    └──────────────────────────────┘  │
│         ↑ add_tools(*mcp_tools)                                 │
│         └───────────────────────────────────────────────────────┘
│
│  to_params() → LLM function calling
│  execute(name, tool_input) → ToolResult
│
├─────────────────────────────────────────────────────────────────┤
│                      MCPServer (反向暴露)                        │
│  FastMCP ← register_tool(BaseTool) → MCP 协议工具               │
│  _build_signature() + _build_docstring() 自动生成 Python 签名    │
└─────────────────────────────────────────────────────────────────┘
```

### 2.2 核心实现

#### 2.2.1 BaseTool 抽象基类

BaseTool 是整个工具系统的基石（`app/tool/base.py:78-137`）：

```python
class BaseTool(ABC, BaseModel):
    name: str
    description: str
    parameters: Optional[dict] = None

    class Config:
        arbitrary_types_allowed = True
        underscore_attrs_are_private = False

    async def __call__(self, **kwargs) -> Any:
        return await self.execute(**kwargs)

    @abstractmethod
    async def execute(self, **kwargs) -> Any:
        """Execute the tool with given parameters."""

    def to_param(self) -> Dict:
        return {
            "type": "function",
            "function": {
                "name": self.name,
                "description": self.description,
                "parameters": self.parameters,
            },
        }
```

关键设计点：
- `__call__` 委托给 `execute()`，使工具实例可直接作为 callable 使用（`app/tool/base.py:116-118`）
- `to_param()` 输出 OpenAI function calling 标准格式（`app/tool/base.py:124-137`）
- `success_response()` 和 `fail_response()` 提供标准化的 ToolResult 构造（`app/tool/base.py:147-173`）

#### 2.2.2 ToolResult 结果容器

ToolResult 支持结果合并和多态子类（`app/tool/base.py:38-75`）：

```python
class ToolResult(BaseModel):
    output: Any = Field(default=None)
    error: Optional[str] = Field(default=None)
    base64_image: Optional[str] = Field(default=None)
    system: Optional[str] = Field(default=None)

    def __add__(self, other: "ToolResult"):
        return ToolResult(
            output=combine_fields(self.output, other.output),
            error=combine_fields(self.error, other.error),
            base64_image=combine_fields(self.base64_image, other.base64_image, False),
            system=combine_fields(self.system, other.system),
        )
```

`base64_image` 字段专门支持浏览器截图等视觉工具的输出，`system` 字段用于传递工具级系统消息（如 "tool must be restarted"）。子类 `CLIResult` 和 `ToolFailure` 提供语义化区分。

#### 2.2.3 ToolCollection 注册表

ToolCollection 是工具的容器和执行入口（`app/tool/tool_collection.py:9-72`）：

```python
class ToolCollection:
    def __init__(self, *tools: BaseTool):
        self.tools = tools                              # tuple，不可变
        self.tool_map = {tool.name: tool for tool in tools}  # dict，O(1) 查找

    def to_params(self) -> List[Dict[str, Any]]:
        return [tool.to_param() for tool in self.tools]

    async def execute(self, *, name: str, tool_input: Dict[str, Any] = None) -> ToolResult:
        tool = self.tool_map.get(name)
        if not tool:
            return ToolFailure(error=f"Tool {name} is invalid")
        try:
            result = await tool(**tool_input)
            return result
        except ToolError as e:
            return ToolFailure(error=e.message)
```

`add_tool()` 方法（`app/tool/tool_collection.py:51-62`）实现去重保护：同名工具跳过并记录 warning，避免 MCP 重连时产生重复工具。

#### 2.2.4 MCP 客户端 — 远程工具代理

MCPClients 继承 ToolCollection，管理多个 MCP 服务器连接（`app/tool/mcp.py:37-194`）：

```python
class MCPClients(ToolCollection):
    sessions: Dict[str, ClientSession] = {}
    exit_stacks: Dict[str, AsyncExitStack] = {}

    async def connect_sse(self, server_url: str, server_id: str = "") -> None:
        exit_stack = AsyncExitStack()
        streams_context = sse_client(url=server_url)
        streams = await exit_stack.enter_async_context(streams_context)
        session = await exit_stack.enter_async_context(ClientSession(*streams))
        self.sessions[server_id] = session
        await self._initialize_and_list_tools(server_id)
```

工具发现的核心在 `_initialize_and_list_tools()`（`app/tool/mcp.py:97-126`）：远程工具被包装为 MCPClientTool，名称格式为 `mcp_{server_id}_{original_name}`，经过 `_sanitize_tool_name()` 清洗（替换非法字符、截断到 64 字符）。

MCPClientTool 是远程工具的本地代理（`app/tool/mcp.py:14-34`）：

```python
class MCPClientTool(BaseTool):
    session: Optional[ClientSession] = None
    server_id: str = ""
    original_name: str = ""

    async def execute(self, **kwargs) -> ToolResult:
        if not self.session:
            return ToolResult(error="Not connected to MCP server")
        try:
            result = await self.session.call_tool(self.original_name, kwargs)
            content_str = ", ".join(
                item.text for item in result.content if isinstance(item, TextContent)
            )
            return ToolResult(output=content_str or "No output returned.")
        except Exception as e:
            return ToolResult(error=f"Error executing tool: {str(e)}")
```

#### 2.2.5 MCP 服务端 — 本地工具反向暴露

MCPServer（`app/mcp/server.py:24-161`）将本地 BaseTool 注册为 MCP 协议工具：

```python
class MCPServer:
    def __init__(self, name: str = "openmanus"):
        self.server = FastMCP(name)
        self.tools: Dict[str, BaseTool] = {}
        self.tools["bash"] = Bash()
        self.tools["browser"] = BrowserUseTool()
        self.tools["editor"] = StrReplaceEditor()
        self.tools["terminate"] = Terminate()

    def register_tool(self, tool: BaseTool, method_name: Optional[str] = None) -> None:
        tool_name = method_name or tool.name
        tool_param = tool.to_param()
        tool_function = tool_param["function"]

        async def tool_method(**kwargs):
            result = await tool.execute(**kwargs)
            if hasattr(result, "model_dump"):
                return json.dumps(result.model_dump())
            elif isinstance(result, dict):
                return json.dumps(result)
            return result

        tool_method.__name__ = tool_name
        tool_method.__doc__ = self._build_docstring(tool_function)
        tool_method.__signature__ = self._build_signature(tool_function)
        self.server.tool()(tool_method)
```

关键技巧：`_build_signature()`（`app/mcp/server.py:100-136`）将 JSON Schema 类型映射为 Python 类型注解（string→str, integer→int 等），使 FastMCP 能正确解析参数。`_build_docstring()`（`app/mcp/server.py:78-98`）自动生成包含参数说明的文档字符串。

### 2.3 实现细节

#### Agent 层工具编排流程

ToolCallAgent 的 think-act 循环（`app/agent/toolcall.py:39-164`）：

1. **think()** — 调用 `self.llm.ask_tool(tools=self.available_tools.to_params())` 获取 LLM 的工具选择决策
2. **act()** — 遍历 `self.tool_calls`，逐个调用 `self.execute_tool(command)`
3. **execute_tool()** — JSON 解析参数 → `self.available_tools.execute(name, tool_input)` → 处理特殊工具（如 Terminate 触发 AgentState.FINISHED）→ 格式化观察结果

Manus Agent 的 MCP 集成（`app/agent/manus.py:67-129`）：

- `initialize_mcp_servers()` 从 `config.mcp_config.servers` 读取配置，按 type 分别调用 `connect_sse()` 或 `connect_stdio()`
- `connect_mcp_server()` 连接后将新工具通过 `self.available_tools.add_tools(*new_tools)` 合并到主工具集
- `disconnect_mcp_server()` 断开后重建 ToolCollection：先过滤出非 MCPClientTool 的本地工具，再合并剩余 MCP 工具

#### 工具结果截断

ToolCallAgent 支持 `max_observe` 参数（`app/agent/toolcall.py:147-148`）：

```python
if self.max_observe:
    result = result[: self.max_observe]
```

Manus 设置 `max_observe: int = 10000`（`app/agent/manus.py:27`），防止工具输出过长撑爆上下文窗口。

#### 工具清理生命周期

ToolCallAgent.cleanup()（`app/agent/toolcall.py:229-243`）遍历所有工具，调用有 `cleanup()` 方法的工具进行资源释放。`run()` 方法用 try/finally 确保清理一定执行。

---

## 第 3 章 迁移指南

### 3.1 迁移清单

**阶段 1：基础工具框架（必选）**
- [ ] 复制 `BaseTool` 抽象基类和 `ToolResult` 结果容器
- [ ] 复制 `ToolCollection` 注册表
- [ ] 实现至少一个具体工具（如 Bash 或 PythonExecute）
- [ ] 在 Agent 中集成 `available_tools.to_params()` 和 `available_tools.execute()`

**阶段 2：MCP 客户端集成（可选）**
- [ ] 安装 `mcp` Python 包
- [ ] 复制 `MCPClientTool` 和 `MCPClients`
- [ ] 添加 MCP 服务器配置（`config/mcp.json`）
- [ ] 在 Agent 初始化时调用 `initialize_mcp_servers()`

**阶段 3：MCP 服务端暴露（可选）**
- [ ] 安装 `mcp[server]` 包（含 FastMCP）
- [ ] 复制 `MCPServer` 类
- [ ] 注册需要暴露的本地工具
- [ ] 启动 stdio 或 SSE 传输

### 3.2 适配代码模板

#### 最小可用工具框架

```python
from abc import ABC, abstractmethod
from typing import Any, Dict, List, Optional
from pydantic import BaseModel, Field


class ToolResult(BaseModel):
    output: Any = Field(default=None)
    error: Optional[str] = Field(default=None)

    def __bool__(self):
        return any(getattr(self, f) for f in self.model_fields)

    def __str__(self):
        return f"Error: {self.error}" if self.error else str(self.output)


class BaseTool(ABC, BaseModel):
    name: str
    description: str
    parameters: Optional[dict] = None

    class Config:
        arbitrary_types_allowed = True

    async def __call__(self, **kwargs) -> Any:
        return await self.execute(**kwargs)

    @abstractmethod
    async def execute(self, **kwargs) -> Any: ...

    def to_param(self) -> Dict:
        return {
            "type": "function",
            "function": {
                "name": self.name,
                "description": self.description,
                "parameters": self.parameters,
            },
        }


class ToolCollection:
    def __init__(self, *tools: BaseTool):
        self.tools = tools
        self.tool_map = {tool.name: tool for tool in tools}

    def to_params(self) -> List[Dict[str, Any]]:
        return [tool.to_param() for tool in self.tools]

    async def execute(self, *, name: str, tool_input: Dict[str, Any] = None) -> ToolResult:
        tool = self.tool_map.get(name)
        if not tool:
            return ToolResult(error=f"Tool {name} is invalid")
        return await tool(**(tool_input or {}))

    def add_tool(self, tool: BaseTool):
        if tool.name not in self.tool_map:
            self.tools += (tool,)
            self.tool_map[tool.name] = tool
        return self
```

#### 具体工具示例

```python
class MySearchTool(BaseTool):
    name: str = "search"
    description: str = "Search the web for information"
    parameters: dict = {
        "type": "object",
        "properties": {
            "query": {"type": "string", "description": "Search query"},
            "num_results": {"type": "integer", "description": "Number of results", "default": 5},
        },
        "required": ["query"],
    }

    async def execute(self, query: str, num_results: int = 5, **kwargs) -> ToolResult:
        # 实际搜索逻辑
        results = await do_search(query, num_results)
        return ToolResult(output=json.dumps(results))
```

### 3.3 适用场景

| 场景 | 适用度 | 说明 |
|------|--------|------|
| OpenAI function calling Agent | ⭐⭐⭐ | to_param() 直接对接，零转换成本 |
| 需要 MCP 远程工具扩展 | ⭐⭐⭐ | MCPClients 继承 ToolCollection，无缝集成 |
| 多 Agent 共享工具集 | ⭐⭐ | ToolCollection 实例可在 Agent 间传递，但无工具隔离机制 |
| 需要工具权限控制 | ⭐ | 仅有 special_tool_names 机制，无细粒度权限 |
| 非 OpenAI 格式的 LLM | ⭐⭐ | 需要额外适配 to_param() 输出格式 |

---

## 第 4 章 测试用例

```python
import pytest
import json
from unittest.mock import AsyncMock, MagicMock, patch


class TestBaseTool:
    """测试 BaseTool 抽象基类"""

    def test_to_param_format(self):
        """验证 to_param() 输出 OpenAI function calling 标准格式"""
        class DummyTool(BaseTool):
            name: str = "test_tool"
            description: str = "A test tool"
            parameters: dict = {
                "type": "object",
                "properties": {"input": {"type": "string"}},
                "required": ["input"],
            }
            async def execute(self, **kwargs): return ToolResult(output="ok")

        tool = DummyTool()
        param = tool.to_param()
        assert param["type"] == "function"
        assert param["function"]["name"] == "test_tool"
        assert param["function"]["description"] == "A test tool"
        assert "properties" in param["function"]["parameters"]

    @pytest.mark.asyncio
    async def test_callable_delegates_to_execute(self):
        """验证 __call__ 委托给 execute()"""
        class EchoTool(BaseTool):
            name: str = "echo"
            description: str = "Echo input"
            async def execute(self, msg: str = "", **kwargs):
                return ToolResult(output=msg)

        tool = EchoTool()
        result = await tool(msg="hello")
        assert result.output == "hello"


class TestToolResult:
    """测试 ToolResult 结果容器"""

    def test_add_combines_outputs(self):
        r1 = ToolResult(output="part1 ")
        r2 = ToolResult(output="part2")
        combined = r1 + r2
        assert combined.output == "part1 part2"

    def test_str_shows_error_when_present(self):
        r = ToolResult(error="something failed")
        assert str(r) == "Error: something failed"

    def test_str_shows_output_when_no_error(self):
        r = ToolResult(output="success")
        assert str(r) == "success"

    def test_bool_false_when_empty(self):
        r = ToolResult()
        assert not r


class TestToolCollection:
    """测试 ToolCollection 注册表"""

    @pytest.mark.asyncio
    async def test_execute_unknown_tool_returns_failure(self):
        collection = ToolCollection()
        result = await collection.execute(name="nonexistent", tool_input={})
        assert result.error == "Tool nonexistent is invalid"

    def test_add_tool_skips_duplicate(self):
        class DummyTool(BaseTool):
            name: str = "dup"
            description: str = "dup"
            async def execute(self, **kwargs): pass

        collection = ToolCollection(DummyTool())
        collection.add_tool(DummyTool())  # 同名，应跳过
        assert len(collection.tools) == 1

    def test_to_params_returns_all_tools(self):
        class T1(BaseTool):
            name: str = "t1"; description: str = "t1"
            async def execute(self, **kwargs): pass
        class T2(BaseTool):
            name: str = "t2"; description: str = "t2"
            async def execute(self, **kwargs): pass

        collection = ToolCollection(T1(), T2())
        params = collection.to_params()
        assert len(params) == 2
        assert params[0]["function"]["name"] == "t1"


class TestMCPClientTool:
    """测试 MCP 远程工具代理"""

    @pytest.mark.asyncio
    async def test_execute_without_session_returns_error(self):
        tool = MCPClientTool(
            name="remote_tool", description="test",
            session=None, server_id="s1", original_name="tool1"
        )
        result = await tool.execute(param="value")
        assert result.error == "Not connected to MCP server"

    @pytest.mark.asyncio
    async def test_execute_delegates_to_session(self):
        mock_session = AsyncMock()
        mock_result = MagicMock()
        mock_result.content = [MagicMock(text="result text", spec=["text"])]
        mock_session.call_tool.return_value = mock_result

        tool = MCPClientTool(
            name="remote_tool", description="test",
            session=mock_session, server_id="s1", original_name="real_name"
        )
        result = await tool.execute(param="value")
        mock_session.call_tool.assert_called_once_with("real_name", {"param": "value"})
        assert result.output == "result text"
```

