# PD-09.04 OpenManus — AskHuman 工具式人机交互

> 文档编号：PD-09.04
> 来源：OpenManus `app/tool/ask_human.py` / `app/agent/manus.py`
> GitHub：https://github.com/FoundationAgents/OpenManus.git
> 问题域：PD-09 Human-in-the-Loop
> 状态：可复用方案

---

## 第 1 章 问题与动机（≥ 30 行）

### 1.1 核心问题

Agent 在自主执行任务时，会遇到信息不足、决策不确定或需要外部确认的场景。如果 Agent 只能在任务开始前接收一次用户输入，那么在执行过程中遇到歧义或缺失信息时，只能猜测或放弃。这导致两个问题：

1. **信息断层**：Agent 无法在执行中途获取用户补充信息，只能基于初始 prompt 推断
2. **极端情况处理**：当所有工具都无法解决问题时，Agent 没有"求助"通道

OpenManus 的系统 prompt 明确将 human interaction 定位为"only for extreme cases"（`app/prompt/manus.py:2`），这意味着 AskHuman 不是主要交互方式，而是一个安全网——当 Agent 的自主能力不足以完成任务时的最后手段。

### 1.2 OpenManus 的解法概述

OpenManus 采用了极简的"工具即交互"方案：

1. **AskHuman 作为普通工具**：将人机交互实现为一个标准 BaseTool 子类，与 PythonExecute、BrowserUseTool 等工具平级（`app/tool/ask_human.py:4`）
2. **LLM 自主决策调用时机**：不预设暂停点，由 LLM 在 ReAct 循环中自行判断何时需要人工介入（`app/agent/toolcall.py:39-77`）
3. **同步阻塞式输入**：通过 Python 内置 `input()` 函数直接阻塞等待终端输入（`app/tool/ask_human.py:21`）
4. **默认工具集成员**：AskHuman 被包含在 Manus 和 SandboxManus 的默认工具集中（`app/agent/manus.py:39`，`app/agent/sandbox_agent.py:42`）
5. **A2A 协议暴露**：在 Agent-to-Agent 协议中作为独立 Skill 注册（`protocol/a2a/app/main.py:56-60`）

### 1.3 设计思想

| 设计原则 | 具体实现 | 理由 | 替代方案 |
|----------|----------|------|----------|
| 工具统一性 | AskHuman 继承 BaseTool，遵循相同的 name/description/parameters/execute 接口 | 不需要为人机交互引入特殊机制，复用已有工具调用管道 | 专用 interrupt 节点（如 LangGraph interrupt） |
| LLM 自主判断 | 不硬编码暂停点，由 LLM 根据 system prompt 中"only for extreme cases"的指引自行决定 | 最大化 Agent 自主性，减少不必要的人工打断 | 规则引擎预定义暂停条件 |
| 同步阻塞 | `input()` 直接阻塞当前协程（async 函数中调用同步 input） | 实现最简单，适合 CLI 场景 | WebSocket/SSE 异步等待 |
| 最小参数 | 只有一个 `inquire` 字符串参数 | 保持工具接口简洁，问题格式由 LLM 自由组织 | 结构化问题类型（选择题/填空/确认） |

---

## 第 2 章 源码实现分析（≥ 60 行，核心章节）

### 2.1 架构概览

OpenManus 的人机交互通过标准的 ReAct 工具调用管道实现，AskHuman 与其他工具共享完全相同的执行路径：

```
┌─────────────────────────────────────────────────────────┐
│                    BaseAgent.run()                       │
│                   (执行主循环)                            │
│  ┌─────────────────────────────────────────────────┐    │
│  │  while step < max_steps && state != FINISHED:   │    │
│  │    step() → think() + act()                     │    │
│  └─────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────┐
│              ToolCallAgent.think()                       │
│  LLM 决定调用哪些工具（含 ask_human）                     │
│  response = llm.ask_tool(tools=available_tools)         │
└─────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────┐
│              ToolCallAgent.act()                         │
│  for command in tool_calls:                             │
│    result = execute_tool(command)                       │
│    ┌──────────────────────────────────────────┐         │
│    │ if name == "ask_human":                  │         │
│    │   → AskHuman.execute(inquire=...)        │         │
│    │   → input("Bot: {inquire}\n\nYou: ")     │         │
│    │   → 阻塞等待用户终端输入                   │         │
│    │   → 返回用户输入文本                       │         │
│    └──────────────────────────────────────────┘         │
│    memory.add_message(tool_message(result))             │
└─────────────────────────────────────────────────────────┘
                          │
                          ▼
              下一轮 think() 可以看到用户回复
```

### 2.2 核心实现

**AskHuman 工具定义** (`app/tool/ask_human.py:1-22`)：

```python
from app.tool import BaseTool


class AskHuman(BaseTool):
    """Add a tool to ask human for help."""

    name: str = "ask_human"
    description: str = "Use this tool to ask human for help."
    parameters: str = {
        "type": "object",
        "properties": {
            "inquire": {
                "type": "string",
                "description": "The question you want to ask human.",
            }
        },
        "required": ["inquire"],
    }

    async def execute(self, inquire: str) -> str:
        return input(f"""Bot: {inquire}\n\nYou: """).strip()
```

这是整个人机交互的全部实现——22 行代码。核心设计决策：

- `parameters` 使用标准 OpenAI function calling JSON Schema 格式，只有一个 `inquire` 字段
- `execute` 是 async 方法但内部调用同步 `input()`，这会阻塞事件循环
- 返回值是 `str`（不是 `ToolResult`），由 `ToolCollection.execute()` 透传

**工具注册到 Manus Agent** (`app/agent/manus.py:34-42`)：

```python
available_tools: ToolCollection = Field(
    default_factory=lambda: ToolCollection(
        PythonExecute(),
        BrowserUseTool(),
        StrReplaceEditor(),
        AskHuman(),        # 人机交互工具，与其他工具平级
        Terminate(),
    )
)
```

AskHuman 在工具列表中排在第 4 位（倒数第 2），排在 Terminate 之前。这个顺序暗示了使用优先级：先尝试代码执行、浏览器、文件编辑，实在不行才问人，最后终止。

**工具执行管道** (`app/agent/toolcall.py:166-208`)：

```python
async def execute_tool(self, command: ToolCall) -> str:
    """Execute a single tool call with robust error handling"""
    if not command or not command.function or not command.function.name:
        return "Error: Invalid command format"

    name = command.function.name
    if name not in self.available_tools.tool_map:
        return f"Error: Unknown tool '{name}'"

    try:
        args = json.loads(command.function.arguments or "{}")
        logger.info(f"🔧 Activating tool: '{name}'...")
        result = await self.available_tools.execute(name=name, tool_input=args)
        await self._handle_special_tool(name=name, result=result)

        observation = (
            f"Observed output of cmd `{name}` executed:\n{str(result)}"
            if result
            else f"Cmd `{name}` completed with no output"
        )
        return observation
    except json.JSONDecodeError:
        error_msg = f"Error parsing arguments for {name}: Invalid JSON format"
        return f"Error: {error_msg}"
    except Exception as e:
        error_msg = f"⚠️ Tool '{name}' encountered a problem: {str(e)}"
        return f"Error: {error_msg}"
```

关键观察：AskHuman 不在 `special_tool_names` 中（只有 Terminate 是特殊工具），所以 `_handle_special_tool` 不会对 ask_human 做任何状态变更。用户的回复被包装为 `"Observed output of cmd 'ask_human' executed:\n{用户输入}"` 格式的 tool message，添加到 memory 中。

### 2.3 实现细节

**ReAct 循环中的交互流** (`app/agent/react.py:33-38`, `app/agent/base.py:136-148`)：

```
Step N: think() → LLM 决定调用 ask_human(inquire="请问你想要什么格式？")
        act()   → execute_tool("ask_human", {inquire: "..."})
                → AskHuman.execute() → input() 阻塞
                → 用户输入 "PDF 格式"
                → tool_message 写入 memory
Step N+1: think() → LLM 看到用户回复，继续执行
```

**SandboxManus 中的复用** (`app/agent/sandbox_agent.py:37-44`)：

SandboxManus 同样将 AskHuman 作为默认工具，但注意它的工具集更精简——本地工具（PythonExecute、BrowserUseTool、StrReplaceEditor）被注释掉，替换为沙箱工具（SandboxBrowserTool、SandboxFilesTool 等），但 AskHuman 保留不变。这说明 AskHuman 是跨环境通用的。

**A2A 协议中的暴露** (`protocol/a2a/app/main.py:56-60`)：

```python
AgentSkill(
    id="Ask human",
    name="Ask human Tool",
    description="Use this tool to ask human for help.",
    tags=["Ask human for help"],
    examples=["Ask human: 'What time is it?'"],
),
```

在 Agent-to-Agent 协议中，AskHuman 被注册为一个独立的 AgentSkill，这意味着远程 Agent 也可以通过 A2A 协议触发人机交互。

**系统 prompt 的约束** (`app/prompt/manus.py:2`)：

```
"Whether it's programming, information retrieval, file processing,
web browsing, or human interaction (only for extreme cases), you can handle it all."
```

"only for extreme cases" 是唯一的使用约束，完全依赖 LLM 的判断力。没有硬编码的触发条件或频率限制。

---

## 第 3 章 迁移指南（≥ 40 行）

### 3.1 迁移清单

**阶段 1：基础工具实现**
- [ ] 创建 AskHuman 工具类，继承项目的 BaseTool
- [ ] 实现 execute 方法，根据运行环境选择输入方式（CLI/Web/API）
- [ ] 定义 parameters JSON Schema

**阶段 2：集成到 Agent 工具集**
- [ ] 将 AskHuman 添加到 Agent 的 available_tools
- [ ] 在 system prompt 中添加使用指引（何时该问人）
- [ ] 确保工具执行结果正确写入 memory

**阶段 3：增强（可选）**
- [ ] 添加超时机制（避免永久阻塞）
- [ ] 支持结构化问题类型（选择题、确认、自由文本）
- [ ] 添加异步输入支持（WebSocket/SSE）
- [ ] 添加多通道路由（终端/Web/Slack）

### 3.2 适配代码模板

**基础版：CLI 场景（与 OpenManus 等价）**

```python
import asyncio
from abc import ABC, abstractmethod
from typing import Any, Dict, Optional
from pydantic import BaseModel


class BaseTool(BaseModel, ABC):
    name: str
    description: str
    parameters: Optional[dict] = None

    @abstractmethod
    async def execute(self, **kwargs) -> Any:
        pass

    def to_param(self) -> Dict:
        return {
            "type": "function",
            "function": {
                "name": self.name,
                "description": self.description,
                "parameters": self.parameters,
            },
        }


class AskHuman(BaseTool):
    """最简人机交互工具 — 适用于 CLI Agent"""

    name: str = "ask_human"
    description: str = "Ask the human user for help when you cannot proceed autonomously."
    parameters: dict = {
        "type": "object",
        "properties": {
            "question": {
                "type": "string",
                "description": "The question to ask the human user.",
            }
        },
        "required": ["question"],
    }

    async def execute(self, question: str) -> str:
        # 在事件循环中运行同步 input，避免阻塞
        loop = asyncio.get_event_loop()
        response = await loop.run_in_executor(
            None, lambda: input(f"\n🤖 Agent: {question}\n👤 You: ").strip()
        )
        return response if response else "(no response)"
```

**增强版：带超时 + 结构化问题**

```python
import asyncio
from enum import Enum
from typing import Optional


class QuestionType(str, Enum):
    FREE_TEXT = "free_text"
    YES_NO = "yes_no"
    CHOICE = "choice"


class AskHumanWithTimeout(BaseTool):
    """带超时和结构化问题的人机交互工具"""

    name: str = "ask_human"
    description: str = "Ask the human user for help. Use sparingly, only when stuck."
    parameters: dict = {
        "type": "object",
        "properties": {
            "question": {"type": "string", "description": "Question to ask"},
            "question_type": {
                "type": "string",
                "enum": ["free_text", "yes_no", "choice"],
                "default": "free_text",
            },
            "choices": {
                "type": "array",
                "items": {"type": "string"},
                "description": "Options for choice type questions",
            },
            "timeout_seconds": {
                "type": "integer",
                "default": 300,
                "description": "Timeout in seconds (default 5 min)",
            },
        },
        "required": ["question"],
    }

    default_timeout: int = 300  # 5 minutes

    async def execute(
        self,
        question: str,
        question_type: str = "free_text",
        choices: Optional[list] = None,
        timeout_seconds: int = 300,
    ) -> str:
        prompt = f"\n🤖 Agent asks: {question}"
        if question_type == "yes_no":
            prompt += " (yes/no)"
        elif question_type == "choice" and choices:
            for i, c in enumerate(choices, 1):
                prompt += f"\n  {i}. {c}"
            prompt += "\nEnter number"

        prompt += "\n👤 You: "

        loop = asyncio.get_event_loop()
        try:
            response = await asyncio.wait_for(
                loop.run_in_executor(None, lambda: input(prompt).strip()),
                timeout=timeout_seconds,
            )
        except asyncio.TimeoutError:
            return "(timeout: user did not respond, proceeding with default behavior)"

        if not response:
            return "(no response)"

        # 解析选择题答案
        if question_type == "choice" and choices and response.isdigit():
            idx = int(response) - 1
            if 0 <= idx < len(choices):
                return choices[idx]

        return response
```

### 3.3 适用场景

| 场景 | 适用度 | 说明 |
|------|--------|------|
| CLI 单用户 Agent | ⭐⭐⭐ | 完美匹配，input() 直接可用 |
| 本地开发助手 | ⭐⭐⭐ | 开发者在终端交互，延迟可接受 |
| Web 应用 Agent | ⭐⭐ | 需替换 input() 为 WebSocket/SSE，增加异步等待 |
| 多用户服务端 | ⭐ | input() 阻塞不适用，需完全重写为异步消息队列 |
| 批处理/无人值守 | ⭐ | 不适用，需要超时降级或完全移除 |
| Agent-to-Agent | ⭐⭐ | OpenManus 已通过 A2A 协议暴露，但实际仍需终端人工 |

---

## 第 4 章 测试用例（≥ 20 行）

```python
import asyncio
import pytest
from unittest.mock import patch, AsyncMock


# === 模拟 OpenManus 的 BaseTool 和 AskHuman ===

class BaseTool:
    def __init__(self, name, description, parameters):
        self.name = name
        self.description = description
        self.parameters = parameters

    async def execute(self, **kwargs):
        raise NotImplementedError


class AskHuman(BaseTool):
    def __init__(self):
        super().__init__(
            name="ask_human",
            description="Use this tool to ask human for help.",
            parameters={
                "type": "object",
                "properties": {
                    "inquire": {
                        "type": "string",
                        "description": "The question you want to ask human.",
                    }
                },
                "required": ["inquire"],
            },
        )

    async def execute(self, inquire: str) -> str:
        return input(f"""Bot: {inquire}\n\nYou: """).strip()


class TestAskHumanTool:
    """测试 AskHuman 工具的核心行为"""

    def test_tool_metadata(self):
        """验证工具元数据符合 OpenAI function calling 格式"""
        tool = AskHuman()
        assert tool.name == "ask_human"
        assert "inquire" in tool.parameters["properties"]
        assert tool.parameters["required"] == ["inquire"]

    @pytest.mark.asyncio
    @patch("builtins.input", return_value="PDF format please")
    async def test_normal_response(self, mock_input):
        """正常路径：用户输入被正确返回"""
        tool = AskHuman()
        result = await tool.execute(inquire="What format do you want?")
        assert result == "PDF format please"
        mock_input.assert_called_once()

    @pytest.mark.asyncio
    @patch("builtins.input", return_value="  spaced answer  ")
    async def test_strip_whitespace(self, mock_input):
        """边界情况：用户输入前后空格被 strip"""
        tool = AskHuman()
        result = await tool.execute(inquire="Question?")
        assert result == "spaced answer"

    @pytest.mark.asyncio
    @patch("builtins.input", return_value="")
    async def test_empty_response(self, mock_input):
        """边界情况：用户输入空字符串"""
        tool = AskHuman()
        result = await tool.execute(inquire="Question?")
        assert result == ""

    @pytest.mark.asyncio
    @patch("builtins.input", side_effect=EOFError)
    async def test_eof_error(self, mock_input):
        """降级行为：非交互环境（如管道输入）抛出 EOFError"""
        tool = AskHuman()
        with pytest.raises(EOFError):
            await tool.execute(inquire="Question?")

    @pytest.mark.asyncio
    @patch("builtins.input", side_effect=KeyboardInterrupt)
    async def test_keyboard_interrupt(self, mock_input):
        """降级行为：用户 Ctrl+C 中断"""
        tool = AskHuman()
        with pytest.raises(KeyboardInterrupt):
            await tool.execute(inquire="Question?")


class TestAskHumanInToolCollection:
    """测试 AskHuman 在工具集合中的集成"""

    def test_registered_in_manus_tools(self):
        """验证 AskHuman 在 Manus 默认工具集中"""
        tool = AskHuman()
        # 模拟 ToolCollection 的 tool_map
        tool_map = {tool.name: tool}
        assert "ask_human" in tool_map

    def test_not_in_special_tools(self):
        """验证 AskHuman 不是特殊工具（不会触发 FINISHED 状态）"""
        special_tool_names = ["terminate"]
        assert "ask_human" not in special_tool_names

    @pytest.mark.asyncio
    @patch("builtins.input", return_value="user reply")
    async def test_result_format_in_pipeline(self, mock_input):
        """验证工具结果在管道中的格式化"""
        tool = AskHuman()
        result = await tool.execute(inquire="Need help?")
        # 模拟 ToolCallAgent.execute_tool 的格式化
        observation = f"Observed output of cmd `ask_human` executed:\n{str(result)}"
        assert "user reply" in observation
        assert "ask_human" in observation
```

---

## 第 5 章 跨域关联

| 关联域 | 关系类型 | 说明 |
|--------|----------|------|
| PD-04 工具系统 | 依赖 | AskHuman 完全依赖 BaseTool 抽象和 ToolCollection 执行管道，工具系统的设计直接决定了人机交互的实现方式 |
| PD-01 上下文管理 | 协同 | 用户回复作为 tool_message 写入 Memory，受 `max_messages=100` 限制（`app/schema.py:162`），长对话中早期的人机交互可能被截断 |
| PD-02 多 Agent 编排 | 协同 | PlanningFlow 中每个 step 由独立 Agent 执行，每个 Agent 都可以调用 AskHuman，但 PlanningFlow 本身不协调人机交互 |
| PD-03 容错与重试 | 互补 | AskHuman 的 input() 没有超时保护，如果用户不响应会永久阻塞；需要 PD-03 的超时机制来补充 |
| PD-05 沙箱隔离 | 独立 | SandboxManus 在沙箱环境中运行，但 AskHuman 的 input() 仍然读取宿主机终端，不受沙箱隔离影响 |
| PD-11 可观测性 | 协同 | 工具调用通过 logger.info 记录（`app/agent/toolcall.py:180`），但没有专门的人机交互指标（如响应时间、交互频率） |

---

## 第 6 章 来源文件索引

| 文件 | 行范围 | 关键实现 |
|------|--------|----------|
| `app/tool/ask_human.py` | L1-22 | AskHuman 工具完整实现（22 行） |
| `app/tool/base.py` | L78-138 | BaseTool 抽象基类，定义 name/description/parameters/execute 接口 |
| `app/tool/tool_collection.py` | L9-72 | ToolCollection 工具集合，execute() 方法分发工具调用 |
| `app/agent/manus.py` | L34-42 | Manus Agent 默认工具集，AskHuman 在第 4 位 |
| `app/agent/sandbox_agent.py` | L37-44 | SandboxManus 工具集，AskHuman 保留 |
| `app/agent/toolcall.py` | L39-77 | think() 方法，LLM 决定调用哪些工具 |
| `app/agent/toolcall.py` | L131-164 | act() 方法，遍历 tool_calls 执行工具 |
| `app/agent/toolcall.py` | L166-208 | execute_tool() 方法，单个工具执行 + 错误处理 |
| `app/agent/react.py` | L33-38 | ReAct step() = think() + act() |
| `app/agent/base.py` | L116-154 | BaseAgent.run() 主循环，max_steps 限制 |
| `app/prompt/manus.py` | L1-10 | 系统 prompt，"human interaction (only for extreme cases)" |
| `app/schema.py` | L159-168 | Memory 类，max_messages=100 限制 |
| `protocol/a2a/app/main.py` | L56-60 | A2A 协议中 AskHuman 作为 AgentSkill 注册 |

---

## 第 7 章 横向对比维度

> **重要：** 本章用于自动填充 Butcher Wiki 的横向对比表。
> 必须严格按以下 JSON 格式输出，放在 `comparison_data` 代码块中。

```json comparison_data
{
  "project": "OpenManus",
  "dimensions": {
    "暂停机制": "无显式暂停，LLM 自主决定调用 ask_human 工具",
    "澄清类型": "自由文本，单一 inquire 字符串参数",
    "状态持久化": "无持久化，input() 同步阻塞等待",
    "实现层级": "工具层，AskHuman 继承 BaseTool",
    "身份绑定": "无，终端 input() 无身份验证",
    "多通道转发": "仅终端 stdin，A2A 协议可暴露但未实现路由"
  }
}
```

### 域元数据补充

```json domain_metadata
{
  "solution_summary": "OpenManus 将人机交互实现为 22 行的 AskHuman BaseTool，通过 input() 同步阻塞等待终端输入，由 LLM 在 ReAct 循环中自主决定调用时机",
  "description": "工具化人机交互：将 human-in-the-loop 降维为普通工具调用",
  "sub_problems": [
    "工具优先级排序：多工具并存时如何引导 LLM 优先使用自主工具而非求助人工",
    "跨环境适配：同一 AskHuman 接口在 CLI/沙箱/A2A 不同运行环境下的输入源切换"
  ],
  "best_practices": [
    "工具即交互：将人机交互实现为标准工具而非特殊节点，复用已有工具管道零成本集成",
    "prompt 约束优于硬编码：用 system prompt 中 'only for extreme cases' 引导 LLM 控制调用频率，而非代码层面限制"
  ]
}
```
