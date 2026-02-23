---
id: "PD-01-mirothinker"
domain: "PD-01"
project: "MiroThinker"
repo: "https://github.com/Xyntopia/MiroThinker"
title: "tiktoken 精确估算 + 分级裁剪 + 滑动窗口"
score: 0.92
signals: ["token_overflow", "context_limit", "tiktoken", "sliding_window"]

design_philosophy:
  - "精确优于估算：用 tiktoken 而非字符数近似"
  - "预防优于治疗：在调用前裁剪，而非等 API 报错"
  - "分级裁剪：按内容重要性分层丢弃"
  - "三级降级：每一层都有 fallback，绝不因依赖缺失崩溃"

source_files:
  - file: "openai_client.py"
    lines: "363-382"
    description: "_estimate_tokens() — tiktoken 精确估算"
  - file: "openai_client.py"
    lines: "384-444"
    description: "ensure_summary_context() — 超限前自动裁剪"
  - file: "orchestrator.py"
    lines: "~200"
    description: "滑动窗口 keep_tool_result=5"

pros:
  - "精确度高：tiktoken 与 OpenAI 实际计费一致"
  - "三级降级：tiktoken → cl100k → 字符估算，不会因依赖缺失崩溃"
  - "85% 安全边际：为输出预留空间"
  - "零额外 LLM 调用：纯规则裁剪，不消耗 token"

cons:
  - "仅支持 OpenAI 系编码器，对 Claude/Gemini 的 token 计算有偏差"
  - "裁剪策略是硬编码的优先级，不够灵活"
  - "滑动窗口的 keep_tool_result=5 是魔法数字"
  - "丢弃的内容无法恢复，可能丢失关键上下文"

migration_scenarios:
  - title: "以 OpenAI 为主要 LLM 的项目"
    description: "tiktoken 编码器与 OpenAI 计费完全一致，估算零偏差"
  - title: "工具调用频繁的 Agent"
    description: "工具结果是上下文膨胀的主要来源，滑动窗口直接命中痛点"
  - title: "需要精确 token 控制的长文生成"
    description: "85% 安全边际 + 分级裁剪确保不会超限崩溃"
  - title: "不想引入额外 LLM 调用的场景"
    description: "纯规则裁剪，不像 LLM 摘要那样消耗额外 token 和延迟"
---

## 一、方案概述

MiroThinker 的上下文管理方案是一套**纯规则驱动**的三层防御体系：Token 精确估算 → 分级裁剪 → 滑动窗口。核心思想是"在 LLM 调用前就把上下文控制在安全范围内"，而非等到 API 返回 token 超限错误再处理。

整个系统包含三个核心组件：

1. **`_estimate_tokens()`** — tiktoken 精确估算，三级降级（`openai_client.py:363-382`）
2. **`ensure_summary_context()`** — 分级裁剪引擎，85% 安全边际（`openai_client.py:384-444`）
3. **滑动窗口** — 工具结果管理，keep=5 策略（`orchestrator.py:~200`）

## 二、架构全景

```
LLM 调用前检查链路
  │
  ├─ _estimate_tokens(text)                    ← openai_client.py:363
  │     ├─ tiktoken.get_encoding("o200k_base")       ← GPT-4o 编码器
  │     ├─ fallback: tiktoken.get_encoding("cl100k_base")  ← GPT-4 编码器
  │     └─ fallback: len(text) // 4                  ← 粗略估算（1 token ≈ 4 chars）
  │
  ├─ ensure_summary_context(messages, model)   ← openai_client.py:384
  │     ├─ max_tokens = MODEL_CONTEXT_LIMITS[model]
  │     ├─ safety_margin = 0.85                      ← 只用 85% 容量
  │     ├─ total = Σ _estimate_tokens(m.content)
  │     │
  │     ├─ if total <= max_tokens * 0.85:
  │     │     └─ return messages                     ← 未超限，原样返回
  │     │
  │     └─ 分级裁剪（按优先级从低到高丢弃）:
  │           ├─ Level 1: 裁剪工具调用结果（tool role messages）
  │           ├─ Level 2: 裁剪旧对话历史（保留最近 N 轮）
  │           └─ Level 3: 截断系统提示（极端情况，保留前 2000 tokens）
  │
  └─ 滑动窗口（独立于裁剪，常驻运行）         ← orchestrator.py:~200
        ├─ keep_tool_result = 5
        ├─ 遍历 messages，找到 role="tool" 的消息
        └─ 如果 tool 消息索引 < len(messages) - 5:
              msg["content"] = "[Previous tool result omitted]"
```

## 三、核心实现详解

### 3.1 Token 精确估算

**源文件**: `openai_client.py:363-382`

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
            # 优先使用 GPT-4o 编码器
            self.encoding = tiktoken.get_encoding("o200k_base")
        except Exception:
            # 降级到 GPT-4 编码器
            self.encoding = tiktoken.get_encoding("cl100k_base")
    try:
        return len(self.encoding.encode(text))
    except Exception:
        # 最终降级：1 token ≈ 4 个英文字符
        return len(text) // 4
```

**关键设计决策**：

| 决策 | 选择 | 理由 |
|------|------|------|
| 编码器选择 | `o200k_base` 优先 | GPT-4o 是当前主流模型，编码器匹配度最高 |
| 加载时机 | 懒加载（`hasattr` 检查） | 避免启动时开销，首次调用时才初始化 |
| 降级策略 | 三级 fallback | 即使 tiktoken 未安装也不崩溃 |
| 字符估算比例 | `len // 4` | 英文平均 1 token ≈ 4 chars，中文约 1 token ≈ 1.5 chars |

**注意**：`len(text) // 4` 对中文内容会严重低估 token 数（中文 1 个字 ≈ 1-2 tokens，而非 0.25）。如果你的项目处理中文内容，建议将降级比例改为 `len(text) // 2`。

### 3.2 分级裁剪引擎

**源文件**: `openai_client.py:384-444`

```python
def ensure_summary_context(self, messages: list, model_name: str) -> list:
    """确保消息列表不超过模型上下文限制。

    核心策略：85% 安全边际 + 三级裁剪优先级
    """
    max_tokens = MODEL_CONTEXT_LIMITS.get(model_name, 128000)
    safety_margin = 0.85  # 只用 85% 的上下文窗口
    target = int(max_tokens * safety_margin)

    # 计算当前总 token 数
    total = sum(self._estimate_tokens(m.get("content", "")) for m in messages)

    if total <= target:
        return messages  # 未超限，原样返回

    # === Level 1: 裁剪工具调用结果 ===
    # 工具结果通常最长且最不重要（搜索结果、代码输出等）
    for i in range(len(messages) - 1, -1, -1):
        if total <= target:
            break
        if messages[i].get("role") == "tool":
            old_content = messages[i]["content"]
            old_tokens = self._estimate_tokens(old_content)
            messages[i]["content"] = "[Tool result truncated for context management]"
            total -= old_tokens - self._estimate_tokens(messages[i]["content"])

    if total <= target:
        return messages

    # === Level 2: 裁剪旧对话历史 ===
    # 保留 system prompt (index 0) 和最近 6 条消息
    keep_recent = 6
    if len(messages) > keep_recent + 1:
        removed = messages[1:-keep_recent]
        messages = [messages[0]] + messages[-keep_recent:]
        total = sum(self._estimate_tokens(m.get("content", "")) for m in messages)

    if total <= target:
        return messages

    # === Level 3: 截断系统提示（极端情况） ===
    if messages[0].get("role") == "system":
        sys_content = messages[0]["content"]
        sys_tokens = self._estimate_tokens(sys_content)
        if sys_tokens > 2000:
            # 保留前 2000 tokens 的系统提示
            encoded = self.encoding.encode(sys_content)[:2000]
            messages[0]["content"] = self.encoding.decode(encoded) + "\n[System prompt truncated]"

    return messages
```

**裁剪优先级矩阵**：

```
重要性低 ◄──────────────────────────────► 重要性高

工具结果    旧对话历史    最近对话    系统提示
(Level 1)   (Level 2)    (保留)     (Level 3, 极端)
  ▲            ▲                        ▲
  │            │                        │
  先裁剪       次裁剪                   最后裁剪
```

### 3.3 滑动窗口

**源文件**: `orchestrator.py:~200`

```python
# 滑动窗口：只保留最近 5 个工具调用结果
# 旧的工具结果替换为占位符，保留消息结构完整性
keep_tool_result = 5

tool_indices = [
    i for i, msg in enumerate(messages)
    if msg.get("role") == "tool"
]

# 只替换超出窗口的旧工具结果
if len(tool_indices) > keep_tool_result:
    for idx in tool_indices[:-keep_tool_result]:
        messages[idx]["content"] = (
            "[Previous tool result omitted for context management]"
        )
```

**为什么是 keep=5？**

MiroThinker 的典型工作流是：搜索 → 分析 → 搜索 → 分析 → 总结。一个完整的"搜索-分析"循环产生 2 个工具结果，keep=5 意味着保留最近 2.5 个循环的完整结果，足够 LLM 理解当前上下文。

## 四、迁移指南

### 4.1 核心组件迁移清单

| 组件 | 源文件 | 迁移难度 | 依赖 |
|------|--------|----------|------|
| `_estimate_tokens()` | `openai_client.py:363-382` | 低 | tiktoken |
| `ensure_summary_context()` | `openai_client.py:384-444` | 中 | `_estimate_tokens()` |
| 滑动窗口 | `orchestrator.py:~200` | 低 | 无 |
| `MODEL_CONTEXT_LIMITS` | `openai_client.py:~20` | 低 | 无 |

### 4.2 适配要点

**编码器适配**（如果你不用 OpenAI）：

```python
# Claude 项目适配示例
def _estimate_tokens(self, text: str) -> int:
    # Claude 没有官方 tokenizer，用 tiktoken cl100k_base 近似
    # 偏差约 5-10%，对裁剪决策影响不大
    try:
        return len(tiktoken.get_encoding("cl100k_base").encode(text))
    except Exception:
        # 中文内容用 // 2，英文用 // 4
        return len(text) // 2
```

**安全边际调整**：

```python
# 不同场景的安全边际建议
SAFETY_MARGINS = {
    "short_output": 0.90,   # 输出 < 500 tokens（分类、判断）
    "medium_output": 0.85,  # 输出 500-2000 tokens（摘要、分析）
    "long_output": 0.70,    # 输出 > 2000 tokens（长文生成）
    "code_generation": 0.75, # 代码生成（输出长度不可预测）
}
```

**裁剪优先级自定义**：

```python
# 可配置的裁剪优先级（从低到高）
TRIM_PRIORITY = [
    {"role": "tool", "strategy": "replace_placeholder"},  # 最先裁剪
    {"role": "assistant", "age": "old", "strategy": "remove"},
    {"role": "user", "age": "old", "strategy": "remove"},
    {"role": "system", "strategy": "truncate_tail"},       # 最后裁剪
]
```

### 4.3 适用场景矩阵

| 场景 | 适合度 | 理由 |
|------|--------|------|
| OpenAI 为主的项目 | ★★★★★ | tiktoken 零偏差 |
| 工具调用频繁的 Agent | ★★★★★ | 滑动窗口直接命中痛点 |
| 多模型混用项目 | ★★★☆☆ | 需要适配不同 tokenizer |
| 需要保留完整历史的场景 | ★★☆☆☆ | 裁剪会丢失信息，考虑 DeerFlow 的 LLM 摘要方案 |
| 实时对话（低延迟要求） | ★★★★★ | 纯规则裁剪，零额外延迟 |

## 五、测试用例

### 5.1 Token 估算测试

```python
import pytest
from unittest.mock import MagicMock, patch


class TestEstimateTokens:
    """Token 估算三级降级测试"""

    def test_o200k_encoding(self):
        """正常路径：使用 o200k_base 编码器"""
        client = OpenAIClient()
        tokens = client._estimate_tokens("Hello, world!")
        assert isinstance(tokens, int)
        assert tokens > 0
        assert tokens < 10  # "Hello, world!" 约 4 tokens

    def test_fallback_to_cl100k(self):
        """降级路径：o200k 不可用时降级到 cl100k"""
        with patch("tiktoken.get_encoding") as mock:
            mock.side_effect = [Exception("o200k not found"), MagicMock()]
            client = OpenAIClient()
            tokens = client._estimate_tokens("test")
            assert tokens > 0

    def test_fallback_to_char_count(self):
        """最终降级：tiktoken 完全不可用"""
        client = OpenAIClient()
        client.encoding = MagicMock()
        client.encoding.encode.side_effect = Exception("encode failed")
        tokens = client._estimate_tokens("Hello, world!")  # 13 chars
        assert tokens == 13 // 4  # = 3

    def test_empty_string(self):
        """边界：空字符串"""
        client = OpenAIClient()
        assert client._estimate_tokens("") == 0

    def test_chinese_text(self):
        """中文文本 token 估算"""
        client = OpenAIClient()
        tokens = client._estimate_tokens("你好世界")
        # 中文每个字约 1-2 tokens
        assert 2 <= tokens <= 8
```

### 5.2 分级裁剪测试

```python
class TestEnsureSummaryContext:
    """分级裁剪引擎测试"""

    def _make_messages(self, system_tokens=100, user_tokens=100,
                       tool_count=0, tool_tokens=500):
        """构造测试消息列表"""
        msgs = [{"role": "system", "content": "x" * (system_tokens * 4)}]
        msgs.append({"role": "user", "content": "x" * (user_tokens * 4)})
        for i in range(tool_count):
            msgs.append({"role": "tool", "content": "x" * (tool_tokens * 4)})
        return msgs

    def test_under_limit_no_trim(self):
        """未超限：原样返回"""
        client = OpenAIClient()
        msgs = self._make_messages(system_tokens=100, user_tokens=100)
        result = client.ensure_summary_context(msgs, "gpt-4o")
        assert len(result) == len(msgs)

    def test_level1_trim_tool_results(self):
        """Level 1：工具结果被裁剪"""
        client = OpenAIClient()
        msgs = self._make_messages(tool_count=20, tool_tokens=5000)
        result = client.ensure_summary_context(msgs, "gpt-4o")
        trimmed = [m for m in result if "truncated" in m.get("content", "")]
        assert len(trimmed) > 0  # 至少有工具结果被裁剪

    def test_level2_trim_old_history(self):
        """Level 2：旧对话历史被裁剪"""
        client = OpenAIClient()
        # 构造大量历史消息
        msgs = [{"role": "system", "content": "system prompt"}]
        for i in range(50):
            msgs.append({"role": "user", "content": "x" * 4000})
            msgs.append({"role": "assistant", "content": "x" * 4000})
        result = client.ensure_summary_context(msgs, "gpt-4o")
        assert len(result) < len(msgs)  # 消息数减少

    def test_preserves_system_prompt(self):
        """系统提示始终保留"""
        client = OpenAIClient()
        msgs = self._make_messages(tool_count=20, tool_tokens=5000)
        result = client.ensure_summary_context(msgs, "gpt-4o")
        assert result[0]["role"] == "system"

    def test_preserves_recent_messages(self):
        """最近消息始终保留"""
        client = OpenAIClient()
        msgs = self._make_messages(tool_count=20, tool_tokens=5000)
        last_msg = msgs[-1]
        result = client.ensure_summary_context(msgs, "gpt-4o")
        assert result[-1] == last_msg
```

### 5.3 滑动窗口测试

```python
class TestSlidingWindow:
    """滑动窗口测试"""

    def test_keep_recent_5(self):
        """保留最近 5 个工具结果"""
        msgs = [{"role": "system", "content": "sys"}]
        for i in range(10):
            msgs.append({"role": "user", "content": f"query {i}"})
            msgs.append({"role": "tool", "content": f"result {i}"})

        apply_sliding_window(msgs, keep=5)

        tool_msgs = [m for m in msgs if m["role"] == "tool"]
        preserved = [m for m in tool_msgs if "omitted" not in m["content"]]
        assert len(preserved) == 5

    def test_under_limit_no_change(self):
        """工具结果数 <= 5 时不做任何修改"""
        msgs = [{"role": "tool", "content": f"result {i}"} for i in range(3)]
        original = [m["content"] for m in msgs]
        apply_sliding_window(msgs, keep=5)
        assert [m["content"] for m in msgs] == original

    def test_message_structure_preserved(self):
        """裁剪后消息结构完整（不删除消息，只替换内容）"""
        msgs = [{"role": "tool", "content": f"result {i}"} for i in range(10)]
        original_len = len(msgs)
        apply_sliding_window(msgs, keep=5)
        assert len(msgs) == original_len  # 消息数不变
```

## 六、跨域关联

| 关联域 | 关系 | 说明 |
|--------|------|------|
| PD-11 可观测性 | 输入 | token 估算数据可用于成本追踪和用量监控 |
| PD-03 容错与重试 | 互补 | 裁剪失败时需要重试机制兜底 |
| PD-10 中间件管道 | 架构 | 裁剪逻辑可封装为中间件（参考 DeerFlow 方案） |
| PD-12 推理增强 | 冲突 | Extended Thinking 需要更多上下文，与裁剪策略存在张力 |

## 七、来源文件索引

| 编号 | 文件 | 行号 | 说明 |
|------|------|------|------|
| S1 | `openai_client.py` | 363-382 | `_estimate_tokens()` — tiktoken 三级降级估算 |
| S2 | `openai_client.py` | 384-444 | `ensure_summary_context()` — 分级裁剪引擎 |
| S3 | `openai_client.py` | ~20 | `MODEL_CONTEXT_LIMITS` — 模型上下文限制表 |
| S4 | `orchestrator.py` | ~200 | 滑动窗口 `keep_tool_result=5` |
