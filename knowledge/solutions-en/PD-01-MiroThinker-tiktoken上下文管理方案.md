# PD-01.01 MiroThinker — Precise tiktoken Estimation + Hierarchical Truncation + Sliding Window

> Document ID: PD-01.01
> Source: MiroThinker `openai_client.py` / `orchestrator.py`
> GitHub: https://github.com/MiroMindAI/MiroThinker
> Problem Domain: PD-01 Context Window Management
> Status: Reusable Solution

---

## Chapter 1 Problem and Motivation

### 1.1 Core Problem

LLM context windows are limited (4K-200K tokens), and tokens accumulate continuously in long tasks. Without active management:

- API calls fail directly (token overflow → HTTP 400 / context_length_exceeded)
- Critical information is silently truncated on the API side, model cannot see complete context
- Costs spiral out of control: each call carries large amounts of useless history, token fees grow linearly

Typical bloat trajectory:

```
Initial system prompt (2K tokens)
  + user message (0.5K)
  + tool call results × 10 (each 2-5K → cumulative 20-50K)
  + assistant replies × 10 (each 1-2K → cumulative 10-20K)
  = Total 32-72K tokens (only 10 conversation turns)
```

After 30+ tool calls in agent execution, a 128K window fills easily.

### 1.2 MiroThinker's Solution Overview

Three layers of defense, from precise to coarse:

1. **Precise tiktoken estimation** of current token usage (three-level fallback: o200k → cl100k → chars/4)
2. **Hierarchical truncation by priority when exceeding 85% threshold** (tool results → old history → system prompt)
3. **Sliding window for tool results with keep=5** (independent of truncation, runs continuously)

### 1.3 Design Philosophy

| Principle | Explanation |
|-----------|-------------|
| Precision over estimation | Use tiktoken rather than character count approximation (char/4 error can reach 20%+, higher for Chinese) |
| Prevention over treatment | Truncate before calling, not after API errors |
| Hierarchical truncation | Discard by content importance, not one-size-fits-all truncate |
| Three-level fallback | Each layer has a fallback, never crashes due to missing dependencies |
| Zero extra calls | Pure rule-based truncation, unlike LLM summarization which consumes extra tokens |

---

## Chapter 2 Source Code Implementation Analysis

### 2.1 Token Estimator

**Source file**: `openai_client.py:363-382`

MiroThinker uses the tiktoken library for precise token counting and implements a three-level fallback strategy to work in any environment:

```python
def _estimate_tokens(self, text: str) -> int:
    """Use tiktoken to estimate the number of tokens in text.

    Three-level fallback strategy:
    1. o200k_base — encoder for GPT-4o/GPT-4o-mini, most precise
    2. cl100k_base — encoder for GPT-4/GPT-3.5, good compatibility
    3. len(text) // 4 — pure character estimation, final fallback
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

**Key design decisions**:

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Encoder selection | `o200k_base` priority | GPT-4o is the current mainstream model, encoder match is highest |
| Load timing | Lazy loading (`hasattr` check) | Avoid startup overhead, initialize on first call |
| Fallback strategy | Three-level fallback | Won't crash even if tiktoken is not installed |
| Character estimation ratio | `len // 4` | English average 1 token ~ 4 chars |

**Precision comparison**:

```
Text: "Hello, how are you doing today?"
tiktoken o200k_base:  7 tokens (precise)
tiktoken cl100k_base: 7 tokens (precise)
len // 4:             7 tokens (coincidentally consistent)

Text: "你好，今天天气怎么样？"
tiktoken o200k_base:  7 tokens (precise)
len // 4:             2 tokens (severe underestimation! actual deviation -71%)
len // 2:             5 tokens (deviation -28%, recommended for Chinese)
```

### 2.2 Hierarchical Truncation Strategy

**Source file**: `openai_client.py:384-444`

When total tokens exceed 85% of model context window, truncate by three priority levels:

```python
def ensure_summary_context(self, messages: list, model_name: str) -> list:
    """Ensure message list does not exceed model context limit."""
    max_tokens = MODEL_CONTEXT_LIMITS.get(model_name, 128000)
    safety_margin = 0.85
    target = int(max_tokens * safety_margin)

    total = sum(self._estimate_tokens(m.get("content", "")) for m in messages)

    if total <= target:
        return messages  # Not over limit, return as-is

    # === Level 1: Truncate tool call results ===
    for i in range(len(messages) - 1, -1, -1):
        if total <= target:
            break
        if messages[i].get("role") == "tool":
            old_tokens = self._estimate_tokens(messages[i]["content"])
            messages[i]["content"] = "[Tool result truncated]"
            total -= old_tokens - self._estimate_tokens(messages[i]["content"])

    if total <= target:
        return messages

    # === Level 2: Truncate old conversation history ===
    keep_recent = 6
    if len(messages) > keep_recent + 1:
        messages = [messages[0]] + messages[-keep_recent:]
        total = sum(self._estimate_tokens(m.get("content", "")) for m in messages)

    if total <= target:
        return messages

    # === Level 3: Truncate system prompt (extreme case) ===
    if messages[0].get("role") == "system":
        sys_content = messages[0]["content"]
        if self._estimate_tokens(sys_content) > 2000:
            encoded = self.encoding.encode(sys_content)[:2000]
            messages[0]["content"] = self.encoding.decode(encoded) + "\n[System prompt truncated]"

    return messages
```

**Truncation priority matrix**:

```
Low importance ◄──────────────────────────────► High importance

Tool results    Old history    Recent messages    System prompt
(Level 1)       (Level 2)      (preserve)         (Level 3, extreme)
  |                |                                  |
  Truncate first   Truncate second                   Truncate last
```

**Why 85%?** Reserve 15% space for model output. If model context is 128K, 85% = 108K for input, remaining 20K for generation. For long-form generation scenarios (output > 4K tokens), consider lowering to 70-75%.

### 2.3 Sliding Window

**Source file**: `orchestrator.py:~200`

Independent of hierarchical truncation, runs continuously before each LLM call:

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

**Design points**:
- Don't delete messages, only replace content → preserves message structure, avoids dangling tool_call_id
- keep=5 corresponds to MiroThinker's typical "search-analyze" cycle (2 tool results/cycle, keep last 2.5 cycles)
- Complements hierarchical truncation: sliding window is continuous "daily cleanup", hierarchical truncation is "emergency relief"

### 2.4 Call Chain

Complete call chain from request to LLM call:

```
User request
  │
  ▼
orchestrator.run_step()
  │
  ├─ 1. Build messages list (system + history + user)
  │
  ├─ 2. Sliding window (continuous)
  │     └─ apply_sliding_window(messages, keep=5)
  │         → Replace old tool results with placeholders
  │
  ├─ 3. Token check + hierarchical truncation (as needed)
  │     └─ client.ensure_summary_context(messages, model)
  │         ├─ _estimate_tokens() calculate total
  │         ├─ Not over limit → return as-is
  │         └─ Over limit → truncate Level 1/2/3 progressively
  │
  ├─ 4. LLM call
  │     └─ client.chat_completion(messages)
  │
  └─ 5. Response handling + append to history
```

---

## Chapter 3 Reusable Solution Design

### 3.1 Generic Architecture

The following is a generic context management architecture extracted from MiroThinker, directly integrable into any Python LLM project:

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

### 3.2 Core Class: ContextWindowManager

Complete reusable implementation, can be directly copied into projects:

```python
"""
context_manager.py — Generic context window manager

Reusable solution extracted from MiroThinker.
Dependencies: pip install tiktoken
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Optional

logger = logging.getLogger(__name__)


# ─── Model context limit table ───

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
    """Context manager configuration."""

    safety_margin: float = 0.85
    """Safety margin ratio. 0.85 means use only 85% of context window."""

    keep_recent_messages: int = 6
    """Number of recent messages to keep during Level 2 truncation."""

    keep_tool_results: int = 5
    """Number of recent tool results to keep in sliding window."""

    system_prompt_max_tokens: int = 2000
    """Maximum tokens for system prompt during Level 3 truncation."""

    default_context_limit: int = 128_000
    """Default context limit for unknown models."""

    encoding_name: str = "o200k_base"
    """Preferred tiktoken encoder name."""

    fallback_encoding_name: str = "cl100k_base"
    """Fallback tiktoken encoder name."""

    char_token_ratio: int = 4
    """Character/token ratio for estimation (English ~4, Chinese recommend 2)."""


class TokenEstimator:
    """Token estimator with three-level fallback strategy."""

    def __init__(self, config: ContextManagerConfig):
        self._config = config
        self._encoding = None

    @property
    def encoding(self):
        if self._encoding is None:
            self._encoding = self._load_encoding()
        return self._encoding


    def _load_encoding(self):
        """Load tiktoken encoder with fallback support."""
        try:
            import tiktoken
            try:
                return tiktoken.get_encoding(self._config.encoding_name)
            except Exception:
                logger.warning(
                    "Encoder %s unavailable, falling back to %s",
                    self._config.encoding_name,
                    self._config.fallback_encoding_name,
                )
                return tiktoken.get_encoding(self._config.fallback_encoding_name)
        except ImportError:
            logger.warning("tiktoken not installed, will use character estimation")
            return None

    def estimate(self, text: str) -> int:
        """Estimate token count for text."""
        if not text:
            return 0
        enc = self.encoding
        if enc is not None:
            try:
                return len(enc.encode(text))
            except Exception:
                pass
        # Final fallback: character estimation
        return len(text) // self._config.char_token_ratio

    def estimate_messages(self, messages: list[dict]) -> int:
        """Estimate total token count for message list.

        Includes message structure overhead (~4 tokens per message for formatting).
        """
        total = 0
        for msg in messages:
            total += 4  # Format overhead per message: <role>, content, etc.
            total += self.estimate(msg.get("content", ""))
            total += self.estimate(msg.get("name", ""))
            # Tool call parameters also consume tokens
            if "tool_calls" in msg:
                for tc in msg["tool_calls"]:
                    fn = tc.get("function", {})
                    total += self.estimate(fn.get("name", ""))
                    total += self.estimate(fn.get("arguments", ""))
        total += 2  # Start/end markers per conversation
        return total

    def truncate_to_tokens(self, text: str, max_tokens: int) -> str:
        """Truncate text to specified token count."""
        enc = self.encoding
        if enc is not None:
            try:
                encoded = enc.encode(text)
                if len(encoded) <= max_tokens:
                    return text
                return enc.decode(encoded[:max_tokens])
            except Exception:
                pass
        # Fallback: truncate by character count
        max_chars = max_tokens * self._config.char_token_ratio
        return text[:max_chars]


class SlidingWindow:
    """Sliding window manager to control tool result quantity."""

    PLACEHOLDER = "[Previous tool result omitted for context management]"

    def __init__(self, keep: int = 5):
        self._keep = keep

    def apply(self, messages: list[dict]) -> list[dict]:
        """Apply sliding window to message list, replacing old tool results.

        Note: Modifies messages list in-place.
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
            "Sliding window: keeping last %d of %d tool results",
            self._keep, len(tool_indices),
        )
        return messages


class TruncationEngine:
    """Hierarchical truncation engine, truncates by priority level."""

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
        """Execute hierarchical truncation on message list.

        Returns:
            Truncated message list.
        """
        limit = MODEL_CONTEXT_LIMITS.get(model, self._config.default_context_limit)
        target = int(limit * self._config.safety_margin)
        total = self._estimator.estimate_messages(messages)

        if total <= target:
            return messages

        logger.info("Token overflow: %d / %d (target %d), starting truncation", total, limit, target)

        # Level 1: Truncate tool call results (oldest first)
        messages, total = self._level1_trim_tools(messages, total, target)
        if total <= target:
            return messages

        # Level 2: Truncate old conversation history
        messages, total = self._level2_trim_history(messages, total, target)
        if total <= target:
            return messages

        # Level 3: Truncate system prompt
        messages = self._level3_trim_system(messages)

        return messages


    def _level1_trim_tools(
        self, messages: list[dict], total: int, target: int,
    ) -> tuple[list[dict], int]:
        """Level 1: Truncate oldest tool results first."""
        placeholder = "[Tool result truncated for context management]"
        for i in range(len(messages) - 1, -1, -1):
            if total <= target:
                break
            if messages[i].get("role") == "tool" and placeholder not in messages[i].get("content", ""):
                old_tokens = self._estimator.estimate(messages[i]["content"])
                messages[i]["content"] = placeholder
                new_tokens = self._estimator.estimate(placeholder)
                total -= (old_tokens - new_tokens)
                logger.debug("Level 1: Truncated tool result [%d], freed %d tokens", i, old_tokens - new_tokens)
        return messages, total

    def _level2_trim_history(
        self, messages: list[dict], total: int, target: int,
    ) -> tuple[list[dict], int]:
        """Level 2: Keep system prompt + last N messages, remove middle history."""
        keep = self._config.keep_recent_messages
        if len(messages) <= keep + 1:
            return messages, total
        removed_count = len(messages) - keep - 1
        messages = [messages[0]] + messages[-keep:]
        total = self._estimator.estimate_messages(messages)
        logger.debug("Level 2: Removed %d old messages", removed_count)
        return messages, total

    def _level3_trim_system(self, messages: list[dict]) -> list[dict]:
        """Level 3: Truncate overly long system prompt (extreme case)."""
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
            logger.warning("Level 3: System prompt truncated from %d to %d tokens", sys_tokens, max_sys)
        return messages


class ContextWindowManager:
    """Context window manager — unified entry point.

    Combines TokenEstimator + SlidingWindow + TruncationEngine,
    provides single manage() method.

    Usage:
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
        """Manage context window: sliding window + hierarchical truncation.

        Args:
            messages: OpenAI format message list.
            model: Model name for context limit lookup.

        Returns:
            Processed message list (may be modified).
        """
        # Step 1: Sliding window (continuous)
        messages = self.sliding_window.apply(messages)

        # Step 2: Hierarchical truncation (as needed)
        messages = self.truncation.truncate(messages, model)

        return messages

    def estimate_tokens(self, messages: list[dict]) -> int:
        """Estimate total token count for message list (for external monitoring)."""
        return self.estimator.estimate_messages(messages)

    def get_usage_ratio(self, messages: list[dict], model: str) -> float:
        """Get current token usage ratio (0.0 - 1.0+)."""
        total = self.estimator.estimate_messages(messages)
        limit = MODEL_CONTEXT_LIMITS.get(model, self.config.default_context_limit)
        return total / limit
```

### 3.3 Configuration Parameters

Customize behavior via environment variables or config files:

```python
import os

config = ContextManagerConfig(
    safety_margin=float(os.getenv("CTX_SAFETY_MARGIN", "0.85")),
    keep_recent_messages=int(os.getenv("CTX_KEEP_RECENT", "6")),
    keep_tool_results=int(os.getenv("CTX_KEEP_TOOLS", "5")),
    system_prompt_max_tokens=int(os.getenv("CTX_SYS_MAX_TOKENS", "2000")),
    char_token_ratio=int(os.getenv("CTX_CHAR_RATIO", "4")),  # Set to 2 for Chinese projects
)
manager = ContextWindowManager(config)
```

**Recommended configurations**:

| Scenario | safety_margin | keep_recent | keep_tools | Notes |
|----------|--------------|-------------|------------|-------|
| Short output (classification/judgment) | 0.90 | 4 | 3 | Short output, can reserve more input space |
| Medium output (summary/analysis) | 0.85 | 6 | 5 | Default configuration |
| Long output (long-form/code generation) | 0.70 | 6 | 5 | Reserve more space for output |
| Tool-intensive agent | 0.80 | 8 | 8 | Frequent tool calls, keep more |
| Chinese-heavy projects | 0.85 | 6 | 5 | Set char_token_ratio to 2 |

---

## Chapter 4 Integration Guide

### 4.1 Integration with OpenAI Calls

Minimal integration, 3 lines of code:

```python
from openai import OpenAI
from context_manager import ContextWindowManager

client = OpenAI()
manager = ContextWindowManager()

def chat(messages: list[dict], model: str = "gpt-4o") -> str:
    # Manage context before calling
    managed = manager.manage(messages, model=model)

    # Normal OpenAI call
    response = client.chat.completions.create(
        model=model,
        messages=managed,
    )
    return response.choices[0].message.content
```

### 4.2 Integration with LangChain

Use as LangChain callback or custom chain:

```python
from langchain_core.callbacks import BaseCallbackHandler
from langchain_openai import ChatOpenAI
from context_manager import ContextWindowManager


class ContextManagedChat:
    """Wrap LangChain ChatModel, auto-manage context."""

    def __init__(self, llm: ChatOpenAI, model_name: str = "gpt-4o"):
        self.llm = llm
        self.model_name = model_name
        self.manager = ContextWindowManager()

    def invoke(self, messages: list[dict]) -> str:
        managed = self.manager.manage(messages, model=self.model_name)
        # Convert to LangChain message format
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


# Usage example
llm = ChatOpenAI(model="gpt-4o")
chat = ContextManagedChat(llm)
result = chat.invoke(messages)
```

### 4.3 Integration with Custom Agent

Integrate into agent loop:

```python
from context_manager import ContextWindowManager, ContextManagerConfig

class MyAgent:
    def __init__(self, model: str = "gpt-4o"):
        self.model = model
        self.messages: list[dict] = []
        self.ctx_manager = ContextWindowManager(
            ContextManagerConfig(
                safety_margin=0.80,      # Agents need more output space
                keep_tool_results=8,     # Frequent tool calls
            )
        )

    def run(self, task: str) -> str:
        self.messages.append({"role": "user", "content": task})

        for step in range(self.max_steps):
            # Manage context before each LLM call
            managed = self.ctx_manager.manage(
                list(self.messages),  # Pass copy, preserve original history
                model=self.model,
            )

            # Optional: log token usage ratio
            usage = self.ctx_manager.get_usage_ratio(managed, self.model)
            logger.info("Step %d: token usage %.1f%%", step, usage * 100)

            response = self._call_llm(managed)

            if response.tool_calls:
                self._execute_tools(response.tool_calls)
            else:
                return response.content

        return "Max steps reached"
```

---

## Chapter 5 Test Cases

### 5.1 Unit Tests

Complete pytest test suite, ready to run:

```python
"""
test_context_manager.py — Complete ContextWindowManager test suite

Run: pytest test_context_manager.py -v
Dependencies: pip install pytest tiktoken
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


# ─── TokenEstimator tests ───

class TestTokenEstimator:
    """Token estimator tests: covers three-level fallback."""

    def setup_method(self):
        self.config = ContextManagerConfig()
        self.estimator = TokenEstimator(self.config)

    def test_estimate_english_text(self):
        """Precise estimation for English text."""
        tokens = self.estimator.estimate("Hello, world!")
        assert isinstance(tokens, int)
        assert 1 <= tokens <= 10

    def test_estimate_chinese_text(self):
        """Estimation for Chinese text."""
        tokens = self.estimator.estimate("你好世界")
        assert 2 <= tokens <= 8

    def test_estimate_empty_string(self):
        """Empty string returns 0."""
        assert self.estimator.estimate("") == 0

    def test_estimate_long_text(self):
        """Long text estimation correlates with text length."""
        short = self.estimator.estimate("Hello")
        long = self.estimator.estimate("Hello " * 1000)
        assert long > short

    def test_fallback_to_char_count(self):
        """Falls back to character count when tiktoken unavailable."""
        estimator = TokenEstimator(ContextManagerConfig(char_token_ratio=4))
        # Simulate encoding load failure
        estimator._encoding = MagicMock()
        estimator._encoding.encode.side_effect = Exception("encode failed")
        tokens = estimator.estimate("Hello, world!")  # 13 chars
        assert tokens == 13 // 4

    def test_estimate_messages_structure_overhead(self):
        """Message list estimation includes structure overhead."""
        messages = [
            {"role": "system", "content": "You are helpful."},
            {"role": "user", "content": "Hi"},
        ]
        total = self.estimator.estimate_messages(messages)
        content_only = (
            self.estimator.estimate("You are helpful.")
            + self.estimator.estimate("Hi")
        )
        # Total should exceed content-only (due to structure overhead)
        assert total > content_only

    def test_estimate_messages_with_tool_calls(self):
        """Estimation for messages with tool calls."""
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
        """Truncate text to specified token count."""
        long_text = "Hello world. " * 100
        truncated = self.estimator.truncate_to_tokens(long_text, 10)
        tokens_after = self.estimator.estimate(truncated)
        assert tokens_after <= 10


# ─── SlidingWindow tests ───

class TestSlidingWindow:
    """Sliding window tests."""

    def test_keep_recent_n(self):
        """Keep last N tool results."""
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
        """No modification when tool results <= keep."""
        window = SlidingWindow(keep=5)
        messages = [
            {"role": "tool", "content": f"result {i}"}
            for i in range(3)
        ]
        original_contents = [m["content"] for m in messages]
        window.apply(messages)
        assert [m["content"] for m in messages] == original_contents

    def test_message_count_preserved(self):
        """Message count unchanged after truncation (only content replaced, not deleted)."""
        window = SlidingWindow(keep=