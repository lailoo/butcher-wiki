# PD-07.04 DeepTutor — 多层输出验证与引用完整性方案

> 文档编号：PD-07.04
> 来源：DeepTutor `src/agents/solve/utils/error_handler.py`, `src/agents/research/utils/citation_manager.py`
> GitHub：https://github.com/HKUDS/DeepTutor.git
> 问题域：PD-07 质量检查 Quality Assurance
> 状态：可复用方案

---

## 第 1 章 问题与动机（≥ 30 行）

### 1.1 核心问题

LLM Agent 系统中，输出质量保障面临三个层次的挑战：

1. **结构正确性**：LLM 返回的 JSON 是否符合预期 schema？字段是否齐全、类型是否正确？
2. **语义准确性**：生成的回答是否与知识库内容一致？引用是否真实存在？
3. **流程完整性**：多步骤求解链中，每一步的输出是否被正确验证后才进入下一步？

DeepTutor 作为一个学术辅导系统（PDF 上传 → 知识库构建 → 问答/出题/研究），对输出质量有极高要求——错误的引用会误导学生，格式错误会导致流程中断。

### 1.2 DeepTutor 的解法概述

DeepTutor 采用**四层质量保障体系**，从底层到顶层逐级把关：

1. **Pydantic 模型验证层**（`error_handler.py:26-135`）：为每种 Agent 输出定义严格的 Pydantic BaseModel，LLM 返回后立即校验结构和字段约束
2. **引用完整性验证层**（`citation_manager.py:176-233`）：Research 模块的 CitationManager 提供 `validate_citation_references()` 和 `fix_invalid_citations()` 方法，确保文本中引用的 ID 都真实存在
3. **相关性分析层**（`relevance_analyzer.py:51-118`）：Question 模块的 RelevanceAnalyzer 对生成内容进行 high/partial 分类，不拒绝但标注质量等级
4. **精确回答决策层**（`precision_answer_agent.py:41-59`）：PrecisionAnswerAgent 两阶段判断——先决策是否需要精确回答，再生成精确版本

### 1.3 设计思想

| 设计原则 | 具体实现 | 理由 | 替代方案 |
|----------|----------|------|----------|
| 类型安全优先 | Pydantic BaseModel + field_validator | 编译期捕获结构错误，比运行时 dict 检查更可靠 | JSON Schema 验证、手动 isinstance 检查 |
| 引用可追溯 | 全局 citation_id 编号 + JSON 持久化 | 确保每条引用可溯源到原始工具调用 | 内存 dict 不持久化 |
| 分类不拒绝 | RelevanceAnalyzer 输出 high/partial 而非 pass/fail | 所有内容都有价值，标注比丢弃更合理 | 迭代验证循环直到通过 |
| 渐进式精确 | 先判断是否需要精确回答，再生成 | 避免对所有问题都做精确化的资源浪费 | 统一精确化处理 |
| 解析容错 | 多策略 JSON 解析（直接 → 正则提取 → markdown 提取） | LLM 输出格式不稳定，需要多重兜底 | 单一 json.loads 失败即报错 |

---

## 第 2 章 源码实现分析（≥ 60 行，核心章节）

### 2.1 架构概览

```
┌─────────────────────────────────────────────────────────────┐
│                    DeepTutor 质量保障架构                      │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  Layer 4: 精确回答决策                                        │
│  ┌─────────────────────────────────────────────┐            │
│  │ PrecisionAnswerAgent                        │            │
│  │  _should_generate() → _generate_precision() │            │
│  └─────────────────────────────────────────────┘            │
│                         ↑                                   │
│  Layer 3: 语义相关性分析                                      │
│  ┌─────────────────────────────────────────────┐            │
│  │ RelevanceAnalyzer                           │            │
│  │  process() → _parse_analysis_response()     │            │
│  │  输出: {relevance: high|partial}            │            │
│  └─────────────────────────────────────────────┘            │
│                         ↑                                   │
│  Layer 2: 引用完整性验证                                      │
│  ┌─────────────────────────────────────────────┐            │
│  │ CitationManager (Research)                  │            │
│  │  validate_citation_references()             │            │
│  │  fix_invalid_citations()                    │            │
│  │ CitationManager (Solve, Singleton)          │            │
│  │  allocate_citation_id() → get_citation_info │            │
│  └─────────────────────────────────────────────┘            │
│                         ↑                                   │
│  Layer 1: 结构化输出验证 (Pydantic)                           │
│  ┌─────────────────────────────────────────────┐            │
│  │ error_handler.py                            │            │
│  │  InvestigateOutput / NoteOutput /           │            │
│  │  ReflectOutput / PlanOutput / SolveOutput   │            │
│  │  + retry_on_parse_error 装饰器              │            │
│  └─────────────────────────────────────────────┘            │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### 2.2 核心实现

#### 2.2.1 Pydantic 结构化验证（Layer 1）

DeepTutor 为每种 Agent 输出定义了独立的 Pydantic 模型。以 `InvestigateOutput` 为例（`src/agents/solve/utils/error_handler.py:26-63`）：

```python
class ToolIntent(BaseModel):
    """Model for tool intent in investigate output"""
    tool_type: str = Field(..., description="Type of tool to use")
    query: str = Field("", description="Query for the tool")
    identifier: Optional[str] = Field(None, description="Optional identifier")

    @field_validator("tool_type")
    @classmethod
    def validate_tool_type(cls, v):
        if v.lower() not in VALID_INVESTIGATE_TOOLS:
            raise ValueError(f"tool_type must be one of {VALID_INVESTIGATE_TOOLS}, got: {v}")
        return v.lower()

    @field_validator("query")
    @classmethod
    def validate_query_required(cls, v, info):
        tool_type = info.data.get("tool_type", "").lower()
        if tool_type != "none" and not v:
            raise ValueError("query is required for non-none tools")
        return v

class InvestigateOutput(BaseModel):
    reasoning: str = Field(..., description="Reasoning for the investigation")
    tools: list[ToolIntent] = Field(..., min_length=1, description="List of tool intents")

    @field_validator("tools")
    @classmethod
    def validate_tools_consistency(cls, v):
        has_none = any(tool.tool_type == "none" for tool in v)
        if has_none and len(v) > 1:
            raise ValueError("When 'none' tool exists, no other tool intents should be provided")
        return v
```

关键设计点：
- `field_validator` 在字段级别做约束（tool_type 白名单、query 非空）
- `validate_tools_consistency` 做跨字段语义约束（none 工具互斥）
- 验证失败抛出 `ValidationError`，被上层统一转换为 `LLMParseError`（`error_handler.py:268-273`）

验证函数统一入口（`error_handler.py:238-273`）：

```python
def validate_investigate_output(output: dict[str, Any], valid_tools: list[str] = VALID_INVESTIGATE_TOOLS) -> bool:
    if valid_tools != VALID_INVESTIGATE_TOOLS:
        # 自定义工具列表时走手动验证
        validate_output(output, ["reasoning"], {"reasoning": str})
        # ... 手动逐字段检查
        return True
    # 标准工具列表走 Pydantic
    try:
        InvestigateOutput(**output)
        return True
    except ValidationError as e:
        error_details = _format_validation_errors(e)
        raise LLMParseError(f"InvestigateAgent output validation failed: {error_details}") from e
```

同样的模式覆盖了 5 种 Agent 输出：`NoteOutput`、`ReflectOutput`、`PlanOutput`、`SolveOutput`，每种都有对应的 `validate_xxx_output()` 函数。

#### 2.2.2 重试机制（Layer 1 补充）

解析失败时通过 tenacity 装饰器自动重试（`error_handler.py:141-171`）：

```python
def retry_on_parse_error(max_retries: int = 2, delay: float = 1.0, backoff: float = 2.0,
                         exceptions: tuple[type[Exception], ...] = (LLMParseError,)):
    def decorator(func: Callable):
        return tenacity.retry(
            retry=tenacity.retry_if_exception_type(*exceptions),
            wait=tenacity.wait_exponential(multiplier=backoff, min=delay, max=60),
            stop=tenacity.stop_after_attempt(max_retries + 1),
            before_sleep=lambda retry_state: logger.warning(
                f"Parse failed (attempt {retry_state.attempt_number}/{max_retries + 1}), "
                f"retrying in {retry_state.upcoming_sleep:.1f}s..."
            ),
        )(func)
    return decorator
```

#### 2.2.3 引用完整性验证（Layer 2）

DeepTutor 有两套 CitationManager，分别服务于 Research 和 Solve 模块：

**Research CitationManager**（`src/agents/research/utils/citation_manager.py:19-799`）：
- 全局 ID 管理：`PLAN-XX`（规划阶段）和 `CIT-X-XX`（研究阶段）两种编号格式
- asyncio.Lock 保证并行模式下 ID 不冲突（`citation_manager.py:47`）
- 引用验证核心方法（`citation_manager.py:176-211`）：

```python
def validate_citation_references(self, text: str) -> dict[str, Any]:
    pattern = r"\[\[([A-Z]+-\d+-?\d*)\]\]"
    found_refs = re.findall(pattern, text)
    valid, invalid = [], []
    for ref in found_refs:
        if self.citation_exists(ref):
            valid.append(ref)
        else:
            invalid.append(ref)
    return {
        "valid_citations": valid,
        "invalid_citations": invalid,
        "is_valid": len(invalid) == 0,
        "total_found": len(found_refs),
    }
```

- 自动修复无效引用（`citation_manager.py:213-233`）：`fix_invalid_citations()` 用正则匹配并移除不存在的引用 ID
- 引用去重与编号映射（`citation_manager.py:640-708`）：`build_ref_number_map()` 对论文类引用做标题+作者去重，其他类型保持唯一编号

**Solve CitationManager**（`src/agents/solve/solve_loop/citation_manager.py:10-75`）：
- 单例模式（`__new__` + `_initialized` 标志），确保整个 Solve 流程中引用编号全局唯一连续
- `allocate_citation_id()` 返回 `[1]`, `[2]` 格式的递增编号
- ResponseAgent 在生成回答后提取使用的引用（`response_agent.py:280-301`），只保留 `allowed` 集合中的合法引用

#### 2.2.4 相关性分析（Layer 3）

RelevanceAnalyzer（`src/agents/question/agents/relevance_analyzer.py:17-208`）的核心设计：

- **不拒绝，只分类**：输出 `high` 或 `partial`，所有问题都被接受（`relevance_analyzer.py:27-29`）
- **低温度保一致性**：`temperature=0.3`（`relevance_analyzer.py:101`）
- **多策略 JSON 解析**（`relevance_analyzer.py:120-176`）：
  1. 先尝试从 markdown 代码块提取 JSON
  2. 清理控制字符
  3. 直接 `json.loads`
  4. 正则提取 `{...}` 对象
- **优雅降级**：解析失败返回默认 `partial`（`relevance_analyzer.py:111-118`），不中断流程

#### 2.2.5 精确回答决策（Layer 4）

PrecisionAnswerAgent（`src/agents/solve/solve_loop/precision_answer_agent.py:18-97`）实现两阶段质量提升：

1. **决策阶段** `_should_generate()`：LLM 判断问题是否需要精确回答（返回 Y/N）
2. **生成阶段** `_generate_precision_answer()`：基于详细回答生成精确版本

如果决策为"不需要"，直接返回原始 `detailed_answer`，避免不必要的 LLM 调用。

### 2.3 实现细节

#### 数据流：从 LLM 输出到验证通过

```
LLM 原始输出 (str)
    │
    ▼
extract_json_from_text()  ← 多策略 JSON 提取
    │
    ▼
validate_xxx_output()     ← Pydantic 模型验证
    │ 失败 → LLMParseError → retry_on_parse_error 重试
    ▼
业务逻辑处理
    │
    ▼
CitationManager.validate_citation_references()  ← 引用完整性
    │ 无效引用 → fix_invalid_citations() 自动移除
    ▼
RelevanceAnalyzer.process()  ← 语义质量分类
    │
    ▼
PrecisionAnswerAgent.process()  ← 可选精确化
    │
    ▼
最终输出
```

#### 异常层级设计

DeepTutor 定义了完整的 LLM 异常层级（`src/services/llm/exceptions.py:14-153`）：

```
LLMError (基类)
├── LLMConfigError        — 配置错误
├── LLMProviderError      — 提供商错误
├── LLMParseError         — 解析失败（质量检查核心异常）
└── LLMAPIError           — API 调用失败
    ├── LLMTimeoutError   — 超时
    ├── LLMRateLimitError — 限流
    ├── LLMAuthenticationError — 认证失败
    └── LLMModelNotFoundError  — 模型不存在
```

`LLMParseError` 是质量检查的核心异常类型，所有验证失败都统一抛出此异常，上层通过 `retry_on_parse_error` 装饰器捕获并重试。

---

## 第 3 章 迁移指南（≥ 40 行）

### 3.1 迁移清单

**阶段 1：结构化输出验证（1-2 天）**
- [ ] 为每种 Agent 输出定义 Pydantic BaseModel
- [ ] 实现 `field_validator` 做字段级约束（白名单、非空、类型）
- [ ] 实现 `model_validator` 做跨字段语义约束
- [ ] 定义统一的 `LLMParseError` 异常类
- [ ] 实现 `validate_xxx_output()` 统一入口函数
- [ ] 集成 tenacity 重试装饰器

**阶段 2：引用完整性系统（1-2 天）**
- [ ] 实现 CitationManager（全局 ID 分配 + JSON 持久化）
- [ ] 实现 `validate_citation_references()` 引用验证
- [ ] 实现 `fix_invalid_citations()` 自动修复
- [ ] 如需并行，添加 asyncio.Lock 保护

**阶段 3：语义质量分析（可选）**
- [ ] 实现 RelevanceAnalyzer（分类而非拒绝）
- [ ] 实现多策略 JSON 解析（markdown 提取 → 控制字符清理 → 正则兜底）

**阶段 4：精确回答增强（可选）**
- [ ] 实现两阶段 PrecisionAnswerAgent（决策 + 生成）

### 3.2 适配代码模板

#### 模板 1：Pydantic 输出验证器

```python
from pydantic import BaseModel, Field, ValidationError, field_validator
from typing import Any, Optional

# 1. 定义你的 Agent 输出模型
class MyAgentOutput(BaseModel):
    reasoning: str = Field(..., min_length=1)
    actions: list[dict] = Field(..., min_length=1)
    confidence: float = Field(default=0.5, ge=0.0, le=1.0)

    @field_validator("actions")
    @classmethod
    def validate_actions(cls, v):
        for action in v:
            if "type" not in action:
                raise ValueError("Each action must have a 'type' field")
        return v

# 2. 统一验证入口
class ParseError(Exception):
    pass

def validate_my_agent_output(output: dict[str, Any]) -> bool:
    try:
        MyAgentOutput(**output)
        return True
    except ValidationError as e:
        errors = "; ".join(
            f"{'.'.join(str(x) for x in err['loc'])}: {err['msg']}"
            for err in e.errors()
        )
        raise ParseError(f"Validation failed: {errors}") from e

# 3. 重试装饰器
import tenacity

def retry_on_parse(max_retries=2):
    def decorator(func):
        return tenacity.retry(
            retry=tenacity.retry_if_exception_type(ParseError),
            wait=tenacity.wait_exponential(min=1, max=30),
            stop=tenacity.stop_after_attempt(max_retries + 1),
        )(func)
    return decorator
```

#### 模板 2：引用完整性管理器

```python
import re
import json
from pathlib import Path
from typing import Any

class SimpleCitationManager:
    def __init__(self, cache_path: Path):
        self._citations: dict[str, dict] = {}
        self._counter = 0
        self._cache_path = cache_path

    def allocate_id(self, tool_type: str, query: str) -> str:
        self._counter += 1
        cid = f"[{self._counter}]"
        self._citations[cid] = {"tool_type": tool_type, "query": query}
        return cid

    def validate_references(self, text: str) -> dict[str, Any]:
        found = re.findall(r"\[(\d+)\]", text)
        found_ids = [f"[{n}]" for n in found]
        valid = [c for c in found_ids if c in self._citations]
        invalid = [c for c in found_ids if c not in self._citations]
        return {"valid": valid, "invalid": invalid, "is_valid": len(invalid) == 0}

    def fix_invalid(self, text: str) -> str:
        result = self.validate_references(text)
        for inv in result["invalid"]:
            text = text.replace(inv, "")
        return text

    def save(self):
        self._cache_path.write_text(json.dumps(self._citations, ensure_ascii=False, indent=2))
```

### 3.3 适用场景

| 场景 | 适用度 | 说明 |
|------|--------|------|
| 学术问答系统 | ⭐⭐⭐ | 引用准确性是核心需求，DeepTutor 方案直接适用 |
| RAG 应用 | ⭐⭐⭐ | Pydantic 验证 + 引用追溯是 RAG 质量保障标配 |
| 多步骤 Agent 流水线 | ⭐⭐⭐ | 每步输出验证 + 重试机制防止错误传播 |
| 简单聊天机器人 | ⭐ | 过度设计，直接字符串输出即可 |
| 实时流式输出 | ⭐⭐ | 需要适配流式场景，验证时机需调整到流结束后 |

---

## 第 4 章 测试用例（≥ 20 行）

```python
import pytest
from pydantic import ValidationError

# 假设已按模板 1 实现
from my_project.validators import MyAgentOutput, validate_my_agent_output, ParseError
from my_project.citations import SimpleCitationManager
from pathlib import Path
import tempfile


class TestPydanticValidation:
    """测试 Pydantic 结构化输出验证"""

    def test_valid_output(self):
        output = {
            "reasoning": "Based on the knowledge base...",
            "actions": [{"type": "rag_search", "query": "quantum physics"}],
            "confidence": 0.85,
        }
        assert validate_my_agent_output(output) is True

    def test_missing_required_field(self):
        output = {"actions": [{"type": "search"}]}  # missing reasoning
        with pytest.raises(ParseError, match="reasoning"):
            validate_my_agent_output(output)

    def test_invalid_action_no_type(self):
        output = {
            "reasoning": "test",
            "actions": [{"query": "no type field"}],
        }
        with pytest.raises(ParseError, match="type"):
            validate_my_agent_output(output)

    def test_empty_actions_list(self):
        output = {"reasoning": "test", "actions": []}
        with pytest.raises(ParseError):
            validate_my_agent_output(output)

    def test_confidence_out_of_range(self):
        output = {
            "reasoning": "test",
            "actions": [{"type": "search"}],
            "confidence": 1.5,
        }
        with pytest.raises(ParseError):
            validate_my_agent_output(output)


class TestCitationManager:
    """测试引用完整性管理"""

    def setup_method(self):
        self.tmp = Path(tempfile.mktemp(suffix=".json"))
        self.cm = SimpleCitationManager(self.tmp)

    def test_allocate_sequential_ids(self):
        id1 = self.cm.allocate_id("rag", "query1")
        id2 = self.cm.allocate_id("web", "query2")
        assert id1 == "[1]"
        assert id2 == "[2]"

    def test_validate_valid_references(self):
        self.cm.allocate_id("rag", "q1")
        self.cm.allocate_id("web", "q2")
        result = self.cm.validate_references("According to [1] and [2], ...")
        assert result["is_valid"] is True
        assert len(result["invalid"]) == 0

    def test_validate_invalid_references(self):
        self.cm.allocate_id("rag", "q1")
        result = self.cm.validate_references("See [1] and [99]")
        assert result["is_valid"] is False
        assert "[99]" in result["invalid"]

    def test_fix_invalid_removes_bad_refs(self):
        self.cm.allocate_id("rag", "q1")
        fixed = self.cm.fix_invalid("See [1] and [99] for details")
        assert "[1]" in fixed
        assert "[99]" not in fixed

    def test_save_and_persistence(self):
        self.cm.allocate_id("rag", "q1")
        self.cm.save()
        assert self.tmp.exists()
        import json
        data = json.loads(self.tmp.read_text())
        assert "[1]" in data
```

---

## 第 5 章 跨域关联

| 关联域 | 关系类型 | 说明 |
|--------|----------|------|
| PD-03 容错与重试 | 协同 | `retry_on_parse_error` 装饰器是容错机制在质量检查层的具体应用；`LLMParseError` 异常层级与 PD-03 的错误处理体系共享 |
| PD-04 工具系统 | 依赖 | Pydantic 验证中的 `VALID_INVESTIGATE_TOOLS` / `VALID_SOLVE_TOOLS` 白名单来自工具系统注册表 |
| PD-06 记忆持久化 | 协同 | CitationManager 的 JSON 持久化（`_save_citations`）是记忆系统的一部分；Solve 模块的 CitationMemory 跨步骤保持引用状态 |
| PD-08 搜索与检索 | 依赖 | Research CitationManager 管理搜索结果的引用 ID，确保 RAG/Web/Paper 搜索结果可追溯 |
| PD-01 上下文管理 | 协同 | RelevanceAnalyzer 截断过长上下文（`knowledge_context[:4000]`），是上下文管理在质量检查层的体现 |

---

## 第 6 章 来源文件索引

| 文件 | 行范围 | 关键实现 |
|------|--------|----------|
| `src/agents/solve/utils/error_handler.py` | L26-L135 | Pydantic 输出模型定义（ToolIntent, InvestigateOutput, NoteOutput, ReflectOutput, PlanOutput, SolveOutput） |
| `src/agents/solve/utils/error_handler.py` | L141-L171 | tenacity 重试装饰器 `retry_on_parse_error` |
| `src/agents/solve/utils/error_handler.py` | L174-L364 | 验证函数集（validate_investigate/note/reflect/plan/solve_output） |
| `src/agents/research/utils/citation_manager.py` | L19-L799 | Research CitationManager 完整实现（ID 生成、验证、修复、去重、异步安全） |
| `src/agents/solve/solve_loop/citation_manager.py` | L10-L75 | Solve CitationManager（单例模式、递增编号） |
| `src/agents/question/agents/relevance_analyzer.py` | L17-L208 | RelevanceAnalyzer（相关性分类、多策略 JSON 解析） |
| `src/agents/solve/solve_loop/precision_answer_agent.py` | L18-L97 | PrecisionAnswerAgent（两阶段精确回答） |
| `src/agents/solve/solve_loop/response_agent.py` | L280-L301 | 引用提取与过滤（`_extract_used_citations`） |
| `src/agents/solve/utils/config_validator.py` | L14-L314 | ConfigValidator（配置文件结构验证） |
| `src/utils/document_validator.py` | L13-L169 | DocumentValidator（文件上传安全验证） |
| `src/services/llm/exceptions.py` | L14-L153 | LLM 异常层级定义 |

---

## 第 7 章 横向对比维度

> **重要：** 本章用于自动填充 Butcher Wiki 的横向对比表。

```json comparison_data
{
  "project": "DeepTutor",
  "dimensions": {
    "检查方式": "四层递进：Pydantic 结构验证 → 引用完整性 → 语义分类 → 精确化决策",
    "评估维度": "结构正确性 + 引用存在性 + 语义相关性（high/partial）",
    "评估粒度": "每个 Agent 输出独立验证，5 种 Pydantic 模型覆盖全流程",
    "迭代机制": "tenacity 指数退避重试（默认 2 次），无 Generator-Critic 循环",
    "反馈机制": "Pydantic ValidationError 格式化为可读错误信息，驱动重试",
    "自动修复": "fix_invalid_citations() 自动移除无效引用 ID",
    "覆盖范围": "Investigate/Note/Reflect/Plan/Solve 五类输出 + 引用 + 配置 + 文件上传",
    "并发策略": "Research CitationManager 用 asyncio.Lock 保护并行 ID 分配",
    "降级路径": "RelevanceAnalyzer 失败返回默认 partial；safe_parse 返回默认值"
  }
}
```

### 域元数据补充

```json domain_metadata
{
  "description": "输入安全验证（文件上传、配置文件）也是质量保障的前置环节",
  "sub_problems": [
    "引用完整性：生成文本中的引用 ID 是否真实存在于引用库中",
    "输入安全验证：上传文件的类型、大小、MIME 是否合规"
  ],
  "best_practices": [
    "Pydantic 模型验证优于手动 dict 检查：类型安全、错误信息自动格式化、支持嵌套验证",
    "分类优于拒绝：RelevanceAnalyzer 标注 high/partial 而非 pass/fail，保留所有内容价值",
    "两阶段精确化节省资源：先判断是否需要精确回答，避免对所有问题统一精确化"
  ]
}
```
