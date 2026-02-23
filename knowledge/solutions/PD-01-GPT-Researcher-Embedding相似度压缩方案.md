# PD-01.03 GPT-Researcher — Embedding 相似度压缩

> 文档编号：PD-01.03
> 来源：GPT-Researcher `gpt_researcher/context/compression.py` / `gpt_researcher/retrievers/`
> GitHub：https://github.com/assafelovic/gpt-researcher
> 问题域：PD-01 上下文管理 Context Window Management
> 状态：可复用方案

---

## 第 1 章 问题与动机

### 1.1 核心问题

RAG 管线从外部检索到的文档片段往往远超 LLM 上下文窗口容量。一个典型的深度研究任务可能从 5 个搜索源各返回 10 条结果，每条 500-2000 tokens，总计 25K-100K tokens 的原始上下文。直接拼接会导致：

1. **Context overflow** — 超出模型窗口限制，API 直接报错
2. **噪声淹没信号** — 大量低相关性片段稀释了真正有用的信息，模型输出质量下降
3. **成本浪费** — 每个无关 token 都在消耗 API 费用，且增加推理延迟

```
搜索源 A: 10 条结果 × ~1K tokens = ~10K tokens
搜索源 B: 10 条结果 × ~1K tokens = ~10K tokens
搜索源 C: 10 条结果 × ~1K tokens = ~10K tokens
────────────────────────────────────────────────
原始上下文总计: ~30K tokens
模型窗口 (GPT-4o): 128K tokens → 看似够用
实际可用 (85% 安全边际 - system prompt - 历史): ~60K tokens
加上多轮对话累积: 很快溢出
```

### 1.2 为什么 Embedding 相似度优于规则裁剪

MiroThinker（PD-01.01）的规则裁剪按消息类型和时间顺序丢弃内容，不理解语义。在 RAG 场景下，这种策略有明显缺陷：

| 维度 | 规则裁剪 | Embedding 相似度压缩 |
|------|----------|---------------------|
| 裁剪依据 | 消息类型 + 时间顺序 | 与查询的语义相关性 |
| 信息保留 | 保留最近的，丢弃最旧的 | 保留最相关的，丢弃最无关的 |
| RAG 适配 | 差 — 最新不等于最相关 | 好 — 直接按相关性排序 |
| Token 预算 | 粗粒度控制 | 精确到每个片段的 token 贡献 |
| 额外成本 | 零 | Embedding API 调用（$0.02/1M tokens） |

关键洞察：在 RAG 场景中，"最近"不等于"最相关"。第一条搜索结果可能比第十条更切题。Embedding 相似度让我们按语义相关性而非时间顺序选择要保留的内容。

### 1.3 GPT-Researcher 的解法概述

GPT-Researcher 在搜索结果进入 LLM 之前，插入一个 Embedding 相似度压缩层：

1. 将用户查询和每个文档片段分别生成 Embedding 向量
2. 计算查询与每个片段的 Cosine Similarity
3. 按相似度降序排列，选取 Top-K 片段
4. 在 Token Budget 内贪心填充，确保不超限

### 1.4 设计思想

| 原则 | 含义 | 体现 |
|------|------|------|
| 语义优先 | 按内容相关性而非位置裁剪 | Cosine Similarity 排序 |
| 预算感知 | 压缩结果严格不超过 token 预算 | 贪心填充 + token 计数 |
| 模型无关 | Embedding 模型可替换 | 抽象接口，支持 OpenAI / local 模型 |
| 渐进降级 | Embedding 不可用时回退到简单截断 | fallback 到 Top-N by position |

---

## 第 2 章 源码实现分析

### 2.1 压缩管线架构

GPT-Researcher 的上下文压缩位于 `gpt_researcher/context/compression.py`，在搜索结果送入 LLM 生成报告之前执行：

```
搜索结果 (N 个文档片段)
  │
  ▼
┌─────────────────────────────────────────────┐
│         ContextCompressor                    │
│                                             │
│  1. Embedding 生成                           │
│     query → query_embedding                 │
│     docs  → doc_embeddings[]                │
│                                             │
│  2. Cosine Similarity 计算                   │
│     similarity[i] = cos(query_emb, doc_emb) │
│                                             │
│  3. Top-K 选择 + Token Budget 填充           │
│     sorted by similarity DESC               │
│     greedy fill until budget exhausted       │
│                                             │
│  4. 输出压缩后的上下文                        │
└─────────────────────────────────────────────┘
  │
  ▼
LLM 生成报告 (压缩后的上下文 ≤ token budget)
```

### 2.2 Embedding 生成

GPT-Researcher 通过统一的 Embedding 接口支持多种模型：

```python
# 源码简化自 gpt_researcher/context/compression.py
import numpy as np
from typing import Union


class EmbeddingProvider:
    """Embedding 生成器，支持 OpenAI 和本地模型。"""

    def __init__(self, provider: str = "openai", model: str = "text-embedding-3-small"):
        self.provider = provider
        self.model = model

    async def embed_texts(self, texts: list[str]) -> list[list[float]]:
        """批量生成 Embedding 向量。

        Args:
            texts: 待编码的文本列表

        Returns:
            对应的 Embedding 向量列表，每个向量维度取决于模型
            text-embedding-3-small: 1536 维
            text-embedding-3-large: 3072 维
        """
        if self.provider == "openai":
            from openai import AsyncOpenAI
            client = AsyncOpenAI()
            response = await client.embeddings.create(
                input=texts,
                model=self.model,
            )
            return [item.embedding for item in response.data]
        else:
            # 本地模型 fallback（如 sentence-transformers）
            from sentence_transformers import SentenceTransformer
            local_model = SentenceTransformer(self.model)
            embeddings = local_model.encode(texts)
            return embeddings.tolist()
```

Embedding 模型选择对压缩质量有直接影响：

| 模型 | 维度 | 成本 | 质量 | 延迟 |
|------|------|------|------|------|
| `text-embedding-3-small` | 1536 | $0.02/1M tokens | 良好 | ~50ms |
| `text-embedding-3-large` | 3072 | $0.13/1M tokens | 优秀 | ~80ms |
| `text-embedding-ada-002` | 1536 | $0.10/1M tokens | 良好（旧版） | ~50ms |
| `all-MiniLM-L6-v2` (本地) | 384 | 免费 | 中等 | ~10ms |

GPT-Researcher 默认使用 `text-embedding-3-small`，在成本和质量之间取得平衡。

### 2.3 Cosine Similarity 计算

```python
# 源码简化自 compression.py — 相似度计算核心
def cosine_similarity(vec_a: list[float], vec_b: list[float]) -> float:
    """计算两个向量的余弦相似度。

    cos(A, B) = (A · B) / (||A|| × ||B||)

    返回值范围 [-1, 1]，1 表示完全相同方向，0 表示正交，-1 表示完全相反。
    在文本 Embedding 场景中，通常在 [0, 1] 范围内。
    """
    a = np.array(vec_a)
    b = np.array(vec_b)
    dot_product = np.dot(a, b)
    norm_a = np.linalg.norm(a)
    norm_b = np.linalg.norm(b)
    if norm_a == 0 or norm_b == 0:
        return 0.0
    return float(dot_product / (norm_a * norm_b))


def rank_by_similarity(
    query_embedding: list[float],
    doc_embeddings: list[list[float]],
    documents: list[str],
) -> list[tuple[str, float]]:
    """按与查询的相似度对文档排序。

    Returns:
        [(document_text, similarity_score), ...] 按相似度降序
    """
    scored = []
    for doc, emb in zip(documents, doc_embeddings):
        score = cosine_similarity(query_embedding, emb)
        scored.append((doc, score))
    scored.sort(key=lambda x: x[1], reverse=True)
    return scored
```

### 2.4 Top-K 选择与 Token Budget 填充

这是压缩管线的核心 — 在 token 预算内贪心选择最相关的文档片段：

```python
# 源码简化自 compression.py — Token Budget 感知的 Top-K 选择
def select_top_k_within_budget(
    ranked_docs: list[tuple[str, float]],
    token_budget: int,
    token_counter: callable,
    min_similarity: float = 0.3,
) -> list[tuple[str, float]]:
    """在 token 预算内选择最相关的文档片段。

    Args:
        ranked_docs: 按相似度降序排列的 (text, score) 列表
        token_budget: 最大允许的 token 总数
        token_counter: token 计数函数 (text -> int)
        min_similarity: 最低相似度阈值，低于此值直接丢弃

    Returns:
        选中的 (text, score) 列表
    """
    selected = []
    used_tokens = 0

    for doc_text, score in ranked_docs:
        # 相似度低于阈值，后续更低，直接停止
        if score < min_similarity:
            break

        doc_tokens = token_counter(doc_text)

        # 单个片段超过剩余预算，跳过（不截断，保持完整性）
        if used_tokens + doc_tokens > token_budget:
            continue

        selected.append((doc_text, score))
        used_tokens += doc_tokens

    return selected
```

### 2.5 完整压缩器

将上述组件组合为统一的 `ContextCompressor`：

```python
# 源码简化自 gpt_researcher/context/compression.py
class ContextCompressor:
    """Embedding 相似度上下文压缩器。

    将 N 个文档片段压缩为 token 预算内最相关的子集。
    """

    def __init__(
        self,
        embedding_provider: EmbeddingProvider,
        token_counter: callable,
        token_budget: int = 4000,
        min_similarity: float = 0.3,
    ):
        self.embedding_provider = embedding_provider
        self.token_counter = token_counter
        self.token_budget = token_budget
        self.min_similarity = min_similarity

    async def compress(
        self, query: str, documents: list[str]
    ) -> list[str]:
        """压缩文档列表，返回最相关的子集。

        Args:
            query: 用户查询
            documents: 待压缩的文档片段列表

        Returns:
            压缩后的文档列表（按相关性降序）
        """
        if not documents:
            return []

        # 1. 批量生成 Embedding（query + 所有文档一次调用）
        all_texts = [query] + documents
        embeddings = await self.embedding_provider.embed_texts(all_texts)
        query_embedding = embeddings[0]
        doc_embeddings = embeddings[1:]

        # 2. 按相似度排序
        ranked = rank_by_similarity(query_embedding, doc_embeddings, documents)

        # 3. Token Budget 内贪心选择
        selected = select_top_k_within_budget(
            ranked,
            token_budget=self.token_budget,
            token_counter=self.token_counter,
            min_similarity=self.min_similarity,
        )

        return [text for text, score in selected]
```

### 2.6 关键设计决策

| 决策 | GPT-Researcher 的选择 | 理由 |
|------|----------------------|------|
| Embedding 批量调用 | query + docs 合并为一次 API 调用 | 减少网络往返，降低延迟 |
| 相似度阈值 | 0.3（可配置） | 低于 0.3 的片段几乎无关，直接丢弃 |
| 片段完整性 | 不截断单个片段 | 截断可能破坏语义完整性 |
| 贪心填充 | 按相似度降序逐个填入 | 简单有效，保证最相关的片段优先入选 |
| Token 计数 | 复用 tiktoken | 与 LLM 调用的 token 计数一致 |

---

## 第 3 章 迁移指南

### 3.1 快速接入检查清单

```
[ ] 1. pip install openai numpy tiktoken
[ ] 2. 设置 OPENAI_API_KEY 环境变量
[ ] 3. 复制 context_compressor.py 到项目
[ ] 4. 在 RAG 管线中插入压缩步骤（搜索结果 → 压缩 → LLM）
[ ] 5. 配置 token_budget（建议为模型窗口的 30-50%）
[ ] 6. 配置 min_similarity（默认 0.3，严格场景可提高到 0.5）
[ ] 7. 运行测试套件确认通过
[ ] 8. 监控压缩率和相似度分布
```

### 3.2 适配代码

完整的可复用实现：

```python
"""
context_compressor.py — Embedding 相似度上下文压缩器

从 GPT-Researcher 提取的可复用方案。
依赖: pip install openai numpy tiktoken
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Protocol, Optional

import numpy as np

logger = logging.getLogger(__name__)


# ─── 协议定义 ───

class TokenCounter(Protocol):
    """Token 计数协议。"""
    def count(self, text: str) -> int: ...


class EmbeddingModel(Protocol):
    """Embedding 模型协议。"""
    async def embed(self, texts: list[str]) -> list[list[float]]: ...


# ─── 配置 ───

@dataclass
class CompressorConfig:
    """压缩器配置。"""

    token_budget: int = 4000
    """压缩后的最大 token 数。建议为模型窗口的 30-50%。"""

    min_similarity: float = 0.3
    """最低相似度阈值。低于此值的片段直接丢弃。"""

    embedding_model: str = "text-embedding-3-small"
    """Embedding 模型名称。"""

    batch_size: int = 100
    """Embedding API 单次批量上限。"""


# ─── Cosine Similarity ───

def cosine_similarity_matrix(
    query_vec: np.ndarray, doc_vecs: np.ndarray
) -> np.ndarray:
    """计算查询向量与文档向量矩阵的余弦相似度。

    Args:
        query_vec: shape (D,) 查询向量
        doc_vecs: shape (N, D) 文档向量矩阵

    Returns:
        shape (N,) 相似度数组
    """
    # 归一化
    query_norm = query_vec / (np.linalg.norm(query_vec) + 1e-10)
    doc_norms = doc_vecs / (
        np.linalg.norm(doc_vecs, axis=1, keepdims=True) + 1e-10
    )
    # 矩阵乘法一次算出所有相似度
    return doc_norms @ query_norm


# ─── Token Budget 选择器 ───

def select_within_budget(
    documents: list[str],
    scores: np.ndarray,
    token_counter: TokenCounter,
    token_budget: int,
    min_similarity: float = 0.3,
) -> list[tuple[str, float, int]]:
    """在 token 预算内选择最相关的文档。

    Returns:
        [(text, score, token_count), ...] 按相关性降序
    """
    # 按相似度降序排列的索引
    sorted_indices = np.argsort(scores)[::-1]

    selected = []
    used_tokens = 0

    for idx in sorted_indices:
        score = float(scores[idx])
        if score < min_similarity:
            break

        doc = documents[idx]
        doc_tokens = token_counter.count(doc)

        if used_tokens + doc_tokens > token_budget:
            continue  # 跳过超预算的片段，尝试更短的

        selected.append((doc, score, doc_tokens))
        used_tokens += doc_tokens

    logger.info(
        "压缩: %d → %d 片段, %d tokens (预算 %d)",
        len(documents), len(selected), used_tokens, token_budget,
    )
    return selected


# ─── 主压缩器 ───

class EmbeddingSimilarityCompressor:
    """Embedding 相似度上下文压缩器。

    用法:
        compressor = EmbeddingSimilarityCompressor(
            embedding_model=OpenAIEmbedding(),
            token_counter=TiktokenCounter(),
        )
        compressed = await compressor.compress("用户查询", documents)
    """

    def __init__(
        self,
        embedding_model: EmbeddingModel,
        token_counter: TokenCounter,
        config: Optional[CompressorConfig] = None,
    ):
        self.embedding_model = embedding_model
        self.token_counter = token_counter
        self.config = config or CompressorConfig()

    async def compress(
        self, query: str, documents: list[str]
    ) -> list[str]:
        """压缩文档列表。

        Args:
            query: 用户查询
            documents: 原始文档片段列表

        Returns:
            压缩后的文档列表（按相关性降序）
        """
        if not documents:
            return []

        # 1. 生成 Embedding
        all_texts = [query] + documents
        try:
            embeddings = await self.embedding_model.embed(all_texts)
        except Exception as e:
            logger.warning("Embedding 生成失败，降级到位置截断: %s", e)
            return self._fallback_truncate(documents)

        query_vec = np.array(embeddings[0])
        doc_vecs = np.array(embeddings[1:])

        # 2. 计算相似度
        scores = cosine_similarity_matrix(query_vec, doc_vecs)

        # 3. Token Budget 内选择
        selected = select_within_budget(
            documents,
            scores,
            self.token_counter,
            self.config.token_budget,
            self.config.min_similarity,
        )

        return [text for text, score, tokens in selected]

    async def compress_with_scores(
        self, query: str, documents: list[str]
    ) -> list[tuple[str, float]]:
        """压缩并返回相似度分数（用于调试和监控）。"""
        if not documents:
            return []

        all_texts = [query] + documents
        embeddings = await self.embedding_model.embed(all_texts)
        query_vec = np.array(embeddings[0])
        doc_vecs = np.array(embeddings[1:])
        scores = cosine_similarity_matrix(query_vec, doc_vecs)

        selected = select_within_budget(
            documents, scores, self.token_counter,
            self.config.token_budget, self.config.min_similarity,
        )
        return [(text, score) for text, score, tokens in selected]

    def _fallback_truncate(self, documents: list[str]) -> list[str]:
        """降级策略：Embedding 不可用时按位置截断。"""
        result = []
        used_tokens = 0
        for doc in documents:
            doc_tokens = self.token_counter.count(doc)
            if used_tokens + doc_tokens > self.config.token_budget:
                break
            result.append(doc)
            used_tokens += doc_tokens
        return result
```

### 3.3 场景适配矩阵

| 场景 | token_budget | min_similarity | embedding_model | 说明 |
|------|-------------|----------------|-----------------|------|
| 深度研究报告 | 8000 | 0.25 | text-embedding-3-small | 宽松阈值，保留更多上下文 |
| 精准问答 | 3000 | 0.5 | text-embedding-3-large | 严格阈值，只保留高相关片段 |
| 事实核查 | 5000 | 0.4 | text-embedding-3-small | 中等配置 |
| 成本敏感 | 4000 | 0.3 | all-MiniLM-L6-v2 (本地) | 零 API 成本 |
| 多语言 | 4000 | 0.3 | text-embedding-3-small | OpenAI 模型天然支持多语言 |

### 3.4 与 MiroThinker 方案的组合使用

两个方案解决不同层面的问题，可以组合：

```
RAG 搜索结果 (30K tokens)
  │
  ▼
Embedding 相似度压缩 (PD-01.03)     ← 语义层：选择最相关的片段
  │ 压缩到 ~8K tokens
  ▼
拼接到对话历史
  │
  ▼
tiktoken 分级裁剪 (PD-01.01)        ← 窗口层：确保总量不超限
  │ 确保 ≤ 85% 窗口
  ▼
LLM 调用
```

---

## 第 4 章 测试用例

```python
"""
test_embedding_compressor.py — Embedding 相似度压缩器完整测试套件

运行: pytest test_embedding_compressor.py -v
依赖: pip install pytest pytest-asyncio numpy
"""

import pytest
import numpy as np
from unittest.mock import AsyncMock, MagicMock
from context_compressor import (
    EmbeddingSimilarityCompressor,
    CompressorConfig,
    cosine_similarity_matrix,
    select_within_budget,
)


# ─── 测试用 Mock ───

class MockTokenCounter:
    """简单的 token 计数器 Mock：每 4 个字符 = 1 token。"""

    def count(self, text: str) -> int:
        return max(1, len(text) // 4)


class MockEmbeddingModel:
    """可控的 Embedding 模型 Mock。"""

    def __init__(self, embeddings: list[list[float]] | None = None):
        self._embeddings = embeddings
        self._call_count = 0

    async def embed(self, texts: list[str]) -> list[list[float]]:
        self._call_count += 1
        if self._embeddings is not None:
            return self._embeddings
        # 默认：为每个文本生成随机向量
        return [np.random.randn(128).tolist() for _ in texts]


def make_similar_embeddings(
    query_vec: list[float],
    n_docs: int,
    similarities: list[float],
) -> list[list[float]]:
    """构造具有指定相似度的 Embedding 向量。

    通过在 query 方向上混合随机向量来控制相似度。
    """
    query = np.array(query_vec)
    query_norm = query / np.linalg.norm(query)
    result = [query_vec]  # 第一个是 query 本身

    for sim in similarities:
        # 构造一个与 query 有指定相似度的向量
        random_vec = np.random.randn(len(query_vec))
        # 正交化
        random_vec = random_vec - np.dot(random_vec, query_norm) * query_norm
        random_vec = random_vec / (np.linalg.norm(random_vec) + 1e-10)
        # 混合
        doc_vec = sim * query_norm + np.sqrt(1 - sim**2) * random_vec
        result.append(doc_vec.tolist())

    return result


# ─── 4.1 Cosine Similarity 测试 ───

class TestCosineSimilarity:
    """余弦相似度计算测试。"""

    def test_identical_vectors(self):
        """相同向量的相似度为 1.0。"""
        vec = np.array([1.0, 2.0, 3.0])
        scores = cosine_similarity_matrix(vec, vec.reshape(1, -1))
        assert abs(scores[0] - 1.0) < 1e-6

    def test_orthogonal_vectors(self):
        """正交向量的相似度为 0.0。"""
        a = np.array([1.0, 0.0, 0.0])
        b = np.array([[0.0, 1.0, 0.0]])
        scores = cosine_similarity_matrix(a, b)
        assert abs(scores[0]) < 1e-6

    def test_opposite_vectors(self):
        """反向向量的相似度为 -1.0。"""
        a = np.array([1.0, 0.0])
        b = np.array([[-1.0, 0.0]])
        scores = cosine_similarity_matrix(a, b)
        assert abs(scores[0] - (-1.0)) < 1e-6

    def test_batch_computation(self):
        """批量计算多个文档的相似度。"""
        query = np.array([1.0, 0.0, 0.0])
        docs = np.array([
            [1.0, 0.0, 0.0],   # 相同 → 1.0
            [0.0, 1.0, 0.0],   # 正交 → 0.0
            [0.707, 0.707, 0.0],  # 45度 → ~0.707
        ])
        scores = cosine_similarity_matrix(query, docs)
        assert len(scores) == 3
        assert abs(scores[0] - 1.0) < 1e-5
        assert abs(scores[1]) < 1e-5
        assert abs(scores[2] - 0.707) < 0.01

    def test_zero_vector_handling(self):
        """零向量不导致除零错误。"""
        query = np.array([1.0, 2.0])
        zero_doc = np.array([[0.0, 0.0]])
        scores = cosine_similarity_matrix(query, zero_doc)
        assert not np.isnan(scores[0])

    def test_high_dimensional(self):
        """高维向量（1536 维，模拟 text-embedding-3-small）。"""
        query = np.random.randn(1536)
        docs = np.random.randn(50, 1536)
        scores = cosine_similarity_matrix(query, docs)
        assert scores.shape == (50,)
        assert all(-1.0 <= s <= 1.0 for s in scores)


# ─── 4.2 Token Budget 选择器测试 ───

class TestSelectWithinBudget:
    """Token Budget 感知选择测试。"""

    def setup_method(self):
        self.counter = MockTokenCounter()

    def test_all_fit_within_budget(self):
        """所有文档都在预算内时全部选中。"""
        docs = ["short doc"] * 5
        scores = np.array([0.9, 0.8, 0.7, 0.6, 0.5])
        selected = select_within_budget(docs, scores, self.counter, token_budget=1000)
        assert len(selected) == 5

    def test_budget_limits_selection(self):
        """预算不足时只选择最相关的子集。"""
        docs = ["x" * 100] * 10  # 每个 ~25 tokens
        scores = np.array([0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.35, 0.33, 0.32, 0.31])
        selected = select_within_budget(docs, scores, self.counter, token_budget=60)
        assert len(selected) < 10
        # 选中的应该是相似度最高的
        selected_scores = [s for _, s, _ in selected]
        assert selected_scores == sorted(selected_scores, reverse=True)

    def test_min_similarity_filter(self):
        """低于最低相似度阈值的文档被过滤。"""
        docs = ["doc1", "doc2", "doc3"]
        scores = np.array([0.8, 0.4, 0.1])
        selected = select_within_budget(
            docs, scores, self.counter, token_budget=1000, min_similarity=0.5
        )
        assert len(selected) == 1
        assert selected[0][1] == 0.8

    def test_empty_documents(self):
        """空文档列表返回空结果。"""
        selected = select_within_budget([], np.array([]), self.counter, token_budget=1000)
        assert selected == []

    def test_skip_large_doc_take_smaller(self):
        """跳过超预算的大文档，选择更小的高相关文档。"""
        docs = ["x" * 400, "y" * 40, "z" * 40]  # 100, 10, 10 tokens
        scores = np.array([0.9, 0.85, 0.8])
        selected = select_within_budget(docs, scores, self.counter, token_budget=25)
        # 第一个太大（100 tokens），应该跳过，选第二和第三个
        assert len(selected) == 2
        texts = [t for t, _, _ in selected]
        assert "y" * 40 in texts

    def test_order_by_similarity_desc(self):
        """结果按相似度降序排列。"""
        docs = [f"doc{i}" for i in range(5)]
        scores = np.array([0.3, 0.9, 0.5, 0.7, 0.4])
        selected = select_within_budget(docs, scores, self.counter, token_budget=1000)
        selected_scores = [s for _, s, _ in selected]
        assert selected_scores == sorted(selected_scores, reverse=True)


# ─── 4.3 EmbeddingSimilarityCompressor 集成测试 ───

class TestEmbeddingSimilarityCompressor:
    """压缩器端到端测试。"""

    @pytest.mark.asyncio
    async def test_compress_basic(self):
        """基本压缩流程。"""
        query_vec = [1.0, 0.0, 0.0, 0.0]
        embeddings = make_similar_embeddings(
            query_vec, n_docs=5,
            similarities=[0.95, 0.8, 0.6, 0.3, 0.1],
        )
        model = MockEmbeddingModel(embeddings)
        counter = MockTokenCounter()
        config = CompressorConfig(token_budget=1000, min_similarity=0.2)
        compressor = EmbeddingSimilarityCompressor(model, counter, config)

        docs = [f"Document {i} content here" for i in range(5)]
        result = await compressor.compress("test query", docs)

        assert len(result) > 0
        assert len(result) <= 5

    @pytest.mark.asyncio
    async def test_compress_empty_documents(self):
        """空文档列表返回空。"""
        model = MockEmbeddingModel()
        counter = MockTokenCounter()
        compressor = EmbeddingSimilarityCompressor(model, counter)

        result = await compressor.compress("query", [])
        assert result == []

    @pytest.mark.asyncio
    async def test_compress_respects_token_budget(self):
        """压缩结果不超过 token 预算。"""
        # 每个文档 ~50 tokens，预算 120 tokens → 最多 2-3 个
        docs = ["x" * 200] * 10
        embeddings = [np.random.randn(64).tolist() for _ in range(11)]
        model = MockEmbeddingModel(embeddings)
        counter = MockTokenCounter()
        config = CompressorConfig(token_budget=120, min_similarity=0.0)
        compressor = EmbeddingSimilarityCompressor(model, counter, config)

        result = await compressor.compress("query", docs)
        total_tokens = sum(counter.count(doc) for doc in result)
        assert total_tokens <= 120

    @pytest.mark.asyncio
    async def test_compress_with_scores(self):
        """compress_with_scores 返回分数。"""
        query_vec = [1.0, 0.0, 0.0, 0.0]
        embeddings = make_similar_embeddings(
            query_vec, n_docs=3,
            similarities=[0.9, 0.5, 0.2],
        )
        model = MockEmbeddingModel(embeddings)
        counter = MockTokenCounter()
        config = CompressorConfig(token_budget=1000, min_similarity=0.1)
        compressor = EmbeddingSimilarityCompressor(model, counter, config)

        docs = ["doc1", "doc2", "doc3"]
        result = await compressor.compress_with_scores("query", docs)

        assert all(isinstance(item, tuple) and len(item) == 2 for item in result)
        scores = [score for _, score in result]
        assert scores == sorted(scores, reverse=True)

    @pytest.mark.asyncio
    async def test_fallback_on_embedding_failure(self):
        """Embedding 失败时降级到位置截断。"""
        model = MockEmbeddingModel()
        model.embed = AsyncMock(side_effect=ConnectionError("API 不可用"))
        counter = MockTokenCounter()
        config = CompressorConfig(token_budget=50)
        compressor = EmbeddingSimilarityCompressor(model, counter, config)

        docs = [f"doc{i} " * 10 for i in range(10)]
        result = await compressor.compress("query", docs)

        # 应该返回结果（降级到位置截断），不抛异常
        assert isinstance(result, list)
        total_tokens = sum(counter.count(doc) for doc in result)
        assert total_tokens <= 50

    @pytest.mark.asyncio
    async def test_single_embedding_call(self):
        """query + docs 合并为一次 Embedding 调用。"""
        model = MockEmbeddingModel()
        counter = MockTokenCounter()
        compressor = EmbeddingSimilarityCompressor(model, counter)

        docs = ["doc1", "doc2", "doc3"]
        await compressor.compress("query", docs)

        assert model._call_count == 1  # 只调用一次
```

---

## 第 5 章 跨域关联

| 关联域 | 关系 | 说明 |
|--------|------|------|
| PD-01.01 MiroThinker tiktoken 裁剪 | 互补 | 本方案处理 RAG 语义压缩，MiroThinker 处理窗口级裁剪。两者可串联使用 |
| PD-01.02 DeerFlow LLM 摘要压缩 | 替代/互补 | LLM 摘要保留语义更好但成本更高。可在 Embedding 压缩后对 Top-K 结果做 LLM 摘要 |
| PD-08 搜索与检索 | 上游 | 搜索结果是本方案的输入。PD-08.01 的多源并行搜索产出大量结果，需要本方案压缩 |
| PD-06 记忆持久化 | 互补 | Embedding 向量可缓存到向量数据库，避免重复计算 |
| PD-11 可观测性 | 输入 | 压缩率、相似度分布、Embedding API 调用次数需要追踪 |
| PD-03 容错与重试 | 互补 | Embedding API 调用失败时需要重试机制，或降级到位置截断 |

### 与 PD-01 其他方案的定位对比

```
精确度低 ◄──────────────────────────────────────► 精确度高
成本低                                              成本高

PD-01.01 MiroThinker        PD-01.03 GPT-Researcher    PD-01.02 DeerFlow
规则裁剪                     Embedding 相似度            LLM 摘要
(按类型+时间)                (按语义相关性)              (按语义理解)
零额外成本                   Embedding API 成本          LLM API 成本
微秒级                       毫秒级                     秒级
```

推荐组合策略：

1. 入口层：PD-01.03 Embedding 压缩 — 从 30K tokens 的搜索结果中选出 8K 最相关片段
2. 窗口层：PD-01.01 tiktoken 裁剪 — 确保总上下文不超过模型窗口的 85%
3. 可选增强：PD-01.02 LLM 摘要 — 对关键片段做进一步语义压缩

---

## 第 6 章 来源文件索引

| 编号 | 文件 | 说明 |
|------|------|------|
| S1 | `gpt_researcher/context/compression.py` | 上下文压缩核心 — Embedding 生成 + 相似度计算 + Top-K 选择 |
| S2 | `gpt_researcher/context/retriever.py` | 检索器 — 调用压缩器处理搜索结果 |
| S3 | `gpt_researcher/retrievers/` | 搜索源适配器目录（压缩器的上游输入） |
| S4 | `gpt_researcher/master/agent.py` | Master Agent — 在 conduct_research() 中调用压缩 |
| S5 | `gpt_researcher/config/config.py` | 配置 — Embedding 模型选择、token budget 等参数 |
| S6 | `gpt_researcher/utils/costs.py` | 成本追踪 — 记录 Embedding API 调用费用 |
