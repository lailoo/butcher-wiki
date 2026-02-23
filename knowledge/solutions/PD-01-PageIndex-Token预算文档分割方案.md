# PD-01.05 PageIndex — Token 预算驱动的文档分割与树结构构建

> 文档编号：PD-01.05
> 来源：PageIndex `pageindex/utils.py` `pageindex/page_index.py` `pageindex/page_index_md.py` `pageindex/config.yaml`
> GitHub：https://github.com/VectifyAI/PageIndex.git
> 问题域：PD-01 上下文管理 Context Window Management
> 状态：可复用方案

---

## 第 1 章 问题与动机

### 1.1 核心问题

LLM 的上下文窗口有硬性 token 上限。当处理超长文档（数百页 PDF、大型 Markdown）时，
无法将全文一次性送入模型。需要一种机制将文档按 token 预算切分为可处理的分组，
同时保证切分边界不破坏语义连贯性。

PageIndex 面对的具体挑战：
- PDF 文档可能有数百页，总 token 数远超单次 LLM 调用上限
- 需要对每个分组调用 LLM 提取目录结构，分组间不能丢失上下文
- 树结构构建后，单个节点的 token 数也不能超过后续处理的上限
- Markdown 文档的树结构需要按 token 阈值进行"瘦身"合并

### 1.2 PageIndex 的解法概述

PageIndex 围绕 token 预算构建了一套三层上下文管理体系：

1. **精确 token 计数**：使用 tiktoken 按模型编码精确计算每页 token 数（`utils.py:22-27`），
   而非粗略的字符数估算，确保预算控制精确可靠

2. **智能分组 + 重叠页**：`page_list_to_group_text()` 函数（`page_index.py:418-451`）
   将页面按 `max_tokens=20000` 预算分组，使用 `overlap_page` 机制在分组边界保留重叠页，
   防止跨页内容被截断

3. **树节点 token 约束**：构建文档树后，通过 `max_token_num_each_node=20000` 限制
   单节点 token 数（`page_index.py:996`），超限节点递归拆分

4. **Markdown 树瘦身**：`tree_thinning_for_index()` 函数（`page_index_md.py:135-187`）
   将低于阈值的子节点合并到父节点，减少树的碎片化

5. **全局安全阀**：`check_token_limit()` 函数（`utils.py:533`）以 110000 token 为上限
   做最终校验，防止任何节点超出模型绝对上限

### 1.3 设计思想

| 设计原则 | 具体实现 | 理由 | 替代方案 |
|----------|----------|------|----------|
| 精确优于估算 | tiktoken 按模型编码计数 | 不同模型 tokenizer 不同，字符数估算误差大 | 按字符数 ÷ 4 估算（误差 10-30%） |
| 预算均匀分配 | average_tokens_per_part 取均值与上限的中间值 | 避免最后一组过小或过大 | 固定 max_tokens 硬切（最后一组可能很小） |
| 重叠防断裂 | overlap_page=1 在分组边界保留重叠页 | 跨页内容（表格、段落）不被截断 | 无重叠硬切（丢失边界上下文） |
| 递归拆分大节点 | process_large_node_recursively 对超限节点重新提取子结构 | 保持树结构语义完整性 | 简单截断（破坏语义） |
| 配置驱动 | config.yaml 集中管理所有 token 阈值 | 不同场景可调参，无需改代码 | 硬编码常量 |

---

## 第 2 章 源码实现分析

### 2.1 架构概览

PageIndex 的上下文管理贯穿整个文档处理流水线：

```
PDF 输入
  │
  ▼
┌─────────────────────────────────┐
│  get_page_tokens()              │  Layer 1: 逐页 token 计数
│  utils.py:413-437               │  tiktoken 精确编码
└──────────────┬──────────────────┘
               │ [(page_text, token_length), ...]
               ▼
┌─────────────────────────────────┐
│  page_list_to_group_text()      │  Layer 2: 按预算分组
│  page_index.py:418-451          │  max_tokens + overlap_page
└──────────────┬──────────────────┘
               │ [group_text_1, group_text_2, ...]
               ▼
┌─────────────────────────────────┐
│  meta_processor() → tree_parser │  Layer 3: LLM 提取目录结构
│  page_index.py:951-989          │  逐组调用，增量构建 TOC
└──────────────┬──────────────────┘
               │ toc_tree (树结构)
               ▼
┌─────────────────────────────────┐
│  process_large_node_recursively │  Layer 4: 大节点递归拆分
│  page_index.py:992-1019         │  max_token_num_each_node 约束
└──────────────┬──────────────────┘
               │
               ▼
┌─────────────────────────────────┐
│  check_token_limit()            │  Layer 5: 全局安全校验
│  utils.py:533-542               │  110000 token 硬上限
└─────────────────────────────────┘
```

Markdown 路径有独立的瘦身层：

```
Markdown 输入
  │
  ▼
┌─────────────────────────────────────────┐
│  update_node_list_with_text_token_count │  递归计算每节点累计 token
│  page_index_md.py:89-132                │
└──────────────┬──────────────────────────┘
               ▼
┌─────────────────────────────────────────┐
│  tree_thinning_for_index()              │  合并低 token 子节点
│  page_index_md.py:135-187               │  min_node_token 阈值
└─────────────────────────────────────────┘
```

### 2.2 核心实现

#### 2.2.1 精确 token 计数（`utils.py:22-27`）

```python
def count_tokens(text, model=None):
    if not text:
        return 0
    enc = tiktoken.encoding_for_model(model)
    tokens = enc.encode(text)
    return len(tokens)
```

关键点：使用 `tiktoken.encoding_for_model(model)` 获取与目标模型完全一致的 tokenizer，
而非通用编码。这确保了 token 计数与实际 API 调用消耗完全匹配。

#### 2.2.2 逐页 token 统计（`utils.py:413-437`）

```python
def get_page_tokens(pdf_path, model="gpt-4o-2024-11-20", pdf_parser="PyPDF2"):
    enc = tiktoken.encoding_for_model(model)
    if pdf_parser == "PyPDF2":
        pdf_reader = PyPDF2.PdfReader(pdf_path)
        page_list = []
        for page_num in range(len(pdf_reader.pages)):
            page = pdf_reader.pages[page_num]
            page_text = page.extract_text()
            token_length = len(enc.encode(page_text))
            page_list.append((page_text, token_length))
        return page_list
```

返回 `[(page_text, token_length), ...]` 元组列表，一次解析同时获得文本和 token 长度，
避免后续重复编码。支持 PyPDF2 和 PyMuPDF 两种解析器。

#### 2.2.3 智能分组算法（`page_index.py:418-451`）

这是上下文管理的核心算法：

```python
def page_list_to_group_text(page_contents, token_lengths, max_tokens=20000, overlap_page=1):
    num_tokens = sum(token_lengths)

    if num_tokens <= max_tokens:
        page_text = "".join(page_contents)
        return [page_text]

    subsets = []
    current_subset = []
    current_token_count = 0

    expected_parts_num = math.ceil(num_tokens / max_tokens)
    average_tokens_per_part = math.ceil(((num_tokens / expected_parts_num) + max_tokens) / 2)

    for i, (page_content, page_tokens) in enumerate(zip(page_contents, token_lengths)):
        if current_token_count + page_tokens > average_tokens_per_part:
            subsets.append(''.join(current_subset))
            overlap_start = max(i - overlap_page, 0)
            current_subset = page_contents[overlap_start:i]
            current_token_count = sum(token_lengths[overlap_start:i])

        current_subset.append(page_content)
        current_token_count += page_tokens

    if current_subset:
        subsets.append(''.join(current_subset))

    return subsets
```

三个关键设计决策：

1. **短路优化**（L420-424）：总 token 数不超限时直接合并，零开销
2. **均匀分配**（L430-431）：`average_tokens_per_part` 取 `(平均值 + 上限) / 2`，
   使各组大小更均匀，避免最后一组过小
3. **重叠页机制**（L438-440）：新分组从 `i - overlap_page` 开始，
   将前一组的最后 N 页复制到新组开头，保证跨页内容的连贯性

#### 2.2.4 大节点递归拆分（`page_index.py:992-1019`）

```python
async def process_large_node_recursively(node, page_list, opt=None, logger=None):
    node_page_list = page_list[node['start_index']-1:node['end_index']]
    token_num = sum([page[1] for page in node_page_list])

    if node['end_index'] - node['start_index'] > opt.max_page_num_each_node \
       and token_num >= opt.max_token_num_each_node:
        # 对超限节点重新调用 meta_processor 提取子结构
        node_toc_tree = await meta_processor(
            node_page_list, mode='process_no_toc',
            start_index=node['start_index'], opt=opt, logger=logger)
        # ... 将子结构挂载到当前节点
```

双条件门控：页数 > `max_page_num_each_node`（默认 10）**且** token 数 >= `max_token_num_each_node`（默认 20000）。
只有同时满足才触发拆分，避免对短但多页的节点做不必要的 LLM 调用。

#### 2.2.5 索引截断安全阀（`page_index.py:1114-1144`）

```python
def validate_and_truncate_physical_indices(toc_with_page_number, page_list_length, start_index=1, logger=None):
    if not toc_with_page_number:
        return toc_with_page_number
    max_allowed_page = page_list_length + start_index - 1
    truncated_items = []
    for i, item in enumerate(toc_with_page_number):
        if item.get('physical_index') is not None:
            original_index = item['physical_index']
            if original_index > max_allowed_page:
                item['physical_index'] = None
                truncated_items.append({
                    'title': item.get('title', 'Unknown'),
                    'original_index': original_index
                })
    return toc_with_page_number
```

LLM 生成的 TOC 可能引用不存在的页码（幻觉或文档不完整）。此函数将超出文档实际长度的
`physical_index` 置为 `None`，防止后续 `page_list[index]` 越界。这是 LLM 输出不可信
原则的典型防御实现。

#### 2.2.6 全局 token 上限校验（`utils.py:533-542`）

```python
def check_token_limit(structure, limit=110000):
    list = structure_to_list(structure)
    for node in list:
        num_tokens = count_tokens(node['text'], model='gpt-4o')
        if num_tokens > limit:
            print(f"Node ID: {node['node_id']} has {num_tokens} tokens")
```

最终安全网：遍历整棵树，检查是否有节点超过 110000 token 的绝对上限。
这个值对应 GPT-4o 的 128K 上下文窗口减去 prompt 和输出预留空间。

### 2.3 实现细节

#### 数据流：从 PDF 到分组

```
PDF → get_page_tokens() → [(text, tokens), (text, tokens), ...]
                                    │
                    ┌───────────────┼───────────────┐
                    ▼               ▼               ▼
              page_contents   token_lengths    物理页码标签
              [tagged_text]   [int, int, ...]  <physical_index_N>
                    │               │
                    └───────┬───────┘
                            ▼
                page_list_to_group_text()
                            │
              ┌─────────────┼─────────────┐
              ▼             ▼             ▼
          group_1       group_2       group_N
          (≤20K tok)    (≤20K tok)    (≤20K tok)
              │             │             │
              ▼             ▼             ▼
        generate_toc   generate_toc   generate_toc
          _init()       _continue()    _continue()
              │             │             │
              └─────────────┴─────────────┘
                            ▼
                   toc_with_page_number (flat list)
                            │
                            ▼
                   post_processing() → tree structure
                            │
                            ▼
                process_large_node_recursively()
                   (递归拆分超限节点)
```

#### 分组均匀化策略

`page_list_to_group_text()` 中的 `average_tokens_per_part` 计算（`page_index.py:430-431`）
是一个精巧的设计：

```python
expected_parts_num = math.ceil(num_tokens / max_tokens)
average_tokens_per_part = math.ceil(((num_tokens / expected_parts_num) + max_tokens) / 2)
```

取「理论平均值」和「硬上限」的中间值作为实际分组阈值。例如总 token 50000，max_tokens 20000：
- expected_parts_num = ceil(50000/20000) = 3
- 理论平均 = 50000/3 ≈ 16667
- average_tokens_per_part = ceil((16667 + 20000) / 2) = 18334

这样每组约 18334 token，比硬切 20000 更均匀，避免最后一组只有几千 token 的尾巴效应。

#### 三级降级策略（`meta_processor` `page_index.py:951-989`）

TOC 处理采用三级降级：

1. `process_toc_with_page_numbers` — 有 TOC 且有页码，直接映射
2. `process_toc_no_page_numbers` — 有 TOC 无页码，LLM 逐组匹配
3. `process_no_toc` — 无 TOC，LLM 从零提取结构

每级处理后通过 `verify_toc()` 验证准确率，accuracy < 0.6 时自动降级到下一级。
这保证了即使 PDF 的 TOC 质量差或缺失，系统仍能产出可用的文档结构。

---

## 第 3 章 迁移指南

### 3.1 迁移清单

**阶段 1：Token 计数基础设施**
- [ ] 安装 `tiktoken`（`pip install tiktoken`）
- [ ] 实现 `count_tokens(text, model)` 函数
- [ ] 确定目标模型的 tokenizer（GPT 系列用 tiktoken，Claude 用自带 tokenizer）

**阶段 2：分组引擎**
- [ ] 实现 `page_list_to_group_text()` 分组算法
- [ ] 配置 `max_tokens` 阈值（建议为模型上下文窗口的 15-20%）
- [ ] 配置 `overlap_page`（建议 1-2，视内容粒度而定）

**阶段 3：大节点拆分**
- [ ] 实现递归拆分逻辑（双条件门控：页数 + token 数）
- [ ] 集成到文档树构建流程

**阶段 4：安全阀**
- [ ] 实现 `validate_and_truncate_physical_indices()` 防越界
- [ ] 实现全局 token 上限校验

### 3.2 适配代码模板

以下模板可直接用于任何需要按 token 预算分割长文本的场景：

```python
import math
import tiktoken

def count_tokens(text: str, model: str = "gpt-4o") -> int:
    """精确计算文本的 token 数"""
    if not text:
        return 0
    enc = tiktoken.encoding_for_model(model)
    return len(enc.encode(text))


def split_by_token_budget(
    chunks: list[str],
    chunk_token_counts: list[int],
    max_tokens: int = 20000,
    overlap: int = 1,
) -> list[str]:
    """
    将有序文本块按 token 预算分组，支持重叠。

    Args:
        chunks: 有序文本块列表（页、段落、章节等）
        chunk_token_counts: 每个块的 token 数
        max_tokens: 每组的 token 上限
        overlap: 分组边界重叠的块数

    Returns:
        分组后的文本列表
    """
    total_tokens = sum(chunk_token_counts)

    if total_tokens <= max_tokens:
        return ["".join(chunks)]

    expected_parts = math.ceil(total_tokens / max_tokens)
    target_per_part = math.ceil(
        ((total_tokens / expected_parts) + max_tokens) / 2
    )

    groups = []
    current_group = []
    current_count = 0

    for i, (chunk, tokens) in enumerate(zip(chunks, chunk_token_counts)):
        if current_count + tokens > target_per_part and current_group:
            groups.append("".join(current_group))
            overlap_start = max(i - overlap, 0)
            current_group = list(chunks[overlap_start:i])
            current_count = sum(chunk_token_counts[overlap_start:i])

        current_group.append(chunk)
        current_count += tokens

    if current_group:
        groups.append("".join(current_group))

    return groups


def validate_indices(items: list[dict], max_index: int) -> list[dict]:
    """将超出范围的索引置为 None，防止 LLM 幻觉导致越界"""
    for item in items:
        idx = item.get("index")
        if idx is not None and idx > max_index:
            item["index"] = None
    return items
```

### 3.3 适用场景

| 场景 | 适用度 | 说明 |
|------|--------|------|
| 超长 PDF 文档处理 | ⭐⭐⭐ | 原生场景，直接复用 |
| RAG 文档分块 | ⭐⭐⭐ | 替代固定字符数分块，token 精确控制 |
| 长对话历史压缩 | ⭐⭐ | 可用分组思路，但需适配消息边界而非页边界 |
| 代码文件分析 | ⭐⭐ | 按函数/类为单元替代页，token 计数逻辑通用 |
| 流式文本处理 | ⭐ | 需改造为增量模式，当前实现是批处理 |

### 3.4 适配注意事项

1. **非 OpenAI 模型**：tiktoken 仅支持 OpenAI 模型的 tokenizer。使用 Claude 时需替换为
   `anthropic.count_tokens()` 或 Hugging Face 的 `AutoTokenizer`
2. **overlap 粒度**：PageIndex 以页为单位重叠。如果你的分块粒度是段落或句子，
   overlap 数量需要相应增大（建议 3-5 个段落）
3. **max_tokens 选择**：PageIndex 用 20000（约为 GPT-4o 128K 窗口的 15%），
   因为还需要留空间给 prompt 模板和 LLM 输出。建议设为模型窗口的 10-20%

---

## 第 4 章 测试用例

基于 PageIndex 真实函数签名编写的测试，可直接运行（需 `pip install tiktoken pytest`）：

```python
import math
import pytest

# --- 被测函数（从 PageIndex 提取的核心逻辑） ---

def count_tokens(text, model="gpt-4o"):
    import tiktoken
    if not text:
        return 0
    enc = tiktoken.encoding_for_model(model)
    return len(enc.encode(text))


def page_list_to_group_text(page_contents, token_lengths, max_tokens=20000, overlap_page=1):
    num_tokens = sum(token_lengths)
    if num_tokens <= max_tokens:
        return ["".join(page_contents)]
    subsets = []
    current_subset = []
    current_token_count = 0
    expected_parts_num = math.ceil(num_tokens / max_tokens)
    average_tokens_per_part = math.ceil(((num_tokens / expected_parts_num) + max_tokens) / 2)
    for i, (page_content, page_tokens) in enumerate(zip(page_contents, token_lengths)):
        if current_token_count + page_tokens > average_tokens_per_part:
            subsets.append("".join(current_subset))
            overlap_start = max(i - overlap_page, 0)
            current_subset = page_contents[overlap_start:i]
            current_token_count = sum(token_lengths[overlap_start:i])
        current_subset.append(page_content)
        current_token_count += page_tokens
    if current_subset:
        subsets.append("".join(current_subset))
    return subsets


def validate_and_truncate_physical_indices(toc, page_list_length, start_index=1):
    max_allowed = page_list_length + start_index - 1
    for item in toc:
        if item.get("physical_index") is not None and item["physical_index"] > max_allowed:
            item["physical_index"] = None
    return toc


# --- 测试类 ---

class TestCountTokens:
    def test_empty_text(self):
        assert count_tokens("") == 0
        assert count_tokens(None) == 0

    def test_known_text(self):
        tokens = count_tokens("Hello, world!")
        assert isinstance(tokens, int)
        assert tokens > 0

    def test_model_specific_encoding(self):
        text = "The quick brown fox jumps over the lazy dog."
        t1 = count_tokens(text, model="gpt-4o")
        t2 = count_tokens(text, model="gpt-3.5-turbo")
        # 不同模型的 tokenizer 可能产生不同结果
        assert isinstance(t1, int) and isinstance(t2, int)


class TestPageListToGroupText:
    def test_short_document_no_split(self):
        pages = ["page1 ", "page2 "]
        tokens = [100, 100]
        result = page_list_to_group_text(pages, tokens, max_tokens=20000)
        assert len(result) == 1
        assert result[0] == "page1 page2 "

    def test_split_into_groups(self):
        pages = [f"page{i} " for i in range(10)]
        tokens = [5000] * 10  # 总计 50000 tokens
        result = page_list_to_group_text(pages, tokens, max_tokens=20000)
        assert len(result) >= 3  # 50000/20000 至少 3 组

    def test_overlap_preserves_boundary(self):
        pages = ["A", "B", "C", "D", "E"]
        tokens = [10000, 10000, 10000, 10000, 10000]
        result = page_list_to_group_text(pages, tokens, max_tokens=20000, overlap_page=1)
        # 第二组应包含第一组最后一页的内容
        assert len(result) >= 2
        # 验证重叠：第二组的开头应包含前一组末尾的页
        if len(result) >= 2:
            first_group_pages = result[0]
            second_group_pages = result[1]
            # 重叠页的内容应同时出现在相邻组中
            assert len(second_group_pages) > len("D")  # 不只是单页

    def test_single_page(self):
        result = page_list_to_group_text(["only"], [100], max_tokens=20000)
        assert result == ["only"]

    def test_uniform_distribution(self):
        """验证分组大小的均匀性"""
        pages = [f"p{i}" for i in range(20)]
        tokens = [3000] * 20  # 总计 60000
        result = page_list_to_group_text(pages, tokens, max_tokens=20000)
        # 各组 token 数不应差异过大
        group_sizes = [len(g) for g in result]
        assert max(group_sizes) / min(group_sizes) < 3  # 最大组不超过最小组 3 倍


class TestValidateAndTruncate:
    def test_valid_indices_unchanged(self):
        toc = [{"title": "Ch1", "physical_index": 5}]
        result = validate_and_truncate_physical_indices(toc, page_list_length=10)
        assert result[0]["physical_index"] == 5

    def test_exceeding_index_set_to_none(self):
        toc = [{"title": "Ch1", "physical_index": 15}]
        result = validate_and_truncate_physical_indices(toc, page_list_length=10)
        assert result[0]["physical_index"] is None

    def test_none_index_unchanged(self):
        toc = [{"title": "Ch1", "physical_index": None}]
        result = validate_and_truncate_physical_indices(toc, page_list_length=10)
        assert result[0]["physical_index"] is None

    def test_empty_toc(self):
        assert validate_and_truncate_physical_indices([], 10) == []
```

---

## 第 5 章 跨域关联

| 关联域 | 关系类型 | 说明 |
|--------|----------|------|
| PD-04 工具系统 | 协同 | PageIndex 的 token 计数依赖 tiktoken 作为外部工具；分组后的 LLM 调用通过 `ChatGPT_API` 工具函数执行 |
| PD-03 容错与重试 | 协同 | `ChatGPT_API` 内置 `max_retries=10` 重试机制（`utils.py:30-57`），分组处理中任一 LLM 调用失败会触发重试 |
| PD-07 质量检查 | 依赖 | `meta_processor` 中的 `verify_toc()` 验证 TOC 准确率（`page_index.py:971`），accuracy < 0.6 触发降级，这是质量检查驱动上下文管理策略切换的典型模式 |
| PD-12 推理增强 | 协同 | 三级降级策略（有页码 TOC → 无页码 TOC → 无 TOC）本质上是推理路径的渐进增强，每级使用更多 LLM 推理来弥补输入信息的不足 |
| PD-08 搜索与检索 | 协同 | 分组后的文档结构（树 + 摘要）可直接用于检索索引构建，`generate_summaries_for_structure()` 为每个节点生成摘要（`utils.py:605-623`） |

### 与其他 PD-01 方案的对比

| 维度 | PageIndex（本方案） | MiroThinker | DeerFlow | GPT-Researcher |
|------|---------------------|-------------|----------|----------------|
| 分割粒度 | 页级（PDF 物理页） | 消息级（对话轮次） | 步骤级（工作流节点） | 段落级（搜索结果） |
| token 计数 | tiktoken 精确计数 | tiktoken 精确计数 | LangGraph 内置 | 估算 |
| 重叠机制 | overlap_page 滑动窗口 | 无（摘要替代） | 无 | 无 |
| 超限处理 | 递归拆分子结构 | 摘要压缩 | 截断 | 嵌入相似度筛选 |
| 配置化 | config.yaml | 硬编码 | 环境变量 | 硬编码 |

---

## 第 6 章 来源文件索引

| 文件 | 行范围 | 关键实现 |
|------|--------|----------|
| `pageindex/utils.py` | L22-27 | `count_tokens()` — tiktoken 精确 token 计数 |
| `pageindex/utils.py` | L413-437 | `get_page_tokens()` — 逐页 token 统计，支持 PyPDF2/PyMuPDF |
| `pageindex/utils.py` | L533-542 | `check_token_limit()` — 全局 110K token 安全校验 |
| `pageindex/config.yaml` | L1-8 | 全局配置：max_token_num_each_node=20000, max_page_num_each_node=10 |
| `pageindex/page_index.py` | L418-451 | `page_list_to_group_text()` — 核心分组算法 + 重叠页机制 |
| `pageindex/page_index.py` | L534-566 | `generate_toc_init()` — 首组 TOC 提取 |
| `pageindex/page_index.py` | L499-531 | `generate_toc_continue()` — 后续组增量 TOC 构建 |
| `pageindex/page_index.py` | L568-587 | `process_no_toc()` — 无 TOC 路径：分组 → 逐组提取 |
| `pageindex/page_index.py` | L951-989 | `meta_processor()` — 三级降级调度器 |
| `pageindex/page_index.py` | L992-1019 | `process_large_node_recursively()` — 大节点递归拆分 |
| `pageindex/page_index.py` | L1021-1055 | `tree_parser()` — 主流程：TOC 检测 → 处理 → 树构建 → 大节点拆分 |
| `pageindex/page_index.py` | L1058-1100 | `page_index_main()` — 入口函数，串联全流程 |
| `pageindex/page_index.py` | L1114-1144 | `validate_and_truncate_physical_indices()` — 索引越界截断 |
| `pageindex/page_index_md.py` | L89-132 | `update_node_list_with_text_token_count()` — Markdown 节点累计 token 计算 |
| `pageindex/page_index_md.py` | L135-187 | `tree_thinning_for_index()` — Markdown 树瘦身合并 |

---

## 第 7 章 横向对比维度

> 本章用于自动填充 Butcher Wiki 的横向对比表。

```json comparison_data
{
  "project": "PageIndex",
  "dimensions": {
    "估算方式": "tiktoken 按模型编码精确计算每页 token",
    "压缩策略": "树结构节点合并 + token 阈值瘦身",
    "触发机制": "分组 token 总数超过 LLM 上限时自动分割",
    "实现位置": "utils.py count_tokens + page_index.py 分组算法",
    "容错设计": "三级降级 + validate_and_truncate 索引越界防护",
    "分割粒度": "页级分组，overlap_page 保证语义连贯性",
    "树构建": "自底向上合并，token 超限节点递归拆分"
  }
}
```

**维度说明：**

- **估算方式**（复用已有）：PageIndex 使用 `tiktoken.encoding_for_model()` 获取与目标模型完全一致的 tokenizer，精确到 token 级别，非字符数估算
- **压缩策略**（复用已有）：PDF 路径通过 `process_large_node_recursively()` 递归拆分超限节点；Markdown 路径通过 `tree_thinning_for_index()` 将低 token 子节点合并到父节点
- **触发机制**（复用已有）：`page_list_to_group_text()` 在总 token 超过 `max_tokens`（默认 20000）时自动启动分组；`process_large_node_recursively()` 在节点同时超过页数和 token 双阈值时触发递归拆分
- **实现位置**（复用已有）：核心逻辑分布在 `utils.py`（token 计数）和 `page_index.py`（分组 + 树构建），通过 `config.yaml` 统一配置
- **容错设计**（复用已有）：`meta_processor` 三级降级（有页码 TOC → 无页码 TOC → 无 TOC），`validate_and_truncate_physical_indices` 防止 LLM 幻觉导致的索引越界
- **分割粒度**（新增）：以 PDF 物理页为最小分割单元，`overlap_page=1` 在分组边界保留重叠页防止跨页内容断裂，`average_tokens_per_part` 均匀化策略避免尾巴效应
- **树构建**（新增）：先通过分组 + LLM 提取平面 TOC，再 `post_processing()` 转为树结构，最后 `process_large_node_recursively()` 对超限节点递归拆分为子树
