# PD-08.02 DeepResearch — 树状搜索 + 知识图谱

> 文档编号：PD-08.02
> 来源：DeepResearch `src/search_tree.py` / `src/knowledge_graph.py`
> GitHub：https://github.com/Alibaba-NLP/DeepResearch
> 问题域：PD-08 搜索与检索 Search & Retrieval
> 状态：可复用方案

---

## 第 1 章 问题与动机

### 1.1 核心问题

传统的线性搜索（查询 → 结果列表）无法处理需要多层推理的复杂研究问题：

```
"量子计算对密码学的影响"
  → 线性搜索：返回 10 篇概述文章，缺乏深度
  → 树状搜索：
      ├── "量子计算当前进展" → 发现 Shor 算法
      │   ├── "Shor 算法对 RSA 的威胁" → 具体攻击场景
      │   └── "Shor 算法实现进展" → 硬件限制
      ├── "后量子密码学标准" → NIST PQC 标准
      │   ├── "CRYSTALS-Kyber 算法" → 格密码
      │   └── "SPHINCS+ 签名" → 哈希签名
      └── "量子密钥分发 QKD" → 物理层安全
```

树状搜索的优势：每一层搜索基于上一层的发现，逐步深入，覆盖面和深度远超线性搜索。

### 1.2 DeepResearch 的解法概述

DeepResearch 采用树状搜索 + 知识图谱构建：

- **搜索树**：根节点是原始查询，每个节点的搜索结果生成子节点（子查询）
- **知识图谱**：从搜索结果中提取实体和关系，构建知识网络
- **关系推理**：基于知识图谱发现隐含关联，生成新的搜索方向
- **搜索可视化**：树结构天然支持搜索过程的可视化展示

### 1.3 设计思想

| 原则 | 说明 |
|------|------|
| 深度优先 | 沿有价值的分支深入，而非广度扫描 |
| 知识驱动 | 搜索方向由已获取的知识决定，而非预设 |
| 图谱积累 | 每次搜索都丰富知识图谱，后续搜索更精准 |
| 剪枝控制 | 低相关性分支及时剪枝，控制搜索成本 |
| 可追溯 | 树结构记录完整搜索路径，支持回溯和解释 |

---

## 第 2 章 源码实现分析

### 2.1 搜索树结构

```python
# 源码简化自 DeepResearch src/search_tree.py
from dataclasses import dataclass, field
from typing import Optional
import uuid


@dataclass
class SearchNode:
    """搜索树节点"""
    id: str = field(default_factory=lambda: str(uuid.uuid4())[:8])
    query: str = ""
    depth: int = 0
    parent_id: Optional[str] = None
    children: list["SearchNode"] = field(default_factory=list)
    results: list[dict] = field(default_factory=list)
    entities: list[dict] = field(default_factory=list)
    relevance_score: float = 0.0
    status: str = "pending"  # pending | searching | completed | pruned


class SearchTree:
    """搜索树管理器"""

    def __init__(self, root_query: str, max_depth: int = 3,
                 max_children: int = 3, min_relevance: float = 0.3):
        self.root = SearchNode(query=root_query, depth=0, status="pending")
        self.max_depth = max_depth
        self.max_children = max_children
        self.min_relevance = min_relevance
        self._nodes: dict[str, SearchNode] = {self.root.id: self.root}

    def add_child(self, parent_id: str, query: str,
                  relevance: float = 0.0) -> SearchNode | None:
        """添加子节点，低相关性自动剪枝"""
        parent = self._nodes.get(parent_id)
        if not parent or parent.depth >= self.max_depth:
            return None
        if len(parent.children) >= self.max_children:
            return None
        if relevance < self.min_relevance:
            return None  # 剪枝

        child = SearchNode(
            query=query, depth=parent.depth + 1,
            parent_id=parent_id, relevance_score=relevance,
        )
        parent.children.append(child)
        self._nodes[child.id] = child
        return child

    def get_pending_nodes(self) -> list[SearchNode]:
        """获取待搜索的节点（BFS 或 DFS）"""
        return [n for n in self._nodes.values() if n.status == "pending"]

    def get_path(self, node_id: str) -> list[SearchNode]:
        """获取从根到指定节点的路径"""
        path = []
        current = self._nodes.get(node_id)
        while current:
            path.append(current)
            current = self._nodes.get(current.parent_id) if current.parent_id else None
        return list(reversed(path))

    def to_dict(self) -> dict:
        """序列化为字典（用于可视化）"""
        def _serialize(node: SearchNode) -> dict:
            return {
                "id": node.id, "query": node.query,
                "depth": node.depth, "status": node.status,
                "relevance": node.relevance_score,
                "results_count": len(node.results),
                "entities_count": len(node.entities),
                "children": [_serialize(c) for c in node.children],
            }
        return _serialize(self.root)
```

### 2.2 知识图谱构建

```python
# 源码简化自 DeepResearch src/knowledge_graph.py
from dataclasses import dataclass, field
from collections import defaultdict


@dataclass
class Entity:
    """知识实体"""
    name: str
    entity_type: str  # person, technology, concept, organization
    mentions: int = 1
    properties: dict = field(default_factory=dict)


@dataclass
class Relation:
    """实体关系"""
    source: str  # 源实体名
    target: str  # 目标实体名
    relation_type: str  # uses, affects, part_of, competes_with
    confidence: float = 0.0
    evidence: str = ""


class KnowledgeGraph:
    """知识图谱 — 从搜索结果中提取实体和关系"""

    def __init__(self):
        self.entities: dict[str, Entity] = {}
        self.relations: list[Relation] = []
        self._adjacency: dict[str, list[str]] = defaultdict(list)

    def add_entity(self, name: str, entity_type: str, **props) -> Entity:
        if name in self.entities:
            self.entities[name].mentions += 1
            self.entities[name].properties.update(props)
        else:
            self.entities[name] = Entity(
                name=name, entity_type=entity_type, properties=props
            )
        return self.entities[name]

    def add_relation(self, source: str, target: str,
                     relation_type: str, confidence: float = 0.0,
                     evidence: str = "") -> Relation:
        rel = Relation(
            source=source, target=target,
            relation_type=relation_type,
            confidence=confidence, evidence=evidence,
        )
        self.relations.append(rel)
        self._adjacency[source].append(target)
        return rel

    def get_related_entities(self, entity_name: str, depth: int = 1) -> set[str]:
        """获取 N 度关联实体"""
        visited = set()
        queue = [(entity_name, 0)]
        while queue:
            current, d = queue.pop(0)
            if current in visited or d > depth:
                continue
            visited.add(current)
            for neighbor in self._adjacency.get(current, []):
                queue.append((neighbor, d + 1))
        visited.discard(entity_name)
        return visited

    def suggest_queries(self, focus_entity: str, max_suggestions: int = 3) -> list[str]:
        """基于图谱关系推荐新的搜索查询"""
        related = self.get_related_entities(focus_entity, depth=2)
        suggestions = []
        for rel in self.relations:
            if rel.source == focus_entity or rel.target == focus_entity:
                other = rel.target if rel.source == focus_entity else rel.source
                suggestions.append(
                    f"{focus_entity} {rel.relation_type} {other}"
                )
        return suggestions[:max_suggestions]

    def get_stats(self) -> dict:
        return {
            "entities": len(self.entities),
            "relations": len(self.relations),
            "top_entities": sorted(
                self.entities.values(),
                key=lambda e: e.mentions, reverse=True
            )[:10],
        }
```

### 2.3 实体提取（LLM 驱动）

```python
# 源码简化自 DeepResearch
async def extract_entities_and_relations(
    text: str, llm, existing_entities: list[str] = None
) -> dict:
    """LLM 从文本中提取实体和关系"""
    existing = ", ".join(existing_entities[:20]) if existing_entities else "无"

    prompt = f"""从以下文本中提取实体和关系。

已知实体: {existing}

文本:
{text[:3000]}

返回 JSON:
{{
  "entities": [{{"name": "...", "type": "person|technology|concept|organization"}}],
  "relations": [{{"source": "...", "target": "...", "type": "uses|affects|part_of|competes_with", "evidence": "..."}}]
}}"""

    response = await llm.ainvoke(prompt)
    try:
        return json.loads(response.content)
    except json.JSONDecodeError:
        return {"entities": [], "relations": []}
```

### 2.4 树状搜索引擎

```python
"""tree_search_engine.py — 树状搜索引擎"""
import asyncio
import logging
from typing import Any

logger = logging.getLogger(__name__)


class TreeSearchEngine:
    """树状搜索引擎 — 递归搜索 + 知识图谱构建"""

    def __init__(self, search_source, llm, max_depth=3,
                 max_children=3, min_relevance=0.3):
        self.search_source = search_source
        self.llm = llm
        self.graph = KnowledgeGraph()
        self.tree: SearchTree | None = None
        self.max_depth = max_depth
        self.max_children = max_children
        self.min_relevance = min_relevance

    async def research(self, query: str) -> dict:
        """执行完整的树状搜索研究"""
        self.tree = SearchTree(
            query, self.max_depth, self.max_children, self.min_relevance
        )

        # BFS 逐层搜索
        while True:
            pending = self.tree.get_pending_nodes()
            if not pending:
                break

            # 并行搜索当前层所有待处理节点
            tasks = [self._process_node(node) for node in pending]
            await asyncio.gather(*tasks, return_exceptions=True)

        return {
            "tree": self.tree.to_dict(),
            "graph": self.graph.get_stats(),
            "total_nodes": len(self.tree._nodes),
        }

    async def _process_node(self, node: SearchNode):
        """处理单个搜索节点"""
        node.status = "searching"

        try:
            # 1. 搜索
            results = await self.search_source.search(node.query)
            node.results = results

            # 2. 提取实体和关系
            text = "\n".join(r.get("snippet", "") for r in results[:5])
            extracted = await extract_entities_and_relations(
                text, self.llm,
                list(self.graph.entities.keys()),
            )

            for e in extracted.get("entities", []):
                self.graph.add_entity(e["name"], e.get("type", "concept"))
                node.entities.append(e)

            for r in extracted.get("relations", []):
                self.graph.add_relation(
                    r["source"], r["target"],
                    r.get("type", "related"),
                    confidence=0.5,
                    evidence=r.get("evidence", ""),
                )

            # 3. 生成子查询
            if node.depth < self.max_depth:
                sub_queries = await self._generate_sub_queries(node)
                for sq, score in sub_queries:
                    self.tree.add_child(node.id, sq, relevance=score)

            node.status = "completed"

        except Exception as e:
            logger.error(f"节点 {node.id} 处理失败: {e}")
            node.status = "pruned"

    async def _generate_sub_queries(
        self, node: SearchNode
    ) -> list[tuple[str, float]]:
        """基于搜索结果和知识图谱生成子查询"""
        # 方式 1: 基于知识图谱推荐
        graph_suggestions = []
        for entity in node.entities[:3]:
            suggestions = self.graph.suggest_queries(entity["name"])
            graph_suggestions.extend(suggestions)

        # 方式 2: LLM 生成
        context = "\n".join(r.get("snippet", "")[:200] for r in node.results[:5])
        prompt = f"""基于以下搜索结果，生成 {self.max_children} 个更深入的子查询。

原始查询: {node.query}
搜索结果摘要:
{context}

已知实体: {', '.join(e['name'] for e in node.entities[:10])}

返回 JSON: [{{"query": "...", "relevance": 0.0-1.0}}]"""

        response = await self.llm.ainvoke(prompt)
        try:
            items = json.loads(response.content)
            return [(item["query"], item.get("relevance", 0.5)) for item in items]
        except (json.JSONDecodeError, KeyError):
            # 降级：使用图谱推荐
            return [(q, 0.5) for q in graph_suggestions[:self.max_children]]
```

### 2.5 关键设计决策

| 决策 | DeepResearch 的选择 | 理由 |
|------|---------------------|------|
| 搜索策略 | BFS（逐层） | 保证每层都有结果后再深入 |
| 子查询生成 | LLM + 知识图谱双驱动 | LLM 灵活，图谱精准 |
| 剪枝策略 | 相关性阈值 | 低于 0.3 的分支不展开 |
| 实体提取 | LLM 驱动 | 灵活处理各种文本格式 |
| 图谱存储 | 内存 | 单次研究的图谱规模可控 |

---

## 第 3 章 可复用方案设计

### 3.1 配置参数

| 参数 | 默认值 | 说明 | 调优建议 |
|------|--------|------|----------|
| `max_depth` | 3 | 搜索树最大深度 | 2-4，过深成本指数增长 |
| `max_children` | 3 | 每节点最大子节点数 | 2-5 |
| `min_relevance` | 0.3 | 剪枝阈值 | 0.2-0.5 |
| `entity_extraction` | True | 是否提取实体 | 不需要图谱时关闭 |

### 3.2 成本模型

```
搜索树成本（max_depth=3, max_children=3）:
  深度 0: 1 节点 × 1 搜索 + 1 LLM = 2 次调用
  深度 1: 3 节点 × (1 搜索 + 1 LLM) = 6 次调用
  深度 2: 9 节点 × (1 搜索 + 1 LLM) = 18 次调用
  深度 3: 27 节点 × (1 搜索 + 1 LLM) = 54 次调用
  总计: 80 次调用（实际因剪枝会更少）
```

---

## 第 4 章 测试用例

```python
"""test_tree_search.py — 树状搜索与知识图谱测试"""
import pytest
from unittest.mock import AsyncMock, MagicMock


# === 搜索树测试 ===

class TestSearchTree:

    def test_create_root(self):
        tree = SearchTree("root query", max_depth=3)
        assert tree.root.query == "root query"
        assert tree.root.depth == 0

    def test_add_child(self):
        tree = SearchTree("root", max_depth=3)
        child = tree.add_child(tree.root.id, "child query", relevance=0.8)
        assert child is not None
        assert child.depth == 1
        assert child.parent_id == tree.root.id
        assert len(tree.root.children) == 1

    def test_max_depth_prevents_child(self):
        tree = SearchTree("root", max_depth=1)
        child = tree.add_child(tree.root.id, "child", relevance=0.8)
        assert child is not None
        grandchild = tree.add_child(child.id, "grandchild", relevance=0.8)
        assert grandchild is None  # 超过最大深度

    def test_max_children_limit(self):
        tree = SearchTree("root", max_depth=3, max_children=2)
        tree.add_child(tree.root.id, "c1", relevance=0.8)
        tree.add_child(tree.root.id, "c2", relevance=0.7)
        c3 = tree.add_child(tree.root.id, "c3", relevance=0.9)
        assert c3 is None  # 超过最大子节点数

    def test_low_relevance_pruned(self):
        tree = SearchTree("root", max_depth=3, min_relevance=0.5)
        child = tree.add_child(tree.root.id, "low", relevance=0.2)
        assert child is None  # 低相关性被剪枝

    def test_get_pending_nodes(self):
        tree = SearchTree("root", max_depth=3)
        assert len(tree.get_pending_nodes()) == 1  # 只有 root
        tree.root.status = "completed"
        tree.add_child(tree.root.id, "c1", relevance=0.8)
        assert len(tree.get_pending_nodes()) == 1  # 只有 c1

    def test_get_path(self):
        tree = SearchTree("root", max_depth=3)
        child = tree.add_child(tree.root.id, "child", relevance=0.8)
        grandchild = tree.add_child(child.id, "grandchild", relevance=0.7)
        path = tree.get_path(grandchild.id)
        assert len(path) == 3
        assert path[0].query == "root"
        assert path[2].query == "grandchild"

    def test_to_dict(self):
        tree = SearchTree("root", max_depth=3)
        tree.add_child(tree.root.id, "child", relevance=0.8)
        d = tree.to_dict()
        assert d["query"] == "root"
        assert len(d["children"]) == 1


# === 知识图谱测试 ===

class TestKnowledgeGraph:

    def test_add_entity(self):
        kg = KnowledgeGraph()
        e = kg.add_entity("Python", "technology")
        assert e.name == "Python"
        assert e.mentions == 1

    def test_duplicate_entity_increments_mentions(self):
        kg = KnowledgeGraph()
        kg.add_entity("Python", "technology")
        kg.add_entity("Python", "technology")
        assert kg.entities["Python"].mentions == 2

    def test_add_relation(self):
        kg = KnowledgeGraph()
        kg.add_entity("Python", "technology")
        kg.add_entity("Django", "technology")
        rel = kg.add_relation("Django", "Python", "uses")
        assert rel.source == "Django"
        assert rel.relation_type == "uses"

    def test_get_related_entities(self):
        kg = KnowledgeGraph()
        kg.add_entity("A", "concept")
        kg.add_entity("B", "concept")
        kg.add_entity("C", "concept")
        kg.add_relation("A", "B", "related")
        kg.add_relation("B", "C", "related")

        related_1 = kg.get_related_entities("A", depth=1)
        assert "B" in related_1
        assert "C" not in related_1

        related_2 = kg.get_related_entities("A", depth=2)
        assert "B" in related_2
        assert "C" in related_2

    def test_suggest_queries(self):
        kg = KnowledgeGraph()
        kg.add_entity("RSA", "technology")
        kg.add_entity("Shor", "technology")
        kg.add_relation("Shor", "RSA", "affects")
        suggestions = kg.suggest_queries("RSA")
        assert len(suggestions) >= 1

    def test_empty_graph_stats(self):
        kg = KnowledgeGraph()
        stats = kg.get_stats()
        assert stats["entities"] == 0
        assert stats["relations"] == 0


# === 实体提取测试 ===

class TestEntityExtraction:

    @pytest.mark.asyncio
    async def test_extract_entities(self):
        llm = AsyncMock()
        llm.ainvoke.return_value = MagicMock(content=json.dumps({
            "entities": [
                {"name": "Python", "type": "technology"},
                {"name": "Guido", "type": "person"},
            ],
            "relations": [
                {"source": "Guido", "target": "Python",
                 "type": "uses", "evidence": "creator"},
            ],
        }))
        result = await extract_entities_and_relations("text", llm)
        assert len(result["entities"]) == 2
        assert len(result["relations"]) == 1

    @pytest.mark.asyncio
    async def test_invalid_json_returns_empty(self):
        llm = AsyncMock()
        llm.ainvoke.return_value = MagicMock(content="not json")
        result = await extract_entities_and_relations("text", llm)
        assert result["entities"] == []
        assert result["relations"] == []
```

---

## 第 5 章 跨域关联

| 关联域 | 关系 | 说明 |
|--------|------|------|
| PD-01 上下文管理 | 输入 | 搜索结果需裁剪后放入 LLM 上下文 |
| PD-02 多 Agent 编排 | 架构 | 树状搜索可作为 DAG 图的子流程 |
| PD-03 容错与重试 | 互补 | 节点搜索失败时标记为 pruned |
| PD-08.01 多源并行搜索 | 集成 | 每个树节点内部可使用多源并行搜索 |
| PD-12 推理增强 | 核心 | 知识图谱驱动的搜索方向推理 |

---

## 第 6 章 来源文件索引

| 编号 | 文件 | 说明 |
|------|------|------|
| S1 | `src/search_tree.py` | 搜索树结构与管理 |
| S2 | `src/knowledge_graph.py` | 知识图谱构建与查询 |
| S3 | `src/entity_extractor.py` | LLM 驱动的实体提取 |
| S4 | `src/llm_client.py` | LLM 客户端封装 |
| S5 | `config.py` | 搜索深度、剪枝阈值配置 |
