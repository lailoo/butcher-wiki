# PD-03.04 PageIndex — 多层容错与三级降级方案

> 文档编号：PD-03.04
> 来源：PageIndex `pageindex/utils.py` `pageindex/page_index.py`
> GitHub：https://github.com/VectifyAI/PageIndex.git
> 问题域：PD-03 容错与重试 Fault Tolerance & Retry
> 状态：可复用方案

---

## 第 1 章 问题与动机

### 1.1 核心问题

PDF 文档结构化解析是一个高度依赖 LLM 的多步骤流水线任务。PageIndex 的核心功能是将 PDF 文档解析为层次化的目录树结构，这个过程涉及：

- 目录检测（TOC detection）
- 目录内容提取与转换（TOC extraction & transformation）
- 页码索引匹配（page index mapping）
- 结果验证与修复（verification & fix）

每一步都需要调用 LLM API，而 LLM API 调用天然不稳定：网络超时、速率限制、模型输出截断、JSON 解析失败等问题频繁发生。更关键的是，即使 API 调用成功，LLM 的输出质量也不确定——目录提取可能不完整，页码匹配可能不准确。

PageIndex 面临的容错挑战是**双层**的：
1. **基础设施层**：API 调用本身可能失败（网络、限流、超时）
2. **语义层**：API 返回成功但结果质量不达标（准确率不足、输出截断）

### 1.2 PageIndex 的解法概述

PageIndex 在三个层次构建了容错体系：

1. **LLM API 重试层**：所有 LLM 调用函数统一实现 `max_retries=10` 的重试循环，捕获全部异常后 `sleep(1)` 再重试（`pageindex/utils.py:29-108`）
2. **输出续写层**：当 LLM 输出因 token 限制被截断时（`finish_reason == "length"`），自动拼接 chat_history 续写，最多 5 轮（`pageindex/page_index.py:160-197`）
3. **处理策略三级降级**：`meta_processor` 根据验证准确率自动降级处理策略——从带页码 TOC → 无页码 TOC → 无 TOC 纯文本（`pageindex/page_index.py:951-989`）
4. **验证修复重试**：对验证失败的 TOC 条目进行最多 `max_attempts=3` 次定向修复（`pageindex/page_index.py:870-886`）

### 1.3 设计思想

| 设计原则 | 具体实现 | 理由 | 替代方案 |
|----------|----------|------|----------|
| 宽泛异常捕获 | `except Exception as e` 捕获所有异常类型 | LLM API 可能抛出多种异常（网络、认证、限流），逐一处理不现实 | 按异常类型分别处理（更精细但维护成本高） |
| 固定间隔重试 | `sleep(1)` 固定 1 秒间隔 | 实现简单，对 LLM API 的限流场景足够 | 指数退避（更适合高并发场景） |
| 质量驱动降级 | accuracy < 0.6 触发策略降级 | 用量化指标而非异常信号决定是否降级，更精准 | 基于异常类型降级（无法捕获"成功但质量差"的情况） |
| 渐进式降级 | 三级策略逐级尝试，不跳级 | 优先使用信息量最大的策略，只在质量不达标时才放弃 | 直接使用最保守策略（浪费 TOC 信息） |
| 定向修复优于全局重试 | `fix_incorrect_toc` 只修复验证失败的条目 | 避免重新处理已正确的条目，节省 API 调用成本 | 全量重试（成本高，且可能引入新错误） |

---

## 第 2 章 源码实现分析

### 2.1 架构概览

PageIndex 的容错机制分布在三个层次，形成一个从底层到顶层的防御体系：

```
┌─────────────────────────────────────────────────────────────┐
│                    meta_processor (顶层编排)                  │
│  ┌─────────────────┐  accuracy<0.6  ┌──────────────────┐    │
│  │ process_toc_with │──────────────→│ process_toc_no   │    │
│  │ _page_numbers    │               │ _page_numbers    │    │
│  └────────┬────────┘               └────────┬─────────┘    │
│           │                                  │              │
│           │  accuracy<0.6                    │ accuracy<0.6 │
│           │                                  │              │
│           │         ┌────────────────────┐   │              │
│           └────────→│  process_no_toc    │←──┘              │
│                     └────────────────────┘                  │
├─────────────────────────────────────────────────────────────┤
│              verify_toc + fix_incorrect_toc_with_retries     │
│  ┌──────────┐    incorrect    ┌───────────┐   max 3 次      │
│  │verify_toc│───────────────→│fix_incorrect│──────────→     │
│  │(采样验证) │                │_toc        │  循环修复       │
│  └──────────┘                └───────────┘                  │
├─────────────────────────────────────────────────────────────┤
│              extract_toc_content (输出续写层)                 │
│  ┌──────────────┐  finish_reason  ┌──────────────┐          │
│  │ChatGPT_API   │  =="length"     │ 拼接 history │ 最多5轮  │
│  │_with_finish   │───────────────→│ 续写输出     │──────→   │
│  │_reason        │                └──────────────┘          │
├─────────────────────────────────────────────────────────────┤
│              LLM API 重试层 (基础设施)                        │
│  ┌──────────────┐  Exception  ┌──────────┐                  │
│  │ChatGPT_API() │────────────→│sleep(1)  │  max 10 次      │
│  │ChatGPT_API   │             │retry     │──────────→      │
│  │_async()       │             └──────────┘                  │
│  └──────────────┘                                           │
└─────────────────────────────────────────────────────────────┘
```

### 2.2 核心实现

#### 2.2.1 LLM API 重试层

三个 LLM 调用函数共享相同的重试模式。以同步版本 `ChatGPT_API` 为例（`pageindex/utils.py:61-86`）：

```python
def ChatGPT_API(model, prompt, api_key=CHATGPT_API_KEY, chat_history=None):
    max_retries = 10
    client = openai.OpenAI(api_key=api_key)
    for i in range(max_retries):
        try:
            if chat_history:
                messages = chat_history
                messages.append({"role": "user", "content": prompt})
            else:
                messages = [{"role": "user", "content": prompt}]
            response = client.chat.completions.create(
                model=model,
                messages=messages,
                temperature=0,
            )
            return response.choices[0].message.content
        except Exception as e:
            print('************* Retrying *************')
            logging.error(f"Error: {e}")
            if i < max_retries - 1:
                time.sleep(1)
            else:
                logging.error('Max retries reached for prompt: ' + prompt)
                return "Error"
```

异步版本 `ChatGPT_API_async`（`pageindex/utils.py:89-108`）使用 `await asyncio.sleep(1)` 替代 `time.sleep(1)`，其余逻辑完全一致。

带 finish_reason 的版本 `ChatGPT_API_with_finish_reason`（`pageindex/utils.py:29-57`）额外返回完成原因，用于判断输出是否被截断：

```python
def ChatGPT_API_with_finish_reason(model, prompt, api_key=CHATGPT_API_KEY, chat_history=None):
    max_retries = 10
    client = openai.OpenAI(api_key=api_key)
    for i in range(max_retries):
        try:
            # ... 同上 ...
            if response.choices[0].finish_reason == "length":
                return response.choices[0].message.content, "max_output_reached"
            else:
                return response.choices[0].message.content, "finished"
        except Exception as e:
            # ... 同上重试逻辑 ...
            if i < max_retries - 1:
                time.sleep(1)
            else:
                return "Error"
```

#### 2.2.2 输出续写层

`extract_toc_content`（`pageindex/page_index.py:160-197`）处理 LLM 输出因 token 限制被截断的情况。它通过检查 `finish_reason` 和内容完整性双重条件来决定是否续写：

```python
def extract_toc_content(content, model=None):
    prompt = f"""Your job is to extract the full table of contents from the given text..."""
    response, finish_reason = ChatGPT_API_with_finish_reason(model=model, prompt=prompt)

    if_complete = check_if_toc_transformation_is_complete(content, response, model)
    if if_complete == "yes" and finish_reason == "finished":
        return response

    chat_history = [
        {"role": "user", "content": prompt},
        {"role": "assistant", "content": response},
    ]
    prompt = "please continue the generation of table of contents..."
    new_response, finish_reason = ChatGPT_API_with_finish_reason(
        model=model, prompt=prompt, chat_history=chat_history)
    response = response + new_response

    while not (if_complete == "yes" and finish_reason == "finished"):
        # 续写循环...
        if len(chat_history) > 5:  # 最多 5 轮续写
            raise Exception('Failed to complete table of contents after maximum retries')
    return response
```

关键设计：续写判断使用**双条件门控**——`finish_reason == "finished"` 确认模型认为输出完成，`check_if_toc_transformation_is_complete` 用另一次 LLM 调用验证内容完整性。两者都满足才停止续写。

#### 2.2.3 三级降级策略

`meta_processor`（`pageindex/page_index.py:951-989`）是整个容错体系的核心编排器。它根据验证准确率动态选择处理策略：

```python
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
        return toc_with_page_number  # 完美通过
    if accuracy > 0.6 and len(incorrect_results) > 0:
        # 准确率尚可，定向修复错误条目
        toc_with_page_number, _ = await fix_incorrect_toc_with_retries(
            toc_with_page_number, page_list, incorrect_results,
            start_index=start_index, max_attempts=3, model=opt.model, logger=logger)
        return toc_with_page_number
    else:
        # 准确率过低，降级到下一策略
        if mode == 'process_toc_with_page_numbers':
            return await meta_processor(page_list, mode='process_toc_no_page_numbers', ...)
        elif mode == 'process_toc_no_page_numbers':
            return await meta_processor(page_list, mode='process_no_toc', ...)
        else:
            raise Exception('Processing failed')
```

降级路径的信息量递减逻辑：
- **Level 1** `process_toc_with_page_numbers`：利用 TOC 中的页码信息，通过偏移量计算物理页码（信息量最大）
- **Level 2** `process_toc_no_page_numbers`：有 TOC 结构但无页码，需要逐段匹配文档内容定位页码
- **Level 3** `process_no_toc`：完全无 TOC，从文档文本中用 LLM 生成层次结构

#### 2.2.4 验证修复重试

`fix_incorrect_toc_with_retries`（`pageindex/page_index.py:870-886`）对验证失败的条目进行定向修复：

```python
async def fix_incorrect_toc_with_retries(toc_with_page_number, page_list,
                                          incorrect_results, start_index=1,
                                          max_attempts=3, model=None, logger=None):
    fix_attempt = 0
    current_toc = toc_with_page_number
    current_incorrect = incorrect_results

    while current_incorrect:
        print(f"Fixing {len(current_incorrect)} incorrect results")
        current_toc, current_incorrect = await fix_incorrect_toc(
            current_toc, page_list, current_incorrect, start_index, model, logger)
        fix_attempt += 1
        if fix_attempt >= max_attempts:
            logger.info("Maximum fix attempts reached")
            break
    return current_toc, current_incorrect
```

每轮修复后，`fix_incorrect_toc`（`pageindex/page_index.py:752-866`）会重新验证修复结果，只将仍然不正确的条目传入下一轮。这种"缩小范围"的修复策略确保每轮修复的工作量递减。

### 2.3 实现细节

#### 数据流：从检测到修复的完整路径

```
PDF 输入
  │
  ▼
check_toc() ─── 检测是否有 TOC + 是否有页码
  │
  ├─ 有 TOC + 有页码 → meta_processor(mode='process_toc_with_page_numbers')
  ├─ 有 TOC + 无页码 → meta_processor(mode='process_toc_no_page_numbers')
  └─ 无 TOC          → meta_processor(mode='process_no_toc')
  │
  ▼
处理完成 → verify_toc() 采样验证
  │
  ├─ accuracy == 1.0 → 直接返回 ✓
  ├─ accuracy > 0.6  → fix_incorrect_toc_with_retries() → 返回
  └─ accuracy ≤ 0.6  → 递归调用 meta_processor(降级 mode) ↩
```

#### 并发修复机制

`fix_incorrect_toc`（`pageindex/page_index.py:760-834`）使用 `asyncio.gather` 并发处理所有错误条目。每个条目的修复流程：
1. 找到前后最近的正确条目，确定搜索范围
2. 在范围内调用 `single_toc_item_index_fixer` 重新定位
3. 调用 `check_title_appearance` 验证修复结果
4. 返回 `is_valid` 标记

异常隔离：`asyncio.gather(*tasks, return_exceptions=True)` 确保单个条目修复失败不影响其他条目。

#### JSON 解析容错

`extract_json`（`pageindex/utils.py:125-156`）对 LLM 返回的 JSON 实现了多层解析容错：
1. 尝试提取 ` ```json ``` ` 包裹的内容
2. 替换 Python `None` 为 JSON `null`
3. 规范化空白字符
4. 首次解析失败后，移除尾部逗号再试
5. 最终失败返回空字典 `{}`

---

## 第 3 章 迁移指南

### 3.1 迁移清单

**阶段 1：基础 LLM 重试层**
- [ ] 封装统一的 LLM 调用函数，内置 `max_retries` + `sleep` 重试
- [ ] 区分同步/异步版本，异步版使用 `asyncio.sleep`
- [ ] 添加带 `finish_reason` 返回的变体，用于续写场景

**阶段 2：输出续写机制**
- [ ] 实现 `finish_reason` 检测 + 内容完整性验证的双条件续写
- [ ] 设置续写轮数上限（建议 3-5 轮）
- [ ] 续写时拼接 `chat_history` 保持上下文连贯

**阶段 3：质量驱动降级**
- [ ] 定义处理策略的降级链（从信息量最大到最小）
- [ ] 实现验证函数，输出量化准确率
- [ ] 在编排器中根据准确率阈值触发降级
- [ ] 实现定向修复（只修复失败条目，不重试全部）

### 3.2 适配代码模板

#### 通用 LLM 重试包装器

```python
import asyncio
import logging
from typing import Optional, Tuple

class LLMCaller:
    """可复用的 LLM 调用器，内置重试和续写能力。"""

    def __init__(self, client, max_retries: int = 10, retry_delay: float = 1.0):
        self.client = client
        self.max_retries = max_retries
        self.retry_delay = retry_delay

    async def call(self, model: str, messages: list,
                   temperature: float = 0) -> str:
        for i in range(self.max_retries):
            try:
                response = await self.client.chat.completions.create(
                    model=model, messages=messages, temperature=temperature)
                return response.choices[0].message.content
            except Exception as e:
                logging.error(f"LLM call failed (attempt {i+1}): {e}")
                if i < self.max_retries - 1:
                    await asyncio.sleep(self.retry_delay)
                else:
                    raise RuntimeError(f"Max retries ({self.max_retries}) reached")

    async def call_with_continuation(
        self, model: str, initial_prompt: str,
        completeness_checker, max_rounds: int = 5
    ) -> str:
        """带续写能力的调用，适用于长输出场景。"""
        messages = [{"role": "user", "content": initial_prompt}]
        response = await self.call(model, messages)
        full_output = response

        for round_num in range(max_rounds):
            if await completeness_checker(full_output):
                return full_output
            messages.append({"role": "assistant", "content": response})
            messages.append({"role": "user", "content": "Please continue."})
            response = await self.call(model, messages)
            full_output += response

        raise RuntimeError(f"Output incomplete after {max_rounds} continuation rounds")
```

#### 质量驱动降级编排器

```python
from dataclasses import dataclass
from typing import Callable, List, Any

@dataclass
class ProcessingStrategy:
    name: str
    processor: Callable
    min_accuracy: float  # 低于此值触发降级

class DegradationOrchestrator:
    """三级降级编排器模板。"""

    def __init__(self, strategies: List[ProcessingStrategy],
                 verifier: Callable, fixer: Callable,
                 fix_threshold: float = 0.6, max_fix_attempts: int = 3):
        self.strategies = strategies
        self.verifier = verifier
        self.fixer = fixer
        self.fix_threshold = fix_threshold
        self.max_fix_attempts = max_fix_attempts

    async def process(self, data: Any, strategy_index: int = 0) -> Any:
        if strategy_index >= len(self.strategies):
            raise RuntimeError("All strategies exhausted")

        strategy = self.strategies[strategy_index]
        result = await strategy.processor(data)
        accuracy, failures = await self.verifier(result)

        if accuracy >= 1.0:
            return result
        if accuracy >= self.fix_threshold and failures:
            result, _ = await self._fix_with_retries(result, failures)
            return result
        # 降级到下一策略
        return await self.process(data, strategy_index + 1)

    async def _fix_with_retries(self, result, failures):
        for attempt in range(self.max_fix_attempts):
            if not failures:
                break
            result, failures = await self.fixer(result, failures)
        return result, failures
```

### 3.3 适用场景

| 场景 | 适用度 | 说明 |
|------|--------|------|
| LLM 驱动的文档解析流水线 | ⭐⭐⭐ | 直接适用，PageIndex 的原始场景 |
| 多步骤 LLM Agent 任务链 | ⭐⭐⭐ | 三级降级思想可推广到任何有多种策略的 Agent |
| 结构化数据提取（JSON/表格） | ⭐⭐⭐ | 续写机制 + JSON 解析容错直接可用 |
| 单次 LLM 调用的简单应用 | ⭐ | 只需基础重试层，降级机制过重 |
| 实时对话系统 | ⭐ | 重试延迟不可接受，需要更快的 fallback |

---

## 第 4 章 测试用例

```python
import pytest
import asyncio
from unittest.mock import AsyncMock, MagicMock, patch

# ============================================================
# 测试 1：LLM API 重试机制
# ============================================================
class TestLLMRetry:
    def test_retry_on_exception_then_succeed(self):
        """模拟前 2 次失败、第 3 次成功的场景"""
        mock_client = MagicMock()
        call_count = 0

        def side_effect(**kwargs):
            nonlocal call_count
            call_count += 1
            if call_count < 3:
                raise Exception("Rate limit exceeded")
            mock_response = MagicMock()
            mock_response.choices = [MagicMock()]
            mock_response.choices[0].message.content = "success"
            return mock_response

        mock_client.chat.completions.create.side_effect = side_effect

        with patch('openai.OpenAI', return_value=mock_client), \
             patch('time.sleep'):
            from pageindex.utils import ChatGPT_API
            result = ChatGPT_API("gpt-4o", "test prompt")
            assert result == "success"
            assert call_count == 3

    def test_max_retries_exhausted(self):
        """10 次全部失败，返回 'Error'"""
        mock_client = MagicMock()
        mock_client.chat.completions.create.side_effect = Exception("Always fails")

        with patch('openai.OpenAI', return_value=mock_client), \
             patch('time.sleep'):
            from pageindex.utils import ChatGPT_API
            result = ChatGPT_API("gpt-4o", "test prompt")
            assert result == "Error"

# ============================================================
# 测试 2：输出续写机制
# ============================================================
class TestOutputContinuation:
    def test_complete_on_first_call(self):
        """首次调用即完成，不触发续写"""
        with patch('pageindex.page_index.ChatGPT_API_with_finish_reason') as mock_api, \
             patch('pageindex.page_index.check_if_toc_transformation_is_complete') as mock_check:
            mock_api.return_value = ("full toc content", "finished")
            mock_check.return_value = "yes"

            from pageindex.page_index import extract_toc_content
            result = extract_toc_content("raw content", model="gpt-4o")
            assert result == "full toc content"
            assert mock_api.call_count == 1

    def test_continuation_after_truncation(self):
        """首次截断，续写一次后完成"""
        with patch('pageindex.page_index.ChatGPT_API_with_finish_reason') as mock_api, \
             patch('pageindex.page_index.check_if_toc_transformation_is_complete') as mock_check:
            mock_api.side_effect = [
                ("partial...", "max_output_reached"),
                ("...complete", "finished"),
            ]
            mock_check.side_effect = ["no", "yes"]

            from pageindex.page_index import extract_toc_content
            result = extract_toc_content("raw content", model="gpt-4o")
            assert result == "partial......complete"

# ============================================================
# 测试 3：三级降级策略
# ============================================================
class TestDegradation:
    @pytest.mark.asyncio
    async def test_degradation_from_level1_to_level2(self):
        """Level 1 准确率 < 0.6 时降级到 Level 2"""
        from pageindex.page_index import meta_processor

        with patch('pageindex.page_index.process_toc_with_page_numbers') as mock_l1, \
             patch('pageindex.page_index.process_toc_no_page_numbers') as mock_l2, \
             patch('pageindex.page_index.verify_toc') as mock_verify, \
             patch('pageindex.page_index.validate_and_truncate_physical_indices', side_effect=lambda x, *a, **kw: x):

            mock_l1.return_value = [{"title": "Ch1", "physical_index": 1}]
            mock_l2.return_value = [{"title": "Ch1", "physical_index": 1}]
            # Level 1 验证失败，Level 2 验证通过
            mock_verify.side_effect = [(0.3, []), (1.0, [])]

            opt = MagicMock()
            opt.model = "gpt-4o"
            opt.toc_check_page_num = 20
            logger = MagicMock()

            result = await meta_processor(
                page_list=[(f"page {i}", 100) for i in range(10)],
                mode='process_toc_with_page_numbers',
                toc_content="toc", toc_page_list=[0],
                start_index=1, opt=opt, logger=logger)

            mock_l1.assert_called_once()
            mock_l2.assert_called_once()

# ============================================================
# 测试 4：定向修复重试
# ============================================================
class TestFixRetries:
    @pytest.mark.asyncio
    async def test_fix_converges_within_max_attempts(self):
        """修复在 max_attempts 内收敛"""
        from pageindex.page_index import fix_incorrect_toc_with_retries

        toc = [{"title": "Ch1", "physical_index": 5, "structure": "1"}]
        incorrect = [{"list_index": 0, "title": "Ch1", "physical_index": 5}]

        with patch('pageindex.page_index.fix_incorrect_toc') as mock_fix:
            # 第 1 轮修复后仍有错误，第 2 轮修复成功
            mock_fix.side_effect = [
                (toc, [{"list_index": 0, "title": "Ch1", "physical_index": 6}]),
                (toc, []),
            ]
            logger = MagicMock()
            result_toc, remaining = await fix_incorrect_toc_with_retries(
                toc, [], incorrect, max_attempts=3, model="gpt-4o", logger=logger)
            assert len(remaining) == 0
            assert mock_fix.call_count == 2
```

---

## 第 5 章 跨域关联

| 关联域 | 关系类型 | 说明 |
|--------|----------|------|
| PD-01 上下文管理 | 协同 | 续写机制依赖 `chat_history` 管理；`page_list_to_group_text` 将文档按 token 限制分组，是上下文窗口管理的实例 |
| PD-04 工具系统 | 协同 | LLM 调用函数（`ChatGPT_API` 系列）本质上是工具层的封装，重试逻辑嵌入工具层而非编排层 |
| PD-07 质量检查 | 依赖 | 三级降级的触发条件依赖 `verify_toc` 的准确率评估；`check_title_appearance` 是质量检查的具体实现 |
| PD-08 搜索与检索 | 协同 | `single_toc_item_index_fixer` 在修复时需要在文档范围内搜索正确的页码位置 |
| PD-11 可观测性 | 协同 | `JsonLogger` 记录每步处理结果和准确率，为降级决策提供可追溯的日志 |

---

## 第 6 章 来源文件索引

| 文件 | 行范围 | 关键实现 |
|------|--------|----------|
| `pageindex/utils.py` | L29-L57 | `ChatGPT_API_with_finish_reason` — 带完成原因的 LLM 调用 + 重试 |
| `pageindex/utils.py` | L61-L86 | `ChatGPT_API` — 同步 LLM 调用 + max_retries=10 重试 |
| `pageindex/utils.py` | L89-L108 | `ChatGPT_API_async` — 异步 LLM 调用 + 重试 |
| `pageindex/utils.py` | L125-L156 | `extract_json` — 多层 JSON 解析容错 |
| `pageindex/page_index.py` | L160-L197 | `extract_toc_content` — 输出续写机制（最多 5 轮） |
| `pageindex/page_index.py` | L270-L328 | `toc_transformer` — TOC 转换 + 续写 |
| `pageindex/page_index.py` | L752-L866 | `fix_incorrect_toc` — 并发定向修复错误条目 |
| `pageindex/page_index.py` | L870-L886 | `fix_incorrect_toc_with_retries` — 修复重试循环（max_attempts=3） |
| `pageindex/page_index.py` | L892-L944 | `verify_toc` — 采样验证 + 准确率计算 |
| `pageindex/page_index.py` | L951-L989 | `meta_processor` — 三级降级编排核心 |
| `pageindex/config.yaml` | L1-L8 | 默认配置（模型、页数限制等） |
| `pageindex/page_index.py` | L1114-L1144 | `validate_and_truncate_physical_indices` — 越界页码防御 |

---

## 第 7 章 横向对比维度

> **重要：** 本章用于自动填充 Butcher Wiki 的横向对比表。
> 必须严格按以下 JSON 格式输出，放在 `comparison_data` 代码块中。

```json comparison_data
{
  "project": "PageIndex",
  "dimensions": {
    "重试策略": "固定间隔 sleep(1) + max_retries=10，宽泛 except Exception 捕获",
    "降级方案": "三级渐进降级：有页码TOC → 无页码TOC → 无TOC全文扫描，accuracy<0.6 触发",
    "错误分类": "不区分异常类型，统一捕获；语义层通过 accuracy 量化评估质量",
    "恢复机制": "定向修复：只重试验证失败的条目（max_attempts=3），不全量重试",
    "监控告警": "JsonLogger 记录每步准确率和降级决策，无实时告警",
    "续写能力": "finish_reason + LLM 完整性双条件门控，chat_history 拼接续写最多5轮",
    "并发容错": "asyncio.gather(return_exceptions=True) 隔离单条目修复失败"
  }
}
```

**维度说明：**

- **重试策略**、**降级方案**、**错误分类**、**恢复机制**、**监控告警**：复用 PD-03 已有维度，确保跨项目可比
- **续写能力**：PageIndex 独有的 LLM 输出截断续写机制，其他项目未见此模式
- **并发容错**：PageIndex 在修复阶段使用 asyncio.gather 并发处理，异常隔离是其特色
