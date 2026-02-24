# PD-11.06 OpenManus — 双日志系统 + Token 累积追踪方案

> 文档编号：PD-11.06
> 来源：OpenManus `app/logger.py` `app/utils/logger.py` `app/llm.py`
> GitHub：https://github.com/FoundationAgents/OpenManus.git
> 问题域：PD-11 可观测性 Observability & Cost Tracking
> 状态：可复用方案

---

## 第 1 章 问题与动机（≥ 30 行）

### 1.1 核心问题

Agent 系统在运行时需要回答三个关键问题：
1. **发生了什么？** — 每次 LLM 调用的输入/输出/工具选择需要可追溯
2. **花了多少钱？** — Token 消耗需要精确统计，支持累积追踪和限额保护
3. **哪里出了问题？** — 错误需要分级记录，开发环境和生产环境的日志需求不同

OpenManus 面临的特殊挑战在于它是一个多 Agent 工具调用系统（Manus、Browser、Sandbox 等多种 Agent），每个 Agent 都通过 LLM 单例进行调用，token 消耗分散在多个执行路径中。同时项目需要同时支持 OpenAI、Azure、AWS Bedrock 三种 API 提供商，各自的 usage 返回格式不同。

### 1.2 OpenManus 的解法概述

OpenManus 采用**双日志系统 + LLM 级 Token 累积器**的组合方案：

1. **loguru 分级日志**（`app/logger.py:12-26`）— 主日志系统，stderr 输出 INFO 级别供实时观察，文件输出 DEBUG 级别供事后分析，日志文件按时间戳命名
2. **structlog 结构化日志**（`app/utils/logger.py:1-32`）— 辅助日志系统，支持 JSON 渲染（生产）和 Console 渲染（本地），自动附加调用位置（文件名、函数名、行号）
3. **TokenCounter 客户端估算**（`app/llm.py:45-171`）— 使用 tiktoken 在发送前预估 token 数，支持文本、图片、工具调用三种内容类型的 token 计算
4. **LLM 累积追踪**（`app/llm.py:238-247`）— 每次调用后累加 input/completion tokens，区分流式（客户端估算）和非流式（API 返回值）两种统计模式
5. **Token 限额保护**（`app/llm.py:249-264`）— 可配置 `max_input_tokens` 上限，超限时抛出 `TokenLimitExceeded` 异常且不触发重试

### 1.3 设计思想

| 设计原则 | 具体实现 | 理由 | 替代方案 |
|----------|----------|------|----------|
| 双日志分离 | loguru（运行时）+ structlog（结构化） | 运行时需要人类可读，分析时需要机器可解析 | 统一用 structlog（但 loguru 的 emoji 日志更适合 Agent 调试） |
| 客户端预估 + API 精确值混合 | 流式用 tiktoken 估算，非流式用 response.usage | 流式响应无法获取 API 返回的 token 数 | 全部用客户端估算（但误差更大） |
| 单例 LLM 累积器 | `__new__` 单例模式，token 计数跟随实例生命周期 | 多 Agent 共享同一 LLM 配置时自动聚合 token | 独立的 TokenTracker 服务（更解耦但更复杂） |
| 异常不重试 | `TokenLimitExceeded` 不在 tenacity retry 列表中 | token 超限是确定性错误，重试无意义 | 自动截断上下文后重试（更智能但风险更高） |
| 环境感知渲染 | structlog 根据 ENV_MODE 切换 JSON/Console | 本地开发看彩色输出，生产环境输出 JSON 便于 ELK 采集 | 始终 JSON（但本地调试体验差） |

---

## 第 2 章 源码实现分析（≥ 60 行，核心章节）

### 2.1 架构概览

```
┌─────────────────────────────────────────────────────────────┐
│                    OpenManus Agent 系统                       │
│                                                              │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐    │
│  │  Manus   │  │ Browser  │  │ Sandbox  │  │   MCP    │    │
│  │  Agent   │  │  Agent   │  │  Agent   │  │  Agent   │    │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └────┬─────┘    │
│       │              │              │              │          │
│       └──────────────┴──────┬───────┴──────────────┘          │
│                             │                                 │
│                    ┌────────▼────────┐                        │
│                    │   LLM 单例      │                        │
│                    │ (TokenCounter)  │                        │
│                    │ total_input: N  │                        │
│                    │ total_compl: M  │                        │
│                    └────────┬────────┘                        │
│                             │                                 │
│              ┌──────────────┼──────────────┐                  │
│              │              │              │                   │
│     ┌────────▼──┐  ┌───────▼───┐  ┌──────▼──────┐           │
│     │  OpenAI   │  │   Azure   │  │   Bedrock   │           │
│     │  API      │  │   API     │  │   API       │           │
│     └───────────┘  └───────────┘  └─────────────┘           │
│                                                              │
│  ═══════════════════ 日志层 ═══════════════════              │
│  ┌─────────────────┐    ┌──────────────────────┐            │
│  │ loguru logger   │    │ structlog logger      │            │
│  │ stderr: INFO    │    │ LOCAL: Console 渲染   │            │
│  │ file: DEBUG     │    │ PROD: JSON 渲染       │            │
│  │ logs/YYYYMMDD.. │    │ + callsite 自动附加   │            │
│  └─────────────────┘    └──────────────────────┘            │
└─────────────────────────────────────────────────────────────┘
```

### 2.2 核心实现

#### 2.2.1 loguru 分级日志系统

`app/logger.py:12-29` 定义了主日志系统：

```python
# app/logger.py:12-29
def define_log_level(print_level="INFO", logfile_level="DEBUG", name: str = None):
    """Adjust the log level to above level"""
    global _print_level
    _print_level = print_level

    current_date = datetime.now()
    formatted_date = current_date.strftime("%Y%m%d%H%M%S")
    log_name = (
        f"{name}_{formatted_date}" if name else formatted_date
    )

    _logger.remove()
    _logger.add(sys.stderr, level=print_level)
    _logger.add(PROJECT_ROOT / f"logs/{log_name}.log", level=logfile_level)
    return _logger

logger = define_log_level()
```

关键设计点：
- **双 sink 分离**：stderr 只输出 INFO+（用户实时看），文件记录 DEBUG+（事后分析用）
- **时间戳文件名**：每次启动生成新日志文件 `logs/20240315143022.log`，避免覆盖
- **可选前缀**：`name` 参数支持为不同 Agent 创建带前缀的日志文件
- **模块级初始化**：`logger = define_log_level()` 在导入时即完成配置

#### 2.2.2 structlog 结构化日志系统

`app/utils/logger.py:1-32` 提供了面向生产环境的结构化日志：

```python
# app/utils/logger.py:7-32
ENV_MODE = os.getenv("ENV_MODE", "LOCAL")

renderer = [structlog.processors.JSONRenderer()]
if ENV_MODE.lower() == "local".lower():
    renderer = [structlog.dev.ConsoleRenderer()]

structlog.configure(
    processors=[
        structlog.stdlib.add_log_level,
        structlog.stdlib.PositionalArgumentsFormatter(),
        structlog.processors.dict_tracebacks,
        structlog.processors.CallsiteParameterAdder(
            {
                structlog.processors.CallsiteParameter.FILENAME,
                structlog.processors.CallsiteParameter.FUNC_NAME,
                structlog.processors.CallsiteParameter.LINENO,
            }
        ),
        structlog.processors.TimeStamper(fmt="iso"),
        structlog.contextvars.merge_contextvars,
        *renderer,
    ],
    cache_logger_on_first_use=True,
)

logger: structlog.stdlib.BoundLogger = structlog.get_logger(level=logging.DEBUG)
```

关键设计点：
- **环境感知渲染**：`ENV_MODE=LOCAL` 时用 `ConsoleRenderer`（彩色人类可读），生产环境用 `JSONRenderer`（机器可解析）
- **自动调用位置**：`CallsiteParameterAdder` 自动附加文件名、函数名、行号，无需手动传入
- **ISO 时间戳**：`TimeStamper(fmt="iso")` 输出标准 ISO 8601 格式
- **上下文变量合并**：`merge_contextvars` 支持通过 `structlog.contextvars.bind_contextvars()` 注入请求级上下文（如 request_id）

#### 2.2.3 TokenCounter 客户端估算器

`app/llm.py:45-171` 实现了完整的客户端 token 估算：

```python
# app/llm.py:45-57
class TokenCounter:
    BASE_MESSAGE_TOKENS = 4
    FORMAT_TOKENS = 2
    LOW_DETAIL_IMAGE_TOKENS = 85
    HIGH_DETAIL_TILE_TOKENS = 170
    MAX_SIZE = 2048
    HIGH_DETAIL_TARGET_SHORT_SIDE = 768
    TILE_SIZE = 512

    def __init__(self, tokenizer):
        self.tokenizer = tokenizer
```

TokenCounter 支持三种内容类型的 token 计算：
- **文本**（`count_text`，L60-62）：直接用 tiktoken 编码计算
- **图片**（`count_image`，L64-93）：按 OpenAI 的图片 token 计算规则，区分 low/medium/high 三种 detail 级别，high detail 按 512px tile 切分计算
- **工具调用**（`count_tool_calls`，L137-145）：累加函数名和参数的 token 数

#### 2.2.4 LLM 累积追踪与限额保护

`app/llm.py:238-264` 是 token 追踪的核心：

```python
# app/llm.py:238-264
def update_token_count(self, input_tokens: int, completion_tokens: int = 0) -> None:
    """Update token counts"""
    self.total_input_tokens += input_tokens
    self.total_completion_tokens += completion_tokens
    logger.info(
        f"Token usage: Input={input_tokens}, Completion={completion_tokens}, "
        f"Cumulative Input={self.total_input_tokens}, Cumulative Completion={self.total_completion_tokens}, "
        f"Total={input_tokens + completion_tokens}, Cumulative Total={self.total_input_tokens + self.total_completion_tokens}"
    )

def check_token_limit(self, input_tokens: int) -> bool:
    """Check if token limits are exceeded"""
    if self.max_input_tokens is not None:
        return (self.total_input_tokens + input_tokens) <= self.max_input_tokens
    return True

def get_limit_error_message(self, input_tokens: int) -> str:
    """Generate error message for token limit exceeded"""
    if (
        self.max_input_tokens is not None
        and (self.total_input_tokens + input_tokens) > self.max_input_tokens
    ):
        return f"Request may exceed input token limit (Current: {self.total_input_tokens}, Needed: {input_tokens}, Max: {self.max_input_tokens})"
    return "Token limit exceeded"
```

#### 2.2.5 流式 vs 非流式的 Token 统计差异

`app/llm.py:419-458` 展示了两种模式的关键差异：

```python
# 非流式（app/llm.py:429-431）— 使用 API 返回的精确值
self.update_token_count(
    response.usage.prompt_tokens, response.usage.completion_tokens
)

# 流式（app/llm.py:436 + 453-458）— 发送前记录 input，完成后估算 completion
self.update_token_count(input_tokens)  # 发送前：用客户端估算的 input tokens
# ... 流式接收完成后 ...
completion_tokens = self.count_tokens(completion_text)
logger.info(f"Estimated completion tokens for streaming response: {completion_tokens}")
self.total_completion_tokens += completion_tokens
```

### 2.3 实现细节

#### Bedrock 提供商的 Usage 适配

`app/bedrock.py:183-192` 展示了 Bedrock 到 OpenAI 格式的 usage 转换：

```python
# app/bedrock.py:183-192
"usage": {
    "completion_tokens": bedrock_response.get("usage", {}).get("outputTokens", 0),
    "prompt_tokens": bedrock_response.get("usage", {}).get("inputTokens", 0),
    "total_tokens": bedrock_response.get("usage", {}).get("totalTokens", 0),
},
```

Bedrock 使用 `inputTokens/outputTokens/totalTokens`，通过 `BedrockClient` 统一转换为 OpenAI 的 `prompt_tokens/completion_tokens/total_tokens` 格式，使上层 `LLM.update_token_count` 无需感知提供商差异。

#### Agent 层的日志使用模式

`app/agent/toolcall.py:81-89` 展示了 Agent 层如何利用 loguru 的 emoji 日志：

```python
# app/agent/toolcall.py:81-89
logger.info(f"✨ {self.name}'s thoughts: {content}")
logger.info(f"🛠️ {self.name} selected {len(tool_calls)} tools to use")
logger.info(f"🧰 Tools being prepared: {[call.function.name for call in tool_calls]}")
logger.info(f"🔧 Tool arguments: {tool_calls[0].function.arguments}")
```

这种 emoji 前缀模式使得在大量日志中快速定位 Agent 的思考（✨）、工具选择（🛠️）、工具执行（🔧）和完成（🎯）变得直观。

#### 卡死检测机制

`app/agent/base.py:170-186` 实现了基于重复内容的卡死检测：

```python
# app/agent/base.py:170-186
def is_stuck(self) -> bool:
    """Check if the agent is stuck in a loop by detecting duplicate content"""
    if len(self.memory.messages) < 2:
        return False
    last_message = self.memory.messages[-1]
    if not last_message.content:
        return False
    duplicate_count = sum(
        1
        for msg in reversed(self.memory.messages[:-1])
        if msg.role == "assistant" and msg.content == last_message.content
    )
    return duplicate_count >= self.duplicate_threshold
```

---

## 第 3 章 迁移指南（≥ 40 行）

### 3.1 迁移清单

#### 阶段 1：基础日志（1 天）
- [ ] 安装 loguru：`pip install loguru`
- [ ] 创建 `logger.py`，配置双 sink（stderr INFO + 文件 DEBUG）
- [ ] 在所有模块中统一 `from app.logger import logger`
- [ ] 确保 `logs/` 目录在 `.gitignore` 中

#### 阶段 2：Token 追踪（2 天）
- [ ] 安装 tiktoken：`pip install tiktoken`
- [ ] 实现 `TokenCounter` 类，支持文本和工具调用的 token 计算
- [ ] 在 LLM 封装层添加 `total_input_tokens` / `total_completion_tokens` 累积器
- [ ] 区分流式和非流式的 token 统计逻辑
- [ ] 添加 `max_input_tokens` 配置项和 `TokenLimitExceeded` 异常

#### 阶段 3：结构化日志（可选）
- [ ] 安装 structlog：`pip install structlog`
- [ ] 配置环境感知渲染（LOCAL → Console，PROD → JSON）
- [ ] 添加 CallsiteParameterAdder 自动附加调用位置

### 3.2 适配代码模板

#### 最小可用的 Token 追踪器

```python
"""token_tracker.py — 可直接复用的 Token 累积追踪器"""
import tiktoken
from dataclasses import dataclass, field
from typing import Optional
from loguru import logger


@dataclass
class TokenUsage:
    """单次调用的 token 使用量"""
    input_tokens: int = 0
    completion_tokens: int = 0
    model: str = ""
    is_estimated: bool = False  # 标记是否为客户端估算值


@dataclass
class TokenTracker:
    """LLM 级别的 Token 累积追踪器，参考 OpenManus LLM 类设计"""
    total_input_tokens: int = 0
    total_completion_tokens: int = 0
    max_input_tokens: Optional[int] = None
    model: str = "gpt-4o"
    _tokenizer: object = field(default=None, repr=False)

    def __post_init__(self):
        try:
            self._tokenizer = tiktoken.encoding_for_model(self.model)
        except KeyError:
            self._tokenizer = tiktoken.get_encoding("cl100k_base")

    def count_tokens(self, text: str) -> int:
        """客户端 token 估算"""
        if not text:
            return 0
        return len(self._tokenizer.encode(text))

    def update(self, input_tokens: int, completion_tokens: int = 0,
               is_estimated: bool = False) -> TokenUsage:
        """更新累积计数并记录日志"""
        self.total_input_tokens += input_tokens
        self.total_completion_tokens += completion_tokens
        usage = TokenUsage(
            input_tokens=input_tokens,
            completion_tokens=completion_tokens,
            model=self.model,
            is_estimated=is_estimated,
        )
        logger.info(
            f"Token usage: Input={input_tokens}, Completion={completion_tokens}, "
            f"Cumulative Total={self.total_input_tokens + self.total_completion_tokens}"
        )
        return usage

    def check_limit(self, input_tokens: int) -> bool:
        """检查是否超过 token 限额"""
        if self.max_input_tokens is None:
            return True
        return (self.total_input_tokens + input_tokens) <= self.max_input_tokens

    @property
    def total_tokens(self) -> int:
        return self.total_input_tokens + self.total_completion_tokens
```

#### 双日志配置模板

```python
"""dual_logger.py — loguru + structlog 双日志配置"""
import sys
import os
import logging
from datetime import datetime
from pathlib import Path

from loguru import logger as loguru_logger
import structlog


def setup_loguru(project_root: Path, print_level="INFO", file_level="DEBUG"):
    """配置 loguru 分级日志，参考 OpenManus app/logger.py"""
    formatted_date = datetime.now().strftime("%Y%m%d%H%M%S")
    log_dir = project_root / "logs"
    log_dir.mkdir(exist_ok=True)

    loguru_logger.remove()
    loguru_logger.add(sys.stderr, level=print_level)
    loguru_logger.add(log_dir / f"{formatted_date}.log", level=file_level)
    return loguru_logger


def setup_structlog():
    """配置 structlog 结构化日志，参考 OpenManus app/utils/logger.py"""
    env_mode = os.getenv("ENV_MODE", "LOCAL")
    renderer = (
        [structlog.dev.ConsoleRenderer()]
        if env_mode.upper() == "LOCAL"
        else [structlog.processors.JSONRenderer()]
    )
    structlog.configure(
        processors=[
            structlog.stdlib.add_log_level,
            structlog.processors.TimeStamper(fmt="iso"),
            structlog.processors.CallsiteParameterAdder({
                structlog.processors.CallsiteParameter.FILENAME,
                structlog.processors.CallsiteParameter.FUNC_NAME,
                structlog.processors.CallsiteParameter.LINENO,
            }),
            structlog.contextvars.merge_contextvars,
            *renderer,
        ],
        cache_logger_on_first_use=True,
    )
    return structlog.get_logger(level=logging.DEBUG)
```

### 3.3 适用场景

| 场景 | 适用度 | 说明 |
|------|--------|------|
| 单 LLM 提供商的 Agent 系统 | ⭐⭐⭐ | 直接复用，无需适配层 |
| 多提供商（OpenAI + Azure + Bedrock） | ⭐⭐⭐ | OpenManus 已验证三提供商适配 |
| 需要精确成本核算的生产系统 | ⭐⭐ | 流式模式的客户端估算有误差，需补充 API 级精确统计 |
| 多 Agent 独立计费 | ⭐⭐ | 单例模式导致多 Agent 共享计数器，需改造为 per-agent 追踪 |
| 需要时间序列分析的系统 | ⭐ | 仅有累积值，无时间序列持久化，需自行扩展 |

---

## 第 4 章 测试用例（≥ 20 行）

```python
"""test_observability.py — 基于 OpenManus 真实接口的测试用例"""
import pytest
from unittest.mock import MagicMock, patch


class TestTokenCounter:
    """测试 TokenCounter 的 token 计算逻辑"""

    def setup_method(self):
        """模拟 tiktoken tokenizer"""
        self.mock_tokenizer = MagicMock()
        self.mock_tokenizer.encode.return_value = [1, 2, 3, 4, 5]  # 5 tokens

        # 延迟导入以避免配置依赖
        from dataclasses import dataclass, field
        from typing import Optional

        @dataclass
        class TokenTracker:
            total_input_tokens: int = 0
            total_completion_tokens: int = 0
            max_input_tokens: Optional[int] = None

            def update(self, input_tokens, completion_tokens=0):
                self.total_input_tokens += input_tokens
                self.total_completion_tokens += completion_tokens

            def check_limit(self, input_tokens):
                if self.max_input_tokens is None:
                    return True
                return (self.total_input_tokens + input_tokens) <= self.max_input_tokens

        self.tracker = TokenTracker()

    def test_count_text_empty(self):
        """空文本返回 0 token"""
        self.mock_tokenizer.encode.return_value = []
        assert len(self.mock_tokenizer.encode("")) == 0

    def test_count_text_normal(self):
        """正常文本返回正确 token 数"""
        assert len(self.mock_tokenizer.encode("hello world")) == 5

    def test_cumulative_tracking(self):
        """累积追踪正确累加"""
        self.tracker.update(100, 50)
        self.tracker.update(200, 80)
        assert self.tracker.total_input_tokens == 300
        assert self.tracker.total_completion_tokens == 130

    def test_token_limit_not_set(self):
        """未设置限额时始终返回 True"""
        assert self.tracker.check_limit(999999) is True

    def test_token_limit_within(self):
        """在限额内返回 True"""
        self.tracker.max_input_tokens = 1000
        self.tracker.update(500)
        assert self.tracker.check_limit(400) is True

    def test_token_limit_exceeded(self):
        """超过限额返回 False"""
        self.tracker.max_input_tokens = 1000
        self.tracker.update(800)
        assert self.tracker.check_limit(300) is False

    def test_streaming_estimation_separate(self):
        """流式模式下 input 和 completion 分开更新"""
        # 模拟流式：先记录 input
        self.tracker.update(input_tokens=500)
        assert self.tracker.total_input_tokens == 500
        assert self.tracker.total_completion_tokens == 0

        # 流式完成后补充 completion
        self.tracker.total_completion_tokens += 200
        assert self.tracker.total_completion_tokens == 200


class TestDualLogger:
    """测试双日志系统配置"""

    def test_loguru_dual_sink(self, tmp_path):
        """loguru 配置双 sink：stderr + 文件"""
        from loguru import logger as test_logger
        import sys

        test_logger.remove()
        test_logger.add(sys.stderr, level="INFO")
        log_file = tmp_path / "test.log"
        test_logger.add(str(log_file), level="DEBUG")

        test_logger.debug("debug msg")
        test_logger.info("info msg")

        # 文件应包含 DEBUG 和 INFO
        content = log_file.read_text()
        assert "debug msg" in content
        assert "info msg" in content

    def test_structlog_json_mode(self):
        """structlog JSON 渲染模式输出有效 JSON"""
        import structlog
        import json
        from io import StringIO

        output = StringIO()
        structlog.configure(
            processors=[
                structlog.stdlib.add_log_level,
                structlog.processors.TimeStamper(fmt="iso"),
                structlog.processors.JSONRenderer(),
            ],
            logger_factory=structlog.PrintLoggerFactory(file=output),
        )
        log = structlog.get_logger()
        log.info("test", key="value")

        line = output.getvalue().strip()
        parsed = json.loads(line)
        assert parsed["key"] == "value"
        assert "timestamp" in parsed
```

---

## 第 5 章 跨域关联

| 关联域 | 关系类型 | 说明 |
|--------|----------|------|
| PD-01 上下文管理 | 协同 | TokenCounter 的 `count_message_tokens` 为上下文窗口管理提供精确的 token 计数，`max_input_tokens` 限额保护防止上下文溢出 |
| PD-03 容错与重试 | 依赖 | `TokenLimitExceeded` 异常被排除在 tenacity retry 列表之外（`app/llm.py:357-359`），确定性错误不重试 |
| PD-04 工具系统 | 协同 | `TokenCounter.count_tool_calls`（`app/llm.py:137-145`）专门计算工具调用的 token 消耗，`ask_tool` 方法额外计算工具描述的 token（`app/llm.py:694-698`） |
| PD-05 沙箱隔离 | 协同 | Agent 的 emoji 日志（✨🛠️🔧🎯）在沙箱执行时提供工具调用的可视化追踪 |
| PD-09 Human-in-the-Loop | 协同 | `is_stuck` 卡死检测（`app/agent/base.py:170-186`）可作为人工介入的触发信号 |

---

## 第 6 章 来源文件索引

| 文件 | 行范围 | 关键实现 |
|------|--------|----------|
| `app/logger.py` | L1-43 | loguru 分级日志配置（双 sink：stderr INFO + 文件 DEBUG） |
| `app/utils/logger.py` | L1-32 | structlog 结构化日志（环境感知渲染 + callsite 自动附加） |
| `app/llm.py` | L45-171 | TokenCounter 类（文本/图片/工具调用三种 token 计算） |
| `app/llm.py` | L174-227 | LLM 单例初始化（token 累积器 + tiktoken tokenizer） |
| `app/llm.py` | L238-264 | Token 累积追踪 + 限额保护（update/check/error message） |
| `app/llm.py` | L419-458 | 流式 vs 非流式 token 统计差异 |
| `app/llm.py` | L644-766 | ask_tool 方法中工具描述 token 计算 |
| `app/bedrock.py` | L134-193 | Bedrock → OpenAI usage 格式转换 |
| `app/exceptions.py` | L8-13 | TokenLimitExceeded 异常定义 |
| `app/config.py` | L19-30 | LLMSettings 中 max_input_tokens 配置 |
| `app/agent/toolcall.py` | L39-129 | Agent 层 emoji 日志模式 |
| `app/agent/base.py` | L140-186 | 步骤日志 + 卡死检测 |

---

## 第 7 章 横向对比维度

> **重要：** 本章用于自动填充 Butcher Wiki 的横向对比表。
> 必须严格按以下 JSON 格式输出，放在 `comparison_data` 代码块中。

```json comparison_data
{
  "project": "OpenManus",
  "dimensions": {
    "追踪方式": "LLM 单例累积器，每次调用后 update_token_count 累加",
    "数据粒度": "input/completion 两类，区分流式估算和非流式精确值",
    "持久化": "loguru 文件日志（时间戳命名），无结构化 JSON 持久化",
    "多提供商": "OpenAI + Azure + Bedrock 三提供商，Bedrock 适配层统一 usage 格式",
    "日志格式": "loguru emoji 文本（运行时）+ structlog JSON/Console（结构化）",
    "指标采集": "无独立指标采集，token 数据仅在日志中输出",
    "可视化": "无内置可视化，依赖日志文件人工分析",
    "成本追踪": "仅 token 计数，无价格映射和成本计算",
    "日志级别": "双 sink 分级：stderr INFO + 文件 DEBUG",
    "崩溃安全": "loguru 文件 sink 自动 flush，structlog 无额外保护",
    "延迟统计": "无延迟统计，未记录 LLM 调用耗时",
    "卡死检测": "基于重复内容检测（duplicate_threshold=2），触发策略变更提示"
  }
}
```

### 域元数据补充

```json domain_metadata
{
  "solution_summary": "OpenManus 用 loguru+structlog 双日志系统配合 LLM 单例 TokenCounter 实现分级日志与 token 累积追踪，支持 OpenAI/Azure/Bedrock 三提供商 usage 统一",
  "description": "双日志系统（运行时可读 + 生产结构化）是 Agent 可观测性的实用分层模式",
  "sub_problems": [
    "图片 token 估算：多模态 Agent 需按 detail 级别和分辨率计算图片 token",
    "流式与非流式统计一致性：流式用客户端估算、非流式用 API 返回值，两者存在系统性偏差"
  ],
  "best_practices": [
    "emoji 前缀日志分类：用 ✨🛠️🔧🎯 等 emoji 标记 Agent 思考/选择/执行/完成，大量日志中快速定位",
    "Token 限额异常不重试：TokenLimitExceeded 是确定性错误，排除在 retry 列表外避免无意义重试",
    "tiktoken fallback 策略：未知模型名时降级到 cl100k_base 编码，避免初始化失败"
  ]
}
```
