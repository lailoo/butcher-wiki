# PD-06.05 OpenManus — 滑动窗口消息记忆 + 单例 Token 追踪

> 文档编号：PD-06.05
> 来源：OpenManus `app/schema.py` `app/agent/base.py` `app/llm.py`
> GitHub：https://github.com/FoundationAgents/OpenManus.git
> 问题域：PD-06 记忆持久化 Memory Persistence
> 状态：可复用方案

---

## 第 1 章 问题与动机

### 1.1 核心问题

Agent 在多步执行过程中需要维护对话历史，但无限增长的消息列表会导致两个问题：
1. **上下文窗口溢出**：LLM 的 context window 有限，消息过多会超出 token 限制
2. **成本失控**：每次 LLM 调用都携带全部历史消息，token 消耗随步数线性增长
3. **循环检测困难**：Agent 可能陷入重复输出的死循环，需要基于记忆内容做检测

OpenManus 面对的场景是一个 ReAct 循环 Agent（最多 20-30 步），每步都会产生 user/assistant/tool 三类消息。如果不做记忆管理，20 步后消息列表可能包含 60+ 条消息，轻松突破 token 上限。

### 1.2 OpenManus 的解法概述

OpenManus 采用**极简主义**的记忆方案，核心设计：

1. **Pydantic Memory 模型**：`Memory` 类基于 Pydantic BaseModel，`messages` 字段为 `List[Message]`，`max_messages` 默认 100（`app/schema.py:160-161`）
2. **滑动窗口截断**：`add_message` 时检查长度，超限则保留最近 N 条（`app/schema.py:167-168`）
3. **角色工厂方法**：`Message` 类提供 `user_message`/`assistant_message`/`tool_message`/`system_message` 四个工厂方法，统一消息创建（`app/schema.py:99-129`）
4. **单例 LLM + Token 累计**：`LLM` 类用 `__new__` 单例模式按 `config_name` 缓存实例，累计追踪 `total_input_tokens` / `total_completion_tokens`（`app/llm.py:175-184`）
5. **循环检测**：`BaseAgent.is_stuck()` 基于 memory 中最近消息的内容重复度判断是否陷入死循环（`app/agent/base.py:170-186`）

### 1.3 设计思想

| 设计原则 | 具体实现 | 理由 | 替代方案 |
|----------|----------|------|----------|
| 极简优先 | Memory 仅 30 行代码，无外部依赖 | 通用 Agent 框架不预设复杂记忆需求 | LangChain Memory 模块（重量级） |
| 消息级粒度 | 以完整 Message 为最小单位管理 | 保持 OpenAI API 兼容的消息格式 | Token 级截断（破坏消息完整性） |
| 单例共享状态 | LLM 按 config_name 单例，token 计数全局累计 | 多 Agent 共享同一 LLM 时统一成本追踪 | 每个 Agent 独立 LLM 实例（计数分散） |
| 纯内存存储 | 无持久化，进程结束即丢失 | 单次任务执行场景，无需跨会话 | SQLite/Redis 持久化 |
| Pydantic 序列化 | `to_dict()` / `to_dict_list()` 支持 JSON 序列化 | 与 OpenAI API 格式对齐 | 自定义序列化协议 |

---

## 第 2 章 源码实现分析

### 2.1 架构概览

```
┌─────────────────────────────────────────────────────────┐
│                    Manus (顶层 Agent)                    │
│  max_steps=20, system_prompt, next_step_prompt          │
├─────────────────────────────────────────────────────────┤
│                  ToolCallAgent                           │
│  think(): LLM ask_tool → tool_calls                     │
│  act(): execute_tool → tool_msg → memory.add_message    │
├─────────────────────────────────────────────────────────┤
│                   ReActAgent                             │
│  step() = think() + act()                               │
├─────────────────────────────────────────────────────────┤
│                   BaseAgent                              │
│  memory: Memory    ←── 滑动窗口消息管理                   │
│  llm: LLM          ←── 单例 + Token 累计追踪             │
│  run(): while loop → step() → is_stuck() check          │
└─────────────────────────────────────────────────────────┘
         │                          │
         ▼                          ▼
┌─────────────────┐    ┌──────────────────────────┐
│  Memory          │    │  LLM (Singleton)          │
│  messages: []    │    │  _instances: Dict          │
│  max_messages:100│    │  total_input_tokens: int   │
│  add_message()   │    │  total_completion_tokens   │
│  add_messages()  │    │  token_counter: TokenCounter│
│  get_recent()    │    │  check_token_limit()       │
│  to_dict_list()  │    │  update_token_count()      │
│  clear()         │    │  count_message_tokens()    │
└─────────────────┘    └──────────────────────────┘
```

消息流转路径：
1. `BaseAgent.run()` 接收 request → `update_memory("user", request)` 写入 Memory
2. `ToolCallAgent.think()` 追加 `next_step_prompt` 为 user 消息 → 调用 `llm.ask_tool(messages=self.messages)`
3. LLM 返回 response → `memory.add_message(assistant_msg)` 写入 Memory
4. `ToolCallAgent.act()` 执行工具 → `memory.add_message(tool_msg)` 写入 Memory
5. 每步结束 `BaseAgent.run()` 调用 `is_stuck()` 检查 Memory 中是否有重复内容

### 2.2 核心实现

**Memory 类 — 滑动窗口消息管理** (`app/schema.py:159-187`)

```python
class Memory(BaseModel):
    messages: List[Message] = Field(default_factory=list)
    max_messages: int = Field(default=100)

    def add_message(self, message: Message) -> None:
        """Add a message to memory"""
        self.messages.append(message)
        # Optional: Implement message limit
        if len(self.messages) > self.max_messages:
            self.messages = self.messages[-self.max_messages :]

    def add_messages(self, messages: List[Message]) -> None:
        """Add multiple messages to memory"""
        self.messages.extend(messages)
        if len(self.messages) > self.max_messages:
            self.messages = self.messages[-self.max_messages :]

    def clear(self) -> None:
        self.messages.clear()

    def get_recent_messages(self, n: int) -> List[Message]:
        return self.messages[-n:]

    def to_dict_list(self) -> List[dict]:
        return [msg.to_dict() for msg in self.messages]
```

关键设计点：
- 截断策略是**尾部保留**（`[-max_messages:]`），丢弃最早的消息
- `add_message` 和 `add_messages` 都在写入后立即检查并截断，保证内存不会无限增长
- 没有 system message 保护机制——如果 system prompt 在消息列表头部，超限时会被截断丢失

**LLM 单例模式 — 按 config_name 缓存** (`app/llm.py:174-228`)

```python
class LLM:
    _instances: Dict[str, "LLM"] = {}

    def __new__(
        cls, config_name: str = "default", llm_config: Optional[LLMSettings] = None
    ):
        if config_name not in cls._instances:
            instance = super().__new__(cls)
            instance.__init__(config_name, llm_config)
            cls._instances[config_name] = instance
        return cls._instances[config_name]

    def __init__(self, config_name: str = "default", ...):
        if not hasattr(self, "client"):
            # ... 初始化 model, max_tokens, temperature 等
            self.total_input_tokens = 0
            self.total_completion_tokens = 0
            self.max_input_tokens = llm_config.max_input_tokens  # 可选上限
            self.tokenizer = tiktoken.encoding_for_model(self.model)
            self.token_counter = TokenCounter(self.tokenizer)
```

单例的 key 是 `config_name`（如 `"default"`, `"manus"`, `"browser"`），同一 config_name 的所有 Agent 共享同一个 LLM 实例及其 token 计数器。

**Token 累计追踪与限额保护** (`app/llm.py:238-264`)

```python
def update_token_count(self, input_tokens: int, completion_tokens: int = 0) -> None:
    self.total_input_tokens += input_tokens
    self.total_completion_tokens += completion_tokens
    logger.info(
        f"Token usage: Input={input_tokens}, Completion={completion_tokens}, "
        f"Cumulative Input={self.total_input_tokens}, "
        f"Cumulative Completion={self.total_completion_tokens}"
    )

def check_token_limit(self, input_tokens: int) -> bool:
    if self.max_input_tokens is not None:
        return (self.total_input_tokens + input_tokens) <= self.max_input_tokens
    return True
```

当 `max_input_tokens` 配置后，每次 LLM 调用前会检查累计 token 是否超限，超限则抛出 `TokenLimitExceeded` 异常（不会被 tenacity 重试）。

**循环检测 — 基于 Memory 内容去重** (`app/agent/base.py:170-186`)

```python
def is_stuck(self) -> bool:
    if len(self.memory.messages) < 2:
        return False
    last_message = self.memory.messages[-1]
    if not last_message.content:
        return False
    duplicate_count = sum(
        1
        for msg in reversed(self.memory.messages[:-1])
        if msg.role == "assistant" and msg.content == last_message.content
    )
    return duplicate_count >= self.duplicate_threshold  # default: 2
```

### 2.3 实现细节

**消息注入路径**：`BaseAgent.update_memory()` (`app/agent/base.py:84-114`) 是统一的消息写入入口，通过 role 映射到 Message 工厂方法：

```python
message_map = {
    "user": Message.user_message,
    "system": Message.system_message,
    "assistant": Message.assistant_message,
    "tool": lambda content, **kw: Message.tool_message(content, **kw),
}
```

但实际上 `ToolCallAgent` 更多直接调用 `self.memory.add_message()`（`app/agent/toolcall.py:112`, `app/agent/toolcall.py:161`），绕过了 `update_memory` 方法。这说明 `update_memory` 更多是给外部调用者（如 `run()` 中的初始 request）使用的便捷方法。

**Memory 属性代理**：`BaseAgent` 提供 `messages` property（`app/agent/base.py:188-196`），直接代理 `self.memory.messages`，使得子类可以用 `self.messages` 简写访问。

**Manus 的近期消息窗口**：`Manus.think()` 中用 `self.memory.messages[-3:]` 取最近 3 条消息判断是否在使用浏览器工具（`app/agent/manus.py:147`），这是一种轻量级的"工作记忆"模式——不需要全部历史，只看最近几步。

---

## 第 3 章 迁移指南

### 3.1 迁移清单

**阶段 1：基础记忆（1 个文件）**
- [ ] 复制 `Memory` 和 `Message` 类到目标项目
- [ ] 配置 `max_messages` 参数（建议根据模型 context window 调整）
- [ ] 在 Agent 基类中集成 `memory: Memory` 字段

**阶段 2：Token 追踪（可选）**
- [ ] 集成 `TokenCounter` 类用于消息 token 估算
- [ ] 在 LLM 调用层添加 `update_token_count` / `check_token_limit`
- [ ] 配置 `max_input_tokens` 上限

**阶段 3：增强（按需）**
- [ ] 添加 system message 保护（截断时保留首条 system 消息）
- [ ] 添加持久化层（JSON/SQLite）用于跨会话
- [ ] 添加基于 token 的截断（替代消息数截断）

### 3.2 适配代码模板

```python
from typing import List, Optional
from pydantic import BaseModel, Field


class Message(BaseModel):
    role: str
    content: Optional[str] = None
    tool_calls: Optional[list] = None
    tool_call_id: Optional[str] = None
    name: Optional[str] = None

    def to_dict(self) -> dict:
        d = {"role": self.role}
        for key in ("content", "tool_calls", "tool_call_id", "name"):
            val = getattr(self, key)
            if val is not None:
                d[key] = val
        return d

    @classmethod
    def user(cls, content: str) -> "Message":
        return cls(role="user", content=content)

    @classmethod
    def assistant(cls, content: str) -> "Message":
        return cls(role="assistant", content=content)

    @classmethod
    def system(cls, content: str) -> "Message":
        return cls(role="system", content=content)


class SlidingWindowMemory(BaseModel):
    """滑动窗口记忆 — 移植自 OpenManus Memory 模式"""
    messages: List[Message] = Field(default_factory=list)
    max_messages: int = 100
    protect_system: bool = True  # 增强：保护 system 消息不被截断

    def add(self, message: Message) -> None:
        self.messages.append(message)
        self._truncate()

    def _truncate(self) -> None:
        if len(self.messages) <= self.max_messages:
            return
        if self.protect_system and self.messages and self.messages[0].role == "system":
            system_msg = self.messages[0]
            self.messages = [system_msg] + self.messages[-(self.max_messages - 1):]
        else:
            self.messages = self.messages[-self.max_messages:]

    def recent(self, n: int) -> List[Message]:
        return self.messages[-n:]

    def to_dicts(self) -> List[dict]:
        return [m.to_dict() for m in self.messages]

    def clear(self) -> None:
        self.messages.clear()

    def is_stuck(self, threshold: int = 2) -> bool:
        """检测重复输出循环"""
        if len(self.messages) < 2:
            return False
        last = self.messages[-1]
        if last.role != "assistant" or not last.content:
            return False
        count = sum(
            1 for m in reversed(self.messages[:-1])
            if m.role == "assistant" and m.content == last.content
        )
        return count >= threshold
```

### 3.3 适用场景

| 场景 | 适用度 | 说明 |
|------|--------|------|
| 单次任务 Agent（10-30 步） | ⭐⭐⭐ | 完美匹配，消息数可控 |
| 长对话 Chatbot | ⭐⭐ | 需要增加 system 保护和摘要压缩 |
| 多 Agent 协作 | ⭐⭐ | 每个 Agent 独立 Memory，无共享记忆机制 |
| 跨会话持久化 | ⭐ | 无持久化支持，需自行扩展 |
| 知识密集型任务 | ⭐ | 无语义检索，只有时序窗口 |

---

## 第 4 章 测试用例

```python
import pytest
from typing import List, Optional
from pydantic import BaseModel, Field


# --- 被测类（简化版，与源码逻辑一致）---

class Message(BaseModel):
    role: str
    content: Optional[str] = None

    def to_dict(self) -> dict:
        d = {"role": self.role}
        if self.content is not None:
            d["content"] = self.content
        return d

    @classmethod
    def user_message(cls, content: str) -> "Message":
        return cls(role="user", content=content)

    @classmethod
    def assistant_message(cls, content: str) -> "Message":
        return cls(role="assistant", content=content)


class Memory(BaseModel):
    messages: List[Message] = Field(default_factory=list)
    max_messages: int = Field(default=100)

    def add_message(self, message: Message) -> None:
        self.messages.append(message)
        if len(self.messages) > self.max_messages:
            self.messages = self.messages[-self.max_messages:]

    def clear(self) -> None:
        self.messages.clear()

    def get_recent_messages(self, n: int) -> List[Message]:
        return self.messages[-n:]

    def to_dict_list(self) -> List[dict]:
        return [msg.to_dict() for msg in self.messages]


# --- 测试 ---

class TestMemorySlidingWindow:
    def test_add_within_limit(self):
        mem = Memory(max_messages=5)
        for i in range(5):
            mem.add_message(Message.user_message(f"msg-{i}"))
        assert len(mem.messages) == 5
        assert mem.messages[0].content == "msg-0"

    def test_sliding_window_truncation(self):
        mem = Memory(max_messages=3)
        for i in range(6):
            mem.add_message(Message.user_message(f"msg-{i}"))
        assert len(mem.messages) == 3
        assert mem.messages[0].content == "msg-3"  # 最早的 3 条被丢弃
        assert mem.messages[-1].content == "msg-5"

    def test_get_recent_messages(self):
        mem = Memory(max_messages=10)
        for i in range(5):
            mem.add_message(Message.user_message(f"msg-{i}"))
        recent = mem.get_recent_messages(2)
        assert len(recent) == 2
        assert recent[0].content == "msg-3"
        assert recent[1].content == "msg-4"

    def test_clear(self):
        mem = Memory()
        mem.add_message(Message.user_message("hello"))
        mem.clear()
        assert len(mem.messages) == 0

    def test_to_dict_list(self):
        mem = Memory()
        mem.add_message(Message.user_message("hi"))
        mem.add_message(Message.assistant_message("hello"))
        dicts = mem.to_dict_list()
        assert dicts == [
            {"role": "user", "content": "hi"},
            {"role": "assistant", "content": "hello"},
        ]

    def test_system_message_lost_on_truncation(self):
        """验证 OpenManus 的已知限制：system 消息会被截断丢失"""
        mem = Memory(max_messages=2)
        mem.add_message(Message(role="system", content="You are helpful"))
        mem.add_message(Message.user_message("q1"))
        mem.add_message(Message.assistant_message("a1"))
        # system 消息已被截断
        assert mem.messages[0].role == "user"
        assert len(mem.messages) == 2


class TestStuckDetection:
    @staticmethod
    def is_stuck(messages: List[Message], threshold: int = 2) -> bool:
        """复现 BaseAgent.is_stuck() 逻辑"""
        if len(messages) < 2:
            return False
        last = messages[-1]
        if not last.content:
            return False
        count = sum(
            1 for m in reversed(messages[:-1])
            if m.role == "assistant" and m.content == last.content
        )
        return count >= threshold

    def test_not_stuck_with_varied_content(self):
        msgs = [
            Message.assistant_message("action A"),
            Message.assistant_message("action B"),
            Message.assistant_message("action C"),
        ]
        assert not self.is_stuck(msgs)

    def test_stuck_with_repeated_content(self):
        msgs = [
            Message.assistant_message("same output"),
            Message.assistant_message("same output"),
            Message.assistant_message("same output"),
        ]
        assert self.is_stuck(msgs, threshold=2)

    def test_not_stuck_with_single_message(self):
        msgs = [Message.assistant_message("only one")]
        assert not self.is_stuck(msgs)
```

---

## 第 5 章 跨域关联

| 关联域 | 关系类型 | 说明 |
|--------|----------|------|
| PD-01 上下文管理 | 强依赖 | Memory 的 `max_messages` 滑动窗口本质上是一种上下文窗口管理策略，但粒度是消息数而非 token 数 |
| PD-03 容错与重试 | 协同 | `TokenLimitExceeded` 异常与 tenacity 重试机制配合——token 超限不重试，API 错误重试 6 次 |
| PD-04 工具系统 | 协同 | `ToolCallAgent.act()` 每次工具执行结果都写入 Memory 作为 tool 消息，工具输出通过 `max_observe` 截断 |
| PD-11 可观测性 | 协同 | LLM 单例的 `total_input_tokens` / `total_completion_tokens` 提供全局 token 消耗追踪 |

---

## 第 6 章 来源文件索引

| 文件 | 行范围 | 关键实现 |
|------|--------|----------|
| `app/schema.py` | L54-157 | Message 类定义：4 种角色工厂方法、to_dict 序列化、tool_calls 支持 |
| `app/schema.py` | L159-187 | Memory 类：滑动窗口 add_message/add_messages、get_recent、to_dict_list |
| `app/agent/base.py` | L34-56 | BaseAgent 中 memory/llm 字段定义与 model_validator 初始化 |
| `app/agent/base.py` | L84-114 | update_memory() 统一消息写入入口 |
| `app/agent/base.py` | L170-186 | is_stuck() 循环检测：基于 assistant 消息内容重复度 |
| `app/agent/base.py` | L163-168 | handle_stuck_state() 注入策略变更 prompt |
| `app/llm.py` | L174-228 | LLM 单例模式：_instances Dict + __new__ + token 计数器初始化 |
| `app/llm.py` | L238-264 | Token 累计追踪：update_token_count / check_token_limit |
| `app/llm.py` | L45-171 | TokenCounter：tiktoken 编码 + 图片 token 估算 |
| `app/agent/toolcall.py` | L39-129 | think() 中 memory.add_message 写入 assistant 消息 |
| `app/agent/toolcall.py` | L131-164 | act() 中 memory.add_message 写入 tool 消息 |
| `app/agent/manus.py` | L147 | 近期消息窗口：messages[-3:] 判断浏览器工具使用 |
| `app/config.py` | L24-25 | LLMSettings.max_input_tokens 配置项 |
| `app/exceptions.py` | L12-13 | TokenLimitExceeded 异常定义 |

---

## 第 7 章 横向对比维度

> 本章用于自动填充 Butcher Wiki 的横向对比表。

```json comparison_data
{
  "project": "OpenManus",
  "dimensions": {
    "记忆结构": "Pydantic Memory 模型，List[Message] + max_messages 滑动窗口",
    "更新机制": "add_message 后立即检查长度，超限尾部保留截断",
    "事实提取": "无事实提取，仅存储原始消息",
    "存储方式": "纯内存 List，无持久化，进程结束即丢失",
    "注入方式": "self.messages 直接传入 LLM ask_tool，system_msgs 单独拼接",
    "循环检测": "is_stuck() 基于 assistant 消息内容重复度，阈值 2 次",
    "成本追踪": "LLM 单例累计 total_input/completion_tokens + max_input_tokens 限额"
  }
}
```

### 域元数据补充

```json domain_metadata
{
  "solution_summary": "OpenManus 用 Pydantic Memory + max_messages 滑动窗口管理对话历史，LLM 单例按 config_name 缓存并累计追踪 token 消耗，is_stuck() 检测重复输出循环",
  "description": "极简记忆方案：纯内存滑动窗口 + 消息级粒度管理，适合单次任务 Agent",
  "sub_problems": [
    "循环检测：基于记忆内容识别 Agent 陷入重复输出的死循环"
  ],
  "best_practices": [
    "单例 LLM 共享 token 计数：多 Agent 共用同一 config_name 的 LLM 实例，全局统一成本追踪",
    "消息数截断简单但有风险：system 消息可能被丢弃，生产环境应增加首条保护"
  ]
}
```
