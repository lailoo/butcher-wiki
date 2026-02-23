# PD-06.02 GPT-Researcher — 研究报告缓存 + 向量索引

> 文档编号：PD-06.02
> 来源：GPT-Researcher `gpt_researcher/memory/` / `gpt_researcher/vector_store/`
> GitHub：https://github.com/assafelovic/gpt-researcher
> 问题域：PD-06 记忆持久化 Memory Persistence
> 状态：可复用方案

---

## 第 1 章 问题与动机

### 1.1 核心问题

研究型 Agent 在多轮交互中会产生大量中间结果（搜索摘要、分析报告、引用数据）。这些结果有三个结构性问题：

1. **重复研究浪费资源** — 用户问"React vs Vue 性能对比"后又问"React 渲染机制"，第二次查询与第一次有大量重叠，但 Agent 无法复用已有研究成果。
2. **跨会话知识断裂** — 上午的研究结论在下午的新会话中完全丢失，用户需要重新描述背景。
3. **语义检索缺失** — 即使缓存了历史报告，基于关键词的精确匹配无法找到语义相关的过往研究。

```
会话 1: "AI Agent 架构设计" → 生成 5000 字报告（耗时 3 分钟，$0.50）
会话 2: "多 Agent 系统的编排模式" → 从零开始研究（与会话 1 有 60% 重叠）
会话 3: "LangGraph 状态管理" → 从零开始（会话 1 已覆盖此内容）

如果有缓存 + 向量索引：
会话 2: 命中会话 1 的 60% 内容 → 只需补充 40% → 省时 1.8 分钟，省 $0.30
会话 3: 直接从缓存提取相关段落 → 省时 2.5 分钟，省 $0.45
```

### 1.2 GPT-Researcher 的解法概述

GPT-Researcher 用两层缓存机制解决上述问题：

- **报告级缓存**：完整研究报告按查询哈希存储，精确匹配时直接返回
- **向量索引**：报告内容分块后存入向量数据库，语义相似查询可检索相关片段
- **去重机制**：新研究结果与已有缓存对比，避免重复内容
- **缓存失效**：基于 TTL + 内容新鲜度评分的双重失效策略

### 1.3 设计思想

| 原则 | 含义 | 体现 |
|------|------|------|
| 两级缓存 | 精确匹配 + 语义匹配互补 | 哈希缓存命中快，向量索引覆盖广 |
| 增量积累 | 每次研究都丰富知识库 | 新报告自动入库，下次可复用 |
| 成本敏感 | 缓存命中 = 省钱 | 避免重复 LLM 调用和搜索 API 费用 |
| 透明降级 | 缓存未命中不影响功能 | 回退到正常研究流程 |

---

## 第 2 章 源码实现分析

### 2.1 Memory 架构

```
gpt_researcher/
├── memory/
│   ├── __init__.py          # Memory 接口定义
│   ├── draft.py             # 草稿记忆（当前会话内）
│   └── research.py          # 研究记忆（跨会话持久化）
├── vector_store/
│   ├── __init__.py          # VectorStore 工厂
│   ├── chromadb.py          # ChromaDB 后端
│   └── pinecone.py          # Pinecone 后端
└── context/
    └── compression.py       # 上下文压缩（与缓存配合）
```

### 2.2 报告缓存实现

```python
# 源码简化自 gpt_researcher/memory/research.py
import hashlib
import json
import time
from pathlib import Path


class ResearchMemory:
    """研究报告缓存 — 基于查询哈希的精确匹配"""

    def __init__(self, cache_dir: str = ".research_cache", ttl: int = 86400):
        self.cache_dir = Path(cache_dir)
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        self.ttl = ttl  # 默认 24 小时

    def _query_hash(self, query: str) -> str:
        """查询归一化后取哈希"""
        normalized = query.strip().lower()
        return hashlib.sha256(normalized.encode()).hexdigest()[:16]

    def get(self, query: str) -> dict | None:
        """查找缓存的研究报告"""
        key = self._query_hash(query)
        cache_file = self.cache_dir / f"{key}.json"
        if not cache_file.exists():
            return None

        data = json.loads(cache_file.read_text(encoding="utf-8"))
        # TTL 检查
        if time.time() - data["created_at"] > self.ttl:
            cache_file.unlink()
            return None

        return data

    def set(self, query: str, report: str, sources: list[dict], metadata: dict = None):
        """缓存研究报告"""
        key = self._query_hash(query)
        cache_file = self.cache_dir / f"{key}.json"
        cache_file.write_text(json.dumps({
            "query": query,
            "report": report,
            "sources": sources,
            "metadata": metadata or {},
            "created_at": time.time(),
        }, ensure_ascii=False), encoding="utf-8")
```

### 2.3 向量索引实现

```python
# 源码简化自 gpt_researcher/vector_store/chromadb.py
from typing import Protocol


class VectorStore(Protocol):
    """向量存储抽象接口"""
    async def add(self, texts: list[str], metadatas: list[dict], ids: list[str]) -> None: ...
    async def query(self, query_text: str, n_results: int) -> list[dict]: ...


class ChromaVectorStore:
    """ChromaDB 向量存储实现"""

    def __init__(self, collection_name: str = "research_reports", persist_dir: str = ".chroma_db"):
        import chromadb
        self.client = chromadb.PersistentClient(path=persist_dir)
        self.collection = self.client.get_or_create_collection(
            name=collection_name,
            metadata={"hnsw:space": "cosine"},
        )

    async def add(self, texts: list[str], metadatas: list[dict], ids: list[str]) -> None:
        """添加文本到向量索引"""
        self.collection.add(documents=texts, metadatas=metadatas, ids=ids)

    async def query(self, query_text: str, n_results: int = 5) -> list[dict]:
        """语义搜索"""
        results = self.collection.query(query_texts=[query_text], n_results=n_results)
        return [
            {
                "text": doc,
                "metadata": meta,
                "distance": dist,
            }
            for doc, meta, dist in zip(
                results["documents"][0],
                results["metadatas"][0],
                results["distances"][0],
            )
        ]
```

### 2.4 报告分块与索引

```python
# 源码简化自 gpt_researcher/memory/research.py
import uuid


class ReportIndexer:
    """将研究报告分块后存入向量索引"""

    def __init__(self, vector_store: VectorStore, chunk_size: int = 500, chunk_overlap: int = 50):
        self.vector_store = vector_store
        self.chunk_size = chunk_size
        self.chunk_overlap = chunk_overlap

    def _chunk_text(self, text: str) -> list[str]:
        """按段落 + 固定大小分块"""
        paragraphs = text.split("\n\n")
        chunks = []
        current_chunk = ""

        for para in paragraphs:
            if len(current_chunk) + len(para) > self.chunk_size:
                if current_chunk:
                    chunks.append(current_chunk.strip())
                current_chunk = para
            else:
                current_chunk += "\n\n" + para if current_chunk else para

        if current_chunk.strip():
            chunks.append(current_chunk.strip())
        return chunks

    async def index_report(self, query: str, report: str, sources: list[dict]):
        """将报告分块并索引"""
        chunks = self._chunk_text(report)
        ids = [f"{uuid.uuid4().hex[:8]}" for _ in chunks]
        metadatas = [
            {"query": query, "chunk_index": i, "total_chunks": len(chunks),
             "source_count": len(sources)}
            for i in range(len(chunks))
        ]
        await self.vector_store.add(texts=chunks, metadatas=metadatas, ids=ids)
```

### 2.5 去重机制

```python
# 源码简化自 gpt_researcher/memory/research.py
from difflib import SequenceMatcher


class ContentDeduplicator:
    """基于文本相似度的内容去重"""

    def __init__(self, similarity_threshold: float = 0.85):
        self.threshold = similarity_threshold

    def is_duplicate(self, new_text: str, existing_texts: list[str]) -> bool:
        """判断新内容是否与已有内容重复"""
        for existing in existing_texts:
            ratio = SequenceMatcher(None, new_text[:500], existing[:500]).ratio()
            if ratio >= self.threshold:
                return True
        return False

    def deduplicate_results(self, results: list[dict]) -> list[dict]:
        """对搜索结果列表去重"""
        unique = []
        seen_snippets = []
        for r in results:
            snippet = r.get("snippet", "")
            if not self.is_duplicate(snippet, seen_snippets):
                unique.append(r)
                seen_snippets.append(snippet)
        return unique
```

### 2.6 关键设计决策

| 决策 | GPT-Researcher 的选择 | 理由 |
|------|----------------------|------|
| 缓存粒度 | 完整报告 + 分块索引 | 精确匹配返回全文，语义匹配返回片段 |
| 向量后端 | ChromaDB（默认） | 零配置、本地持久化、嵌入式 |
| 分块策略 | 段落优先 + 固定大小兜底 | 保持语义完整性 |
| 去重算法 | SequenceMatcher | 轻量、无外部依赖 |
| 缓存失效 | TTL（24h 默认） | 研究内容有时效性 |

---

## 第 3 章 迁移指南

### 3.1 迁移检查清单

| # | 检查项 | 说明 |
|---|--------|------|
| 1 | 确定缓存存储位置 | 文件系统 / Redis / 数据库 |
| 2 | 选择向量数据库 | ChromaDB（本地）/ Pinecone（云端）/ Qdrant |
| 3 | 配置 embedding 模型 | OpenAI text-embedding-3-small 或本地模型 |
| 4 | 设置 TTL 策略 | 根据内容时效性决定缓存有效期 |
| 5 | 实现分块策略 | 段落分块 / 固定大小 / 语义分块 |
| 6 | 测试缓存命中率 | 监控命中/未命中比例，调优阈值 |

### 3.2 通用研究缓存管理器

```python
"""research_cache.py — 通用研究报告缓存管理器"""
from __future__ import annotations
import hashlib
import json
import time
import logging
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Protocol

logger = logging.getLogger(__name__)


class VectorStoreProtocol(Protocol):
    """向量存储协议"""
    async def add(self, texts: list[str], metadatas: list[dict], ids: list[str]) -> None: ...
    async def query(self, query_text: str, n_results: int) -> list[dict]: ...


@dataclass
class CacheConfig:
    """缓存配置"""
    cache_dir: str = ".research_cache"
    ttl_seconds: int = 86400           # 24 小时
    vector_similarity_threshold: float = 0.8
    chunk_size: int = 500
    chunk_overlap: int = 50
    max_cached_reports: int = 1000     # 最大缓存报告数


class ResearchCacheManager:
    """两级缓存：精确匹配 + 向量语义检索"""

    def __init__(
        self,
        config: CacheConfig | None = None,
        vector_store: VectorStoreProtocol | None = None,
    ):
        self.config = config or CacheConfig()
        self.vector_store = vector_store
        self._cache_dir = Path(self.config.cache_dir)
        self._cache_dir.mkdir(parents=True, exist_ok=True)

    def _query_hash(self, query: str) -> str:
        normalized = query.strip().lower()
        return hashlib.sha256(normalized.encode()).hexdigest()[:16]

    # --- Level 1: 精确匹配缓存 ---

    def get_exact(self, query: str) -> dict | None:
        """精确匹配：查询哈希命中"""
        key = self._query_hash(query)
        cache_file = self._cache_dir / f"{key}.json"
        if not cache_file.exists():
            return None
        try:
            data = json.loads(cache_file.read_text(encoding="utf-8"))
            if time.time() - data.get("created_at", 0) > self.config.ttl_seconds:
                cache_file.unlink()
                logger.info(f"Cache expired for query: {query[:50]}...")
                return None
            logger.info(f"Cache hit (exact) for query: {query[:50]}...")
            return data
        except (json.JSONDecodeError, KeyError):
            cache_file.unlink(missing_ok=True)
            return None

    def save_report(self, query: str, report: str, sources: list[dict],
                    metadata: dict | None = None) -> str:
        """保存研究报告到缓存"""
        key = self._query_hash(query)
        cache_file = self._cache_dir / f"{key}.json"
        data = {
            "query": query,
            "report": report,
            "sources": sources,
            "metadata": metadata or {},
            "created_at": time.time(),
            "cache_key": key,
        }
        cache_file.write_text(
            json.dumps(data, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        logger.info(f"Report cached: {key} for query: {query[:50]}...")
        return key

    # --- Level 2: 向量语义检索 ---

    async def get_semantic(self, query: str, n_results: int = 5) -> list[dict]:
        """语义匹配：从向量索引检索相关片段"""
        if self.vector_store is None:
            return []
        try:
            results = await self.vector_store.query(query, n_results=n_results)
            # 过滤低相似度结果
            filtered = [
                r for r in results
                if r.get("distance", 1.0) <= (1.0 - self.config.vector_similarity_threshold)
            ]
            logger.info(f"Semantic search: {len(filtered)}/{len(results)} results above threshold")
            return filtered
        except Exception as e:
            logger.warning(f"Vector search failed: {e}")
            return []

    async def index_report(self, query: str, report: str, sources: list[dict]):
        """将报告分块后存入向量索引"""
        if self.vector_store is None:
            return
        chunks = self._chunk_text(report)
        if not chunks:
            return
        import uuid
        ids = [uuid.uuid4().hex[:12] for _ in chunks]
        metadatas = [
            {"query": query, "chunk_index": i, "source_count": len(sources)}
            for i in range(len(chunks))
        ]
        await self.vector_store.add(texts=chunks, metadatas=metadatas, ids=ids)
        logger.info(f"Indexed {len(chunks)} chunks for query: {query[:50]}...")

    def _chunk_text(self, text: str) -> list[str]:
        """段落优先分块"""
        paragraphs = text.split("\n\n")
        chunks, current = [], ""
        for para in paragraphs:
            if len(current) + len(para) > self.config.chunk_size:
                if current:
                    chunks.append(current.strip())
                current = para
            else:
                current += ("\n\n" + para) if current else para
        if current.strip():
            chunks.append(current.strip())
        return chunks

    # --- 缓存管理 ---

    def clear_expired(self) -> int:
        """清理过期缓存，返回清理数量"""
        count = 0
        for f in self._cache_dir.glob("*.json"):
            try:
                data = json.loads(f.read_text(encoding="utf-8"))
                if time.time() - data.get("created_at", 0) > self.config.ttl_seconds:
                    f.unlink()
                    count += 1
            except Exception:
                f.unlink(missing_ok=True)
                count += 1
        return count

    def cache_stats(self) -> dict:
        """缓存统计信息"""
        files = list(self._cache_dir.glob("*.json"))
        total_size = sum(f.stat().st_size for f in files)
        return {
            "total_reports": len(files),
            "total_size_mb": round(total_size / 1024 / 1024, 2),
            "cache_dir": str(self._cache_dir),
        }
```

### 3.3 场景适配矩阵

| 场景 | 缓存策略 | 向量索引 | TTL | 说明 |
|------|----------|----------|-----|------|
| 个人研究助手 | 文件系统 | ChromaDB 本地 | 7 天 | 低成本，本地运行 |
| 团队知识库 | Redis | Qdrant/Pinecone | 30 天 | 多用户共享缓存 |
| 实时新闻分析 | 文件系统 | 可选 | 1 小时 | 内容时效性强 |
| 学术研究 | 数据库 | ChromaDB | 90 天 | 研究成果长期有效 |
| 客服知识库 | Redis | Pinecone | 永久 | FAQ 类内容不过期 |

### 3.4 缓存失效策略

```python
"""cache_invalidation.py — 缓存失效策略"""
from dataclasses import dataclass
from enum import Enum


class InvalidationStrategy(Enum):
    TTL = "ttl"                    # 基于时间
    FRESHNESS = "freshness"        # 基于内容新鲜度
    HYBRID = "hybrid"              # TTL + 新鲜度组合


@dataclass
class InvalidationConfig:
    strategy: InvalidationStrategy = InvalidationStrategy.HYBRID
    ttl_seconds: int = 86400
    freshness_check_interval: int = 3600  # 每小时检查一次新鲜度
    max_stale_ratio: float = 0.3          # 超过 30% 内容过时则失效


class CacheInvalidator:
    """缓存失效判断器"""

    def __init__(self, config: InvalidationConfig | None = None):
        self.config = config or InvalidationConfig()

    def should_invalidate(self, cache_entry: dict, current_time: float) -> bool:
        """判断缓存条目是否应失效"""
        created_at = cache_entry.get("created_at", 0)
        age = current_time - created_at

        if self.config.strategy == InvalidationStrategy.TTL:
            return age > self.config.ttl_seconds

        if self.config.strategy == InvalidationStrategy.FRESHNESS:
            stale_ratio = cache_entry.get("metadata", {}).get("stale_ratio", 0)
            return stale_ratio > self.config.max_stale_ratio

        # HYBRID: TTL 或新鲜度任一触发
        if age > self.config.ttl_seconds:
            return True
        stale_ratio = cache_entry.get("metadata", {}).get("stale_ratio", 0)
        return stale_ratio > self.config.max_stale_ratio
```

---

## 第 4 章 测试用例

```python
"""test_research_cache.py — 研究报告缓存完整测试套件"""
import json
import time
import pytest
from unittest.mock import AsyncMock, MagicMock
from pathlib import Path


# === 4.1 精确匹配缓存测试 ===

class TestExactCache:
    """报告级精确匹配缓存测试"""

    def test_cache_miss_returns_none(self, tmp_path):
        """未缓存的查询应返回 None"""
        config = CacheConfig(cache_dir=str(tmp_path))
        mgr = ResearchCacheManager(config=config)
        assert mgr.get_exact("unknown query") is None

    def test_cache_hit_returns_report(self, tmp_path):
        """缓存命中应返回完整报告"""
        config = CacheConfig(cache_dir=str(tmp_path))
        mgr = ResearchCacheManager(config=config)

        mgr.save_report("AI Agent 架构", "这是一份研究报告...", [{"url": "https://example.com"}])
        result = mgr.get_exact("AI Agent 架构")

        assert result is not None
        assert result["report"] == "这是一份研究报告..."
        assert len(result["sources"]) == 1

    def test_cache_case_insensitive(self, tmp_path):
        """查询匹配应忽略大小写"""
        config = CacheConfig(cache_dir=str(tmp_path))
        mgr = ResearchCacheManager(config=config)

        mgr.save_report("React Performance", "report content", [])
        assert mgr.get_exact("react performance") is not None

    def test_cache_ignores_whitespace(self, tmp_path):
        """查询匹配应忽略首尾空白"""
        config = CacheConfig(cache_dir=str(tmp_path))
        mgr = ResearchCacheManager(config=config)

        mgr.save_report("test query", "report", [])
        assert mgr.get_exact("  test query  ") is not None

    def test_expired_cache_returns_none(self, tmp_path):
        """过期缓存应返回 None"""
        config = CacheConfig(cache_dir=str(tmp_path), ttl_seconds=0)
        mgr = ResearchCacheManager(config=config)

        mgr.save_report("test", "report", [])
        time.sleep(0.01)
        assert mgr.get_exact("test") is None

    def test_corrupted_cache_file_handled(self, tmp_path):
        """损坏的缓存文件应被清理"""
        config = CacheConfig(cache_dir=str(tmp_path))
        mgr = ResearchCacheManager(config=config)

        # 写入损坏的 JSON
        key = mgr._query_hash("test")
        (tmp_path / f"{key}.json").write_text("not valid json")

        assert mgr.get_exact("test") is None
        assert not (tmp_path / f"{key}.json").exists()  # 文件已清理


# === 4.2 向量语义检索测试 ===

class TestSemanticSearch:
    """向量索引语义检索测试"""

    @pytest.mark.asyncio
    async def test_semantic_search_returns_results(self, tmp_path):
        """语义搜索应返回相关片段"""
        mock_store = AsyncMock()
        mock_store.query = AsyncMock(return_value=[
            {"text": "相关内容", "metadata": {"query": "AI"}, "distance": 0.1},
        ])
        config = CacheConfig(cache_dir=str(tmp_path), vector_similarity_threshold=0.8)
        mgr = ResearchCacheManager(config=config, vector_store=mock_store)

        results = await mgr.get_semantic("AI Agent")
        assert len(results) == 1

    @pytest.mark.asyncio
    async def test_semantic_search_filters_low_similarity(self, tmp_path):
        """低相似度结果应被过滤"""
        mock_store = AsyncMock()
        mock_store.query = AsyncMock(return_value=[
            {"text": "不相关", "metadata": {}, "distance": 0.9},  # 低相似度
        ])
        config = CacheConfig(cache_dir=str(tmp_path), vector_similarity_threshold=0.8)
        mgr = ResearchCacheManager(config=config, vector_store=mock_store)

        results = await mgr.get_semantic("test")
        assert len(results) == 0

    @pytest.mark.asyncio
    async def test_no_vector_store_returns_empty(self, tmp_path):
        """没有向量存储时应返回空列表"""
        config = CacheConfig(cache_dir=str(tmp_path))
        mgr = ResearchCacheManager(config=config, vector_store=None)

        results = await mgr.get_semantic("test")
        assert results == []

    @pytest.mark.asyncio
    async def test_vector_store_error_returns_empty(self, tmp_path):
        """向量存储异常时应降级返回空列表"""
        mock_store = AsyncMock()
        mock_store.query = AsyncMock(side_effect=ConnectionError("DB down"))
        config = CacheConfig(cache_dir=str(tmp_path))
        mgr = ResearchCacheManager(config=config, vector_store=mock_store)

        results = await mgr.get_semantic("test")
        assert results == []


# === 4.3 报告索引测试 ===

class TestReportIndexing:
    """报告分块与索引测试"""

    @pytest.mark.asyncio
    async def test_index_report_chunks_text(self, tmp_path):
        """报告应被分块后索引"""
        mock_store = AsyncMock()
        config = CacheConfig(cache_dir=str(tmp_path), chunk_size=50)
        mgr = ResearchCacheManager(config=config, vector_store=mock_store)

        long_report = "第一段内容。\n\n第二段内容，比较长的段落。\n\n第三段内容。"
        await mgr.index_report("test", long_report, [])

        mock_store.add.assert_called_once()
        call_args = mock_store.add.call_args
        assert len(call_args.kwargs.get("texts", call_args[1].get("texts", []))) >= 1

    @pytest.mark.asyncio
    async def test_index_skipped_without_vector_store(self, tmp_path):
        """没有向量存储时索引应跳过"""
        config = CacheConfig(cache_dir=str(tmp_path))
        mgr = ResearchCacheManager(config=config, vector_store=None)
        # 不应抛出异常
        await mgr.index_report("test", "report content", [])


# === 4.4 缓存管理测试 ===

class TestCacheManagement:
    """缓存清理与统计测试"""

    def test_clear_expired(self, tmp_path):
        """应清理过期缓存"""
        config = CacheConfig(cache_dir=str(tmp_path), ttl_seconds=0)
        mgr = ResearchCacheManager(config=config)

        mgr.save_report("q1", "r1", [])
        mgr.save_report("q2", "r2", [])
        time.sleep(0.01)

        cleared = mgr.clear_expired()
        assert cleared == 2

    def test_cache_stats(self, tmp_path):
        """应返回正确的缓存统计"""
        config = CacheConfig(cache_dir=str(tmp_path))
        mgr = ResearchCacheManager(config=config)

        mgr.save_report("q1", "report 1", [])
        mgr.save_report("q2", "report 2", [])

        stats = mgr.cache_stats()
        assert stats["total_reports"] == 2
        assert stats["total_size_mb"] > 0


# === 4.5 去重测试 ===

class TestDeduplication:
    """内容去重测试"""

    def test_duplicate_detected(self):
        """高相似度内容应被识别为重复"""
        dedup = ContentDeduplicator(similarity_threshold=0.85)
        assert dedup.is_duplicate(
            "React 是一个用于构建用户界面的 JavaScript 库",
            ["React 是一个用于构建用户界面的 JavaScript 框架"],
        )

    def test_unique_content_not_flagged(self):
        """不同内容不应被标记为重复"""
        dedup = ContentDeduplicator(similarity_threshold=0.85)
        assert not dedup.is_duplicate(
            "Python 是一种编程语言",
            ["React 是一个 JavaScript 库"],
        )

    def test_deduplicate_results(self):
        """结果列表去重应保留唯一条目"""
        dedup = ContentDeduplicator(similarity_threshold=0.85)
        results = [
            {"snippet": "React 性能优化指南"},
            {"snippet": "React 性能优化指南详解"},  # 与第一条高度相似
            {"snippet": "Vue 组件设计模式"},
        ]
        unique = dedup.deduplicate_results(results)
        assert len(unique) == 2


# === 4.6 缓存失效策略测试 ===

class TestCacheInvalidation:
    """缓存失效策略测试"""

    def test_ttl_invalidation(self):
        """TTL 策略：超时应失效"""
        config = InvalidationConfig(strategy=InvalidationStrategy.TTL, ttl_seconds=3600)
        inv = CacheInvalidator(config)
        entry = {"created_at": time.time() - 7200}  # 2 小时前
        assert inv.should_invalidate(entry, time.time())

    def test_ttl_still_valid(self):
        """TTL 策略：未超时应有效"""
        config = InvalidationConfig(strategy=InvalidationStrategy.TTL, ttl_seconds=3600)
        inv = CacheInvalidator(config)
        entry = {"created_at": time.time() - 1800}  # 30 分钟前
        assert not inv.should_invalidate(entry, time.time())

    def test_freshness_invalidation(self):
        """新鲜度策略：过时比例超阈值应失效"""
        config = InvalidationConfig(
            strategy=InvalidationStrategy.FRESHNESS, max_stale_ratio=0.3
        )
        inv = CacheInvalidator(config)
        entry = {"created_at": time.time(), "metadata": {"stale_ratio": 0.5}}
        assert inv.should_invalidate(entry, time.time())

    def test_hybrid_ttl_triggers(self):
        """混合策略：TTL 超时即失效"""
        config = InvalidationConfig(strategy=InvalidationStrategy.HYBRID, ttl_seconds=100)
        inv = CacheInvalidator(config)
        entry = {"created_at": time.time() - 200, "metadata": {"stale_ratio": 0.0}}
        assert inv.should_invalidate(entry, time.time())
```

---

## 第 5 章 跨域关联

| 关联域 | 关系 | 说明 |
|--------|------|------|
| PD-01 上下文管理 | 输入 | 缓存的报告片段作为上下文注入 LLM |
| PD-06.01 Checkpoint 持久化 | 互补 | Checkpoint 保存执行状态，本方案保存研究成果 |
| PD-07 质量检查 | 下游 | 缓存命中的报告仍需质量检查（可能过时） |
| PD-08 搜索与检索 | 上游 | 搜索结果是缓存的输入源 |
| PD-11 可观测性 | 监控 | 缓存命中率、存储大小需要追踪 |
| PD-03 容错与重试 | 降级 | 搜索失败时可降级到缓存结果 |

---

## 第 6 章 来源文件索引

| 编号 | 文件 | 说明 |
|------|------|------|
| S1 | `gpt_researcher/memory/` | Memory 模块目录 |
| S2 | `gpt_researcher/memory/research.py` | 研究报告缓存实现 |
| S3 | `gpt_researcher/memory/draft.py` | 会话内草稿记忆 |
| S4 | `gpt_researcher/vector_store/` | 向量存储适配器目录 |
| S5 | `gpt_researcher/vector_store/chromadb.py` | ChromaDB 后端实现 |
| S6 | `gpt_researcher/context/compression.py` | 上下文压缩（与缓存配合） |