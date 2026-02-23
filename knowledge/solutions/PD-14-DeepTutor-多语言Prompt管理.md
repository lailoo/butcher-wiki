# PD-14.01 DeepTutor — 多语言 Prompt 管理系统

> 文档编号：PD-14.01
> 来源：DeepTutor `src/services/prompt/manager.py`
> GitHub：https://github.com/HKUDS/DeepTutor
> 问题域：PD-14 多语言 Prompt 管理 Multi-Language Prompt Management
> 状态：可复用方案

---

## 第 1 章 问题与动机

### 1.1 核心问题

Agent 系统中 prompt 管理面临三个工程痛点：

1. **Prompt 硬编码耦合** — prompt 字符串散落在各 Agent 的 Python 代码中，修改 prompt 需要改代码、重新部署。非技术人员（如 prompt 工程师、翻译人员）无法独立维护 prompt 内容。
2. **多语言支持困难** — 国际化场景下，每个 Agent 需要维护多语言版本的 prompt。缺少统一的语言切换和 fallback 机制，容易出现某语言缺失时系统崩溃。
3. **重复加载与性能浪费** — 同一个 Agent 的 prompt 在多次调用中被反复从磁盘读取和解析，缺少缓存层导致不必要的 I/O 开销。

DeepTutor 作为一个面向 STEM 教育的多模块 AI 辅导系统（含 research、solve、guide、question、ideagen、co_writer 六大模块），拥有 50+ 个 YAML prompt 文件、覆盖中英双语，是该问题域的典型实践案例。

### 1.2 DeepTutor 的解法概述

1. **YAML 外部化** — 所有 prompt 从 Python 代码中剥离，存储为 `prompts/{lang}/{agent_name}.yaml` 文件，支持多 section（system、user_template、context_template 等）（`src/agents/chat/prompts/en/chat_agent.yaml:1-36`）
2. **三级目录组织** — 按 `module/prompts/language/agent.yaml` 层级组织，支持子目录嵌套如 `solve/prompts/en/solve_loop/solve_agent.yaml`（`src/services/prompt/manager.py:84`）
3. **Singleton + 全局缓存** — PromptManager 采用单例模式 + 类级别字典缓存，首次加载后内存命中（`src/services/prompt/manager.py:16-34`）
4. **语言 Fallback 链** — 定义 `zh → cn → en`、`en → zh → cn` 的降级链，缺失翻译时自动回退（`src/services/prompt/manager.py:23-26`）
5. **BaseAgent 统一集成** — 所有 Agent 继承 BaseAgent，构造函数自动通过 PromptManager 加载 prompt，无需手动调用（`src/agents/base_agent.py:136-147`）

### 1.3 设计思想

| 设计原则 | 具体实现 | 理由 | 替代方案 |
|----------|----------|------|----------|
| Prompt 即配置 | YAML 文件外部化，与代码完全分离 | 允许非开发者独立编辑 prompt | JSON 文件（不支持多行字符串）、数据库存储（过重） |
| 约定优于配置 | `module/prompts/lang/agent.yaml` 固定路径约定 | 无需额外配置文件指定路径 | 配置文件映射（增加维护成本） |
| 单例 + 缓存 | 类级别 `_cache` 字典 + `__new__` 单例 | 避免重复 I/O，全局一致性 | 模块级缓存（无法统一清除） |
| 优雅降级 | Fallback 链 + 空字典兜底 | 缺失翻译不崩溃，返回默认语言 | 启动时校验完整性（严格但脆弱） |
| 递归发现 | `rglob` 在子目录中搜索 YAML | 支持 solve 模块的嵌套子目录结构 | 显式注册每个文件路径（繁琐） |

---

## 第 2 章 源码实现分析

### 2.1 架构概览

```
┌─────────────────────────────────────────────────────────┐
│                     BaseAgent.__init__                    │
│  get_prompt_manager().load_prompts(module, agent, lang)  │
└──────────────────────────┬──────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────┐
│                   PromptManager (Singleton)               │
│                                                           │
│  load_prompts(module, agent, lang, subdir?)               │
│       │                                                   │
│       ├─ _build_cache_key() → "module_agent_lang_subdir"  │
│       ├─ cache hit? → return _cache[key]                  │
│       └─ cache miss? → _load_with_fallback()              │
│              │                                            │
│              ├─ LANGUAGE_FALLBACKS[lang] → [zh, cn, en]   │
│              └─ for each fallback_lang:                   │
│                   _resolve_prompt_path()                  │
│                     ├─ subdir/agent.yaml (优先)            │
│                     ├─ lang/agent.yaml (直接)              │
│                     └─ lang/**/agent.yaml (rglob)         │
│                                                           │
│  get_prompt(prompts, section, field?, fallback?)          │
│  clear_cache(module?) / reload_prompts(...)               │
└─────────────────────────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────┐
│              YAML Prompt Files (磁盘)                     │
│                                                           │
│  src/agents/                                              │
│  ├── chat/prompts/en/chat_agent.yaml                     │
│  ├── chat/prompts/zh/chat_agent.yaml                     │
│  ├── research/prompts/en/research_agent.yaml             │
│  ├── solve/prompts/en/solve_loop/solve_agent.yaml        │
│  ├── guide/prompts/en/chat_agent.yaml                    │
│  ├── question/prompts/en/generate_agent.yaml             │
│  ├── ideagen/prompts/en/idea_generation.yaml             │
│  └── co_writer/prompts/en/edit_agent.yaml                │
│                                                           │
│  6 modules × ~4 agents × 2 languages = 50+ YAML files   │
└─────────────────────────────────────────────────────────┘
```

### 2.2 核心实现

#### PromptManager 单例与缓存（`src/services/prompt/manager.py:16-34`）

```python
class PromptManager:
    """Unified prompt manager with singleton pattern and global caching."""

    _instance: "PromptManager | None" = None
    _cache: dict[str, dict[str, Any]] = {}

    # Language fallback chain: if primary language not found, try alternatives
    LANGUAGE_FALLBACKS = {
        "zh": ["zh", "cn", "en"],
        "en": ["en", "zh", "cn"],
    }

    MODULES = ["research", "solve", "guide", "question", "ideagen", "co_writer"]

    def __new__(cls) -> "PromptManager":
        if cls._instance is None:
            cls._instance = super().__new__(cls)
        return cls._instance
```

关键设计点：
- `_cache` 是类变量而非实例变量，确保即使单例被重建缓存也不丢失
- `LANGUAGE_FALLBACKS` 硬编码在类中，`zh` 会先尝试 `cn`（兼容旧目录名）再 fallback 到 `en`
- `MODULES` 列表用于文档和校验，实际加载不做模块名校验（灵活性优先）

#### 带 Fallback 的加载流程（`src/services/prompt/manager.py:76-98`）

```python
def _load_with_fallback(self, module_name, agent_name, lang_code, subdirectory):
    """Load prompt file with language fallback."""
    prompts_dir = PROJECT_ROOT / "src" / "agents" / module_name / "prompts"
    fallback_chain = self.LANGUAGE_FALLBACKS.get(lang_code, ["en"])

    for lang in fallback_chain:
        prompt_file = self._resolve_prompt_path(prompts_dir, lang, agent_name, subdirectory)
        if prompt_file and prompt_file.exists():
            try:
                with open(prompt_file, encoding="utf-8") as f:
                    return yaml.safe_load(f) or {}
            except Exception as e:
                print(f"Warning: Failed to load {prompt_file}: {e}")
                continue

    print(f"Warning: No prompt file found for {module_name}/{agent_name}")
    return {}
```

关键设计点：
- 未知语言码的 fallback 默认为 `["en"]`（`src/services/prompt/manager.py:85`）
- YAML 解析失败不抛异常，`continue` 尝试下一个 fallback 语言
- 最终兜底返回空字典 `{}`，调用方通过 `get_prompt()` 的 fallback 参数处理缺失

#### 路径解析三级策略（`src/services/prompt/manager.py:100-129`）

```python
def _resolve_prompt_path(self, prompts_dir, lang, agent_name, subdirectory):
    lang_dir = prompts_dir / lang
    if not lang_dir.exists():
        return None

    # 1. 子目录优先
    if subdirectory:
        direct_path = lang_dir / subdirectory / f"{agent_name}.yaml"
        if direct_path.exists():
            return direct_path

    # 2. 直接路径
    direct_path = lang_dir / f"{agent_name}.yaml"
    if direct_path.exists():
        return direct_path

    # 3. 递归搜索
    found = list(lang_dir.rglob(f"{agent_name}.yaml"))
    if found:
        return found[0]

    return None
```

这个三级策略解决了 solve 模块的嵌套目录问题：`solve/prompts/en/solve_loop/solve_agent.yaml` 和 `solve/prompts/en/analysis_loop/investigate_agent.yaml` 分属不同子目录。

#### BaseAgent 自动集成（`src/agents/base_agent.py:136-147`）

```python
# Load prompts using unified PromptManager
try:
    self.prompts = get_prompt_manager().load_prompts(
        module_name=module_name,
        agent_name=agent_name,
        language=language,
    )
    if self.prompts:
        self.logger.debug(f"Prompts loaded: {agent_name} ({language})")
except Exception as e:
    self.prompts = None
    self.logger.warning(f"Failed to load prompts for {agent_name}: {e}")
```

所有 6 个模块的 Agent 继承 BaseAgent，构造时自动加载 prompt。加载失败设为 `None` 而非崩溃，体现防御性编程。

### 2.3 实现细节

#### 语言标准化（`src/services/config/loader.py:173-197`）

`parse_language()` 将多种输入格式统一为 `"zh"` 或 `"en"`：

```python
def parse_language(language: Any) -> str:
    if not language:
        return "zh"
    if isinstance(language, str):
        lang_lower = language.lower()
        if lang_lower in ["en", "english"]:
            return "en"
        if lang_lower in ["zh", "chinese", "cn"]:
            return "zh"
    return "zh"  # Default Chinese
```

默认语言为中文（`zh`），反映 DeepTutor 的主要用户群体（香港大学）。

#### YAML Prompt 文件结构

每个 YAML 文件采用扁平 key-value 结构，value 使用 YAML 多行字符串（`|`）：

```yaml
# src/agents/chat/prompts/en/chat_agent.yaml
system: |
  You are DeepTutor, an intelligent AI learning assistant...

context_template: |
  Here is some reference context...
  <context>
  {context}
  </context>

user_template: |
  {message}

history_format: |
  Previous conversation:
  {history}
```

中文版本（`src/agents/chat/prompts/zh/chat_agent.yaml`）保持完全相同的 key 结构，仅替换 value 内容：

```yaml
system: |
  你是 DeepTutor，一个由香港大学数据智能实验室开发的智能 AI 学习助手。

context_template: |
  以下是一些可能有助于回答问题的参考上下文：
  <context>
  {context}
  </context>
```

#### 缓存键设计（`src/services/prompt/manager.py:65-74`）

缓存键格式为 `{module}_{agent}_{lang}[_{subdir}]`，例如：
- `research_research_agent_en`
- `solve_solve_agent_en_solve_loop`

`clear_cache(module_name)` 通过前缀匹配实现模块级缓存清除（`src/services/prompt/manager.py:164-176`），支持热重载场景下只刷新特定模块。

#### 数据流：从用户请求到 Prompt 注入

```
用户选择语言(zh/en) → parse_language() 标准化
    → BaseAgent.__init__(language=lang)
    → get_prompt_manager().load_prompts("chat", "chat_agent", "zh")
    → _build_cache_key() → "chat_chat_agent_zh"
    → cache miss → _load_with_fallback()
    → fallback_chain = ["zh", "cn", "en"]
    → _resolve_prompt_path(prompts_dir, "zh", "chat_agent", None)
    → 找到 src/agents/chat/prompts/zh/chat_agent.yaml
    → yaml.safe_load() → {"system": "你是 DeepTutor...", ...}
    → 缓存 + 返回
    → Agent 使用 pm.get_prompt(prompts, "system") 获取具体 prompt
```

---

## 第 3 章 迁移指南

### 3.1 迁移清单

**阶段 1：基础设施（1 个文件）**
- [ ] 创建 `services/prompt/manager.py`，实现 PromptManager 单例
- [ ] 定义 `LANGUAGE_FALLBACKS` 映射（根据项目需要扩展语言）
- [ ] 实现 `parse_language()` 标准化函数

**阶段 2：Prompt 外部化（按模块逐步）**
- [ ] 为每个 Agent 模块创建 `prompts/{lang}/` 目录
- [ ] 将硬编码 prompt 字符串提取到 YAML 文件
- [ ] 保持 YAML key 在不同语言间一致

**阶段 3：集成（修改 BaseAgent）**
- [ ] 在 BaseAgent 构造函数中注入 PromptManager 调用
- [ ] 移除各 Agent 中的 prompt 硬编码
- [ ] 添加 `get_prompt()` 安全访问方法

**阶段 4：验证**
- [ ] 单元测试覆盖：单例、缓存、fallback、reload
- [ ] 集成测试：每个模块的每种语言都能正确加载

### 3.2 适配代码模板

以下是一个可直接复用的最小化 PromptManager 实现：

```python
"""Minimal PromptManager — 可直接复制到任何 Agent 项目中使用。"""

from pathlib import Path
from typing import Any

import yaml


class PromptManager:
    _instance = None
    _cache: dict[str, dict[str, Any]] = {}

    LANGUAGE_FALLBACKS = {
        "zh": ["zh", "en"],
        "en": ["en", "zh"],
        "ja": ["ja", "en"],  # 按需扩展
    }

    def __new__(cls):
        if cls._instance is None:
            cls._instance = super().__new__(cls)
        return cls._instance

    def __init__(self, prompts_root: Path | None = None):
        if not hasattr(self, "_initialized"):
            # prompts_root: 项目中 agents/ 目录的路径
            self._prompts_root = prompts_root or Path("src/agents")
            self._initialized = True

    def load(
        self,
        module: str,
        agent: str,
        lang: str = "en",
        subdir: str | None = None,
    ) -> dict[str, Any]:
        key = f"{module}_{agent}_{lang}_{subdir or ''}"
        if key in self._cache:
            return self._cache[key]

        prompts = self._load_with_fallback(module, agent, lang, subdir)
        self._cache[key] = prompts
        return prompts

    def _load_with_fallback(self, module, agent, lang, subdir):
        base = self._prompts_root / module / "prompts"
        chain = self.LANGUAGE_FALLBACKS.get(lang, ["en"])

        for fallback_lang in chain:
            lang_dir = base / fallback_lang
            if not lang_dir.exists():
                continue

            # 子目录优先 → 直接路径 → 递归搜索
            candidates = []
            if subdir:
                candidates.append(lang_dir / subdir / f"{agent}.yaml")
            candidates.append(lang_dir / f"{agent}.yaml")

            for path in candidates:
                if path.exists():
                    with open(path, encoding="utf-8") as f:
                        return yaml.safe_load(f) or {}

            # 递归兜底
            found = list(lang_dir.rglob(f"{agent}.yaml"))
            if found:
                with open(found[0], encoding="utf-8") as f:
                    return yaml.safe_load(f) or {}

        return {}

    def get(self, prompts: dict, section: str, field: str | None = None, fallback: str = "") -> str:
        if section not in prompts:
            return fallback
        value = prompts[section]
        if field is None:
            return value if isinstance(value, str) else fallback
        if isinstance(value, dict) and field in value:
            result = value[field]
            return result if isinstance(result, str) else fallback
        return fallback

    def clear_cache(self, module: str | None = None):
        if module:
            self._cache = {k: v for k, v in self._cache.items() if not k.startswith(f"{module}_")}
        else:
            self._cache.clear()

    def reload(self, module: str, agent: str, lang: str = "en", subdir: str | None = None):
        key = f"{module}_{agent}_{lang}_{subdir or ''}"
        self._cache.pop(key, None)
        return self.load(module, agent, lang, subdir)
```

### 3.3 适用场景

| 场景 | 适用度 | 说明 |
|------|--------|------|
| 多语言 Agent 系统 | ⭐⭐⭐ | 核心场景，fallback 链确保任何语言都有可用 prompt |
| 单语言但需 prompt 迭代 | ⭐⭐⭐ | YAML 外部化让 prompt 工程师无需改代码 |
| 多模块 Agent 框架 | ⭐⭐⭐ | module/agent 两级组织天然适配 |
| 需要 A/B 测试 prompt | ⭐⭐ | 可通过 subdirectory 参数切换变体，但缺少内置实验框架 |
| 动态 prompt 生成 | ⭐ | 静态 YAML 不适合运行时动态构建的 prompt |
| 超大规模（100+ 语言） | ⭐ | 硬编码 fallback 链不适合，需改为配置驱动 |

---

## 第 4 章 测试用例

基于 DeepTutor 真实测试文件（`tests/core/test_prompt_manager.py`）的模式，以下是可直接运行的测试：

```python
"""Tests for PromptManager — 基于 DeepTutor 测试模式改编。"""

import tempfile
from pathlib import Path

import pytest
import yaml

# 假设 PromptManager 已按 3.2 模板实现
from your_project.prompt_manager import PromptManager


@pytest.fixture(autouse=True)
def reset_singleton():
    """每个测试前重置单例和缓存。"""
    PromptManager._instance = None
    PromptManager._cache = {}
    yield


@pytest.fixture
def prompt_dir(tmp_path):
    """创建临时 prompt 目录结构。"""
    # chat/prompts/en/chat_agent.yaml
    en_dir = tmp_path / "chat" / "prompts" / "en"
    en_dir.mkdir(parents=True)
    (en_dir / "chat_agent.yaml").write_text(
        yaml.dump({"system": "You are a helpful assistant.", "user_template": "{message}"})
    )

    # chat/prompts/zh/chat_agent.yaml
    zh_dir = tmp_path / "chat" / "prompts" / "zh"
    zh_dir.mkdir(parents=True)
    (zh_dir / "chat_agent.yaml").write_text(
        yaml.dump({"system": "你是一个有用的助手。", "user_template": "{message}"})
    )

    # solve/prompts/en/solve_loop/solver.yaml (子目录)
    sub_dir = tmp_path / "solve" / "prompts" / "en" / "solve_loop"
    sub_dir.mkdir(parents=True)
    (sub_dir / "solver.yaml").write_text(
        yaml.dump({"system": "You are a problem solver."})
    )

    return tmp_path


class TestSingleton:
    def test_same_instance(self):
        pm1 = PromptManager()
        pm2 = PromptManager()
        assert pm1 is pm2

    def test_cache_shared(self):
        pm1 = PromptManager()
        pm2 = PromptManager()
        assert pm1._cache is pm2._cache


class TestLoadPrompts:
    def test_load_english(self, prompt_dir):
        pm = PromptManager(prompts_root=prompt_dir)
        prompts = pm.load("chat", "chat_agent", "en")
        assert prompts["system"] == "You are a helpful assistant."

    def test_load_chinese(self, prompt_dir):
        pm = PromptManager(prompts_root=prompt_dir)
        prompts = pm.load("chat", "chat_agent", "zh")
        assert prompts["system"] == "你是一个有用的助手。"

    def test_fallback_to_english(self, prompt_dir):
        pm = PromptManager(prompts_root=prompt_dir)
        # ja 不存在，应 fallback 到 en
        prompts = pm.load("chat", "chat_agent", "ja")
        assert prompts["system"] == "You are a helpful assistant."

    def test_missing_agent_returns_empty(self, prompt_dir):
        pm = PromptManager(prompts_root=prompt_dir)
        prompts = pm.load("chat", "nonexistent_agent", "en")
        assert prompts == {}

    def test_subdirectory_loading(self, prompt_dir):
        pm = PromptManager(prompts_root=prompt_dir)
        prompts = pm.load("solve", "solver", "en", subdir="solve_loop")
        assert prompts["system"] == "You are a problem solver."


class TestCaching:
    def test_cache_hit(self, prompt_dir):
        pm = PromptManager(prompts_root=prompt_dir)
        p1 = pm.load("chat", "chat_agent", "en")
        p2 = pm.load("chat", "chat_agent", "en")
        assert p1 is p2  # 同一对象引用

    def test_clear_all(self, prompt_dir):
        pm = PromptManager(prompts_root=prompt_dir)
        pm.load("chat", "chat_agent", "en")
        pm.clear_cache()
        assert len(pm._cache) == 0

    def test_clear_module_specific(self, prompt_dir):
        pm = PromptManager(prompts_root=prompt_dir)
        pm.load("chat", "chat_agent", "en")
        pm.load("solve", "solver", "en", subdir="solve_loop")
        pm.clear_cache("chat")
        assert not any("chat" in k for k in pm._cache)
        assert any("solve" in k for k in pm._cache)

    def test_reload_bypasses_cache(self, prompt_dir):
        pm = PromptManager(prompts_root=prompt_dir)
        p1 = pm.load("chat", "chat_agent", "en")
        p2 = pm.reload("chat", "chat_agent", "en")
        assert p1 == p2
        assert p1 is not p2  # 不同对象


class TestGetPrompt:
    def test_simple_access(self):
        pm = PromptManager()
        prompts = {"system": "Hello", "nested": {"key": "value"}}
        assert pm.get(prompts, "system") == "Hello"

    def test_nested_access(self):
        pm = PromptManager()
        prompts = {"nested": {"key": "value"}}
        assert pm.get(prompts, "nested", "key") == "value"

    def test_fallback_on_missing(self):
        pm = PromptManager()
        assert pm.get({}, "missing", fallback="default") == "default"
```

---

## 第 5 章 跨域关联

| 关联域 | 关系类型 | 说明 |
|--------|----------|------|
| PD-01 上下文管理 | 协同 | Prompt 模板中的 `{context}` 占位符由上下文管理系统填充；prompt 长度直接影响可用上下文窗口 |
| PD-02 多 Agent 编排 | 协同 | 每个 Agent 通过 BaseAgent 自动加载对应 prompt，编排层无需关心 prompt 细节 |
| PD-04 工具系统 | 协同 | solve 模块的 tool_agent prompt 定义了工具选择策略（`solve/prompts/en/solve_loop/tool_agent.yaml`），prompt 管理与工具系统解耦 |
| PD-09 Human-in-the-Loop | 协同 | 用户语言偏好通过 `parse_language()` 传递到 PromptManager，实现用户界面语言与 Agent prompt 语言一致 |
| PD-11 可观测性 | 依赖 | BaseAgent 在 prompt 加载时记录 debug 日志（`src/agents/base_agent.py:144`），可追踪哪个 Agent 加载了哪个语言的 prompt |

---

## 第 6 章 来源文件索引

| 文件 | 行范围 | 关键实现 |
|------|--------|----------|
| `src/services/prompt/manager.py` | L1-207 | PromptManager 完整实现：单例、缓存、fallback、路径解析 |
| `src/services/prompt/__init__.py` | L1-26 | 模块导出，使用示例文档 |
| `src/agents/base_agent.py` | L136-147 | BaseAgent 中 PromptManager 集成点 |
| `src/services/config/loader.py` | L173-197 | `parse_language()` 语言标准化函数 |
| `src/agents/chat/prompts/en/chat_agent.yaml` | L1-36 | 英文 prompt 示例（system + context_template + user_template） |
| `src/agents/chat/prompts/zh/chat_agent.yaml` | L1-36 | 中文 prompt 示例，与英文版 key 结构一致 |
| `src/agents/solve/prompts/en/solve_loop/solve_agent.yaml` | L1-30 | 子目录嵌套 prompt 示例 |
| `src/agents/ideagen/prompts/en/idea_generation.yaml` | L1-188 | 复杂多 section prompt 示例（4 个 system + 4 个 user_template） |
| `tests/core/test_prompt_manager.py` | L1-200 | 官方测试：单例、缓存、fallback、reload、语言处理 |

---

## 第 7 章 横向对比维度

```json comparison_data
{
  "project": "DeepTutor",
  "dimensions": {
    "存储格式": "YAML 文件，多行字符串（|），扁平 key-value 结构",
    "组织层级": "module/prompts/lang/[subdir/]agent.yaml 三级+可选子目录",
    "Fallback 策略": "硬编码 fallback 链 zh→cn→en，未知语言默认 en",
    "缓存机制": "类级别字典缓存 + 单例模式，支持模块级清除和强制 reload",
    "集成方式": "BaseAgent 构造函数自动注入，6 模块 50+ YAML 统一管理",
    "路径解析": "三级策略：子目录优先 → 直接路径 → rglob 递归搜索"
  }
}
```

### 域元数据补充

```json domain_metadata
{
  "description": "统一管理 Agent 系统中多语言 prompt 的加载、缓存、降级与组织结构",
  "sub_problems": [
    "Prompt 安全访问与缺失兜底（get_prompt fallback 机制）",
    "嵌套子目录下的 prompt 路径解析（rglob 递归发现）",
    "BaseAgent 层自动注入 prompt 的集成模式"
  ],
  "best_practices": [
    "通过 Singleton + 类级别缓存避免重复 I/O，支持模块粒度的缓存清除",
    "BaseAgent 构造函数统一注入 prompt 加载，子类无需手动调用",
    "parse_language() 标准化多种语言输入格式，统一为内部语言码"
  ]
}
```
