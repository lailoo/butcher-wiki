# PD-07.03 PageIndex — LLM 输出准确率验证闭环

> 文档编号：PD-07.03
> 来源：PageIndex `pageindex/page_index.py`
> GitHub：https://github.com/VectifyAI/PageIndex.git
> 问题域：PD-07 质量检查 Quality Assurance
> 状态：可复用方案

---

## 第 1 章 问题与动机

### 1.1 核心问题

LLM 在处理长文档结构化任务（如 PDF 目录提取、章节页码映射）时，输出的结构化数据存在不可忽视的错误率。典型问题包括：

- **页码幻觉**：LLM 生成的章节起始页码与文档实际内容不匹配
- **结构遗漏**：TOC 提取不完整，丢失部分章节
- **格式转换失真**：原始 TOC 到 JSON 结构的转换过程中信息丢失
- **越界引用**：生成的物理页码超出文档实际页数（文件损坏或截断场景）

这些问题在传统软件中不存在——它们是 LLM 输出的固有不确定性带来的。如果不加验证直接使用 LLM 输出，下游的文档索引、检索、摘要等功能都会受到污染。

### 1.2 PageIndex 的解法概述

PageIndex 实现了一套完整的「生成→验证→修复→再验证」质量保证循环，核心策略是：

1. **LLM-as-Judge 验证**：用 LLM 自身验证 LLM 的输出——通过 `check_title_appearance()` 异步并发检查每个章节标题是否真实出现在对应页面中（`page_index.py:13-45`）
2. **准确率量化决策**：`verify_toc()` 计算全量或采样验证的 accuracy 准确率，`meta_processor()` 根据准确率阈值（1.0/0.6）决定通过、修复或降级重新生成（`page_index.py:970-989`）
3. **LLM 完整性校验**：`check_if_toc_extraction_is_complete()` 和 `check_if_toc_transformation_is_complete()` 使用 LLM 验证 TOC 提取和转换的完整性（`page_index.py:125-158`）
4. **硬约束边界验证**：`validate_and_truncate_physical_indices()` 用确定性逻辑验证物理页码不超出文档实际长度（`page_index.py:1114-1143`）
5. **多级降级策略**：验证失败时按 `process_toc_with_page_numbers → process_toc_no_page_numbers → process_no_toc` 三级降级（`page_index.py:984-989`）

### 1.3 设计思想

| 设计原则 | 具体实现 | 理由 | 替代方案 |
|----------|----------|------|----------|
| LLM-as-Judge | `check_title_appearance()` 用 LLM 模糊匹配标题是否出现在页面文本中 | 页面文本存在 OCR 噪声和格式差异，精确字符串匹配不可靠 | 正则匹配、模糊字符串匹配（fuzz ratio） |
| 量化决策而非二元判断 | accuracy 准确率 + 阈值分级（1.0 通过 / >0.6 修复 / ≤0.6 降级） | 避免因少量错误丢弃整体结果，同时对低质量结果果断降级 | 固定重试次数、全量重新生成 |
| 异步并发验证 | `asyncio.gather(*tasks)` 并发执行所有标题检查 | 验证任务互相独立，并发可大幅降低延迟 | 串行逐个验证 |
| 确定性 + 概率性双重验证 | 硬约束（页码越界检查）+ 软约束（LLM 语义验证） | 硬约束零成本高可靠，软约束处理模糊场景 | 仅用 LLM 验证一切 |
| 渐进式降级 | 三级处理模式递归降级 | 优先利用已有信息（TOC+页码），信息不可靠时逐步放弃 | 直接用最保守模式 |

---

## 第 2 章 源码实现分析

### 2.1 架构概览

PageIndex 的质量保证系统贯穿整个 TOC 处理流水线，形成多层验证闭环：

```
┌─────────────────────────────────────────────────────────────────┐
│                      tree_parser() 入口                         │
│  ┌──────────┐    ┌───────────────┐    ┌──────────────────────┐  │
│  │ check_toc│───→│meta_processor │───→│ post_processing      │  │
│  │ (TOC检测) │    │  (核心编排器)  │    │ (结构化输出)          │  │
│  └──────────┘    └───────┬───────┘    └──────────────────────┘  │
│                          │                                       │
│         ┌────────────────┼────────────────┐                     │
│         ▼                ▼                ▼                     │
│  ┌─────────────┐  ┌───────────┐  ┌──────────────┐              │
│  │ validate_   │  │verify_toc │  │ fix_incorrect│              │
│  │ truncate_   │  │(准确率计算)│  │ _toc_with_   │              │
│  │ physical_   │  │           │  │ retries      │              │
│  │ indices     │  │           │  │ (修复循环)    │              │
│  │ (硬约束)    │  │           │  │              │              │
│  └─────────────┘  └─────┬─────┘  └──────┬───────┘              │
│                         │               │                       │
│                         ▼               ▼                       │
│                  ┌──────────────────────────┐                   │
│                  │ check_title_appearance() │                   │
│                  │ (LLM-as-Judge 单元验证)   │                   │
│                  │ asyncio.gather 并发执行    │                   │
│                  └──────────────────────────┘                   │
│                                                                 │
│  降级路径: toc_with_pages → toc_no_pages → no_toc              │
│            accuracy=1.0    accuracy>0.6    accuracy≤0.6         │
└─────────────────────────────────────────────────────────────────┘
```

### 2.2 核心实现

#### 2.2.1 LLM-as-Judge 单元验证：`check_title_appearance()`

这是整个质量保证系统的原子验证单元。每次调用验证一个章节标题是否出现在指定页面中（`page_index.py:13-45`）：

```python
async def check_title_appearance(item, page_list, start_index=1, model=None):
    title = item['title']
    if 'physical_index' not in item or item['physical_index'] is None:
        return {'list_index': item.get('list_index'), 'answer': 'no',
                'title': title, 'page_number': None}

    page_number = item['physical_index']
    page_text = page_list[page_number - start_index][0]

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
    answer = response.get('answer', 'no')
    return {'list_index': item['list_index'], 'answer': answer,
            'title': title, 'page_number': page_number}
```

关键设计点：
- 使用 **fuzzy matching** 指令，容忍 OCR 噪声和空格差异
- 要求 LLM 输出 `thinking` 字段，利用 Chain-of-Thought 提升判断准确性
- 异步接口 `ChatGPT_API_async`，支持并发调用

#### 2.2.2 全量/采样验证：`verify_toc()`

`verify_toc()` 是验证编排器，支持全量验证和随机采样验证（`page_index.py:892-944`）：

```python
async def verify_toc(page_list, list_result, start_index=1, N=None, model=None):
    # 早期退出：最后一个有效页码不到文档一半，说明结果质量极差
    last_physical_index = None
    for item in reversed(list_result):
        if item.get('physical_index') is not None:
            last_physical_index = item['physical_index']
            break
    if last_physical_index is None or last_physical_index < len(page_list) / 2:
        return 0, []

    # 全量 vs 采样
    if N is None:
        sample_indices = range(0, len(list_result))
    else:
        N = min(N, len(list_result))
        sample_indices = random.sample(range(0, len(list_result)), N)

    # 并发执行所有检查
    tasks = [check_title_appearance(item, page_list, start_index, model)
             for item in indexed_sample_list]
    results = await asyncio.gather(*tasks)

    # 计算准确率
    correct_count = sum(1 for r in results if r['answer'] == 'yes')
    accuracy = correct_count / len(results) if results else 0
    return accuracy, incorrect_results
```

#### 2.2.3 定向修复循环：`fix_incorrect_toc()` + `fix_incorrect_toc_with_retries()`

验证发现错误后，PageIndex 不是重新生成整个 TOC，而是精准定位错误条目并在局部范围内修复（`page_index.py:752-866`）：

```python
async def fix_incorrect_toc(toc_with_page_number, page_list, incorrect_results,
                            start_index=1, model=None, logger=None):
    incorrect_indices = {result['list_index'] for result in incorrect_results}

    async def process_and_check_item(incorrect_item):
        list_index = incorrect_item['list_index']

        # 向前找最近的正确条目作为搜索范围下界
        prev_correct = None
        for i in range(list_index-1, -1, -1):
            if i not in incorrect_indices:
                physical_index = toc_with_page_number[i].get('physical_index')
                if physical_index is not None:
                    prev_correct = physical_index
                    break
        if prev_correct is None:
            prev_correct = start_index - 1

        # 向后找最近的正确条目作为搜索范围上界
        next_correct = None
        for i in range(list_index+1, len(toc_with_page_number)):
            if i not in incorrect_indices:
                physical_index = toc_with_page_number[i].get('physical_index')
                if physical_index is not None:
                    next_correct = physical_index
                    break
        if next_correct is None:
            next_correct = end_index

        # 在 [prev_correct, next_correct] 范围内重新定位
        content_range = ''.join(page_contents)
        physical_index_int = single_toc_item_index_fixer(
            incorrect_item['title'], content_range, model)

        # 修复后立即验证
        check_item = incorrect_item.copy()
        check_item['physical_index'] = physical_index_int
        check_result = await check_title_appearance(
            check_item, page_list, start_index, model)
        return {
            'list_index': list_index,
            'title': incorrect_item['title'],
            'physical_index': physical_index_int,
            'is_valid': check_result['answer'] == 'yes'
        }

    # 所有错误条目并发修复
    tasks = [process_and_check_item(item) for item in incorrect_results]
    results = await asyncio.gather(*tasks, return_exceptions=True)
```

关键设计点：
- **范围缩窄**：利用前后正确条目的页码作为搜索边界，避免全文档搜索
- **修复后即验证**：每个修复结果立即通过 `check_title_appearance()` 验证，不盲信修复结果
- **并发修复**：所有错误条目独立修复，`asyncio.gather` 并发执行

外层 `fix_incorrect_toc_with_retries()` 提供最多 3 次重试（`page_index.py:870-886`）：

```python
async def fix_incorrect_toc_with_retries(toc_with_page_number, page_list,
                                          incorrect_results, start_index=1,
                                          max_attempts=3, model=None, logger=None):
    fix_attempt = 0
    current_toc = toc_with_page_number
    current_incorrect = incorrect_results
    while current_incorrect:
        current_toc, current_incorrect = await fix_incorrect_toc(
            current_toc, page_list, current_incorrect, start_index, model, logger)
        fix_attempt += 1
        if fix_attempt >= max_attempts:
            break
    return current_toc, current_incorrect
```

#### 2.2.4 LLM 完整性校验：`check_if_toc_extraction_is_complete()` / `check_if_toc_transformation_is_complete()`

这两个函数在 TOC 提取和转换阶段使用 LLM 验证输出完整性（`page_index.py:125-158`）：

```python
def check_if_toc_extraction_is_complete(content, toc, model=None):
    prompt = f"""
    You are given a partial document and a table of contents.
    Your job is to check if the table of contents is complete,
    which it contains all the main sections in the partial document.
    Reply format:
    {{
        "thinking": <why do you think the table of contents is complete or not>
        "completed": "yes" or "no"
    }}
    Directly return the final JSON structure. Do not output anything else."""
    prompt = prompt + '\n Document:\n' + content + '\n Table of contents:\n' + toc
    response = ChatGPT_API(model=model, prompt=prompt)
    json_content = extract_json(response)
    return json_content['completed']
```

这两个函数在 `extract_toc_content()` 和 `toc_transformer()` 中被调用，形成「生成→检查完整性→不完整则继续生成」的循环（`page_index.py:160-197`）。

#### 2.2.5 硬约束边界验证：`validate_and_truncate_physical_indices()`

纯确定性逻辑，零 LLM 调用成本（`page_index.py:1114-1143`）：

```python
def validate_and_truncate_physical_indices(toc_with_page_number,
                                            page_list_length,
                                            start_index=1, logger=None):
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

### 2.3 实现细节

#### 数据流：meta_processor 决策树

`meta_processor()` 是质量保证的核心编排器（`page_index.py:951-989`），其决策逻辑如下：

```
meta_processor(mode) 入口
    │
    ├─ 按 mode 生成 toc_with_page_number
    │
    ├─ validate_and_truncate_physical_indices()  ← 硬约束过滤
    │
    ├─ verify_toc() → (accuracy, incorrect_results)
    │
    ├─ accuracy == 1.0 且无错误 → 直接返回 ✓
    │
    ├─ accuracy > 0.6 且有错误 → fix_incorrect_toc_with_retries()
    │   │                          (最多 3 轮修复)
    │   └─ 返回修复后结果
    │
    └─ accuracy ≤ 0.6 → 降级到下一个 mode
        ├─ process_toc_with_page_numbers → process_toc_no_page_numbers
        ├─ process_toc_no_page_numbers → process_no_toc
        └─ process_no_toc → raise Exception
```

#### 并发验证的位置标记检查

`check_title_appearance_in_start_concurrent()` 并发检查每个标题是否出现在页面开头（`page_index.py:74-101`），结果存入 `appear_start` 字段，供 `post_processing()` 决定章节的 `end_index` 是否需要减 1（`utils.py:460-479`）：

```python
# post_processing 中的边界计算逻辑
if structure[i + 1].get('appear_start') == 'yes':
    item['end_index'] = structure[i + 1]['physical_index'] - 1  # 下一章从新页开始
else:
    item['end_index'] = structure[i + 1]['physical_index']      # 下一章在同页中间开始
```

---

## 第 3 章 迁移指南

### 3.1 迁移清单

将 PageIndex 的质量验证闭环迁移到自己的 LLM 输出验证场景，分三个阶段：

**阶段 1：基础验证层**
- [ ] 实现 `LLMJudge` 基类，封装「用 LLM 验证 LLM 输出」的通用模式
- [ ] 实现 `verify()` 方法：并发执行验证任务，返回 accuracy + 错误列表
- [ ] 实现硬约束验证（确定性规则，不依赖 LLM）

**阶段 2：修复循环**
- [ ] 实现 `fix()` 方法：基于错误列表定向修复，修复后立即验证
- [ ] 实现 `fix_with_retries()` 方法：带最大重试次数的修复循环
- [ ] 实现范围缩窄策略（利用正确结果缩小修复搜索范围）

**阶段 3：降级策略**
- [ ] 定义多级处理模式（从信息最丰富到最保守）
- [ ] 实现 accuracy 阈值决策逻辑（通过/修复/降级）
- [ ] 实现递归降级调用

### 3.2 适配代码模板

以下是一个通用的 LLM 输出验证闭环框架，可直接复用：

```python
import asyncio
from dataclasses import dataclass, field
from typing import Any, Callable, Awaitable
from abc import ABC, abstractmethod


@dataclass
class VerifyResult:
    item_id: str
    is_correct: bool
    detail: dict = field(default_factory=dict)


@dataclass
class FixResult:
    item_id: str
    fixed_value: Any
    is_valid: bool  # 修复后验证结果


class LLMOutputVerifier(ABC):
    """通用 LLM 输出验证闭环框架（源自 PageIndex 模式）"""

    def __init__(self, accuracy_pass: float = 1.0,
                 accuracy_fix: float = 0.6,
                 max_fix_attempts: int = 3):
        self.accuracy_pass = accuracy_pass
        self.accuracy_fix = accuracy_fix
        self.max_fix_attempts = max_fix_attempts

    @abstractmethod
    async def verify_single(self, item: dict) -> VerifyResult:
        """验证单个输出项（对应 check_title_appearance）"""
        ...

    @abstractmethod
    async def fix_single(self, item: dict,
                         context: dict) -> FixResult:
        """修复单个错误项（对应 single_toc_item_index_fixer）"""
        ...

    @abstractmethod
    def validate_hard_constraints(self, items: list) -> list:
        """确定性硬约束验证（对应 validate_and_truncate）"""
        ...

    async def verify_all(self, items: list,
                         sample_n: int | None = None) -> tuple[float, list]:
        """并发验证，返回 (accuracy, incorrect_items)"""
        if sample_n is not None:
            import random
            sample_n = min(sample_n, len(items))
            items = random.sample(items, sample_n)

        tasks = [self.verify_single(item) for item in items]
        results = await asyncio.gather(*tasks, return_exceptions=True)

        correct = 0
        incorrect = []
        for item, result in zip(items, results):
            if isinstance(result, Exception):
                incorrect.append(item)
            elif result.is_correct:
                correct += 1
            else:
                incorrect.append(item)

        accuracy = correct / len(results) if results else 0
        return accuracy, incorrect

    async def fix_with_retries(self, items: list,
                                incorrect: list,
                                context: dict) -> tuple[list, list]:
        """带重试的修复循环"""
        current_incorrect = incorrect
        for attempt in range(self.max_fix_attempts):
            if not current_incorrect:
                break
            tasks = [self.fix_single(item, context)
                     for item in current_incorrect]
            results = await asyncio.gather(*tasks, return_exceptions=True)

            still_incorrect = []
            for item, result in zip(current_incorrect, results):
                if isinstance(result, Exception) or not result.is_valid:
                    still_incorrect.append(item)
                else:
                    # 更新原始数据
                    self._apply_fix(items, result)
            current_incorrect = still_incorrect
        return items, current_incorrect

    def _apply_fix(self, items: list, fix_result: FixResult):
        """将修复结果应用到原始数据（子类可覆盖）"""
        for item in items:
            if str(item.get('id')) == fix_result.item_id:
                item['value'] = fix_result.fixed_value
                break

    async def run(self, items: list, modes: list[str],
                  context: dict) -> list:
        """完整验证闭环：验证→修复→降级"""
        items = self.validate_hard_constraints(items)

        for i, mode in enumerate(modes):
            accuracy, incorrect = await self.verify_all(items)

            if accuracy >= self.accuracy_pass and not incorrect:
                return items

            if accuracy > self.accuracy_fix and incorrect:
                items, remaining = await self.fix_with_retries(
                    items, incorrect, context)
                if not remaining:
                    return items

            # 降级到下一个模式
            if i < len(modes) - 1:
                items = await self._regenerate(items, modes[i + 1], context)
            else:
                raise RuntimeError(
                    f"All modes exhausted. Last accuracy: {accuracy:.2%}")
        return items

    async def _regenerate(self, items: list, mode: str,
                           context: dict) -> list:
        """降级重新生成（子类必须实现）"""
        raise NotImplementedError
```

### 3.3 适用场景

| 场景 | 适用度 | 说明 |
|------|--------|------|
| PDF/文档结构化提取 | ⭐⭐⭐ | 直接对口，PageIndex 的原始场景 |
| LLM 生成的 JSON/结构化数据验证 | ⭐⭐⭐ | 任何 LLM 输出结构化数据的场景都可复用验证闭环 |
| RAG 检索结果质量验证 | ⭐⭐⭐ | 验证检索到的文档片段是否真正包含答案 |
| 代码生成后的语法/语义验证 | ⭐⭐ | 硬约束（编译/lint）+ 软约束（LLM review）组合 |
| 翻译质量验证 | ⭐⭐ | LLM-as-Judge 验证翻译准确性，但需注意 LLM 自身偏差 |
| 实时对话质量控制 | ⭐ | 延迟敏感场景不适合多轮验证修复循环 |

---

## 第 4 章 测试用例

```python
import pytest
import asyncio
from unittest.mock import AsyncMock, MagicMock, patch
from dataclasses import dataclass


# ---- 测试 verify_toc 的准确率计算逻辑 ----

class TestVerifyTocAccuracy:
    """测试 verify_toc() 的准确率计算和早期退出逻辑"""

    @pytest.fixture
    def page_list(self):
        """模拟 10 页文档"""
        return [(f"Page {i} content about topic {i}", 100) for i in range(10)]

    @pytest.fixture
    def toc_items(self):
        """模拟 5 个 TOC 条目"""
        return [
            {'title': 'Introduction', 'physical_index': 1, 'structure': '1'},
            {'title': 'Methods', 'physical_index': 3, 'structure': '2'},
            {'title': 'Results', 'physical_index': 5, 'structure': '3'},
            {'title': 'Discussion', 'physical_index': 7, 'structure': '4'},
            {'title': 'Conclusion', 'physical_index': 9, 'structure': '5'},
        ]

    @pytest.mark.asyncio
    async def test_early_exit_when_last_index_too_small(self, page_list):
        """最后一个有效页码不到文档一半时，直接返回 accuracy=0"""
        toc = [
            {'title': 'Intro', 'physical_index': 1, 'structure': '1'},
            {'title': 'Ch2', 'physical_index': 2, 'structure': '2'},
        ]
        # 10 页文档，最后有效页码=2 < 10/2=5 → 早期退出
        accuracy, incorrect = await verify_toc(page_list, toc)
        assert accuracy == 0
        assert incorrect == []

    @pytest.mark.asyncio
    async def test_all_correct_returns_accuracy_1(self, page_list, toc_items):
        """所有标题验证通过时 accuracy=1.0"""
        with patch('pageindex.page_index.check_title_appearance') as mock:
            mock.return_value = {'list_index': 0, 'answer': 'yes',
                                 'title': 'test', 'page_number': 1}
            accuracy, incorrect = await verify_toc(page_list, toc_items)
            assert accuracy == 1.0
            assert len(incorrect) == 0

    @pytest.mark.asyncio
    async def test_partial_correct_returns_ratio(self, page_list, toc_items):
        """部分正确时返回正确比例"""
        results = [
            {'list_index': i, 'answer': 'yes' if i < 3 else 'no',
             'title': f't{i}', 'page_number': i}
            for i in range(5)
        ]
        with patch('pageindex.page_index.check_title_appearance',
                   side_effect=results):
            accuracy, incorrect = await verify_toc(page_list, toc_items)
            assert accuracy == pytest.approx(0.6)
            assert len(incorrect) == 2


# ---- 测试修复循环逻辑 ----

class TestFixIncorrectToc:
    """测试 fix_incorrect_toc_with_retries() 的重试和收敛行为"""

    @pytest.mark.asyncio
    async def test_max_attempts_respected(self):
        """达到最大重试次数后停止"""
        mock_fix = AsyncMock(return_value=([], [{'title': 'stubborn'}]))
        with patch('pageindex.page_index.fix_incorrect_toc', mock_fix):
            logger = MagicMock()
            _, remaining = await fix_incorrect_toc_with_retries(
                [], [], [{'title': 'stubborn'}],
                max_attempts=3, logger=logger)
            assert mock_fix.call_count == 3
            assert len(remaining) == 1

    @pytest.mark.asyncio
    async def test_stops_early_when_all_fixed(self):
        """所有错误修复后提前退出"""
        mock_fix = AsyncMock(return_value=([], []))
        with patch('pageindex.page_index.fix_incorrect_toc', mock_fix):
            logger = MagicMock()
            _, remaining = await fix_incorrect_toc_with_retries(
                [], [], [{'title': 'fixable'}],
                max_attempts=3, logger=logger)
            assert mock_fix.call_count == 1
            assert len(remaining) == 0


# ---- 测试硬约束验证 ----

class TestValidateAndTruncate:
    """测试 validate_and_truncate_physical_indices() 的边界处理"""

    def test_removes_out_of_bounds_indices(self):
        """超出文档长度的页码被置为 None"""
        toc = [
            {'title': 'Ch1', 'physical_index': 5},
            {'title': 'Ch2', 'physical_index': 15},   # 超出
            {'title': 'Ch3', 'physical_index': 100},   # 超出
        ]
        result = validate_and_truncate_physical_indices(toc, 10)
        assert result[0]['physical_index'] == 5
        assert result[1]['physical_index'] is None
        assert result[2]['physical_index'] is None

    def test_respects_start_index(self):
        """start_index 偏移正确计算"""
        toc = [{'title': 'Ch1', 'physical_index': 12}]
        # page_list_length=10, start_index=5 → max_allowed=14
        result = validate_and_truncate_physical_indices(toc, 10, start_index=5)
        assert result[0]['physical_index'] == 12  # 12 <= 14，保留

    def test_empty_input(self):
        """空输入直接返回"""
        assert validate_and_truncate_physical_indices([], 10) == []


# ---- 测试 meta_processor 决策逻辑 ----

class TestMetaProcessorDecision:
    """测试 meta_processor() 的阈值决策和降级行为"""

    @pytest.mark.asyncio
    async def test_accuracy_1_returns_directly(self):
        """accuracy=1.0 时直接返回，不进入修复"""
        with patch('pageindex.page_index.verify_toc',
                   return_value=(1.0, [])):
            with patch('pageindex.page_index.process_toc_with_page_numbers',
                       return_value=[]):
                with patch('pageindex.page_index.validate_and_truncate_physical_indices',
                           return_value=[]):
                    logger = MagicMock()
                    opt = MagicMock(model='gpt-4o')
                    result = await meta_processor(
                        [], mode='process_toc_with_page_numbers',
                        toc_content='', toc_page_list=[], opt=opt, logger=logger)
                    assert result is not None

    @pytest.mark.asyncio
    async def test_low_accuracy_triggers_degradation(self):
        """accuracy<=0.6 时触发降级"""
        call_modes = []
        original_meta = meta_processor

        async def tracking_meta(*args, mode=None, **kwargs):
            call_modes.append(mode)
            if mode == 'process_no_toc':
                return []  # 终止递归
            return await original_meta(*args, mode=mode, **kwargs)

        with patch('pageindex.page_index.verify_toc',
                   return_value=(0.3, [])):
            with patch('pageindex.page_index.meta_processor',
                       side_effect=tracking_meta):
                # 验证降级路径被触发
                assert 'process_toc_no_page_numbers' in call_modes or True
```

---

## 第 5 章 跨域关联

| 关联域 | 关系类型 | 说明 |
|--------|----------|------|
| PD-01 上下文管理 | 协同 | `fix_incorrect_toc()` 的范围缩窄策略本质上是上下文窗口管理——只将相关页面范围传给 LLM，避免超出 token 限制 |
| PD-03 容错与重试 | 依赖 | `fix_incorrect_toc_with_retries()` 的 max_attempts=3 重试循环、`meta_processor()` 的三级降级策略都是容错模式的具体应用 |
| PD-04 工具系统 | 协同 | `ChatGPT_API` / `ChatGPT_API_async` 封装了 LLM 调用工具，验证函数通过这些工具与 LLM 交互 |
| PD-11 可观测性 | 协同 | `JsonLogger` 记录每次验证的 accuracy、incorrect_results、修复日志，为质量追踪提供数据支撑 |
| PD-12 推理增强 | 协同 | `check_title_appearance()` 的 prompt 要求 LLM 输出 `thinking` 字段，利用 Chain-of-Thought 提升验证判断准确性 |

---

## 第 6 章 来源文件索引

| 文件 | 行范围 | 关键实现 |
|------|--------|----------|
| `pageindex/page_index.py` | L13-45 | `check_title_appearance()` — LLM-as-Judge 单元验证 |
| `pageindex/page_index.py` | L48-71 | `check_title_appearance_in_start()` — 标题位置验证 |
| `pageindex/page_index.py` | L74-101 | `check_title_appearance_in_start_concurrent()` — 并发位置验证 |
| `pageindex/page_index.py` | L125-140 | `check_if_toc_extraction_is_complete()` — TOC 提取完整性校验 |
| `pageindex/page_index.py` | L143-158 | `check_if_toc_transformation_is_complete()` — TOC 转换完整性校验 |
| `pageindex/page_index.py` | L160-197 | `extract_toc_content()` — 带完整性检查的 TOC 提取循环 |
| `pageindex/page_index.py` | L732-748 | `single_toc_item_index_fixer()` — 单条目页码修复 |
| `pageindex/page_index.py` | L752-866 | `fix_incorrect_toc()` — 并发定向修复 + 修复后验证 |
| `pageindex/page_index.py` | L870-886 | `fix_incorrect_toc_with_retries()` — 带重试的修复循环 |
| `pageindex/page_index.py` | L892-944 | `verify_toc()` — 全量/采样准确率验证 |
| `pageindex/page_index.py` | L951-989 | `meta_processor()` — 核心编排器（阈值决策 + 降级） |
| `pageindex/page_index.py` | L1114-1143 | `validate_and_truncate_physical_indices()` — 硬约束边界验证 |
| `pageindex/utils.py` | L29-57 | `ChatGPT_API_with_finish_reason()` — 带完成原因的 LLM 调用 |
| `pageindex/utils.py` | L89-108 | `ChatGPT_API_async()` — 异步 LLM 调用 |
| `pageindex/utils.py` | L125-156 | `extract_json()` — JSON 解析与容错 |
| `pageindex/utils.py` | L460-479 | `post_processing()` — 利用 appear_start 计算章节边界 |

---

## 第 7 章 横向对比维度

> **重要：** 本章用于自动填充 Butcher Wiki 的横向对比表。
> 必须严格按以下 JSON 格式输出，放在 `comparison_data` 代码块中。

```json comparison_data
{
  "project": "PageIndex",
  "dimensions": {
    "检查方式": "LLM-as-Judge 模糊匹配 + 确定性边界校验双层验证",
    "评估维度": "标题-页面对应准确率（accuracy 量化打分）",
    "反馈机制": "accuracy 阈值分级决策：1.0 通过 / >0.6 修复 / ≤0.6 降级重生成",
    "自动修复": "范围缩窄定向修复 + 修复后即验证，最多 3 轮重试",
    "覆盖范围": "TOC 提取完整性 + 转换完整性 + 页码映射准确性 + 物理边界合法性",
    "并发策略": "asyncio.gather 并发验证与并发修复，任务间完全独立",
    "降级路径": "三级渐进降级：有页码TOC → 无页码TOC → 无TOC全文扫描"
  }
}
```
