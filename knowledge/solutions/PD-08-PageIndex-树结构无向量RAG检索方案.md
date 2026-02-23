# PD-08.04 PageIndex — 树结构无向量 RAG 检索方案

> 文档编号：PD-08.04
> 来源：PageIndex `pageindex/page_index.py`, `pageindex/page_index_md.py`, `pageindex/utils.py`
> GitHub：https://github.com/VectifyAI/PageIndex.git
> 问题域：PD-08 搜索与检索 Search & Retrieval
> 状态：可复用方案

---

## 第 1 章 问题与动机

### 1.1 核心问题

传统 RAG 系统依赖向量数据库进行语义相似度检索，存在三个根本性缺陷：

1. **相似度 ≠ 相关性**：向量 embedding 捕捉的是语义距离，而非逻辑相关性。对于需要领域专业知识和多步推理的专业文档（金融报告、法律文件、学术论文），相似度搜索经常失败。
2. **人工分块破坏文档结构**：chunking 将文档切割为固定大小的片段，破坏了章节、段落之间的层次关系和上下文连贯性。
3. **检索过程不可解释**：top-K 向量搜索是一个黑盒过程（"vibe retrieval"），无法追溯为什么选择了某个片段。

PageIndex 提出了一种全新的范式：**Vectorless Reasoning-based RAG**——用文档的层次化树结构索引替代向量数据库，用 LLM 推理替代向量相似度搜索。

### 1.2 PageIndex 的解法概述

1. **树结构索引生成**：将 PDF/Markdown 文档解析为层次化树结构（类似增强版目录），每个节点包含标题、页码范围、摘要（`pageindex/page_index.py:1021-1055`）
2. **LLM 驱动的树搜索检索**：给定查询，LLM 通过推理在树结构上导航，选择最相关的节点，而非通过向量距离匹配（`cookbook/pageindex_RAG_simple.ipynb` Step 2）
3. **递归大节点处理**：对超过 token 阈值的大节点，递归构建子树以保持细粒度（`pageindex/page_index.py:992-1019`）
4. **多路径 TOC 检测**：自动检测文档是否包含目录、目录是否有页码，选择最优解析路径（`pageindex/page_index.py:688-724`）
5. **验证-修复闭环**：解析后通过 LLM 验证每个节点的页码准确性，不准确的自动修复（`pageindex/page_index.py:892-944`）

### 1.3 设计思想

| 设计原则 | 具体实现 | 理由 | 替代方案 |
|----------|----------|------|----------|
| 结构优先于语义 | 用文档层次结构（标题/章节）组织索引，而非 embedding 向量 | 专业文档天然具有层次结构，利用结构比丢弃结构更高效 | 向量数据库 + chunking |
| 推理替代匹配 | LLM 在树结构上推理选择节点，输出 thinking + node_list | 推理能处理需要领域知识的复杂查询，相似度搜索做不到 | top-K 向量检索 + rerank |
| 渐进式解析 | 先检测 TOC → 有页码走快速路径 → 无页码走 LLM 定位 → 无 TOC 走全文解析 | 不同文档结构差异大，单一策略无法覆盖 | 统一 chunking 策略 |
| 递归细化 | 大节点超过阈值时递归拆分为子树 | 保证每个叶节点的 token 数在 LLM 上下文窗口内 | 固定大小分块 |
| 验证-修复闭环 | 解析后随机采样验证准确率，不达标则自动修复 | LLM 解析不是 100% 准确，需要自我纠错机制 | 一次解析直接使用 |
| 双格式支持 | PDF 走 TOC 检测 + 物理页码路径，Markdown 走 header 正则解析路径 | 两种格式的结构信号完全不同，需要独立处理管线 | 统一转纯文本后处理 |

---

## 第 2 章 源码实现分析

### 2.1 架构概览

PageIndex 的核心架构分为两个阶段：**索引构建**（Indexing）和**检索**（Retrieval）。

```
┌─────────────────────────────────────────────────────────────────────┐
│                    Phase 1: 索引构建 (Indexing)                      │
│                                                                      │
│  PDF/MD ──→ check_toc() ──→ meta_processor() ──→ tree_parser()      │
│              │                  │                     │              │
│              ▼                  ▼                     ▼              │
│         ┌─────────┐    ┌──────────────┐    ┌──────────────────────┐ │
│         │ TOC 检测 │    │ 3 种解析路径  │    │ 递归大节点处理        │ │
│         │ 有/无目录│    │ 有页码/无页码 │    │ process_large_node_  │ │
│         │ 有/无页码│    │ /无目录       │    │ recursively          │ │
│         └─────────┘    └──────────────┘    └──────────────────────┘ │
│                              │                     │                │
│                              ▼                     ▼                │
│                    ┌──────────────────────────────────┐             │
│                    │  verify_toc() → fix_incorrect()  │             │
│                    │  验证-修复闭环（最多 3 轮）        │             │
│                    └──────────────────────────────────┘             │
│                              │                                      │
│                              ▼                                      │
│                    Tree Structure Index (JSON)                       │
│                    {title, node_id, summary,                        │
│                     start_index, end_index, nodes[]}                │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│                    Phase 2: 检索 (Retrieval)                         │
│                                                                      │
│  Query ──→ LLM Tree Search ──→ Node Selection ──→ Text Extraction   │
│              │                      │                    │          │
│              ▼                      ▼                    ▼          │
│     ┌──────────────┐    ┌────────────────┐    ┌─────────────────┐  │
│     │ 树结构 + 摘要 │    │ thinking 推理  │    │ 节点原文提取     │  │
│     │ 作为 prompt   │    │ + node_list    │    │ → 答案生成       │  │
│     └──────────────┘    └────────────────┘    └─────────────────┘  │
└─────────────────────────────────────────────────────────────────────┘
```

**Markdown 独立管线**（`pageindex/page_index_md.py`）：

```
MD 文件 ──→ extract_nodes_from_markdown() ──→ extract_node_text_content()
                    │                                │
                    ▼                                ▼
            正则匹配 #{1,6}                    按 header 切分文本
                    │                                │
                    ▼                                ▼
          tree_thinning_for_index()  ──→  build_tree_from_nodes()
          (可选：合并小节点)                  (栈算法构建层次树)
                                                     │
                                                     ▼
                                          generate_summaries_for_structure_md()
                                          (异步并发生成节点摘要)
```

### 2.2 核心实现

#### 2.2.1 主入口：`tree_parser()` — 树结构解析编排器

`tree_parser()` (`pageindex/page_index.py:1021-1055`) 是 PDF 索引构建的主入口，编排整个解析流程：

```python
# pageindex/page_index.py:1021-1055
async def tree_parser(page_list, opt, doc=None, logger=None):
    check_toc_result = check_toc(page_list, opt)
    logger.info(check_toc_result)

    if check_toc_result.get("toc_content") and check_toc_result["toc_content"].strip() \
       and check_toc_result["page_index_given_in_toc"] == "yes":
        toc_with_page_number = await meta_processor(
            page_list, mode='process_toc_with_page_numbers',
            start_index=1, toc_content=check_toc_result['toc_content'],
            toc_page_list=check_toc_result['toc_page_list'], opt=opt, logger=logger)
    else:
        toc_with_page_number = await meta_processor(
            page_list, mode='process_no_toc',
            start_index=1, opt=opt, logger=logger)

    toc_with_page_number = add_preface_if_needed(toc_with_page_number)
    toc_with_page_number = await check_title_appearance_in_start_concurrent(
        toc_with_page_number, page_list, model=opt.model, logger=logger)

    valid_toc_items = [item for item in toc_with_page_number
                       if item.get('physical_index') is not None]
    toc_tree = post_processing(valid_toc_items, len(page_list))

    # 递归处理大节点
    tasks = [process_large_node_recursively(node, page_list, opt, logger=logger)
             for node in toc_tree]
    await asyncio.gather(*tasks)
    return toc_tree
```

关键设计点：
- 根据 `check_toc()` 结果选择解析路径（有 TOC 有页码 / 无 TOC）
- `add_preface_if_needed()` 自动补充前言节点（当第一个章节不从第 1 页开始时）
- `check_title_appearance_in_start_concurrent()` 并发验证每个标题是否出现在对应页面开头
- 最后对所有节点并发执行 `process_large_node_recursively()`

#### 2.2.2 三路径解析策略：`meta_processor()`

`meta_processor()` (`pageindex/page_index.py:951-989`) 实现了核心的降级策略：

```python
# pageindex/page_index.py:951-989
async def meta_processor(page_list, mode=None, toc_content=None,
                         toc_page_list=None, start_index=1, opt=None, logger=None):
    if mode == 'process_toc_with_page_numbers':
        toc_with_page_number = process_toc_with_page_numbers(...)
    elif mode == 'process_toc_no_page_numbers':
        toc_with_page_number = process_toc_no_page_numbers(...)
    else:
        toc_with_page_number = process_no_toc(...)

    # 验证准确率
    accuracy, incorrect_results = await verify_toc(
        page_list, toc_with_page_number, start_index=start_index, model=opt.model)

    if accuracy == 1.0 and len(incorrect_results) == 0:
        return toc_with_page_number
    if accuracy > 0.6 and len(incorrect_results) > 0:
        # 修复不正确的条目（最多 3 轮）
        toc_with_page_number, _ = await fix_incorrect_toc_with_retries(
            toc_with_page_number, page_list, incorrect_results,
            start_index=start_index, max_attempts=3, model=opt.model, logger=logger)
        return toc_with_page_number
    else:
        # 准确率 <= 0.6，降级到下一个策略
        if mode == 'process_toc_with_page_numbers':
            return await meta_processor(..., mode='process_toc_no_page_numbers', ...)
        elif mode == 'process_toc_no_page_numbers':
            return await meta_processor(..., mode='process_no_toc', ...)
        else:
            raise Exception('Processing failed')
```

降级链路：`有TOC有页码` → `有TOC无页码` → `无TOC全文解析`。每一级都有验证，准确率 > 0.6 则修复，≤ 0.6 则降级。

#### 2.2.3 TOC 检测：`check_toc()` 与 `find_toc_pages()`

`check_toc()` (`pageindex/page_index.py:688-724`) 逐页扫描前 N 页（默认 20 页），用 LLM 判断每页是否为目录页：

```python
# pageindex/page_index.py:333-358
def find_toc_pages(start_page_index, page_list, opt, logger=None):
    last_page_is_yes = False
    toc_page_list = []
    i = start_page_index
    while i < len(page_list):
        if i >= opt.toc_check_page_num and not last_page_is_yes:
            break
        detected_result = toc_detector_single_page(page_list[i][0], model=opt.model)
        if detected_result == 'yes':
            toc_page_list.append(i)
            last_page_is_yes = True
        elif detected_result == 'no' and last_page_is_yes:
            break  # TOC 连续区域结束
        i += 1
    return toc_page_list
```

设计亮点：利用"连续性假设"——目录页是连续的，一旦检测到非目录页且之前有目录页，立即停止扫描。

#### 2.2.4 验证-修复闭环：`verify_toc()` 与 `fix_incorrect_toc_with_retries()`

验证阶段 (`pageindex/page_index.py:892-944`) 对每个 TOC 条目，用 LLM 检查标题是否真的出现在对应的物理页面上：

```python
# pageindex/page_index.py:892-944 (简化)
async def verify_toc(page_list, list_result, start_index=1, N=None, model=None):
    # 对每个条目并发调用 check_title_appearance()
    tasks = [check_title_appearance(item, page_list, start_index, model)
             for item in indexed_sample_list]
    results = await asyncio.gather(*tasks)

    correct_count = sum(1 for r in results if r['answer'] == 'yes')
    accuracy = correct_count / len(results) if results else 0
    incorrect_results = [r for r in results if r['answer'] != 'yes']
    return accuracy, incorrect_results
```

修复阶段 (`pageindex/page_index.py:870-886`) 最多重试 3 轮，每轮对不正确的条目在前后正确条目的页码范围内重新定位：

```python
# pageindex/page_index.py:870-886
async def fix_incorrect_toc_with_retries(toc_with_page_number, page_list,
                                          incorrect_results, start_index=1,
                                          max_attempts=3, model=None, logger=None):
    fix_attempt = 0
    current_incorrect = incorrect_results
    while current_incorrect:
        current_toc, current_incorrect = await fix_incorrect_toc(
            current_toc, page_list, current_incorrect, start_index, model, logger)
        fix_attempt += 1
        if fix_attempt >= max_attempts:
            break
    return current_toc, current_incorrect
```

#### 2.2.5 递归大节点处理：`process_large_node_recursively()`

当某个节点跨越的页数超过 `max_page_num_each_node`（默认 10）且 token 数超过 `max_token_num_each_node`（默认 20000）时，递归拆分 (`pageindex/page_index.py:992-1019`)：

```python
# pageindex/page_index.py:992-1019
async def process_large_node_recursively(node, page_list, opt=None, logger=None):
    node_page_list = page_list[node['start_index']-1:node['end_index']]
    token_num = sum([page[1] for page in node_page_list])

    if node['end_index'] - node['start_index'] > opt.max_page_num_each_node \
       and token_num >= opt.max_token_num_each_node:
        # 对大节点重新运行 meta_processor（无 TOC 模式）
        node_toc_tree = await meta_processor(
            node_page_list, mode='process_no_toc',
            start_index=node['start_index'], opt=opt, logger=logger)
        # 将结果挂载为子节点
        node['nodes'] = post_processing(valid_node_toc_items, node['end_index'])

    # 递归处理子节点
    if 'nodes' in node and node['nodes']:
        tasks = [process_large_node_recursively(child, page_list, opt, logger=logger)
                 for child in node['nodes']]
        await asyncio.gather(*tasks)
    return node
```

#### 2.2.6 Markdown 管线：`page_index_md.py`

Markdown 文件走完全不同的解析路径 (`pageindex/page_index_md.py:243-297`)，核心是正则匹配 header 而非 LLM 检测 TOC：

- `extract_nodes_from_markdown()` (`page_index_md.py:32-59`)：正则 `^(#{1,6})\s+(.+)$` 提取所有 header，跳过代码块内的 header
- `tree_thinning_for_index()` (`page_index_md.py:135-187`)：可选的"树修剪"——将 token 数低于阈值的小节点合并到父节点
- `build_tree_from_nodes()` (`page_index_md.py:190-221`)：用栈算法根据 header level 构建层次树

### 2.3 实现细节

#### LLM 调用层

所有 LLM 调用封装在 `utils.py` 中，提供同步和异步两种接口 (`pageindex/utils.py:29-108`)：

- `ChatGPT_API()` — 同步调用，10 次重试，`temperature=0` 确保确定性
- `ChatGPT_API_async()` — 异步调用，用于并发场景
- `ChatGPT_API_with_finish_reason()` — 返回 finish_reason，用于检测输出是否被截断（TOC 转换时需要续写）

#### 分组策略

`page_list_to_group_text()` (`pageindex/page_index.py:418-451`) 将页面按 token 数分组，每组不超过 `max_tokens`（默认 20000），组间有 `overlap_page`（默认 1 页）重叠，防止章节边界被切断。

#### 配置系统

`ConfigLoader` (`pageindex/utils.py:681-712`) 从 `config.yaml` 加载默认配置，支持用户覆盖：

```yaml
# pageindex/config.yaml
model: "gpt-4o-2024-11-20"
toc_check_page_num: 20
max_page_num_each_node: 10
max_token_num_each_node: 20000
if_add_node_id: "yes"
if_add_node_summary: "yes"
if_add_doc_description: "no"
if_add_node_text: "no"
```

#### 数据流：从 PDF 到 Tree JSON

```
PDF 文件
  │
  ▼ get_page_tokens() [utils.py:413]
  │ PyPDF2/PyMuPDF 逐页提取文本 + tiktoken 计算 token 数
  │ → [(page_text, token_count), ...]
  │
  ▼ check_toc() [page_index.py:688]
  │ 逐页 LLM 判断是否为目录页
  │ → {toc_content, toc_page_list, page_index_given_in_toc}
  │
  ▼ meta_processor() [page_index.py:951]
  │ 根据 TOC 检测结果选择解析路径
  │ → [{structure, title, physical_index}, ...]
  │
  ▼ verify_toc() + fix_incorrect_toc_with_retries()
  │ 验证准确率，不达标则修复或降级
  │
  ▼ post_processing() [utils.py:460]
  │ 扁平列表 → 层次树（list_to_tree）
  │ → [{title, start_index, end_index, nodes[]}, ...]
  │
  ▼ process_large_node_recursively() [page_index.py:992]
  │ 大节点递归拆分
  │
  ▼ write_node_id() + generate_summaries_for_structure()
  │ 分配节点 ID + 异步生成摘要
  │
  ▼ 最终输出
  {doc_name, doc_description?, structure: [{title, node_id, summary, nodes[]}]}
```

---

## 第 3 章 迁移指南

### 3.1 迁移清单

**阶段 1：核心索引构建（最小可用）**

- [ ] 移植 `page_index.py` 中的 `tree_parser()` + `meta_processor()` + `check_toc()` 三个核心函数
- [ ] 移植 `utils.py` 中的 LLM 调用层（`ChatGPT_API` / `ChatGPT_API_async`），替换为你的 LLM provider
- [ ] 移植 `utils.py` 中的 `post_processing()` + `list_to_tree()` 树构建逻辑
- [ ] 移植 `config.yaml` 配置系统

**阶段 2：质量保证**

- [ ] 移植 `verify_toc()` + `fix_incorrect_toc_with_retries()` 验证-修复闭环
- [ ] 移植 `process_large_node_recursively()` 递归大节点处理
- [ ] 移植 `validate_and_truncate_physical_indices()` 边界保护

**阶段 3：检索层**

- [ ] 实现 LLM 树搜索（参考 `cookbook/pageindex_RAG_simple.ipynb` Step 2 的 prompt 模板）
- [ ] 实现节点文本提取 + 答案生成管线

**阶段 4：扩展**

- [ ] 添加 Markdown 支持（移植 `page_index_md.py`）
- [ ] 添加节点摘要生成（`generate_summaries_for_structure()`）
- [ ] 添加文档描述生成（`generate_doc_description()`）

### 3.2 适配代码模板

以下是一个可直接运行的最小化树搜索检索实现，基于 PageIndex 的核心思想：

```python
import json
import openai

async def reasoning_based_retrieval(query: str, tree_index: dict,
                                     model: str = "gpt-4o") -> dict:
    """
    基于 PageIndex 思想的 LLM 树搜索检索。
    tree_index: page_index_main() 的输出 JSON
    返回: {thinking, node_ids, texts}
    """
    client = openai.AsyncOpenAI()

    # Step 1: LLM 在树结构上推理，选择相关节点
    search_prompt = f"""
You are given a question and a tree structure of a document.
Each node contains a node_id, title, and summary.
Find all nodes likely to contain the answer.

Question: {query}

Document tree:
{json.dumps(tree_index['structure'], indent=2)}

Reply in JSON:
{{
    "thinking": "<reasoning process>",
    "node_list": ["node_id_1", "node_id_2"]
}}
Directly return JSON only.
"""
    response = await client.chat.completions.create(
        model=model,
        messages=[{"role": "user", "content": search_prompt}],
        temperature=0,
    )
    result = json.loads(response.choices[0].message.content)

    # Step 2: 提取选中节点的文本
    node_map = _build_node_map(tree_index['structure'])
    texts = [node_map[nid]['text'] for nid in result['node_list']
             if nid in node_map and 'text' in node_map[nid]]

    return {
        "thinking": result["thinking"],
        "node_ids": result["node_list"],
        "texts": texts,
    }


def _build_node_map(structure, result=None):
    """递归构建 node_id → node 的映射"""
    if result is None:
        result = {}
    if isinstance(structure, list):
        for item in structure:
            _build_node_map(item, result)
    elif isinstance(structure, dict):
        if 'node_id' in structure:
            result[structure['node_id']] = structure
        if 'nodes' in structure:
            _build_node_map(structure['nodes'], result)
    return result
```

### 3.3 适用场景

| 场景 | 适用度 | 说明 |
|------|--------|------|
| 长文档 QA（学术论文、法律文件、财报） | ⭐⭐⭐ | 核心场景，文档有天然层次结构，推理检索远优于向量检索 |
| 多文档跨文档检索 | ⭐⭐ | 需要为每个文档独立构建索引，跨文档推理需额外编排层 |
| 实时流式文档（聊天记录、日志） | ⭐ | 不适合，这类文档没有层次结构，向量检索更合适 |
| 短文本检索（FAQ、知识条目） | ⭐ | 过度设计，短文本直接全文搜索或向量检索即可 |
| 代码仓库检索 | ⭐⭐ | 代码有目录结构但非文档层次，需要适配（参考 DeepWiki 方案） |
| Agentic RAG（Agent 自主检索） | ⭐⭐⭐ | 天然适配，LLM 推理检索可以作为 Agent 的 tool 调用 |

---

## 第 4 章 测试用例

```python
import pytest
import json
import copy
from unittest.mock import AsyncMock, patch, MagicMock

# ============================================================
# 测试 1: post_processing — 扁平列表转层次树
# ============================================================
class TestPostProcessing:
    """测试 utils.py 中的 post_processing + list_to_tree"""

    def test_flat_list_to_tree(self):
        """正常路径：扁平 TOC 列表转为嵌套树"""
        from pageindex.utils import post_processing
        structure = [
            {"structure": "1", "title": "Introduction",
             "physical_index": 1, "appear_start": "yes"},
            {"structure": "1.1", "title": "Background",
             "physical_index": 3, "appear_start": "yes"},
            {"structure": "2", "title": "Methods",
             "physical_index": 5, "appear_start": "yes"},
        ]
        tree = post_processing(structure, end_physical_index=10)
        assert len(tree) == 2  # 两个顶级节点
        assert tree[0]["title"] == "Introduction"
        assert len(tree[0]["nodes"]) == 1  # 1.1 是 1 的子节点
        assert tree[0]["nodes"][0]["title"] == "Background"
        assert tree[1]["title"] == "Methods"
        assert tree[1]["end_index"] == 10

    def test_empty_structure(self):
        """边界：空列表"""
        from pageindex.utils import post_processing
        tree = post_processing([], end_physical_index=10)
        assert tree == []

    def test_single_node(self):
        """边界：只有一个节点"""
        from pageindex.utils import post_processing
        structure = [
            {"structure": "1", "title": "Only Section",
             "physical_index": 1, "appear_start": "yes"},
        ]
        tree = post_processing(structure, end_physical_index=20)
        assert len(tree) == 1
        assert tree[0]["end_index"] == 20


# ============================================================
# 测试 2: extract_json — JSON 提取鲁棒性
# ============================================================
class TestExtractJson:
    """测试 utils.py 中的 extract_json"""

    def test_clean_json(self):
        from pageindex.utils import extract_json
        result = extract_json('{"answer": "yes", "thinking": "found it"}')
        assert result["answer"] == "yes"

    def test_json_in_code_block(self):
        from pageindex.utils import extract_json
        content = '```json\n{"answer": "no"}\n```'
        result = extract_json(content)
        assert result["answer"] == "no"

    def test_python_none_replacement(self):
        from pageindex.utils import extract_json
        result = extract_json('{"value": None}')
        assert result["value"] is None

    def test_trailing_comma_cleanup(self):
        from pageindex.utils import extract_json
        result = extract_json('{"items": [1, 2, 3,]}')
        assert result["items"] == [1, 2, 3]

    def test_malformed_json_returns_empty(self):
        from pageindex.utils import extract_json
        result = extract_json('not json at all')
        assert result == {}


# ============================================================
# 测试 3: validate_and_truncate_physical_indices — 边界保护
# ============================================================
class TestValidatePhysicalIndices:
    """测试 page_index.py 中的 validate_and_truncate_physical_indices"""

    def test_truncate_out_of_range(self):
        from pageindex.page_index import validate_and_truncate_physical_indices
        toc = [
            {"title": "A", "physical_index": 5},
            {"title": "B", "physical_index": 100},  # 超出范围
        ]
        result = validate_and_truncate_physical_indices(toc, page_list_length=10)
        assert result[0]["physical_index"] == 5
        assert result[1]["physical_index"] is None  # 被截断

    def test_empty_toc(self):
        from pageindex.page_index import validate_and_truncate_physical_indices
        result = validate_and_truncate_physical_indices([], page_list_length=10)
        assert result == []

    def test_all_valid(self):
        from pageindex.page_index import validate_and_truncate_physical_indices
        toc = [{"title": "A", "physical_index": 3}]
        result = validate_and_truncate_physical_indices(toc, page_list_length=10)
        assert result[0]["physical_index"] == 3


# ============================================================
# 测试 4: Markdown 管线 — header 提取
# ============================================================
class TestMarkdownPipeline:
    """测试 page_index_md.py 中的 extract_nodes_from_markdown"""

    def test_extract_headers(self):
        from pageindex.page_index_md import extract_nodes_from_markdown
        md = "# Title\n\nSome text\n\n## Section 1\n\nContent\n\n### Sub 1.1\n"
        nodes, lines = extract_nodes_from_markdown(md)
        assert len(nodes) == 3
        assert nodes[0]["node_title"] == "Title"
        assert nodes[1]["node_title"] == "Section 1"
        assert nodes[2]["node_title"] == "Sub 1.1"

    def test_skip_headers_in_code_blocks(self):
        from pageindex.page_index_md import extract_nodes_from_markdown
        md = "# Real Title\n\n```python\n# Not a header\n```\n\n## Real Section\n"
        nodes, lines = extract_nodes_from_markdown(md)
        assert len(nodes) == 2
        titles = [n["node_title"] for n in nodes]
        assert "Not a header" not in titles

    def test_build_tree_hierarchy(self):
        from pageindex.page_index_md import (
            extract_nodes_from_markdown, extract_node_text_content,
            build_tree_from_nodes
        )
        md = "# Root\n\nText\n\n## Child 1\n\nText\n\n## Child 2\n\nText\n"
        nodes, lines = extract_nodes_from_markdown(md)
        nodes_with_content = extract_node_text_content(nodes, lines)
        tree = build_tree_from_nodes(nodes_with_content)
        assert len(tree) == 1  # 一个根节点
        assert len(tree[0]["nodes"]) == 2  # 两个子节点
```

---

## 第 5 章 跨域关联

| 关联域 | 关系类型 | 说明 |
|--------|----------|------|
| PD-01 上下文管理 | 协同 | PageIndex 的 `max_token_num_each_node` 配置和递归拆分机制本质上是上下文窗口管理策略，确保每个节点的文本不超过 LLM 上下文限制 |
| PD-03 容错与重试 | 协同 | `ChatGPT_API` 的 10 次重试机制、`fix_incorrect_toc_with_retries` 的 3 轮修复、`meta_processor` 的三级降级策略都是容错设计 |
| PD-04 工具系统 | 协同 | 树搜索检索可以封装为 Agent 的 tool（如 `cookbook/agentic_retrieval.ipynb` 所示），通过 prompt 驱动检索 |
| PD-07 质量检查 | 依赖 | `verify_toc()` 的准确率验证 + `fix_incorrect_toc_with_retries()` 的自动修复是质量保证的核心机制 |
| PD-11 可观测性 | 协同 | `JsonLogger` 记录每个阶段的中间结果（TOC 检测、准确率、修复日志），支持事后分析和调试 |
| PD-12 推理增强 | 依赖 | 整个检索过程依赖 LLM 推理能力——TOC 检测、标题定位、树搜索都是推理任务，模型推理能力直接决定检索质量 |

---

## 第 6 章 来源文件索引

| 文件 | 行范围 | 关键实现 |
|------|--------|----------|
| `pageindex/page_index.py` | L1021-1055 | `tree_parser()` — 树结构解析主入口 |
| `pageindex/page_index.py` | L1058-1101 | `page_index_main()` — PDF 索引构建完整流程编排 |
| `pageindex/page_index.py` | L951-989 | `meta_processor()` — 三路径解析 + 降级策略 |
| `pageindex/page_index.py` | L688-724 | `check_toc()` — TOC 检测（有/无目录、有/无页码） |
| `pageindex/page_index.py` | L333-358 | `find_toc_pages()` — 逐页 TOC 检测（连续性假设） |
| `pageindex/page_index.py` | L892-944 | `verify_toc()` — 并发验证 TOC 准确率 |
| `pageindex/page_index.py` | L870-886 | `fix_incorrect_toc_with_retries()` — 最多 3 轮修复 |
| `pageindex/page_index.py` | L992-1019 | `process_large_node_recursively()` — 递归大节点拆分 |
| `pageindex/page_index.py` | L418-451 | `page_list_to_group_text()` — 页面分组（带重叠） |
| `pageindex/page_index.py` | L1114-1144 | `validate_and_truncate_physical_indices()` — 边界保护 |
| `pageindex/page_index_md.py` | L32-59 | `extract_nodes_from_markdown()` — 正则提取 Markdown header |
| `pageindex/page_index_md.py` | L135-187 | `tree_thinning_for_index()` — 小节点合并修剪 |
| `pageindex/page_index_md.py` | L190-221 | `build_tree_from_nodes()` — 栈算法构建层次树 |
| `pageindex/page_index_md.py` | L243-297 | `md_to_tree()` — Markdown 管线主入口 |
| `pageindex/utils.py` | L29-108 | LLM 调用层（同步/异步/带 finish_reason） |
| `pageindex/utils.py` | L125-156 | `extract_json()` — 鲁棒 JSON 提取 |
| `pageindex/utils.py` | L350-396 | `list_to_tree()` — 扁平列表转层次树 |
| `pageindex/utils.py` | L460-479 | `post_processing()` — 后处理（页码→索引 + 树构建） |
| `pageindex/utils.py` | L605-623 | `generate_summaries_for_structure()` — 异步并发摘要生成 |
| `pageindex/utils.py` | L681-712 | `ConfigLoader` — YAML 配置加载 + 用户覆盖 |
| `pageindex/config.yaml` | L1-8 | 默认配置（模型、页数阈值、token 阈值） |
| `cookbook/pageindex_RAG_simple.ipynb` | Step 2 | LLM 树搜索检索 prompt 模板 |
| `cookbook/agentic_retrieval.ipynb` | cell-14 | Agentic retrieval prompt 驱动检索示例 |
| `run_pageindex.py` | L1-133 | CLI 入口（PDF/Markdown 双模式） |
| `cookbook/vision_RAG_pageindex.ipynb` | Step 2 | Vision RAG：VLM 直接对 PDF 页面图片推理，无需 OCR |
| `tutorials/tree-search/README.md` | 全文 | LLM 树搜索 + MCTS 检索策略 + 专家知识集成 |
| `tutorials/doc-search/README.md` | 全文 | 三种多文档检索策略总览 |
| `tutorials/doc-search/metadata.md` | 全文 | 多文档检索：Query-to-SQL 元数据策略 |
| `tutorials/doc-search/semantics.md` | 全文 | 多文档检索：向量 + DocScore 语义策略 |
| `tutorials/doc-search/description.md` | 全文 | 多文档检索：LLM 描述匹配策略 |

---

## 第 7 章 横向对比维度

> 本章用于自动填充 Butcher Wiki 的横向对比表。

PageIndex 的核心差异在于用 LLM 推理替代向量相似度搜索，用文档层次树结构替代 chunking + embedding。以下维度覆盖了 PD-08 已有对比维度和 PageIndex 独有的工程特征。

```json comparison_data
{
  "project": "PageIndex",
  "dimensions": {
    "检索方式": "LLM 推理式树搜索，无向量数据库，生产环境结合 MCTS",
    "索引结构": "层次化树索引（标题/页码/摘要），PDF 自动 TOC 检测 + MD header 解析",
    "排序策略": "LLM 推理输出 thinking + node_list，非相似度排序",
    "缓存机制": "树索引一次构建持久化为 JSON，检索时只传树结构不传原文",
    "扩展性": "三种多文档策略（metadata SQL / semantics DocScore / description LLM）",
    "解析容错": "三级降级（有TOC有页码→有TOC无页码→无TOC）+ 验证修复闭环最多3轮",
    "多模态支持": "Vision RAG：VLM 直接对 PDF 页面图片推理，无需 OCR",
    "专家知识集成": "树搜索 prompt 中直接注入领域偏好，无需微调 embedding"
  }
}
```

**维度说明：**

| 维度 | PageIndex 做法 | 与传统 RAG 对比 |
|------|---------------|----------------|
| 检索方式 | LLM 在树结构上推理导航，输出推理过程 + 节点列表 | 传统 RAG 用 top-K 向量相似度匹配，黑盒不可解释 |
| 索引结构 | 保留文档天然层次（章/节/段），每个节点含标题、页码范围、摘要 | 传统 RAG 将文档切割为固定大小 chunk，破坏结构 |
| 排序策略 | LLM 推理选择，可解释（thinking 字段），支持注入专家知识 | 向量距离排序，语义相似 ≠ 逻辑相关 |
| 缓存机制 | 树索引 JSON 一次构建，后续检索只需传递轻量树结构 | 向量数据库需要持久化大量 embedding 向量 |
| 扩展性 | 单文档树搜索 + 三种多文档策略覆盖不同场景 | 通常只有向量检索一种方式 |
| 解析容错 | 三级降级 + LLM 验证 + 自动修复，适应各种 PDF 质量 | chunking 对文档质量不敏感但丢失结构 |
| 多模态支持 | VLM 直接处理 PDF 页面图片，跳过 OCR 步骤 | 传统 RAG 依赖 OCR 文本提取 |
| 专家知识集成 | prompt 注入，零成本适配新领域 | 需要微调 embedding 模型或 reranker |
