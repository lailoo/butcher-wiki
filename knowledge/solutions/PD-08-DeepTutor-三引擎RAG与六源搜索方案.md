# PD-08.05 DeepTutor — 三引擎 RAG + 六源 Web 搜索

> 文档编号：PD-08.05
> 来源：DeepTutor `src/services/rag/`, `src/services/search/`
> GitHub：https://github.com/HKUDS/DeepTutor
> 问题域：PD-08 搜索与检索 Search & Retrieval
> 状态：可复用方案

---

## 第 1 章 问题与动机

### 1.1 核心问题

学术辅导场景下的知识检索面临三重挑战：

1. **文档格式多样性**：学术 PDF 包含公式、表格、图片等多模态内容，纯文本 RAG 丢失关键信息
2. **检索精度与速度的矛盾**：知识图谱检索精度高但慢，向量检索快但语义理解浅
3. **知识来源碎片化**：学生需要同时查阅教材（本地 KB）、论文（ArXiv）、网络资源（Web 搜索），每个来源的 API 和数据格式不同

DeepTutor 的核心洞察是：**不同场景需要不同的检索引擎**，而非一个万能方案。教材精读用知识图谱，快速查找用向量检索，多模态文档用 RAGAnything。

### 1.2 DeepTutor 的解法概述

DeepTutor 构建了一个**双层检索架构**：

1. **RAG 层（本地知识库）**：三引擎可切换 — LlamaIndex（纯向量，最快）、LightRAG（知识图谱，中速）、RAGAnything（多模态，最慢但最全）。通过工厂模式 + 懒加载实现引擎切换（`src/services/rag/factory.py:20-63`）
2. **Web 搜索层（外部知识）**：六 provider 统一接口 — Tavily、Serper、Jina、Exa、Perplexity、Baidu。装饰器注册 + 统一 `SEARCH_API_KEY` 环境变量（`src/services/search/providers/__init__.py:16-32`）
3. **组件化 RAG 管道**：Fluent API 组装 parser→chunker→embedder→indexer→retriever 五阶段管道（`src/services/rag/pipeline.py:26-43`）
4. **结果整合层**：Jinja2 模板 + LLM 两种策略将原始搜索结果转化为结构化答案（`src/services/search/consolidation.py:143-396`）
5. **学术搜索专用工具**：ArXiv 论文搜索 + 引用格式化（`src/tools/paper_search_tool.py:21-143`）

### 1.3 设计思想

| 设计原则 | 具体实现 | 理由 | 替代方案 |
|----------|----------|------|----------|
| 引擎可切换 | 工厂模式 + 懒加载，4 种 RAG pipeline 按需实例化 | 不同文档类型适合不同引擎，避免加载不需要的重依赖 | 单一引擎 + 配置参数（灵活性不足） |
| 组件正交 | Component Protocol + Fluent API 组装管道 | 每个组件独立可替换，新增 chunker/retriever 不影响其他组件 | 继承体系（耦合度高） |
| 统一搜索接口 | BaseSearchProvider ABC + 装饰器注册 | 6 个 provider 的 API 差异被封装，上层只看 WebSearchResponse | 每个 provider 独立调用（重复代码多） |
| 文件类型路由 | FileTypeRouter 按扩展名分流到不同解析器 | PDF 需要 MinerU 重解析，txt 直接读取，避免不必要的开销 | 统一用重解析器（浪费资源） |
| 嵌入适配器 | EmbeddingProviderManager 支持 7 种嵌入后端 | 用户可能用 OpenAI/Jina/Ollama 等不同嵌入服务 | 硬编码 OpenAI（不灵活） |

---

## 第 2 章 源码实现分析

### 2.1 架构概览

DeepTutor 的检索系统分为两大子系统，通过 Tool 层暴露给 Agent 使用：

```
┌─────────────────────────────────────────────────────────────────┐
│                        Agent Layer                              │
│  (ChatAgent / SolveAgent / ResearchAgent / GuideAgent)          │
├──────────┬──────────────┬───────────────────────────────────────┤
│ rag_tool │ web_search   │ paper_search_tool                     │
│          │              │ (ArXiv API)                            │
├──────────┴──────────────┴───────────────────────────────────────┤
│                     RAG Service Layer                            │
│  RAGService ─→ Factory ─→ Pipeline                              │
│                  │                                               │
│         ┌────────┼────────┬──────────────┐                      │
│         ▼        ▼        ▼              ▼                      │
│    LlamaIndex  LightRAG  RAGAnything  RAGAnything               │
│    (向量)      (知识图谱)  (MinerU)    (Docling)                │
│                                                                  │
│  Components: Parser → Chunker → Embedder → Indexer → Retriever  │
├──────────────────────────────────────────────────────────────────┤
│                   Web Search Service Layer                        │
│  web_search() ─→ Provider Registry ─→ AnswerConsolidator         │
│                    │                                              │
│    ┌───────┬───────┼───────┬────────┬──────────┐                │
│    ▼       ▼       ▼       ▼        ▼          ▼                │
│  Tavily  Serper   Jina    Exa   Perplexity   Baidu              │
│                                                                  │
│  Types: WebSearchResponse / Citation / SearchResult              │
├──────────────────────────────────────────────────────────────────┤
│                   Embedding Service Layer                         │
│  EmbeddingProviderManager → Adapter (OpenAI/Jina/Cohere/Ollama) │
└──────────────────────────────────────────────────────────────────┘
```

### 2.2 核心实现

#### 2.2.1 RAG 工厂 — 懒加载 + 按需导入

工厂注册表使用闭包延迟导入重依赖，避免 `import lightrag` 或 `import llama_index` 在模块加载时触发（`src/services/rag/factory.py:20-63`）：

```python
# src/services/rag/factory.py:20-63
_PIPELINES: Dict[str, Callable] = {}
_PIPELINES_INITIALIZED = False

def _init_pipelines():
    global _PIPELINES, _PIPELINES_INITIALIZED
    if _PIPELINES_INITIALIZED:
        return

    def _build_raganything(**kwargs):
        from .pipelines.raganything import RAGAnythingPipeline
        return RAGAnythingPipeline(**kwargs)

    def _build_lightrag(kb_base_dir=None, **kwargs):
        from .pipelines.lightrag import LightRAGPipeline
        return LightRAGPipeline(kb_base_dir=kb_base_dir)

    def _build_llamaindex(**kwargs):
        from .pipelines.llamaindex import LlamaIndexPipeline
        return LlamaIndexPipeline(**kwargs)

    _PIPELINES.update({
        "raganything": _build_raganything,
        "raganything_docling": _build_raganything_docling,
        "lightrag": _build_lightrag,
        "llamaindex": _build_llamaindex,
    })
    _PIPELINES_INITIALIZED = True
```

#### 2.2.2 Fluent API 组装 RAG 管道

`RAGPipeline` 通过链式调用组装五阶段管道，每个阶段是一个 `Component` Protocol 实现（`src/services/rag/pipeline.py:26-86`）：

```python
# src/services/rag/pipeline.py:26-86
class RAGPipeline:
    def __init__(self, name: str = "default", kb_base_dir=None):
        self._parser: Optional[Component] = None
        self._chunkers: List[Component] = []
        self._embedder: Optional[Component] = None
        self._indexers: List[Component] = []
        self._retriever: Optional[Component] = None

    def parser(self, p: Component) -> "RAGPipeline":
        self._parser = p; return self
    def chunker(self, c: Component) -> "RAGPipeline":
        self._chunkers.append(c); return self
    def indexer(self, i: Component) -> "RAGPipeline":
        self._indexers.append(i); return self
    def retriever(self, r: Component) -> "RAGPipeline":
        self._retriever = r; return self
```

LightRAG 管道的组装示例（`src/services/rag/pipelines/lightrag.py:18-44`）：

```python
# src/services/rag/pipelines/lightrag.py:18-44
def LightRAGPipeline(kb_base_dir=None) -> RAGPipeline:
    return (
        RAGPipeline("lightrag", kb_base_dir=kb_base_dir)
        .parser(PDFParser())
        .indexer(LightRAGIndexer(kb_base_dir=kb_base_dir))
        .retriever(LightRAGRetriever(kb_base_dir=kb_base_dir))
    )
```

注意 LightRAG 管道**跳过了 chunker 和 embedder**——因为 LightRAG 内部自带分块和嵌入。这体现了组件正交的好处：不需要的阶段直接不挂载。

#### 2.2.3 Web 搜索 Provider 注册机制

使用装饰器模式自动注册 provider（`src/services/search/providers/__init__.py:16-32`）：

```python
# src/services/search/providers/__init__.py:16-32
_PROVIDERS: dict[str, Type[BaseSearchProvider]] = {}

def register_provider(name: str):
    def decorator(cls: Type[BaseSearchProvider]):
        _PROVIDERS[name.lower()] = cls
        cls.name = name.lower()
        return cls
    return decorator

# 使用示例 (src/services/search/providers/tavily.py:27-28)
@register_provider("tavily")
class TavilyProvider(BaseSearchProvider):
    supports_answer = True
    BASE_URL = "https://api.tavily.com/search"
```

所有 provider 共享统一的 `SEARCH_API_KEY` 环境变量（`src/services/search/base.py:17`），简化配置。

#### 2.2.4 结果整合 — 模板 vs LLM 双策略

`AnswerConsolidator` 对 SERP 类 provider（Serper、Jina）的原始结果进行二次加工（`src/services/search/consolidation.py:143-396`）：

- **template 策略**：Jinja2 模板渲染，每个 provider 有专属模板（Serper 含 Knowledge Graph / Answer Box / People Also Ask）
- **llm 策略**：调用 LLM 将搜索结果合成结构化摘要，system prompt 要求输出 bullet points + citation numbers

AI 类 provider（Tavily、Perplexity、Baidu、Exa）自带 answer，不需要整合。

### 2.3 实现细节

#### 文件类型路由

`FileTypeRouter`（`src/services/rag/components/routing.py:47-335`）将文件分为三类：
- `needs_mineru`：PDF/DOCX/Image → MinerU 重解析
- `text_files`：.txt/.md/.py 等 40+ 种扩展名 → 直接读取（快速路径）
- `unsupported`：跳过并警告

还支持按 provider 返回支持的文件扩展名集合，用于前端文件选择器过滤。

#### 嵌入适配器体系

`EmbeddingProviderManager`（`src/services/embedding/provider.py:22-98`）维护 7 种嵌入后端的映射：

| binding | 适配器类 |
|---------|---------|
| openai / azure_openai / huggingface / google / lm_studio | OpenAICompatibleEmbeddingAdapter |
| jina | JinaEmbeddingAdapter |
| cohere | CohereEmbeddingAdapter |
| ollama | OllamaEmbeddingAdapter |

大部分后端走 OpenAI 兼容协议，只有 Jina/Cohere/Ollama 需要专用适配器。

#### DenseRetriever 的 FAISS 降级

`DenseRetriever`（`src/services/rag/components/retrievers/dense.py:19-201`）优先使用 FAISS 做 ANN 搜索，FAISS 不可用时降级为 numpy cosine similarity。两种路径的结果格式完全一致，上层无感知。

#### KB 配置持久化

`KnowledgeBaseConfigService`（`src/services/config/knowledge_base_config.py:28-211`）是单例服务，管理每个 KB 的 provider 和 search mode 配置。支持从 `metadata.json` 同步配置，实现配置迁移。

---

## 第 3 章 迁移指南

### 3.1 迁移清单

**阶段 1：RAG 组件化管道（核心，1 周）**

- [ ] 定义 `Component` Protocol（name + process 方法）
- [ ] 实现 `RAGPipeline` Fluent API（parser/chunker/embedder/indexer/retriever 五阶段）
- [ ] 实现 `FileTypeRouter`（按扩展名分流文件到不同解析器）
- [ ] 实现至少一个 pipeline（推荐先做 LlamaIndex 向量检索）

**阶段 2：多引擎工厂（可选，3 天）**

- [ ] 实现 `factory.py` 懒加载注册表
- [ ] 添加 LightRAG 知识图谱管道
- [ ] 添加 RAGAnything 多模态管道
- [ ] 实现 `RAGService` 统一入口（自动从 KB metadata 读取 provider）

**阶段 3：Web 搜索服务（可选，3 天）**

- [ ] 定义 `BaseSearchProvider` ABC + `WebSearchResponse` 数据类
- [ ] 实现装饰器注册机制
- [ ] 接入 2-3 个 provider（推荐 Tavily + Serper）
- [ ] 实现 `AnswerConsolidator`（至少 template 策略）

### 3.2 适配代码模板

#### 最小可用 RAG 管道

```python
"""最小可用的组件化 RAG 管道 — 可直接运行"""
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Protocol, runtime_checkable

# ── 类型定义 ──
@dataclass
class Chunk:
    content: str
    metadata: Dict[str, Any] = field(default_factory=dict)
    embedding: Optional[List[float]] = None

@dataclass
class Document:
    content: str
    file_path: str = ""
    chunks: List[Chunk] = field(default_factory=list)

# ── 组件协议 ──
@runtime_checkable
class Component(Protocol):
    name: str
    async def process(self, data: Any, **kwargs) -> Any: ...

# ── Fluent Pipeline ──
class RAGPipeline:
    def __init__(self, name: str = "default"):
        self.name = name
        self._parser = None
        self._chunkers: List[Component] = []
        self._embedder = None
        self._indexer = None
        self._retriever = None

    def parser(self, p): self._parser = p; return self
    def chunker(self, c): self._chunkers.append(c); return self
    def embedder(self, e): self._embedder = e; return self
    def indexer(self, i): self._indexer = i; return self
    def retriever(self, r): self._retriever = r; return self

    async def initialize(self, kb_name: str, file_paths: List[str]):
        docs = [await self._parser.process(p) for p in file_paths]
        for chunker in self._chunkers:
            for doc in docs:
                doc.chunks.extend(await chunker.process(doc))
        if self._embedder:
            for doc in docs:
                await self._embedder.process(doc)
        if self._indexer:
            await self._indexer.process(kb_name, docs)
        return True

    async def search(self, query: str, kb_name: str, **kwargs):
        return await self._retriever.process(query, kb_name=kb_name, **kwargs)
```

#### 最小可用搜索 Provider 注册

```python
"""搜索 Provider 注册机制 — 可直接运行"""
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any, Dict, List, Type

@dataclass
class SearchResult:
    title: str
    url: str
    snippet: str
    score: float = 0.0

@dataclass
class WebSearchResponse:
    query: str
    answer: str
    provider: str
    results: List[SearchResult] = field(default_factory=list)

# Provider 注册表
_PROVIDERS: Dict[str, Type] = {}

def register_provider(name: str):
    def decorator(cls):
        _PROVIDERS[name.lower()] = cls
        return cls
    return decorator

def get_provider(name: str, **kwargs):
    if name not in _PROVIDERS:
        raise ValueError(f"Unknown: {name}. Available: {list(_PROVIDERS.keys())}")
    return _PROVIDERS[name](**kwargs)

class BaseSearchProvider(ABC):
    name: str = "base"
    supports_answer: bool = False

    @abstractmethod
    def search(self, query: str, **kwargs) -> WebSearchResponse: ...

# 使用示例
@register_provider("tavily")
class TavilyProvider(BaseSearchProvider):
    name = "tavily"
    supports_answer = True

    def search(self, query: str, **kwargs) -> WebSearchResponse:
        # 调用 Tavily API ...
        return WebSearchResponse(query=query, answer="...", provider="tavily")
```

### 3.3 适用场景

| 场景 | 适用度 | 说明 |
|------|--------|------|
| 学术辅导 / 教材问答 | ⭐⭐⭐ | 三引擎覆盖文本/图谱/多模态，ArXiv 搜索加持 |
| 企业知识库 | ⭐⭐⭐ | 组件化管道可按需裁剪，KB 配置持久化支持多租户 |
| 多源信息聚合 | ⭐⭐⭐ | 6 个 Web 搜索 provider + 结果整合层 |
| 简单 QA 机器人 | ⭐⭐ | 架构偏重，简单场景用 LlamaIndex 单管道即可 |
| 实时搜索引擎 | ⭐ | RAG 初始化较慢，不适合实时索引场景 |

---

## 第 4 章 测试用例

```python
"""基于 DeepTutor 真实接口的测试用例"""
import pytest
from unittest.mock import AsyncMock, MagicMock, patch
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

# ── 测试 RAG 工厂 ──

class TestRAGFactory:
    def test_get_pipeline_returns_correct_type(self):
        """验证工厂返回正确的 pipeline 类型"""
        from src.services.rag.factory import get_pipeline, _init_pipelines
        _init_pipelines()
        # 测试 llamaindex pipeline
        pipeline = get_pipeline("llamaindex")
        assert hasattr(pipeline, "initialize")
        assert hasattr(pipeline, "search")

    def test_get_pipeline_unknown_raises(self):
        """未知 pipeline 名应抛出 ValueError"""
        from src.services.rag.factory import get_pipeline
        with pytest.raises(ValueError, match="Unknown pipeline"):
            get_pipeline("nonexistent")

    def test_lazy_loading_no_import_at_module_level(self):
        """验证懒加载：模块导入时不触发重依赖"""
        import importlib
        # 重新导入 factory 不应触发 lightrag/llama_index 导入
        mod = importlib.import_module("src.services.rag.factory")
        assert mod._PIPELINES_INITIALIZED is False or len(mod._PIPELINES) >= 0

    def test_register_custom_pipeline(self):
        """验证自定义 pipeline 注册"""
        from src.services.rag.factory import register_pipeline, has_pipeline
        register_pipeline("test_custom", lambda **kw: MagicMock())
        assert has_pipeline("test_custom")


# ── 测试文件类型路由 ──

class TestFileTypeRouter:
    def test_pdf_routes_to_mineru(self):
        from src.services.rag.components.routing import FileTypeRouter
        result = FileTypeRouter.classify_files(["doc.pdf"])
        assert result.needs_mineru == ["doc.pdf"]
        assert result.text_files == []

    def test_text_files_fast_path(self):
        from src.services.rag.components.routing import FileTypeRouter
        result = FileTypeRouter.classify_files(["readme.md", "code.py", "data.json"])
        assert len(result.text_files) == 3
        assert result.needs_mineru == []

    def test_mixed_classification(self):
        from src.services.rag.components.routing import FileTypeRouter
        files = ["paper.pdf", "notes.txt", "image.png", "unknown.xyz"]
        result = FileTypeRouter.classify_files(files)
        assert "paper.pdf" in result.needs_mineru
        assert "notes.txt" in result.text_files
        assert "image.png" in result.needs_mineru  # 图片走 MinerU


# ── 测试搜索 Provider 注册 ──

class TestSearchProviderRegistry:
    def test_list_providers_includes_all(self):
        from src.services.search.providers import list_providers
        providers = list_providers()
        assert "tavily" in providers
        assert "serper" in providers

    def test_get_unknown_provider_raises(self):
        from src.services.search.providers import get_provider
        with pytest.raises(ValueError, match="Unknown provider"):
            get_provider("nonexistent_provider")

    def test_tavily_supports_answer(self):
        """Tavily 是 AI provider，应标记 supports_answer=True"""
        from src.services.search.providers.tavily import TavilyProvider
        assert TavilyProvider.supports_answer is True

    def test_serper_no_answer(self):
        """Serper 是 SERP provider，不自带 answer"""
        from src.services.search.providers.serper import SerperProvider
        assert SerperProvider.supports_answer is False


# ── 测试 DenseRetriever 降级 ──

class TestDenseRetrieverDegradation:
    def test_faiss_fallback_to_cosine(self):
        """FAISS 不可用时应降级为 cosine similarity"""
        with patch.dict("sys.modules", {"faiss": None}):
            from src.services.rag.components.retrievers.dense import DenseRetriever
            retriever = DenseRetriever.__new__(DenseRetriever)
            retriever.use_faiss = False
            assert retriever.use_faiss is False
```

---

## 第 5 章 跨域关联

| 关联域 | 关系类型 | 说明 |
|--------|----------|------|
| PD-01 上下文管理 | 协同 | RAG 检索结果需要注入 LLM 上下文窗口，SemanticChunker 的 chunk_size=1000 直接影响上下文占用 |
| PD-02 多 Agent 编排 | 协同 | ResearchAgent/SolveAgent/GuideAgent 各自调用 rag_tool 和 web_search，编排层决定何时触发检索 |
| PD-04 工具系统 | 依赖 | rag_tool.py / web_search.py / paper_search_tool.py 是 Agent 的工具定义，检索能力通过工具系统暴露 |
| PD-06 记忆持久化 | 协同 | KB 配置通过 KnowledgeBaseConfigService 持久化，metadata.json 记录每个 KB 的 provider 选择 |
| PD-11 可观测性 | 协同 | LightRAGLogContext 将 RAG 内部日志转发到统一日志系统，支持按 scene 过滤 |

---

## 第 6 章 来源文件索引

| 文件 | 行范围 | 关键实现 |
|------|--------|----------|
| `src/services/rag/factory.py` | L20-63 | RAG 工厂懒加载注册表 |
| `src/services/rag/pipeline.py` | L26-217 | Fluent API 组装五阶段管道 |
| `src/services/rag/service.py` | L25-238 | RAGService 统一入口 |
| `src/services/rag/types.py` | L1-75 | Chunk/Document/SearchResult 数据类 |
| `src/services/rag/components/base.py` | L1-61 | Component Protocol + BaseComponent |
| `src/services/rag/components/routing.py` | L47-335 | FileTypeRouter 文件分流 |
| `src/services/rag/components/chunkers/semantic.py` | L15-98 | SemanticChunker 语义分块 |
| `src/services/rag/components/retrievers/dense.py` | L19-201 | DenseRetriever FAISS/cosine 双路径 |
| `src/services/rag/components/retrievers/hybrid.py` | L16-126 | HybridRetriever RAGAnything 混合检索 |
| `src/services/rag/components/retrievers/lightrag.py` | L16-131 | LightRAGRetriever 知识图谱检索 |
| `src/services/rag/components/indexers/vector.py` | L22-148 | VectorIndexer FAISS 索引构建 |
| `src/services/rag/components/indexers/graph.py` | L17-134 | GraphIndexer 知识图谱构建 |
| `src/services/rag/components/indexers/lightrag.py` | L17-118 | LightRAGIndexer 纯文本图谱 |
| `src/services/rag/pipelines/llamaindex.py` | L84-413 | LlamaIndex 向量管道 |
| `src/services/rag/pipelines/lightrag.py` | L18-44 | LightRAG 管道组装 |
| `src/services/rag/pipelines/raganything.py` | L21-352 | RAGAnything 多模态管道 |
| `src/services/search/__init__.py` | L92-218 | web_search() 统一入口 |
| `src/services/search/base.py` | L21-88 | BaseSearchProvider ABC |
| `src/services/search/types.py` | L1-116 | WebSearchResponse/Citation/SearchResult |
| `src/services/search/consolidation.py` | L143-396 | AnswerConsolidator 模板+LLM 整合 |
| `src/services/search/providers/__init__.py` | L16-130 | 装饰器注册 + 自动导入 |
| `src/services/search/providers/tavily.py` | L28-163 | Tavily provider |
| `src/services/search/providers/serper.py` | L35-211 | Serper provider（含 scholar 模式） |
| `src/services/embedding/provider.py` | L22-121 | EmbeddingProviderManager 7 种后端 |
| `src/services/config/knowledge_base_config.py` | L28-211 | KB 配置持久化服务 |
| `src/tools/rag_tool.py` | L24-174 | RAG 工具入口 |
| `src/tools/web_search.py` | L1-72 | Web 搜索工具入口 |
| `src/tools/paper_search_tool.py` | L21-172 | ArXiv 论文搜索工具 |

---

## 第 7 章 横向对比维度

```json comparison_data
{
  "project": "DeepTutor",
  "dimensions": {
    "搜索架构": "双层架构：RAG 三引擎（LlamaIndex/LightRAG/RAGAnything）+ Web 六 provider",
    "去重机制": "RAG 实例缓存（_instances dict 按 working_dir 去重），无跨 provider 结果去重",
    "结果处理": "AnswerConsolidator 双策略：Jinja2 模板渲染 + LLM 摘要合成",
    "容错策略": "FAISS→cosine 降级、ImportError 捕获、KB metadata 回退到 env var",
    "成本控制": "三引擎按速度/精度分级选择，嵌入适配器支持本地 Ollama 零成本方案",
    "检索方式": "向量（FAISS/cosine）、知识图谱（LightRAG hybrid/local/global/naive）、多模态（RAGAnything）",
    "索引结构": "FAISS IndexFlatIP + LightRAG 知识图谱 + LlamaIndex VectorStoreIndex 三种并存",
    "排序策略": "DenseRetriever cosine similarity top-k，LightRAG 内置排序，Tavily 自带 relevance score",
    "缓存机制": "RAG 实例级缓存（ClassVar dict），无查询结果缓存",
    "扩展性": "Component Protocol + 装饰器注册，新增 pipeline/provider 零修改核心代码",
    "解析容错": "FileTypeRouter 多编码尝试（UTF-8→GBK→Latin-1→replace），二进制检测跳过",
    "多模态支持": "RAGAnything 支持 PDF 图片/表格/公式提取，MinerU 解析 + 图片迁移到 canonical 路径",
    "专家知识集成": "ArXiv PaperSearchTool 学术搜索 + Serper scholar 模式 + 引用格式化"
  }
}
```

### 域元数据补充

```json domain_metadata
{
  "description": "三引擎可切换 RAG 与六源 Web 搜索的组件化架构，支持按场景选择最优检索策略",
  "sub_problems": [
    "引擎选择：不同文档类型和精度需求下如何自动选择最优 RAG 引擎",
    "组件正交：RAG 管道各阶段（解析/分块/嵌入/索引/检索）如何独立替换不互相影响",
    "嵌入后端适配：如何统一接口支持 OpenAI/Jina/Cohere/Ollama 等多种嵌入服务"
  ],
  "best_practices": [
    "工厂懒加载避免重依赖污染：闭包延迟 import，用户只装需要的 RAG 后端依赖",
    "Fluent API 组装管道比继承更灵活：跳过不需要的阶段（如 LightRAG 不需要 chunker）",
    "SERP 结果用 provider 专属 Jinja2 模板整合，AI provider 直接用自带 answer",
    "FAISS 不可用时静默降级为 numpy cosine，保持接口一致性"
  ]
}
```
