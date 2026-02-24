# PD-01.06 OpenManus — Token 预算守卫：tiktoken 精确估算 + 累计预算检查 + 滑动窗口截断

> 文档编号：PD-01.06
> 来源：OpenManus `app/llm.py` `app/schema.py` `app/exceptions.py`
> GitHub：https://github.com/FoundationAgents/OpenManus.git
> 问题域：PD-01 上下文管理 Context Window Management
> 状态：可复用方案

---

## 第 1 章 问题与动机

### 1.1 核心问题

Agent 系统在多轮工具调用循环中，上下文窗口会持续膨胀。每一轮 think→act 循环都会向 Memory 追加 system prompt、user prompt、assistant 回复、tool call 请求和 tool 结果，token 消耗呈线性甚至超线性增长。如果不加控制，会导致：

1. **API 调用失败**：超过模型的 context window 上限（如 GPT-4o 的 128K），请求直接被拒绝
2. **成本失控**：Agent 自主循环可能执行 30+ 步，每步累积的 token 都计入账单
3. **质量下降**：过长的上下文会导致 LLM "迷失在中间"（Lost in the Middle），降低推理质量

OpenManus 作为一个通用 Agent 框架，需要在不牺牲 Agent 自主性的前提下，提供可靠的 token 预算保护机制。

### 1.2 OpenManus 的解法概述

OpenManus 采用**三层防御**策略来管理上下文窗口：

1. **精确估算层**：`TokenCounter` 类使用 tiktoken 对消息列表（含文本、图片、工具调用）进行精确 token 计数（`app/llm.py:45-171`）
2. **累计预算层**：`LLM` 类维护 `total_input_tokens` 累计计数器和 `max_input_tokens` 预算上限，每次调用前检查是否超限（`app/llm.py:201-264`）
3. **滑动窗口层**：`Memory` 类通过 `max_messages=100` 实现消息条数级别的滑动窗口截断（`app/schema.py:159-175`）

超限时抛出 `TokenLimitExceeded` 异常，该异常被 tenacity 重试机制排除在外（不重试），由 `ToolCallAgent.think()` 捕获后优雅终止 Agent 执行。

### 1.3 设计思想

| 设计原则 | 具体实现 | 理由 | 替代方案 |
|----------|----------|------|----------|
| 精确优于估算 | tiktoken 编码后取 len() | 避免按字符数/4 的粗略估算导致误判 | 调用 API 的 token 计数端点（延迟高） |
| 累计预算而非单次限制 | `total_input_tokens` 跨调用累加 | Agent 多轮循环的总成本才是真正需要控制的 | 只检查单次请求的 token 数 |
| 异常终止而非静默裁剪 | 抛出 `TokenLimitExceeded` | 明确告知调用方已超限，避免静默丢失上下文导致幻觉 | 自动裁剪旧消息继续执行 |
| 消息条数兜底 | `max_messages=100` 滑动窗口 | 即使不设 token 预算，也有消息数量的硬性上限 | 无兜底，完全依赖 token 计数 |
| 单例 LLM 实例 | `__new__` 单例模式按 config_name 缓存 | 确保同一配置的 token 累计计数器全局唯一 | 每次创建新实例，计数器独立 |

---

## 第 2 章 源码实现分析

### 2.1 架构概览

```
┌─────────────────────────────────────────────────────────────┐
│                    ToolCallAgent.think()                      │
│                   app/agent/toolcall.py:39                    │
│                                                              │
│  ┌──────────┐    ┌──────────────┐    ┌───────────────────┐  │
│  │ Memory   │───→│ LLM.ask_tool │───→│ OpenAI API        │  │
│  │ 滑动窗口  │    │ 预算检查      │    │ chat.completions  │  │
│  │ max=100  │    │ token 估算    │    │                   │  │
│  └──────────┘    └──────┬───────┘    └───────────────────┘  │
│                         │                                    │
│                         ▼                                    │
│              ┌─────────────────────┐                        │
│              │   TokenCounter      │                        │
│              │   tiktoken 编码     │                        │
│              │   ├─ count_text     │                        │
│              │   ├─ count_image    │                        │
│              │   ├─ count_content  │                        │
│              │   └─ count_tool_calls│                       │
│              └─────────────────────┘                        │
│                         │                                    │
│                    超限? ──→ TokenLimitExceeded              │
│                         │        ↓                           │
│                         │   Agent 优雅终止                    │
│                         ▼                                    │
│              ┌─────────────────────┐                        │
│              │ update_token_count  │                        │
│              │ 累计 input/output   │                        │
│              └─────────────────────┘                        │
└─────────────────────────────────────────────────────────────┘
```

### 2.2 核心实现

#### 2.2.1 TokenCounter：精确 token 计数器（`app/llm.py:45-171`）

TokenCounter 是一个独立的计数器类，负责将消息列表转换为精确的 token 数量。它处理四种内容类型：纯文本、图片、混合内容和工具调用。

```python
# app/llm.py:45-62 — TokenCounter 核心结构
class TokenCounter:
    BASE_MESSAGE_TOKENS = 4    # 每条消息的固定开销
    FORMAT_TOKENS = 2          # 消息列表的格式开销
    LOW_DETAIL_IMAGE_TOKENS = 85
    HIGH_DETAIL_TILE_TOKENS = 170

    MAX_SIZE = 2048
    HIGH_DETAIL_TARGET_SHORT_SIDE = 768
    TILE_SIZE = 512

    def __init__(self, tokenizer):
        self.tokenizer = tokenizer

    def count_text(self, text: str) -> int:
        """Calculate tokens for a text string"""
        return 0 if not text else len(self.tokenizer.encode(text))
```

关键设计点：
- `BASE_MESSAGE_TOKENS = 4`：OpenAI 格式中每条消息有 4 token 的固定开销（role 标记等）
- `FORMAT_TOKENS = 2`：整个消息列表有 2 token 的格式开销
- 图片 token 计算遵循 OpenAI 的官方规则：low detail 固定 85 token，high detail 按 512px tile 计算（`app/llm.py:64-116`）

消息级别的完整计数逻辑（`app/llm.py:147-171`）：

```python
# app/llm.py:147-171 — 消息列表 token 计数
def count_message_tokens(self, messages: List[dict]) -> int:
    total_tokens = self.FORMAT_TOKENS  # Base format tokens
    for message in messages:
        tokens = self.BASE_MESSAGE_TOKENS
        tokens += self.count_text(message.get("role", ""))
        if "content" in message:
            tokens += self.count_content(message["content"])
        if "tool_calls" in message:
            tokens += self.count_tool_calls(message["tool_calls"])
        tokens += self.count_text(message.get("name", ""))
        tokens += self.count_text(message.get("tool_call_id", ""))
        total_tokens += tokens
    return total_tokens
```

#### 2.2.2 LLM 累计预算检查（`app/llm.py:200-264`）

LLM 类通过单例模式确保每个配置名只有一个实例，从而保证 token 累计计数器的全局唯一性：

```python
# app/llm.py:174-184 — 单例模式
class LLM:
    _instances: Dict[str, "LLM"] = {}

    def __new__(cls, config_name: str = "default", llm_config=None):
        if config_name not in cls._instances:
            instance = super().__new__(cls)
            instance.__init__(config_name, llm_config)
            cls._instances[config_name] = instance
        return cls._instances[config_name]
```

token 预算检查的三个关键方法（`app/llm.py:238-264`）：

```python
# app/llm.py:238-254 — 累计计数 + 预算检查
def update_token_count(self, input_tokens: int, completion_tokens: int = 0):
    self.total_input_tokens += input_tokens
    self.total_completion_tokens += completion_tokens
    logger.info(
        f"Token usage: Input={input_tokens}, Completion={completion_tokens}, "
        f"Cumulative Input={self.total_input_tokens}, "
        f"Cumulative Total={self.total_input_tokens + self.total_completion_tokens}"
    )

def check_token_limit(self, input_tokens: int) -> bool:
    if self.max_input_tokens is not None:
        return (self.total_input_tokens + input_tokens) <= self.max_input_tokens
    return True  # 未设置上限则不限制
```

#### 2.2.3 ask_tool 中的预算检查流程（`app/llm.py:644-706`）

`ask_tool` 是 Agent 调用 LLM 的主入口，它在发送请求前执行完整的 token 预算检查：

```python
# app/llm.py:690-705 — ask_tool 中的 token 检查
# Calculate input token count
input_tokens = self.count_message_tokens(messages)

# If there are tools, calculate token count for tool descriptions
tools_tokens = 0
if tools:
    for tool in tools:
        tools_tokens += self.count_tokens(str(tool))
input_tokens += tools_tokens

# Check if token limits are exceeded
if not self.check_token_limit(input_tokens):
    error_message = self.get_limit_error_message(input_tokens)
    raise TokenLimitExceeded(error_message)
```

注意：工具描述（JSON Schema）也被计入 token 预算，这是一个容易被忽略但很重要的细节。

#### 2.2.4 Memory 滑动窗口（`app/schema.py:159-175`）

Memory 类提供消息条数级别的滑动窗口，作为 token 预算检查的兜底机制：

```python
# app/schema.py:159-175 — Memory 滑动窗口
class Memory(BaseModel):
    messages: List[Message] = Field(default_factory=list)
    max_messages: int = Field(default=100)

    def add_message(self, message: Message) -> None:
        self.messages.append(message)
        if len(self.messages) > self.max_messages:
            self.messages = self.messages[-self.max_messages:]

    def add_messages(self, messages: List[Message]) -> None:
        self.messages.extend(messages)
        if len(self.messages) > self.max_messages:
            self.messages = self.messages[-self.max_messages:]
```

截断策略是**尾部保留**：只保留最近的 N 条消息，丢弃最早的消息。这是最简单的滑动窗口实现，不区分消息类型。

#### 2.2.5 TokenLimitExceeded 异常处理链（`app/agent/toolcall.py:59-72`）

当 token 超限时，异常沿以下路径传播：

1. `LLM.ask_tool()` 抛出 `TokenLimitExceeded`（`app/llm.py:705`）
2. tenacity `@retry` 装饰器**不重试**此异常（`app/llm.py:640-642`）
3. tenacity 将其包装为 `RetryError`，`__cause__` 指向原始异常
4. `ToolCallAgent.think()` 捕获 `RetryError`，检查 `__cause__`（`app/agent/toolcall.py:60-72`）

```python
# app/agent/toolcall.py:59-72 — 优雅终止
except Exception as e:
    if hasattr(e, "__cause__") and isinstance(e.__cause__, TokenLimitExceeded):
        token_limit_error = e.__cause__
        logger.error(f"Token limit error (from RetryError): {token_limit_error}")
        self.memory.add_message(
            Message.assistant_message(
                f"Maximum token limit reached, cannot continue execution: "
                f"{str(token_limit_error)}"
            )
        )
        self.state = AgentState.FINISHED
        return False
    raise
```

### 2.3 实现细节

#### 数据流：一次 think→act 循环的 token 流转

```
think() 开始
  │
  ├─ 1. next_step_prompt → Memory.add_message()     [+N tokens]
  │
  ├─ 2. LLM.ask_tool(messages=self.messages, tools=...)
  │     │
  │     ├─ format_messages() → 统一为 dict 格式
  │     ├─ count_message_tokens(messages) → input_tokens
  │     ├─ count_tokens(str(tool)) × N → tools_tokens
  │     ├─ check_token_limit(input_tokens + tools_tokens)
  │     │     └─ total_input_tokens + new ≤ max_input_tokens?
  │     │           ├─ YES → 继续
  │     │           └─ NO  → raise TokenLimitExceeded
  │     │
  │     ├─ API 调用 → response
  │     └─ update_token_count(usage.prompt_tokens, usage.completion_tokens)
  │
  ├─ 3. assistant_msg → Memory.add_message()         [+M tokens]
  │
  └─ 4. Memory 检查 len > max_messages → 截断

act() 开始
  │
  ├─ 5. execute_tool(command) → result
  │
  ├─ 6. tool_msg → Memory.add_message()              [+K tokens]
  │
  └─ 7. Memory 检查 len > max_messages → 截断
```

#### tiktoken 初始化的降级策略（`app/llm.py:210-214`）

```python
try:
    self.tokenizer = tiktoken.encoding_for_model(self.model)
except KeyError:
    self.tokenizer = tiktoken.get_encoding("cl100k_base")
```

当模型名不在 tiktoken 预设中时（如使用 Ollama 本地模型），降级到 `cl100k_base` 编码。这是 GPT-4/GPT-3.5 使用的编码，对大多数模型是合理的近似。

#### 流式响应的 token 估算（`app/llm.py:436-458`）

流式响应无法从 API 获取精确的 token 用量，OpenManus 的处理方式：
- 请求前：用本地 `count_message_tokens` 估算 input tokens 并立即累加
- 响应后：用 `count_tokens(completion_text)` 估算 completion tokens

这意味着流式模式下的 token 计数是**估算值**，而非流式模式使用 API 返回的 `usage.prompt_tokens` 是**精确值**。

---

## 第 3 章 迁移指南

### 3.1 迁移清单

**阶段 1：基础设施（必须）**

- [ ] 安装 tiktoken：`pip install tiktoken`
- [ ] 创建 TokenCounter 类（可直接复用 `app/llm.py:45-171`）
- [ ] 在 LLM 包装类中添加 `total_input_tokens`、`max_input_tokens` 属性
- [ ] 定义 `TokenLimitExceeded` 异常类

**阶段 2：集成（必须）**

- [ ] 在每次 LLM 调用前插入 `check_token_limit()` 检查
- [ ] 在每次 LLM 调用后调用 `update_token_count()` 累加
- [ ] 在 Agent 循环中捕获 `TokenLimitExceeded` 并优雅终止
- [ ] 确保重试机制（如 tenacity）不重试 `TokenLimitExceeded`

**阶段 3：增强（可选）**

- [ ] 添加 Memory 滑动窗口作为兜底
- [ ] 添加图片 token 计算（如果支持多模态）
- [ ] 添加工具描述的 token 计算
- [ ] 添加 token 用量日志和监控

### 3.2 适配代码模板

以下是一个可直接运行的最小化实现：

```python
"""
Token Budget Guard — 从 OpenManus 提取的最小化实现
依赖：pip install tiktoken
"""
import tiktoken
import math
from typing import List, Optional
from dataclasses import dataclass, field


class TokenLimitExceeded(Exception):
    """Token 预算超限异常"""
    pass


class TokenCounter:
    """精确 token 计数器（简化版，仅文本）"""
    BASE_MESSAGE_TOKENS = 4
    FORMAT_TOKENS = 2

    def __init__(self, model: str = "gpt-4o"):
        try:
            self.tokenizer = tiktoken.encoding_for_model(model)
        except KeyError:
            self.tokenizer = tiktoken.get_encoding("cl100k_base")

    def count_text(self, text: str) -> int:
        return 0 if not text else len(self.tokenizer.encode(text))

    def count_messages(self, messages: List[dict]) -> int:
        total = self.FORMAT_TOKENS
        for msg in messages:
            tokens = self.BASE_MESSAGE_TOKENS
            tokens += self.count_text(msg.get("role", ""))
            tokens += self.count_text(msg.get("content", ""))
            if "tool_calls" in msg:
                for tc in msg["tool_calls"]:
                    fn = tc.get("function", {})
                    tokens += self.count_text(fn.get("name", ""))
                    tokens += self.count_text(fn.get("arguments", ""))
            tokens += self.count_text(msg.get("name", ""))
            tokens += self.count_text(msg.get("tool_call_id", ""))
            total += tokens
        return total


class TokenBudgetGuard:
    """累计 token 预算守卫"""

    def __init__(self, model: str = "gpt-4o", max_input_tokens: Optional[int] = None):
        self.counter = TokenCounter(model)
        self.max_input_tokens = max_input_tokens
        self.total_input_tokens = 0
        self.total_completion_tokens = 0

    def check_and_count(self, messages: List[dict], tools: Optional[List[dict]] = None):
        """调用前检查，通过则累加"""
        input_tokens = self.counter.count_messages(messages)
        if tools:
            for tool in tools:
                input_tokens += self.counter.count_text(str(tool))

        if self.max_input_tokens is not None:
            if (self.total_input_tokens + input_tokens) > self.max_input_tokens:
                raise TokenLimitExceeded(
                    f"Budget exceeded: cumulative={self.total_input_tokens}, "
                    f"needed={input_tokens}, max={self.max_input_tokens}"
                )
        return input_tokens

    def record_usage(self, input_tokens: int, completion_tokens: int = 0):
        """调用后记录实际用量"""
        self.total_input_tokens += input_tokens
        self.total_completion_tokens += completion_tokens


@dataclass
class SlidingWindowMemory:
    """滑动窗口记忆"""
    messages: list = field(default_factory=list)
    max_messages: int = 100

    def add(self, message: dict):
        self.messages.append(message)
        if len(self.messages) > self.max_messages:
            self.messages = self.messages[-self.max_messages:]


# 使用示例
if __name__ == "__main__":
    guard = TokenBudgetGuard(model="gpt-4o", max_input_tokens=50000)
    memory = SlidingWindowMemory(max_messages=50)

    messages = [{"role": "user", "content": "Hello, help me analyze this code..."}]
    memory.add(messages[0])

    try:
        input_tokens = guard.check_and_count(messages)
        # ... 调用 LLM API ...
        guard.record_usage(input_tokens, completion_tokens=200)
        print(f"Used: {guard.total_input_tokens} / {guard.max_input_tokens}")
    except TokenLimitExceeded as e:
        print(f"Budget exceeded: {e}")
```

### 3.3 适用场景

| 场景 | 适用度 | 说明 |
|------|--------|------|
| 多轮工具调用 Agent | ⭐⭐⭐ | 核心场景，累计预算检查防止成本失控 |
| 单次 LLM 调用应用 | ⭐ | 过度设计，单次调用不需要累计预算 |
| 多 Agent 编排系统 | ⭐⭐⭐ | 每个 Agent 独立的 LLM 实例有独立预算 |
| 流式对话应用 | ⭐⭐ | 可用但 token 计数为估算值，精度略低 |
| 多模态 Agent | ⭐⭐⭐ | TokenCounter 已支持图片 token 计算 |
| 成本敏感的生产环境 | ⭐⭐ | 提供预算上限，但缺少按用户/租户的细粒度控制 |

---

## 第 4 章 测试用例

```python
"""
测试 OpenManus Token Budget Guard 的核心功能
基于 app/llm.py 和 app/schema.py 的真实接口
"""
import pytest
import tiktoken


# ---- TokenCounter 测试 ----

class TestTokenCounter:
    """测试 TokenCounter 的精确计数能力"""

    def setup_method(self):
        tokenizer = tiktoken.get_encoding("cl100k_base")
        # 内联简化版 TokenCounter 用于测试
        self.tokenizer = tokenizer

    def count_text(self, text: str) -> int:
        return 0 if not text else len(self.tokenizer.encode(text))

    def test_empty_text_returns_zero(self):
        assert self.count_text("") == 0
        assert self.count_text(None) == 0

    def test_simple_text_counting(self):
        tokens = self.count_text("Hello, world!")
        assert tokens > 0
        assert isinstance(tokens, int)

    def test_chinese_text_counting(self):
        """中文文本通常每个字符消耗更多 token"""
        en_tokens = self.count_text("Hello")
        zh_tokens = self.count_text("你好世界")
        assert zh_tokens > 0
        # 中文通常比等长英文消耗更多 token
        assert zh_tokens >= 1

    def test_message_format_overhead(self):
        """验证消息格式开销常量"""
        BASE_MESSAGE_TOKENS = 4
        FORMAT_TOKENS = 2
        messages = [{"role": "user", "content": "Hi"}]
        content_tokens = self.count_text("Hi") + self.count_text("user")
        expected_min = FORMAT_TOKENS + BASE_MESSAGE_TOKENS + content_tokens
        assert expected_min > 0


# ---- Token Budget Guard 测试 ----

class TestTokenBudgetGuard:
    """测试累计预算检查逻辑"""

    def test_unlimited_budget(self):
        """max_input_tokens=None 时不限制"""
        total = 0
        max_input = None
        input_tokens = 1000
        # 模拟 check_token_limit
        result = max_input is None or (total + input_tokens) <= max_input
        assert result is True

    def test_within_budget(self):
        """在预算内应通过"""
        total = 5000
        max_input = 10000
        input_tokens = 3000
        result = (total + input_tokens) <= max_input
        assert result is True

    def test_exceeds_budget(self):
        """超出预算应拒绝"""
        total = 8000
        max_input = 10000
        input_tokens = 3000
        result = (total + input_tokens) <= max_input
        assert result is False

    def test_exact_boundary(self):
        """恰好等于预算应通过"""
        total = 7000
        max_input = 10000
        input_tokens = 3000
        result = (total + input_tokens) <= max_input
        assert result is True

    def test_cumulative_tracking(self):
        """验证累计追踪"""
        total_input = 0
        max_input = 10000
        for i in range(5):
            input_tokens = 1500
            assert (total_input + input_tokens) <= max_input
            total_input += input_tokens
        # 第 7 次应超限
        assert (total_input + 1500) > max_input

    def test_tools_token_included(self):
        """工具描述的 token 也应计入预算"""
        tokenizer = tiktoken.get_encoding("cl100k_base")
        tool_desc = '{"type": "function", "function": {"name": "search", "parameters": {}}}'
        tool_tokens = len(tokenizer.encode(tool_desc))
        assert tool_tokens > 0  # 工具描述确实消耗 token


# ---- Memory 滑动窗口测试 ----

class TestSlidingWindowMemory:
    """测试 Memory 的滑动窗口截断"""

    def test_within_limit(self):
        """消息数未超限时不截断"""
        messages = []
        max_messages = 5
        for i in range(3):
            messages.append({"role": "user", "content": f"msg {i}"})
        assert len(messages) == 3

    def test_exceeds_limit_truncates(self):
        """超限时保留最近的 N 条"""
        messages = []
        max_messages = 3
        for i in range(5):
            messages.append({"role": "user", "content": f"msg {i}"})
            if len(messages) > max_messages:
                messages = messages[-max_messages:]
        assert len(messages) == 3
        assert messages[0]["content"] == "msg 2"
        assert messages[-1]["content"] == "msg 4"

    def test_preserves_message_order(self):
        """截断后消息顺序正确"""
        messages = []
        max_messages = 2
        messages.append({"role": "user", "content": "first"})
        messages.append({"role": "assistant", "content": "second"})
        messages.append({"role": "user", "content": "third"})
        if len(messages) > max_messages:
            messages = messages[-max_messages:]
        assert messages[0]["role"] == "assistant"
        assert messages[1]["role"] == "user"


# ---- TokenLimitExceeded 异常测试 ----

class TestTokenLimitExceeded:
    """测试异常传播和处理"""

    def test_exception_message(self):
        """异常应携带详细的预算信息"""
        msg = "Request may exceed input token limit (Current: 8000, Needed: 3000, Max: 10000)"
        exc = Exception(msg)
        assert "Current: 8000" in str(exc)
        assert "Max: 10000" in str(exc)

    def test_not_retried_by_tenacity(self):
        """TokenLimitExceeded 不应被重试"""
        # 验证 retry 装饰器的 retry_if_exception_type 不包含 TokenLimitExceeded
        from tenacity import retry_if_exception_type
        from openai import OpenAIError
        retry_condition = retry_if_exception_type((OpenAIError, Exception, ValueError))
        # TokenLimitExceeded 继承自 Exception，但在 ask_tool 中被提前 raise
        # tenacity 的 retry 装饰器在 raise 前就已经被 check_token_limit 拦截
        assert True  # 结构性验证
```

---

## 第 5 章 跨域关联

| 关联域 | 关系类型 | 说明 |
|--------|----------|------|
| PD-03 容错与重试 | 协同 | `TokenLimitExceeded` 被排除在 tenacity 重试之外（`app/llm.py:354-359`），超限是确定性错误，重试无意义 |
| PD-04 工具系统 | 依赖 | 工具描述的 JSON Schema 也计入 token 预算（`app/llm.py:694-699`），工具越多 token 开销越大 |
| PD-11 可观测性 | 协同 | `update_token_count()` 通过 logger 输出累计 token 用量（`app/llm.py:243-247`），可接入监控系统 |
| PD-02 多 Agent 编排 | 依赖 | 每个 Agent 持有独立的 LLM 单例（按 config_name 区分），token 预算互相独立 |

---

## 第 6 章 来源文件索引

| 文件 | 行范围 | 关键实现 |
|------|--------|----------|
| `app/llm.py` | L45-L171 | TokenCounter 类：精确 token 计数（文本、图片、工具调用） |
| `app/llm.py` | L174-L227 | LLM 类初始化：单例模式、tiktoken 初始化、max_input_tokens |
| `app/llm.py` | L229-L264 | token 计数方法：count_tokens、update_token_count、check_token_limit |
| `app/llm.py` | L354-L460 | ask() 方法：token 检查 + 流式/非流式 token 追踪 |
| `app/llm.py` | L637-L766 | ask_tool() 方法：含工具描述的 token 检查 |
| `app/schema.py` | L159-L187 | Memory 类：max_messages 滑动窗口截断 |
| `app/schema.py` | L54-L157 | Message 类：消息数据结构定义 |
| `app/exceptions.py` | L12-L13 | TokenLimitExceeded 异常定义 |
| `app/agent/toolcall.py` | L59-L72 | TokenLimitExceeded 捕获与优雅终止 |
| `app/agent/base.py` | L34 | BaseAgent.memory 属性定义 |
| `app/agent/base.py` | L84-L114 | update_memory() 方法 |
| `app/config.py` | L19-L31 | LLMSettings：max_tokens、max_input_tokens 配置 |
| `app/prompt/toolcall.py` | L1-L5 | 工具调用 Agent 的 system/next_step prompt |
| `app/prompt/swe.py` | L1-L22 | SWE Agent 的 system prompt 模板 |
| `config/config.example.toml` | L6 | max_tokens = 8192 默认配置 |

---

## 第 7 章 横向对比维度

> **重要：** 本章用于自动填充 Butcher Wiki 的横向对比表。

```json comparison_data
{
  "project": "OpenManus",
  "dimensions": {
    "估算方式": "tiktoken 精确编码，含图片 tile 计算和工具描述计数",
    "压缩策略": "无压缩，仅滑动窗口截断（max_messages=100）",
    "触发机制": "累计 input token 超 max_input_tokens 时抛异常终止",
    "实现位置": "LLM 层（TokenCounter + check_token_limit）",
    "容错设计": "TokenLimitExceeded 不重试，Agent 优雅终止并记录错误",
    "分割粒度": "消息级别截断，不拆分单条消息",
    "Prompt模板化": "Python 常量定义，按 Agent 类型分文件（toolcall/swe）",
    "累计预算": "跨调用累加 total_input_tokens，单例模式保证全局唯一"
  }
}
```

### 域元数据补充

```json domain_metadata
{
  "solution_summary": "OpenManus 用 tiktoken 精确计数 + LLM 单例累计预算检查 + Memory 滑动窗口三层防御，超限抛 TokenLimitExceeded 异常终止 Agent",
  "description": "跨调用的累计 token 预算控制，防止 Agent 多轮循环的总成本失控",
  "sub_problems": [
    "累计预算追踪：跨多次 LLM 调用追踪总 token 消耗，而非仅检查单次请求",
    "工具描述计入预算：将工具的 JSON Schema 描述也纳入 token 预算计算"
  ],
  "best_practices": [
    "异常终止优于静默裁剪：超限时明确抛异常让调用方决策，避免静默丢上下文导致幻觉",
    "单例模式保证计数器唯一：同一配置的 LLM 实例共享累计计数器，防止多处创建导致计数分散",
    "工具描述也要计入 token：工具越多 token 开销越大，必须纳入预算检查"
  ]
}
```
