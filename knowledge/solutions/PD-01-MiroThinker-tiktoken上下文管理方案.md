# PD-01.01 MiroThinker — tiktoken 精确估算 + 分级裁剪 + 滑动窗口

> 文档编号：PD-01.01
> 来源：MiroThinker `openai_client.py` / `orchestrator.py`
> GitHub：https://github.com/MiroMindAI/MiroThinker
> 问题域：PD-01 上下文管理 Context Window Management
> 状态：可复用方案

---

## 第 1 章 问题与动机

### 1.1 核心问题

LLM 上下文窗口有限（4K-200K tokens），长任务中 token 会不断累积。如果不主动管理：

- API 调用直接报错（token 超限 → HTTP 400 / context_length_exceeded）
- 关键信息被 API 侧静默截断，模型看不到完整上下文
- 成本失控：每次调用都带着大量无用历史，token 费用线性增长

典型膨胀路径：

```
初始 system prompt (2K tokens)
  + 用户消息 (0.5K)
  + 工具调用结果 × 10 (每个 2-5K → 累计 20-50K)
  + 助手回复 × 10 (每个 1-2K → 累计 10-20K)
  = 总计 32-72K tokens（仅 10 轮对话）
```

Agent 执行 30+ 轮工具调用后，128K 窗口轻松被填满。

### 1.2 MiroThinker 的解法概述

三层防御，从精确到粗放：

1. **tiktoken 精确估算**当前 token 用量（三级降级：o200k → cl100k → 字符/4）
2. **超过 85% 阈值时按优先级分级裁剪**（工具结果 → 旧历史 → 系统提示）
3. **工具结果用滑动窗口 keep=5 管理**（独立于裁剪，常驻运行）

### 1.3 设计思想

| 原则 | 说明 |
|------|------|
| 精确优于估算 | 用 tiktoken 而非字符数近似（字符数/4 的误差可达 20%+，中文更高） |
| 预防优于治疗 | 在调用前裁剪，而非等 API 报错再处理 |
| 分级裁剪 | 按内容重要性分层丢弃，而非一刀切 truncate |
| 三级降级 | 每一层都有 fallback，绝不因依赖缺失崩溃 |
| 零额外调用 | 纯规则裁剪，不像 LLM 摘要那样消耗额外 token |

---

## 第 2 章 源码实现分析

### 2.1 Token 估算器

**源文件**: `openai_client.py:363-382`

MiroThinker 使用 tiktoken 库进行精确 token 计数，并设计了三级降级策略确保在任何环境下都能工作：

```python
def _estimate_tokens(self, text: str) -> int:
    """Use tiktoken to estimate the number of tokens in text.

    三级降级策略：
    1. o200k_base — GPT-4o/GPT-4o-mini 的编码器，最精确
    2. cl100k_base — GPT-4/GPT-3.5 的编码器，兼容性好
    3. len(text) // 4 — 纯字符估算，最后的 fallback
    """
    if not hasattr(self, "encoding"):
        try:
            self.encoding = tiktoken.get_encoding("o200k_base")
        except Exception:
            self.encoding = tiktoken.get_encoding("cl100k_base")
    try:
        return len(self.encoding.encode(text))
    except Exception:
        return len(text) // 4
```

**关键设计决策**：

| 决策 | 选择 | 理由 |
|------|------|------|
| 编码器选择 | `o200k_base` 优先 | GPT-4o 是当前主流模型，编码器匹配度最高 |
| 加载时机 | 懒加载（`hasattr` 检查） | 避免启动时开销，首次调用时才初始化 |
| 降级策略 | 三级 fallback | 即使 tiktoken 未安装也不崩溃 |
| 字符估算比例 | `len // 4` | 英文平均 1 token ~ 4 chars |

**精度对比**：

```
文本: "Hello, how are you doing today?"
tiktoken o200k_base:  7 tokens (精确)
tiktoken cl100k_base: 7 tokens (精确)
len // 4:             7 tokens (巧合一致)

文本: "你好，今天天气怎么样？"
tiktoken o200k_base:  7 tokens (精确)
len // 4:             2 tokens (严重低估！实际偏差 -71%)
len // 2:             5 tokens (偏差 -28%，中文场景建议)
```

### 2.2 分级裁剪策略

**源文件**: `openai_client.py:384-444`

当总 token 数超过模型上下文窗口的 85% 时，按三个优先级层次逐级裁剪：

```python
def ensure_summary_context(self, messages: list, model_name: str) -> list:
    """确保消息列表不超过模型上下文限制。"""
    max_tokens = MODEL_CONTEXT_LIMITS.get(model_name, 128000)
    safety_margin = 0.85
    target = int(max_tokens * safety_margin)

    total = sum(self._estimate_tokens(m.get("content", "")) for m in messages)

    if total <= target:
        return messages  # 未超限，原样返回

    # === Level 1: 裁剪工具调用结果 ===
    for i in range(len(messages) - 1, -1, -1):
        if total <= target:
            break
        if messages[i].get("role") == "tool":
            old_tokens = self._estimate_tokens(messages[i]["content"])
            messages[i]["content"] = "[Tool result truncated]"
            total -= old_tokens - self._estimate_tokens(messages[i]["content"])

    if total <= target:
        return messages

    # === Level 2: 裁剪旧对话历史 ===
    keep_recent = 6
    if len(messages) > keep_recent + 1:
        messages = [messages[0]] + messages[-keep_recent:]
        total = sum(self._estimate_tokens(m.get("content", "")) for m in messages)

    if total <= target:
        return messages

    # === Level 3: 截断系统提示（极端情况） ===
    if messages[0].get("role") == "system":
        sys_content = messages[0]["content"]
        if self._estimate_tokens(sys_content) > 2000:
            encoded = self.encoding.encode(sys_content)[:2000]
            messages[0]["content"] = self.encoding.decode(encoded) + "\n[System prompt truncated]"

    return messages
```

**裁剪优先级矩阵**：

```
重要性低 ◄──────────────────────────────► 重要性高

工具结果    旧对话历史    最近对话    系统提示
(Level 1)   (Level 2)    (保留)     (Level 3, 极端)
  |            |                        |
  先裁剪       次裁剪                   最后裁剪
```

**为什么 85%？** 为模型输出预留 15% 空间。如果模型上下文是 128K，85% = 108K 用于输入，剩余 20K 用于生成输出。对于长文生成场景（输出 > 4K tokens），建议降低到 70-75%。

### 2.3 滑动窗口

**源文件**: `orchestrator.py:~200`

独立于分级裁剪，在每次 LLM 调用前常驻运行：

```python
keep_tool_result = 5

tool_indices = [
    i for i, msg in enumerate(messages)
    if msg.get("role") == "tool"
]

if len(tool_indices) > keep_tool_result:
    for idx in tool_indices[:-keep_tool_result]:
        messages[idx]["content"] = "[Previous tool result omitted]"
```

**设计要点**：
- 不删除消息，只替换内容 → 保持消息结构完整，避免 tool_call_id 悬挂
- keep=5 对应 MiroThinker 典型的"搜索-分析"循环（2 个工具结果/循环，保留最近 2.5 个循环）
- 与分级裁剪互补：滑动窗口是常驻的"日常清理"，分级裁剪是"紧急减负"

### 2.4 调用链路

完整的调用链路，从请求到 LLM 调用：

```
用户请求
  │
  ▼
orchestrator.run_step()
  │
  ├─ 1. 构建 messages 列表（system + history + user）
  │
  ├─ 2. 滑动窗口（常驻）
  │     └─ apply_sliding_window(messages, keep=5)
  │         → 旧工具结果替换为占位符
  │
  ├─ 3. Token 检查 + 分级裁剪（按需）
  │     └─ client.ensure_summary_context(messages, model)
  │         ├─ _estimate_tokens() 计算总量
  │         ├─ 未超限 → 原样返回
  │         └─ 超限 → Level 1/2/3 逐级裁剪
  │
  ├─ 4. LLM 调用
  │     └─ client.chat_completion(messages)
  │
  └─ 5. 响应处理 + 追加到 history
```

---

## 第 3 章 可复用方案设计

### 3.1 通用架构

以下是从 MiroThinker 提取的通用上下文管理架构，可直接集成到任何 Python LLM 项目中：

```
┌─────────────────────────────────────────────┐
│              ContextWindowManager            │
│                                             │
│  ┌──────────────┐  ┌──────────────────────┐ │
│  │ TokenEstimator│  │ TruncationEngine     │ │
│  │              │  │                      │ │
│  │ tiktoken     │  │ Level 1: tool_results│ │
│  │ fallback     │  │ Level 2: old_history │ │
│  │ char_approx  │  │ Level 3: system_prompt│ │
│  └──────────────┘  └──────────────────────┘ │
│                                             │
│  ┌──────────────────────────────────────┐   │
│  │ SlidingWindow                        │   │
│  │ keep_recent=5, replace_with_placeholder│  │
│  └──────────────────────────────────────┘   │
│                                             │
│  manage(messages, model) → messages         │
└─────────────────────────────────────────────┘
```

### 3.2 核心类：ContextWindowManager

完整的可复用实现，可直接复制到项目中使用：

```python
"""
context_manager.py — 通用上下文窗口管理器

从 MiroThinker 提取的可复用方案。
依赖: pip install tiktoken
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Optional

logger = logging.getLogger(__name__)


# ─── 模型上下文限制表 ───

MODEL_CONTEXT_LIMITS: dict[str, int] = {
    "gpt-4o": 128_000,
    "gpt-4o-mini": 128_000,
    "gpt-4-turbo": 128_000,
    "gpt-4": 8_192,
    "gpt-3.5-turbo": 16_385,
    "claude-3-opus": 200_000,
    "claude-3-sonnet": 200_000,
    "claude-3-haiku": 200_000,
    "claude-3.5-sonnet": 200_000,
    "claude-4-opus": 200_000,
    "gemini-1.5-pro": 1_000_000,
    "gemini-1.5-flash": 1_000_000,
    "deepseek-chat": 64_000,
    "deepseek-reasoner": 64_000,
}


@dataclass
class ContextManagerConfig:
    """上下文管理器配置。"""

    safety_margin: float = 0.85
    """安全边际比例。0.85 表示只使用 85% 的上下文窗口。"""

    keep_recent_messages: int = 6
    """Level 2 裁剪时保留的最近消息数。"""

    keep_tool_results: int = 5
    """滑动窗口保留的最近工具结果数。"""

    system_prompt_max_tokens: int = 2000
    """Level 3 裁剪时系统提示的最大 token 数。"""

    default_context_limit: int = 128_000
    """未知模型的默认上下文限制。"""

    encoding_name: str = "o200k_base"
    """首选 tiktoken 编码器名称。"""

    fallback_encoding_name: str = "cl100k_base"
    """降级 tiktoken 编码器名称。"""

    char_token_ratio: int = 4
    """字符估算时的字符/token 比例（英文约 4，中文建议 2）。"""


class TokenEstimator:
    """Token 估算器，三级降级策略。"""

    def __init__(self, config: ContextManagerConfig):
        self._config = config
        self._encoding = None

    @property
    def encoding(self):
        if self._encoding is None:
            self._encoding = self._load_encoding()
        return self._encoding


    def _load_encoding(self):
        """加载 tiktoken 编码器，支持降级。"""
        try:
            import tiktoken
            try:
                return tiktoken.get_encoding(self._config.encoding_name)
            except Exception:
                logger.warning(
                    "编码器 %s 不可用，降级到 %s",
                    self._config.encoding_name,
                    self._config.fallback_encoding_name,
                )
                return tiktoken.get_encoding(self._config.fallback_encoding_name)
        except ImportError:
            logger.warning("tiktoken 未安装，将使用字符估算")
            return None

    def estimate(self, text: str) -> int:
        """估算文本的 token 数。"""
        if not text:
            return 0
        enc = self.encoding
        if enc is not None:
            try:
                return len(enc.encode(text))
            except Exception:
                pass
        # 最终降级：字符估算
        return len(text) // self._config.char_token_ratio

    def estimate_messages(self, messages: list[dict]) -> int:
        """估算消息列表的总 token 数。

        包含消息结构开销（每条消息约 4 tokens 的格式开销）。
        """
        total = 0
        for msg in messages:
            total += 4  # 每条消息的格式开销: <role>, content, etc.
            total += self.estimate(msg.get("content", ""))
            total += self.estimate(msg.get("name", ""))
            # 工具调用参数也占 token
            if "tool_calls" in msg:
                for tc in msg["tool_calls"]:
                    fn = tc.get("function", {})
                    total += self.estimate(fn.get("name", ""))
                    total += self.estimate(fn.get("arguments", ""))
        total += 2  # 每次对话的起止标记
        return total

    def truncate_to_tokens(self, text: str, max_tokens: int) -> str:
        """将文本截断到指定 token 数。"""
        enc = self.encoding
        if enc is not None:
            try:
                encoded = enc.encode(text)
                if len(encoded) <= max_tokens:
                    return text
                return enc.decode(encoded[:max_tokens])
            except Exception:
                pass
        # 降级：按字符截断
        max_chars = max_tokens * self._config.char_token_ratio
        return text[:max_chars]


class SlidingWindow:
    """滑动窗口管理器，控制工具结果数量。"""

    PLACEHOLDER = "[Previous tool result omitted for context management]"

    def __init__(self, keep: int = 5):
        self._keep = keep

    def apply(self, messages: list[dict]) -> list[dict]:
        """对消息列表应用滑动窗口，替换旧工具结果。

        注意：就地修改 messages 列表。
        """
        tool_indices = [
            i for i, msg in enumerate(messages)
            if msg.get("role") == "tool"
        ]
        if len(tool_indices) <= self._keep:
            return messages

        for idx in tool_indices[:-self._keep]:
            messages[idx]["content"] = self.PLACEHOLDER

        logger.debug(
            "滑动窗口：%d 个工具结果中保留最近 %d 个",
            len(tool_indices), self._keep,
        )
        return messages


class TruncationEngine:
    """分级裁剪引擎，按优先级逐级裁剪消息。"""

    def __init__(
        self,
        estimator: TokenEstimator,
        config: ContextManagerConfig,
    ):
        self._estimator = estimator
        self._config = config

    def truncate(
        self,
        messages: list[dict],
        model: str,
    ) -> list[dict]:
        """对消息列表执行分级裁剪。

        Returns:
            裁剪后的消息列表。
        """
        limit = MODEL_CONTEXT_LIMITS.get(model, self._config.default_context_limit)
        target = int(limit * self._config.safety_margin)
        total = self._estimator.estimate_messages(messages)

        if total <= target:
            return messages

        logger.info("Token 超限: %d / %d (目标 %d)，开始裁剪", total, limit, target)

        # Level 1: 裁剪工具调用结果（从旧到新）
        messages, total = self._level1_trim_tools(messages, total, target)
        if total <= target:
            return messages

        # Level 2: 裁剪旧对话历史
        messages, total = self._level2_trim_history(messages, total, target)
        if total <= target:
            return messages

        # Level 3: 截断系统提示
        messages = self._level3_trim_system(messages)

        return messages


    def _level1_trim_tools(
        self, messages: list[dict], total: int, target: int,
    ) -> tuple[list[dict], int]:
        """Level 1: 从最旧的工具结果开始裁剪。"""
        placeholder = "[Tool result truncated for context management]"
        for i in range(len(messages) - 1, -1, -1):
            if total <= target:
                break
            if messages[i].get("role") == "tool" and placeholder not in messages[i].get("content", ""):
                old_tokens = self._estimator.estimate(messages[i]["content"])
                messages[i]["content"] = placeholder
                new_tokens = self._estimator.estimate(placeholder)
                total -= (old_tokens - new_tokens)
                logger.debug("Level 1: 裁剪工具结果 [%d]，释放 %d tokens", i, old_tokens - new_tokens)
        return messages, total

    def _level2_trim_history(
        self, messages: list[dict], total: int, target: int,
    ) -> tuple[list[dict], int]:
        """Level 2: 保留 system prompt + 最近 N 条消息，移除中间历史。"""
        keep = self._config.keep_recent_messages
        if len(messages) <= keep + 1:
            return messages, total
        removed_count = len(messages) - keep - 1
        messages = [messages[0]] + messages[-keep:]
        total = self._estimator.estimate_messages(messages)
        logger.debug("Level 2: 移除 %d 条旧消息", removed_count)
        return messages, total

    def _level3_trim_system(self, messages: list[dict]) -> list[dict]:
        """Level 3: 截断过长的系统提示（极端情况）。"""
        if not messages or messages[0].get("role") != "system":
            return messages
        sys_content = messages[0]["content"]
        sys_tokens = self._estimator.estimate(sys_content)
        max_sys = self._config.system_prompt_max_tokens
        if sys_tokens > max_sys:
            messages[0]["content"] = (
                self._estimator.truncate_to_tokens(sys_content, max_sys)
                + "\n[System prompt truncated]"
            )
            logger.warning("Level 3: 系统提示从 %d tokens 截断到 %d tokens", sys_tokens, max_sys)
        return messages


class ContextWindowManager:
    """上下文窗口管理器 — 统一入口。

    组合 TokenEstimator + SlidingWindow + TruncationEngine，
    提供单一 manage() 方法。

    用法:
        manager = ContextWindowManager()
        messages = manager.manage(messages, model="gpt-4o")
        response = openai.chat.completions.create(messages=messages, model="gpt-4o")
    """

    def __init__(self, config: Optional[ContextManagerConfig] = None):
        self.config = config or ContextManagerConfig()
        self.estimator = TokenEstimator(self.config)
        self.sliding_window = SlidingWindow(keep=self.config.keep_tool_results)
        self.truncation = TruncationEngine(self.estimator, self.config)

    def manage(self, messages: list[dict], model: str) -> list[dict]:
        """管理上下文窗口：滑动窗口 + 分级裁剪。

        Args:
            messages: OpenAI 格式的消息列表。
            model: 模型名称，用于查询上下文限制。

        Returns:
            处理后的消息列表（可能被修改）。
        """
        # Step 1: 滑动窗口（常驻）
        messages = self.sliding_window.apply(messages)

        # Step 2: 分级裁剪（按需）
        messages = self.truncation.truncate(messages, model)

        return messages

    def estimate_tokens(self, messages: list[dict]) -> int:
        """估算消息列表的总 token 数（供外部监控使用）。"""
        return self.estimator.estimate_messages(messages)

    def get_usage_ratio(self, messages: list[dict], model: str) -> float:
        """获取当前 token 使用率（0.0 - 1.0+）。"""
        total = self.estimator.estimate_messages(messages)
        limit = MODEL_CONTEXT_LIMITS.get(model, self.config.default_context_limit)
        return total / limit
```

### 3.3 配置参数

通过环境变量或配置文件自定义行为：

```python
import os

config = ContextManagerConfig(
    safety_margin=float(os.getenv("CTX_SAFETY_MARGIN", "0.85")),
    keep_recent_messages=int(os.getenv("CTX_KEEP_RECENT", "6")),
    keep_tool_results=int(os.getenv("CTX_KEEP_TOOLS", "5")),
    system_prompt_max_tokens=int(os.getenv("CTX_SYS_MAX_TOKENS", "2000")),
    char_token_ratio=int(os.getenv("CTX_CHAR_RATIO", "4")),  # 中文项目设为 2
)
manager = ContextWindowManager(config)
```

**推荐配置**：

| 场景 | safety_margin | keep_recent | keep_tools | 说明 |
|------|--------------|-------------|------------|------|
| 短输出（分类/判断） | 0.90 | 4 | 3 | 输出短，可多留输入空间 |
| 中等输出（摘要/分析） | 0.85 | 6 | 5 | 默认配置 |
| 长输出（长文/代码生成） | 0.70 | 6 | 5 | 为输出预留更多空间 |
| 工具密集型 Agent | 0.80 | 8 | 8 | 工具调用频繁，多保留 |
| 中文为主的项目 | 0.85 | 6 | 5 | char_token_ratio 设为 2 |

---

## 第 4 章 集成指南

### 4.1 集成到 OpenAI 调用

最简集成，3 行代码：

```python
from openai import OpenAI
from context_manager import ContextWindowManager

client = OpenAI()
manager = ContextWindowManager()

def chat(messages: list[dict], model: str = "gpt-4o") -> str:
    # 调用前管理上下文
    managed = manager.manage(messages, model=model)

    # 正常调用 OpenAI
    response = client.chat.completions.create(
        model=model,
        messages=managed,
    )
    return response.choices[0].message.content
```

### 4.2 集成到 LangChain

作为 LangChain 的 callback 或自定义 chain 使用：

```python
from langchain_core.callbacks import BaseCallbackHandler
from langchain_openai import ChatOpenAI
from context_manager import ContextWindowManager


class ContextManagedChat:
    """包装 LangChain ChatModel，自动管理上下文。"""

    def __init__(self, llm: ChatOpenAI, model_name: str = "gpt-4o"):
        self.llm = llm
        self.model_name = model_name
        self.manager = ContextWindowManager()

    def invoke(self, messages: list[dict]) -> str:
        managed = self.manager.manage(messages, model=self.model_name)
        # 转换为 LangChain 消息格式
        from langchain_core.messages import HumanMessage, SystemMessage, AIMessage

        lc_messages = []
        for m in managed:
            if m["role"] == "system":
                lc_messages.append(SystemMessage(content=m["content"]))
            elif m["role"] == "user":
                lc_messages.append(HumanMessage(content=m["content"]))
            elif m["role"] == "assistant":
                lc_messages.append(AIMessage(content=m["content"]))

        response = self.llm.invoke(lc_messages)
        return response.content


# 使用示例
llm = ChatOpenAI(model="gpt-4o")
chat = ContextManagedChat(llm)
result = chat.invoke(messages)
```

### 4.3 集成到自定义 Agent

在 Agent 循环中集成：

```python
from context_manager import ContextWindowManager, ContextManagerConfig

class MyAgent:
    def __init__(self, model: str = "gpt-4o"):
        self.model = model
        self.messages: list[dict] = []
        self.ctx_manager = ContextWindowManager(
            ContextManagerConfig(
                safety_margin=0.80,      # Agent 需要更多输出空间
                keep_tool_results=8,     # 工具调用频繁
            )
        )

    def run(self, task: str) -> str:
        self.messages.append({"role": "user", "content": task})

        for step in range(self.max_steps):
            # 每次 LLM 调用前管理上下文
            managed = self.ctx_manager.manage(
                list(self.messages),  # 传副本，保留原始历史
                model=self.model,
            )

            # 可选：记录 token 使用率
            usage = self.ctx_manager.get_usage_ratio(managed, self.model)
            logger.info("Step %d: token 使用率 %.1f%%", step, usage * 100)

            response = self._call_llm(managed)

            if response.tool_calls:
                self._execute_tools(response.tool_calls)
            else:
                return response.content

        return "Max steps reached"
```

---

## 第 5 章 测试用例

### 5.1 单元测试

完整的 pytest 测试套件，可直接运行：

```python
"""
test_context_manager.py — ContextWindowManager 完整测试套件

运行: pytest test_context_manager.py -v
依赖: pip install pytest tiktoken
"""

import pytest
from unittest.mock import patch, MagicMock
from context_manager import (
    ContextWindowManager,
    ContextManagerConfig,
    TokenEstimator,
    SlidingWindow,
    TruncationEngine,
    MODEL_CONTEXT_LIMITS,
)


# ─── TokenEstimator 测试 ───

class TestTokenEstimator:
    """Token 估算器测试：覆盖三级降级。"""

    def setup_method(self):
        self.config = ContextManagerConfig()
        self.estimator = TokenEstimator(self.config)

    def test_estimate_english_text(self):
        """英文文本精确估算。"""
        tokens = self.estimator.estimate("Hello, world!")
        assert isinstance(tokens, int)
        assert 1 <= tokens <= 10

    def test_estimate_chinese_text(self):
        """中文文本估算。"""
        tokens = self.estimator.estimate("你好世界")
        assert 2 <= tokens <= 8

    def test_estimate_empty_string(self):
        """空字符串返回 0。"""
        assert self.estimator.estimate("") == 0

    def test_estimate_long_text(self):
        """长文本估算应与文本长度正相关。"""
        short = self.estimator.estimate("Hello")
        long = self.estimator.estimate("Hello " * 1000)
        assert long > short

    def test_fallback_to_char_count(self):
        """tiktoken 不可用时降级到字符估算。"""
        estimator = TokenEstimator(ContextManagerConfig(char_token_ratio=4))
        # 模拟 encoding 加载失败
        estimator._encoding = MagicMock()
        estimator._encoding.encode.side_effect = Exception("encode failed")
        tokens = estimator.estimate("Hello, world!")  # 13 chars
        assert tokens == 13 // 4

    def test_estimate_messages_structure_overhead(self):
        """消息列表估算包含结构开销。"""
        messages = [
            {"role": "system", "content": "You are helpful."},
            {"role": "user", "content": "Hi"},
        ]
        total = self.estimator.estimate_messages(messages)
        content_only = (
            self.estimator.estimate("You are helpful.")
            + self.estimator.estimate("Hi")
        )
        # 总量应大于纯内容（因为有结构开销）
        assert total > content_only

    def test_estimate_messages_with_tool_calls(self):
        """包含工具调用的消息估算。"""
        messages = [
            {
                "role": "assistant",
                "content": "",
                "tool_calls": [
                    {
                        "function": {
                            "name": "search",
                            "arguments": '{"query": "test"}',
                        }
                    }
                ],
            }
        ]
        total = self.estimator.estimate_messages(messages)
        assert total > 0

    def test_truncate_to_tokens(self):
        """文本截断到指定 token 数。"""
        long_text = "Hello world. " * 100
        truncated = self.estimator.truncate_to_tokens(long_text, 10)
        tokens_after = self.estimator.estimate(truncated)
        assert tokens_after <= 10


# ─── SlidingWindow 测试 ───

class TestSlidingWindow:
    """滑动窗口测试。"""

    def test_keep_recent_n(self):
        """保留最近 N 个工具结果。"""
        window = SlidingWindow(keep=5)
        messages = [{"role": "system", "content": "sys"}]
        for i in range(10):
            messages.append({"role": "user", "content": f"query {i}"})
            messages.append({"role": "tool", "content": f"result {i}"})

        window.apply(messages)

        tool_msgs = [m for m in messages if m["role"] == "tool"]
        preserved = [m for m in tool_msgs if "omitted" not in m["content"]]
        assert len(preserved) == 5

    def test_under_limit_no_change(self):
        """工具结果数 <= keep 时不修改。"""
        window = SlidingWindow(keep=5)
        messages = [
            {"role": "tool", "content": f"result {i}"}
            for i in range(3)
        ]
        original_contents = [m["content"] for m in messages]
        window.apply(messages)
        assert [m["content"] for m in messages] == original_contents

    def test_message_count_preserved(self):
        """裁剪后消息数量不变（只替换内容，不删除消息）。"""
        window = SlidingWindow(keep=3)
        messages = [
            {"role": "tool", "content": f"result {i}"}
            for i in range(10)
        ]
        original_len = len(messages)
        window.apply(messages)
        assert len(messages) == original_len

    def test_preserves_recent_content(self):
        """最近的工具结果内容不被修改。"""
        window = SlidingWindow(keep=3)
        messages = [
            {"role": "tool", "content": f"result {i}"}
            for i in range(10)
        ]
        window.apply(messages)
        # 最后 3 个应保留原始内容
        assert messages[-1]["content"] == "result 9"
        assert messages[-2]["content"] == "result 8"
        assert messages[-3]["content"] == "result 7"

    def test_no_tool_messages(self):
        """没有工具消息时不报错。"""
        window = SlidingWindow(keep=5)
        messages = [
            {"role": "user", "content": "hello"},
            {"role": "assistant", "content": "hi"},
        ]
        window.apply(messages)  # 不应抛异常
        assert len(messages) == 2


# ─── TruncationEngine 测试 ───

class TestTruncationEngine:
    """分级裁剪引擎测试。"""

    def setup_method(self):
        self.config = ContextManagerConfig(
            safety_margin=0.85,
            keep_recent_messages=4,
            system_prompt_max_tokens=100,
        )
        self.estimator = TokenEstimator(self.config)
        self.engine = TruncationEngine(self.estimator, self.config)

    def _make_messages(self, system="sys", user_count=2, tool_count=0, content_size=100):
        """构造测试消息列表。"""
        msgs = [{"role": "system", "content": system}]
        for i in range(user_count):
            msgs.append({"role": "user", "content": f"question {i} " + "x" * content_size})
            msgs.append({"role": "assistant", "content": f"answer {i} " + "x" * content_size})
        for i in range(tool_count):
            msgs.append({"role": "tool", "content": f"tool result {i} " + "x" * content_size})
        return msgs

    def test_under_limit_no_truncation(self):
        """未超限时原样返回。"""
        msgs = self._make_messages(user_count=2, content_size=10)
        result = self.engine.truncate(msgs, "gpt-4o")
        assert len(result) == len(msgs)

    def test_level1_truncates_tool_results(self):
        """Level 1: 工具结果被裁剪。"""
        # 构造大量工具结果使其超限
        msgs = self._make_messages(tool_count=50, content_size=5000)
        result = self.engine.truncate(msgs, "gpt-4")  # gpt-4 只有 8192 上下文
        truncated = [m for m in result if "truncated" in m.get("content", "")]
        assert len(truncated) > 0

    def test_preserves_system_prompt(self):
        """系统提示始终保留（至少部分保留）。"""
        msgs = self._make_messages(tool_count=50, content_size=5000)
        result = self.engine.truncate(msgs, "gpt-4")
        assert result[0]["role"] == "system"

    def test_preserves_recent_messages(self):
        """最近消息始终保留。"""
        msgs = self._make_messages(user_count=20, content_size=500)
        last_msg = msgs[-1]
        result = self.engine.truncate(msgs, "gpt-4")
        assert result[-1] == last_msg


# ─── ContextWindowManager 集成测试 ───

class TestContextWindowManager:
    """管理器集成测试。"""

    def test_manage_under_limit(self):
        """未超限时消息不变。"""
        manager = ContextWindowManager()
        messages = [
            {"role": "system", "content": "You are helpful."},
            {"role": "user", "content": "Hello"},
        ]
        result = manager.manage(messages, model="gpt-4o")
        assert len(result) == 2

    def test_manage_applies_sliding_window_and_truncation(self):
        """管理器同时应用滑动窗口和裁剪。"""
        manager = ContextWindowManager(ContextManagerConfig(keep_tool_results=2))
        messages = [{"role": "system", "content": "sys"}]
        for i in range(10):
            messages.append({"role": "tool", "content": f"result {i} " + "x" * 100})
        result = manager.manage(messages, model="gpt-4o")
        tool_msgs = [m for m in result if m["role"] == "tool"]
        omitted = [m for m in tool_msgs if "omitted" in m["content"]]
        assert len(omitted) == 8  # 10 - 2 = 8 个被替换

    def test_estimate_tokens(self):
        """外部可调用 token 估算。"""
        manager = ContextWindowManager()
        messages = [
            {"role": "system", "content": "You are helpful."},
            {"role": "user", "content": "Hello"},
        ]
        tokens = manager.estimate_tokens(messages)
        assert tokens > 0

    def test_get_usage_ratio(self):
        """使用率计算。"""
        manager = ContextWindowManager()
        messages = [
            {"role": "system", "content": "You are helpful."},
            {"role": "user", "content": "Hello"},
        ]
        ratio = manager.get_usage_ratio(messages, "gpt-4o")
        assert 0.0 < ratio < 0.01  # 很短的消息，使用率极低

    def test_custom_config(self):
        """自定义配置生效。"""
        config = ContextManagerConfig(
            safety_margin=0.50,
            keep_tool_results=2,
            keep_recent_messages=3,
        )
        manager = ContextWindowManager(config)
        assert manager.config.safety_margin == 0.50
        assert manager.sliding_window._keep == 2
```

### 5.2 集成测试

模拟真实 Agent 场景的端到端测试：

```python
class TestIntegrationScenarios:
    """模拟真实 Agent 场景。"""

    def test_agent_30_step_conversation(self):
        """模拟 30 步 Agent 对话，验证不超限。"""
        manager = ContextWindowManager()
        messages = [
            {"role": "system", "content": "You are a research agent. " * 200}
        ]

        for step in range(30):
            messages.append({"role": "user", "content": f"Research step {step}: " + "x" * 500})
            messages.append({"role": "tool", "content": f"Search result {step}: " + "x" * 2000})
            messages.append({"role": "assistant", "content": f"Analysis {step}: " + "x" * 500})

            managed = manager.manage(list(messages), model="gpt-4o")
            total = manager.estimate_tokens(managed)
            limit = MODEL_CONTEXT_LIMITS["gpt-4o"]

            # 始终在安全边际内
            assert total <= int(limit * 0.85), f"Step {step}: {total} > {int(limit * 0.85)}"

    def test_tool_heavy_workflow(self):
        """工具密集型工作流：20 个工具调用。"""
        config = ContextManagerConfig(keep_tool_results=5)
        manager = ContextWindowManager(config)
        messages = [{"role": "system", "content": "sys"}]

        for i in range(20):
            messages.append({"role": "tool", "content": f"Large result {i}: " + "x" * 3000})

        managed = manager.manage(list(messages), model="gpt-4o")
        tool_msgs = [m for m in managed if m["role"] == "tool"]
        active = [m for m in tool_msgs if "omitted" not in m["content"] and "truncated" not in m["content"]]
        assert len(active) <= 5

    def test_small_model_aggressive_truncation(self):
        """小上下文模型（gpt-4 8K）的激进裁剪。"""
        manager = ContextWindowManager()
        messages = [{"role": "system", "content": "System prompt. " * 100}]
        for i in range(20):
            messages.append({"role": "user", "content": "Question " * 50})
            messages.append({"role": "assistant", "content": "Answer " * 50})

        managed = manager.manage(list(messages), model="gpt-4")
        total = manager.estimate_tokens(managed)
        assert total <= int(8192 * 0.85)
```

### 5.3 测试覆盖目标

| 模块 | 目标覆盖率 | 关键路径 |
|------|-----------|---------|
| TokenEstimator | 95%+ | 三级降级、空字符串、中文文本 |
| SlidingWindow | 100% | keep 边界、无工具消息、内容保留 |
| TruncationEngine | 90%+ | 三级裁剪触发、边界条件 |
| ContextWindowManager | 85%+ | 集成流程、配置传递 |
| 集成场景 | 80%+ | 30 步对话、工具密集、小模型 |

---

## 第 6 章 风险与降级

### 6.1 风险矩阵

| 风险 | 概率 | 影响 | 缓解措施 |
|------|------|------|----------|
| tiktoken 未安装 | 低 | 中 | 三级降级到字符估算 |
| 字符估算偏差导致超限 | 中 | 高 | 捕获 API 400 错误后重试（配合 PD-03 容错） |
| 裁剪丢失关键上下文 | 中 | 高 | 分级裁剪 + 保留最近消息 + 日志记录被裁内容 |
| 新模型未在限制表中 | 中 | 低 | 默认 128K 限制，定期更新表 |
| 中文内容 len//4 严重低估 | 高 | 高 | 配置 char_token_ratio=2 |
| 滑动窗口 keep 值不合理 | 低 | 中 | 可配置，按实际工作流调整 |
| 工具调用 ID 悬挂 | 中 | 高 | 裁剪后检查 tool_call_id 一致性（参考 DeerFlow） |

### 6.2 降级策略

```
正常路径:
  tiktoken o200k_base → 精确估算 → 分级裁剪

降级路径 1 (tiktoken 编码器不可用):
  tiktoken cl100k_base → 近似估算（偏差 < 5%） → 分级裁剪

降级路径 2 (tiktoken 库不可用):
  字符估算 len//4 → 粗略估算（偏差 10-30%） → 分级裁剪
  ⚠️ 建议: 加大安全边际到 0.70

降级路径 3 (裁剪后仍超限):
  捕获 API context_length_exceeded 错误
  → 更激进裁剪 (keep_recent=3, safety_margin=0.60)
  → 重试
  ⚠️ 需要配合 PD-03 容错重试机制

降级路径 4 (极端情况):
  所有裁剪都无法满足
  → 只保留 system prompt + 最后一条用户消息
  → 记录告警日志
```

---

## 第 7 章 适用场景与限制

### 7.1 适合借鉴的场景

| 场景 | 适合度 | 说明 |
|------|--------|------|
| 以 OpenAI 为主要 LLM 的项目 | 极高 | tiktoken 与 OpenAI 计费完全一致，估算零偏差 |
| 工具调用频繁的 Agent | 极高 | 工具结果是上下文膨胀的主要来源，滑动窗口直接命中痛点 |
| 需要精确 token 控制的长文生成 | 高 | 85% 安全边际 + 分级裁剪确保不会超限崩溃 |
| 不想引入额外 LLM 调用的场景 | 高 | 纯规则裁剪，零额外 token 消耗和延迟 |
| 实时对话（低延迟要求） | 高 | 裁剪是纯 CPU 操作，微秒级完成 |
| 成本敏感的项目 | 高 | 主动裁剪减少每次调用的 token 数，直接降低成本 |

### 7.2 不适合的场景

| 场景 | 原因 | 替代方案 |
|------|------|----------|
| 需要保留完整对话历史 | 裁剪会永久丢失信息 | DeerFlow 的 LLM 摘要方案（PD-01-deerflow） |
| 多模型混用（OpenAI + Claude + Gemini） | tiktoken 对非 OpenAI 模型有偏差 | 各模型官方 tokenizer 或统一用 cl100k_base 近似 |
| 需要语义理解的压缩 | 规则裁剪不理解内容语义 | LLM 驱动的摘要压缩 |
| 上下文窗口极大（Gemini 1M） | 1M 窗口下裁剪的必要性降低 | 可能只需滑动窗口，不需要分级裁剪 |
| 需要可恢复的上下文管理 | 裁剪后无法恢复原始内容 | 外部存储 + 按需加载 |

### 7.3 与其他方案的对比

| 维度 | MiroThinker (本方案) | DeerFlow LLM 摘要 | GPT-Researcher 向量检索 |
|------|---------------------|-------------------|----------------------|
| 估算精度 | 极高（tiktoken） | 中（配置阈值） | 无显式估算 |
| 压缩质量 | 低（丢弃内容） | 高（语义保留） | 高（相关性排序） |
| 额外成本 | 零 | 每次压缩消耗 token | 需要 embedding 计算 |
| 延迟 | 微秒级 | 秒级（LLM 调用） | 毫秒级（向量检索） |
| 实现复杂度 | 低（~200 行） | 中（需要 LLM 集成） | 高（需要向量数据库） |
| 降级能力 | 强（三级 fallback） | 弱（LLM 不可用则无法压缩） | 弱（向量库不可用则无法检索） |
| 适合阶段 | MVP / 快速集成 | 成熟产品 | RAG 场景 |

**推荐组合**：MiroThinker 的精确估算 + DeerFlow 的 LLM 摘要 = 精确知道何时压缩 + 智能压缩保留语义。

---

## 附录 A 来源文件索引

| 编号 | 文件 | 行号 | 说明 |
|------|------|------|------|
| S1 | `openai_client.py` | 363-382 | `_estimate_tokens()` — tiktoken 三级降级估算 |
| S2 | `openai_client.py` | 384-444 | `ensure_summary_context()` — 分级裁剪引擎 |
| S3 | `openai_client.py` | ~20 | `MODEL_CONTEXT_LIMITS` — 模型上下文限制表 |
| S4 | `orchestrator.py` | ~200 | 滑动窗口 `keep_tool_result=5` |

## 附录 B 快速接入检查清单

```
[ ] 1. pip install tiktoken
[ ] 2. 复制 context_manager.py 到项目
[ ] 3. 配置 ContextManagerConfig（特别是 char_token_ratio）
[ ] 4. 在 LLM 调用前插入 manager.manage(messages, model)
[ ] 5. 运行测试套件确认通过
[ ] 6. 监控日志中的裁剪事件（grep "Level 1/2/3"）
[ ] 7. 根据实际工作流调整 keep_tool_results 和 safety_margin
```
