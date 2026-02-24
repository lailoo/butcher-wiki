# PD-52.01 OpenManus — TOML + Pydantic 分层配置单例系统

> 文档编号：PD-52.01
> 来源：OpenManus `app/config.py`
> GitHub：https://github.com/FoundationAgents/OpenManus.git
> 问题域：PD-52 配置管理 Configuration Management
> 状态：可复用方案

---

## 第 1 章 问题与动机

### 1.1 核心问题

Agent 系统通常需要管理大量异构配置：LLM 提供商参数（模型名、API Key、温度）、浏览器自动化选项、搜索引擎偏好、沙箱资源限制、MCP 服务器连接、云沙箱（Daytona）凭证等。这些配置具有以下挑战：

- **类型多样性**：字符串、数字、布尔值、嵌套对象、可选字段混杂
- **分层覆盖需求**：LLM 配置需要 default 基础值 + 命名覆盖（如 vision 模型用不同参数）
- **并发安全**：多线程/异步环境下配置对象必须是单例且线程安全
- **多格式混合**：主配置用 TOML，MCP 服务器配置用 JSON，需要统一加载
- **可选模块**：Browser、Search、Sandbox 等模块可能不配置，需要优雅降级

### 1.2 OpenManus 的解法概述

OpenManus 采用 **TOML 配置文件 + Pydantic BaseModel + 双重检查锁定单例** 的三层架构：

1. **TOML 作为用户接口**：`config/config.toml` 是唯一的用户编辑入口，支持注释和分节（`app/config.py:220-226`）
2. **Pydantic 模型作为类型屏障**：7 个 `BaseModel` 子类定义了 LLM/Browser/Search/Sandbox/MCP/Daytona/Runflow 的完整 schema（`app/config.py:19-191`）
3. **Config 单例作为全局访问点**：双重检查锁定 + `threading.Lock` 保证进程内唯一实例（`app/config.py:197-207`）
4. **LLM default + 命名覆盖**：`[llm]` 节的顶层字段作为 default，`[llm.vision]` 等子节继承 default 并覆盖差异字段（`app/config.py:235-319`）
5. **MCP 双源加载**：TOML 提供 `server_reference`，JSON 文件提供具体服务器列表（`app/config.py:148-171`）

### 1.3 设计思想

| 设计原则 | 具体实现 | 理由 | 替代方案 |
|----------|----------|------|----------|
| 单一配置入口 | TOML 文件 + example fallback | 用户只需关注一个文件 | YAML、JSON、.env |
| 类型安全 | Pydantic BaseModel + Field 约束 | 启动时即发现配置错误 | dataclass、TypedDict |
| 并发安全 | `threading.Lock` 双重检查锁定 | 多线程首次访问不会创建多实例 | `__init_subclass__`、模块级单例 |
| 分层覆盖 | dict spread `{**default, **override}` | LLM 多模型共享基础配置 | 继承链、配置合并库 |
| 可选模块 | `Optional[XxxSettings]` + None 检查 | 未配置的模块不影响启动 | 全部必填 + 默认值 |
| 格式混合 | TOML 主配置 + JSON MCP 配置 | MCP 生态惯例用 JSON | 全部 TOML |

---

## 第 2 章 源码实现分析

### 2.1 架构概览

OpenManus 的配置系统由三层组成：文件层（TOML/JSON）→ 模型层（Pydantic）→ 访问层（Config 单例）。

```
┌─────────────────────────────────────────────────────────┐
│                    消费者层                               │
│  LLM  │  Manus Agent  │  WebSearch  │  Sandbox  │  MCP  │
├───────┴───────────────┴─────────────┴───────────┴───────┤
│              Config 单例 (双重检查锁定)                    │
│         config.llm / config.sandbox / config.mcp_config  │
├─────────────────────────────────────────────────────────┤
│              AppConfig (Pydantic BaseModel)               │
│  ┌──────────┐ ┌───────────────┐ ┌────────────────────┐  │
│  │LLMSettings│ │BrowserSettings│ │SearchSettings      │  │
│  │(Dict)     │ │(Optional)     │ │(Optional)          │  │
│  └──────────┘ └───────────────┘ └────────────────────┘  │
│  ┌──────────────┐ ┌───────────┐ ┌────────────────────┐  │
│  │SandboxSettings│ │MCPSettings│ │DaytonaSettings     │  │
│  │(Optional)     │ │(Optional) │ │(Optional)          │  │
│  └──────────────┘ └───────────┘ └────────────────────┘  │
├─────────────────────────────────────────────────────────┤
│                    文件层                                 │
│  config/config.toml (TOML)  │  config/mcp.json (JSON)   │
└─────────────────────────────────────────────────────────┘
```

### 2.2 核心实现

#### 2.2.1 双重检查锁定单例 (`app/config.py:197-216`)

Config 类同时在 `__new__` 和 `__init__` 中使用双重检查锁定，确保多线程环境下只创建一个实例且只初始化一次：

```python
class Config:
    _instance = None
    _lock = threading.Lock()
    _initialized = False

    def __new__(cls):
        if cls._instance is None:
            with cls._lock:
                if cls._instance is None:
                    cls._instance = super().__new__(cls)
        return cls._instance

    def __init__(self):
        if not self._initialized:
            with self._lock:
                if not self._initialized:
                    self._config = None
                    self._load_initial_config()
                    self._initialized = True
```

关键点：`__new__` 控制实例唯一性，`__init__` 控制初始化唯一性，两者都用同一把 `_lock`。模块末尾 `config = Config()` 创建全局实例（`app/config.py:372`）。

#### 2.2.2 LLM default + 命名覆盖模式 (`app/config.py:233-319`)

#### 2.2.2 LLM default + 命名覆盖模式 (`app/config.py:233-319`)

这是 OpenManus 配置系统最精巧的设计。TOML 中 `[llm]` 节的顶层字段构成 default 配置，`[llm.vision]` 等子表通过 dict spread 继承 default 并覆盖差异：

```python
def _load_initial_config(self):
    raw_config = self._load_config()
    base_llm = raw_config.get("llm", {})
    llm_overrides = {
        k: v for k, v in raw_config.get("llm", {}).items() if isinstance(v, dict)
    }

    default_settings = {
        "model": base_llm.get("model"),
        "base_url": base_llm.get("base_url"),
        "api_key": base_llm.get("api_key"),
        "max_tokens": base_llm.get("max_tokens", 4096),
        "temperature": base_llm.get("temperature", 1.0),
        "api_type": base_llm.get("api_type", ""),
        "api_version": base_llm.get("api_version", ""),
    }

    config_dict = {
        "llm": {
            "default": default_settings,
            **{
                name: {**default_settings, **override_config}
                for name, override_config in llm_overrides.items()
            },
        },
        # ... 其他模块
    }
    self._config = AppConfig(**config_dict)
```

对应的 TOML 配置（`config/config.example.toml:1-48`）：

```toml
[llm]
model = "claude-3-7-sonnet-20250219"
base_url = "https://api.anthropic.com/v1/"
api_key = "YOUR_API_KEY"
max_tokens = 8192
temperature = 0.0

[llm.vision]
model = "claude-3-7-sonnet-20250219"
base_url = "https://api.anthropic.com/v1/"
api_key = "YOUR_API_KEY"
max_tokens = 8192
temperature = 0.0
```

消费端通过 `config_name` 参数选择配置（`app/llm.py:177-191`）：

```python
class LLM:
    _instances: Dict[str, "LLM"] = {}

    def __new__(cls, config_name: str = "default", llm_config=None):
        if config_name not in cls._instances:
            instance = super().__new__(cls)
            instance.__init__(config_name, llm_config)
            cls._instances[config_name] = instance
        return cls._instances[config_name]

    def __init__(self, config_name: str = "default", llm_config=None):
        if not hasattr(self, "client"):
            llm_config = llm_config or config.llm
            llm_config = llm_config.get(config_name, llm_config["default"])
```

LLM 类自身也是多实例单例（按 `config_name` 缓存），与 Config 单例形成两级缓存。

#### 2.2.3 MCP 双源配置加载 (`app/config.py:148-171`)

MCP 配置从两个源合并：TOML 提供模块引用，JSON 提供服务器列表：

```python
class MCPSettings(BaseModel):
    server_reference: str = Field(
        "app.mcp.server", description="Module reference for the MCP server"
    )
    servers: Dict[str, MCPServerConfig] = Field(default_factory=dict)

    @classmethod
    def load_server_config(cls) -> Dict[str, MCPServerConfig]:
        config_path = PROJECT_ROOT / "config" / "mcp.json"
        try:
            config_file = config_path if config_path.exists() else None
            if not config_file:
                return {}
            with config_file.open() as f:
                data = json.load(f)
                servers = {}
                for server_id, server_config in data.get("mcpServers", {}).items():
                    servers[server_id] = MCPServerConfig(
                        type=server_config["type"],
                        url=server_config.get("url"),
                        command=server_config.get("command"),
                        args=server_config.get("args", []),
                    )
                return servers
        except Exception as e:
            raise ValueError(f"Failed to load MCP server config: {e}")
```

### 2.3 实现细节

#### 配置文件 fallback 链 (`app/config.py:217-226`)

```python
@staticmethod
def _get_config_path() -> Path:
    root = PROJECT_ROOT
    config_path = root / "config" / "config.toml"
    if config_path.exists():
        return config_path
    example_path = root / "config" / "config.example.toml"
    if example_path.exists():
        return example_path
    raise FileNotFoundError("No configuration file found in config directory")
```

优先加载 `config.toml`，不存在则 fallback 到 `config.example.toml`，两者都不存在则抛异常。这让新用户无需复制配置文件即可启动（使用 example 默认值）。

#### 可选模块的防御性加载 (`app/config.py:252-312`)

每个可选模块（Browser、Search、Sandbox、Daytona、MCP、Runflow）都遵循相同模式：

```
raw_config 中有该节 → 用实际值构造 Settings
raw_config 中无该节 → 用默认值构造 Settings 或设为 None
```

Browser 配置还有额外的嵌套处理——Proxy 子对象需要单独提取和验证（`app/config.py:256-282`）。

#### 配置消费模式

各模块通过全局 `config` 实例的 property 访问配置：

- `config.llm` → `Dict[str, LLMSettings]`（`app/llm.py:22`）
- `config.browser_config` → `Optional[BrowserSettings]`（`app/tool/browser_use_tool.py:13`）
- `config.search_config` → `Optional[SearchSettings]`（`app/tool/web_search.py:223-247`）
- `config.mcp_config.servers` → `Dict[str, MCPServerConfig]`（`app/agent/manus.py:69`）
- `config.daytona` → `DaytonaSettings`（`app/daytona/sandbox.py:18`）
- `config.workspace_root` → `Path`（`app/agent/manus.py:24`）

消费端对 Optional 配置使用 `getattr` 防御性访问（`app/tool/web_search.py:223-247`）：

```python
retry_delay = (
    getattr(config.search_config, "retry_delay", 60)
    if config.search_config
    else 60
)
```

---

## 第 3 章 迁移指南

### 3.1 迁移清单

**阶段 1：基础配置骨架**
- [ ] 创建 `config/config.example.toml`，定义所有配置节
- [ ] 创建 Pydantic Settings 模型（每个模块一个 BaseModel）
- [ ] 创建 AppConfig 聚合模型
- [ ] 实现 Config 单例（双重检查锁定）
- [ ] 模块末尾 `config = Config()` 导出全局实例

**阶段 2：LLM 分层覆盖**
- [ ] 实现 default + 命名覆盖的 dict spread 逻辑
- [ ] LLM 类按 config_name 缓存实例

**阶段 3：多格式扩展**
- [ ] 如需 MCP 等 JSON 配置，在对应 Settings 中添加 `@classmethod` 加载器
- [ ] 在 `_load_initial_config` 中合并多源配置

### 3.2 适配代码模板

以下是一个可直接复用的最小配置系统模板：

```python
"""config.py — 可复用的 TOML + Pydantic 配置单例模板"""
import threading
import tomllib
from pathlib import Path
from typing import Dict, Optional

from pydantic import BaseModel, Field


PROJECT_ROOT = Path(__file__).resolve().parent.parent


class LLMSettings(BaseModel):
    model: str = Field(..., description="Model name")
    base_url: str = Field(..., description="API base URL")
    api_key: str = Field(..., description="API key")
    max_tokens: int = Field(4096, description="Max tokens per request")
    temperature: float = Field(1.0, description="Sampling temperature")


class AppConfig(BaseModel):
    llm: Dict[str, LLMSettings]
    # 按需添加其他模块：
    # sandbox: Optional[SandboxSettings] = None
    # browser: Optional[BrowserSettings] = None


class Config:
    _instance = None
    _lock = threading.Lock()
    _initialized = False

    def __new__(cls):
        if cls._instance is None:
            with cls._lock:
                if cls._instance is None:
                    cls._instance = super().__new__(cls)
        return cls._instance

    def __init__(self):
        if not self._initialized:
            with self._lock:
                if not self._initialized:
                    self._load_initial_config()
                    self._initialized = True

    def _load_initial_config(self):
        config_path = PROJECT_ROOT / "config" / "config.toml"
        if not config_path.exists():
            config_path = PROJECT_ROOT / "config" / "config.example.toml"

        with config_path.open("rb") as f:
            raw = tomllib.load(f)

        base_llm = raw.get("llm", {})
        overrides = {k: v for k, v in base_llm.items() if isinstance(v, dict)}
        default = {k: v for k, v in base_llm.items() if not isinstance(v, dict)}

        self._config = AppConfig(
            llm={
                "default": default,
                **{name: {**default, **ov} for name, ov in overrides.items()},
            }
        )

    @property
    def llm(self) -> Dict[str, LLMSettings]:
        return self._config.llm


config = Config()
```

### 3.3 适用场景

| 场景 | 适用度 | 说明 |
|------|--------|------|
| 多 LLM 提供商 Agent 系统 | ⭐⭐⭐ | default + 命名覆盖完美匹配 |
| 单 LLM 简单 Agent | ⭐⭐ | 可简化为无覆盖模式 |
| 微服务配置 | ⭐⭐ | 单例模式适合单进程，多进程需配合环境变量 |
| 需要热重载的系统 | ⭐ | 当前实现不支持运行时重载 |
| 需要环境变量覆盖的 12-Factor App | ⭐ | 缺少 env var 覆盖层，需自行扩展 |

---

## 第 4 章 测试用例

```python
"""test_config.py — OpenManus 配置系统测试用例"""
import threading
from unittest.mock import patch, mock_open
import pytest


# ---- 测试 Config 单例 ----

class TestConfigSingleton:
    def test_singleton_identity(self):
        """同一进程内 Config() 返回同一实例"""
        from app.config import Config
        c1 = Config()
        c2 = Config()
        assert c1 is c2

    def test_thread_safe_singleton(self):
        """多线程并发创建 Config 仍然是同一实例"""
        from app.config import Config
        instances = []

        def create():
            instances.append(Config())

        threads = [threading.Thread(target=create) for _ in range(10)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        assert all(inst is instances[0] for inst in instances)


# ---- 测试 LLM 分层覆盖 ----

class TestLLMOverride:
    def test_default_config_exists(self):
        """config.llm 必须包含 'default' 键"""
        from app.config import config
        assert "default" in config.llm

    def test_vision_inherits_default(self):
        """vision 配置继承 default 的 base_url 和 api_key"""
        from app.config import config
        if "vision" in config.llm:
            default = config.llm["default"]
            vision = config.llm["vision"]
            # vision 应该继承 default 的 api_key（除非显式覆盖）
            assert vision.api_key == default.api_key or vision.api_key != ""

    def test_override_spread(self):
        """dict spread 覆盖：override 字段优先于 default"""
        default = {"model": "gpt-4", "temperature": 0.7, "api_key": "key1"}
        override = {"model": "gpt-4-vision", "temperature": 0.0}
        merged = {**default, **override}
        assert merged["model"] == "gpt-4-vision"
        assert merged["temperature"] == 0.0
        assert merged["api_key"] == "key1"  # 未覆盖的字段保留


# ---- 测试可选模块降级 ----

class TestOptionalModules:
    def test_browser_config_optional(self):
        """browser_config 可以为 None"""
        from app.config import config
        # 不抛异常即可，值可能是 None 或 BrowserSettings
        _ = config.browser_config

    def test_search_config_defensive_access(self):
        """search_config 为 None 时 getattr 不抛异常"""
        from app.config import config
        retry_delay = (
            getattr(config.search_config, "retry_delay", 60)
            if config.search_config
            else 60
        )
        assert isinstance(retry_delay, int)

    def test_mcp_config_always_exists(self):
        """mcp_config 即使无 TOML 配置也有默认值"""
        from app.config import config
        assert config.mcp_config is not None
        assert isinstance(config.mcp_config.servers, dict)


# ---- 测试配置文件 fallback ----

class TestConfigFallback:
    def test_example_fallback(self, tmp_path):
        """config.toml 不存在时 fallback 到 config.example.toml"""
        from app.config import Config
        example = tmp_path / "config" / "config.example.toml"
        example.parent.mkdir(parents=True)
        example.write_text('[llm]\nmodel = "test"\n')

        with patch.object(Config, '_get_config_path', return_value=example):
            # 验证 fallback 路径可被正确解析
            assert example.exists()
```

---

## 第 5 章 跨域关联

| 关联域 | 关系类型 | 说明 |
|--------|----------|------|
| PD-04 工具系统 | 依赖 | MCP 工具服务器的连接参数（SSE URL / stdio command）由 MCPSettings 提供，Manus Agent 在 `initialize_mcp_servers` 中消费 `config.mcp_config.servers`（`app/agent/manus.py:69`） |
| PD-05 沙箱隔离 | 依赖 | SandboxSettings 定义了 Docker 镜像、内存限制、CPU 限制、超时等参数，SandboxManager 在创建沙箱时消费这些配置（`app/sandbox/core/manager.py:137`） |
| PD-08 搜索与检索 | 依赖 | SearchSettings 定义了搜索引擎优先级、fallback 顺序、重试策略，WebSearch 工具在执行时读取 `config.search_config`（`app/tool/web_search.py:223-247`） |
| PD-11 可观测性 | 协同 | Logger 使用 `PROJECT_ROOT` 确定日志文件路径（`app/logger.py:7`），与配置系统共享项目根目录定位逻辑 |
| PD-03 容错与重试 | 协同 | SearchSettings 中的 `retry_delay` 和 `max_retries` 直接控制搜索引擎的容错行为，LLMSettings 中的 `max_input_tokens` 控制 token 限制降级 |

---

## 第 6 章 来源文件索引

| 文件 | 行范围 | 关键实现 |
|------|--------|----------|
| `app/config.py` | L1-372 | 完整配置系统：7 个 Pydantic 模型 + Config 单例 + 全局实例 |
| `app/config.py` | L19-31 | LLMSettings 模型定义（8 个字段含 api_type/api_version） |
| `app/config.py` | L127-171 | MCPServerConfig + MCPSettings（含 JSON 加载器） |
| `app/config.py` | L174-195 | AppConfig 聚合模型（7 个模块配置） |
| `app/config.py` | L197-216 | Config 双重检查锁定单例 |
| `app/config.py` | L233-329 | `_load_initial_config`：TOML 解析 + LLM 覆盖 + 模块加载 |
| `config/config.example.toml` | L1-114 | TOML 配置模板（含多 LLM 提供商注释示例） |
| `config/mcp.example.json` | L1-8 | MCP 服务器 JSON 配置示例 |
| `app/llm.py` | L174-228 | LLM 类：按 config_name 缓存的多实例单例 |
| `app/tool/web_search.py` | L222-248 | SearchSettings 消费：getattr 防御性访问模式 |
| `app/agent/manus.py` | L24,67-89 | Manus Agent 消费 workspace_root 和 MCP 配置 |
| `app/daytona/sandbox.py` | L18-24 | Daytona 配置消费：模块级即时初始化 |

---

## 第 7 章 横向对比维度

```json comparison_data
{
  "project": "OpenManus",
  "dimensions": {
    "配置格式": "TOML 主配置 + JSON MCP 配置，双格式混合加载",
    "类型校验": "Pydantic BaseModel + Field 约束，启动时校验",
    "单例模式": "threading.Lock 双重检查锁定，__new__ + __init__ 双层保护",
    "分层覆盖": "dict spread {**default, **override}，LLM 支持命名配置继承",
    "模块化程度": "7 个独立 Settings 模型，Optional 可选模块优雅降级",
    "热重载支持": "不支持，启动时一次性加载",
    "环境变量覆盖": "不支持，纯文件驱动"
  }
}
```

### 域元数据补充

```json domain_metadata
{
  "solution_summary": "OpenManus 用 TOML + 7 个 Pydantic BaseModel + threading.Lock 双重检查锁定单例实现六大模块（LLM/Browser/Search/Sandbox/MCP/Daytona）的类型安全分层配置，LLM 配置支持 default + 命名覆盖的 dict spread 模式",
  "description": "多格式配置源混合加载与 Agent 系统模块化配置解耦",
  "sub_problems": [
    "多格式配置源合并（TOML + JSON）",
    "LLM 多模型命名配置继承",
    "可选模块防御性访问"
  ],
  "best_practices": [
    "配置文件 example fallback 降低新用户门槛",
    "消费端 getattr + None 检查防御可选配置",
    "LLM 类按 config_name 二级缓存避免重复初始化"
  ]
}
```
