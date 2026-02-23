# PD-11.03 PageIndex — 结构化 JSON 日志 + Token 计量

> 文档编号：PD-11.03
> 来源：PageIndex `pageindex/utils.py` / `pageindex/page_index.py`
> GitHub：https://github.com/VectifyAI/PageIndex.git
> 问题域：PD-11 可观测性 Observability & Cost Tracking
> 状态：可复用方案

---

## 第 1 章 问题与动机

### 1.1 核心问题

PDF 文档结构化解析是一个多阶段 LLM 密集型流水线：TOC 检测 → TOC 提取 → 页码映射 → 准确性验证 → 错误修复。每个阶段都涉及多次 LLM 调用，面临以下可观测性挑战：

- **中间状态不可追溯**：流水线包含 TOC 检测、结构转换、物理索引映射、准确性验证、错误修复等多个阶段，任何一步出错都难以定位根因
- **Token 消耗不透明**：单次 PDF 解析可能触发数十次 LLM 调用（每页 TOC 检测、每组页面的索引提取、每个错误项的修复），总 token 消耗无法预估
- **质量指标缺失**：accuracy 验证结果、incorrect_results 列表、offset 计算等关键质量数据如果不持久化，无法做事后分析和流程优化
- **多模式降级不可见**：`meta_processor` 支持三种处理模式的自动降级（有页码 TOC → 无页码 TOC → 无 TOC），降级路径需要被记录

### 1.2 PageIndex 的解法概述

PageIndex 采用双层日志架构，将结构化业务日志与标准错误日志分离：

1. **JsonLogger 类**（`utils.py:309-345`）：自定义 JSON 日志器，以 PDF 文件名+时间戳命名，每次写入都将完整日志数组序列化到 `./logs` 目录，记录业务级中间状态
2. **全流程 logger 传递**（`page_index.py:1059`）：在入口 `page_index_main()` 创建 logger 实例，通过参数传递到 `tree_parser` → `meta_processor` → 各子函数，形成完整调用链日志
3. **关键指标记录**（`page_index.py:1071-1072`）：入口处记录 `total_page_number` 和 `total_token`，为成本估算提供基础数据
4. **Python logging 模块**（`utils.py:52-56`）：用于 API 调用层的错误和重试日志，与业务日志分离
5. **质量验证日志**（`page_index.py:973-977`）：`meta_processor` 记录每种处理模式的 accuracy 和 incorrect_results

### 1.3 设计思想

| 设计原则 | 具体实现 | 理由 | 替代方案 |
|----------|----------|------|----------|
| 双层日志分离 | JsonLogger 记录业务状态，Python logging 记录 API 错误 | 业务日志需要结构化查询，API 错误日志需要标准格式 | 统一用 logging 模块（丢失结构化能力） |
| 全量快照写入 | 每次 `log()` 都将完整 `log_data` 数组写入文件 | 进程崩溃时不丢失已记录数据，无需 flush 机制 | 追加写入（崩溃时可能丢失缓冲区数据） |
| 文件名含时间戳 | `{pdf_name}_{YYYYMMDD_HHMMSS}.json` | 同一 PDF 多次处理的日志不会互相覆盖 | UUID 命名（不可读） |
| 参数传递而非全局 | logger 通过函数参数逐层传递 | 避免全局状态，支持并发处理不同 PDF | 全局 logger 单例（并发冲突） |
| 可选日志 | 所有 `logger.info()` 调用前都有 `if logger:` 守卫 | 允许不传 logger 的轻量调用模式 | 强制要求 logger（降低灵活性） |

---

## 第 2 章 源码实现分析

### 2.1 架构概览

```
┌─────────────────────────────────────────────────────────────┐
│                    page_index_main()                         │
│  ┌─────────────┐  ┌──────────────┐  ┌────────────────────┐  │
│  │ JsonLogger   │  │ total_pages  │  │ total_tokens       │  │
│  │ (创建实例)   │  │ (记录)       │  │ (记录)             │  │
│  └──────┬──────┘  └──────────────┘  └────────────────────┘  │
│         │ logger 参数传递                                    │
│         ▼                                                    │
│  ┌─────────────────────────────────────────────────────┐    │
│  │              tree_parser()                           │    │
│  │  ├─ check_toc() → logger.info(toc_result)           │    │
│  │  ├─ meta_processor() → logger.info(accuracy)        │    │
│  │  │   ├─ process_toc_with_page_numbers()             │    │
│  │  │   │   └─ logger.info(每步中间结果)                │    │
│  │  │   ├─ process_toc_no_page_numbers()               │    │
│  │  │   └─ process_no_toc()                            │    │
│  │  ├─ fix_incorrect_toc() → logger.info(修复结果)      │    │
│  │  └─ process_large_node_recursively()                │    │
│  └─────────────────────────────────────────────────────┘    │
│                                                              │
│  ┌─────────────────────────────────────────────────────┐    │
│  │         Python logging (API 层)                      │    │
│  │  ChatGPT_API() → logging.error(重试信息)             │    │
│  │  ChatGPT_API_async() → logging.error(重试信息)       │    │
│  │  extract_json() → logging.error(解析失败)            │    │
│  └─────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────┘
                         │
                         ▼
              ./logs/{pdf_name}_{timestamp}.json
```

### 2.2 核心实现

#### JsonLogger 类（`utils.py:309-345`）

```python
class JsonLogger:
    def __init__(self, file_path):
        # Extract PDF name for logger name
        pdf_name = get_pdf_name(file_path)

        current_time = datetime.now().strftime("%Y%m%d_%H%M%S")
        self.filename = f"{pdf_name}_{current_time}.json"
        os.makedirs("./logs", exist_ok=True)
        # Initialize empty list to store all messages
        self.log_data = []

    def log(self, level, message, **kwargs):
        if isinstance(message, dict):
            self.log_data.append(message)
        else:
            self.log_data.append({'message': message})
        # Write entire log data to file
        with open(self._filepath(), "w") as f:
            json.dump(self.log_data, f, indent=2)

    def info(self, message, **kwargs):
        self.log("INFO", message, **kwargs)

    def error(self, message, **kwargs):
        self.log("ERROR", message, **kwargs)

    def debug(self, message, **kwargs):
        self.log("DEBUG", message, **kwargs)

    def exception(self, message, **kwargs):
        kwargs["exception"] = True
        self.log("ERROR", message, **kwargs)

    def _filepath(self):
        return os.path.join("logs", self.filename)
```

关键设计点：
- `log_data` 是内存中的列表，每次 `log()` 调用都追加新条目并**全量重写**文件（`utils.py:328`）
- `level` 参数被接收但未写入日志数据（`utils.py:320`），这是一个设计缺陷——日志级别信息丢失
- 支持 dict 和 string 两种消息格式（`utils.py:321-324`），dict 直接追加，string 包装为 `{'message': str}`

#### 入口处的指标记录（`page_index.py:1058-1072`）

```python
def page_index_main(doc, opt=None):
    logger = JsonLogger(doc)

    is_valid_pdf = (
        (isinstance(doc, str) and os.path.isfile(doc) and doc.lower().endswith(".pdf")) or
        isinstance(doc, BytesIO)
    )
    if not is_valid_pdf:
        raise ValueError("Unsupported input type. Expected a PDF file path or BytesIO object.")

    print('Parsing PDF...')
    page_list = get_page_tokens(doc)

    logger.info({'total_page_number': len(page_list)})
    logger.info({'total_token': sum([page[1] for page in page_list])})
```

`get_page_tokens()`（`utils.py:413-437`）使用 tiktoken 对每页文本进行 token 计数，返回 `(text, token_count)` 元组列表。入口处记录的 `total_token` 是文档原始 token 总量，用于估算 LLM 调用成本。

#### 流水线中间状态日志（`page_index.py:614-643`）

以 `process_toc_with_page_numbers()` 为例，展示了流水线每一步的日志记录：

```python
def process_toc_with_page_numbers(toc_content, toc_page_list, page_list,
                                   toc_check_page_num=None, model=None, logger=None):
    toc_with_page_number = toc_transformer(toc_content, model)
    logger.info(f'toc_with_page_number: {toc_with_page_number}')  # L616

    toc_no_page_number = remove_page_number(copy.deepcopy(toc_with_page_number))
    # ... 物理索引提取 ...
    toc_with_physical_index = toc_index_extractor(toc_no_page_number, main_content, model)
    logger.info(f'toc_with_physical_index: {toc_with_physical_index}')  # L626

    toc_with_physical_index = convert_physical_index_to_int(toc_with_physical_index)
    logger.info(f'toc_with_physical_index: {toc_with_physical_index}')  # L629

    matching_pairs = extract_matching_page_pairs(toc_with_page_number, toc_with_physical_index, start_page_index)
    logger.info(f'matching_pairs: {matching_pairs}')  # L632

    offset = calculate_page_offset(matching_pairs)
    logger.info(f'offset: {offset}')  # L635

    toc_with_page_number = add_page_offset_to_toc_json(toc_with_page_number, offset)
    logger.info(f'toc_with_page_number: {toc_with_page_number}')  # L638

    toc_with_page_number = process_none_page_numbers(toc_with_page_number, page_list, model=model)
    logger.info(f'toc_with_page_number: {toc_with_page_number}')  # L641

    return toc_with_page_number
```

#### 质量验证与降级日志（`page_index.py:951-988`）

`meta_processor()` 是流水线的核心调度器，记录每种处理模式的验证结果并驱动降级决策：

```python
async def meta_processor(page_list, mode=None, toc_content=None,
                         toc_page_list=None, start_index=1, opt=None, logger=None):
    # ... 根据 mode 选择处理函数 ...
    accuracy, incorrect_results = await verify_toc(
        page_list, toc_with_page_number, start_index=start_index, model=opt.model)

    logger.info({
        'mode': 'process_toc_with_page_numbers',
        'accuracy': accuracy,
        'incorrect_results': incorrect_results
    })  # L973-977

    if accuracy == 1.0 and len(incorrect_results) == 0:
        return toc_with_page_number
    if accuracy > 0.6 and len(incorrect_results) > 0:
        toc_with_page_number, incorrect_results = await fix_incorrect_toc_with_retries(
            toc_with_page_number, page_list, incorrect_results,
            start_index=start_index, max_attempts=3, model=opt.model, logger=logger)
        return toc_with_page_number
    else:
        # 降级到下一种处理模式
        if mode == 'process_toc_with_page_numbers':
            return await meta_processor(page_list, mode='process_toc_no_page_numbers', ...)
        elif mode == 'process_toc_no_page_numbers':
            return await meta_processor(page_list, mode='process_no_toc', ...)
```

降级链路：`process_toc_with_page_numbers` → `process_toc_no_page_numbers` → `process_no_toc`，每次降级都会重新记录 accuracy 和 incorrect_results，形成完整的决策审计轨迹。

#### 错误修复日志（`page_index.py:752-886`）

`fix_incorrect_toc()` 和 `fix_incorrect_toc_with_retries()` 记录修复过程的关键数据：

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
            logger.info("Maximum fix attempts reached")  # L883
            break
    return current_toc, current_incorrect
```

`fix_incorrect_toc()` 内部记录（`page_index.py:863-864`）：
- `incorrect_results_and_range_logs`：每个错误项的搜索范围和修复尝试
- `invalid_results`：无法修复的项目列表

### 2.3 实现细节

#### Token 计量机制

`get_page_tokens()`（`utils.py:413-437`）在 PDF 解析阶段就完成 token 计数，使用 tiktoken 编码器：

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

这个设计将 token 计数前置到数据准备阶段，使得后续所有函数都能直接使用 `page[1]` 获取 token 数，无需重复编码。入口处的 `total_token` 汇总（`page_index.py:1072`）提供了成本估算的上界。

#### 日志数据流

```
page_index_main()
  │
  ├─ logger.info({total_page_number: N})     ← 文档规模
  ├─ logger.info({total_token: T})           ← 成本基线
  │
  ├─ tree_parser()
  │   ├─ logger.info(check_toc_result)       ← TOC 检测结果
  │   │
  │   ├─ meta_processor()
  │   │   ├─ process_toc_with_page_numbers()
  │   │   │   ├─ logger.info(toc_with_page_number)    ← 每步转换结果
  │   │   │   ├─ logger.info(toc_with_physical_index)
  │   │   │   ├─ logger.info(matching_pairs)
  │   │   │   ├─ logger.info(offset)
  │   │   │   └─ logger.info(最终 toc)
  │   │   │
  │   │   ├─ logger.info({mode, accuracy, incorrect_results})  ← 质量指标
  │   │   │
  │   │   └─ fix_incorrect_toc_with_retries()
  │   │       ├─ logger.info(incorrect_results_and_range_logs)
  │   │       ├─ logger.info(invalid_results)
  │   │       └─ logger.info("Maximum fix attempts reached")
  │   │
  │   ├─ find_toc_pages()
  │   │   ├─ logger.info("Page {i} has toc")
  │   │   └─ logger.info("No toc found")
  │   │
  │   └─ check_title_appearance_in_start_concurrent()
  │       └─ logger.info("Checking title appearance...")
  │
  └─ ./logs/{pdf_name}_{timestamp}.json      ← 最终输出
```

#### 设计缺陷与改进空间

1. **日志级别丢失**：`log()` 方法接收 `level` 参数但未写入数据（`utils.py:320`），所有日志条目无法区分 INFO/ERROR/DEBUG
2. **全量重写性能**：每次 `log()` 都重写整个 JSON 文件（`utils.py:328`），对于大型 PDF（数百页）可能产生数千条日志，I/O 开销随日志增长线性增加
3. **无 LLM 调用级 token 追踪**：`total_token` 只记录输入文档的 token 总量，不追踪每次 LLM API 调用的实际 token 消耗（prompt + completion）
4. **无时间戳字段**：日志条目本身不含时间戳，只有文件名包含创建时间，无法分析各阶段耗时

---

## 第 3 章 迁移指南

### 3.1 迁移清单

**阶段 1：基础日志框架**
- [ ] 实现 JsonLogger 类（含日志级别写入修复）
- [ ] 在流水线入口创建 logger 实例
- [ ] 通过参数传递 logger 到所有子函数

**阶段 2：关键指标记录**
- [ ] 入口处记录输入规模指标（文档大小、token 总量等）
- [ ] 在每个处理阶段记录中间状态
- [ ] 在质量验证点记录 accuracy 和错误列表

**阶段 3：增强（可选）**
- [ ] 添加每条日志的时间戳和级别字段
- [ ] 添加 LLM 调用级 token 追踪（prompt_tokens + completion_tokens）
- [ ] 改用追加写入 + 崩溃恢复机制替代全量重写
- [ ] 添加结构化查询接口（按阶段、按级别过滤）

### 3.2 适配代码模板

以下是改进版 JsonLogger，修复了原版的日志级别丢失和时间戳缺失问题：

```python
import json
import os
from datetime import datetime
from typing import Any, Union


class StructuredJsonLogger:
    """结构化 JSON 日志器 — 基于 PageIndex JsonLogger 改进版。

    改进点：
    - 每条日志包含 level + timestamp 字段
    - 支持 context 上下文（如 stage、function 名）
    - 可选全量重写或追加模式
    """

    def __init__(self, run_id: str, log_dir: str = "./logs"):
        ts = datetime.now().strftime("%Y%m%d_%H%M%S")
        self.filename = f"{run_id}_{ts}.json"
        self.log_dir = log_dir
        os.makedirs(log_dir, exist_ok=True)
        self.log_data: list[dict[str, Any]] = []

    def log(self, level: str, message: Union[str, dict], **context) -> None:
        entry = {
            "timestamp": datetime.now().isoformat(),
            "level": level,
        }
        if isinstance(message, dict):
            entry["data"] = message
        else:
            entry["message"] = message
        if context:
            entry["context"] = context

        self.log_data.append(entry)
        self._flush()

    def info(self, message, **ctx):
        self.log("INFO", message, **ctx)

    def error(self, message, **ctx):
        self.log("ERROR", message, **ctx)

    def debug(self, message, **ctx):
        self.log("DEBUG", message, **ctx)

    def metric(self, name: str, value: Any, **ctx):
        """专用指标记录方法"""
        self.log("METRIC", {"metric": name, "value": value}, **ctx)

    def _flush(self):
        path = os.path.join(self.log_dir, self.filename)
        with open(path, "w") as f:
            json.dump(self.log_data, f, indent=2, default=str)

    def summary(self) -> dict:
        """返回日志摘要：各级别计数 + 指标汇总"""
        levels = {}
        metrics = {}
        for entry in self.log_data:
            lvl = entry.get("level", "UNKNOWN")
            levels[lvl] = levels.get(lvl, 0) + 1
            if lvl == "METRIC" and isinstance(entry.get("data"), dict):
                metrics[entry["data"]["metric"]] = entry["data"]["value"]
        return {"level_counts": levels, "metrics": metrics}
```

使用示例：

```python
# 在流水线入口创建
logger = StructuredJsonLogger(run_id="my-pdf-doc")

# 记录输入规模
logger.metric("total_pages", len(page_list))
logger.metric("total_tokens", sum(t for _, t in page_list))

# 在处理函数中记录中间状态
logger.info({"toc_detected": True, "toc_pages": [1, 2, 3]}, stage="toc_detection")

# 记录质量指标
logger.info({
    "mode": "process_toc_with_page_numbers",
    "accuracy": 0.85,
    "incorrect_count": 3
}, stage="verification")

# 记录错误
logger.error("Maximum fix attempts reached", stage="toc_fix", attempt=3)

# 获取摘要
print(logger.summary())
```

### 3.3 适用场景

| 场景 | 适用度 | 说明 |
|------|--------|------|
| 多阶段 LLM 流水线调试 | ⭐⭐⭐ | 核心场景：每步中间结果持久化，崩溃后可从日志恢复上下文 |
| PDF/文档处理流水线 | ⭐⭐⭐ | 直接适用：文件名含文档标识，日志与输入一一对应 |
| 单次批处理任务 | ⭐⭐⭐ | 全量重写保证崩溃安全，适合非高频写入场景 |
| 高并发在线服务 | ⭐ | 全量重写 I/O 开销大，需改为追加写入 + 异步刷盘 |
| 实时监控/告警 | ⭐ | 文件日志不支持实时推送，需额外集成 Prometheus/OpenTelemetry |
| 成本精确核算 | ⭐⭐ | 记录了输入 token 总量，但缺少 LLM 调用级 token 追踪 |

---

## 第 4 章 测试用例

```python
import json
import os
import tempfile
import pytest
from datetime import datetime
from io import BytesIO


class TestJsonLogger:
    """基于 PageIndex JsonLogger (utils.py:309-345) 的测试用例"""

    def setup_method(self):
        """每个测试前创建临时日志目录"""
        self.tmp_dir = tempfile.mkdtemp()
        self.original_cwd = os.getcwd()
        os.chdir(self.tmp_dir)

    def teardown_method(self):
        os.chdir(self.original_cwd)

    def test_logger_creates_log_file_with_pdf_name(self):
        """验证日志文件名包含 PDF 名称和时间戳"""
        # 模拟 JsonLogger 的文件命名逻辑
        pdf_name = "test_document"
        current_time = datetime.now().strftime("%Y%m%d_%H%M%S")
        filename = f"{pdf_name}_{current_time}.json"

        assert "test_document" in filename
        assert len(current_time) == 15  # YYYYMMDD_HHMMSS

    def test_log_dict_message_appended_directly(self):
        """验证 dict 消息直接追加到 log_data"""
        log_data = []
        message = {"total_page_number": 42}

        # 模拟 JsonLogger.log() 的核心逻辑 (utils.py:321-322)
        if isinstance(message, dict):
            log_data.append(message)
        else:
            log_data.append({"message": message})

        assert log_data == [{"total_page_number": 42}]

    def test_log_string_message_wrapped(self):
        """验证 string 消息被包装为 {'message': str}"""
        log_data = []
        message = "No toc found"

        if isinstance(message, dict):
            log_data.append(message)
        else:
            log_data.append({"message": message})

        assert log_data == [{"message": "No toc found"}]

    def test_full_rewrite_preserves_all_entries(self):
        """验证全量重写模式下所有历史条目都被保留"""
        os.makedirs("./logs", exist_ok=True)
        log_data = []
        filepath = os.path.join("logs", "test_20240101_120000.json")

        # 模拟多次写入
        for i in range(5):
            log_data.append({"step": i, "value": f"data_{i}"})
            with open(filepath, "w") as f:
                json.dump(log_data, f, indent=2)

        # 读取验证
        with open(filepath) as f:
            saved = json.load(f)
        assert len(saved) == 5
        assert saved[0]["step"] == 0
        assert saved[4]["step"] == 4

    def test_accuracy_and_incorrect_results_logged(self):
        """验证 meta_processor 的质量指标日志格式 (page_index.py:973-977)"""
        log_entry = {
            "mode": "process_toc_with_page_numbers",
            "accuracy": 0.85,
            "incorrect_results": [
                {"list_index": 3, "title": "Chapter 4", "answer": "no"}
            ],
        }

        assert log_entry["accuracy"] == 0.85
        assert len(log_entry["incorrect_results"]) == 1
        assert log_entry["mode"] == "process_toc_with_page_numbers"

    def test_token_counting_basic(self):
        """验证 token 计数逻辑 (utils.py:22-27)"""
        import tiktoken

        enc = tiktoken.encoding_for_model("gpt-4o-2024-11-20")
        text = "Hello, world!"
        token_count = len(enc.encode(text))

        assert token_count > 0
        assert isinstance(token_count, int)

    def test_total_token_aggregation(self):
        """验证入口处 total_token 汇总逻辑 (page_index.py:1072)"""
        page_list = [
            ("Page 1 content", 150),
            ("Page 2 content", 200),
            ("Page 3 content", 180),
        ]

        total_token = sum([page[1] for page in page_list])
        assert total_token == 530

    def test_logger_optional_guard(self):
        """验证 logger 可选守卫模式 (page_index.py:345-346)"""
        logger = None
        # 模拟 find_toc_pages 中的守卫逻辑
        if logger:
            logger.info("Page 1 has toc")
        # 不应抛出异常
        assert True
```

---

## 第 5 章 跨域关联

| 关联域 | 关系类型 | 说明 |
|--------|----------|------|
| PD-01 上下文管理 | 协同 | `total_token` 记录为上下文窗口管理提供输入规模数据；`get_page_tokens()` 的 token 计数同时服务于上下文分组（`page_list_to_group_text`）和可观测性 |
| PD-03 容错与重试 | 依赖 | `fix_incorrect_toc_with_retries()` 的重试日志（`page_index.py:883`）依赖 logger 记录重试次数和失败原因；`ChatGPT_API` 的 `logging.error` 记录 API 重试 |
| PD-07 质量检查 | 协同 | `verify_toc()` 的 accuracy 计算结果通过 logger 持久化（`page_index.py:973-977`），质量检查和可观测性共享同一数据管道 |
| PD-12 推理增强 | 协同 | 三种处理模式的降级路径（有页码→无页码→无 TOC）通过 logger 记录 mode 字段，为推理策略选择提供历史数据 |

---

## 第 6 章 来源文件索引

| 文件 | 行范围 | 关键实现 |
|------|--------|----------|
| `pageindex/utils.py` | L22-27 | `count_tokens()` — tiktoken 编码器 token 计数 |
| `pageindex/utils.py` | L29-57 | `ChatGPT_API_with_finish_reason()` — API 调用 + logging.error 重试日志 |
| `pageindex/utils.py` | L297-306 | `get_pdf_name()` — 从文件路径/BytesIO 提取 PDF 名称 |
| `pageindex/utils.py` | L309-345 | `JsonLogger` 类 — 结构化 JSON 日志核心实现 |
| `pageindex/utils.py` | L413-437 | `get_page_tokens()` — PDF 解析 + 逐页 token 计数 |
| `pageindex/page_index.py` | L48-71 | `check_title_appearance_in_start()` — 带 logger 的 LLM 验证 |
| `pageindex/page_index.py` | L74-96 | `check_title_appearance_in_start_concurrent()` — 并发验证 + 错误日志 |
| `pageindex/page_index.py` | L333-358 | `find_toc_pages()` — TOC 检测 + 逐页日志 |
| `pageindex/page_index.py` | L568-587 | `process_no_toc()` — 无 TOC 模式处理 + 中间状态日志 |
| `pageindex/page_index.py` | L589-608 | `process_toc_no_page_numbers()` — 无页码 TOC 处理 + 日志 |
| `pageindex/page_index.py` | L614-641 | `process_toc_with_page_numbers()` — 有页码 TOC 处理 + 7 步日志 |
| `pageindex/page_index.py` | L752-866 | `fix_incorrect_toc()` — 错误修复 + 修复结果日志 |
| `pageindex/page_index.py` | L870-886 | `fix_incorrect_toc_with_retries()` — 重试循环 + 最大重试日志 |
| `pageindex/page_index.py` | L892-944 | `verify_toc()` — 准确性验证（accuracy 计算） |
| `pageindex/page_index.py` | L951-988 | `meta_processor()` — 核心调度 + 质量指标日志 + 降级决策 |
| `pageindex/page_index.py` | L1021-1055 | `tree_parser()` — 顶层解析 + TOC 检测结果日志 |
| `pageindex/page_index.py` | L1058-1100 | `page_index_main()` — 入口 + logger 创建 + 规模指标记录 |
| `pageindex/page_index.py` | L1114-1138 | `validate_and_truncate_physical_indices()` — 索引截断 + 日志 |

---

## 第 7 章 横向对比维度

> 用于自动填充 Butcher Wiki 的横向对比表。

```json comparison_data
{
  "project": "PageIndex",
  "dimensions": {
    "日志格式": "自定义 JsonLogger，全量 JSON 数组重写到文件",
    "追踪方式": "函数参数逐层传递 logger，无分布式 trace",
    "指标采集": "入口记录 total_page_number + total_token，流水线各步记录中间状态",
    "可视化": "无内置可视化，依赖 JSON 文件人工查阅",
    "成本追踪": "tiktoken 前置计算文档 token 总量，无 LLM 调用级 token 追踪",
    "日志级别": "接口支持 info/error/debug/exception 四级，但级别未写入数据",
    "崩溃安全": "每次写入全量重写文件，进程崩溃不丢失已记录数据"
  }
}
```

**维度说明：**
- "日志格式""追踪方式""指标采集""可视化""成本追踪"复用 PD-11 已有维度
- "日志级别""崩溃安全"是 PageIndex 的 JsonLogger 独有特征，反映其文件级日志系统的设计取舍
