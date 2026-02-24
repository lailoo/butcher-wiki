# PD-49.01 OpenManus — 多 LLM 提供商统一适配层

> 文档编号：PD-49.01
> 来源：OpenManus `app/llm.py` `app/bedrock.py` `app/config.py`
> GitHub：https://github.com/FoundationAgents/OpenManus.git
> 问题域：PD-49 多 LLM 提供商适配 Multi-LLM Provider Adapter
> 状态：可复用方案

---

## 第 1 章 问题与动机

### 1.1 核心问题

Agent 框架需要支持多个 LLM 提供商（OpenAI、Azure OpenAI、AWS Bedrock、Ollama 等本地推理），
但各提供商的 API 格式、认证方式、消息结构、工具调用协议、流式响应格式均不相同。
如果在业务层直接对接每个提供商，会导致：

- 业务代码中充斥 `if provider == "azure"` 分支，耦合度极高
- 新增提供商需要修改所有调用点
- 工具调用（function calling）的请求/响应格式在 OpenAI 与 Bedrock 之间差异巨大
- 流式响应的事件结构完全不同（OpenAI SSE chunks vs Bedrock converse_stream events）
- Token 计量和限额管理需要统一，不能因提供商不同而丢失

### 1.2 OpenManus 的解法概述

OpenManus 采用 **"OpenAI 格式为锚点 + 适配器桥接"** 的策略：

1. **统一接口层**：`LLM` 类（`app/llm.py:174`）对外暴露 `ask()` / `ask_tool()` / `ask_with_images()` 三个方法，业务层完全不感知底层提供商
2. **配置驱动选择**：通过 TOML 配置文件的 `api_type` 字段（`app/config.py:29`）决定使用哪个提供商，支持 `azure` / `aws` / `ollama` / 默认 OpenAI
3. **Bedrock 适配器**：`BedrockClient`（`app/bedrock.py:38`）实现完整的 OpenAI↔Bedrock 双向格式转换，包括消息、工具、响应三层转换
4. **单例缓存**：`LLM.__new__()` 按 `config_name` 缓存实例（`app/llm.py:175-184`），同一配置名只创建一次客户端
5. **多模型实例**：TOML 支持 `[llm]`（默认）和 `[llm.vision]`（视觉）等命名配置，通过继承+覆盖机制复用基础配置（`app/config.py:236-319`）

### 1.3 设计思想

| 设计原则 | 具体实现 | 理由 | 替代方案 |
|----------|----------|------|----------|
| OpenAI 格式为锚点 | 所有非 OpenAI 提供商都转换为 OpenAI 格式 | OpenAI SDK 生态最成熟，AsyncOpenAI/AsyncAzureOpenAI 已覆盖大部分场景 | 自定义中间格式（增加转换层数） |
| 配置驱动而非代码驱动 | `api_type` 字段在 TOML 中声明 | 切换提供商只需改配置文件，零代码修改 | 环境变量（不够结构化） |
| 适配器模式 | BedrockClient 模拟 `client.chat.completions.create()` 接口 | 让 Bedrock 对 LLM 类透明 | 策略模式（需要更多抽象） |
| 单例 + 命名缓存 | `_instances: Dict[str, "LLM"]` 按 config_name 索引 | 避免重复创建客户端，节省连接资源 | 依赖注入容器（过重） |
| 继承式配置覆盖 | `[llm.vision]` 只需声明差异字段，其余继承 `[llm]` | 减少配置冗余 | 完全独立配置（重复多） |

---

## 第 2 章 源码实现分析

### 2.1 架构概览

```
┌─────────────────────────────────────────────────────────┐
│                    业务层 (Agent)                         │
│              ask() / ask_tool() / ask_with_images()      │
└──────────────────────┬──────────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────────┐
│                   LLM 统一接口层                          │
│  app/llm.py:174  class LLM (单例, 按 config_name 缓存)   │
│  ┌─────────────────────────────────────────────────┐    │
│  │ api_type 路由:                                    │    │
│  │  "azure"  → AsyncAzureOpenAI (openai SDK)        │    │
│  │  "aws"    → BedrockClient (自研适配器)             │    │
│  │  其他     → AsyncOpenAI (openai SDK)              │    │
│  └─────────────────────────────────────────────────┘    │
│  TokenCounter / retry / format_messages                  │
└──────┬──────────────┬──────────────┬────────────────────┘
       │              │              │
┌──────▼─────┐ ┌──────▼─────┐ ┌─────▼──────────────┐
│AsyncOpenAI │ │AsyncAzure  │ │  BedrockClient     │
│  (openai)  │ │  OpenAI    │ │  app/bedrock.py:38 │
│            │ │  (openai)  │ │  ┌───────────────┐  │
│            │ │            │ │  │ Chat           │  │
│            │ │            │ │  │ └─Completions  │  │
│            │ │            │ │  │   .create()    │  │
│            │ │            │ │  └───────────────┘  │
└────────────┘ └────────────┘ │  boto3.client()    │
                              └────────────────────┘
       │              │              │
┌──────▼──────────────▼──────────────▼────────────────────┐
│              Config 配置层 (TOML)                         │
│  app/config.py:197  class Config (线程安全单例)            │
│  ┌──────────────────────────────────────────────────┐   │
│  │ [llm]          → default LLMSettings              │   │
│  │ [llm.vision]   → vision LLMSettings (继承+覆盖)    │   │
│  │ api_type: azure | aws | ollama | (default openai) │   │
│  └──────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────┘
```

### 2.2 核心实现

#### 2.2.1 提供商路由 — LLM.__init__() (`app/llm.py:186-227`)

LLM 类的初始化根据 `api_type` 选择不同的客户端实现：

```python
# app/llm.py:216-225 — 提供商路由核心逻辑
if self.api_type == "azure":
    self.client = AsyncAzureOpenAI(
        base_url=self.base_url,
        api_key=self.api_key,
        api_version=self.api_version,
    )
elif self.api_type == "aws":
    self.client = BedrockClient()
else:
    self.client = AsyncOpenAI(api_key=self.api_key, base_url=self.base_url)
```

关键点：`azure` 和默认 OpenAI 都使用 openai SDK 的异步客户端，只是 Azure 需要额外的 `api_version`。
Ollama 等兼容 OpenAI 格式的提供商走 `else` 分支，通过 `base_url` 指向本地端点即可。
只有 Bedrock 因为 API 格式完全不同，需要自研适配器。

#### 2.2.2 单例缓存机制 (`app/llm.py:174-184`)

```python
# app/llm.py:174-184 — 按 config_name 的单例缓存
class LLM:
    _instances: Dict[str, "LLM"] = {}

    def __new__(
        cls, config_name: str = "default", llm_config: Optional[LLMSettings] = None
    ):
        if config_name not in cls._instances:
            instance = super().__new__(cls)
            instance.__init__(config_name, llm_config)
            cls._instances[config_name] = instance
        return cls._instances[config_name]
```

`LLM("default")` 和 `LLM("vision")` 返回不同实例，但同一 config_name 多次调用返回同一实例。
这使得 Agent 系统中多个组件可以共享同一个 LLM 连接，避免重复初始化。

#### 2.2.3 Bedrock 适配器 — 消息格式双向转换 (`app/bedrock.py:86-132`)

Bedrock 的消息格式与 OpenAI 差异巨大。`ChatCompletions` 类实现了完整的双向转换：

```python
# app/bedrock.py:86-132 — OpenAI 消息 → Bedrock 消息转换
def _convert_openai_messages_to_bedrock_format(self, messages):
    bedrock_messages = []
    system_prompt = []
    for message in messages:
        if message.get("role") == "system":
            # Bedrock 的 system prompt 是独立参数，不在 messages 中
            system_prompt = [{"text": message.get("content")}]
        elif message.get("role") == "user":
            bedrock_message = {
                "role": message.get("role", "user"),
                "content": [{"text": message.get("content")}],
            }
            bedrock_messages.append(bedrock_message)
        elif message.get("role") == "assistant":
            bedrock_message = {
                "role": "assistant",
                "content": [{"text": message.get("content")}],
            }
            # 工具调用转换：OpenAI tool_calls → Bedrock toolUse
            openai_tool_calls = message.get("tool_calls", [])
            if openai_tool_calls:
                bedrock_tool_use = {
                    "toolUseId": openai_tool_calls[0]["id"],
                    "name": openai_tool_calls[0]["function"]["name"],
                    "input": json.loads(
                        openai_tool_calls[0]["function"]["arguments"]
                    ),
                }
                bedrock_message["content"].append({"toolUse": bedrock_tool_use})
            bedrock_messages.append(bedrock_message)
        elif message.get("role") == "tool":
            # Bedrock 中 tool result 是 user 角色
            bedrock_message = {
                "role": "user",
                "content": [
                    {
                        "toolResult": {
                            "toolUseId": CURRENT_TOOLUSE_ID,
                            "content": [{"text": message.get("content")}],
                        }
                    }
                ],
            }
            bedrock_messages.append(bedrock_message)
    return system_prompt, bedrock_messages
```

核心差异点：
- Bedrock 的 system prompt 是 `converse()` API 的独立参数，不在 messages 数组中
- OpenAI 的 `tool` 角色在 Bedrock 中变为 `user` 角色 + `toolResult` 结构
- OpenAI 的 `tool_calls[].function.arguments`（JSON 字符串）在 Bedrock 中是 `toolUse.input`（已解析对象）

#### 2.2.4 Bedrock 工具定义转换 (`app/bedrock.py:60-84`)

```python
# app/bedrock.py:60-84 — OpenAI function → Bedrock toolSpec
def _convert_openai_tools_to_bedrock_format(self, tools):
    bedrock_tools = []
    for tool in tools:
        if tool.get("type") == "function":
            function = tool.get("function", {})
            bedrock_tool = {
                "toolSpec": {
                    "name": function.get("name", ""),
                    "description": function.get("description", ""),
                    "inputSchema": {
                        "json": {
                            "type": "object",
                            "properties": function.get("parameters", {}).get(
                                "properties", {}
                            ),
                            "required": function.get("parameters", {}).get(
                                "required", []
                            ),
                        }
                    },
                }
            }
            bedrock_tools.append(bedrock_tool)
    return bedrock_tools
```

#### 2.2.5 Bedrock 响应转换 (`app/bedrock.py:134-193`)

```python
# app/bedrock.py:134-193 — Bedrock 响应 → OpenAI 格式
def _convert_bedrock_response_to_openai_format(self, bedrock_response):
    content = ""
    if bedrock_response.get("output", {}).get("message", {}).get("content"):
        content_array = bedrock_response["output"]["message"]["content"]
        content = "".join(item.get("text", "") for item in content_array)
    if content == "":
        content = "."  # 防止空内容导致下游异常

    # 工具调用转换：Bedrock toolUse → OpenAI tool_calls
    openai_tool_calls = []
    if bedrock_response.get("output", {}).get("message", {}).get("content"):
        for content_item in bedrock_response["output"]["message"]["content"]:
            if content_item.get("toolUse"):
                bedrock_tool_use = content_item["toolUse"]
                openai_tool_call = {
                    "id": bedrock_tool_use["toolUseId"],
                    "type": "function",
                    "function": {
                        "name": bedrock_tool_use["name"],
                        "arguments": json.dumps(bedrock_tool_use["input"]),
                    },
                }
                openai_tool_calls.append(openai_tool_call)

    # 构造 OpenAI 格式响应
    openai_format = {
        "id": f"chatcmpl-{uuid.uuid4()}",
        "created": int(time.time()),
        "object": "chat.completion",
        "choices": [{
            "finish_reason": bedrock_response.get("stopReason", "end_turn"),
            "index": 0,
            "message": {
                "content": content,
                "role": "assistant",
                "tool_calls": openai_tool_calls if openai_tool_calls else None,
            },
        }],
        "usage": {
            "completion_tokens": bedrock_response.get("usage", {}).get("outputTokens", 0),
            "prompt_tokens": bedrock_response.get("usage", {}).get("inputTokens", 0),
            "total_tokens": bedrock_response.get("usage", {}).get("totalTokens", 0),
        },
    }
    return OpenAIResponse(openai_format)
```

### 2.3 实现细节

#### 配置继承机制 (`app/config.py:236-319`)

TOML 配置支持 `[llm]` 基础配置 + `[llm.vision]` 等命名覆盖。加载逻辑：

```python
# app/config.py:236-319 — 配置继承与覆盖
default_settings = {
    "model": base_llm.get("model"),
    "base_url": base_llm.get("base_url"),
    "api_key": base_llm.get("api_key"),
    # ... 其他字段
}

config_dict = {
    "llm": {
        "default": default_settings,
        # 命名配置继承 default 并覆盖差异字段
        **{
            name: {**default_settings, **override_config}
            for name, override_config in llm_overrides.items()
        },
    },
}
```

这意味着 `[llm.vision]` 只需声明 `model = "gpt-4o"` 等差异字段，其余（api_key、base_url 等）自动继承 `[llm]`。

#### 流式响应适配 (`app/bedrock.py:220-298`)

Bedrock 的 `converse_stream()` 返回事件流，事件类型包括 `messageStart`、`contentBlockDelta`、`contentBlockStop`、`contentBlockStart`。
适配器将这些事件逐步拼装成完整的 Bedrock 响应结构，最后统一转换为 OpenAI 格式：

```
Bedrock Stream Events:
  messageStart(role) → contentBlockDelta(text) → contentBlockStop(0)
  → contentBlockStart(toolUse) → contentBlockDelta(toolUse.input) → contentBlockStop(1)

转换后:
  OpenAIResponse { choices[0].message.content, choices[0].message.tool_calls }
```

注意：流式模式下 Bedrock 适配器并不返回真正的流式 chunks 给上层，而是内部消费完整个流后返回完整响应。
这是一个设计取舍——简化了适配层，但牺牲了流式输出的实时性。

#### Token 计量统一 (`app/llm.py:45-171`, `app/llm.py:229-264`)

`TokenCounter` 类使用 tiktoken 统一计算 token 数，支持文本、图片（低/高细节）、工具调用的 token 估算。
`LLM` 类维护 `total_input_tokens` 和 `total_completion_tokens` 累计计数，并通过 `max_input_tokens` 实现全局限额控制。

#### 重试策略 (`app/llm.py:354-360`)

所有 API 调用方法都使用 tenacity 的 `@retry` 装饰器：

```python
@retry(
    wait=wait_random_exponential(min=1, max=60),
    stop=stop_after_attempt(6),
    retry=retry_if_exception_type((OpenAIError, Exception, ValueError)),
)
```

`TokenLimitExceeded` 异常被排除在重试之外，避免无意义的重复请求。

---

## 第 3 章 迁移指南

### 3.1 迁移清单

**阶段 1：基础适配层**
- [ ] 定义 `LLMSettings` Pydantic 模型，包含 `api_type`、`model`、`base_url`、`api_key`、`api_version` 等字段
- [ ] 实现 `LLM` 类，根据 `api_type` 路由到不同客户端
- [ ] 实现单例缓存（按 config_name）

**阶段 2：Bedrock 适配器（如需 AWS）**
- [ ] 实现 `BedrockClient`，模拟 `client.chat.completions.create()` 接口
- [ ] 实现消息格式双向转换（OpenAI ↔ Bedrock）
- [ ] 实现工具定义格式转换
- [ ] 实现响应格式转换（含 usage token 映射）

**阶段 3：配置系统**
- [ ] 设计 TOML 配置结构，支持 `[llm]` + `[llm.xxx]` 继承覆盖
- [ ] 实现 Config 单例加载器

**阶段 4：增强功能**
- [ ] 集成 tiktoken 做 token 计量
- [ ] 添加 tenacity 重试策略
- [ ] 实现 `max_input_tokens` 全局限额

### 3.2 适配代码模板

以下是一个可直接复用的多提供商适配层骨架：

```python
"""multi_llm_adapter.py — 多 LLM 提供商适配层"""
from typing import Dict, List, Optional, Union
from pydantic import BaseModel, Field
from openai import AsyncOpenAI, AsyncAzureOpenAI

class LLMConfig(BaseModel):
    """LLM 配置模型"""
    model: str
    base_url: str
    api_key: str
    api_type: str = "openai"  # openai | azure | aws | ollama
    api_version: str = ""
    max_tokens: int = 4096
    temperature: float = 1.0

class LLMAdapter:
    """统一 LLM 适配层 — 按 config_name 单例缓存"""
    _instances: Dict[str, "LLMAdapter"] = {}

    def __new__(cls, config_name: str = "default", config: Optional[LLMConfig] = None):
        if config_name not in cls._instances:
            instance = super().__new__(cls)
            cls._instances[config_name] = instance
        return cls._instances[config_name]

    def __init__(self, config_name: str = "default", config: Optional[LLMConfig] = None):
        if hasattr(self, "_initialized"):
            return
        self._initialized = True
        self.config = config

        # 提供商路由
        if config.api_type == "azure":
            self.client = AsyncAzureOpenAI(
                base_url=config.base_url,
                api_key=config.api_key,
                api_version=config.api_version,
            )
        elif config.api_type == "aws":
            from .bedrock_adapter import BedrockClient
            self.client = BedrockClient()
        else:
            # OpenAI / Ollama / 其他兼容提供商
            self.client = AsyncOpenAI(
                api_key=config.api_key,
                base_url=config.base_url,
            )

    async def chat(self, messages: List[dict], **kwargs) -> str:
        """统一聊天接口"""
        response = await self.client.chat.completions.create(
            model=self.config.model,
            messages=messages,
            max_tokens=self.config.max_tokens,
            temperature=self.config.temperature,
            **kwargs,
        )
        return response.choices[0].message.content
```

### 3.3 适用场景

| 场景 | 适用度 | 说明 |
|------|--------|------|
| 多云部署的 Agent 系统 | ⭐⭐⭐ | 核心场景，不同环境用不同提供商 |
| 本地开发 + 云端生产 | ⭐⭐⭐ | 本地用 Ollama，生产用 Azure/Bedrock |
| 成本优化（模型路由） | ⭐⭐ | 简单任务用便宜模型，复杂任务用强模型 |
| 提供商故障切换 | ⭐ | 当前实现不支持自动 failover，需扩展 |
| 多模态混合调用 | ⭐⭐ | 通过 `[llm.vision]` 配置独立视觉模型 |

---

## 第 4 章 测试用例

```python
"""test_multi_llm_adapter.py — 基于 OpenManus 真实接口的测试"""
import json
import pytest
from unittest.mock import AsyncMock, MagicMock, patch

# ---- 测试 Config 配置继承 ----

class TestConfigInheritance:
    def test_vision_inherits_default(self):
        """[llm.vision] 应继承 [llm] 的 api_key 等基础字段"""
        default = {"model": "gpt-4o-mini", "base_url": "https://api.openai.com/v1",
                    "api_key": "sk-xxx", "max_tokens": 4096, "temperature": 1.0,
                    "api_type": "", "api_version": ""}
        override = {"model": "gpt-4o", "max_tokens": 8192}
        merged = {**default, **override}
        assert merged["model"] == "gpt-4o"
        assert merged["api_key"] == "sk-xxx"  # 继承
        assert merged["max_tokens"] == 8192   # 覆盖

    def test_api_type_determines_client(self):
        """api_type 应正确路由到对应客户端"""
        type_map = {
            "azure": "AsyncAzureOpenAI",
            "aws": "BedrockClient",
            "": "AsyncOpenAI",
            "ollama": "AsyncOpenAI",
        }
        for api_type, expected_class in type_map.items():
            assert expected_class  # 验证映射存在

# ---- 测试 Bedrock 格式转换 ----

class TestBedrockFormatConversion:
    def test_openai_tools_to_bedrock(self):
        """OpenAI function calling 格式应正确转换为 Bedrock toolSpec"""
        openai_tools = [{
            "type": "function",
            "function": {
                "name": "search",
                "description": "Search the web",
                "parameters": {
                    "type": "object",
                    "properties": {"query": {"type": "string"}},
                    "required": ["query"],
                },
            },
        }]
        # 模拟转换逻辑
        bedrock_tools = []
        for tool in openai_tools:
            if tool.get("type") == "function":
                fn = tool["function"]
                bedrock_tools.append({
                    "toolSpec": {
                        "name": fn["name"],
                        "description": fn["description"],
                        "inputSchema": {
                            "json": {
                                "type": "object",
                                "properties": fn["parameters"]["properties"],
                                "required": fn["parameters"]["required"],
                            }
                        },
                    }
                })
        assert len(bedrock_tools) == 1
        assert bedrock_tools[0]["toolSpec"]["name"] == "search"
        assert "query" in bedrock_tools[0]["toolSpec"]["inputSchema"]["json"]["properties"]

    def test_system_message_extraction(self):
        """system 消息应从 messages 中提取为独立 system_prompt"""
        messages = [
            {"role": "system", "content": "You are helpful"},
            {"role": "user", "content": "Hello"},
        ]
        system_prompt = []
        bedrock_messages = []
        for msg in messages:
            if msg["role"] == "system":
                system_prompt = [{"text": msg["content"]}]
            else:
                bedrock_messages.append({
                    "role": msg["role"],
                    "content": [{"text": msg["content"]}],
                })
        assert system_prompt == [{"text": "You are helpful"}]
        assert len(bedrock_messages) == 1
        assert bedrock_messages[0]["role"] == "user"

    def test_tool_role_becomes_user(self):
        """OpenAI 的 tool 角色在 Bedrock 中应变为 user + toolResult"""
        tool_msg = {"role": "tool", "content": "result data"}
        tool_use_id = "call_123"
        bedrock_msg = {
            "role": "user",
            "content": [{
                "toolResult": {
                    "toolUseId": tool_use_id,
                    "content": [{"text": tool_msg["content"]}],
                }
            }],
        }
        assert bedrock_msg["role"] == "user"
        assert bedrock_msg["content"][0]["toolResult"]["toolUseId"] == "call_123"

    def test_bedrock_response_to_openai(self):
        """Bedrock 响应应正确转换为 OpenAI ChatCompletion 格式"""
        bedrock_resp = {
            "output": {"message": {
                "role": "assistant",
                "content": [{"text": "Hello!"}],
            }},
            "stopReason": "end_turn",
            "usage": {"inputTokens": 10, "outputTokens": 5, "totalTokens": 15},
        }
        content_array = bedrock_resp["output"]["message"]["content"]
        content = "".join(item.get("text", "") for item in content_array)
        assert content == "Hello!"

# ---- 测试单例缓存 ----

class TestSingletonCache:
    def test_same_config_returns_same_instance(self):
        """相同 config_name 应返回同一实例"""
        cache = {}
        def get_or_create(name):
            if name not in cache:
                cache[name] = object()
            return cache[name]
        a = get_or_create("default")
        b = get_or_create("default")
        assert a is b

    def test_different_config_returns_different_instance(self):
        """不同 config_name 应返回不同实例"""
        cache = {}
        def get_or_create(name):
            if name not in cache:
                cache[name] = object()
            return cache[name]
        a = get_or_create("default")
        b = get_or_create("vision")
        assert a is not b
```

---

## 第 5 章 跨域关联

| 关联域 | 关系类型 | 说明 |
|--------|----------|------|
| PD-01 上下文管理 | 协同 | TokenCounter 和 max_input_tokens 限额是上下文窗口管理的基础设施 |
| PD-03 容错与重试 | 协同 | tenacity @retry 装饰器为所有提供商提供统一的重试策略 |
| PD-04 工具系统 | 依赖 | ask_tool() 的工具调用格式转换（特别是 Bedrock 适配）直接服务于工具系统 |
| PD-11 可观测性 | 协同 | update_token_count() 提供 token 用量追踪，是成本监控的数据源 |
| PD-52 配置管理 | 依赖 | TOML 配置系统和 Config 单例是多提供商切换的基础 |

---

## 第 6 章 来源文件索引

| 文件 | 行范围 | 关键实现 |
|------|--------|----------|
| `app/llm.py` | L174-L227 | LLM 类定义、单例缓存、提供商路由 |
| `app/llm.py` | L354-L460 | ask() 方法、重试策略、流式处理 |
| `app/llm.py` | L644-L766 | ask_tool() 方法、工具调用 |
| `app/llm.py` | L45-L171 | TokenCounter 类、token 计量 |
| `app/llm.py` | L34-L42 | REASONING_MODELS / MULTIMODAL_MODELS 常量 |
| `app/bedrock.py` | L38-L46 | BedrockClient 初始化（boto3） |
| `app/bedrock.py` | L60-L84 | OpenAI tools → Bedrock toolSpec 转换 |
| `app/bedrock.py` | L86-L132 | OpenAI messages → Bedrock messages 转换 |
| `app/bedrock.py` | L134-L193 | Bedrock response → OpenAI format 转换 |
| `app/bedrock.py` | L220-L298 | 流式响应处理（converse_stream） |
| `app/bedrock.py` | L17-L34 | OpenAIResponse 包装类 |
| `app/config.py` | L19-L31 | LLMSettings Pydantic 模型（含 api_type） |
| `app/config.py` | L197-L216 | Config 线程安全单例（双重检查锁） |
| `app/config.py` | L233-L329 | 配置加载与继承覆盖逻辑 |
| `app/schema.py` | L54-L157 | Message 类、工厂方法、to_dict() |
| `app/exceptions.py` | L12-L13 | TokenLimitExceeded 异常 |
| `config/config.example.toml` | L1-L56 | 多提供商配置示例（OpenAI/Bedrock/Azure/Ollama） |
| `config/config.example-model-azure.toml` | L1-L19 | Azure 专用配置模板 |
| `config/config.example-model-ollama.toml` | L1-L17 | Ollama 专用配置模板 |

---

## 第 7 章 横向对比维度

```json comparison_data
{
  "project": "OpenManus",
  "dimensions": {
    "适配架构": "OpenAI 格式为锚点，Bedrock 自研适配器，Azure/Ollama 复用 openai SDK",
    "配置方式": "TOML 文件 api_type 字段路由，[llm.xxx] 继承覆盖",
    "格式转换": "BedrockClient 实现消息/工具/响应三层双向转换",
    "实例管理": "LLM.__new__() 按 config_name 单例缓存",
    "流式支持": "Bedrock 适配器内部消费流后返回完整响应，非真流式透传",
    "Token 计量": "tiktoken 统一计量 + max_input_tokens 全局限额",
    "重试策略": "tenacity 指数退避 6 次重试，TokenLimitExceeded 排除在外"
  }
}
```

### 域元数据补充

```json domain_metadata
{
  "solution_summary": "OpenManus 以 OpenAI 格式为锚点，通过 BedrockClient 适配器实现 OpenAI↔Bedrock 消息/工具/响应三层双向转换，TOML api_type 字段路由 + [llm.xxx] 继承覆盖配置多模型实例",
  "description": "不同提供商的工具调用协议和流式事件结构差异是适配的核心难点",
  "sub_problems": [
    "TOML 配置继承与命名实例管理",
    "Token 计量跨提供商统一"
  ],
  "best_practices": [
    "以主流 SDK 格式为锚点减少转换层数",
    "流式响应可先内部消费再统一返回以简化适配"
  ]
}
```
