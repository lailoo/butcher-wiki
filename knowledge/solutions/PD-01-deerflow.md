---
id: "PD-01-deerflow"
domain: "PD-01"
project: "deerflow"
title: "SummarizationMiddleware 三触发压缩"

design_philosophy:
  - "中间件模式：上下文压缩作为可插拔中间件，不侵入业务逻辑"
  - "多触发条件：token 数、消息数、压缩比例三重触发"
  - "LLM 驱动摘要：用小模型生成摘要，而非规则裁剪"

source_files:
  - file: "src/middleware/summarization.py"
    lines: "~1-120"
    description: "SummarizationMiddleware — 三触发条件 + LLM 摘要"
  - file: "src/middleware/dangling_tool_call.py"
    lines: "~1-60"
    description: "DanglingToolCallMiddleware — 修复压缩后的悬挂工具调用"
---

## 机制详解

### 1. 三触发条件

```python
class SummarizationMiddleware:
    def __init__(self, config):
        self.max_tokens = config.get("max_tokens", 100000)
        self.max_messages = config.get("max_messages", 50)
        self.compression_ratio = config.get("compression_ratio", 0.6)

    def should_compress(self, messages, token_count):
        return (
            token_count > self.max_tokens or          # 条件1: token 超限
            len(messages) > self.max_messages or       # 条件2: 消息数过多
            token_count > self.max_tokens * self.compression_ratio  # 条件3: 接近阈值
        )
```

### 2. LLM 驱动摘要

不同于 MiroThinker 的规则裁剪，DeerFlow 用 LLM 生成摘要：

```python
async def compress(self, messages):
    # 保留 system prompt 和最近 N 条消息
    preserved = messages[:1] + messages[-self.keep_recent:]
    to_summarize = messages[1:-self.keep_recent]

    summary = await self.llm.summarize(
        messages=to_summarize,
        instruction="Summarize the key decisions, findings, and context..."
    )

    return preserved[:1] + [{"role": "system", "content": summary}] + preserved[1:]
```

### 3. 悬挂工具调用修复

压缩消息后可能出现"工具调用消息在，但对应的工具结果消息被裁掉了"的问题：

```python
class DanglingToolCallMiddleware:
    """修复压缩后的悬挂工具调用"""
    def process(self, messages):
        tool_call_ids = {m["tool_call_id"] for m in messages if m.get("role") == "assistant" and m.get("tool_calls")}
        tool_result_ids = {m["tool_call_id"] for m in messages if m.get("role") == "tool"}

        dangling = tool_call_ids - tool_result_ids
        # 为悬挂的工具调用补充占位结果
        for call_id in dangling:
            messages.append({"role": "tool", "tool_call_id": call_id, "content": "[Result omitted]"})
```

## 优势

- 中间件模式：可插拔，不影响业务代码
- LLM 摘要比规则裁剪保留更多语义信息
- 悬挂工具调用修复避免了 API 格式错误

## 劣势

- LLM 摘要本身消耗 token 和时间
- 摘要可能丢失关键细节（LLM 幻觉风险）
- 三触发条件的阈值需要调优

## 适用场景

- 中间件架构的 Agent 框架
- 对话轮次多、需要保留语义的场景
- 有预算用小模型做摘要的项目
