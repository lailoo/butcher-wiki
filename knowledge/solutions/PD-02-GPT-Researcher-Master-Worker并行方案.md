# PD-02.02 GPT-Researcher — Master-Worker 并行研究

> 文档编号：PD-02.02
> 来源：GPT-Researcher `gpt_researcher/master/agent.py` / `gpt_researcher/agent/research_agent.py`
> GitHub：https://github.com/assafelovic/gpt-researcher
> 问题域：PD-02 多 Agent 编排 Multi-Agent Orchestration
> 状态：可复用方案

---

## 第 1 章 问题与动机

### 1.1 核心问题

深度研究任务天然可分解：一个复杂问题可以拆成多个子问题，每个子问题独立搜索、独立分析，最后汇总。但如果串行执行：

```
"对比 5 种 Agent 框架的优劣"
  → 子查询 1: LangGraph 优劣 (3s)
  → 子查询 2: CrewAI 优劣 (3s)
  → 子查询 3: AutoGen 优劣 (3s)
  → 子查询 4: MetaGPT 优劣 (3s)
  → 子查询 5: Camel 优劣 (3s)
  → 总延迟: 15s
```

并行执行可以将延迟压缩到 3s（取决于最慢的子查询）。但并行带来新问题：如何分发任务、如何收集结果、如何处理部分失败。

### 1.2 GPT-Researcher 的解法概述

GPT-Researcher 采用 Master-Worker 模式：

- **Master Agent**：接收用户查询，调用 LLM 生成子查询列表，分发给 Worker
- **Worker Agent**：每个 Worker 独立执行一个子查询的完整研究流程（搜索 → 抓取 → 摘要）
- **结果聚合**：Master 收集所有 Worker 结果，调用 LLM 生成最终报告

### 1.3 设计思想

| 原则 | 说明 |
|------|------|
| 分而治之 | 复杂查询拆解为独立子查询，降低单次搜索的复杂度 |
| 并行加速 | asyncio.gather 同时执行所有 Worker，延迟 = max(各 Worker) |
| 容错隔离 | 单个 Worker 失败不影响其他 Worker，Master 跳过失败结果 |
| 职责分离 | Master 只负责编排，Worker 只负责执行，互不耦合 |
| 结果融合 | 最终报告由 LLM 综合所有子结果生成，而非简单拼接 |

---

## 第 2 章 源码实现分析

### 2.1 整体架构

```
gpt_researcher/
├── master/
│   ├── agent.py          # Master Agent — 子查询生成、Worker 分发、结果聚合
│   └── functions.py      # Master 辅助函数 — 报告生成、大纲规划
├── agent/
│   └── research_agent.py # Worker Agent — 单个子查询的完整研究流程
├── actions/
│   ├── query_processing.py  # 子查询生成逻辑
│   └── web_scraping.py      # 网页抓取
└── retrievers/              # 搜索源适配器
```

### 2.2 Master Agent — 子查询生成与分发

```python
# 源码简化自 gpt_researcher/master/agent.py
class GPTResearcher:
    """Master Agent：编排整个研究流程"""

    def __init__(self, query: str, report_type: str = "research_report",
                 source_urls=None, config=None):
        self.query = query
        self.report_type = report_type
        self.config = config or Config()
        self.sub_queries: list[str] = []
        self.research_data: list[dict] = []

    async def conduct_research(self) -> str:
        """主研究流程：生成子查询 → 并行研究 → 聚合报告"""
        # Step 1: LLM 生成子查询
        self.sub_queries = await self._generate_sub_queries()

        # Step 2: 并行执行所有子查询研究
        research_tasks = [
            self._research_sub_query(sq)
            for sq in self.sub_queries
        ]
        results = await asyncio.gather(
            *research_tasks,
            return_exceptions=True,
        )

        # Step 3: 过滤失败结果，收集成功数据
        for sq, result in zip(self.sub_queries, results):
            if isinstance(result, Exception):
                logger.warning(f"子查询失败: {sq} — {result}")
                continue
            self.research_data.append({
                "sub_query": sq,
                "data": result,
            })

        # Step 4: 生成最终报告
        report = await self._generate_report()
        return report
```

### 2.3 子查询生成

```python
# 源码简化自 gpt_researcher/actions/query_processing.py
async def generate_sub_queries(
    query: str,
    agent_role: str,
    llm,
    max_sub_queries: int = 5,
) -> list[str]:
    """LLM 将主查询拆解为可并行执行的子查询"""
    prompt = f"""You are a research assistant with the role: {agent_role}

Given the research query: "{query}"

Generate up to {max_sub_queries} specific sub-queries that:
1. Each explores a different aspect of the topic
2. Can be researched independently
3. Together provide comprehensive coverage

Return as a JSON array of strings."""

    response = await llm.ainvoke(prompt)
    sub_queries = json.loads(response.content)

    # 始终包含原始查询作为兜底
    if query not in sub_queries:
        sub_queries.insert(0, query)

    return sub_queries[:max_sub_queries]
```

### 2.4 Worker Agent — 单子查询研究

```python
# 源码简化自 gpt_researcher/agent/research_agent.py
class ResearchAgent:
    """Worker Agent：执行单个子查询的完整研究"""

    def __init__(self, query: str, retrievers: list, llm, config):
        self.query = query
        self.retrievers = retrievers
        self.llm = llm
        self.config = config

    async def research(self) -> dict:
        """单子查询研究流程：搜索 → 抓取 → 摘要"""
        # 1. 多源搜索
        search_results = await self._search(self.query)

        # 2. 抓取网页内容
        scraped_content = await self._scrape_urls(
            [r["url"] for r in search_results[:self.config.max_urls]]
        )

        # 3. LLM 生成摘要
        summary = await self._summarize(scraped_content)

        return {
            "query": self.query,
            "sources": search_results,
            "content": scraped_content,
            "summary": summary,
        }

    async def _search(self, query: str) -> list[dict]:
        """并行查询所有搜索源"""
        tasks = [r.search(query) for r in self.retrievers]
        results = await asyncio.gather(*tasks, return_exceptions=True)
        all_results = []
        for r in results:
            if not isinstance(r, Exception):
                all_results.extend(r)
        return all_results

    async def _scrape_urls(self, urls: list[str]) -> list[str]:
        """并行抓取网页"""
        tasks = [scrape_url(url) for url in urls]
        contents = await asyncio.gather(*tasks, return_exceptions=True)
        return [c for c in contents if isinstance(c, str)]

    async def _summarize(self, contents: list[str]) -> str:
        """LLM 摘要"""
        combined = "\n\n---\n\n".join(contents[:10])
        response = await self.llm.ainvoke(
            f"Summarize the following research data for: {self.query}\n\n{combined}"
        )
        return response.content
```

### 2.5 结果聚合与报告生成

```python
# 源码简化自 gpt_researcher/master/functions.py
async def generate_report(
    query: str,
    research_data: list[dict],
    llm,
    report_type: str = "research_report",
) -> str:
    """将所有子查询研究结果聚合为最终报告"""
    context_parts = []
    for item in research_data:
        context_parts.append(
            f"### Sub-query: {item['sub_query']}\n{item['data']['summary']}"
        )
    context = "\n\n".join(context_parts)

    prompt = f"""Based on the following research data, write a comprehensive
{report_type} about: {query}

Research Data:
{context}

Requirements:
- Synthesize information from all sub-queries
- Identify common themes and contradictions
- Provide a balanced, well-structured report
- Cite sources where applicable"""

    response = await llm.ainvoke(prompt)
    return response.content
```

### 2.6 关键设计决策

| 决策 | GPT-Researcher 的选择 | 理由 |
|------|----------------------|------|
| 并行粒度 | 子查询级别 | 每个子查询独立完整，天然可并行 |
| 失败处理 | `return_exceptions=True` + 跳过 | 部分失败不阻塞整体 |
| 子查询数量 | 3-5 个 | 平衡覆盖率与成本 |
| 原始查询保留 | 始终包含在子查询列表中 | 兜底：即使子查询偏离，原始查询仍有结果 |
| 报告生成 | LLM 综合而非拼接 | 避免重复、矛盾，生成连贯报告 |

---

## 第 3 章 可复用方案设计

> 从 GPT-Researcher 的 Master-Worker 模式提炼的通用实现，不依赖特定项目。

### 3.1 通用架构图

```
用户查询
  │
  ▼
┌──────────────────────────────────────────┐
│            MasterAgent                    │
│                                          │
│  1. 接收查询                              │
│  2. LLM 生成子任务列表                    │
│  3. 创建 WorkerAgent 实例                 │
│  4. asyncio.gather 并行执行               │
│  5. 收集结果 → 过滤失败 → 聚合            │
│  6. LLM 生成最终输出                      │
└────┬─────────┬─────────┬────────────────┘
     │         │         │
┌────▼───┐ ┌──▼────┐ ┌──▼────┐
│Worker 1│ │Worker 2│ │Worker N│  并行执行
│子任务 1│ │子任务 2│ │子任务 N│
└────┬───┘ └──┬────┘ └──┬────┘
     │         │         │
     └─────────┼─────────┘
               ▼
         结果聚合 → 最终报告
```

### 3.2 核心接口定义

```python
"""master_worker.py — Master-Worker 并行研究框架"""
from __future__ import annotations

import asyncio
import logging
import time
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any, Generic, TypeVar

logger = logging.getLogger(__name__)

T = TypeVar("T")  # Worker 结果类型


@dataclass
class SubTask:
    """子任务定义"""
    id: str
    query: str
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass
class WorkerResult:
    """Worker 执行结果"""
    task_id: str
    query: str
    success: bool
    data: Any = None
    error: str | None = None
    duration_ms: float = 0.0


@dataclass
class MasterConfig:
    """Master 配置"""
    max_sub_tasks: int = 5
    max_parallel_workers: int = 10
    worker_timeout: float = 60.0
    include_original_query: bool = True
    retry_failed_workers: bool = False
    max_worker_retries: int = 2
```

### 3.3 Worker 基类

```python
class BaseWorker(ABC):
    """Worker 基类 — 执行单个子任务的完整流程"""

    @abstractmethod
    async def execute(self, task: SubTask) -> Any:
        """
        执行子任务并返回结果。

        Args:
            task: 子任务定义

        Returns:
            任务执行结果（类型由子类决定）

        Raises:
            任何异常都会被 Master 捕获并记录
        """
        ...


class ResearchWorker(BaseWorker):
    """研究型 Worker — 搜索 + 抓取 + 摘要"""

    def __init__(self, search_sources: list, llm, config: dict | None = None):
        self.search_sources = search_sources
        self.llm = llm
        self.config = config or {}

    async def execute(self, task: SubTask) -> dict:
        # 1. 并行搜索
        search_tasks = [s.search(task.query) for s in self.search_sources]
        raw_results = await asyncio.gather(*search_tasks, return_exceptions=True)
        results = []
        for r in raw_results:
            if not isinstance(r, Exception):
                results.extend(r)

        # 2. 摘要
        context = "\n".join(f"- {r.get('title', '')}: {r.get('snippet', '')}" for r in results[:10])
        response = await self.llm.ainvoke(
            f"Summarize research for: {task.query}\n\nSources:\n{context}"
        )

        return {
            "query": task.query,
            "sources_count": len(results),
            "summary": response.content,
        }
```

### 3.4 Master Agent

```python
class MasterAgent:
    """Master Agent — 子任务生成、Worker 分发、结果聚合"""

    def __init__(
        self,
        worker: BaseWorker,
        llm,
        config: MasterConfig | None = None,
    ):
        self.worker = worker
        self.llm = llm
        self.config = config or MasterConfig()

    async def run(self, query: str) -> dict:
        """
        执行完整的 Master-Worker 研究流程。

        Returns:
            {"query": str, "sub_tasks": list, "results": list,
             "report": str, "stats": dict}
        """
        start = time.monotonic()

        # Step 1: 生成子任务
        sub_tasks = await self._generate_sub_tasks(query)
        logger.info(f"生成 {len(sub_tasks)} 个子任务")

        # Step 2: 并行执行
        results = await self._execute_parallel(sub_tasks)

        # Step 3: 可选重试失败任务
        if self.config.retry_failed_workers:
            results = await self._retry_failed(results)

        # Step 4: 聚合报告
        successful = [r for r in results if r.success]
        report = await self._aggregate_results(query, successful)

        total_ms = (time.monotonic() - start) * 1000
        stats = {
            "total_tasks": len(sub_tasks),
            "successful": len(successful),
            "failed": len(results) - len(successful),
            "total_duration_ms": total_ms,
        }

        return {
            "query": query,
            "sub_tasks": [t.query for t in sub_tasks],
            "results": results,
            "report": report,
            "stats": stats,
        }

    async def _generate_sub_tasks(self, query: str) -> list[SubTask]:
        """LLM 生成子任务列表"""
        prompt = f"""将以下研究查询拆解为 {self.config.max_sub_tasks} 个独立的子查询。
每个子查询应探索主题的不同方面，可以独立研究。

查询: {query}

返回 JSON 数组: ["子查询1", "子查询2", ...]"""

        response = await self.llm.ainvoke(prompt)
        try:
            queries = json.loads(response.content)
        except json.JSONDecodeError:
            queries = [query]  # 降级：使用原始查询

        if self.config.include_original_query and query not in queries:
            queries.insert(0, query)

        tasks = [
            SubTask(id=f"task_{i}", query=q)
            for i, q in enumerate(queries[:self.config.max_sub_tasks])
        ]
        return tasks

    async def _execute_parallel(self, tasks: list[SubTask]) -> list[WorkerResult]:
        """并行执行所有子任务，带超时和并发控制"""
        semaphore = asyncio.Semaphore(self.config.max_parallel_workers)

        async def _run_worker(task: SubTask) -> WorkerResult:
            async with semaphore:
                start = time.monotonic()
                try:
                    data = await asyncio.wait_for(
                        self.worker.execute(task),
                        timeout=self.config.worker_timeout,
                    )
                    duration = (time.monotonic() - start) * 1000
                    return WorkerResult(
                        task_id=task.id, query=task.query,
                        success=True, data=data, duration_ms=duration,
                    )
                except Exception as e:
                    duration = (time.monotonic() - start) * 1000
                    logger.warning(f"Worker {task.id} 失败: {e}")
                    return WorkerResult(
                        task_id=task.id, query=task.query,
                        success=False, error=str(e), duration_ms=duration,
                    )

        return await asyncio.gather(*[_run_worker(t) for t in tasks])

    async def _retry_failed(self, results: list[WorkerResult]) -> list[WorkerResult]:
        """重试失败的 Worker"""
        final = []
        for r in results:
            if r.success:
                final.append(r)
                continue
            for attempt in range(self.config.max_worker_retries):
                logger.info(f"重试 {r.task_id} (attempt {attempt + 1})")
                task = SubTask(id=r.task_id, query=r.query)
                try:
                    data = await asyncio.wait_for(
                        self.worker.execute(task),
                        timeout=self.config.worker_timeout,
                    )
                    final.append(WorkerResult(
                        task_id=r.task_id, query=r.query,
                        success=True, data=data,
                    ))
                    break
                except Exception:
                    if attempt == self.config.max_worker_retries - 1:
                        final.append(r)
        return final

    async def _aggregate_results(
        self, query: str, results: list[WorkerResult]
    ) -> str:
        """LLM 聚合所有 Worker 结果为最终报告"""
        if not results:
            return "研究未能获取到有效数据。"

        context_parts = []
        for r in results:
            summary = r.data.get("summary", str(r.data)) if isinstance(r.data, dict) else str(r.data)
            context_parts.append(f"### {r.query}\n{summary}")
        context = "\n\n".join(context_parts)

        prompt = f"""基于以下研究数据，生成关于 "{query}" 的综合报告。

{context}

要求：综合所有子查询结果，识别共同主题和矛盾点，生成结构化报告。"""

        response = await self.llm.ainvoke(prompt)
        return response.content
```

### 3.5 配置参数

| 参数 | 默认值 | 说明 | 调优建议 |
|------|--------|------|----------|
| `max_sub_tasks` | 5 | 最大子任务数 | 3-7，过多增加成本 |
| `max_parallel_workers` | 10 | 最大并行 Worker 数 | 受搜索 API rate limit 限制 |
| `worker_timeout` | 60.0s | 单 Worker 超时 | 网络慢时增大 |
| `include_original_query` | True | 子任务中包含原始查询 | 兜底保障 |
| `retry_failed_workers` | False | 是否重试失败 Worker | 对可靠性要求高时开启 |
| `max_worker_retries` | 2 | 失败 Worker 最大重试次数 | 与 timeout 配合 |

---

## 第 4 章 测试用例

```python
"""test_master_worker.py — Master-Worker 并行研究框架测试"""
import asyncio
import json
import pytest
from unittest.mock import AsyncMock, MagicMock, patch
from dataclasses import dataclass


# === Mock 对象 ===

class MockWorker(BaseWorker):
    """可控的 Mock Worker"""

    def __init__(self, results: dict[str, Any] | None = None,
                 should_fail: bool = False, delay: float = 0.0):
        self._results = results or {"summary": "mock summary"}
        self._should_fail = should_fail
        self._delay = delay
        self.executed_tasks: list[str] = []

    async def execute(self, task: SubTask) -> dict:
        if self._delay > 0:
            await asyncio.sleep(self._delay)
        self.executed_tasks.append(task.id)
        if self._should_fail:
            raise RuntimeError(f"Worker failed for {task.id}")
        return {**self._results, "query": task.query}


def mock_llm(response_content: str):
    llm = AsyncMock()
    llm.ainvoke.return_value = MagicMock(content=response_content)
    return llm


# === 子任务生成测试 ===

class TestSubTaskGeneration:

    @pytest.mark.asyncio
    async def test_generates_sub_tasks_from_llm(self):
        """LLM 返回的子查询应被解析为 SubTask 列表"""
        llm = mock_llm('["子查询1", "子查询2", "子查询3"]')
        worker = MockWorker()
        master = MasterAgent(worker=worker, llm=llm)
        tasks = await master._generate_sub_tasks("主查询")
        assert len(tasks) >= 3
        assert any(t.query == "主查询" for t in tasks)  # 原始查询被包含

    @pytest.mark.asyncio
    async def test_fallback_on_invalid_json(self):
        """LLM 返回无效 JSON 时降级为原始查询"""
        llm = mock_llm("这不是 JSON")
        worker = MockWorker()
        master = MasterAgent(worker=worker, llm=llm)
        tasks = await master._generate_sub_tasks("主查询")
        assert len(tasks) == 1
        assert tasks[0].query == "主查询"

    @pytest.mark.asyncio
    async def test_respects_max_sub_tasks(self):
        """子任务数不超过配置上限"""
        llm = mock_llm(json.dumps([f"q{i}" for i in range(20)]))
        worker = MockWorker()
        config = MasterConfig(max_sub_tasks=3)
        master = MasterAgent(worker=worker, llm=llm, config=config)
        tasks = await master._generate_sub_tasks("主查询")
        assert len(tasks) <= 3


# === 并行执行测试 ===

class TestParallelExecution:

    @pytest.mark.asyncio
    async def test_all_workers_succeed(self):
        """所有 Worker 成功时返回完整结果"""
        worker = MockWorker()
        tasks = [SubTask(id=f"t{i}", query=f"q{i}") for i in range(3)]
        llm = mock_llm("report")
        master = MasterAgent(worker=worker, llm=llm)
        results = await master._execute_parallel(tasks)
        assert len(results) == 3
        assert all(r.success for r in results)

    @pytest.mark.asyncio
    async def test_partial_failure_isolated(self):
        """部分 Worker 失败不影响其他 Worker"""
        worker = MockWorker(should_fail=True)
        good_worker = MockWorker()
        # 使用 MasterAgent 的完整流程测试
        llm = mock_llm('["q1", "q2"]')
        master = MasterAgent(worker=worker, llm=llm)
        tasks = [SubTask(id="t0", query="q0")]
        results = await master._execute_parallel(tasks)
        assert len(results) == 1
        assert not results[0].success

    @pytest.mark.asyncio
    async def test_worker_timeout(self):
        """超时的 Worker 应被标记为失败"""
        worker = MockWorker(delay=5.0)
        config = MasterConfig(worker_timeout=0.1)
        llm = mock_llm("report")
        master = MasterAgent(worker=worker, llm=llm, config=config)
        tasks = [SubTask(id="t0", query="slow query")]
        results = await master._execute_parallel(tasks)
        assert len(results) == 1
        assert not results[0].success

    @pytest.mark.asyncio
    async def test_concurrency_limit(self):
        """并发数不超过配置上限"""
        concurrent_count = 0
        max_concurrent = 0

        class TrackingWorker(BaseWorker):
            async def execute(self, task):
                nonlocal concurrent_count, max_concurrent
                concurrent_count += 1
                max_concurrent = max(max_concurrent, concurrent_count)
                await asyncio.sleep(0.05)
                concurrent_count -= 1
                return {"summary": "ok"}

        config = MasterConfig(max_parallel_workers=2)
        llm = mock_llm("report")
        master = MasterAgent(worker=TrackingWorker(), llm=llm, config=config)
        tasks = [SubTask(id=f"t{i}", query=f"q{i}") for i in range(5)]
        await master._execute_parallel(tasks)
        assert max_concurrent <= 2


# === 结果聚合测试 ===

class TestResultAggregation:

    @pytest.mark.asyncio
    async def test_aggregation_calls_llm(self):
        """聚合应调用 LLM 生成报告"""
        llm = mock_llm("综合报告内容")
        worker = MockWorker()
        master = MasterAgent(worker=worker, llm=llm)
        results = [
            WorkerResult(task_id="t0", query="q0", success=True,
                        data={"summary": "数据1"}),
            WorkerResult(task_id="t1", query="q1", success=True,
                        data={"summary": "数据2"}),
        ]
        report = await master._aggregate_results("主查询", results)
        assert report == "综合报告内容"
        llm.ainvoke.assert_called_once()

    @pytest.mark.asyncio
    async def test_empty_results_returns_fallback(self):
        """无有效结果时返回兜底文本"""
        llm = mock_llm("report")
        worker = MockWorker()
        master = MasterAgent(worker=worker, llm=llm)
        report = await master._aggregate_results("主查询", [])
        assert "未能获取" in report


# === 端到端测试 ===

class TestEndToEnd:

    @pytest.mark.asyncio
    async def test_full_flow(self):
        """完整流程：生成子任务 → 并行执行 → 聚合报告"""
        llm = mock_llm('["子查询A", "子查询B"]')
        worker = MockWorker(results={"summary": "研究结果"})
        master = MasterAgent(worker=worker, llm=llm)

        # 第二次 LLM 调用用于聚合
        llm.ainvoke.side_effect = [
            MagicMock(content='["子查询A", "子查询B"]'),
            MagicMock(content="最终综合报告"),
        ]

        result = await master.run("主查询")
        assert result["report"] == "最终综合报告"
        assert result["stats"]["total_tasks"] >= 2
        assert result["stats"]["successful"] >= 2
```

---

## 第 5 章 跨域关联

| 关联域 | 关系 | 说明 |
|--------|------|------|
| PD-01 上下文管理 | 输入 | 每个 Worker 的 LLM 调用需要上下文管理，避免超出 token 限制 |
| PD-02.01 DAG 编排 | 互补 | Master-Worker 是 DAG 的特例（fan-out/fan-in），可用 LangGraph Send API 实现 |
| PD-03 容错与重试 | 互补 | Worker 失败时的重试策略、Master 级别的降级 |
| PD-08 搜索与检索 | 集成 | Worker 内部使用多源并行搜索 |
| PD-11 可观测性 | 监控 | Worker 执行时间、成功率、成本需要追踪 |
| PD-12 推理增强 | 扩展 | 子查询生成可结合 CoT 推理提升质量 |

---

## 第 6 章 来源文件索引

| 编号 | 文件 | 说明 |
|------|------|------|
| S1 | `gpt_researcher/master/agent.py` | Master Agent — 子查询生成、Worker 分发、结果聚合 |
| S2 | `gpt_researcher/master/functions.py` | Master 辅助函数 — 报告生成、大纲规划 |
| S3 | `gpt_researcher/agent/research_agent.py` | Worker Agent — 单子查询完整研究流程 |
| S4 | `gpt_researcher/actions/query_processing.py` | 子查询生成逻辑 |
| S5 | `gpt_researcher/actions/web_scraping.py` | 网页抓取 |
| S6 | `gpt_researcher/retrievers/` | 搜索源适配器目录 |

