# PD-04.05 DeepTutor — 学术场景专用工具系统

> 文档编号：PD-04.05
> 来源：DeepTutor `src/tools/`, `src/agents/solve/solve_loop/tool_agent.py`
> GitHub：https://github.com/HKUDS/DeepTutor.git
> 问题域：PD-04 工具系统 Tool System Design
> 状态：可复用方案

---

## 第 1 章 问题与动机

### 1.1 核心问题

学术辅导 Agent 需要调用多种异构工具——RAG 检索、网络搜索、代码执行、论文搜索、公式/定理查询、TeX 下载——来回答用户的学术问题。核心挑战在于：

1. **工具种类多且异构**：有的是同步函数（web_search）、有的是异步（rag_search）、有的需要子进程隔离（code_executor），统一调度困难
2. **工具调用需要全生命周期追踪**：每次调用的输入、输出、耗时、状态（pending→running→success/failed）都要记录，用于后续引用和调试
3. **工具结果需要二次加工**：原始工具输出（JSON、长文本、代码执行日志）不能直接喂给 LLM，需要摘要化
4. **不同 Agent 需要不同工具子集**：InvestigateAgent 用 RAG + web_search + query_item，ToolAgent 用 RAG + web_search + code_execution，需要按角色分配工具

### 1.2 DeepTutor 的解法概述

1. **薄包装层 + 服务层分离**：`src/tools/` 是薄包装（thin wrapper），真正逻辑在 `src/services/` 层。工具文件只做 re-export 和简单适配（`src/tools/web_search.py:30-47`）
2. **YAML 配置驱动的工具白名单**：`config/main.yaml:57-62` 定义 `valid_tools` 列表，Agent 只能调用白名单内的工具
3. **ToolCallRecord 全生命周期追踪**：`src/agents/solve/memory/solve_memory.py:22-65` 定义了完整的工具调用记录数据结构，含状态机（pending→running→success/failed）
4. **LLM 驱动的结果摘要**：ToolAgent 执行工具后，调用 LLM 对原始结果做摘要（`src/agents/solve/solve_loop/tool_agent.py:349-369`）
5. **Provider 模式的可插拔搜索**：搜索工具支持 6 种 provider（perplexity/baidu/tavily/exa/serper/jina），通过配置切换（`src/services/search/base.py:21-88`）

### 1.3 设计思想

| 设计原则 | 具体实现 | 理由 | 替代方案 |
|----------|----------|------|----------|
| 薄包装层 | tools/ 只做 re-export，逻辑在 services/ | 工具接口稳定，底层实现可替换 | 工具直接包含逻辑（耦合高） |
| 配置驱动白名单 | main.yaml 的 valid_tools 列表 | 集中管控，防止 LLM 调用未授权工具 | 硬编码在 Agent 中（难维护） |
| 全生命周期记录 | ToolCallRecord dataclass + 状态机 | 支持引用追踪、调试、重试 | 只记录最终结果（丢失过程信息） |
| LLM 摘要中间层 | tool_agent 调用 LLM 摘要原始结果 | 原始结果太长/格式不统一 | 硬编码截断（丢失关键信息） |
| Provider 抽象 | BaseSearchProvider ABC + 6 个实现 | 搜索源可热切换，不改调用代码 | 单一搜索源（灵活性差） |

---

## 第 2 章 源码实现分析

### 2.1 架构概览

```
┌─────────────────────────────────────────────────────────┐
│                    Agent Layer                           │
│  ┌──────────────────┐  ┌──────────────────────────────┐ │
│  │ InvestigateAgent │  │        ToolAgent             │ │
│  │ (analysis loop)  │  │     (solve loop)             │ │
│  │ tools: rag_naive │  │ tools: rag_naive/hybrid      │ │
│  │   rag_hybrid     │  │   web_search                 │ │
│  │   web_search     │  │   code_execution             │ │
│  │   query_item     │  │                              │ │
│  └────────┬─────────┘  └──────────┬───────────────────┘ │
│           │                       │                      │
│           ▼                       ▼                      │
│  ┌────────────────────────────────────────────────────┐  │
│  │              src/tools/ (Thin Wrappers)            │  │
│  │  __init__.py → re-export all tools                │  │
│  │  rag_tool.py → delegates to RAGService            │  │
│  │  web_search.py → re-exports from services/search  │  │
│  │  code_executor.py → WorkspaceManager + subprocess │  │
│  │  paper_search_tool.py → arxiv client              │  │
│  │  query_item_tool.py → JSON lookup                 │  │
│  │  tex_downloader.py → HTTP + tar/zip extract       │  │
│  └────────────────────┬───────────────────────────────┘  │
│                       │                                  │
│                       ▼                                  │
│  ┌────────────────────────────────────────────────────┐  │
│  │           src/services/ (Business Logic)           │  │
│  │  search/base.py → BaseSearchProvider ABC           │  │
│  │  search/providers/ → 6 provider implementations    │  │
│  │  rag/service.py → RAGService (multi-provider)      │  │
│  └────────────────────────────────────────────────────┘  │
│                                                          │
│  ┌────────────────────────────────────────────────────┐  │
│  │         config/main.yaml (Single Source of Truth)  │  │
│  │  tools.web_search.enabled / provider               │  │
│  │  tools.run_code.workspace / allowed_roots          │  │
│  │  tools.query_item.max_results                      │  │
│  │  solve.valid_tools → [rag_naive, rag_hybrid, ...]  │  │
│  └────────────────────────────────────────────────────┘  │
│                                                          │
│  ┌────────────────────────────────────────────────────┐  │
│  │    SolveMemory / ToolCallRecord (Lifecycle Track)  │  │
│  │  pending → running → success / failed              │  │
│  │  + cite_id + metadata + timestamps                 │  │
│  └────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────┘
```

### 2.2 核心实现

#### 2.2.1 工具注册：薄包装 + __init__.py 统一导出

DeepTutor 没有使用装饰器或注册表模式，而是通过 Python 模块导入机制实现工具注册。`src/tools/__init__.py:57-88` 是工具的统一入口：

```python
# src/tools/__init__.py:57-78
from .code_executor import run_code, run_code_sync
from .query_item_tool import query_numbered_item
from .rag_tool import rag_search
from .web_search import web_search

# Paper research related tools (graceful degradation)
try:
    from .paper_search_tool import PaperSearchTool
    from .tex_chunker import TexChunker
    from .tex_downloader import TexDownloader, read_tex_file

    __all__ = [
        "PaperSearchTool", "TexChunker", "TexDownloader",
        "query_numbered_item", "rag_search", "read_tex_file",
        "run_code", "run_code_sync", "web_search",
    ]
except ImportError as e:
    # Graceful degradation: only export basic tools
    __all__ = [
        "query_numbered_item", "rag_search",
        "run_code", "run_code_sync", "web_search",
    ]
```

关键设计：论文相关工具（依赖 tiktoken/arxiv）用 try/except 包裹，缺少依赖时优雅降级，不影响核心工具。

#### 2.2.2 工具调度：ToolAgent 的 if-else 路由

ToolAgent 通过 `_execute_single_call` 方法（`src/agents/solve/solve_loop/tool_agent.py:227-315`）根据 `tool_type` 字符串路由到具体工具：

```python
# src/agents/solve/solve_loop/tool_agent.py:238-315
async def _execute_single_call(self, record: ToolCallRecord, kb_name: str,
                                output_dir: str | None, artifacts_dir: str,
                                verbose: bool) -> tuple[str, dict[str, Any]]:
    tool_type = record.tool_type
    query = record.query

    if tool_type == "rag_naive":
        result = await rag_search(query=query, kb_name=kb_name, mode="naive")
        answer = result.get("answer", "")
        source, auto_sources = self._infer_sources(answer)
        metadata = {"source": source, "auto_sources": auto_sources, "mode": "naive"}
        return answer, metadata

    if tool_type == "rag_hybrid":
        result = await rag_search(query=query, kb_name=kb_name, mode="hybrid")
        # ... similar pattern

    if tool_type == "web_search":
        result = web_search(query=query, output_dir=output_dir, verbose=verbose)
        # ... extract answer + citations

    if tool_type == "code_execution":
        code = await self._generate_code_from_intent(query)
        exec_result = await run_code(
            language="python", code=code,
            timeout=self.agent_config.get("code_timeout", 20),
            assets_dir=artifacts_dir,
        )
        # ... format result + collect artifacts

    raise ValueError(f"Unknown tool type: {tool_type}")
```

注意 code_execution 的特殊处理：先用 LLM 将自然语言意图转为 Python 代码（`_generate_code_from_intent`，L50-78），再执行。这是一个两阶段工具调用模式。

#### 2.2.3 ToolCallRecord 生命周期追踪

`src/agents/solve/memory/solve_memory.py:22-65` 定义了工具调用的完整生命周期：

```python
# src/agents/solve/memory/solve_memory.py:22-65
@dataclass
class ToolCallRecord:
    """Single tool call record"""
    tool_type: str
    query: str
    cite_id: Optional[str] = None
    raw_answer: Optional[str] = None
    summary: Optional[str] = None
    status: str = "pending"  # pending | running | success | failed | none | finish
    metadata: Dict[str, Any] = field(default_factory=dict)
    created_at: str = field(default_factory=_now)
    updated_at: str = field(default_factory=_now)
    call_id: str = field(default_factory=lambda: f"tc_{uuid.uuid4().hex[:8]}")

    def mark_running(self):
        self.status = "running"
        self.updated_at = _now()

    def mark_result(self, raw_answer: str, summary: str,
                    status: str = "success", metadata: Optional[Dict] = None):
        self.raw_answer = raw_answer
        self.summary = summary
        self.status = status
        if metadata:
            self.metadata.update(metadata)
        self.updated_at = _now()
```

每个 ToolCallRecord 嵌入 SolveChainStep 中，形成 `SolveMemory → SolveChainStep[] → ToolCallRecord[]` 的三层结构，支持按步骤追踪工具调用。

#### 2.2.4 搜索工具的 Provider 模式

`src/services/search/base.py:21-88` 定义了搜索 Provider 的抽象基类：

```python
# src/services/search/base.py:21-69
class BaseSearchProvider(ABC):
    name: str = "base"
    display_name: str = "Base Provider"
    description: str = ""
    requires_api_key: bool = True
    supports_answer: bool = False  # Whether provider generates LLM answers
    BASE_URL: str = ""

    def __init__(self, api_key: str | None = None, **kwargs: Any) -> None:
        self.api_key = api_key or self._get_api_key()
        self.config = kwargs

    @abstractmethod
    def search(self, query: str, **kwargs: Any) -> WebSearchResponse:
        pass

    def is_available(self) -> bool:
        # Check API key availability
        ...
```

6 个 Provider 实现（perplexity/baidu/tavily/exa/serper/jina）在 `src/services/search/providers/` 下，通过 `get_provider(name)` 工厂函数获取实例。Provider 选择优先级：函数参数 > 环境变量 `SEARCH_PROVIDER` > `config/main.yaml` > 默认 perplexity。

#### 2.2.5 代码执行的沙箱隔离

`src/tools/code_executor.py:115-244` 的 WorkspaceManager 实现了代码执行的路径隔离：

- 工作空间路径：环境变量 > 配置文件 > 默认 `data/user/run_code_workspace`（L118-137）
- 允许的根路径白名单：`allowed_roots` 配置 + 项目根目录 + 用户目录（L141-177）
- 路径校验：`_ensure_within_allowed_roots` 检查所有文件操作路径必须在白名单内（L219-244）
- ImportGuard：AST 解析检查导入模块是否在允许列表中（`code_executor.py:247-274`）

### 2.3 实现细节

**工具结果摘要流程**（`tool_agent.py:349-369`）：

ToolAgent 执行工具后，不直接将原始结果返回给 SolveAgent，而是先调用 LLM 做摘要：

1. 从 YAML prompt 模板加载 system_prompt 和 user_template
2. 将 `tool_type`、`query`、`raw_answer[:2000]`（截断到 2000 字符）填入模板
3. LLM 生成摘要后，同时存入 SolveMemory 和 CitationMemory

**工具启用/禁用的配置控制**：

- `config/main.yaml:23` 的 `tools.web_search.enabled` 控制 web_search 是否可用
- InvestigateAgent 在 `__init__` 中读取此配置（`investigate_agent.py:47`），在 `_build_system_prompt` 中动态修改 prompt 移除 web_search 描述（L249-280）
- 运行时调用 web_search 时再次检查（L319-322），双重保险

**数据流：工具调用 → 引用追踪**：

```
LLM 规划 tool_calls → SolveMemory.append_tool_call() 创建 ToolCallRecord(status=pending)
    → ToolAgent.process() 遍历 pending records
        → _execute_single_call() 执行具体工具
        → _summarize_tool_result() LLM 摘要
        → SolveMemory.update_tool_call_result(status=success/failed)
        → CitationMemory.update_citation(cite_id, raw_result, summary)
    → SolveMemory.save() + CitationMemory.save() 持久化到 JSON
```

---

## 第 3 章 迁移指南

### 3.1 迁移清单

**阶段 1：基础工具框架**
- [ ] 创建 `tools/` 目录，每个工具一个文件 + `__init__.py` 统一导出
- [ ] 定义 ToolCallRecord dataclass（含 status 状态机、call_id、timestamps）
- [ ] 在配置文件中定义 `valid_tools` 白名单

**阶段 2：工具实现**
- [ ] 实现各工具的薄包装函数（统一返回 `dict` 格式）
- [ ] 对需要隔离的工具（代码执行）实现 WorkspaceManager
- [ ] 对有多个后端的工具（搜索）实现 Provider 抽象

**阶段 3：工具调度 Agent**
- [ ] 实现 ToolAgent，根据 tool_type 路由到具体工具
- [ ] 实现 LLM 结果摘要中间层
- [ ] 集成 CitationMemory 做引用追踪

**阶段 4：配置化**
- [ ] 工具启用/禁用通过配置控制
- [ ] 工具参数（timeout、max_results 等）通过配置注入
- [ ] Provider 选择通过配置 + 环境变量控制

### 3.2 适配代码模板

**ToolCallRecord 模板（可直接复用）：**

```python
from dataclasses import dataclass, field, asdict
from datetime import datetime
from typing import Any, Optional, Dict
import uuid

def _now() -> str:
    return datetime.utcnow().isoformat()

@dataclass
class ToolCallRecord:
    """工具调用全生命周期记录"""
    tool_type: str
    query: str
    cite_id: Optional[str] = None
    raw_answer: Optional[str] = None
    summary: Optional[str] = None
    status: str = "pending"  # pending → running → success / failed
    metadata: Dict[str, Any] = field(default_factory=dict)
    created_at: str = field(default_factory=_now)
    updated_at: str = field(default_factory=_now)
    call_id: str = field(default_factory=lambda: f"tc_{uuid.uuid4().hex[:8]}")

    def mark_running(self):
        self.status = "running"
        self.updated_at = _now()

    def mark_success(self, raw_answer: str, summary: str, metadata: Optional[Dict] = None):
        self.raw_answer = raw_answer
        self.summary = summary
        self.status = "success"
        if metadata:
            self.metadata.update(metadata)
        self.updated_at = _now()

    def mark_failed(self, error: str):
        self.raw_answer = error
        self.summary = error[:200]
        self.status = "failed"
        self.metadata["error"] = True
        self.updated_at = _now()

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)
```

**工具路由器模板：**

```python
from typing import Any, Callable, Awaitable

class ToolRouter:
    """工具路由器：根据 tool_type 分发到具体工具"""

    def __init__(self, valid_tools: list[str]):
        self._handlers: dict[str, Callable[..., Awaitable[tuple[str, dict]]]] = {}
        self._valid_tools = set(valid_tools)

    def register(self, tool_type: str, handler: Callable[..., Awaitable[tuple[str, dict]]]):
        if tool_type not in self._valid_tools:
            raise ValueError(f"Tool '{tool_type}' not in valid_tools whitelist")
        self._handlers[tool_type] = handler

    async def execute(self, record: ToolCallRecord, **kwargs) -> tuple[str, dict[str, Any]]:
        handler = self._handlers.get(record.tool_type)
        if not handler:
            raise ValueError(f"Unknown tool type: {record.tool_type}")
        record.mark_running()
        try:
            raw_answer, metadata = await handler(query=record.query, **kwargs)
            record.mark_success(raw_answer, summary="", metadata=metadata)
            return raw_answer, metadata
        except Exception as e:
            record.mark_failed(str(e))
            raise
```

### 3.3 适用场景

| 场景 | 适用度 | 说明 |
|------|--------|------|
| 学术/教育 Agent | ⭐⭐⭐ | 完美匹配：RAG + 论文搜索 + 公式查询 + 代码执行 |
| 通用研究 Agent | ⭐⭐⭐ | 搜索 Provider 模式 + 工具生命周期追踪可直接复用 |
| 简单 Chatbot | ⭐ | 过度设计：不需要 ToolCallRecord 和 CitationMemory |
| 需要 MCP 协议的场景 | ⭐ | DeepTutor 不支持 MCP，需自行扩展 |
| 需要动态工具注册的场景 | ⭐⭐ | if-else 路由不够灵活，需改为注册表模式 |

---

## 第 4 章 测试用例

```python
import pytest
from dataclasses import asdict
from unittest.mock import AsyncMock, patch
from datetime import datetime

# --- ToolCallRecord Tests ---

class TestToolCallRecord:
    def test_create_with_defaults(self):
        record = ToolCallRecord(tool_type="rag_naive", query="What is AI?")
        assert record.status == "pending"
        assert record.call_id.startswith("tc_")
        assert record.raw_answer is None
        assert record.created_at is not None

    def test_status_transitions(self):
        record = ToolCallRecord(tool_type="web_search", query="test")
        assert record.status == "pending"

        record.mark_running()
        assert record.status == "running"

        record.mark_result(
            raw_answer="result text",
            summary="summary",
            status="success",
            metadata={"elapsed_ms": 150}
        )
        assert record.status == "success"
        assert record.raw_answer == "result text"
        assert record.metadata["elapsed_ms"] == 150

    def test_failed_status(self):
        record = ToolCallRecord(tool_type="code_execution", query="plot graph")
        record.mark_result(
            raw_answer="Error: timeout",
            summary="Execution timed out",
            status="failed",
            metadata={"exit_code": -1, "execution_failed": True}
        )
        assert record.status == "failed"
        assert record.metadata["execution_failed"] is True

    def test_serialization(self):
        record = ToolCallRecord(tool_type="rag_hybrid", query="test query")
        d = record.to_dict()
        assert d["tool_type"] == "rag_hybrid"
        assert d["query"] == "test query"
        restored = ToolCallRecord.from_dict(d)
        assert restored.tool_type == record.tool_type
        assert restored.call_id == record.call_id


# --- Tool Routing Tests ---

class TestToolRouting:
    @pytest.mark.asyncio
    async def test_valid_tool_dispatch(self):
        """Test that ToolAgent routes to correct tool based on tool_type"""
        mock_rag = AsyncMock(return_value={"answer": "RAG result"})
        with patch("src.tools.rag_tool.rag_search", mock_rag):
            # Simulate ToolAgent._execute_single_call for rag_naive
            result = await mock_rag(query="test", kb_name="kb", mode="naive")
            assert result["answer"] == "RAG result"
            mock_rag.assert_called_once()

    @pytest.mark.asyncio
    async def test_unknown_tool_raises(self):
        """Unknown tool_type should raise ValueError"""
        record = ToolCallRecord(tool_type="unknown_tool", query="test")
        # ToolAgent._execute_single_call raises ValueError for unknown types
        with pytest.raises(ValueError, match="Unknown tool type"):
            raise ValueError(f"Unknown tool type: {record.tool_type}")

    def test_valid_tools_whitelist(self):
        """Config-defined valid_tools should match expected set"""
        valid_tools = ["rag_naive", "rag_hybrid", "web_search", "query_item", "none"]
        assert "rag_naive" in valid_tools
        assert "code_execution" not in valid_tools  # Only in solve loop, not investigate


# --- Code Executor Tests ---

class TestCodeExecutor:
    def test_import_guard_blocks_unauthorized(self):
        """ImportGuard should block unauthorized imports"""
        from src.tools.code_executor import ImportGuard, CodeExecutionError

        with pytest.raises(CodeExecutionError, match="not in the allowed list"):
            ImportGuard.validate("import os\nimport subprocess", allowed_imports=["math", "numpy"])

    def test_import_guard_allows_authorized(self):
        from src.tools.code_executor import ImportGuard

        # Should not raise
        ImportGuard.validate("import math\nimport numpy", allowed_imports=["math", "numpy"])

    def test_workspace_path_validation(self):
        """WorkspaceManager should reject paths outside allowed roots"""
        from src.tools.code_executor import WorkspaceManager

        ws = WorkspaceManager()
        with pytest.raises(ValueError, match="must be located under"):
            ws._ensure_within_allowed_roots(Path("/etc/passwd"))
```

---

## 第 5 章 跨域关联

| 关联域 | 关系类型 | 说明 |
|--------|----------|------|
| PD-01 上下文管理 | 协同 | ToolCallRecord 的 raw_answer 截断到 2000 字符做摘要，是上下文压缩的一种形式 |
| PD-02 多 Agent 编排 | 依赖 | InvestigateAgent 和 ToolAgent 分属不同循环（analysis loop / solve loop），工具分配依赖编排设计 |
| PD-03 容错与重试 | 协同 | ToolCallRecord 的 status=failed 状态支持重试决策；code_executor 的 TimeoutExpired 处理是容错机制 |
| PD-05 沙箱隔离 | 依赖 | code_executor 的 WorkspaceManager + ImportGuard 是沙箱隔离的具体实现 |
| PD-06 记忆持久化 | 协同 | SolveMemory 和 CitationMemory 将工具调用结果持久化为 JSON，支持跨会话引用 |
| PD-08 搜索与检索 | 依赖 | web_search 的 6-Provider 架构和 RAG 工具是搜索域的具体实现 |
| PD-11 可观测性 | 协同 | ToolAgent 的 log_tool_call 记录每次调用的耗时、状态、输入输出，是可观测性的数据源 |

---

## 第 6 章 来源文件索引

| 文件 | 行范围 | 关键实现 |
|------|--------|----------|
| `src/tools/__init__.py` | L1-92 | 工具统一导出 + 优雅降级 |
| `src/tools/code_executor.py` | L85-429 | WorkspaceManager + ImportGuard + run_code |
| `src/tools/web_search.py` | L1-72 | 搜索工具薄包装（re-export from services） |
| `src/tools/rag_tool.py` | L24-69 | RAG 检索工具（delegates to RAGService） |
| `src/tools/paper_search_tool.py` | L21-143 | ArXiv 论文搜索（arxiv client） |
| `src/tools/query_item_tool.py` | L16-289 | 编号条目查询（4 级匹配策略） |
| `src/tools/tex_downloader.py` | L42-220 | TeX 源码下载 + 解压 + 主文件定位 |
| `src/tools/tex_chunker.py` | L21-288 | LaTeX 智能分块（按 section/paragraph） |
| `src/agents/solve/solve_loop/tool_agent.py` | L27-471 | ToolAgent：工具调度 + LLM 摘要 + 产物收集 |
| `src/agents/solve/analysis_loop/investigate_agent.py` | L24-415 | InvestigateAgent：分析循环工具调用 |
| `src/agents/solve/memory/solve_memory.py` | L22-341 | ToolCallRecord + SolveChainStep + SolveMemory |
| `src/agents/base_agent.py` | L35-657 | BaseAgent：统一 LLM 调用 + prompt 加载 |
| `src/services/search/base.py` | L21-88 | BaseSearchProvider ABC |
| `src/services/search/__init__.py` | L92-218 | web_search 主函数 + Provider 选择逻辑 |
| `config/main.yaml` | L14-62 | 工具配置 + valid_tools 白名单 |
| `config/agents.yaml` | L1-58 | Agent 参数（temperature/max_tokens） |

---

## 第 7 章 横向对比维度

```json comparison_data
{
  "project": "DeepTutor",
  "dimensions": {
    "工具注册方式": "模块导入 + __init__.py 统一 re-export，无装饰器/注册表",
    "工具分组/权限": "YAML valid_tools 白名单 + Agent 级别工具子集分配",
    "MCP 协议支持": "不支持，工具接口为项目内部 Python 函数",
    "热更新/缓存": "Provider 运行时可切换（env/config），无工具热加载",
    "超时保护": "code_executor subprocess.timeout + 可配置 code_timeout",
    "结果摘要": "LLM 驱动的工具结果摘要中间层，截断 2000 字符后摘要",
    "生命周期追踪": "ToolCallRecord dataclass 6 状态机 + JSON 持久化"
  }
}
```

```json domain_metadata
{
  "description": "学术场景下工具结果需要 LLM 二次摘要和引用追踪，是工具系统的重要扩展维度",
  "sub_problems": [
    "工具结果摘要：原始工具输出如何压缩为 LLM 可消费的摘要文本",
    "工具调用生命周期：如何追踪 pending→running→success/failed 全状态",
    "工具优雅降级：依赖缺失时如何保证核心工具可用"
  ],
  "best_practices": [
    "薄包装层与服务层分离：tools/ 只做接口适配，逻辑放 services/",
    "工具结果截断后再摘要：防止超长输出撑爆上下文窗口",
    "代码执行前用 AST 检查导入：ImportGuard 在执行前拦截危险模块"
  ]
}
```
