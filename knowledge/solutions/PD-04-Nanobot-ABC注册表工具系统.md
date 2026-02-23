# PD-04.06 Nanobot — ABC 基类 + ToolRegistry 动态注册工具系统

> 文档编号：PD-04.06
> 来源：Nanobot `nanobot/agent/tools/`
> GitHub：https://github.com/HKUDS/nanobot.git
> 问题域：PD-04 工具系统 Tool System Design
> 状态：可复用方案

---

## 第 1 章 问题与动机

### 1.1 核心问题

Agent 工具系统需要解决三个层次的问题：

1. **工具定义标准化** — 每个工具需要统一的 name/description/parameters/execute 接口，LLM 才能通过 function calling 正确选择和调用
2. **工具生命周期管理** — 工具的注册、发现、执行、卸载需要一个中心化的注册表来协调
3. **工具安全边界** — shell 执行、文件操作等危险工具需要内置安全防护（deny patterns、路径限制、超时保护）

Nanobot 作为一个多渠道（Telegram/Discord/Slack/CLI 等）Agent 框架，其工具系统需要同时服务于主 Agent 和子 Agent（subagent），且支持通过 MCP 协议动态扩展外部工具。

### 1.2 Nanobot 的解法概述

1. **Tool ABC 基类** — `base.py:7` 定义抽象基类，强制所有工具实现 `name`/`description`/`parameters`/`execute` 四个接口，并内置 JSON Schema 参数校验（`validate_params`）和 OpenAI function schema 转换（`to_schema`）
2. **ToolRegistry 注册表** — `registry.py:8` 实现字典式注册表，提供 register/unregister/get/execute 操作，execute 内置参数校验 + 异常捕获
3. **分层工具集** — 主 Agent 拥有全部 9 个工具（含 message/spawn/cron），子 Agent 仅注册 7 个安全工具（无 message/spawn），通过代码级隔离实现权限控制
4. **MCP 协议桥接** — `mcp.py:14` 的 MCPToolWrapper 将外部 MCP 服务器的工具包装为原生 Tool 实例，透明注入 ToolRegistry
5. **内置安全防护** — ExecTool 的 deny_patterns 正则黑名单 + restrict_to_workspace 路径沙箱 + 超时 kill

### 1.3 设计思想

| 设计原则 | 具体实现 | 理由 | 替代方案 |
|----------|----------|------|----------|
| ABC 强制接口 | Tool 抽象基类 4 个 abstractmethod | 编译期保证所有工具实现完整接口 | 鸭子类型（运行时才发现缺失） |
| 注册表模式 | ToolRegistry 字典存储 + name 索引 | O(1) 查找，支持动态增删 | 硬编码工具列表（不可扩展） |
| 代码级权限隔离 | 子 Agent 不注册 message/spawn 工具 | 从根本上阻止子 Agent 发消息或递归 spawn | 运行时权限检查（可被绕过） |
| 参数校验前置 | execute 前调用 validate_params | 避免无效参数传入工具导致不可预期错误 | 让工具自行校验（不一致） |
| 安全正则黑名单 | ExecTool deny_patterns 9 条规则 | 阻止 rm -rf、fork bomb 等破坏性命令 | 白名单（过于严格） |

---

## 第 2 章 源码实现分析

### 2.1 架构概览

```
┌─────────────────────────────────────────────────────┐
│                    AgentLoop                         │
│  ┌───────────────────────────────────────────────┐  │
│  │              ToolRegistry                      │  │
│  │  ┌──────────┬──────────┬──────────┬────────┐  │  │
│  │  │read_file │write_file│edit_file │list_dir│  │  │
│  │  ├──────────┼──────────┼──────────┼────────┤  │  │
│  │  │  exec    │web_search│web_fetch │message │  │  │
│  │  ├──────────┼──────────┼──────────┼────────┤  │  │
│  │  │  spawn   │  cron    │mcp_*    │  ...   │  │  │
│  │  └──────────┴──────────┴──────────┴────────┘  │  │
│  └───────────────────────────────────────────────┘  │
│                        │                             │
│              get_definitions() → LLM                 │
│              execute(name, params) ← LLM             │
│                        │                             │
│  ┌─────────────────────┴─────────────────────────┐  │
│  │           SubagentManager                      │  │
│  │  ┌─────────────────────────────────────────┐  │  │
│  │  │  子 ToolRegistry（无 message/spawn/cron）│  │  │
│  │  └─────────────────────────────────────────┘  │  │
│  └───────────────────────────────────────────────┘  │
│                                                      │
│  ┌───────────────────────────────────────────────┐  │
│  │  MCP Bridge (lazy connect)                     │  │
│  │  MCPToolWrapper → registry.register()          │  │
│  └───────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────┘
```

### 2.2 核心实现

#### Tool ABC 基类 (`nanobot/agent/tools/base.py:7-102`)

Tool 基类定义了所有工具必须实现的 4 个抽象接口，并提供两个通用方法：

```python
class Tool(ABC):
    _TYPE_MAP = {
        "string": str, "integer": int, "number": (int, float),
        "boolean": bool, "array": list, "object": dict,
    }

    @property
    @abstractmethod
    def name(self) -> str: ...

    @property
    @abstractmethod
    def description(self) -> str: ...

    @property
    @abstractmethod
    def parameters(self) -> dict[str, Any]: ...

    @abstractmethod
    async def execute(self, **kwargs: Any) -> str: ...

    def validate_params(self, params: dict[str, Any]) -> list[str]:
        """递归校验参数，支持 enum/min/max/minLength/maxLength/required/nested"""
        schema = self.parameters or {}
        return self._validate(params, {**schema, "type": "object"}, "")

    def to_schema(self) -> dict[str, Any]:
        """转换为 OpenAI function calling 格式"""
        return {
            "type": "function",
            "function": {"name": self.name, "description": self.description,
                         "parameters": self.parameters}
        }
```

关键设计点：
- `validate_params` (`base.py:55-60`) 在 ToolRegistry.execute 中被调用，校验发生在工具执行之前
- `_validate` (`base.py:62-91`) 递归处理嵌套 object 和 array，支持完整的 JSON Schema 子集
- `to_schema` (`base.py:93-102`) 输出 OpenAI function calling 标准格式，直接传给 LLM provider

#### ToolRegistry 注册表 (`nanobot/agent/tools/registry.py:8-73`)

```python
class ToolRegistry:
    def __init__(self):
        self._tools: dict[str, Tool] = {}

    def register(self, tool: Tool) -> None:
        self._tools[tool.name] = tool

    def unregister(self, name: str) -> None:
        self._tools.pop(name, None)

    def get_definitions(self) -> list[dict[str, Any]]:
        return [tool.to_schema() for tool in self._tools.values()]

    async def execute(self, name: str, params: dict[str, Any]) -> str:
        tool = self._tools.get(name)
        if not tool:
            return f"Error: Tool '{name}' not found"
        try:
            errors = tool.validate_params(params)
            if errors:
                return f"Error: Invalid parameters for tool '{name}': " + "; ".join(errors)
            return await tool.execute(**params)
        except Exception as e:
            return f"Error executing {name}: {str(e)}"
```

关键设计点：
- 字典存储，name 为 key，O(1) 查找和注册
- `execute` 方法内置三层防护：工具存在性检查 → 参数校验 → 异常捕获
- 错误返回字符串而非抛异常，LLM 可以看到错误信息并自行修正

#### 主 Agent 工具注册 (`nanobot/agent/loop.py:104-119`)

```python
def _register_default_tools(self) -> None:
    allowed_dir = self.workspace if self.restrict_to_workspace else None
    for cls in (ReadFileTool, WriteFileTool, EditFileTool, ListDirTool):
        self.tools.register(cls(workspace=self.workspace, allowed_dir=allowed_dir))
    self.tools.register(ExecTool(
        working_dir=str(self.workspace), timeout=self.exec_config.timeout,
        restrict_to_workspace=self.restrict_to_workspace,
    ))
    self.tools.register(WebSearchTool(api_key=self.brave_api_key))
    self.tools.register(WebFetchTool())
    self.tools.register(MessageTool(send_callback=self.bus.publish_outbound))
    self.tools.register(SpawnTool(manager=self.subagents))
    if self.cron_service:
        self.tools.register(CronTool(self.cron_service))
```

### 2.3 实现细节

#### 安全防护：ExecTool 的 deny_patterns (`nanobot/agent/tools/shell.py:25-36`)

ExecTool 内置 9 条正则黑名单，在命令执行前拦截危险操作：

```python
self.deny_patterns = deny_patterns or [
    r"\brm\s+-[rf]{1,2}\b",          # rm -r, rm -rf
    r"\bdel\s+/[fq]\b",              # Windows del /f
    r"\brmdir\s+/s\b",               # Windows rmdir /s
    r"(?:^|[;&|]\s*)format\b",       # format 命令
    r"\b(mkfs|diskpart)\b",          # 磁盘操作
    r"\bdd\s+if=",                   # dd 写盘
    r">\s*/dev/sd",                  # 写入磁盘设备
    r"\b(shutdown|reboot|poweroff)\b",  # 系统电源
    r":\(\)\s*\{.*\};\s*:",          # fork bomb
]
```

安全防护链 (`shell.py:64-68`)：
1. `_guard_command` 先检查 deny_patterns
2. 再检查 allow_patterns（如果配置了白名单）
3. `restrict_to_workspace` 模式下检查路径遍历和绝对路径越界
4. 执行时 `asyncio.wait_for` 超时保护，超时后 `process.kill()`

#### MCP 协议桥接 (`nanobot/agent/tools/mcp.py:14-101`)

MCPToolWrapper 将 MCP 服务器工具包装为原生 Tool：

```python
class MCPToolWrapper(Tool):
    def __init__(self, session, server_name: str, tool_def, tool_timeout: int = 30):
        self._session = session
        self._name = f"mcp_{server_name}_{tool_def.name}"  # 命名空间隔离
        self._description = tool_def.description or tool_def.name
        self._parameters = tool_def.inputSchema or {"type": "object", "properties": {}}
        self._tool_timeout = tool_timeout

    async def execute(self, **kwargs: Any) -> str:
        result = await asyncio.wait_for(
            self._session.call_tool(self._original_name, arguments=kwargs),
            timeout=self._tool_timeout,
        )
        # 解析 MCP TextContent 为纯文本
        parts = [block.text if isinstance(block, types.TextContent) else str(block)
                 for block in result.content]
        return "\n".join(parts) or "(no output)"
```

MCP 连接策略 (`loop.py:121-141`)：
- **懒加载**：首次处理消息时才连接 MCP 服务器（`_connect_mcp` 在 `run()` 和 `process_direct()` 中调用）
- **双传输**：支持 stdio（本地进程）和 streamable HTTP（远程服务）两种连接方式
- **容错**：单个 MCP 服务器连接失败不影响其他服务器，错误仅 log 不抛异常
- **命名空间**：工具名前缀 `mcp_{server_name}_` 避免与内置工具冲突

#### 子 Agent 工具隔离 (`nanobot/agent/subagent.py:103-116`)

子 Agent 创建独立的 ToolRegistry，只注册安全工具子集：

```
主 Agent:  read_file, write_file, edit_file, list_dir, exec, web_search, web_fetch, message, spawn, cron
子 Agent:  read_file, write_file, edit_file, list_dir, exec, web_search, web_fetch
```

子 Agent 无法：发消息给用户（无 message）、递归创建子 Agent（无 spawn）、创建定时任务（无 cron）。

#### 工具上下文注入 (`nanobot/agent/loop.py:143-155`)

每次处理消息前，`_set_tool_context` 将当前 channel/chat_id 注入需要路由信息的工具：

```python
def _set_tool_context(self, channel: str, chat_id: str, message_id: str | None = None):
    if message_tool := self.tools.get("message"):
        message_tool.set_context(channel, chat_id, message_id)
    if spawn_tool := self.tools.get("spawn"):
        spawn_tool.set_context(channel, chat_id)
    if cron_tool := self.tools.get("cron"):
        cron_tool.set_context(channel, chat_id)
```

这种模式让工具无需感知消息路由细节，由 AgentLoop 统一注入。

---

## 第 3 章 迁移指南

### 3.1 迁移清单

**阶段 1：核心框架（必须）**
- [ ] 复制 `Tool` ABC 基类（含 `validate_params` 和 `to_schema`）
- [ ] 复制 `ToolRegistry` 注册表
- [ ] 实现至少一个具体工具验证流程

**阶段 2：内置工具（按需）**
- [ ] ExecTool — shell 执行 + deny_patterns 安全防护
- [ ] ReadFileTool/WriteFileTool/EditFileTool — 文件操作三件套
- [ ] WebSearchTool/WebFetchTool — 网络搜索与抓取

**阶段 3：高级特性（可选）**
- [ ] MCPToolWrapper — MCP 协议桥接
- [ ] SpawnTool — 子 Agent 工具隔离
- [ ] CronTool — 定时任务调度

### 3.2 适配代码模板

最小可运行的工具系统框架：

```python
from abc import ABC, abstractmethod
from typing import Any


class Tool(ABC):
    """工具基类 — 从 nanobot 提取的最小版本"""

    @property
    @abstractmethod
    def name(self) -> str: ...

    @property
    @abstractmethod
    def description(self) -> str: ...

    @property
    @abstractmethod
    def parameters(self) -> dict[str, Any]: ...

    @abstractmethod
    async def execute(self, **kwargs: Any) -> str: ...

    def to_schema(self) -> dict[str, Any]:
        return {
            "type": "function",
            "function": {
                "name": self.name,
                "description": self.description,
                "parameters": self.parameters,
            },
        }


class ToolRegistry:
    """工具注册表 — 从 nanobot 提取"""

    def __init__(self):
        self._tools: dict[str, Tool] = {}

    def register(self, tool: Tool) -> None:
        self._tools[tool.name] = tool

    def get_definitions(self) -> list[dict[str, Any]]:
        return [t.to_schema() for t in self._tools.values()]

    async def execute(self, name: str, params: dict[str, Any]) -> str:
        tool = self._tools.get(name)
        if not tool:
            return f"Error: Tool '{name}' not found"
        try:
            return await tool.execute(**params)
        except Exception as e:
            return f"Error executing {name}: {e}"


# 使用示例
class MyCustomTool(Tool):
    name = "my_tool"
    description = "A custom tool that does something useful."
    parameters = {
        "type": "object",
        "properties": {
            "input": {"type": "string", "description": "The input to process"},
        },
        "required": ["input"],
    }

    async def execute(self, input: str, **kwargs: Any) -> str:
        return f"Processed: {input}"


# 注册并使用
registry = ToolRegistry()
registry.register(MyCustomTool())
definitions = registry.get_definitions()  # 传给 LLM
result = await registry.execute("my_tool", {"input": "hello"})
```

### 3.3 适用场景

| 场景 | 适用度 | 说明 |
|------|--------|------|
| 需要 function calling 的 Agent | ⭐⭐⭐ | ABC + Registry 是最直接的实现方式 |
| 多 Agent 共享工具但需权限隔离 | ⭐⭐⭐ | 子 Agent 独立 Registry 模式非常适合 |
| 需要 MCP 协议扩展 | ⭐⭐⭐ | MCPToolWrapper 桥接模式可直接复用 |
| 工具数量 < 5 的简单 Agent | ⭐⭐ | 可能过度设计，直接硬编码更简单 |
| 需要工具热更新的场景 | ⭐⭐ | Registry 支持 unregister，但无事件通知机制 |
| 需要工具调用审计的场景 | ⭐ | 当前无生命周期追踪，需自行扩展 |

---

## 第 4 章 测试用例

```python
import pytest
from unittest.mock import AsyncMock, MagicMock
from typing import Any


# ---- Tool ABC 测试 ----

class DummyTool:
    """模拟 nanobot Tool ABC 的最小实现"""
    _TYPE_MAP = {"string": str, "integer": int, "object": dict, "array": list}

    def __init__(self, name="dummy", params=None):
        self._name = name
        self._params = params or {"type": "object", "properties": {}}

    @property
    def name(self): return self._name

    @property
    def description(self): return "A dummy tool"

    @property
    def parameters(self): return self._params

    async def execute(self, **kwargs): return f"ok: {kwargs}"

    def to_schema(self):
        return {"type": "function", "function": {
            "name": self.name, "description": self.description,
            "parameters": self.parameters}}

    def validate_params(self, params):
        schema = self.parameters or {}
        return self._validate(params, {**schema, "type": "object"}, "")

    def _validate(self, val, schema, path):
        t, label = schema.get("type"), path or "parameter"
        if t in self._TYPE_MAP and not isinstance(val, self._TYPE_MAP[t]):
            return [f"{label} should be {t}"]
        errors = []
        if t == "object":
            for k in schema.get("required", []):
                if k not in val:
                    errors.append(f"missing required {path + '.' + k if path else k}")
        return errors


class TestToolSchema:
    def test_to_schema_format(self):
        tool = DummyTool("test_tool")
        schema = tool.to_schema()
        assert schema["type"] == "function"
        assert schema["function"]["name"] == "test_tool"

    def test_validate_params_missing_required(self):
        tool = DummyTool(params={
            "type": "object",
            "properties": {"query": {"type": "string"}},
            "required": ["query"],
        })
        errors = tool.validate_params({})
        assert any("missing required" in e for e in errors)

    def test_validate_params_wrong_type(self):
        tool = DummyTool(params={
            "type": "object",
            "properties": {"count": {"type": "integer"}},
        })
        errors = tool.validate_params({"count": "not_int"})
        assert any("should be integer" in e for e in errors)

    def test_validate_params_valid(self):
        tool = DummyTool(params={
            "type": "object",
            "properties": {"query": {"type": "string"}},
            "required": ["query"],
        })
        errors = tool.validate_params({"query": "hello"})
        assert errors == []


# ---- ToolRegistry 测试 ----

class SimpleRegistry:
    """模拟 nanobot ToolRegistry"""
    def __init__(self):
        self._tools = {}

    def register(self, tool): self._tools[tool.name] = tool
    def unregister(self, name): self._tools.pop(name, None)
    def get(self, name): return self._tools.get(name)
    def has(self, name): return name in self._tools
    def get_definitions(self): return [t.to_schema() for t in self._tools.values()]

    async def execute(self, name, params):
        tool = self._tools.get(name)
        if not tool:
            return f"Error: Tool '{name}' not found"
        try:
            errors = tool.validate_params(params)
            if errors:
                return f"Error: Invalid parameters: " + "; ".join(errors)
            return await tool.execute(**params)
        except Exception as e:
            return f"Error executing {name}: {e}"


class TestToolRegistry:
    def test_register_and_get(self):
        reg = SimpleRegistry()
        tool = DummyTool("my_tool")
        reg.register(tool)
        assert reg.has("my_tool")
        assert reg.get("my_tool") is tool

    def test_unregister(self):
        reg = SimpleRegistry()
        reg.register(DummyTool("temp"))
        reg.unregister("temp")
        assert not reg.has("temp")

    @pytest.mark.asyncio
    async def test_execute_success(self):
        reg = SimpleRegistry()
        reg.register(DummyTool("echo"))
        result = await reg.execute("echo", {"msg": "hi"})
        assert "ok:" in result

    @pytest.mark.asyncio
    async def test_execute_not_found(self):
        reg = SimpleRegistry()
        result = await reg.execute("missing", {})
        assert "not found" in result

    @pytest.mark.asyncio
    async def test_execute_validation_error(self):
        reg = SimpleRegistry()
        reg.register(DummyTool("strict", params={
            "type": "object",
            "properties": {"q": {"type": "string"}},
            "required": ["q"],
        }))
        result = await reg.execute("strict", {})
        assert "missing required" in result

    def test_get_definitions(self):
        reg = SimpleRegistry()
        reg.register(DummyTool("a"))
        reg.register(DummyTool("b"))
        defs = reg.get_definitions()
        assert len(defs) == 2
        names = {d["function"]["name"] for d in defs}
        assert names == {"a", "b"}


# ---- ExecTool 安全防护测试 ----

class TestExecToolGuard:
    """测试 deny_patterns 安全防护逻辑"""

    DENY_PATTERNS = [
        r"\brm\s+-[rf]{1,2}\b",
        r"\b(shutdown|reboot|poweroff)\b",
        r":\(\)\s*\{.*\};\s*:",
    ]

    def _guard(self, command):
        import re
        lower = command.strip().lower()
        for pattern in self.DENY_PATTERNS:
            if re.search(pattern, lower):
                return "blocked"
        return None

    def test_block_rm_rf(self):
        assert self._guard("rm -rf /") == "blocked"

    def test_block_fork_bomb(self):
        assert self._guard(":(){ :|:& };:") == "blocked"

    def test_allow_safe_command(self):
        assert self._guard("ls -la") is None

    def test_allow_rm_without_flags(self):
        assert self._guard("rm file.txt") is None
```

---

## 第 5 章 跨域关联

| 关联域 | 关系类型 | 说明 |
|--------|----------|------|
| PD-02 多 Agent 编排 | 协同 | SpawnTool 创建子 Agent，子 Agent 拥有独立 ToolRegistry，工具隔离是编排安全的基础 |
| PD-03 容错与重试 | 协同 | ToolRegistry.execute 内置异常捕获返回错误字符串，ExecTool 超时 kill，MCP 工具超时保护 |
| PD-05 沙箱隔离 | 依赖 | ExecTool 的 restrict_to_workspace + deny_patterns 是沙箱隔离的工具层实现 |
| PD-09 Human-in-the-Loop | 协同 | MessageTool 的 set_context 机制支持多渠道消息路由，CronTool 支持定时提醒 |
| PD-01 上下文管理 | 协同 | 工具输出截断（ExecTool max_len=10000, WebFetchTool max_chars=50000）控制上下文膨胀 |

---

## 第 6 章 来源文件索引

| 文件 | 行范围 | 关键实现 |
|------|--------|----------|
| `nanobot/agent/tools/base.py` | L7-102 | Tool ABC 基类：4 个抽象接口 + validate_params + to_schema |
| `nanobot/agent/tools/registry.py` | L8-73 | ToolRegistry：register/unregister/get_definitions/execute |
| `nanobot/agent/tools/mcp.py` | L14-53 | MCPToolWrapper：MCP 工具 → 原生 Tool 桥接 |
| `nanobot/agent/tools/mcp.py` | L56-101 | connect_mcp_servers：stdio + HTTP 双传输连接 |
| `nanobot/agent/tools/shell.py` | L12-151 | ExecTool：deny_patterns + 超时 + 路径沙箱 |
| `nanobot/agent/tools/filesystem.py` | L10-245 | ReadFile/WriteFile/EditFile/ListDir 四个文件工具 |
| `nanobot/agent/tools/web.py` | L46-163 | WebSearchTool（Brave API）+ WebFetchTool（Readability） |
| `nanobot/agent/tools/message.py` | L9-108 | MessageTool：多渠道消息发送 + 上下文注入 |
| `nanobot/agent/tools/spawn.py` | L11-65 | SpawnTool：子 Agent 创建 |
| `nanobot/agent/tools/cron.py` | L10-147 | CronTool：定时任务调度（every/cron/at 三种模式） |
| `nanobot/agent/loop.py` | L104-119 | _register_default_tools：主 Agent 工具注册 |
| `nanobot/agent/loop.py` | L121-141 | _connect_mcp：MCP 懒加载连接 |
| `nanobot/agent/loop.py` | L143-155 | _set_tool_context：工具上下文注入 |
| `nanobot/agent/loop.py` | L174-231 | _run_agent_loop：工具调用循环 |
| `nanobot/agent/subagent.py` | L103-116 | 子 Agent 独立 ToolRegistry（无 message/spawn/cron） |
| `nanobot/config/schema.py` | L251-274 | ExecToolConfig/MCPServerConfig/ToolsConfig 配置 |

---

## 第 7 章 横向对比维度

```json comparison_data
{
  "project": "Nanobot",
  "dimensions": {
    "工具注册方式": "Tool ABC 基类 + ToolRegistry 字典注册表，name 索引 O(1) 查找",
    "工具分组/权限": "代码级隔离：主 Agent 9 工具，子 Agent 7 工具（无 message/spawn/cron）",
    "MCP 协议支持": "MCPToolWrapper 桥接，支持 stdio + HTTP 双传输，懒加载连接",
    "热更新/缓存": "支持 register/unregister 动态增删，无事件通知机制",
    "超时保护": "ExecTool 60s + MCP 工具 30s，超时后 kill/cancel",
    "结果摘要": "ExecTool 截断 10000 字符，WebFetch 截断 50000 字符",
    "生命周期追踪": "无显式状态追踪，错误返回字符串由 LLM 自行处理",
    "参数校验": "Tool ABC 内置 JSON Schema 递归校验，execute 前自动调用",
    "安全防护": "ExecTool 9 条正则黑名单 + 路径沙箱 + workspace 限制"
  }
}
```

### 域元数据补充

```json domain_metadata
{
  "description": "工具参数校验与安全防护是工具系统可靠性的关键环节",
  "sub_problems": [
    "工具参数校验：execute 前如何自动校验参数类型和约束",
    "工具上下文注入：多渠道场景下如何动态设置工具的路由信息",
    "子 Agent 工具隔离：如何通过独立注册表实现工具级权限控制"
  ],
  "best_practices": [
    "错误返回字符串而非抛异常：让 LLM 看到错误并自行修正",
    "MCP 工具命名空间隔离：前缀 mcp_{server}_ 避免与内置工具冲突",
    "工具输出截断：控制上下文窗口膨胀，ExecTool 和 WebFetch 各有上限"
  ]
}
```
