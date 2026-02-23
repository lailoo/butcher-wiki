# PD-03.05 DeepTutor — 四层容错：异常层级 × 熔断器 × Pydantic 验证 × 多语言 Fallback

> 文档编号：PD-03.05
> 来源：DeepTutor `src/agents/solve/utils/error_handler.py`, `src/services/llm/providers/base_provider.py`, `src/utils/network/circuit_breaker.py`
> GitHub：https://github.com/HKUDS/DeepTutor.git
> 问题域：PD-03 容错与重试 Fault Tolerance & Retry
> 状态：可复用方案

---

## 第 1 章 问题与动机

### 1.1 核心问题

LLM 驱动的 Agent 系统面临多层次的失败模式：网络层（超时、连接断开）、API 层（速率限制、认证失败）、输出层（JSON 解析失败、字段缺失、工具名幻觉）、配置层（YAML 格式错误、必填项缺失）。这些失败如果不分层处理，会导致级联崩溃——一个 Agent 的 LLM 调用超时可能拖垮整个研究流水线。

DeepTutor 作为一个学术论文深度辅导系统，其双循环架构（Analysis Loop + Solve Loop）中有 7 个专职 Agent，每个都依赖 LLM 调用。任何一个环节的失败都需要被精确分类、合理重试、优雅降级。

### 1.2 DeepTutor 的解法概述

1. **统一异常层级体系**：以 `LLMError` 为根，派生出 `LLMAPIError → LLMTimeoutError / LLMRateLimitError / LLMAuthenticationError`，以及独立的 `LLMParseError` 和 `LLMConfigError`，每个异常携带 `provider`、`status_code`、`details` 等结构化上下文 (`src/services/llm/exceptions.py:14-153`)
2. **双层重试机制**：Factory 层用 tenacity 做 LLM 调用重试（指数退避，最大 5 次），Provider 层用手写循环做底层 HTTP 重试（1.5^n + 随机抖动），两层独立运作 (`src/services/llm/factory.py:197-209`, `src/services/llm/providers/base_provider.py:57-94`)
3. **熔断器 + 错误率追踪**：`CircuitBreaker` 实现三态（closed/open/half-open）熔断，`ErrorRateTracker` 用滑动窗口追踪每个 provider 的错误率，超阈值自动触发熔断 (`src/utils/network/circuit_breaker.py:13-64`, `src/utils/error_rate_tracker.py:14-81`)
4. **Pydantic 模型验证 LLM 输出**：为每个 Agent 定义严格的 Pydantic 模型（`InvestigateOutput`、`SolveOutput`、`NoteOutput` 等），验证失败抛出 `LLMParseError` 触发重试 (`src/agents/solve/utils/error_handler.py:26-63`)
5. **多语言 Prompt Fallback 链**：`PromptManager` 实现 `zh → cn → en` 的语言降级链，任何一级加载失败自动尝试下一级 (`src/services/prompt/manager.py:23-98`)

### 1.3 设计思想

| 设计原则 | 具体实现 | 理由 | 替代方案 |
|----------|----------|------|----------|
| 异常分类优先于统一捕获 | 11 个异常类的层级体系 | 不同错误需要不同的重试策略（429 可重试，401 不可） | 单一 Exception + error_code 字段 |
| 双层重试解耦 | Factory 层 tenacity + Provider 层手写循环 | Factory 关注业务语义，Provider 关注 HTTP 传输 | 单层重试 |
| 熔断保护预算 | CircuitBreaker 三态机 + 60s 恢复窗口 | 持续失败时快速失败，避免无意义的 API 调用消耗预算 | 简单计数器 + 阈值 |
| 结构化输出验证 | Pydantic BaseModel + field_validator | 编译时类型安全 + 运行时验证，比手写 if-else 更可靠 | JSON Schema 验证 |
| 配置预验证 | ConfigValidator 启动时检查 | 将配置错误前移到启动阶段，避免运行时崩溃 | 延迟验证（用到时才检查） |

---

## 第 2 章 源码实现分析

### 2.1 架构概览

DeepTutor 的容错体系分为四层，从外到内依次是：

```
┌─────────────────────────────────────────────────────────┐
│  Layer 4: 配置预验证 (ConfigValidator)                    │
│  ─ 启动时校验 YAML 配置完整性                              │
├─────────────────────────────────────────────────────────┤
│  Layer 3: LLM 输出验证 (Pydantic Models + error_handler) │
│  ─ 验证 LLM 返回的 JSON 结构、字段类型、工具名合法性         │
│  ─ 验证失败 → LLMParseError → tenacity 重试               │
├─────────────────────────────────────────────────────────┤
│  Layer 2: Factory 重试 (tenacity @retry)                 │
│  ─ 指数退避，最大 5 次，区分可重试/不可重试错误              │
│  ─ 路由到 CloudProvider 或 LocalProvider                  │
├─────────────────────────────────────────────────────────┤
│  Layer 1: Provider 重试 + 熔断 (execute_with_retry)       │
│  ─ 1.5^n + random(0.5) 退避                              │
│  ─ CircuitBreaker 三态保护                                │
│  ─ ErrorRateTracker 滑动窗口监控                          │
│  ─ TrafficController 并发限流                             │
└─────────────────────────────────────────────────────────┘
```

### 2.2 核心实现

#### 2.2.1 统一异常层级 (`src/services/llm/exceptions.py:14-153`)

异常树的根是 `LLMError`，携带 `message`、`details`、`provider` 三个结构化字段：

```python
# src/services/llm/exceptions.py:14-29
class LLMError(Exception):
    """Base exception for all LLM-related errors."""
    def __init__(
        self, message: str, details: Optional[Dict[str, Any]] = None, provider: Optional[str] = None
    ):
        super().__init__(message)
        self.message = message
        self.details = details or {}
        self.provider = provider

    def __str__(self) -> str:
        provider_prefix = f"[{self.provider}] " if self.provider else ""
        if self.details:
            return f"{provider_prefix}{self.message} (details: {self.details})"
        return f"{provider_prefix}{self.message}"
```

关键派生类及其语义：
- `LLMAPIError(status_code)` — 通用 API 错误，携带 HTTP 状态码 (`exceptions.py:44-67`)
- `LLMTimeoutError(timeout)` — 超时，默认 status_code=408 (`exceptions.py:70-80`)
- `LLMRateLimitError(retry_after)` — 速率限制，携带建议等待时间 (`exceptions.py:83-93`)
- `LLMAuthenticationError` — 认证失败，status_code=401，**不可重试** (`exceptions.py:96-104`)
- `LLMParseError` — LLM 输出解析失败，独立于 API 错误 (`exceptions.py:120-129`)
- `ProviderContextWindowError` — 上下文窗口超限 (`exceptions.py:137-138`)

#### 2.2.2 错误映射规则引擎 (`src/services/llm/error_mapping.py:36-104`)

`error_mapping.py` 使用规则链模式将各 SDK 的原生异常映射到统一异常：

```python
# src/services/llm/error_mapping.py:54-63
_GLOBAL_RULES: List[MappingRule] = [
    MappingRule(
        classifier=_message_contains("rate limit", "429", "quota"),
        factory=lambda exc, provider: LLMRateLimitError(str(exc), provider=provider),
    ),
    MappingRule(
        classifier=_message_contains("context length", "maximum context"),
        factory=lambda exc, provider: ProviderContextWindowError(str(exc), provider=provider),
    ),
]
```

支持 OpenAI、Anthropic SDK 的原生异常类型匹配（`_instance_of`）和消息文本匹配（`_message_contains`），并在规则链之前做 status_code 快速路径判断 (`error_mapping.py:91-104`)。

#### 2.2.3 Factory 层 tenacity 重试 (`src/services/llm/factory.py:197-240`)

Factory 的 `complete()` 函数内部定义了一个 tenacity 装饰的 `_do_complete()`，精确控制哪些异常可重试：

```python
# src/services/llm/factory.py:197-222
@tenacity.retry(
    retry=(
        tenacity.retry_if_exception_type(LLMRateLimitError)
        | tenacity.retry_if_exception_type(LLMTimeoutError)
        | tenacity.retry_if_exception(_is_retriable_llm_api_error)
    ),
    wait=tenacity.wait_exponential(multiplier=retry_delay, min=retry_delay, max=120),
    stop=tenacity.stop_after_attempt(total_attempts),
    before_sleep=lambda retry_state: logger.warning(
        f"LLM call failed (attempt {retry_state.attempt_number}/{total_attempts}), "
        f"retrying in {retry_state.upcoming_sleep:.1f}s..."
    ),
)
async def _do_complete(**call_kwargs):
    try:
        if use_local:
            return await local_provider.complete(**call_kwargs)
        else:
            return await cloud_provider.complete(**call_kwargs)
    except Exception as e:
        from .error_mapping import map_error
        mapped_error = map_error(e, provider=call_kwargs.get("binding", "unknown"))
        raise mapped_error from e
```

可重试判断逻辑 (`factory.py:166-191`)：只重试 429 和 5xx，所有其他 4xx（400/401/403/404）都不重试。

#### 2.2.4 Provider 层重试 + 熔断 (`src/services/llm/providers/base_provider.py:57-94`)

Provider 层的 `execute_with_retry` 在 Factory 之下运行，增加了熔断器检查和流量控制：

```python
# src/services/llm/providers/base_provider.py:57-94
async def execute_with_retry(self, func, *args, max_retries=3, **kwargs):
    if not is_call_allowed(self.provider_name):
        record_provider_call(self.provider_name, success=False)
        raise LLMError(f"Circuit breaker open for provider {self.provider_name}")

    for attempt in range(max_retries + 1):
        try:
            async with self.traffic_controller:
                result = await func(*args, **kwargs)
                record_provider_call(self.provider_name, success=True)
                record_call_success(self.provider_name)
                return result
        except Exception as e:
            mapped_e = self._map_exception(e)
            is_retriable = isinstance(mapped_e, (LLMRateLimitError, LLMTimeoutError))
            if isinstance(mapped_e, LLMAPIError):
                if getattr(mapped_e, "status_code", None) and mapped_e.status_code >= 500:
                    is_retriable = True
            if attempt >= max_retries or not is_retriable:
                record_provider_call(self.provider_name, success=False)
                raise mapped_e from e
            delay = (1.5 ** attempt) + (random.random() * 0.5)
            await asyncio.sleep(delay)
```

退避策略：`1.5^attempt + random(0, 0.5)`，比 Factory 层的纯指数退避更保守，适合底层 HTTP 重试。

#### 2.2.5 熔断器三态机 (`src/utils/network/circuit_breaker.py:13-64`)

经典的 Circuit Breaker 模式，线程安全：

```
closed ──(连续 5 次失败)──→ open ──(60s 后)──→ half-open ──(成功)──→ closed
                                                    │
                                                    └──(失败)──→ open
```

`ErrorRateTracker` (`src/utils/error_rate_tracker.py:14-81`) 用 60 秒滑动窗口追踪错误率，超过 50% 阈值时通过 `alert_callback` 触发熔断器的 `record_failure`。两个组件通过回调函数解耦 (`error_rate_tracker.py:84-91`)。

#### 2.2.6 Pydantic 输出验证 (`src/agents/solve/utils/error_handler.py:26-63`)

每个 Agent 的 LLM 输出都有对应的 Pydantic 模型，以 `InvestigateOutput` 为例：

```python
# src/agents/solve/utils/error_handler.py:26-63
class ToolIntent(BaseModel):
    tool_type: str = Field(..., description="Type of tool to use")
    query: str = Field("", description="Query for the tool")
    identifier: Optional[str] = Field(None, description="Optional identifier")

    @field_validator("tool_type")
    @classmethod
    def validate_tool_type(cls, v):
        if v.lower() not in VALID_INVESTIGATE_TOOLS:
            raise ValueError(f"tool_type must be one of {VALID_INVESTIGATE_TOOLS}, got: {v}")
        return v.lower()

class InvestigateOutput(BaseModel):
    reasoning: str = Field(..., description="Reasoning for the investigation")
    tools: list[ToolIntent] = Field(..., min_length=1, description="List of tool intents")

    @field_validator("tools")
    @classmethod
    def validate_tools_consistency(cls, v):
        has_none = any(tool.tool_type == "none" for tool in v)
        if has_none and len(v) > 1:
            raise ValueError("When 'none' tool exists, no other tool intents should be provided")
        return v
```

验证函数将 Pydantic `ValidationError` 转换为 `LLMParseError` (`error_handler.py:238-273`)，配合 `retry_on_parse_error` 装饰器实现解析失败自动重试 (`error_handler.py:141-171`)。

### 2.3 实现细节

#### 数据流：一次 LLM 调用的完整容错路径

```
BaseAgent.call_llm()
  → get_max_retries() 从 settings.retry 读取配置
  → factory.complete(max_retries=5)
      → tenacity @retry 装饰器包裹
          → _do_complete()
              → CloudProvider.complete()
                  → execute_with_retry(max_retries=3)
                      → is_call_allowed() 检查熔断器
                      → traffic_controller 限流
                      → 实际 HTTP 调用
                      → record_provider_call() 记录成功/失败
                      → 失败时 map_error() 映射异常
                      → 1.5^n + random 退避
              → 异常冒泡到 Factory
              → map_error() 再次映射
          → tenacity 判断是否可重试
          → wait_exponential(min=2, max=120) 退避
  → 返回 response
  → validate_investigate_output(response) Pydantic 验证
  → 验证失败 → LLMParseError → retry_on_parse_error 重试
```

#### 重试配置的三级优先级

`BaseAgent.get_max_retries()` (`src/agents/base_agent.py:205-212`) 实现了配置优先级链：

```python
# src/agents/base_agent.py:205-212
def get_max_retries(self) -> int:
    return self.agent_config.get("max_retries", settings.retry.max_retries)
```

优先级：Agent 级配置 > 全局 `settings.retry.max_retries`（默认 3）> 环境变量 `LLM_RETRY__MAX_RETRIES`。

#### 流式响应的特殊重试处理

`factory.stream()` (`src/services/llm/factory.py:243-357`) 不使用 tenacity（因为 async generator 不兼容），而是手写循环 + `retry_after` 感知：

```python
# src/services/llm/factory.py:342-344
if isinstance(e, LLMRateLimitError) and e.retry_after:
    current_delay = max(current_delay, e.retry_after)
```

#### 多语言 Prompt Fallback (`src/services/prompt/manager.py:23-98`)

`PromptManager` 的 fallback 链确保 prompt 加载不会因为缺少某语言版本而失败：

```python
# src/services/prompt/manager.py:23-26
LANGUAGE_FALLBACKS = {
    "zh": ["zh", "cn", "en"],
    "en": ["en", "zh", "cn"],
}
```

加载时依次尝试 fallback 链中的每个语言目录，任何一级的 YAML 解析失败都会 `continue` 到下一级 (`manager.py:87-95`)。

---

## 第 3 章 迁移指南

### 3.1 迁移清单

**阶段 1：异常体系（1 个文件）**
- [ ] 创建 `exceptions.py`，定义 `LLMError` 基类及 5-6 个派生类
- [ ] 每个异常携带 `provider`、`status_code`、`details` 结构化字段
- [ ] 创建 `error_mapping.py`，实现规则链将 SDK 异常映射到统一异常

**阶段 2：重试机制（2 个文件）**
- [ ] 在 LLM 调用入口添加 tenacity 重试装饰器
- [ ] 实现 `_is_retriable_error()` 函数，区分可重试/不可重试错误
- [ ] 配置指数退避参数（multiplier、min、max）

**阶段 3：熔断器（2 个文件）**
- [ ] 实现 `CircuitBreaker` 三态机（closed/open/half-open）
- [ ] 实现 `ErrorRateTracker` 滑动窗口错误率追踪
- [ ] 通过回调函数连接两者

**阶段 4：输出验证（1 个文件）**
- [ ] 为每个 Agent 的 LLM 输出定义 Pydantic 模型
- [ ] 实现 `retry_on_parse_error` 装饰器
- [ ] 在 Agent 的 process() 方法中调用验证函数

### 3.2 适配代码模板

#### 最小可用的异常体系 + 重试

```python
"""minimal_fault_tolerance.py — 可直接复用的容错模板"""
from typing import Any, Dict, Optional
from pydantic import BaseModel, Field, ValidationError, field_validator
import tenacity
import asyncio
import random
import logging

logger = logging.getLogger(__name__)

# ── 1. 异常层级 ──
class LLMError(Exception):
    def __init__(self, message: str, provider: Optional[str] = None):
        super().__init__(message)
        self.provider = provider

class LLMAPIError(LLMError):
    def __init__(self, message: str, status_code: Optional[int] = None, **kw):
        super().__init__(message, **kw)
        self.status_code = status_code

class LLMRateLimitError(LLMAPIError):
    def __init__(self, message="Rate limited", retry_after: Optional[float] = None, **kw):
        super().__init__(message, status_code=429, **kw)
        self.retry_after = retry_after

class LLMTimeoutError(LLMAPIError):
    def __init__(self, message="Timeout", **kw):
        super().__init__(message, status_code=408, **kw)

class LLMParseError(LLMError):
    pass

# ── 2. 熔断器 ──
class CircuitBreaker:
    def __init__(self, threshold: int = 5, recovery_sec: int = 60):
        self._failures: Dict[str, int] = {}
        self._last_fail: Dict[str, float] = {}
        self._state: Dict[str, str] = {}
        self.threshold = threshold
        self.recovery_sec = recovery_sec

    def allow(self, provider: str) -> bool:
        import time
        state = self._state.get(provider, "closed")
        if state == "closed":
            return True
        if state == "open":
            if time.time() - self._last_fail.get(provider, 0) > self.recovery_sec:
                self._state[provider] = "half-open"
                return True
            return False
        return True  # half-open

    def record(self, provider: str, success: bool):
        import time
        if success:
            self._state[provider] = "closed"
            self._failures[provider] = 0
        else:
            self._failures[provider] = self._failures.get(provider, 0) + 1
            self._last_fail[provider] = time.time()
            if self._failures[provider] >= self.threshold:
                self._state[provider] = "open"

breaker = CircuitBreaker()

# ── 3. 重试装饰器 ──
def llm_retry(max_retries: int = 5, base_delay: float = 2.0):
    return tenacity.retry(
        retry=(
            tenacity.retry_if_exception_type(LLMRateLimitError)
            | tenacity.retry_if_exception_type(LLMTimeoutError)
        ),
        wait=tenacity.wait_exponential(multiplier=base_delay, min=base_delay, max=120),
        stop=tenacity.stop_after_attempt(max_retries + 1),
        before_sleep=lambda rs: logger.warning(
            f"Retry {rs.attempt_number}/{max_retries+1}, "
            f"wait {rs.upcoming_sleep:.1f}s: {rs.outcome.exception()}"
        ),
    )

# ── 4. Pydantic 输出验证 ──
class AgentOutput(BaseModel):
    reasoning: str = Field(...)
    tool_type: str = Field(...)

    @field_validator("tool_type")
    @classmethod
    def check_tool(cls, v):
        valid = ["search", "code", "rag", "none"]
        if v.lower() not in valid:
            raise ValueError(f"Invalid tool: {v}, must be one of {valid}")
        return v.lower()

def validate_and_retry(raw: dict, model_cls: type[BaseModel]) -> BaseModel:
    """验证 LLM 输出，失败抛出 LLMParseError"""
    try:
        return model_cls(**raw)
    except ValidationError as e:
        raise LLMParseError(f"Validation failed: {e}") from e
```

### 3.3 适用场景

| 场景 | 适用度 | 说明 |
|------|--------|------|
| 多 Provider LLM 系统 | ⭐⭐⭐ | 熔断器 + 错误率追踪对多 provider 切换场景价值最大 |
| 单 Provider 简单 Agent | ⭐⭐ | 异常层级 + tenacity 重试即可，熔断器可省略 |
| 高并发 API 服务 | ⭐⭐⭐ | TrafficController + CircuitBreaker 防止雪崩 |
| 结构化输出 Agent | ⭐⭐⭐ | Pydantic 验证 + parse error 重试是核心需求 |
| 批处理/离线任务 | ⭐ | 重试即可，熔断器意义不大 |

---

## 第 4 章 测试用例

```python
"""test_deeptutor_fault_tolerance.py"""
import asyncio
import time
import pytest
from unittest.mock import AsyncMock, patch
from pydantic import ValidationError

# ── 异常层级测试 ──
class TestExceptionHierarchy:
    def test_llm_error_with_provider(self):
        from src.services.llm.exceptions import LLMError
        e = LLMError("test", provider="openai")
        assert str(e) == "[openai] test"
        assert e.provider == "openai"

    def test_rate_limit_inherits_api_error(self):
        from src.services.llm.exceptions import LLMRateLimitError, LLMAPIError
        e = LLMRateLimitError(retry_after=30.0, provider="anthropic")
        assert isinstance(e, LLMAPIError)
        assert e.status_code == 429
        assert e.retry_after == 30.0

    def test_parse_error_independent_of_api(self):
        from src.services.llm.exceptions import LLMParseError, LLMAPIError
        e = LLMParseError("bad json")
        assert not isinstance(e, LLMAPIError)

# ── 熔断器测试 ──
class TestCircuitBreaker:
    def test_opens_after_threshold(self):
        from src.utils.network.circuit_breaker import CircuitBreaker
        cb = CircuitBreaker(failure_threshold=3, recovery_timeout=1)
        for _ in range(3):
            cb.record_failure("test-provider")
        assert cb.call("test-provider") is False  # open

    def test_half_open_after_recovery(self):
        from src.utils.network.circuit_breaker import CircuitBreaker
        cb = CircuitBreaker(failure_threshold=2, recovery_timeout=0.1)
        cb.record_failure("p")
        cb.record_failure("p")
        assert cb.call("p") is False
        time.sleep(0.15)
        assert cb.call("p") is True  # half-open
        cb.record_success("p")
        assert cb.state.get("p") == "closed"

    def test_closed_resets_on_success(self):
        from src.utils.network.circuit_breaker import CircuitBreaker
        cb = CircuitBreaker(failure_threshold=5)
        cb.record_failure("p")
        cb.record_failure("p")
        cb.record_success("p")
        assert cb.failure_count["p"] == 0

# ── Pydantic 验证测试 ──
class TestOutputValidation:
    def test_valid_investigate_output(self):
        from src.agents.solve.utils.error_handler import validate_investigate_output
        output = {
            "reasoning": "Need to search for papers",
            "tools": [{"tool_type": "web_search", "query": "transformer attention"}]
        }
        assert validate_investigate_output(output) is True

    def test_invalid_tool_type_raises_parse_error(self):
        from src.agents.solve.utils.error_handler import validate_investigate_output
        from src.services.llm.exceptions import LLMParseError
        output = {
            "reasoning": "test",
            "tools": [{"tool_type": "hallucinated_tool", "query": "test"}]
        }
        with pytest.raises(LLMParseError):
            validate_investigate_output(output)

    def test_none_tool_exclusivity(self):
        from src.agents.solve.utils.error_handler import validate_investigate_output
        from src.services.llm.exceptions import LLMParseError
        output = {
            "reasoning": "done",
            "tools": [
                {"tool_type": "none", "query": ""},
                {"tool_type": "web_search", "query": "extra"}
            ]
        }
        with pytest.raises(LLMParseError):
            validate_investigate_output(output)

# ── 错误率追踪测试 ──
class TestErrorRateTracker:
    def test_sliding_window(self):
        from src.utils.error_rate_tracker import ErrorRateTracker
        tracker = ErrorRateTracker(window_size=1, threshold=0.5)
        tracker.record_call("p", success=True)
        tracker.record_call("p", success=False)
        assert 0.4 < tracker.get_error_rate("p") < 0.6
        time.sleep(1.1)
        assert tracker.get_error_rate("p") == 0.0  # window expired

# ── 重试装饰器测试 ──
class TestRetryOnParseError:
    def test_retries_on_parse_error(self):
        from src.agents.solve.utils.error_handler import retry_on_parse_error
        from src.services.llm.exceptions import LLMParseError
        call_count = 0

        @retry_on_parse_error(max_retries=2, delay=0.01)
        def flaky_parser():
            nonlocal call_count
            call_count += 1
            if call_count < 3:
                raise LLMParseError("bad output")
            return {"result": "ok"}

        result = flaky_parser()
        assert result == {"result": "ok"}
        assert call_count == 3
```

---

## 第 5 章 跨域关联

| 关联域 | 关系类型 | 说明 |
|--------|----------|------|
| PD-01 上下文管理 | 协同 | `ProviderContextWindowError` 异常检测上下文超限，触发截断/压缩策略 |
| PD-04 工具系统 | 依赖 | `ToolIntent.validate_tool_type()` 验证 LLM 输出的工具名是否在 `VALID_INVESTIGATE_TOOLS` 白名单中，防止工具幻觉 |
| PD-11 可观测性 | 协同 | `ErrorRateTracker` 的滑动窗口数据可直接接入监控面板；`BaseAgent._track_tokens()` 在每次 LLM 调用后记录 token 用量 |
| PD-02 多 Agent 编排 | 协同 | 双循环架构中 7 个 Agent 共享同一套容错体系，每个 Agent 通过 `BaseAgent.get_max_retries()` 获取独立的重试配置 |

---

## 第 6 章 来源文件索引

| 文件 | 行范围 | 关键实现 |
|------|--------|----------|
| `src/services/llm/exceptions.py` | L14-L153 | 11 个异常类的完整层级体系 |
| `src/services/llm/error_mapping.py` | L36-L104 | 规则链异常映射引擎 |
| `src/services/llm/factory.py` | L60-L240 | Factory 层 tenacity 重试 + 可重试判断 |
| `src/services/llm/providers/base_provider.py` | L26-L94 | Provider 层重试 + 熔断器集成 |
| `src/utils/network/circuit_breaker.py` | L13-L80 | 三态熔断器实现 |
| `src/utils/error_rate_tracker.py` | L14-L112 | 滑动窗口错误率追踪 + 告警回调 |
| `src/agents/solve/utils/error_handler.py` | L26-L364 | Pydantic 输出模型 + 验证函数 + 重试装饰器 |
| `src/agents/base_agent.py` | L205-L212 | 重试配置优先级链 |
| `src/config/settings.py` | L19-L51 | pydantic-settings 重试配置 |
| `src/services/prompt/manager.py` | L23-L98 | 多语言 Prompt Fallback 链 |
| `src/agents/solve/utils/config_validator.py` | L14-L264 | 启动时配置预验证 |

---

## 第 7 章 横向对比维度

```json comparison_data
{
  "project": "DeepTutor",
  "dimensions": {
    "截断/错误检测": "ProviderContextWindowError 检测上下文超限；Pydantic field_validator 检测工具名幻觉",
    "重试/恢复策略": "双层重试：Factory tenacity 指数退避(max=120s) + Provider 1.5^n+random 退避",
    "超时保护": "LLMTimeoutError(408) + embedding request_timeout=30s 配置",
    "优雅降级": "多语言 Prompt fallback 链(zh→cn→en)；safe_parse 返回默认值",
    "重试策略": "tenacity 指数退避，Factory 层 max=5 次，Provider 层 max=3 次",
    "降级方案": "熔断器 open 时快速失败；safe_parse 返回 default 值继续执行",
    "错误分类": "11 个异常类层级 + 规则链映射引擎，区分可重试/不可重试",
    "恢复机制": "CircuitBreaker 三态机：closed→open→half-open→closed，60s 恢复窗口",
    "监控告警": "ErrorRateTracker 60s 滑动窗口，50% 阈值触发 alert_callback",
    "输出验证": "Pydantic BaseModel 验证 LLM 输出结构，ValidationError→LLMParseError→重试",
    "配置预验证": "ConfigValidator 启动时校验 YAML 完整性，区分 error/warning 两级"
  }
}
```

### 域元数据补充

```json domain_metadata
{
  "description": "多 Provider 场景下的熔断保护与错误率监控，防止持续失败耗尽预算",
  "sub_problems": [
    "多 Provider 雪崩：一个 provider 持续失败拖慢整个系统",
    "LLM 输出结构验证：JSON 字段类型/枚举值不符合 Agent 预期",
    "配置错误前移：YAML 配置缺失或类型错误在运行时才暴露"
  ],
  "best_practices": [
    "熔断器三态保护：连续失败时快速失败，定时探测恢复",
    "滑动窗口错误率追踪：比简单计数器更准确反映实时健康状态",
    "Pydantic 模型验证 LLM 输出：编译时类型安全 + 运行时结构验证",
    "双层重试解耦：业务层和传输层各自独立重试，职责清晰"
  ]
}
```
