# PD-03.03 GPT-Researcher — 搜索源降级 + 结果缓存

> 文档编号：PD-03.03
> 来源：GPT-Researcher `gpt_researcher/retrievers/` / `gpt_researcher/master/agent.py`
> GitHub：https://github.com/assafelovic/gpt-researcher
> 问题域：PD-03 容错与重试 Fault Tolerance & Retry
> 状态：可复用方案

---

## 第 1 章 问题与动机

### 1.1 核心问题

搜索 API 是 Agent 系统中最不稳定的外部依赖：

- **Tavily**：偶尔 500 错误，rate limit 严格
- **Google Custom Search**：每日配额限制（100 次/天免费）
- **Bing**：区域限制，某些地区不可用
- **SearXNG**：自托管实例可能宕机

当主搜索源不可用时，Agent 不应该直接失败，而应该：
1. 自动切换到备选搜索源（降级）
2. 如果所有源都不可用，返回缓存结果（兜底）
3. 记录降级事件，便于后续分析

### 1.2 GPT-Researcher 的解法概述

GPT-Researcher 通过三层机制实现搜索容错：

- **多源并行 + 单源失败隔离**：`asyncio.gather(return_exceptions=True)` 确保单源失败不阻塞
- **搜索源优先级链**：配置搜索源优先级，高优先级失败时自动降级到低优先级
- **结果缓存**：相同查询的结果缓存到本地，避免重复调用

### 1.3 设计思想

| 原则 | 说明 |
|------|------|
| 多源冗余 | 不依赖单一搜索源，多源互为备份 |
| 优雅降级 | 主源失败 → 备源 → 缓存 → 空结果，逐级降级 |
| 失败隔离 | 单源失败不影响其他源的执行 |
| 透明缓存 | 调用方无需感知缓存逻辑 |
| 成本控制 | 缓存减少重复 API 调用 |

---

## 第 2 章 源码实现分析

### 2.1 搜索源失败隔离

```python
# 源码简化自 gpt_researcher/master/agent.py
async def _search_all_sources(self, query: str) -> list[dict]:
    """并行查询所有搜索源，单源失败不影响其他源"""
    retrievers = [cls(query) for cls in self.configured_retrievers]

    results_per_source = await asyncio.gather(
        *[r.search(max_results=self.max_results) for r in retrievers],
        return_exceptions=True,  # 关键：异常作为返回值而非抛出
    )

    all_results = []
    for source, results in zip(retrievers, results_per_source):
        if isinstance(results, Exception):
            logger.warning(f"搜索源 {source.__class__.__name__} 失败: {results}")
            continue  # 跳过失败源
        all_results.extend(results)

    return all_results
```

### 2.2 搜索源配置与优先级

```python
# 源码简化自 gpt_researcher 配置
RETRIEVER_PRIORITY = {
    "tavily": 1,      # 最高优先级：结构化摘要，质量最好
    "google": 2,      # 次优先级：覆盖面广
    "bing": 3,        # 第三优先级：某些地区更好
    "duckduckgo": 4,  # 最低优先级：免费，无需 API key
    "searx": 5,       # 自托管：可用性取决于部署
}

# 配置文件中指定使用哪些搜索源
CONFIGURED_RETRIEVERS = ["tavily", "duckduckgo"]  # 默认配置
```

### 2.3 搜索源内部容错

```python
# 每个搜索源适配器内部都有 try/catch
class TavilySearch:
    async def search(self, max_results: int = 5) -> list[dict]:
        try:
            client = TavilyClient(api_key=self.api_key)
            results = await client.search(self.query, max_results=max_results)
            return self._format_results(results)
        except Exception as e:
            logger.error(f"Tavily search failed: {e}")
            return []  # 返回空列表而非抛出异常
```

### 2.4 关键设计决策

| 决策 | 选择 | 理由 |
|------|------|------|
| 失败处理 | `return_exceptions=True` | 最简单的并行容错 |
| 降级策略 | 并行执行所有源 | 不需要串行降级链，并行更快 |
| 缓存粒度 | query + source | 不同源的结果分别缓存 |
| 空结果处理 | 返回空列表 | 调用方统一处理 |

---

## 第 3 章 可复用方案设计

### 3.1 通用架构

```
查询
  │
  ▼
┌──────────────────────────────────────────┐
│        ResilientSearchOrchestrator       │
│                                          │
│  ┌──────────┐  ┌──────────┐  ┌────────┐ │
│  │ Priority │→ │ Fallback │→ │ Cache  │ │
│  │ Router   │  │ Chain    │  │ Layer  │ │
│  └──────────┘  └──────────┘  └────────┘ │
│                                          │
│  Level 1: 并行查询所有高优先级源          │
│  Level 2: 降级到低优先级源               │
│  Level 3: 返回缓存结果                   │
│  Level 4: 返回空结果                     │
└──────────────────────────────────────────┘
```

### 3.2 搜索源降级链

```python
"""resilient_search.py — 搜索源降级 + 结果缓存"""
from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import time
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)


@dataclass
class SearchResult:
    """统一搜索结果"""
    title: str
    url: str
    snippet: str
    source: str
    relevance_score: float = 0.0


class SearchSource(ABC):
    """搜索源基类"""

    @property
    @abstractmethod
    def name(self) -> str: ...

    @property
    def priority(self) -> int:
        return 10  # 默认低优先级

    @abstractmethod
    async def search(self, query: str, max_results: int = 5) -> list[SearchResult]: ...


@dataclass
class DegradationConfig:
    """降级配置"""
    timeout_per_source: float = 10.0
    enable_cache: bool = True
    cache_ttl: int = 3600
    cache_dir: str = ".search_cache"
    max_degradation_level: int = 3
    log_degradation: bool = True


class SearchCache:
    """搜索结果缓存"""

    def __init__(self, cache_dir: str = ".search_cache", ttl: int = 3600):
        self.cache_dir = Path(cache_dir)
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        self.ttl = ttl
        self._hit_count = 0
        self._miss_count = 0

    def _key(self, query: str, source: str) -> str:
        raw = f"{source}:{query.lower().strip()}"
        return hashlib.sha256(raw.encode()).hexdigest()[:16]

    def get(self, query: str, source: str = "all") -> list[dict] | None:
        key = self._key(query, source)
        path = self.cache_dir / f"{key}.json"
        if not path.exists():
            self._miss_count += 1
            return None
        data = json.loads(path.read_text())
        if time.time() - data["timestamp"] > self.ttl:
            path.unlink(missing_ok=True)
            self._miss_count += 1
            return None
        self._hit_count += 1
        return data["results"]

    def set(self, query: str, source: str, results: list[dict]):
        key = self._key(query, source)
        path = self.cache_dir / f"{key}.json"
        path.write_text(json.dumps({
            "query": query, "source": source,
            "timestamp": time.time(), "results": results,
        }, ensure_ascii=False))

    @property
    def hit_rate(self) -> float:
        total = self._hit_count + self._miss_count
        return self._hit_count / total if total > 0 else 0.0


class ResilientSearchOrchestrator:
    """带降级和缓存的搜索编排器"""

    def __init__(
        self,
        sources: list[SearchSource],
        config: DegradationConfig | None = None,
    ):
        self.sources = sorted(sources, key=lambda s: s.priority)
        self.config = config or DegradationConfig()
        self.cache = SearchCache(
            self.config.cache_dir, self.config.cache_ttl
        ) if self.config.enable_cache else None
        self._degradation_log: list[dict] = []

    async def search(self, query: str, max_results: int = 5) -> list[SearchResult]:
        """
        三级降级搜索：
        Level 1: 并行查询所有源
        Level 2: 逐个尝试备选源
        Level 3: 返回缓存结果
        """
        # Level 1: 并行查询
        results = await self._parallel_search(query, max_results)
        if results:
            self._update_cache(query, results)
            return results

        self._log_degradation(query, 1, "并行搜索无结果")

        # Level 2: 逐个降级尝试
        results = await self._sequential_fallback(query, max_results)
        if results:
            self._update_cache(query, results)
            return results

        self._log_degradation(query, 2, "所有源均失败")

        # Level 3: 缓存兜底
        if self.cache:
            cached = self.cache.get(query, "all")
            if cached:
                self._log_degradation(query, 3, "使用缓存结果")
                return [SearchResult(**r) for r in cached]

        self._log_degradation(query, 3, "无缓存可用")
        return []

    async def _parallel_search(
        self, query: str, max_results: int
    ) -> list[SearchResult]:
        """并行查询所有源"""
        tasks = [
            asyncio.wait_for(
                s.search(query, max_results),
                timeout=self.config.timeout_per_source,
            )
            for s in self.sources
        ]
        results_list = await asyncio.gather(*tasks, return_exceptions=True)

        all_results = []
        for source, results in zip(self.sources, results_list):
            if isinstance(results, Exception):
                logger.warning(f"源 {source.name} 失败: {results}")
                continue
            all_results.extend(results)
        return all_results

    async def _sequential_fallback(
        self, query: str, max_results: int
    ) -> list[SearchResult]:
        """逐个尝试每个源（串行降级）"""
        for source in self.sources:
            try:
                results = await asyncio.wait_for(
                    source.search(query, max_results),
                    timeout=self.config.timeout_per_source * 1.5,
                )
                if results:
                    logger.info(f"降级到 {source.name} 成功")
                    return results
            except Exception as e:
                logger.warning(f"降级源 {source.name} 也失败: {e}")
                continue
        return []

    def _update_cache(self, query: str, results: list[SearchResult]):
        if self.cache:
            self.cache.set(query, "all", [
                {"title": r.title, "url": r.url,
                 "snippet": r.snippet, "source": r.source}
                for r in results
            ])

    def _log_degradation(self, query: str, level: int, reason: str):
        entry = {
            "query": query, "level": level,
            "reason": reason, "timestamp": time.time(),
        }
        self._degradation_log.append(entry)
        if self.config.log_degradation:
            logger.warning(f"降级 Level {level}: {reason} (query={query[:50]})")

    def get_degradation_stats(self) -> dict:
        """获取降级统计"""
        if not self._degradation_log:
            return {"total_degradations": 0}
        by_level = {}
        for entry in self._degradation_log:
            level = entry["level"]
            by_level[level] = by_level.get(level, 0) + 1
        return {
            "total_degradations": len(self._degradation_log),
            "by_level": by_level,
            "cache_hit_rate": self.cache.hit_rate if self.cache else 0.0,
        }
```

### 3.3 配置参数

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `timeout_per_source` | 10.0s | 单源超时 |
| `enable_cache` | True | 是否启用缓存 |
| `cache_ttl` | 3600s | 缓存有效期 |
| `cache_dir` | ".search_cache" | 缓存目录 |
| `max_degradation_level` | 3 | 最大降级层级 |

---

## 第 4 章 测试用例

```python
"""test_resilient_search.py — 搜索降级与缓存测试"""
import asyncio
import pytest
import time
from unittest.mock import AsyncMock


# === Mock 搜索源 ===

class MockSource(SearchSource):
    def __init__(self, source_name: str, results=None,
                 should_fail=False, delay=0.0, prio=5):
        self._name = source_name
        self._results = results or []
        self._should_fail = should_fail
        self._delay = delay
        self._priority = prio

    @property
    def name(self): return self._name

    @property
    def priority(self): return self._priority

    async def search(self, query, max_results=5):
        if self._delay:
            await asyncio.sleep(self._delay)
        if self._should_fail:
            raise ConnectionError(f"{self._name} 不可用")
        return self._results[:max_results]


def make_result(title, url, source="mock"):
    return SearchResult(title=title, url=url, snippet=f"snippet", source=source)


# === 降级测试 ===

class TestDegradation:

    @pytest.mark.asyncio
    async def test_all_sources_ok(self):
        """所有源正常时返回合并结果"""
        s1 = MockSource("a", [make_result("A1", "http://a.com", "a")])
        s2 = MockSource("b", [make_result("B1", "http://b.com", "b")])
        orch = ResilientSearchOrchestrator(
            sources=[s1, s2],
            config=DegradationConfig(enable_cache=False),
        )
        results = await orch.search("test")
        assert len(results) == 2

    @pytest.mark.asyncio
    async def test_one_source_fails(self):
        """单源失败时其他源结果仍返回"""
        s_ok = MockSource("ok", [make_result("OK", "http://ok.com")])
        s_fail = MockSource("fail", should_fail=True)
        orch = ResilientSearchOrchestrator(
            sources=[s_ok, s_fail],
            config=DegradationConfig(enable_cache=False),
        )
        results = await orch.search("test")
        assert len(results) == 1

    @pytest.mark.asyncio
    async def test_all_parallel_fail_triggers_sequential(self):
        """并行全失败时触发串行降级"""
        call_count = {"value": 0}

        class FlakySource(SearchSource):
            @property
            def name(self): return "flaky"
            @property
            def priority(self): return 1
            async def search(self, query, max_results=5):
                call_count["value"] += 1
                if call_count["value"] <= 1:
                    raise ConnectionError("first fail")
                return [make_result("Recovered", "http://r.com")]

        orch = ResilientSearchOrchestrator(
            sources=[FlakySource()],
            config=DegradationConfig(enable_cache=False),
        )
        results = await orch.search("test")
        assert len(results) == 1

    @pytest.mark.asyncio
    async def test_timeout_source_skipped(self):
        """超时源被跳过"""
        s_slow = MockSource("slow", [make_result("S", "http://s.com")], delay=5.0)
        s_fast = MockSource("fast", [make_result("F", "http://f.com")])
        orch = ResilientSearchOrchestrator(
            sources=[s_slow, s_fast],
            config=DegradationConfig(timeout_per_source=0.1, enable_cache=False),
        )
        results = await orch.search("test")
        assert len(results) == 1
        assert results[0].source == "mock"


# === 缓存测试 ===

class TestSearchCache:

    def test_cache_miss(self, tmp_path):
        cache = SearchCache(str(tmp_path), ttl=3600)
        assert cache.get("unknown", "tavily") is None

    def test_cache_hit(self, tmp_path):
        cache = SearchCache(str(tmp_path), ttl=3600)
        data = [{"title": "T", "url": "http://t.com", "snippet": "s", "source": "t"}]
        cache.set("test", "tavily", data)
        assert cache.get("test", "tavily") == data

    def test_cache_expiry(self, tmp_path):
        cache = SearchCache(str(tmp_path), ttl=0)
        cache.set("test", "tavily", [{"title": "T"}])
        time.sleep(0.01)
        assert cache.get("test", "tavily") is None

    def test_hit_rate(self, tmp_path):
        cache = SearchCache(str(tmp_path), ttl=3600)
        cache.set("q1", "s", [{"title": "T"}])
        cache.get("q1", "s")  # hit
        cache.get("q2", "s")  # miss
        assert cache.hit_rate == 0.5

    @pytest.mark.asyncio
    async def test_cache_fallback(self, tmp_path):
        """所有源失败时返回缓存"""
        s_fail = MockSource("fail", should_fail=True)
        config = DegradationConfig(
            enable_cache=True, cache_dir=str(tmp_path),
        )
        orch = ResilientSearchOrchestrator(sources=[s_fail], config=config)

        # 预填充缓存
        orch.cache.set("test query", "all", [
            {"title": "Cached", "url": "http://c.com",
             "snippet": "cached", "source": "cache"}
        ])

        results = await orch.search("test query")
        assert len(results) == 1
        assert results[0].title == "Cached"


# === 降级统计测试 ===

class TestDegradationStats:

    @pytest.mark.asyncio
    async def test_stats_tracking(self):
        """降级事件应被记录"""
        s_fail = MockSource("fail", should_fail=True)
        orch = ResilientSearchOrchestrator(
            sources=[s_fail],
            config=DegradationConfig(enable_cache=False),
        )
        await orch.search("test")
        stats = orch.get_degradation_stats()
        assert stats["total_degradations"] > 0

    @pytest.mark.asyncio
    async def test_no_degradation_when_ok(self):
        """正常搜索不应有降级记录"""
        s_ok = MockSource("ok", [make_result("OK", "http://ok.com")])
        orch = ResilientSearchOrchestrator(
            sources=[s_ok],
            config=DegradationConfig(enable_cache=False),
        )
        await orch.search("test")
        stats = orch.get_degradation_stats()
        assert stats["total_degradations"] == 0
```

---

## 第 5 章 跨域关联

| 关联域 | 关系 | 说明 |
|--------|------|------|
| PD-03.01 指数退避 | 互补 | 搜索源内部可叠加指数退避重试 |
| PD-03.02 检查点重试 | 互补 | 图级重试 + 搜索级降级，双层容错 |
| PD-08 搜索与检索 | 核心 | 降级机制直接服务于搜索编排 |
| PD-11 可观测性 | 监控 | 降级事件、缓存命中率需要追踪 |

---

## 第 6 章 来源文件索引

| 编号 | 文件 | 说明 |
|------|------|------|
| S1 | `gpt_researcher/retrievers/` | 搜索源适配器目录 |
| S2 | `gpt_researcher/master/agent.py` | Master Agent — 搜索编排、失败隔离 |
| S3 | `gpt_researcher/config/` | 搜索源配置、优先级 |
