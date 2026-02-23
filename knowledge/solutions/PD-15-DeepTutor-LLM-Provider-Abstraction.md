# PD-15.01 DeepTutor — LLM Provider 抽象层

> 文档编号：PD-15.01
> 来源：DeepTutor `src/services/llm/`, `src/services/embedding/`
> GitHub：https://github.com/HKUDS/DeepTutor
> 问题域：PD-15 LLM Provider 抽象层 LLM Provider Abstraction
> 状态：可复用方案

---

## 第 1 章 问题与动机

### 1.1 核心问题

Agent 应用需要调用多种 LLM 提供商（OpenAI、Anthropic、DeepSeek、本地 Ollama 等），每家 API 的认证方式、请求格式、响应结构、错误码、能力集合都不同。如果业务代码直接耦合某一家 SDK，切换提供商或同时支持多家就需要大量改动。

核心挑战：
1. **API 差异**：OpenAI 用 `Authorization: Bearer`，Anthropic 用 `x-api-key`，Azure 用 `api-key` header + `api-version` query param
2. **能力差异**：Anthropic 不支持 `response_format`，Ollama 不支持 function calling，推理模型强制 temperature=1.0
3. **错误差异**：各 SDK 抛出不同异常类型，重试逻辑无法统一
4. **Cloud vs Local**：云端 API 和本地推理服务器（Ollama/LM Studio/vLLM）的 URL 检测、认证、超时策略完全不同

### 1.2 DeepTutor 的解法概述

DeepTutor 构建了一个 5 层 LLM Provider 抽象体系：

1. **Registry 装饰器注册** — `@register_provider("openai")` 自动注册 provider 类到全局字典（`src/services/llm/registry.py:15`）
2. **BaseLLMProvider 抽象基类** — 定义 `complete()` / `stream()` 统一接口 + 内置 retry + circuit breaker（`src/services/llm/providers/base_provider.py:26`）
3. **Capabilities 静态配置表** — 按 binding×model 二维查询能力（response_format、tools、streaming 等），支持 model-level override（`src/services/llm/capabilities.py:25`）
4. **Error Mapping 规则链** — MappingRule 链式匹配，将各 SDK 异常统一映射为 `LLMError` 层级（`src/services/llm/error_mapping.py:54`）
5. **Factory 路由层** — 按 URL 自动判断 cloud/local，tenacity 重试，对上层暴露 `complete()` / `stream()` 函数式 API（`src/services/llm/factory.py:116`）

Embedding 层同样采用 Adapter 模式：`BaseEmbeddingAdapter` 抽象基类 + `EmbeddingProviderManager` 工厂（`src/services/embedding/provider.py:22`），支持 OpenAI/Cohere/Jina/Ollama 四种后端。

### 1.3 设计思想

| 设计原则 | 具体实现 | 理由 | 替代方案 |
|----------|----------|------|----------|
| 装饰器注册 | `@register_provider(name)` 自动注册到 `_provider_registry` 全局字典 | 新增 provider 只需一个装饰器，零侵入 | 手动 if-else 分支、配置文件声明 |
| 能力静态配置 | `PROVIDER_CAPABILITIES` dict + `MODEL_OVERRIDES` dict，4 级 fallback 查询 | 避免运行时探测，确定性强；model override 处理特例 | 运行时 probe API、provider 自报能力 |
| 统一异常层级 | `LLMError` → `LLMAPIError` → `LLMRateLimitError` / `LLMTimeoutError` / `LLMAuthenticationError` | 重试逻辑只需 isinstance 判断，不依赖具体 SDK | 捕获所有 Exception 统一处理 |
| Cloud/Local 自动路由 | URL 黑白名单（CLOUD_DOMAINS / LOCAL_HOSTS / LOCAL_PORTS）自动判断 | 用户只需填 base_url，无需手动指定 provider 类型 | 显式配置 `is_local=True` |
| Circuit Breaker | ErrorRateTracker 滑动窗口 + CircuitBreaker 三态（closed/open/half-open） | 防止故障 provider 持续消耗资源和延迟 | 简单计数器、无熔断 |

---

## 第 2 章 源码实现分析

### 2.1 架构概览

```
┌─────────────────────────────────────────────────────────┐
│                    Agent 业务层                          │
│         (ChatAgent, GuideAgent, ResearchAgent)           │
└──────────────────────┬──────────────────────────────────┘
                       │ call_llm() / stream_llm()
                       ▼
┌─────────────────────────────────────────────────────────┐
│              LLM Factory (factory.py)                    │
│  ┌─────────────┐  ┌──────────────┐  ┌───────────────┐  │
│  │ URL 路由    │→ │ Config 加载  │→ │ tenacity 重试 │  │
│  │ cloud/local │  │ env/.config  │  │ 指数退避      │  │
│  └─────────────┘  └──────────────┘  └───────────────┘  │
└──────────┬──────────────────────────────┬───────────────┘
           │                              │
           ▼                              ▼
┌──────────────────┐          ┌──────────────────────┐
│  cloud_provider  │          │   local_provider     │
│  (OpenAI SDK)    │          │   (OpenAI SDK,       │
│                  │          │    local endpoints)   │
└────────┬─────────┘          └──────────┬───────────┘
         │                               │
         ▼                               ▼
┌──────────────────────────────────────────────────────┐
│           BaseLLMProvider (base_provider.py)          │
│  ┌──────────┐ ┌──────────────┐ ┌──────────────────┐ │
│  │ retry    │ │ circuit      │ │ traffic          │ │
│  │ wrapper  │ │ breaker      │ │ controller       │ │
│  └──────────┘ └──────────────┘ └──────────────────┘ │
└────────┬──────────────────────────────┬──────────────┘
         │                              │
         ▼                              ▼
┌─────────────────┐          ┌──────────────────┐
│ OpenAIProvider  │          │ AnthropicProvider│
│ @register("oa") │          │ @register("ant") │
└─────────────────┘          └──────────────────┘
         │                              │
         ▼                              ▼
┌──────────────────────────────────────────────────────┐
│              Capabilities (capabilities.py)           │
│  PROVIDER_CAPABILITIES × MODEL_OVERRIDES → 4级查询   │
└──────────────────────────────────────────────────────┘
         │
         ▼
┌──────────────────────────────────────────────────────┐
│           Error Mapping (error_mapping.py)            │
│  MappingRule 链 → LLMError 统一异常层级              │
└──────────────────────────────────────────────────────┘
```

### 2.2 核心实现

#### 2.2.1 Registry 装饰器注册（`src/services/llm/registry.py:15-33`）

```python
# 全局注册表
_provider_registry: Dict[str, Type] = {}

def register_provider(name: str):
    """装饰器：将 provider 类注册到全局字典"""
    def decorator(cls):
        if name in _provider_registry:
            raise ValueError(f"Provider '{name}' is already registered")
        _provider_registry[name] = cls
        cls.__provider_name__ = name  # 在类上存储名称，支持内省
        return cls
    return decorator
```

使用方式极简——在 provider 类上加一行装饰器即可完成注册：

```python
# src/services/llm/providers/open_ai.py:13
@register_provider("openai")
class OpenAIProvider(BaseLLMProvider):
    ...

# src/services/llm/providers/anthropic.py:10
@register_provider("anthropic")
class AnthropicProvider(BaseLLMProvider):
    ...
```

查询接口：`get_provider_class(name)` / `list_providers()` / `is_provider_registered(name)`（`registry.py:36-72`）。

#### 2.2.2 BaseLLMProvider 抽象基类（`src/services/llm/providers/base_provider.py:26-94`）

```python
class BaseLLMProvider(ABC):
    def __init__(self, config):
        self.config = config
        self.provider_name = config.provider_name
        self.api_key = config.api_key
        self.base_url = getattr(config, "base_url", "")
        # 每个 provider 独立的流量控制器
        self.traffic_controller = getattr(config, "traffic_controller", None)
        if self.traffic_controller is None:
            from ..traffic_control import TrafficController
            self.traffic_controller = TrafficController(provider_name=self.provider_name)

    @abstractmethod
    async def complete(self, prompt: str, **kwargs) -> TutorResponse: ...

    @abstractmethod
    async def stream(self, prompt: str, **kwargs) -> AsyncStreamGenerator: ...

    async def execute_with_retry(self, func, *args, max_retries=3, **kwargs):
        """标准重试：circuit breaker 检查 → traffic controller 限流 → 指数退避"""
        if not is_call_allowed(self.provider_name):
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
                if isinstance(mapped_e, LLMAPIError) and getattr(mapped_e, "status_code", None) and mapped_e.status_code >= 500:
                    is_retriable = True
                if attempt >= max_retries or not is_retriable:
                    record_provider_call(self.provider_name, success=False)
                    raise mapped_e from e
                delay = (1.5 ** attempt) + (random.random() * 0.5)  # 抖动退避
                await asyncio.sleep(delay)
```

关键设计点：
- **每个 provider 实例独立的 TrafficController**（`base_provider.py:36-40`），避免跨 provider 限流干扰
- **Circuit Breaker 前置检查**（`base_provider.py:59`），熔断状态直接拒绝，不浪费重试
- **退避公式 `1.5^attempt + random(0, 0.5)`**（`base_provider.py:85`），比标准 2^n 更温和，加随机抖动防止惊群

#### 2.2.3 Capabilities 能力检测（`src/services/llm/capabilities.py:25-177`）

4 级 fallback 查询链：

```python
def get_capability(binding, capability, model=None, default=None):
    # 1. Model-specific overrides（最高优先级）
    #    按 pattern 长度降序匹配，最具体的优先
    if model:
        model_lower = model.lower()
        for pattern, overrides in sorted(MODEL_OVERRIDES.items(), key=lambda x: -len(x[0])):
            if model_lower.startswith(pattern):
                if capability in overrides:
                    return overrides[capability]
    # 2. Provider capabilities
    provider_caps = PROVIDER_CAPABILITIES.get(binding_lower, {})
    if capability in provider_caps:
        return provider_caps[capability]
    # 3. Default capabilities（假设 OpenAI 兼容）
    if capability in DEFAULT_CAPABILITIES:
        return DEFAULT_CAPABILITIES[capability]
    # 4. 显式 default
    return default
```

已覆盖的能力维度（`capabilities.py:27-123`）：
- `supports_response_format` — JSON mode 支持
- `supports_streaming` — 流式响应
- `supports_tools` — function calling / tool use
- `system_in_messages` — system prompt 放 messages 数组（OpenAI）还是独立参数（Anthropic）
- `has_thinking_tags` — 是否输出 `<think>` 标签（DeepSeek/Qwen）
- `forced_temperature` — 推理模型强制 temperature（o1/o3/gpt-5 = 1.0）
- `requires_api_version` — Azure OpenAI 需要 api-version 参数

便捷函数：`supports_response_format()`, `supports_tools()`, `has_thinking_tags()`, `get_effective_temperature()` 等（`capabilities.py:228-337`）。

#### 2.2.4 Error Mapping 规则链（`src/services/llm/error_mapping.py:36-104`）

```python
@dataclass(frozen=True)
class MappingRule:
    classifier: ErrorClassifier    # Callable[[Exception], bool]
    factory: Callable[[Exception, Optional[str]], LLMError]

# 规则链：按顺序匹配，第一个命中的规则生效
_GLOBAL_RULES: List[MappingRule] = [
    # SDK 类型匹配（如果 openai 库可用）
    MappingRule(classifier=_instance_of(openai.AuthenticationError),
                factory=lambda exc, p: LLMAuthenticationError(str(exc), provider=p)),
    MappingRule(classifier=_instance_of(openai.RateLimitError),
                factory=lambda exc, p: LLMRateLimitError(str(exc), provider=p)),
    # 消息内容匹配（兜底）
    MappingRule(classifier=_message_contains("rate limit", "429", "quota"),
                factory=lambda exc, p: LLMRateLimitError(str(exc), provider=p)),
    MappingRule(classifier=_message_contains("context length", "maximum context"),
                factory=lambda exc, p: ProviderContextWindowError(str(exc), provider=p)),
]

def map_error(exc, provider=None):
    # 优先检查 status_code 属性（快速路径）
    status_code = getattr(exc, "status_code", None)
    if status_code == 401: return LLMAuthenticationError(...)
    if status_code == 429: return LLMRateLimitError(...)
    # 遍历规则链
    for rule in _GLOBAL_RULES:
        if rule.classifier(exc):
            return rule.factory(exc, provider)
    # 兜底
    return LLMAPIError(str(exc), status_code=status_code, provider=provider)
```

设计亮点：
- **SDK 可选加载**（`error_mapping.py:21-27`）：`try: import openai` + `_HAS_OPENAI` 标志，SDK 不存在时规则链自动跳过
- **双重匹配策略**：先 `isinstance` 精确匹配 SDK 异常，再 `message_contains` 模糊匹配错误消息
- **status_code 快速路径**（`error_mapping.py:94-98`）：在规则链之前先检查 `status_code` 属性，避免遍历

#### 2.2.5 Factory 路由层（`src/services/llm/factory.py:103-357`）

Factory 是对上层暴露的唯一入口，提供函数式 API：

```python
# Cloud/Local 自动路由
def _should_use_local(base_url):
    return is_local_llm_server(base_url) if base_url else False

# is_local_llm_server 的判断逻辑 (utils.py:60-95):
# 1. 排除已知云域名 (CLOUD_DOMAINS: .openai.com, .anthropic.com, ...)
# 2. 匹配本地主机名 (LOCAL_HOSTS: localhost, 127.0.0.1, 0.0.0.0)
# 3. 匹配本地端口 (LOCAL_PORTS: :11434 Ollama, :1234 LM Studio, ...)
```

`complete()` 函数使用 tenacity 装饰器实现重试（`factory.py:197-209`）：

```python
@tenacity.retry(
    retry=(
        tenacity.retry_if_exception_type(LLMRateLimitError)
        | tenacity.retry_if_exception_type(LLMTimeoutError)
        | tenacity.retry_if_exception(_is_retriable_llm_api_error)
    ),
    wait=tenacity.wait_exponential(multiplier=retry_delay, min=retry_delay, max=120),
    stop=tenacity.stop_after_attempt(total_attempts),
)
async def _do_complete(**call_kwargs):
    try:
        if use_local:
            return await local_provider.complete(**call_kwargs)
        else:
            return await cloud_provider.complete(**call_kwargs)
    except Exception as e:
        mapped_error = map_error(e, provider=call_kwargs.get("binding", "unknown"))
        raise mapped_error from e
```

`stream()` 函数手动实现重试循环（`factory.py:318-354`），因为 tenacity 不支持 AsyncGenerator 装饰。特殊处理：rate limit 错误的 `retry_after` 字段优先于计算的退避时间。

### 2.3 实现细节

#### Embedding Provider 多 Adapter 架构

`src/services/embedding/` 采用独立但平行的抽象体系：

```
BaseEmbeddingAdapter (ABC)
├── OpenAICompatibleEmbeddingAdapter  ← OpenAI/Azure/HuggingFace/LM Studio
├── CohereEmbeddingAdapter            ← Cohere v1/v2 API
├── JinaEmbeddingAdapter              ← Jina AI
└── OllamaEmbeddingAdapter            ← Ollama 本地
```

`EmbeddingProviderManager`（`src/services/embedding/provider.py:22-71`）使用静态 `ADAPTER_MAPPING` 字典替代装饰器注册：

```python
ADAPTER_MAPPING: Dict[str, Type[BaseEmbeddingAdapter]] = {
    "openai": OpenAICompatibleEmbeddingAdapter,
    "azure_openai": OpenAICompatibleEmbeddingAdapter,
    "jina": JinaEmbeddingAdapter,
    "cohere": CohereEmbeddingAdapter,
    "ollama": OllamaEmbeddingAdapter,
    "lm_studio": OpenAICompatibleEmbeddingAdapter,
}
```

统一请求/响应模型（`src/services/embedding/adapters/base.py:16-53`）：
- `EmbeddingRequest` — provider 无关的请求结构，`input_type` 字段按 provider 语义映射（Cohere → `input_type`, Jina → `task`）
- `EmbeddingResponse` — 统一的 embeddings + usage 响应

#### Circuit Breaker 三态机

`src/utils/network/circuit_breaker.py:13-64` 实现经典三态：

```
closed ──(failures >= threshold)──→ open
  ↑                                    │
  │                          (recovery_timeout 过期)
  │                                    ↓
  └──────(success)──────────── half-open
```

与 `ErrorRateTracker`（`src/utils/error_rate_tracker.py:14-81`）联动：滑动窗口（默认 60s）统计错误率，超过阈值（默认 50%）触发 `alert_callback` → circuit breaker `record_failure()`。

#### Thinking Tags 清理

`src/services/llm/utils.py:176-210` 处理推理模型的 `<think>...</think>` 标签：先通过 `capabilities.has_thinking_tags()` 检查模型是否产生 thinking tags，再用正则 `re.sub(r"<think>.*?</think>", "", content, flags=re.DOTALL)` 清理。

#### Provider Presets

`factory.py:385-439` 定义了 API 和 Local 两组预设，供前端 UI 展示：

```python
API_PROVIDER_PRESETS = {
    "openai": {"name": "OpenAI", "base_url": "https://api.openai.com/v1", "requires_key": True, ...},
    "anthropic": {"name": "Anthropic", "base_url": "https://api.anthropic.com/v1", ...},
    "deepseek": {...}, "openrouter": {...},
}
LOCAL_PROVIDER_PRESETS = {
    "ollama": {"name": "Ollama", "base_url": "http://localhost:11434/v1", "requires_key": False, ...},
    "lm_studio": {...}, "vllm": {...}, "llama_cpp": {...},
}
```

---

## 第 3 章 迁移指南

### 3.1 迁移清单

**阶段 1：异常层级 + Error Mapping（基础）**
- [ ] 定义 `LLMError` 异常层级（LLMError → LLMAPIError → RateLimit/Timeout/Auth）
- [ ] 实现 `MappingRule` 规则链 + `map_error()` 函数
- [ ] 为每个使用的 SDK 添加 `isinstance` 规则

**阶段 2：Provider 抽象 + Registry**
- [ ] 定义 `BaseLLMProvider` ABC（complete/stream 接口）
- [ ] 实现 `@register_provider` 装饰器 + 全局注册表
- [ ] 实现各 provider（OpenAI/Anthropic/...），每个一个文件

**阶段 3：Capabilities 配置表**
- [ ] 定义 `PROVIDER_CAPABILITIES` + `MODEL_OVERRIDES` 字典
- [ ] 实现 `get_capability()` 4 级 fallback 查询
- [ ] 在业务代码中用 `supports_tools()` 等替换硬编码判断

**阶段 4：Factory 路由 + 重试**
- [ ] 实现 URL 检测（cloud/local 自动路由）
- [ ] 用 tenacity 包装 complete()，手动循环包装 stream()
- [ ] 集成 circuit breaker（可选）

### 3.2 适配代码模板

以下是一个最小可运行的 Provider 抽象层实现：

```python
"""minimal_llm_provider.py — 可直接运行的最小 Provider 抽象"""
from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import Any, AsyncGenerator, Dict, List, Optional, Type

# ── 1. 异常层级 ──
class LLMError(Exception):
    def __init__(self, message: str, provider: Optional[str] = None):
        super().__init__(message)
        self.provider = provider

class LLMRateLimitError(LLMError):
    def __init__(self, message: str, retry_after: Optional[float] = None, **kw):
        super().__init__(message, **kw)
        self.retry_after = retry_after

class LLMAuthError(LLMError): pass

# ── 2. Registry ──
_registry: Dict[str, Type] = {}

def register_provider(name: str):
    def decorator(cls):
        _registry[name] = cls
        cls.__provider_name__ = name
        return cls
    return decorator

def get_provider(name: str) -> Type:
    return _registry[name]

# ── 3. Capabilities ──
CAPABILITIES: Dict[str, Dict[str, Any]] = {
    "openai": {"supports_tools": True, "supports_response_format": True},
    "anthropic": {"supports_tools": True, "supports_response_format": False},
    "ollama": {"supports_tools": False, "supports_response_format": True},
}
DEFAULTS = {"supports_tools": False, "supports_response_format": True}

def get_capability(binding: str, cap: str, default=None):
    return CAPABILITIES.get(binding, {}).get(cap, DEFAULTS.get(cap, default))

# ── 4. Base Provider ──
@dataclass
class LLMResponse:
    content: str
    usage: Dict[str, int]
    provider: str
    model: str

class BaseLLMProvider(ABC):
    def __init__(self, api_key: str, base_url: str = "", model: str = ""):
        self.api_key = api_key
        self.base_url = base_url
        self.model = model

    @abstractmethod
    async def complete(self, prompt: str, **kwargs) -> LLMResponse: ...

    @abstractmethod
    async def stream(self, prompt: str, **kwargs) -> AsyncGenerator[str, None]: ...

# ── 5. Error Mapping ──
def map_error(exc: Exception, provider: str = "unknown") -> LLMError:
    status = getattr(exc, "status_code", None)
    if status == 429:
        return LLMRateLimitError(str(exc), provider=provider)
    if status == 401:
        return LLMAuthError(str(exc), provider=provider)
    return LLMError(str(exc), provider=provider)

# ── 6. 使用示例 ──
@register_provider("openai")
class OpenAIProvider(BaseLLMProvider):
    async def complete(self, prompt, **kwargs):
        import openai
        client = openai.AsyncOpenAI(api_key=self.api_key, base_url=self.base_url or None)
        resp = await client.chat.completions.create(
            model=self.model or "gpt-4o",
            messages=[{"role": "user", "content": prompt}], **kwargs
        )
        return LLMResponse(
            content=resp.choices[0].message.content or "",
            usage=resp.usage.model_dump() if resp.usage else {},
            provider="openai", model=self.model,
        )
    async def stream(self, prompt, **kwargs):
        import openai
        client = openai.AsyncOpenAI(api_key=self.api_key, base_url=self.base_url or None)
        stream = await client.chat.completions.create(
            model=self.model or "gpt-4o",
            messages=[{"role": "user", "content": prompt}], stream=True, **kwargs
        )
        async for chunk in stream:
            if chunk.choices and chunk.choices[0].delta.content:
                yield chunk.choices[0].delta.content
```

### 3.3 适用场景

| 场景 | 适用度 | 说明 |
|------|--------|------|
| 多 LLM 提供商切换 | ⭐⭐⭐ | 核心场景，registry + factory 完美适配 |
| Cloud + Local 混合部署 | ⭐⭐⭐ | URL 自动路由 + 预设配置，开箱即用 |
| 需要按模型能力动态调整行为 | ⭐⭐⭐ | capabilities 配置表 + model override |
| 单一提供商项目 | ⭐ | 过度设计，直接用 SDK 即可 |
| 需要运行时动态发现能力 | ⭐⭐ | 静态配置表需手动维护，不如 probe API |

---

## 第 4 章 测试用例

```python
import pytest
from unittest.mock import AsyncMock, MagicMock, patch

# ── Registry 测试 ──
class TestProviderRegistry:
    def test_register_and_retrieve(self):
        """注册后可通过名称获取 provider 类"""
        from minimal_llm_provider import _registry, register_provider, get_provider

        @register_provider("test_provider")
        class TestProvider:
            pass

        assert get_provider("test_provider") is TestProvider
        assert TestProvider.__provider_name__ == "test_provider"

    def test_duplicate_registration_raises(self):
        """重复注册同名 provider 应抛出 ValueError"""
        from minimal_llm_provider import register_provider

        @register_provider("dup_test")
        class First: pass

        with pytest.raises(ValueError, match="already registered"):
            @register_provider("dup_test")
            class Second: pass

    def test_unknown_provider_raises(self):
        """查询未注册的 provider 应抛出 KeyError"""
        from minimal_llm_provider import get_provider
        with pytest.raises(KeyError):
            get_provider("nonexistent")

# ── Capabilities 测试 ──
class TestCapabilities:
    def test_known_provider(self):
        from minimal_llm_provider import get_capability
        assert get_capability("openai", "supports_tools") is True
        assert get_capability("anthropic", "supports_response_format") is False

    def test_unknown_provider_uses_defaults(self):
        from minimal_llm_provider import get_capability
        assert get_capability("unknown_provider", "supports_tools") is False

    def test_explicit_default(self):
        from minimal_llm_provider import get_capability
        assert get_capability("openai", "nonexistent_cap", default="fallback") == "fallback"

# ── Error Mapping 测试 ──
class TestErrorMapping:
    def test_rate_limit_mapping(self):
        from minimal_llm_provider import map_error, LLMRateLimitError
        exc = MagicMock(spec=Exception)
        exc.status_code = 429
        exc.__str__ = lambda self: "rate limited"
        result = map_error(exc, provider="openai")
        assert isinstance(result, LLMRateLimitError)

    def test_auth_error_mapping(self):
        from minimal_llm_provider import map_error, LLMAuthError
        exc = MagicMock(spec=Exception)
        exc.status_code = 401
        exc.__str__ = lambda self: "unauthorized"
        result = map_error(exc, provider="openai")
        assert isinstance(result, LLMAuthError)

    def test_generic_error_mapping(self):
        from minimal_llm_provider import map_error, LLMError
        exc = Exception("something went wrong")
        result = map_error(exc)
        assert isinstance(result, LLMError)

# ── URL 路由测试（基于 DeepTutor utils.py 逻辑）──
class TestURLRouting:
    @pytest.mark.parametrize("url,expected", [
        ("http://localhost:11434/v1", True),
        ("http://127.0.0.1:1234/v1", True),
        ("https://api.openai.com/v1", False),
        ("https://api.anthropic.com/v1", False),
        ("http://0.0.0.0:8000/v1", True),
    ])
    def test_is_local_detection(self, url, expected):
        """URL 路由应正确区分 cloud 和 local"""
        CLOUD_DOMAINS = [".openai.com", ".anthropic.com"]
        LOCAL_HOSTS = ["localhost", "127.0.0.1", "0.0.0.0"]

        is_local = False
        url_lower = url.lower()
        if not any(d in url_lower for d in CLOUD_DOMAINS):
            is_local = any(h in url_lower for h in LOCAL_HOSTS)
        assert is_local == expected
```

---

## 第 5 章 跨域关联

| 关联域 | 关系类型 | 说明 |
|--------|----------|------|
| PD-03 容错与重试 | 强依赖 | Provider 抽象层内置了 retry + circuit breaker，是 PD-03 的具体实现载体。DeepTutor 的 `execute_with_retry` 和 tenacity 重试都属于 PD-03 范畴 |
| PD-04 工具系统 | 协同 | `capabilities.supports_tools()` 决定 Agent 是否向该 provider 发送 function calling 请求。工具系统需要查询 provider 能力 |
| PD-11 可观测性 | 协同 | `telemetry.track_llm_call` 装饰器 + `ErrorRateTracker` 滑动窗口统计，为可观测性提供 provider 级别的调用追踪和错误率监控 |
| PD-12 推理增强 | 协同 | `capabilities.has_thinking_tags()` + `utils.clean_thinking_tags()` 处理推理模型输出；`MODEL_OVERRIDES` 中的 `forced_temperature` 适配推理模型约束 |
| PD-01 上下文管理 | 弱关联 | `ProviderContextWindowError` 异常映射（`error_mapping.py:60-62`）检测上下文超限，可触发上下文压缩策略 |

---

## 第 6 章 来源文件索引

| 文件 | 行范围 | 关键实现 |
|------|--------|----------|
| `src/services/llm/registry.py` | L12-73 | Provider 装饰器注册 + 全局注册表 |
| `src/services/llm/providers/base_provider.py` | L26-94 | BaseLLMProvider ABC + execute_with_retry |
| `src/services/llm/capabilities.py` | L25-352 | PROVIDER_CAPABILITIES + MODEL_OVERRIDES + 4级查询 |
| `src/services/llm/error_mapping.py` | L36-104 | MappingRule 规则链 + map_error() |
| `src/services/llm/factory.py` | L1-463 | Factory 路由 + tenacity 重试 + Provider Presets |
| `src/services/llm/exceptions.py` | L14-153 | LLMError 统一异常层级（8 个异常类） |
| `src/services/llm/types.py` | L1-28 | TutorResponse + TutorStreamChunk Pydantic 模型 |
| `src/services/llm/utils.py` | L1-334 | URL 检测 + thinking tags 清理 + auth headers |
| `src/services/llm/config.py` | L60-231 | LLMConfig dataclass + env/config 加载 |
| `src/services/llm/telemetry.py` | L1-41 | track_llm_call 装饰器 |
| `src/services/llm/providers/open_ai.py` | L1-85 | OpenAIProvider 实现 |
| `src/services/llm/providers/anthropic.py` | L1-97 | AnthropicProvider 实现 |
| `src/services/embedding/adapters/base.py` | L10-107 | BaseEmbeddingAdapter ABC + EmbeddingRequest/Response |
| `src/services/embedding/provider.py` | L22-121 | EmbeddingProviderManager 工厂 + ADAPTER_MAPPING |
| `src/services/embedding/adapters/openai_compatible.py` | L14-97 | OpenAI 兼容 Embedding Adapter |
| `src/utils/error_rate_tracker.py` | L14-111 | ErrorRateTracker 滑动窗口错误率统计 |
| `src/utils/network/circuit_breaker.py` | L13-79 | CircuitBreaker 三态机 |

---

## 第 7 章 横向对比维度

```json comparison_data
{
  "project": "DeepTutor",
  "dimensions": {
    "注册机制": "装饰器 @register_provider 自动注册到全局字典",
    "能力检测": "静态配置表 PROVIDER_CAPABILITIES × MODEL_OVERRIDES，4 级 fallback",
    "错误映射": "MappingRule 规则链 + status_code 快速路径，SDK 可选加载",
    "Cloud/Local 分离": "URL 黑白名单自动路由，CLOUD_DOMAINS + LOCAL_HOSTS + LOCAL_PORTS",
    "重试策略": "双层重试：BaseLLMProvider 内置 + Factory tenacity，circuit breaker 前置",
    "Embedding 抽象": "独立 Adapter 模式，EmbeddingProviderManager 静态映射 6 种 binding",
    "流量控制": "每 provider 独立 TrafficController + 全局 ErrorRateTracker 滑动窗口"
  }
}
```

### 域元数据补充

```json domain_metadata
{
  "description": "统一 LLM/Embedding 多提供商接口差异，实现能力检测、错误映射与智能路由",
  "sub_problems": [
    "Thinking tags 清理（推理模型 <think> 标签过滤）",
    "URL 自动检测与 /v1 后缀补全",
    "Provider Presets 前端展示配置",
    "Token 参数兼容（max_tokens vs max_completion_tokens）"
  ],
  "best_practices": [
    "用 MODEL_OVERRIDES 处理模型级特例（如 forced_temperature），避免 provider 级配置膨胀",
    "Error mapping 采用 SDK 可选加载（try import），未安装的 SDK 规则自动跳过",
    "Stream 重试需手动循环实现，tenacity 不支持 AsyncGenerator 装饰"
  ]
}
```
