# PD-12.04 PageIndex — 推理式检索替代向量搜索

> 文档编号：PD-12.04
> 来源：PageIndex `pageindex/page_index.py` / `tutorials/tree-search/README.md`
> GitHub：https://github.com/VectifyAI/PageIndex.git
> 问题域：PD-12 推理增强 Reasoning Enhancement
> 状态：可复用方案

---

## 第 1 章 问题与动机

### 1.1 核心问题

传统 RAG 系统依赖向量相似度搜索（embedding + cosine similarity）进行文档检索，但 **相似度 ≠ 相关性**。对于专业长文档（财报、法规、学术论文），向量搜索存在三个根本缺陷：

1. **语义模糊**：embedding 捕捉的是表面语义相似，无法进行多步推理判断真正的相关性
2. **分块破坏结构**：chunking 将文档切成碎片，丢失了章节层次和上下文关系
3. **不可解释**：向量搜索是黑盒的"氛围检索"（vibe retrieval），无法追溯检索依据

核心问题：**如何让 LLM 像人类专家一样，通过推理而非相似度匹配来定位文档中的相关内容？**

### 1.2 PageIndex 的解法概述

PageIndex 受 AlphaGo 的 MCTS（蒙特卡洛树搜索）启发，提出了一种全新的 **Vectorless, Reasoning-based RAG** 范式：

1. **树结构索引替代向量索引**：将 PDF 文档转化为层次化的目录树（类似 Table of Contents），每个节点对应文档的一个自然章节（`pageindex/page_index.py:1021-1055`）
2. **LLM 推理替代向量匹配**：所有检索判断都通过 LLM prompt 完成，每个 prompt 都要求输出 `thinking` 字段解释推理过程（`pageindex/page_index.py:23-37`）
3. **树搜索替代 top-k 搜索**：检索时 LLM 在树结构上进行推理导航，逐层定位相关节点（`tutorials/tree-search/README.md:8-21`）
4. **多轮验证与自修复**：构建树索引后通过 verify → fix → retry 循环确保准确性（`pageindex/page_index.py:892-944`）
5. **并发异步处理**：大量 LLM 调用通过 `asyncio.gather` 并发执行，提升吞吐量（`pageindex/page_index.py:84-101`）

### 1.3 设计思想

| 设计原则 | 具体实现 | 理由 | 替代方案 |
|----------|----------|------|----------|
| 推理优先于匹配 | 每个 LLM prompt 都包含 `thinking` 字段 | 相似度无法捕捉需要推理才能判断的相关性 | 向量相似度 + reranker |
| 结构保留优先于分块 | 构建层次化目录树而非 chunk 列表 | 文档的自然结构是人类导航的基础 | 固定大小 chunking |
| 验证驱动的准确性 | verify_toc → fix_incorrect → retry 循环 | LLM 单次输出不可靠，需要多轮校验 | 单次生成直接使用 |
| 渐进式降级 | 三种模式自动切换：有目录有页码 → 有目录无页码 → 无目录 | 不同文档结构差异大，需要自适应 | 统一处理流程 |
| 并发最大化 | asyncio.gather 并行处理所有独立 LLM 调用 | LLM 调用是 I/O 密集型，并发可大幅提速 | 串行逐个调用 |

---

## 第 2 章 源码实现分析

### 2.1 架构概览

PageIndex 的核心架构分为两个阶段：**树索引构建**（离线）和 **推理式检索**（在线）。

```
阶段一：树索引构建（离线）

┌─────────────┐     ┌──────────────────┐     ┌─────────────────┐
│  PDF 输入    │────→│  TOC 检测与提取   │────→│  目录树构建      │
│ (page_list)  │     │ find_toc_pages() │     │ toc_transformer()│
└─────────────┘     └──────────────────┘     └─────────────────┘
                            │                         │
                    ┌───────┴───────┐                 ▼
                    │ 三种模式自动选择│     ┌─────────────────────┐
                    │ ① 有TOC+页码  │     │  页码映射与验证       │
                    │ ② 有TOC无页码  │     │ verify_toc()         │
                    │ ③ 无TOC       │     │ fix_incorrect_toc()  │
                    └───────────────┘     └─────────────────────┘
                                                    │
                                                    ▼
                                          ┌─────────────────────┐
                                          │  大节点递归细分       │
                                          │ process_large_node   │
                                          │ _recursively()       │
                                          └─────────────────────┘
                                                    │
                                                    ▼
                                          ┌─────────────────────┐
                                          │  输出：层次化树结构   │
                                          │ {title, start_index, │
                                          │  end_index, nodes[]} │
                                          └─────────────────────┘

阶段二：推理式检索（在线）

┌──────────┐     ┌──────────────────┐     ┌─────────────────┐
│ 用户查询  │────→│ LLM 树搜索       │────→│ 节点内容提取     │
│ (query)   │     │ thinking + 选择  │     │ node → text     │
└──────────┘     └──────────────────┘     └─────────────────┘
                         │                         │
                         ▼                         ▼
                  ┌──────────────┐         ┌──────────────┐
                  │ 推理过程可追溯│         │ 答案生成      │
                  │ (thinking 字段)│        │ (基于上下文)  │
                  └──────────────┘         └──────────────┘
```

### 2.2 核心实现

#### 2.2.1 推理式 Prompt 设计模式

PageIndex 的所有 LLM 交互都遵循统一的 **Thinking-First JSON** 模式。每个 prompt 都要求 LLM 先输出推理过程，再给出结论。

`check_title_appearance()` (`pageindex/page_index.py:13-45`):

```python
async def check_title_appearance(item, page_list, start_index=1, model=None):
    title=item['title']
    if 'physical_index' not in item or item['physical_index'] is None:
        return {'list_index': item.get('list_index'), 'answer': 'no',
                'title':title, 'page_number': None}

    page_number = item['physical_index']
    page_text = page_list[page_number-start_index][0]

    prompt = f"""
    Your job is to check if the given section appears or starts in the given page_text.
    Note: do fuzzy matching, ignore any space inconsistency in the page_text.
    The given section title is {title}.
    The given page_text is {page_text}.

    Reply format:
    {{
        "thinking": <why do you think the section appears or starts in the page_text>
        "answer": "yes or no"
    }}
    Directly return the final JSON structure. Do not output anything else."""

    response = await ChatGPT_API_async(model=model, prompt=prompt)
    response = extract_json(response)
    if 'answer' in response:
        answer = response['answer']
    else:
        answer = 'no'
    return {'list_index': item['list_index'], 'answer': answer,
            'title': title, 'page_number': page_number}
```

这个模式在整个代码库中反复出现：
- `check_title_appearance_in_start()` (`page_index.py:48-71`) — 推理章节是否从页面开头开始
- `toc_detector_single_page()` (`page_index.py:104-122`) — 推理页面是否包含目录
- `check_if_toc_extraction_is_complete()` (`page_index.py:125-140`) — 推理目录提取是否完整
- `detect_page_index()` (`page_index.py:199-217`) — 推理目录中是否包含页码
- `single_toc_item_index_fixer()` (`page_index.py:732-748`) — 推理章节的正确物理页码

#### 2.2.2 三模式自适应处理流程

`meta_processor()` (`pageindex/page_index.py:951-989`) 是核心调度器，根据文档特征自动选择处理模式：

```python
async def meta_processor(page_list, mode=None, toc_content=None,
                         toc_page_list=None, start_index=1, opt=None, logger=None):
    if mode == 'process_toc_with_page_numbers':
        toc_with_page_number = process_toc_with_page_numbers(
            toc_content, toc_page_list, page_list, ...)
    elif mode == 'process_toc_no_page_numbers':
        toc_with_page_number = process_toc_no_page_numbers(
            toc_content, toc_page_list, page_list, ...)
    else:
        toc_with_page_number = process_no_toc(page_list, ...)

    # 验证准确性
    accuracy, incorrect_results = await verify_toc(
        page_list, toc_with_page_number, ...)

    if accuracy == 1.0:
        return toc_with_page_number
    if accuracy > 0.6:
        # 修复错误项
        toc_with_page_number, _ = await fix_incorrect_toc_with_retries(
            toc_with_page_number, page_list, incorrect_results, ...)
        return toc_with_page_number
    else:
        # 降级到更简单的模式
        if mode == 'process_toc_with_page_numbers':
            return await meta_processor(..., mode='process_toc_no_page_numbers')
        elif mode == 'process_toc_no_page_numbers':
            return await meta_processor(..., mode='process_no_toc')
```

#### 2.2.3 递归树搜索推理

`process_large_node_recursively()` (`pageindex/page_index.py:992-1019`) 是 PageIndex 最具创新性的设计——模拟人类专家逐层深入文档的阅读方式。当一个节点的页数或 token 数超过阈值时，递归地对其进行细分：

```python
async def process_large_node_recursively(node, page_list, opt=None, logger=None):
    node_page_list = page_list[node['start_index']-1:node['end_index']]
    token_num = sum([page[1] for page in node_page_list])

    if (node['end_index'] - node['start_index'] > opt.max_page_num_each_node
            and token_num >= opt.max_token_num_each_node):
        # 对大节点重新运行 meta_processor，生成子目录
        node_toc_tree = await meta_processor(
            node_page_list, mode='process_no_toc',
            start_index=node['start_index'], opt=opt, logger=logger)

        # 递归处理子节点
        if valid_node_toc_items and node['title'].strip() == valid_node_toc_items[0]['title'].strip():
            node['nodes'] = post_processing(valid_node_toc_items[1:], node['end_index'])
        else:
            node['nodes'] = post_processing(valid_node_toc_items, node['end_index'])

    # 对所有子节点并发递归
    if 'nodes' in node and node['nodes']:
        tasks = [
            process_large_node_recursively(child_node, page_list, opt, logger=logger)
            for child_node in node['nodes']
        ]
        await asyncio.gather(*tasks)
    return node
```

关键设计点：
- **阈值双条件**：同时检查页数（`max_page_num_each_node=10`）和 token 数（`max_token_num_each_node=20000`），避免误判（`page_index.py:996`）
- **递归复用**：大节点的细分直接复用 `meta_processor` 的完整流程（含验证和修复），保证每一层的准确性
- **并发递归**：同层的子节点通过 `asyncio.gather` 并发处理（`page_index.py:1013-1017`）

#### 2.2.4 验证-修复-重试循环

`verify_toc()` (`pageindex/page_index.py:892-944`) 和 `fix_incorrect_toc_with_retries()` (`page_index.py:870-886`) 构成了质量保障闭环：

```python
async def verify_toc(page_list, list_result, start_index=1, N=None, model=None):
    # 对每个 TOC 条目并发验证：标题是否真的出现在对应页面
    tasks = [check_title_appearance(item, page_list, start_index, model)
             for item in list_result if item.get('physical_index') is not None]
    results = await asyncio.gather(*tasks, return_exceptions=True)
    # 统计准确率，收集错误项
    ...

async def fix_incorrect_toc_with_retries(toc, page_list, incorrect_results,
                                          start_index=1, max_attempts=3, ...):
    fix_attempt = 0
    while current_incorrect:
        current_toc, current_incorrect = await fix_incorrect_toc(
            current_toc, page_list, current_incorrect, ...)
        fix_attempt += 1
        if fix_attempt >= max_attempts:
            break
    return current_toc, current_incorrect
```

修复策略（`fix_incorrect_toc()` `page_index.py:752-866`）：
1. 找到错误项的前后正确锚点（`page_index.py:774-795`）
2. 提取锚点之间的页面内容
3. 用 `single_toc_item_index_fixer()` 重新推理正确页码（`page_index.py:732-748`）
4. 再次验证修复结果，不正确的进入下一轮

### 2.3 实现细节

#### Thinking-First JSON 的统一 prompt 模式

所有 LLM 调用的 prompt 都遵循相同的结构：

```
1. 角色定义 + 任务描述
2. 输入数据（内联到 prompt 中）
3. 回复格式要求：
   {
       "thinking": <推理过程>,
       "<answer_field>": "<结论>"
   }
4. "Directly return the final JSON structure. Do not output anything else."
```

这个模式的关键特征：
- **强制推理**：`thinking` 字段不是可选的，是 JSON schema 的必需部分
- **结构化输出**：所有响应都是 JSON，通过 `extract_json()` (`utils.py:125-156`) 解析
- **容错解析**：`extract_json()` 处理了 ````json` 包裹、Python `None` 替换、尾逗号清理等常见 LLM 输出问题
- **temperature=0**：所有 API 调用都设置 `temperature=0`（`utils.py:43`, `utils.py:73`, `utils.py:98`），确保推理的确定性

#### 数据流：从 PDF 到树结构

```
PDF → get_page_tokens() → [(page_text, token_count), ...]
  → tree_parser()
    → check_toc() → find_toc_pages() → toc_extractor()
    → meta_processor() → [三种模式之一]
      → verify_toc() → fix_incorrect_toc_with_retries()
    → post_processing() → 扁平列表 → 层次化树
    → process_large_node_recursively() → 递归细分大节点
  → 可选：write_node_id() / add_node_text() / generate_summaries()
  → 输出 JSON 树结构
```

---

## 第 3 章 迁移指南

### 3.1 迁移清单

将 PageIndex 的推理增强模式迁移到自己的项目，分三个阶段：

**阶段一：Thinking-First Prompt 模式（1-2 天）**
- [ ] 定义统一的 prompt 模板，包含 `thinking` 字段
- [ ] 实现 `extract_json()` 容错解析器
- [ ] 封装 LLM 调用函数（同步 + 异步），设置 `temperature=0`
- [ ] 添加重试机制（max_retries=10）

**阶段二：验证-修复循环（2-3 天）**
- [ ] 实现验证函数：对 LLM 输出进行独立验证
- [ ] 实现修复函数：基于上下文范围缩小重新推理
- [ ] 实现重试循环：最多 N 次修复尝试
- [ ] 添加准确率阈值判断和降级策略

**阶段三：递归推理（可选，2-3 天）**
- [ ] 实现树结构数据模型
- [ ] 实现大节点检测（页数 + token 双阈值）
- [ ] 实现递归细分逻辑
- [ ] 添加并发处理（asyncio.gather）

### 3.2 适配代码模板

#### 通用 Thinking-First Prompt 框架

```python
import json
import asyncio
from openai import AsyncOpenAI

client = AsyncOpenAI()

def build_thinking_prompt(task_description: str, input_data: str,
                          answer_fields: dict[str, str]) -> str:
    """构建统一的 thinking-first prompt。

    Args:
        task_description: 任务描述
        input_data: 输入数据（将内联到 prompt）
        answer_fields: 答案字段定义，如 {"answer": "yes or no"}
    """
    fields = ',\n        '.join(
        f'"{k}": "{v}"' for k, v in answer_fields.items()
    )
    return f"""
    {task_description}

    Input: {input_data}

    Reply format:
    {{
        "thinking": <explain your reasoning step by step>,
        {fields}
    }}
    Directly return the final JSON structure. Do not output anything else."""


def extract_json_safe(content: str) -> dict:
    """容错 JSON 解析，处理 LLM 常见输出格式问题。"""
    try:
        # 去除 ```json 包裹
        if "```json" in content:
            start = content.find("```json") + 7
            end = content.rfind("```")
            content = content[start:end].strip()
        else:
            content = content.strip()

        content = content.replace('None', 'null')
        content = content.replace('\n', ' ').replace('\r', ' ')
        content = ' '.join(content.split())

        return json.loads(content)
    except json.JSONDecodeError:
        content = content.replace(',]', ']').replace(',}', '}')
        try:
            return json.loads(content)
        except:
            return {}


async def llm_reason(prompt: str, model: str = "gpt-4o",
                     max_retries: int = 10) -> dict:
    """带重试的 LLM 推理调用，返回解析后的 JSON。"""
    for i in range(max_retries):
        try:
            response = await client.chat.completions.create(
                model=model,
                messages=[{"role": "user", "content": prompt}],
                temperature=0,
            )
            return extract_json_safe(response.choices[0].message.content)
        except Exception as e:
            if i < max_retries - 1:
                await asyncio.sleep(1)
            else:
                return {}


async def verify_and_fix(items: list, verify_fn, fix_fn,
                         max_attempts: int = 3) -> list:
    """通用的验证-修复-重试循环。

    Args:
        items: 待验证的项目列表
        verify_fn: 验证函数，返回 (correct_items, incorrect_items)
        fix_fn: 修复函数，接收 incorrect_items，返回修复后的 items
        max_attempts: 最大修复轮次
    """
    correct, incorrect = await verify_fn(items)
    attempt = 0
    while incorrect and attempt < max_attempts:
        fixed = await fix_fn(incorrect)
        correct_new, incorrect = await verify_fn(fixed)
        correct.extend(correct_new)
        attempt += 1
    return correct
```

### 3.3 适用场景

| 场景 | 适用度 | 说明 |
|------|--------|------|
| 长文档结构化解析（PDF/论文/财报） | ⭐⭐⭐ | PageIndex 的核心场景，直接复用 |
| 需要可解释检索结果的 RAG 系统 | ⭐⭐⭐ | thinking 字段提供完整推理链 |
| LLM 输出需要高准确率的场景 | ⭐⭐⭐ | verify-fix-retry 循环显著提升准确率 |
| 多步推理判断（非简单分类） | ⭐⭐ | thinking-first 模式适合需要推理的任务 |
| 实时低延迟检索 | ⭐ | 多轮 LLM 调用延迟较高，不适合实时场景 |
| 短文本 / 简单 FAQ 检索 | ⭐ | 杀鸡用牛刀，向量搜索更高效 |

---

## 第 4 章 测试用例

```python
import pytest
import json
import asyncio
from unittest.mock import AsyncMock, patch, MagicMock


class TestExtractJson:
    """测试 extract_json 容错解析器"""

    def test_normal_json(self):
        content = '{"thinking": "the title matches", "answer": "yes"}'
        result = extract_json_safe(content)
        assert result["answer"] == "yes"
        assert "thinking" in result

    def test_json_with_code_block(self):
        content = '```json\n{"thinking": "reason", "answer": "no"}\n```'
        result = extract_json_safe(content)
        assert result["answer"] == "no"

    def test_json_with_none(self):
        content = '{"thinking": "reason", "physical_index": None}'
        result = extract_json_safe(content)
        assert result["physical_index"] is None

    def test_json_with_trailing_comma(self):
        content = '{"thinking": "reason", "answer": "yes",}'
        result = extract_json_safe(content)
        assert result["answer"] == "yes"

    def test_invalid_json_returns_empty(self):
        content = 'not json at all'
        result = extract_json_safe(content)
        assert result == {}


class TestBuildThinkingPrompt:
    """测试 thinking-first prompt 构建"""

    def test_prompt_contains_thinking_field(self):
        prompt = build_thinking_prompt(
            task_description="Check if title appears",
            input_data="some page text",
            answer_fields={"answer": "yes or no"}
        )
        assert '"thinking"' in prompt
        assert '"answer"' in prompt
        assert "Directly return the final JSON" in prompt

    def test_multiple_answer_fields(self):
        prompt = build_thinking_prompt(
            task_description="Detect TOC",
            input_data="page content",
            answer_fields={"toc_detected": "yes or no", "confidence": "0-1"}
        )
        assert '"toc_detected"' in prompt
        assert '"confidence"' in prompt


class TestVerifyAndFix:
    """测试验证-修复-重试循环"""

    @pytest.mark.asyncio
    async def test_all_correct_no_fix_needed(self):
        items = [{"title": "A", "page": 1}, {"title": "B", "page": 5}]

        async def verify_fn(items):
            return items, []  # 全部正确

        async def fix_fn(incorrect):
            return incorrect

        result = await verify_and_fix(items, verify_fn, fix_fn)
        assert len(result) == 2

    @pytest.mark.asyncio
    async def test_fix_after_one_retry(self):
        call_count = {"n": 0}

        async def verify_fn(items):
            call_count["n"] += 1
            if call_count["n"] == 1:
                return items[:1], items[1:]  # 第一次：1 正确 1 错误
            return items, []  # 第二次：全部正确

        async def fix_fn(incorrect):
            for item in incorrect:
                item["page"] = 10  # 修复
            return incorrect

        items = [{"title": "A", "page": 1}, {"title": "B", "page": -1}]
        result = await verify_and_fix(items, verify_fn, fix_fn)
        assert len(result) == 2

    @pytest.mark.asyncio
    async def test_max_attempts_respected(self):
        async def verify_fn(items):
            return [], items  # 永远失败

        async def fix_fn(incorrect):
            return incorrect

        items = [{"title": "A"}]
        result = await verify_and_fix(items, verify_fn, fix_fn, max_attempts=2)
        assert len(result) == 0  # 达到最大重试次数后放弃


class TestLLMReasonIntegration:
    """集成测试：模拟 LLM 推理调用"""

    @pytest.mark.asyncio
    async def test_thinking_first_response(self):
        mock_response = MagicMock()
        mock_response.choices = [MagicMock()]
        mock_response.choices[0].message.content = json.dumps({
            "thinking": "The title 'Introduction' appears at the top of the page",
            "answer": "yes"
        })

        with patch('openai.AsyncOpenAI') as mock_client:
            instance = mock_client.return_value
            instance.chat.completions.create = AsyncMock(return_value=mock_response)

            prompt = build_thinking_prompt(
                "Check title appearance",
                "Introduction\nThis paper presents...",
                {"answer": "yes or no"}
            )
            result = await llm_reason(prompt)
            assert result["answer"] == "yes"
            assert "Introduction" in result["thinking"]
```

---

## 第 5 章 跨域关联

| 关联域 | 关系类型 | 说明 |
|--------|----------|------|
| PD-01 上下文管理 | 协同 | PageIndex 通过树结构将长文档分解为可管理的节点，每个节点的 token 数受 `max_token_num_each_node` 控制，本质上是一种结构化的上下文窗口管理 |
| PD-03 容错与重试 | 依赖 | verify-fix-retry 循环是 PD-03 容错模式的具体应用。`fix_incorrect_toc_with_retries()` 的 `max_attempts=3` 和 `meta_processor` 的三模式降级都是容错策略 |
| PD-04 工具系统 | 协同 | PageIndex 的 LLM 调用可以封装为 Agent 工具（如 `build_tree_index` 工具和 `tree_search` 工具），集成到更大的 Agent 系统中 |
| PD-07 质量检查 | 依赖 | `verify_toc()` 是质量检查的实例——对 LLM 输出进行独立验证，准确率低于 0.6 时触发降级 |
| PD-08 搜索与检索 | 协同 | PageIndex 的树搜索是 PD-08 的一种实现方式，用推理替代向量相似度进行检索。可与传统向量搜索互补 |
| PD-11 可观测性 | 协同 | `thinking` 字段天然提供了推理过程的可观测性，`JsonLogger` 记录了每一步的中间结果，便于调试和成本追踪 |

---

## 第 6 章 来源文件索引

| 文件 | 行范围 | 关键实现 |
|------|--------|----------|
| `pageindex/page_index.py` | L13-45 | `check_title_appearance()` — thinking-first 验证模式 |
| `pageindex/page_index.py` | L48-71 | `check_title_appearance_in_start()` — 页面起始位置推理 |
| `pageindex/page_index.py` | L104-122 | `toc_detector_single_page()` — TOC 检测推理 |
| `pageindex/page_index.py` | L125-140 | `check_if_toc_extraction_is_complete()` — 完整性推理 |
| `pageindex/page_index.py` | L199-217 | `detect_page_index()` — 页码存在性推理 |
| `pageindex/page_index.py` | L534-566 | `generate_toc_init()` — 无 TOC 时的结构生成 |
| `pageindex/page_index.py` | L568-587 | `process_no_toc()` — 分组推理生成目录 |
| `pageindex/page_index.py` | L732-748 | `single_toc_item_index_fixer()` — 页码修复推理 |
| `pageindex/page_index.py` | L870-886 | `fix_incorrect_toc_with_retries()` — 重试循环 |
| `pageindex/page_index.py` | L892-944 | `verify_toc()` — 并发验证 |
| `pageindex/page_index.py` | L951-989 | `meta_processor()` — 三模式调度 + 降级 |
| `pageindex/page_index.py` | L992-1019 | `process_large_node_recursively()` — 递归树搜索推理 |
| `pageindex/page_index.py` | L1021-1055 | `tree_parser()` — 主流程入口 |
| `pageindex/page_index.py` | L1058-1100 | `page_index_main()` — 顶层入口 |
| `pageindex/utils.py` | L29-57 | `ChatGPT_API_with_finish_reason()` — 带完成原因的 LLM 调用 |
| `pageindex/utils.py` | L89-108 | `ChatGPT_API_async()` — 异步 LLM 调用 |
| `pageindex/utils.py` | L125-156 | `extract_json()` — 容错 JSON 解析 |
| `pageindex/config.yaml` | L1-8 | 默认配置（模型、阈值参数） |

---

## 第 7 章 横向对比维度

> **重要：** 本章用于自动填充 Butcher Wiki 的横向对比表。
> 必须严格按以下 JSON 格式输出，放在 `comparison_data` 代码块中。

```json comparison_data
{
  "project": "PageIndex",
  "dimensions": {
    "推理模式": "Thinking-First JSON — 每个 LLM prompt 强制输出 thinking 推理字段再给结论",
    "思考预算": "无显式 token 预算，通过 temperature=0 + 结构化 JSON 隐式约束推理长度",
    "输出结构": "统一 {thinking, answer_field} JSON schema，extract_json 容错解析",
    "增强策略": "树搜索推理 + 验证-修复-重试循环 + 三模式渐进降级",
    "成本控制": "asyncio.gather 并发批量调用 + 大节点递归细分减少单次 token 消耗",
    "检索范式": "Vectorless — 用 LLM 推理替代向量相似度，在树结构上导航定位",
    "树构建": "自底向上：TOC 检测 → 结构提取 → 页码映射 → 大节点递归拆分",
    "专家知识集成": "将 Expert Knowledge 直接注入树搜索 prompt，无需微调 embedding"
  }
}
```

**维度说明：**
- "推理模式""思考预算""输出结构""增强策略""成本控制" 复用了 PD-12 已有维度
- "检索范式""树构建""专家知识集成" 是 PageIndex 独有的新维度，反映其以推理替代向量搜索的核心创新
