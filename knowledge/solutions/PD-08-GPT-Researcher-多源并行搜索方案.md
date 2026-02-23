---
id: "PD-08-gpt-researcher"
domain: "PD-08"
project: "GPT-Researcher"
repo: "https://github.com/assafelovic/gpt-researcher"
title: "多源并行搜索 + 递归子查询"
score: 0.94
signals: ["multi-source-search", "parallel-retrieval", "recursive-sub-query", "result-fusion"]

design_philosophy:
  - "多源冗余：不依赖单一搜索引擎，多源并行提高覆盖率"
  - "递归深入：初始结果不足时自动生成子查询，像人类一样追问"
  - "并行加速：asyncio.gather 同时查询多个搜索源，延迟取决于最慢源"
  - "统一抽象：所有搜索源实现同一接口，新增源只需一个类"

source_files:
  - file: "gpt_researcher/retrievers/"
    description: "搜索源适配器目录 — 每个搜索引擎一个文件"
  - file: "gpt_researcher/retrievers/tavily/tavily_search.py"
    description: "Tavily 搜索适配器 — search() 异步接口"
  - file: "gpt_researcher/retrievers/google/google_search.py"
    description: "Google 搜索适配器"
  - file: "gpt_researcher/retrievers/bing/bing_search.py"
    description: "Bing 搜索适配器"
  - file: "gpt_researcher/master/agent.py"
    description: "Master Agent — 搜索编排、子查询生成、结果融合"
  - file: "gpt_researcher/actions/query_processing.py"
    description: "查询处理 — plan_research_outline + get_sub_queries"

pros:
  - "覆盖率高：多源搜索互补，单一源遗漏的结果其他源可能覆盖"
  - "延迟可控：并行执行，总延迟 = max(各源延迟)，而非 sum"
  - "扩展性强：新增搜索源只需实现 search() 方法"
  - "深度可调：递归层数和子查询数量均可配置"

cons:
  - "成本线性增长：每多一个搜索源，API 调用费用翻倍"
  - "子查询质量依赖 LLM：生成的子查询可能偏离主题"
  - "结果去重不完美：不同源返回同一页面的 URL 格式可能不同"
  - "递归深度失控风险：需要硬性上限防止无限递归"

migration_scenarios:
  - title: "深度研究 Agent"
    description: "需要从多个角度全面收集信息，单次搜索覆盖率不够"
  - title: "事实核查系统"
    description: "需要交叉验证多个信息源，单一源可能有偏见"
  - title: "竞品分析工具"
    description: "需要从不同搜索引擎获取不同维度的竞品信息"
  - title: "知识图谱构建"
    description: "需要递归追踪实体关系，子查询天然适配"
---

# PD-08.01 GPT-Researcher — 多源并行搜索 + 递归子查询

> 文档编号：PD-08.01
> 来源：GPT-Researcher `gpt_researcher/retrievers/` / `gpt_researcher/master/agent.py`
> GitHub：https://github.com/assafelovic/gpt-researcher
> 问题域：PD-08 搜索与检索 Search & Retrieval
> 状态：可复用方案

---

## 第 1 章 问题与动机

### 1.1 核心问题

Agent 需要从外部获取知识来完成研究任务，但面临三个结构性困难：

1. **单源覆盖率不足** — 任何单一搜索引擎都有索引盲区。Google 擅长网页，Tavily 擅长结构化摘要，Bing 在某些地区覆盖更好。只用一个源，信息必然有遗漏。
2. **浅层查询无法获取深层信息** — 用户问"AI Agent 的主流架构有哪些"，第一轮搜索只能拿到概述。要深入了解每种架构的优劣，需要针对性地追问。
3. **串行搜索延迟不可接受** — 如果依次查询 3 个搜索源，每个 2 秒，总延迟 6 秒。并行执行可以压缩到 2 秒。

### 1.2 GPT-Researcher 的解法概述

GPT-Researcher 用三个机制组合解决上述问题：

- **多搜索源并行查询**：通过统一的 Retriever 接口抽象搜索源，`asyncio.gather` 并行执行
- **递归子查询生成**：LLM 分析初始结果后自动生成 3-5 个子查询，递归深入
- **Master-Worker 分发**：Master Agent 负责编排，Worker 负责执行具体搜索

### 1.3 设计思想

| 原则 | 含义 | 体现 |
|------|------|------|
| 多源冗余 | 不把鸡蛋放一个篮子 | 同一查询发给 Tavily + Google + Bing |
| 递归深入 | 像人类一样追问 | 初始结果 → LLM 分析 → 生成子查询 → 再搜索 |
| 并行加速 | 时间取决于最慢的源 | asyncio.gather 同时发起所有请求 |
| 统一抽象 | 新增源零改动编排层 | 所有 Retriever 实现同一个 `search()` 接口 |

---

## 第 2 章 源码实现分析

### 2.1 Retriever 架构

GPT-Researcher 的搜索源位于 `gpt_researcher/retrievers/` 目录，每个搜索引擎一个子目录：

```
gpt_researcher/retrievers/
├── __init__.py              # Retriever 工厂注册表
├── tavily/
│   └── tavily_search.py     # Tavily API 适配器
├── google/
│   └── google_search.py     # Google Custom Search 适配器
├── bing/
│   └── bing_search.py       # Bing Web Search 适配器
├── searx/
│   └── searx_search.py      # SearXNG 自托管搜索适配器
├── duckduckgo/
│   └── duckduckgo_search.py # DuckDuckGo 适配器
└── custom/
    └── custom_retriever.py  # 自定义检索器基类
```

每个适配器都实现同一个异步接口：

```python
# 源码简化自 gpt_researcher/retrievers/tavily/tavily_search.py
class TavilySearch:
    def __init__(self, query: str, **kwargs):
        self.query = query
        self.api_key = os.getenv("TAVILY_API_KEY")

    async def search(self, max_results: int = 5) -> list[dict]:
        """返回统一格式的搜索结果列表"""
        client = TavilyClient(api_key=self.api_key)
        results = await client.search(self.query, max_results=max_results)
        return [
            {
                "title": r["title"],
                "url": r["url"],
                "snippet": r["content"],
                "source": "tavily",
            }
            for r in results
        ]
```

### 2.2 搜索编排（Master Agent）

`gpt_researcher/master/agent.py` 中的 Master Agent 负责编排多源搜索：

```python
# 源码简化自 agent.py — conduct_research()
async def conduct_research(self):
    # 1. 生成子查询
    sub_queries = await self._generate_sub_queries(self.query)

    # 2. 对每个子查询，并行查询所有搜索源
    all_results = []
    for sub_query in sub_queries:
        results = await self._search_all_sources(sub_query)
        all_results.extend(results)

    # 3. 去重 + 排序
    unique_results = self._deduplicate(all_results)
    return unique_results

async def _search_all_sources(self, query: str) -> list[dict]:
    """并行查询所有配置的搜索源"""
    retrievers = [
        retriever_class(query)
        for retriever_class in self.configured_retrievers
    ]
    # asyncio.gather 并行执行
    results_per_source = await asyncio.gather(
        *[r.search(max_results=self.max_results) for r in retrievers],
        return_exceptions=True,  # 单源失败不影响其他源
    )
    # 过滤异常，合并结果
    all_results = []
    for results in results_per_source:
        if not isinstance(results, Exception):
            all_results.extend(results)
    return all_results
```

### 2.3 子查询生成

```python
# 源码简化自 gpt_researcher/actions/query_processing.py
async def get_sub_queries(query: str, context: str, llm) -> list[str]:
    """LLM 根据主查询和已有上下文生成子查询"""
    prompt = f"""Given the research query: "{query}"
And the current research context: {context}

Generate 3-5 specific sub-queries that would help gather
comprehensive information. Each sub-query should explore
a different aspect of the topic.

Return as a JSON list of strings."""

    response = await llm.generate(prompt)
    return json.loads(response)
```

### 2.4 关键设计决策

| 决策 | GPT-Researcher 的选择 | 理由 |
|------|----------------------|------|
| 并行策略 | `asyncio.gather` + `return_exceptions=True` | 单源失败不阻塞其他源 |
| 子查询数量 | 3-5 个 | 平衡深度与成本 |
| 递归深度 | 默认 1 层（可配置） | 防止成本爆炸 |
| 去重策略 | URL 归一化后去重 | 不同源可能返回同一页面 |
| 结果格式 | 统一 `{title, url, snippet, source}` | 下游处理无需关心来源 |

---

## 第 3 章 可复用方案设计

> 以下设计完全通用，不绑定任何特定项目。可直接复制到你的项目中使用。

### 3.1 通用架构图

```
用户查询
  │
  ▼
┌─────────────────────────────────────────────┐
│           SearchOrchestrator                │
│                                             │
│  1. 接收查询                                 │
│  2. 并行分发到所有已注册的 SearchSource       │
│  3. 收集结果 → 去重 → 融合                   │
│  4. 判断是否需要递归深入                      │
│     ├─ 是 → SubQueryGenerator 生成子查询     │
│     │       → 递归调用自身（depth + 1）       │
│     └─ 否 → 返回最终结果                     │
└──────────┬──────────┬──────────┬────────────┘
           │          │          │
     ┌─────▼──┐ ┌────▼───┐ ┌───▼─────┐
     │Tavily  │ │Google  │ │ Bing    │  ... 可扩展
     │Search  │ │Search  │ │ Search  │
     └────────┘ └────────┘ └─────────┘
```

### 3.2 搜索源抽象接口

```python
"""search_source.py — 搜索源抽象基类"""
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Optional


@dataclass
class SearchResult:
    """统一搜索结果格式"""
    title: str
    url: str
    snippet: str
    source: str  # 来源标识，如 "tavily", "google"
    relevance_score: float = 0.0  # 0.0-1.0，由搜索源或后处理赋值
    raw_data: dict = field(default_factory=dict)  # 保留原始数据


class SearchSource(ABC):
    """搜索源抽象基类 — 所有搜索引擎适配器必须实现此接口"""

    @property
    @abstractmethod
    def name(self) -> str:
        """搜索源名称，用于日志和结果标记"""
        ...

    @abstractmethod
    async def search(self, query: str, max_results: int = 5) -> list[SearchResult]:
        """
        执行搜索并返回统一格式的结果列表。

        Args:
            query: 搜索查询字符串
            max_results: 最大返回结果数

        Returns:
            SearchResult 列表，可能为空（搜索无结果时）

        Raises:
            不应抛出异常 — 内部捕获并返回空列表
        """
        ...
```

### 3.3 并行搜索编排器

```python
"""search_orchestrator.py — 多源并行搜索编排器"""
import asyncio
import logging
from dataclasses import dataclass, field
from urllib.parse import urlparse

logger = logging.getLogger(__name__)


@dataclass
class SearchConfig:
    """搜索编排配置"""
    max_results_per_source: int = 5       # 每个源最大结果数
    max_recursive_depth: int = 2          # 最大递归深度
    sub_queries_per_round: int = 3        # 每轮生成的子查询数
    timeout_per_source: float = 10.0      # 单源超时（秒）
    dedup_by_domain: bool = False         # 是否按域名去重（更激进）
    min_results_for_depth: int = 3        # 结果少于此数时触发递归


class SearchOrchestrator:
    """多源并行搜索编排器"""

    def __init__(
        self,
        sources: list[SearchSource],
        sub_query_generator=None,
        config: SearchConfig | None = None,
    ):
        self.sources = sources
        self.sub_query_generator = sub_query_generator
        self.config = config or SearchConfig()

    async def search(
        self, query: str, depth: int = 0
    ) -> list[SearchResult]:
        """
        执行多源并行搜索，必要时递归生成子查询深入。

        Args:
            query: 搜索查询
            depth: 当前递归深度（内部使用）

        Returns:
            去重后的搜索结果列表
        """
        # 1. 并行查询所有搜索源
        results = await self._parallel_search(query)

        # 2. 去重
        results = self._deduplicate(results)

        # 3. 判断是否需要递归深入
        if self._should_go_deeper(results, depth):
            sub_results = await self._recursive_search(query, results, depth)
            results.extend(sub_results)
            results = self._deduplicate(results)

        return results

    async def _parallel_search(self, query: str) -> list[SearchResult]:
        """并行查询所有搜索源，单源失败不影响其他源"""
        tasks = []
        for source in self.sources:
            task = asyncio.wait_for(
                source.search(query, max_results=self.config.max_results_per_source),
                timeout=self.config.timeout_per_source,
            )
            tasks.append(task)

        results_per_source = await asyncio.gather(*tasks, return_exceptions=True)

        all_results = []
        for source, results in zip(self.sources, results_per_source):
            if isinstance(results, Exception):
                logger.warning(f"搜索源 {source.name} 失败: {results}")
                continue
            logger.info(f"搜索源 {source.name} 返回 {len(results)} 条结果")
            all_results.extend(results)

        return all_results

    def _deduplicate(self, results: list[SearchResult]) -> list[SearchResult]:
        """基于 URL 归一化去重"""
        seen = set()
        unique = []
        for r in results:
            key = self._normalize_url(r.url)
            if self.config.dedup_by_domain:
                key = urlparse(r.url).netloc
            if key not in seen:
                seen.add(key)
                unique.append(r)
        return unique

    @staticmethod
    def _normalize_url(url: str) -> str:
        """URL 归一化：去除尾部斜杠、query 参数中的追踪参数等"""
        parsed = urlparse(url)
        # 去除常见追踪参数
        clean_path = parsed.path.rstrip("/")
        return f"{parsed.scheme}://{parsed.netloc}{clean_path}"

    def _should_go_deeper(self, results: list[SearchResult], depth: int) -> bool:
        """判断是否需要递归深入"""
        if depth >= self.config.max_recursive_depth:
            return False
        if self.sub_query_generator is None:
            return False
        if len(results) < self.config.min_results_for_depth:
            return True
        return False

    async def _recursive_search(
        self, original_query: str, current_results: list[SearchResult], depth: int
    ) -> list[SearchResult]:
        """生成子查询并递归搜索"""
        context = "\n".join(
            f"- {r.title}: {r.snippet[:200]}" for r in current_results[:10]
        )
        sub_queries = await self.sub_query_generator.generate(
            original_query, context, count=self.config.sub_queries_per_round
        )
        logger.info(f"递归深度 {depth + 1}，生成 {len(sub_queries)} 个子查询")

        # 并行执行所有子查询
        sub_tasks = [self.search(sq, depth=depth + 1) for sq in sub_queries]
        sub_results_list = await asyncio.gather(*sub_tasks, return_exceptions=True)

        all_sub_results = []
        for results in sub_results_list:
            if not isinstance(results, Exception):
                all_sub_results.extend(results)
        return all_sub_results
```

### 3.4 子查询生成器

```python
"""sub_query_generator.py — LLM 驱动的子查询生成器"""
import json
from typing import Protocol


class LLMClient(Protocol):
    """LLM 客户端协议 — 你的项目中替换为实际的 LLM 调用"""
    async def generate(self, prompt: str) -> str: ...


class SubQueryGenerator:
    """基于 LLM 的子查询生成器"""

    PROMPT_TEMPLATE = """你是一个研究助手。给定一个研究主题和已收集的初步信息，
生成 {count} 个更具体的子查询来深入研究。

研究主题：{query}

已收集的信息：
{context}

要求：
1. 每个子查询应探索主题的不同方面
2. 子查询应比原始查询更具体
3. 避免与已有信息重复的查询
4. 返回 JSON 数组格式：["子查询1", "子查询2", ...]

子查询列表："""

    def __init__(self, llm: LLMClient):
        self.llm = llm

    async def generate(
        self, query: str, context: str, count: int = 3
    ) -> list[str]:
        """生成子查询列表"""
        prompt = self.PROMPT_TEMPLATE.format(
            query=query, context=context, count=count
        )
        response = await self.llm.generate(prompt)

        try:
            sub_queries = json.loads(response)
            if isinstance(sub_queries, list):
                return sub_queries[:count]
        except json.JSONDecodeError:
            # 降级：按行分割
            lines = [
                line.strip().lstrip("0123456789.-) ")
                for line in response.strip().split("\n")
                if line.strip()
            ]
            return lines[:count]

        return []
```

### 3.5 结果去重与融合

```python
"""result_fusion.py — 搜索结果融合与排序"""
from collections import defaultdict


class ResultFusion:
    """多源搜索结果融合排序器

    使用 Reciprocal Rank Fusion (RRF) 算法：
    对于每个结果，在每个源的排名列表中计算 1/(k+rank)，
    然后将所有源的分数相加。k 是平滑常数（默认 60）。
    """

    def __init__(self, k: int = 60):
        self.k = k

    def fuse(
        self, results_by_source: dict[str, list[SearchResult]]
    ) -> list[SearchResult]:
        """
        融合多个搜索源的结果并排序。

        Args:
            results_by_source: {source_name: [SearchResult, ...]}

        Returns:
            按 RRF 分数降序排列的结果列表
        """
        url_scores: dict[str, float] = defaultdict(float)
        url_to_result: dict[str, SearchResult] = {}

        for source_name, results in results_by_source.items():
            for rank, result in enumerate(results):
                normalized_url = SearchOrchestrator._normalize_url(result.url)
                rrf_score = 1.0 / (self.k + rank + 1)
                url_scores[normalized_url] += rrf_score

                # 保留第一次出现的结果对象
                if normalized_url not in url_to_result:
                    url_to_result[normalized_url] = result

        # 按 RRF 分数降序排列
        sorted_urls = sorted(url_scores.keys(), key=lambda u: url_scores[u], reverse=True)

        fused_results = []
        for url in sorted_urls:
            result = url_to_result[url]
            result.relevance_score = url_scores[url]
            fused_results.append(result)

        return fused_results
```

### 3.6 递归深入控制

递归搜索的核心风险是成本爆炸。以下是控制策略：

```
查询成本模型（假设每次搜索 $0.01，3 个搜索源，3 个子查询/轮）

深度 0: 1 查询 × 3 源 = 3 次 API 调用 = $0.03
深度 1: 3 子查询 × 3 源 = 9 次 API 调用 = $0.09
深度 2: 9 子查询 × 3 源 = 27 次 API 调用 = $0.27
深度 3: 27 子查询 × 3 源 = 81 次 API 调用 = $0.81

总计（深度 2）: 3 + 9 + 27 = 39 次调用 = $0.39
总计（深度 3）: 3 + 9 + 27 + 81 = 120 次调用 = $1.20
```

建议的安全限制：

```python
"""递归控制参数"""
RECURSIVE_LIMITS = {
    "conservative": SearchConfig(
        max_recursive_depth=1,
        sub_queries_per_round=2,
        min_results_for_depth=2,
    ),
    "balanced": SearchConfig(
        max_recursive_depth=2,
        sub_queries_per_round=3,
        min_results_for_depth=3,
    ),
    "aggressive": SearchConfig(
        max_recursive_depth=3,
        sub_queries_per_round=5,
        min_results_for_depth=5,
    ),
}
```

### 3.7 配置参数总览

| 参数 | 默认值 | 说明 | 调优建议 |
|------|--------|------|----------|
| `max_results_per_source` | 5 | 每个搜索源返回的最大结果数 | 增大提高覆盖率，但增加处理时间 |
| `max_recursive_depth` | 2 | 最大递归深度 | 生产环境建议不超过 2 |
| `sub_queries_per_round` | 3 | 每轮生成的子查询数 | 3-5 是平衡点 |
| `timeout_per_source` | 10.0s | 单个搜索源的超时时间 | 根据网络环境调整 |
| `dedup_by_domain` | False | 是否按域名去重 | 需要多样性时开启 |
| `min_results_for_depth` | 3 | 结果少于此数时触发递归 | 根据查询复杂度调整 |

---

## 第 4 章 集成指南

### 4.1 最小可运行示例

```python
"""minimal_example.py — 最小可运行的多源并行搜索示例"""
import asyncio
import os
from dataclasses import dataclass, field


# === Step 1: 实现具体搜索源 ===

class TavilySearchSource(SearchSource):
    """Tavily 搜索源适配器"""

    @property
    def name(self) -> str:
        return "tavily"

    async def search(self, query: str, max_results: int = 5) -> list[SearchResult]:
        try:
            from tavily import AsyncTavilyClient
            client = AsyncTavilyClient(api_key=os.getenv("TAVILY_API_KEY"))
            response = await client.search(query, max_results=max_results)
            return [
                SearchResult(
                    title=r["title"],
                    url=r["url"],
                    snippet=r.get("content", ""),
                    source=self.name,
                )
                for r in response.get("results", [])
            ]
        except Exception as e:
            logger.error(f"Tavily 搜索失败: {e}")
            return []


class DuckDuckGoSearchSource(SearchSource):
    """DuckDuckGo 搜索源适配器（免费，无需 API Key）"""

    @property
    def name(self) -> str:
        return "duckduckgo"

    async def search(self, query: str, max_results: int = 5) -> list[SearchResult]:
        try:
            from duckduckgo_search import AsyncDDGS
            async with AsyncDDGS() as ddgs:
                raw_results = await ddgs.atext(query, max_results=max_results)
                return [
                    SearchResult(
                        title=r["title"],
                        url=r["href"],
                        snippet=r["body"],
                        source=self.name,
                    )
                    for r in raw_results
                ]
        except Exception as e:
            logger.error(f"DuckDuckGo 搜索失败: {e}")
            return []


# === Step 2: 组装并运行 ===

async def main():
    # 注册搜索源
    sources = [
        TavilySearchSource(),
        DuckDuckGoSearchSource(),
    ]

    # 创建编排器（不带子查询生成器 = 不递归）
    orchestrator = SearchOrchestrator(
        sources=sources,
        config=SearchConfig(max_results_per_source=5, timeout_per_source=10.0),
    )

    # 执行搜索
    results = await orchestrator.search("AI Agent 架构设计最佳实践")

    for i, r in enumerate(results, 1):
        print(f"{i}. [{r.source}] {r.title}")
        print(f"   {r.url}")
        print(f"   {r.snippet[:100]}...")
        print()


if __name__ == "__main__":
    asyncio.run(main())
```

### 4.2 添加新搜索源

只需实现 `SearchSource` 接口，然后注册到编排器：

```python
class BingSearchSource(SearchSource):
    """Bing Web Search API 适配器"""

    @property
    def name(self) -> str:
        return "bing"

    async def search(self, query: str, max_results: int = 5) -> list[SearchResult]:
        try:
            import aiohttp
            headers = {"Ocp-Apim-Subscription-Key": os.getenv("BING_API_KEY")}
            params = {"q": query, "count": max_results, "mkt": "zh-CN"}
            async with aiohttp.ClientSession() as session:
                async with session.get(
                    "https://api.bing.microsoft.com/v7.0/search",
                    headers=headers,
                    params=params,
                ) as resp:
                    data = await resp.json()
                    return [
                        SearchResult(
                            title=r["name"],
                            url=r["url"],
                            snippet=r.get("snippet", ""),
                            source=self.name,
                        )
                        for r in data.get("webPages", {}).get("value", [])
                    ]
        except Exception as e:
            logger.error(f"Bing 搜索失败: {e}")
            return []


# 注册到编排器
orchestrator = SearchOrchestrator(
    sources=[TavilySearchSource(), DuckDuckGoSearchSource(), BingSearchSource()],
    config=SearchConfig(max_results_per_source=5),
)
```

### 4.3 自定义子查询策略

默认的 LLM 子查询生成器适用于大多数场景。如果需要自定义策略：

```python
class TemplateSubQueryGenerator:
    """基于模板的子查询生成器 — 不依赖 LLM，零成本"""

    TEMPLATES = {
        "comparison": [
            "{query} 优势",
            "{query} 劣势",
            "{query} 替代方案",
        ],
        "how_to": [
            "{query} 教程",
            "{query} 最佳实践",
            "{query} 常见错误",
        ],
        "research": [
            "{query} 最新进展",
            "{query} 学术论文",
            "{query} 开源实现",
        ],
    }

    def __init__(self, strategy: str = "research"):
        self.templates = self.TEMPLATES.get(strategy, self.TEMPLATES["research"])

    async def generate(
        self, query: str, context: str, count: int = 3
    ) -> list[str]:
        return [t.format(query=query) for t in self.templates[:count]]
```

### 4.4 结果缓存

搜索 API 调用有成本，缓存可以显著降低重复查询的开销：

```python
"""search_cache.py — 搜索结果缓存"""
import hashlib
import json
import time
from pathlib import Path


class SearchCache:
    """基于文件系统的搜索结果缓存"""

    def __init__(self, cache_dir: str = ".search_cache", ttl: int = 3600):
        self.cache_dir = Path(cache_dir)
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        self.ttl = ttl  # 缓存有效期（秒）

    def _cache_key(self, query: str, source: str) -> str:
        raw = f"{source}:{query}"
        return hashlib.sha256(raw.encode()).hexdigest()[:16]

    def get(self, query: str, source: str) -> list[dict] | None:
        """获取缓存结果，过期返回 None"""
        key = self._cache_key(query, source)
        cache_file = self.cache_dir / f"{key}.json"
        if not cache_file.exists():
            return None
        data = json.loads(cache_file.read_text())
        if time.time() - data["timestamp"] > self.ttl:
            cache_file.unlink()
            return None
        return data["results"]

    def set(self, query: str, source: str, results: list[dict]):
        """写入缓存"""
        key = self._cache_key(query, source)
        cache_file = self.cache_dir / f"{key}.json"
        cache_file.write_text(json.dumps({
            "query": query,
            "source": source,
            "timestamp": time.time(),
            "results": results,
        }, ensure_ascii=False))
```

---

## 第 5 章 测试用例

```python
"""test_multi_source_search.py — 完整测试套件"""
import asyncio
import pytest
from unittest.mock import AsyncMock, MagicMock


# === 测试用 Mock 搜索源 ===

class MockSearchSource(SearchSource):
    """可控的 Mock 搜索源"""

    def __init__(self, source_name: str, results: list[SearchResult] | None = None,
                 should_fail: bool = False, delay: float = 0.0):
        self._name = source_name
        self._results = results or []
        self._should_fail = should_fail
        self._delay = delay

    @property
    def name(self) -> str:
        return self._name

    async def search(self, query: str, max_results: int = 5) -> list[SearchResult]:
        if self._delay > 0:
            await asyncio.sleep(self._delay)
        if self._should_fail:
            raise ConnectionError(f"{self._name} 连接失败")
        return self._results[:max_results]


def make_result(title: str, url: str, source: str = "mock") -> SearchResult:
    return SearchResult(title=title, url=url, snippet=f"Snippet for {title}", source=source)


# === 5.1 搜索源接口测试 ===

class TestSearchSource:
    """搜索源基本行为测试"""

    @pytest.mark.asyncio
    async def test_returns_search_results(self):
        """搜索源应返回 SearchResult 列表"""
        source = MockSearchSource("test", [make_result("Result 1", "https://example.com/1")])
        results = await source.search("test query")
        assert len(results) == 1
        assert results[0].title == "Result 1"
        assert results[0].source == "test"

    @pytest.mark.asyncio
    async def test_respects_max_results(self):
        """搜索源应遵守 max_results 限制"""
        results = [make_result(f"R{i}", f"https://example.com/{i}") for i in range(10)]
        source = MockSearchSource("test", results)
        limited = await source.search("query", max_results=3)
        assert len(limited) == 3

    @pytest.mark.asyncio
    async def test_empty_results(self):
        """无结果时返回空列表"""
        source = MockSearchSource("test", [])
        results = await source.search("obscure query")
        assert results == []


# === 5.2 并行搜索编排器测试 ===

class TestSearchOrchestrator:
    """编排器核心行为测试"""

    @pytest.mark.asyncio
    async def test_parallel_search_merges_results(self):
        """多源结果应合并"""
        source_a = MockSearchSource("a", [make_result("A1", "https://a.com/1", "a")])
        source_b = MockSearchSource("b", [make_result("B1", "https://b.com/1", "b")])
        orchestrator = SearchOrchestrator(sources=[source_a, source_b])

        results = await orchestrator.search("test")
        assert len(results) == 2
        sources = {r.source for r in results}
        assert sources == {"a", "b"}

    @pytest.mark.asyncio
    async def test_single_source_failure_does_not_block(self):
        """单源失败不影响其他源"""
        source_ok = MockSearchSource("ok", [make_result("OK", "https://ok.com/1")])
        source_fail = MockSearchSource("fail", should_fail=True)
        orchestrator = SearchOrchestrator(sources=[source_ok, source_fail])

        results = await orchestrator.search("test")
        assert len(results) == 1
        assert results[0].source == "ok"

    @pytest.mark.asyncio
    async def test_deduplication_by_url(self):
        """相同 URL 的结果应去重"""
        source_a = MockSearchSource("a", [make_result("Title A", "https://example.com/page")])
        source_b = MockSearchSource("b", [make_result("Title B", "https://example.com/page")])
        orchestrator = SearchOrchestrator(sources=[source_a, source_b])

        results = await orchestrator.search("test")
        assert len(results) == 1  # 去重后只保留一条

    @pytest.mark.asyncio
    async def test_deduplication_ignores_trailing_slash(self):
        """URL 去重应忽略尾部斜杠"""
        source_a = MockSearchSource("a", [make_result("A", "https://example.com/page/")])
        source_b = MockSearchSource("b", [make_result("B", "https://example.com/page")])
        orchestrator = SearchOrchestrator(sources=[source_a, source_b])

        results = await orchestrator.search("test")
        assert len(results) == 1

    @pytest.mark.asyncio
    async def test_timeout_handling(self):
        """超时的搜索源应被跳过"""
        source_slow = MockSearchSource("slow", [make_result("Slow", "https://slow.com")], delay=5.0)
        source_fast = MockSearchSource("fast", [make_result("Fast", "https://fast.com")])
        config = SearchConfig(timeout_per_source=0.1)
        orchestrator = SearchOrchestrator(sources=[source_slow, source_fast], config=config)

        results = await orchestrator.search("test")
        assert len(results) == 1
        assert results[0].source == "fast"

    @pytest.mark.asyncio
    async def test_all_sources_fail_returns_empty(self):
        """所有源都失败时返回空列表"""
        sources = [MockSearchSource(f"fail_{i}", should_fail=True) for i in range(3)]
        orchestrator = SearchOrchestrator(sources=sources)

        results = await orchestrator.search("test")
        assert results == []


# === 5.3 递归子查询测试 ===

class TestRecursiveSearch:
    """递归子查询行为测试"""

    @pytest.mark.asyncio
    async def test_no_recursion_without_generator(self):
        """没有子查询生成器时不递归"""
        source = MockSearchSource("test", [make_result("R1", "https://example.com/1")])
        config = SearchConfig(min_results_for_depth=10)  # 结果不足，但无生成器
        orchestrator = SearchOrchestrator(sources=[source], config=config)

        results = await orchestrator.search("test")
        assert len(results) == 1  # 不递归，只有初始结果

    @pytest.mark.asyncio
    async def test_recursion_triggered_when_results_insufficient(self):
        """结果不足时触发递归"""
        source = MockSearchSource("test", [make_result("R1", "https://example.com/1")])
        mock_generator = AsyncMock()
        mock_generator.generate = AsyncMock(return_value=["子查询1", "子查询2"])

        config = SearchConfig(min_results_for_depth=5, max_recursive_depth=1)
        orchestrator = SearchOrchestrator(
            sources=[source], sub_query_generator=mock_generator, config=config
        )

        results = await orchestrator.search("test")
        mock_generator.generate.assert_called_once()

    @pytest.mark.asyncio
    async def test_max_depth_respected(self):
        """递归深度不超过配置上限"""
        source = MockSearchSource("test", [])  # 始终返回空 → 始终想递归
        mock_generator = AsyncMock()
        mock_generator.generate = AsyncMock(return_value=["sub1"])

        config = SearchConfig(max_recursive_depth=2, min_results_for_depth=1)
        orchestrator = SearchOrchestrator(
            sources=[source], sub_query_generator=mock_generator, config=config
        )

        await orchestrator.search("test")
        # 深度 0 → 递归 → 深度 1 → 递归 → 深度 2 → 停止
        # generate 被调用 2 次（深度 0 和深度 1 各一次）
        assert mock_generator.generate.call_count <= 3


# === 5.4 结果融合测试 ===

class TestResultFusion:
    """RRF 融合排序测试"""

    def test_single_source_preserves_order(self):
        """单源结果保持原始排序"""
        results = [make_result(f"R{i}", f"https://example.com/{i}") for i in range(5)]
        fusion = ResultFusion()
        fused = fusion.fuse({"source_a": results})
        assert [r.title for r in fused] == [f"R{i}" for i in range(5)]

    def test_multi_source_boosts_shared_results(self):
        """多源共有的结果排名更高"""
        shared = make_result("Shared", "https://shared.com/page")
        unique_a = make_result("Only A", "https://a.com/unique")
        unique_b = make_result("Only B", "https://b.com/unique")

        fusion = ResultFusion()
        fused = fusion.fuse({
            "a": [shared, unique_a],
            "b": [shared, unique_b],
        })
        # shared 在两个源中都排第一，RRF 分数最高
        assert fused[0].title == "Shared"

    def test_empty_sources(self):
        """空输入返回空列表"""
        fusion = ResultFusion()
        assert fusion.fuse({}) == []


# === 5.5 搜索缓存测试 ===

class TestSearchCache:
    """搜索缓存行为测试"""

    def test_cache_miss_returns_none(self, tmp_path):
        cache = SearchCache(cache_dir=str(tmp_path), ttl=3600)
        assert cache.get("unknown query", "tavily") is None

    def test_cache_hit_returns_results(self, tmp_path):
        cache = SearchCache(cache_dir=str(tmp_path), ttl=3600)
        results = [{"title": "Test", "url": "https://example.com"}]
        cache.set("test query", "tavily", results)
        cached = cache.get("test query", "tavily")
        assert cached == results

    def test_expired_cache_returns_none(self, tmp_path):
        cache = SearchCache(cache_dir=str(tmp_path), ttl=0)  # TTL=0 立即过期
        cache.set("test query", "tavily", [{"title": "Test"}])
        import time
        time.sleep(0.01)
        assert cache.get("test query", "tavily") is None
```

---

## 第 6 章 风险与降级

### 6.1 风险矩阵

| 风险 | 概率 | 影响 | 缓解策略 |
|------|------|------|----------|
| 所有搜索源同时不可用 | 低 | 高 | 本地缓存兜底 + 降级到单源重试 |
| 子查询偏离主题 | 中 | 中 | 限制递归深度 + 子查询相关性过滤 |
| 搜索 API 费用超预算 | 中 | 中 | 设置每日调用上限 + 缓存热门查询 |
| 递归深度失控 | 低 | 高 | 硬性 `max_recursive_depth` 上限 |
| 结果去重遗漏 | 中 | 低 | URL 归一化 + 内容指纹去重 |
| 单源响应过慢拖累整体 | 中 | 中 | `asyncio.wait_for` 超时控制 |

### 6.2 降级策略

```python
"""degradation.py — 搜索降级策略"""


class SearchDegradation:
    """三级降级策略"""

    def __init__(self, orchestrator: SearchOrchestrator, cache: SearchCache):
        self.orchestrator = orchestrator
        self.cache = cache

    async def search_with_fallback(self, query: str) -> list[SearchResult]:
        """
        Level 1: 正常多源并行搜索
        Level 2: 单源搜索（选择最可靠的源）
        Level 3: 返回缓存结果（可能过期）
        """
        # Level 1: 正常搜索
        try:
            results = await self.orchestrator.search(query)
            if results:
                return results
        except Exception:
            pass

        # Level 2: 单源降级
        for source in self.orchestrator.sources:
            try:
                results = await asyncio.wait_for(
                    source.search(query), timeout=15.0
                )
                if results:
                    return results
            except Exception:
                continue

        # Level 3: 缓存兜底
        for source in self.orchestrator.sources:
            cached = self.cache.get(query, source.name)
            if cached:
                return [SearchResult(**r) for r in cached]

        return []  # 完全无结果
```

---

## 第 7 章 适用场景与限制

### 7.1 适用场景

| 场景 | 适合度 | 理由 |
|------|--------|------|
| 深度研究 Agent | ★★★★★ | 核心场景，递归子查询天然适配 |
| 事实核查 / 交叉验证 | ★★★★★ | 多源结果互相验证，提高可信度 |
| 竞品分析 / 市场调研 | ★★★★☆ | 不同搜索引擎覆盖不同信息维度 |
| RAG 知识增强 | ★★★★☆ | 搜索结果作为 RAG 的外部知识源 |
| 实时问答 | ★★★☆☆ | 并行搜索有延迟，不适合毫秒级响应 |
| 简单信息查询 | ★★☆☆☆ | 杀鸡用牛刀，单源搜索足够 |

### 7.2 限制

1. **成本与深度成正比** — 递归每深一层，API 调用数指数增长。生产环境必须设置预算上限。
2. **子查询质量依赖 LLM** — 如果 LLM 生成的子查询偏离主题，递归搜索会浪费资源。建议加入相关性过滤。
3. **搜索 API 的速率限制** — 并行查询可能触发搜索引擎的 rate limit。需要实现退避重试或令牌桶限流。
4. **结果新鲜度不可控** — 搜索引擎返回的结果可能是过时的。对时效性要求高的场景需要额外过滤。
5. **不适合结构化数据查询** — 搜索引擎返回的是网页摘要，不适合需要精确数据的场景（如数据库查询、API 调用）。

### 7.3 与其他方案的对比

| 维度 | 多源并行搜索（本方案） | 单源搜索 | RAG 向量检索 |
|------|----------------------|----------|-------------|
| 覆盖率 | 高（多源互补） | 低（单源盲区） | 取决于索引范围 |
| 延迟 | 中（并行，取决于最慢源） | 低（单次调用） | 低（本地向量库） |
| 成本 | 高（多源 + 递归） | 低 | 低（一次索引） |
| 信息新鲜度 | 高（实时搜索） | 高 | 低（需要重新索引） |
| 深度 | 高（递归子查询） | 低 | 中（取决于文档质量） |
| 适用数据 | 公开网页 | 公开网页 | 私有文档 |

---

## 跨域关联

| 关联域 | 关系 | 说明 |
|--------|------|------|
| PD-01 上下文管理 | 下游 | 搜索结果需要裁剪后才能放入 LLM 上下文 |
| PD-02 多 Agent 编排 | 架构 | Master-Worker 模式可复用多 Agent 编排框架 |
| PD-03 容错与重试 | 互补 | 搜索源失败时需要重试机制 |
| PD-07 质量检查 | 下游 | 搜索结果的可信度需要质量检查 |
| PD-11 可观测性 | 输入 | 搜索调用次数、延迟、成本需要追踪 |

---

## 来源文件索引

| 编号 | 文件 | 说明 |
|------|------|------|
| S1 | `gpt_researcher/retrievers/` | 搜索源适配器目录 |
| S2 | `gpt_researcher/retrievers/tavily/tavily_search.py` | Tavily 搜索适配器 |
| S3 | `gpt_researcher/retrievers/google/google_search.py` | Google 搜索适配器 |
| S4 | `gpt_researcher/retrievers/bing/bing_search.py` | Bing 搜索适配器 |
| S5 | `gpt_researcher/master/agent.py` | Master Agent — 搜索编排核心 |
| S6 | `gpt_researcher/actions/query_processing.py` | 子查询生成逻辑 |
