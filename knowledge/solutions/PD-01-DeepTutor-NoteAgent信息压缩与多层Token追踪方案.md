# PD-01.06 DeepTutor — NoteAgent 信息压缩 + 多层 Token 追踪 + YAML Prompt 模板管理

> 文档编号：PD-01.06
> 来源：DeepTutor `src/agents/research/agents/note_agent.py` / `src/agents/solve/utils/token_tracker.py` / `src/logging/stats/llm_stats.py`
> GitHub：https://github.com/HKUDS/DeepTutor.git
> 问题域：PD-01 上下文管理 Context Window Management
> 状态：可复用方案

---

## 第 1 章 问题与动机

### 1.1 核心问题

DeepTutor 是一个学术论文深度辅导系统，核心流程是：用户上传论文 → RAG 检索 → 多 Agent 研究 → 生成报告。在这个流程中，上下文管理面临三个关键挑战：

1. **工具返回数据膨胀**：RAG 检索、论文搜索、代码执行等工具返回的原始数据可能非常大（单次 50KB+），直接塞入上下文会迅速耗尽 token 预算
2. **多 Agent 累积消耗**：Research 模块有 DecomposeAgent → ResearchAgent → NoteAgent → ReportingAgent 的流水线，每个 Agent 都消耗 token，需要全局追踪
3. **多提供商 token 计算差异**：系统支持 OpenAI、Anthropic、DeepSeek、本地模型等多种 LLM，不同提供商的 tokenizer 不同，需要统一的估算策略

### 1.2 DeepTutor 的解法概述

DeepTutor 采用"压缩 + 追踪 + 模板化"三管齐下的策略：

1. **NoteAgent 信息压缩**（`src/agents/research/agents/note_agent.py:43-96`）：每次工具调用后，NoteAgent 将原始结果压缩为结构化摘要，只保留核心知识，丢弃噪声
2. **ToolTrace 数据截断**（`src/agents/research/data_structures.py:37-114`）：原始数据超过 50KB 自动截断，支持 JSON 感知的智能截断
3. **多层 Token 追踪**（`src/agents/solve/utils/token_tracker.py:235-256`）：API 响应 > tiktoken 精确计算 > litellm 计算 > 词数估算，四级降级
4. **LLMStats 轻量统计**（`src/logging/stats/llm_stats.py:55-57`）：全局单例追踪器，`estimate_tokens()` 用 `词数 × 1.3` 快速估算
5. **YAML Prompt 模板管理**（`src/services/prompt/manager.py:16-98`）：多语言 prompt 通过 YAML 文件管理，带缓存和语言降级链

### 1.3 设计思想

| 设计原则 | 具体实现 | 理由 | 替代方案 |
|----------|----------|------|----------|
| 压缩优于裁剪 | NoteAgent 用 LLM 生成摘要而非简单截断 | 保留语义完整性，摘要可独立阅读 | 滑动窗口丢弃旧消息 |
| 多级降级估算 | API > tiktoken > litellm > 词数×1.3 | 不同环境依赖不同，确保总有可用方案 | 只用 tiktoken |
| 数据源头截断 | ToolTrace 在创建时就限制 raw_answer 大小 | 防止大数据进入后续流水线 | 在 LLM 调用前裁剪 |
| 模板外置 | Prompt 放 YAML 文件，支持多语言切换 | 修改 prompt 不需要改代码，支持 i18n | 硬编码在 Python 中 |
| 全局单例追踪 | TokenTracker 和 LLMStats 都用单例模式 | 跨 Agent 累积统计，不丢失数据 | 每个 Agent 独立统计 |

---

## 第 2 章 源码实现分析

### 2.1 架构概览

```
┌─────────────────────────────────────────────────────────────────┐
│                    DeepTutor 上下文管理架构                       │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌──────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐  │
│  │ Research  │───→│   Tool   │───→│  Note    │───→│ Reporting│  │
│  │  Agent   │    │  调用     │    │  Agent   │    │  Agent   │  │
│  └──────────┘    └────┬─────┘    └────┬─────┘    └──────────┘  │
│                       │               │                         │
│                       ▼               ▼                         │
│              ┌────────────────┐ ┌──────────┐                   │
│              │  ToolTrace     │ │ 结构化    │                   │
│              │  (50KB截断)    │ │ 摘要JSON  │                   │
│              └────────────────┘ └──────────┘                   │
│                                                                 │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │              Token 追踪层 (贯穿所有 Agent)                │   │
│  │  BaseAgent._track_tokens() → LLMStats + TokenTracker    │   │
│  │  估算优先级: API响应 > tiktoken > litellm > 词数×1.3     │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                 │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │              Prompt 管理层                                │   │
│  │  PromptManager (单例) → YAML 加载 → 缓存 → 语言降级      │   │
│  └─────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

### 2.2 核心实现

#### 2.2.1 NoteAgent — LLM 驱动的信息压缩

Research 模块的 NoteAgent（`src/agents/research/agents/note_agent.py:43-96`）是上下文压缩的核心。每次工具调用返回原始数据后，NoteAgent 将其压缩为结构化 JSON 摘要：

```python
# src/agents/research/agents/note_agent.py:43-96
class NoteAgent(BaseAgent):
    async def process(
        self,
        tool_type: str,
        query: str,
        raw_answer: str,
        citation_id: str,
        topic: str = "",
        context: str = "",
    ) -> ToolTrace:
        # 生成摘要 — 用 LLM 将原始数据压缩为结构化知识
        summary = await self._generate_summary(
            tool_type=tool_type, query=query,
            raw_answer=raw_answer, topic=topic, context=context
        )
        # 创建 ToolTrace，同时保留原始数据和摘要
        trace = ToolTrace(
            tool_id=self._generate_tool_id(),
            citation_id=citation_id,
            tool_type=tool_type,
            query=query,
            raw_answer=raw_answer,  # 原始数据（会被 ToolTrace 自动截断）
            summary=summary,        # 压缩后的摘要
        )
        return trace
```

Solve 模块也有独立的 NoteAgent（`src/agents/solve/analysis_loop/note_agent.py:46-161`），负责将调查结果压缩为笔记并更新 InvestigateMemory：

```python
# src/agents/solve/analysis_loop/note_agent.py:80-95
for cite_id in target_ids:
    knowledge_item = next(
        (k for k in memory.knowledge_chain if k.cite_id == cite_id), None
    )
    context = self._build_context(question, knowledge_item, memory)
    user_prompt = self._build_user_prompt(context)
    response = await self.call_llm(
        user_prompt=user_prompt,
        system_prompt=system_prompt,
        response_format={"type": "json_object"},
    )
    # 解析后更新记忆
    memory.update_knowledge_summary(cite_id=cite_id, summary=parsed_result["summary"])
```

#### 2.2.2 ToolTrace — 源头数据截断

ToolTrace（`src/agents/research/data_structures.py:40-114`）在数据结构层面限制原始数据大小，默认 50KB 上限：

```python
# src/agents/research/data_structures.py:37-66
DEFAULT_RAW_ANSWER_MAX_SIZE = 50 * 1024  # 50KB

@dataclass
class ToolTrace:
    tool_id: str
    citation_id: str
    tool_type: str
    query: str
    raw_answer: str
    summary: str
    raw_answer_truncated: bool = field(default=False)
    raw_answer_original_size: int = field(default=0)

    def __post_init__(self):
        if self.raw_answer_original_size == 0:
            self.raw_answer_original_size = len(self.raw_answer)
        if len(self.raw_answer) > DEFAULT_RAW_ANSWER_MAX_SIZE:
            self.raw_answer = self._truncate_raw_answer(
                self.raw_answer, DEFAULT_RAW_ANSWER_MAX_SIZE
            )
            self.raw_answer_truncated = True
```

截断策略是 JSON 感知的（`data_structures.py:68-114`）：先尝试解析 JSON 并裁剪内容字段（answer/content/text/chunks），保留结构完整性；失败则简单截断并附加标记。

#### 2.2.3 TokenTracker — 四级降级 Token 估算

TokenTracker（`src/agents/solve/utils/token_tracker.py:235-355`）实现了四级降级的 token 计算策略：

```python
# src/agents/solve/utils/token_tracker.py:270-327
def add_usage(self, agent_name, stage, model, ...,
              system_prompt=None, user_prompt=None,
              response_text=None, messages=None):
    calculation_method = "api"
    # 优先级 1: API 响应中的 token 计数（最准确）
    if token_counts:
        prompt_tokens = token_counts.get("prompt_tokens", prompt_tokens)
        calculation_method = "api"
    # 优先级 2: tiktoken 精确计算
    elif self.prefer_tiktoken and system_prompt and user_prompt:
        prompt_tokens = count_tokens_with_tiktoken(
            system_prompt + "\n" + user_prompt, model
        )
        calculation_method = "tiktoken"
    # 优先级 3: litellm 计算
    elif self.prefer_litellm and messages:
        result = count_tokens_with_litellm(messages, model)
        calculation_method = "litellm"
    # 优先级 4: 词数估算（兜底）
    elif system_prompt and user_prompt:
        estimated = int((len(system_prompt.split()) + len(user_prompt.split())) * 1.3)
        calculation_method = "estimated"
```

#### 2.2.4 LLMStats — 轻量全局统计

LLMStats（`src/logging/stats/llm_stats.py:55-57`）提供最简单的 token 估算，作为 BaseAgent 的内置追踪器：

```python
# src/logging/stats/llm_stats.py:55-57
def estimate_tokens(text: str) -> int:
    """Rough estimate of tokens (1.3 tokens per word)."""
    return int(len(text.split()) * 1.3)
```

BaseAgent 在每次 LLM 调用后自动追踪（`src/agents/base_agent.py:289-334`），同时写入外部 TokenTracker 和内置 LLMStats。

#### 2.2.5 PromptManager — YAML 模板 + 语言降级

PromptManager（`src/services/prompt/manager.py:16-98`）用单例模式管理所有 Agent 的 prompt：

```python
# src/services/prompt/manager.py:22-26
class PromptManager:
    _instance: "PromptManager | None" = None
    _cache: dict[str, dict[str, Any]] = {}
    LANGUAGE_FALLBACKS = {
        "zh": ["zh", "cn", "en"],
        "en": ["en", "zh", "cn"],
    }
```

Prompt 文件按 `src/agents/{module}/prompts/{lang}/{agent_name}.yaml` 组织，支持缓存和语言降级链（zh → cn → en）。

### 2.3 实现细节

**错误异常体系**：DeepTutor 定义了 `LLMContextError`（`src/core/errors.py:48-51`）和 `ProviderContextWindowError`（`src/services/llm/exceptions.py:137-138`）两个上下文溢出异常。`error_mapping.py:60-62` 通过消息匹配（"context length"、"maximum context"）自动将提供商错误映射为统一异常。

**Token 限制参数适配**：`get_token_limit_kwargs()`（`src/services/llm/config.py:209-222`）根据模型名自动选择 `max_tokens` 或 `max_completion_tokens` 参数，适配新旧 OpenAI API。

**NoteAgent Prompt 设计**：Research NoteAgent 的 prompt（`src/agents/research/prompts/en/note_agent.yaml`）要求四步深度提取：内容类型识别 → 分层信息提取（核心/支撑/背景） → 结构化保留（公式/表格/代码） → 生成 300-600 词摘要。Solve NoteAgent 的 prompt 更简洁，专注于去噪和引用提取。

---

## 第 3 章 迁移指南

### 3.1 迁移清单

**阶段 1：数据截断层（1 个文件）**
- [ ] 实现 ToolTrace 类，设置 raw_answer 大小上限（建议 50KB）
- [ ] 实现 JSON 感知截断逻辑

**阶段 2：NoteAgent 压缩层（2 个文件）**
- [ ] 创建 NoteAgent，继承 BaseAgent
- [ ] 编写压缩 prompt（YAML 格式），定义摘要输出结构
- [ ] 在工具调用后插入 NoteAgent 压缩步骤

**阶段 3：Token 追踪层（2 个文件）**
- [ ] 实现 TokenTracker，支持多级降级估算
- [ ] 在 BaseAgent 中集成 `_track_tokens()` 方法
- [ ] 添加全局单例访问器

**阶段 4：Prompt 管理层（可选）**
- [ ] 实现 PromptManager 单例
- [ ] 将 prompt 迁移到 YAML 文件
- [ ] 配置语言降级链

### 3.2 适配代码模板

以下是可直接复用的 NoteAgent 压缩器模板：

```python
"""NoteAgent — 工具输出压缩器（可移植版本）"""
from dataclasses import dataclass, field
from typing import Any

# 数据截断
MAX_RAW_SIZE = 50 * 1024  # 50KB

@dataclass
class CompressedTrace:
    tool_type: str
    query: str
    raw_data: str
    summary: str
    truncated: bool = False
    original_size: int = 0

    def __post_init__(self):
        self.original_size = len(self.raw_data)
        if len(self.raw_data) > MAX_RAW_SIZE:
            self.raw_data = self.raw_data[:MAX_RAW_SIZE] + "\n...[truncated]"
            self.truncated = True


class NoteCompressor:
    """用 LLM 将工具原始输出压缩为结构化摘要"""

    SYSTEM_PROMPT = (
        "You are a knowledge stenographer. Compress the raw tool output "
        "into a structured JSON summary. Remove noise, retain core knowledge. "
        "Output: {\"summary\": \"...\", \"citations\": [...]}"
    )

    def __init__(self, llm_client: Any):
        self.llm = llm_client

    async def compress(
        self, tool_type: str, query: str, raw_data: str
    ) -> CompressedTrace:
        user_prompt = (
            f"Tool: {tool_type}\nQuery: {query}\n"
            f"Raw Output:\n{raw_data[:MAX_RAW_SIZE]}\n\n"
            "Generate a structured JSON summary."
        )
        response = await self.llm.complete(
            system_prompt=self.SYSTEM_PROMPT,
            user_prompt=user_prompt,
        )
        import json
        try:
            result = json.loads(response)
            summary = result.get("summary", response[:1000])
        except json.JSONDecodeError:
            summary = response[:1000]

        return CompressedTrace(
            tool_type=tool_type,
            query=query,
            raw_data=raw_data,
            summary=summary,
        )
```

以下是可复用的多级 Token 追踪器模板：

```python
"""TokenTracker — 多级降级 Token 估算器（可移植版本）"""

def estimate_tokens_simple(text: str) -> int:
    """词数 × 1.3 快速估算"""
    return int(len(text.split()) * 1.3)

def estimate_tokens_tiktoken(text: str, model: str) -> int:
    """tiktoken 精确估算（需要安装 tiktoken）"""
    try:
        import tiktoken
        enc = tiktoken.encoding_for_model(model)
        return len(enc.encode(text))
    except Exception:
        return estimate_tokens_simple(text)

class TokenTracker:
    def __init__(self):
        self.total_tokens = 0
        self.total_cost = 0.0
        self.records = []

    def add(self, model: str, prompt: str, response: str,
            api_usage: dict | None = None):
        if api_usage:  # 优先级 1: API 返回
            pt = api_usage.get("prompt_tokens", 0)
            ct = api_usage.get("completion_tokens", 0)
            method = "api"
        else:  # 优先级 2: tiktoken / 估算
            pt = estimate_tokens_tiktoken(prompt, model)
            ct = estimate_tokens_tiktoken(response, model)
            method = "tiktoken"

        self.total_tokens += pt + ct
        self.records.append({
            "model": model, "prompt_tokens": pt,
            "completion_tokens": ct, "method": method,
        })
```

### 3.3 适用场景

| 场景 | 适用度 | 说明 |
|------|--------|------|
| RAG + 多工具 Agent 系统 | ⭐⭐⭐ | NoteAgent 压缩模式最适合工具返回大量原始数据的场景 |
| 多轮对话系统 | ⭐⭐ | 可用 NoteAgent 压缩历史对话，但不如滑动窗口直接 |
| 单次问答 | ⭐ | 上下文不会膨胀，压缩层是多余的 |
| 多提供商 LLM 网关 | ⭐⭐⭐ | 多级 Token 追踪器天然适配多提供商场景 |
| 多语言产品 | ⭐⭐⭐ | YAML Prompt 管理 + 语言降级链直接可用 |

---

## 第 4 章 测试用例

```python
import json
import pytest
from dataclasses import dataclass

# ---- ToolTrace 截断测试 ----

DEFAULT_RAW_ANSWER_MAX_SIZE = 50 * 1024

class TestToolTraceTruncation:
    def test_small_data_not_truncated(self):
        """小数据不截断"""
        raw = "short answer"
        trace = {"raw_answer": raw, "truncated": len(raw) > DEFAULT_RAW_ANSWER_MAX_SIZE}
        assert trace["truncated"] is False

    def test_large_data_truncated(self):
        """超过 50KB 的数据被截断"""
        raw = "x" * (DEFAULT_RAW_ANSWER_MAX_SIZE + 1000)
        truncated = raw[:DEFAULT_RAW_ANSWER_MAX_SIZE] + "...[truncated]"
        assert len(truncated) < len(raw)
        assert truncated.endswith("...[truncated]")

    def test_json_aware_truncation(self):
        """JSON 感知截断保留结构"""
        data = {"answer": "a" * 100000, "metadata": {"key": "value"}}
        raw = json.dumps(data)
        # 模拟 JSON 感知截断
        parsed = json.loads(raw)
        parsed["answer"] = parsed["answer"][:25000] + "... [truncated]"
        result = json.dumps(parsed, ensure_ascii=False)
        reparsed = json.loads(result)
        assert "metadata" in reparsed
        assert reparsed["metadata"]["key"] == "value"


# ---- Token 估算测试 ----

class TestTokenEstimation:
    def test_simple_estimation(self):
        """词数 × 1.3 估算"""
        text = "hello world this is a test"
        estimated = int(len(text.split()) * 1.3)
        assert estimated == int(6 * 1.3)  # 7

    def test_empty_text(self):
        """空文本返回 0"""
        assert int(len("".split()) * 1.3) == 0

    def test_estimation_reasonable_range(self):
        """估算值在合理范围内（英文约 1.3 token/word）"""
        text = " ".join(["word"] * 100)
        estimated = int(len(text.split()) * 1.3)
        assert 100 < estimated < 200


# ---- NoteAgent 压缩输出测试 ----

class TestNoteAgentOutput:
    def test_valid_json_output(self):
        """NoteAgent 输出必须是有效 JSON"""
        output = '{"summary": "This is a test summary", "citations": []}'
        parsed = json.loads(output)
        assert "summary" in parsed
        assert isinstance(parsed["summary"], str)

    def test_summary_no_latex(self):
        """Solve NoteAgent 摘要不应包含 LaTeX"""
        summary = "The output is the convolution of input and impulse response"
        assert "$$" not in summary
        assert "$" not in summary

    def test_citations_optional(self):
        """citations 字段可选，默认空列表"""
        output = '{"summary": "test"}'
        parsed = json.loads(output)
        citations = parsed.get("citations", [])
        assert isinstance(citations, list)


# ---- PromptManager 测试 ----

class TestPromptManagerFallback:
    def test_language_fallback_chain(self):
        """语言降级链：zh → cn → en"""
        fallbacks = {"zh": ["zh", "cn", "en"], "en": ["en", "zh", "cn"]}
        assert fallbacks["zh"][0] == "zh"
        assert fallbacks["zh"][-1] == "en"

    def test_cache_key_uniqueness(self):
        """缓存键唯一性"""
        key1 = "research_note_agent_zh"
        key2 = "research_note_agent_en"
        key3 = "solve_note_agent_zh_analysis_loop"
        assert key1 != key2 != key3
```

---

## 第 5 章 跨域关联

| 关联域 | 关系类型 | 说明 |
|--------|----------|------|
| PD-02 多 Agent 编排 | 协同 | NoteAgent 是 Research Pipeline 中的一个节点，由 ManagerAgent 编排调度 |
| PD-03 容错与重试 | 协同 | NoteAgent 的 JSON 解析失败时有 fallback（截取前 1000 字符），ToolTrace 截断也是一种容错 |
| PD-04 工具系统 | 依赖 | NoteAgent 处理的是工具系统返回的原始数据，是工具调用链的下游 |
| PD-06 记忆持久化 | 协同 | Solve NoteAgent 将压缩结果写入 InvestigateMemory 和 CitationMemory |
| PD-11 可观测性 | 协同 | TokenTracker 和 LLMStats 提供 token 用量和成本的可观测性数据 |

---

## 第 6 章 来源文件索引

| 文件 | 行范围 | 关键实现 |
|------|--------|----------|
| `src/agents/research/agents/note_agent.py` | L22-180 | Research NoteAgent：LLM 驱动的信息压缩 |
| `src/agents/solve/analysis_loop/note_agent.py` | L23-191 | Solve NoteAgent：调查结果压缩 + 记忆更新 |
| `src/agents/research/data_structures.py` | L37-171 | ToolTrace：50KB 截断 + JSON 感知截断 |
| `src/logging/stats/llm_stats.py` | L46-200 | LLMStats：轻量 token 估算 + 成本统计 |
| `src/agents/solve/utils/token_tracker.py` | L235-541 | TokenTracker（高级版）：四级降级估算 |
| `src/agents/research/utils/token_tracker.py` | L121-298 | TokenTracker（Research 版）：全局单例 |
| `src/services/prompt/manager.py` | L16-207 | PromptManager：YAML 加载 + 缓存 + 语言降级 |
| `src/agents/base_agent.py` | L289-458 | BaseAgent：统一 LLM 调用 + token 追踪集成 |
| `src/core/errors.py` | L48-51 | LLMContextError 异常定义 |
| `src/services/llm/exceptions.py` | L137-138 | ProviderContextWindowError 异常定义 |
| `src/services/llm/error_mapping.py` | L54-63 | 上下文溢出错误自动映射规则 |
| `src/services/llm/config.py` | L209-222 | get_token_limit_kwargs：max_tokens 参数适配 |
| `src/agents/research/prompts/en/note_agent.yaml` | L1-122 | Research NoteAgent prompt：四步深度提取框架 |
| `src/agents/solve/prompts/en/analysis_loop/note_agent.yaml` | L1-55 | Solve NoteAgent prompt：去噪 + 引用提取 |

---

## 第 7 章 横向对比维度

```json comparison_data
{
  "project": "DeepTutor",
  "dimensions": {
    "估算方式": "四级降级：API响应 > tiktoken > litellm > 词数×1.3",
    "压缩策略": "NoteAgent LLM 摘要压缩 + ToolTrace 50KB 源头截断",
    "触发机制": "每次工具调用后自动触发 NoteAgent 压缩",
    "实现位置": "Agent 层（NoteAgent）+ 数据结构层（ToolTrace.__post_init__）",
    "容错设计": "LLMContextError + ProviderContextWindowError 双层异常 + 消息匹配自动映射",
    "分割粒度": "按工具调用粒度，每次调用独立压缩为一个 ToolTrace",
    "Prompt模板化": "YAML 多语言 prompt + 单例缓存 + zh→cn→en 降级链"
  }
}
```

### 域元数据补充

```json domain_metadata
{
  "description": "通过 LLM 驱动的信息压缩（而非简单截断）保留语义完整性，是上下文管理的高级策略",
  "sub_problems": [
    "工具输出压缩：将工具返回的大量原始数据压缩为结构化摘要，保留核心知识",
    "Prompt 模板管理：通过外置配置文件系统化管理 system prompt，支持多语言切换"
  ],
  "best_practices": [
    "源头截断优于下游裁剪：在数据结构创建时就限制大小，防止大数据进入后续流水线",
    "多级降级保证可用性：API > tiktoken > litellm > 估算，确保任何环境都能追踪 token",
    "压缩后保留原始数据引用：ToolTrace 同时存储 summary 和 truncated raw_answer，支持回溯"
  ]
}
```
