# PD-20.01 Nanobot — LiteLLM + Registry 多 Provider 统一接入

> 文档编号：PD-20.01
> 来源：Nanobot `nanobot/providers/`
> GitHub：https://github.com/HKUDS/nanobot.git
> 问题域：PD-20 多 LLM Provider 统一接入 Multi-Provider LLM Gateway
> 状态：可复用方案

---

## 第 1 章 问题与动机

### 1.1 核心问题

当一个 Agent 应用需要同时支持 Anthropic、OpenAI、DeepSeek、Gemini、智谱、通义千问、Moonshot、MiniMax、Groq、vLLM 等 10+ 家 LLM 提供商时，面临以下工程挑战：

1. **接口碎片化**：每家 Provider 的 API 格式、认证方式、模型命名规则各不相同
2. **模型路由**：用户指定 `anthropic/claude-opus-4-5` 或 `deepseek-chat` 时，系统需要自动识别对应 Provider 并正确路由
3. **Gateway 模式**：OpenRouter、AiHubMix、SiliconFlow 等聚合网关需要特殊的前缀处理和 API Key 映射
4. **本地部署**：vLLM/Ollama 等本地模型服务需要不同的认证和端点配置
5. **OAuth 认证**：OpenAI Codex、GitHub Copilot 等使用 OAuth 而非 API Key 的 Provider 需要独立认证流程
6. **配置膨胀**：随着 Provider 增加，if-elif 链式判断会迅速膨胀，难以维护

### 1.2 Nanobot 的解法概述

Nanobot 采用 **Registry 注册表 + LiteLLM 适配层 + 策略分发** 的三层架构：

1. **ProviderSpec 声明式注册表** (`registry.py:19-66`)：每个 Provider 用一个 frozen dataclass 描述全部元数据（名称、关键词、环境变量、前缀规则、Gateway 检测条件等），新增 Provider 只需添加一条记录
2. **LiteLLMProvider 统一适配** (`litellm_provider.py:19-273`)：通过 LiteLLM 库统一调用 10+ Provider，内部通过 Registry 查询自动完成模型前缀、环境变量设置、缓存控制注入
3. **CustomProvider 直连旁路** (`custom_provider.py:13-52`)：对于任意 OpenAI 兼容端点，绕过 LiteLLM 直接使用 openai SDK
4. **OpenAICodexProvider OAuth 旁路** (`openai_codex_provider.py:20-79`)：OAuth 认证的 Provider 完全独立实现，通过 SSE 流式调用 Responses API
5. **Config._match_provider 自动路由** (`schema.py:291-326`)：根据模型名自动匹配已配置的 Provider，支持关键词匹配和 Gateway 回退

### 1.3 设计思想

| 设计原则 | 具体实现 | 理由 | 替代方案 |
|----------|----------|------|----------|
| 声明式注册 | `ProviderSpec` frozen dataclass 元组 | 新增 Provider 只改数据不改逻辑，消除 if-elif 链 | 配置文件 YAML/JSON（需额外解析） |
| 关键词路由 | `find_by_model()` 按模型名关键词匹配 | 用户无需显式指定 Provider，写模型名即可 | 强制 `provider/model` 格式（用户体验差） |
| 三级检测 | provider_name → api_key 前缀 → api_base 关键词 | Gateway 检测需要多信号融合，单一信号不够 | 只靠 api_base 检测（误判率高） |
| 旁路模式 | `is_direct` / `is_oauth` 标记跳过 LiteLLM | 特殊 Provider 不适合走统一适配层 | 全部走 LiteLLM（Codex SSE 不兼容） |
| 环境变量模板 | `env_extras` 支持 `{api_key}` `{api_base}` 占位符 | LiteLLM 依赖特定环境变量名，需自动映射 | 手动设置环境变量（易出错） |
| 前缀规范化 | `_canonicalize_explicit_prefix()` 统一处理 | 避免 `github-copilot/model` 和 `github_copilot/model` 不一致 | 强制用户使用标准格式（不友好） |

---

## 第 2 章 源码实现分析

### 2.1 架构概览

```
┌─────────────────────────────────────────────────────────────┐
│                    Config._match_provider()                  │
│              (schema.py:291 — 模型名→Provider 路由)          │
└──────────────────────┬──────────────────────────────────────┘
                       │ provider_name + ProviderConfig
                       ▼
┌──────────────────────────────────────────────────────────────┐
│                   _make_provider() (commands.py:232)          │
│  ┌─────────────┐  ┌──────────────┐  ┌─────────────────────┐ │
│  │ is_oauth?   │  │ is_direct?   │  │ else (LiteLLM)      │ │
│  │ → CodexProv │  │ → CustomProv │  │ → LiteLLMProvider   │ │
│  └──────┬──────┘  └──────┬───────┘  └──────────┬──────────┘ │
└─────────┼────────────────┼──────────────────────┼────────────┘
          │                │                      │
          ▼                ▼                      ▼
┌──────────────┐  ┌──────────────┐  ┌──────────────────────────┐
│ httpx SSE    │  │ openai SDK   │  │ litellm.acompletion()    │
│ (Codex API)  │  │ (直连端点)    │  │ (10+ Provider 统一调用)   │
└──────────────┘  └──────────────┘  └──────────┬───────────────┘
                                               │
                                    ┌──────────▼───────────────┐
                                    │   Registry (registry.py)  │
                                    │  find_by_model()          │
                                    │  find_gateway()           │
                                    │  find_by_name()           │
                                    │  PROVIDERS tuple          │
                                    └───────────────────────────┘
```

### 2.2 核心实现

#### 2.2.1 ProviderSpec 声明式注册表

`registry.py:19-66` 定义了 `ProviderSpec` frozen dataclass，包含 Provider 的全部元数据：

```python
@dataclass(frozen=True)
class ProviderSpec:
    # identity
    name: str                       # config field name, e.g. "dashscope"
    keywords: tuple[str, ...]       # model-name keywords for matching (lowercase)
    env_key: str                    # LiteLLM env var, e.g. "DASHSCOPE_API_KEY"
    display_name: str = ""          # shown in `nanobot status`

    # model prefixing
    litellm_prefix: str = ""                 # "dashscope" → model becomes "dashscope/{model}"
    skip_prefixes: tuple[str, ...] = ()      # don't prefix if model already starts with these

    # extra env vars, e.g. (("ZHIPUAI_API_KEY", "{api_key}"),)
    env_extras: tuple[tuple[str, str], ...] = ()

    # gateway / local detection
    is_gateway: bool = False
    is_local: bool = False
    detect_by_key_prefix: str = ""           # match api_key prefix, e.g. "sk-or-"
    detect_by_base_keyword: str = ""         # match substring in api_base URL

    # OAuth-based providers
    is_oauth: bool = False
    # Direct providers bypass LiteLLM entirely
    is_direct: bool = False
    # Provider supports cache_control on content blocks
    supports_prompt_caching: bool = False
```

`PROVIDERS` 元组 (`registry.py:72-398`) 按优先级排列所有 Provider，顺序决定匹配优先级：Custom → Gateways → Standard → Local → Auxiliary。

#### 2.2.2 模型名→Provider 自动路由

`registry.py:406-423` 的 `find_by_model()` 实现两阶段匹配：

```python
def find_by_model(model: str) -> ProviderSpec | None:
    model_lower = model.lower()
    model_normalized = model_lower.replace("-", "_")
    model_prefix = model_lower.split("/", 1)[0] if "/" in model_lower else ""
    normalized_prefix = model_prefix.replace("-", "_")
    std_specs = [s for s in PROVIDERS if not s.is_gateway and not s.is_local]

    # Phase 1: Prefer explicit provider prefix
    for spec in std_specs:
        if model_prefix and normalized_prefix == spec.name:
            return spec

    # Phase 2: Keyword matching
    for spec in std_specs:
        if any(kw in model_lower or kw.replace("-", "_") in model_normalized
               for kw in spec.keywords):
            return spec
    return None
```

关键设计：先按显式前缀精确匹配（`github-copilot/model` → `github_copilot` spec），再按关键词模糊匹配。这避免了 `github-copilot/...codex` 被误匹配到 `openai_codex`。

#### 2.2.3 Gateway 三级检测

`registry.py:426-454` 的 `find_gateway()` 实现三级优先级检测：

```python
def find_gateway(
    provider_name: str | None = None,
    api_key: str | None = None,
    api_base: str | None = None,
) -> ProviderSpec | None:
    # 1. Direct match by config key
    if provider_name:
        spec = find_by_name(provider_name)
        if spec and (spec.is_gateway or spec.is_local):
            return spec

    # 2. Auto-detect by api_key prefix / api_base keyword
    for spec in PROVIDERS:
        if spec.detect_by_key_prefix and api_key and api_key.startswith(spec.detect_by_key_prefix):
            return spec
        if spec.detect_by_base_keyword and api_base and spec.detect_by_base_keyword in api_base:
            return spec

    return None
```

例如 OpenRouter 的 API Key 以 `sk-or-` 开头，AiHubMix 的 api_base 包含 `aihubmix`，系统可自动识别。

#### 2.2.4 模型前缀解析与 Gateway 模式

`litellm_provider.py:81-99` 的 `_resolve_model()` 根据是否为 Gateway 模式采用不同策略：

```python
def _resolve_model(self, model: str) -> str:
    if self._gateway:
        # Gateway mode: apply gateway prefix, skip provider-specific prefixes
        prefix = self._gateway.litellm_prefix
        if self._gateway.strip_model_prefix:
            model = model.split("/")[-1]  # anthropic/claude-3 → claude-3
        if prefix and not model.startswith(f"{prefix}/"):
            model = f"{prefix}/{model}"   # claude-3 → openai/claude-3
        return model

    # Standard mode: auto-prefix for known providers
    spec = find_by_model(model)
    if spec and spec.litellm_prefix:
        model = self._canonicalize_explicit_prefix(model, spec.name, spec.litellm_prefix)
        if not any(model.startswith(s) for s in spec.skip_prefixes):
            model = f"{spec.litellm_prefix}/{model}"
    return model
```

AiHubMix 的 `strip_model_prefix=True` 是关键：它不理解 `anthropic/claude-3`，需要先剥离为 `claude-3` 再加 `openai/` 前缀。

#### 2.2.5 环境变量自动映射

`litellm_provider.py:57-79` 的 `_setup_env()` 通过 ProviderSpec 的 `env_extras` 模板自动设置 LiteLLM 所需的环境变量：

```python
def _setup_env(self, api_key: str, api_base: str | None, model: str) -> None:
    spec = self._gateway or find_by_model(model)
    if not spec or not spec.env_key:
        return

    # Gateway overrides; standard provider uses setdefault
    if self._gateway:
        os.environ[spec.env_key] = api_key
    else:
        os.environ.setdefault(spec.env_key, api_key)

    # Resolve env_extras placeholders
    effective_base = api_base or spec.default_api_base
    for env_name, env_val in spec.env_extras:
        resolved = env_val.replace("{api_key}", api_key)
        resolved = resolved.replace("{api_base}", effective_base)
        os.environ.setdefault(env_name, resolved)
```

例如智谱 AI 的 spec 定义了 `env_extras=(("ZHIPUAI_API_KEY", "{api_key}"),)`，系统会自动将用户的 API Key 同时设置到 `ZAI_API_KEY` 和 `ZHIPUAI_API_KEY`。

### 2.3 实现细节

#### Provider 工厂函数

`commands.py:232-267` 的 `_make_provider()` 是 Provider 实例化的唯一入口，根据 Registry 元数据选择正确的 Provider 类：

- `provider_name == "openai_codex"` → `OpenAICodexProvider`（OAuth + SSE）
- `provider_name == "custom"` → `CustomProvider`（直连 openai SDK）
- 其他 → `LiteLLMProvider`（LiteLLM 统一适配）

#### Prompt Caching 支持

`litellm_provider.py:111-142` 根据 `ProviderSpec.supports_prompt_caching` 标记，自动为 Anthropic 和 OpenRouter 注入 `cache_control` 到 system message 和 tools 的最后一个元素。

#### 模型特定参数覆盖

`registry.py:334-336` 的 Moonshot spec 定义了 `model_overrides=(("kimi-k2.5", {"temperature": 1.0}),)`，`litellm_provider.py:144-152` 的 `_apply_model_overrides()` 在调用前自动应用这些覆盖。

#### 消息清洗

`base.py:43-81` 的 `_sanitize_empty_content()` 处理 MCP 工具返回空内容的情况，`litellm_provider.py:154-164` 的 `_sanitize_messages()` 剥离非标准 key（如 `reasoning_content`）并确保 assistant 消息始终有 `content` 字段。

---

## 第 3 章 迁移指南

### 3.1 迁移清单

**阶段 1：基础架构（必须）**

- [ ] 定义 `LLMProvider` ABC 基类，统一 `chat()` 接口签名
- [ ] 定义 `LLMResponse` 和 `ToolCallRequest` 数据类
- [ ] 创建 `ProviderSpec` dataclass，包含 name/keywords/env_key/litellm_prefix 等字段
- [ ] 建立 `PROVIDERS` 注册表元组，按优先级排列
- [ ] 实现 `find_by_model()` 和 `find_gateway()` 查找函数

**阶段 2：LiteLLM 适配（核心）**

- [ ] 实现 `LiteLLMProvider`，封装 `litellm.acompletion()`
- [ ] 实现 `_resolve_model()` 自动前缀逻辑
- [ ] 实现 `_setup_env()` 环境变量自动映射
- [ ] 实现消息清洗（空内容处理、非标准 key 剥离）

**阶段 3：扩展 Provider（按需）**

- [ ] 实现 `CustomProvider` 支持任意 OpenAI 兼容端点
- [ ] 实现 OAuth Provider（如 Codex）的独立认证流程
- [ ] 在配置 schema 中添加 `ProvidersConfig`，每个 Provider 一个字段

**阶段 4：配置路由（集成）**

- [ ] 实现 `Config._match_provider()` 自动路由
- [ ] 实现 `_make_provider()` 工厂函数

### 3.2 适配代码模板

以下是一个可直接复用的最小化 Provider Registry 实现：

```python
"""Minimal provider registry — copy and extend."""

from __future__ import annotations
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any

import litellm
from litellm import acompletion


# --- Data types ---

@dataclass
class ToolCallRequest:
    id: str
    name: str
    arguments: dict[str, Any]

@dataclass
class LLMResponse:
    content: str | None
    tool_calls: list[ToolCallRequest] = field(default_factory=list)
    finish_reason: str = "stop"
    usage: dict[str, int] = field(default_factory=dict)

    @property
    def has_tool_calls(self) -> bool:
        return len(self.tool_calls) > 0


# --- Registry ---

@dataclass(frozen=True)
class ProviderSpec:
    name: str
    keywords: tuple[str, ...]
    env_key: str
    litellm_prefix: str = ""
    skip_prefixes: tuple[str, ...] = ()
    is_gateway: bool = False
    detect_by_key_prefix: str = ""
    detect_by_base_keyword: str = ""

PROVIDERS: tuple[ProviderSpec, ...] = (
    ProviderSpec(name="anthropic", keywords=("anthropic", "claude"),
                 env_key="ANTHROPIC_API_KEY"),
    ProviderSpec(name="openai", keywords=("openai", "gpt"),
                 env_key="OPENAI_API_KEY"),
    ProviderSpec(name="deepseek", keywords=("deepseek",),
                 env_key="DEEPSEEK_API_KEY", litellm_prefix="deepseek",
                 skip_prefixes=("deepseek/",)),
    # Add more providers here...
)

def find_by_model(model: str) -> ProviderSpec | None:
    model_lower = model.lower()
    for spec in PROVIDERS:
        if not spec.is_gateway and any(kw in model_lower for kw in spec.keywords):
            return spec
    return None


# --- Provider ---

class UnifiedProvider:
    def __init__(self, api_key: str, default_model: str = "anthropic/claude-sonnet-4-5"):
        self.api_key = api_key
        self.default_model = default_model
        litellm.drop_params = True

    def _resolve_model(self, model: str) -> str:
        spec = find_by_model(model)
        if spec and spec.litellm_prefix:
            if not any(model.startswith(s) for s in spec.skip_prefixes):
                return f"{spec.litellm_prefix}/{model}"
        return model

    async def chat(self, messages: list[dict], model: str | None = None,
                   tools: list[dict] | None = None) -> LLMResponse:
        model = self._resolve_model(model or self.default_model)
        kwargs = {"model": model, "messages": messages, "api_key": self.api_key}
        if tools:
            kwargs.update(tools=tools, tool_choice="auto")
        response = await acompletion(**kwargs)
        choice = response.choices[0]
        return LLMResponse(
            content=choice.message.content,
            finish_reason=choice.finish_reason or "stop",
        )
```

### 3.3 适用场景

| 场景 | 适用度 | 说明 |
|------|--------|------|
| 多 Provider Agent 应用 | ⭐⭐⭐ | 核心场景，Registry 模式完美适配 |
| 单 Provider 简单应用 | ⭐ | 过度设计，直接用 LiteLLM 即可 |
| 需要 Gateway 聚合的场景 | ⭐⭐⭐ | 三级检测机制专为此设计 |
| 本地模型部署（vLLM/Ollama） | ⭐⭐⭐ | `is_local` + `hosted_vllm` 前缀支持 |
| OAuth 认证 Provider | ⭐⭐ | 需要独立实现，但 `is_oauth` 标记提供了清晰的分发点 |
| 高频切换模型的场景 | ⭐⭐⭐ | `find_by_model()` 自动路由，用户只需改模型名 |

---

## 第 4 章 测试用例

```python
"""Tests for multi-provider gateway — based on nanobot's real interfaces."""

import os
import pytest
from unittest.mock import AsyncMock, patch, MagicMock
from dataclasses import dataclass


# --- Test Registry Matching ---

class TestFindByModel:
    """Test model name → ProviderSpec routing (registry.py:406-423)."""

    def test_anthropic_by_keyword(self):
        from nanobot.providers.registry import find_by_model
        spec = find_by_model("claude-opus-4-5")
        assert spec is not None
        assert spec.name == "anthropic"

    def test_deepseek_by_keyword(self):
        from nanobot.providers.registry import find_by_model
        spec = find_by_model("deepseek-chat")
        assert spec is not None
        assert spec.name == "deepseek"
        assert spec.litellm_prefix == "deepseek"

    def test_explicit_prefix_wins_over_keyword(self):
        """github-copilot/gpt-4o should match github_copilot, not openai."""
        from nanobot.providers.registry import find_by_model
        spec = find_by_model("github_copilot/gpt-4o")
        assert spec is not None
        assert spec.name == "github_copilot"

    def test_unknown_model_returns_none(self):
        from nanobot.providers.registry import find_by_model
        assert find_by_model("totally-unknown-model-xyz") is None

    def test_gateway_not_matched_by_model(self):
        """Gateways should not be matched by find_by_model."""
        from nanobot.providers.registry import find_by_model
        # OpenRouter is a gateway — should not appear in model matching
        spec = find_by_model("openrouter/claude-3")
        # Should match anthropic (by 'claude' keyword), not openrouter
        assert spec is None or spec.name != "openrouter"


class TestFindGateway:
    """Test gateway detection (registry.py:426-454)."""

    def test_detect_openrouter_by_key_prefix(self):
        from nanobot.providers.registry import find_gateway
        spec = find_gateway(api_key="sk-or-abc123")
        assert spec is not None
        assert spec.name == "openrouter"

    def test_detect_aihubmix_by_base_keyword(self):
        from nanobot.providers.registry import find_gateway
        spec = find_gateway(api_base="https://aihubmix.com/v1")
        assert spec is not None
        assert spec.name == "aihubmix"

    def test_detect_vllm_by_provider_name(self):
        from nanobot.providers.registry import find_gateway
        spec = find_gateway(provider_name="vllm")
        assert spec is not None
        assert spec.name == "vllm"
        assert spec.is_local is True

    def test_no_gateway_for_standard_provider(self):
        from nanobot.providers.registry import find_gateway
        spec = find_gateway(api_key="sk-ant-abc123", api_base=None)
        assert spec is None  # Anthropic is not a gateway


class TestResolveModel:
    """Test model prefix resolution (litellm_provider.py:81-99)."""

    def test_standard_prefix_added(self):
        """deepseek-chat → deepseek/deepseek-chat"""
        from nanobot.providers.litellm_provider import LiteLLMProvider
        provider = LiteLLMProvider.__new__(LiteLLMProvider)
        provider._gateway = None
        result = provider._resolve_model("deepseek-chat")
        assert result == "deepseek/deepseek-chat"

    def test_skip_double_prefix(self):
        """deepseek/deepseek-chat should not become deepseek/deepseek/deepseek-chat"""
        from nanobot.providers.litellm_provider import LiteLLMProvider
        provider = LiteLLMProvider.__new__(LiteLLMProvider)
        provider._gateway = None
        result = provider._resolve_model("deepseek/deepseek-chat")
        assert result.count("deepseek/") == 1

    def test_gateway_strip_and_reprefix(self):
        """Gateway with strip_model_prefix: anthropic/claude-3 → openai/claude-3"""
        from nanobot.providers.litellm_provider import LiteLLMProvider
        from nanobot.providers.registry import find_by_name
        provider = LiteLLMProvider.__new__(LiteLLMProvider)
        provider._gateway = find_by_name("aihubmix")  # strip_model_prefix=True
        result = provider._resolve_model("anthropic/claude-3")
        assert result == "openai/claude-3"


class TestSanitizeMessages:
    """Test message sanitization (base.py:43-81)."""

    def test_empty_string_content_replaced(self):
        from nanobot.providers.base import LLMProvider
        messages = [{"role": "tool", "content": "", "tool_call_id": "tc1"}]
        result = LLMProvider._sanitize_empty_content(messages)
        assert result[0]["content"] == "(empty)"

    def test_assistant_empty_with_tool_calls_gets_none(self):
        from nanobot.providers.base import LLMProvider
        messages = [{"role": "assistant", "content": "", "tool_calls": [{"id": "1"}]}]
        result = LLMProvider._sanitize_empty_content(messages)
        assert result[0]["content"] is None
```

---

## 第 5 章 跨域关联

| 关联域 | 关系类型 | 说明 |
|--------|----------|------|
| PD-03 容错与重试 | 协同 | `LiteLLMProvider.chat()` 捕获异常返回 `finish_reason="error"` 的 LLMResponse，上层可据此重试 |
| PD-04 工具系统 | 协同 | Provider 统一了 tool_calls 的解析格式（`ToolCallRequest`），工具系统依赖此标准接口 |
| PD-11 可观测性 | 协同 | `LLMResponse.usage` 字段提供 token 计量数据，可观测性系统可据此追踪成本 |
| PD-12 推理增强 | 协同 | `LLMResponse.reasoning_content` 字段支持 DeepSeek-R1/Kimi 等推理模型的思维链输出 |
| PD-01 上下文管理 | 依赖 | Provider 层的 `max_tokens` 参数和 prompt caching 直接影响上下文窗口利用效率 |

---

## 第 6 章 来源文件索引

| 文件 | 行范围 | 关键实现 |
|------|--------|----------|
| `nanobot/providers/base.py` | L1-111 | `LLMProvider` ABC 基类、`LLMResponse`/`ToolCallRequest` 数据类、`_sanitize_empty_content()` |
| `nanobot/providers/registry.py` | L19-66 | `ProviderSpec` frozen dataclass 定义 |
| `nanobot/providers/registry.py` | L72-398 | `PROVIDERS` 注册表（16 个 Provider） |
| `nanobot/providers/registry.py` | L406-423 | `find_by_model()` 模型名→Provider 匹配 |
| `nanobot/providers/registry.py` | L426-454 | `find_gateway()` 三级 Gateway 检测 |
| `nanobot/providers/litellm_provider.py` | L19-273 | `LiteLLMProvider` 完整实现 |
| `nanobot/providers/litellm_provider.py` | L81-99 | `_resolve_model()` 前缀解析 |
| `nanobot/providers/litellm_provider.py` | L57-79 | `_setup_env()` 环境变量映射 |
| `nanobot/providers/litellm_provider.py` | L111-142 | `_apply_cache_control()` prompt caching |
| `nanobot/providers/custom_provider.py` | L13-52 | `CustomProvider` 直连 OpenAI 兼容端点 |
| `nanobot/providers/openai_codex_provider.py` | L20-79 | `OpenAICodexProvider` OAuth + SSE 流式调用 |
| `nanobot/config/schema.py` | L201-228 | `ProvidersConfig` 配置 schema（16 个 Provider 字段） |
| `nanobot/config/schema.py` | L291-326 | `Config._match_provider()` 自动路由 |
| `nanobot/cli/commands.py` | L232-267 | `_make_provider()` 工厂函数 |

---

## 第 7 章 横向对比维度

```json comparison_data
{
  "project": "Nanobot",
  "dimensions": {
    "适配层": "LiteLLM 统一适配 + CustomProvider/CodexProvider 旁路",
    "路由机制": "ProviderSpec 声明式注册表，find_by_model 关键词匹配 + 显式前缀优先",
    "Gateway 支持": "三级检测（config key → api_key 前缀 → api_base 关键词），strip_model_prefix 重前缀",
    "认证方式": "API Key 环境变量自动映射 + OAuth 独立流程（Codex/Copilot）",
    "Provider 数量": "16 个内置 Provider（含 4 个 Gateway + 1 个本地 + 2 个 OAuth）",
    "扩展方式": "添加 ProviderSpec 记录 + ProvidersConfig 字段，零逻辑代码修改"
  }
}
```

### 域元数据补充

```json domain_metadata
{
  "description": "统一 LLM 调用接口，消除多 Provider 接入的 if-elif 链式判断",
  "sub_problems": [
    "Gateway 聚合网关的模型前缀剥离与重前缀",
    "Provider 特定参数覆盖（如 Kimi K2.5 temperature 下限）",
    "Prompt Caching 的 Provider 感知注入",
    "消息格式清洗（空内容、非标准 key 剥离）"
  ],
  "best_practices": [
    "frozen dataclass 注册表替代 if-elif 链，新增 Provider 只改数据不改逻辑",
    "三级 Gateway 检测（config key → api_key 前缀 → api_base 关键词）避免误判",
    "env_extras 模板化环境变量映射，解决 LiteLLM 对特定环境变量名的依赖",
    "is_direct/is_oauth 标记实现旁路分发，特殊 Provider 不强制走统一适配层"
  ]
}
```


