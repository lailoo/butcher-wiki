# PD-05.04 DeepTutor — 进程级工作空间隔离方案

> 文档编号：PD-05.04
> 来源：DeepTutor `src/tools/code_executor.py`
> GitHub：https://github.com/HKUDS/DeepTutor.git
> 问题域：PD-05 沙箱隔离 Sandbox Isolation
> 状态：可复用方案

---

## 第 1 章 问题与动机

### 1.1 核心问题

DeepTutor 是一个 AI 辅导系统，其 Solve Agent 和 Research Agent 需要执行用户提交的 Python 代码来完成计算验证、数据可视化等任务。代码执行带来三个核心风险：

1. **宿主机安全**：用户代码可能执行 `os.system('rm -rf /')` 等破坏性操作
2. **文件系统越界**：代码可能读写项目根目录之外的敏感文件
3. **资源耗尽**：死循环或大内存分配可能拖垮整个服务

DeepTutor 选择了一种**轻量级进程隔离**方案：不依赖 Docker/E2B 等外部沙箱服务，而是通过 `subprocess` + 临时目录 + 路径白名单 + AST 导入检查实现应用层隔离。这种方案适合教育场景下的可信代码执行，部署成本极低。

### 1.2 DeepTutor 的解法概述

1. **WorkspaceManager** — 管理隔离工作空间，所有代码在 `data/user/run_code_workspace/` 下的临时目录中执行（`src/tools/code_executor.py:115-244`）
2. **路径白名单机制** — `allowed_roots` 配置限制文件访问范围，任何 assets 目录必须在白名单内（`src/tools/code_executor.py:139-177`）
3. **ImportGuard** — AST 静态分析，在执行前拦截未授权的 import 语句（`src/tools/code_executor.py:247-274`）
4. **subprocess 进程隔离** — 代码在独立子进程中运行，通过 `subprocess.run` 的 `timeout` 参数实现超时保护（`src/tools/code_executor.py:283-312`）
5. **Docker 容器化部署** — 生产环境通过多阶段 Dockerfile + docker-compose 提供额外的容器级隔离（`Dockerfile:84-314`, `docker-compose.yml`）

### 1.3 设计思想

| 设计原则 | 具体实现 | 理由 | 替代方案 |
|----------|----------|------|----------|
| 最小权限 | allowed_roots 白名单限制文件访问 | 防止代码越界读写敏感文件 | chroot jail、Docker volume mount |
| 纵深防御 | ImportGuard(AST) + subprocess + 路径白名单三层 | 单层防御可被绕过，多层叠加提高安全性 | 仅依赖 Docker 隔离 |
| 配置驱动 | workspace/allowed_roots 均从 YAML 配置加载 | 不同部署环境可灵活调整隔离策略 | 硬编码路径 |
| 懒初始化 | WorkspaceManager._initialized 标志位 | 不是所有请求都需要代码执行，按需创建目录 | 启动时预创建 |
| 临时目录隔离 | tempfile.TemporaryDirectory 自动清理 | 每次执行互不干扰，执行完自动清理 | 固定目录 + 手动清理 |

---

## 第 2 章 源码实现分析

### 2.1 架构概览

DeepTutor 的代码执行隔离分为两层：应用层（WorkspaceManager + ImportGuard + subprocess）和部署层（Docker 容器）。

```
┌─────────────────────────────────────────────────────────────┐
│                    Docker Container (部署层)                  │
│  ┌───────────────────────────────────────────────────────┐  │
│  │              FastAPI Backend (应用层)                   │  │
│  │                                                       │  │
│  │  ToolAgent / ResearchPipeline                         │  │
│  │       │                                               │  │
│  │       ▼                                               │  │
│  │  run_code(language, code, timeout, assets_dir)        │  │
│  │       │                                               │  │
│  │       ├── ImportGuard.validate(code, allowed_imports) │  │
│  │       │   └── AST 解析 → 检查 import 白名单           │  │
│  │       │                                               │  │
│  │       ├── WorkspaceManager                            │  │
│  │       │   ├── base_dir: data/user/run_code_workspace  │  │
│  │       │   ├── allowed_roots: [项目根, data/user]       │  │
│  │       │   └── create_temp_dir() → tempfile            │  │
│  │       │                                               │  │
│  │       └── CodeExecutionEnvironment.run_python()       │  │
│  │           └── subprocess.run(python, code.py,         │  │
│  │               cwd=temp_dir, timeout=N)                │  │
│  │                                                       │  │
│  │  ┌─────────────────────────────────┐                  │  │
│  │  │  data/user/run_code_workspace/  │                  │  │
│  │  │  ├── tmp_abc123/  (执行中)       │                  │  │
│  │  │  │   └── code.py               │                  │  │
│  │  │  └── tmp_def456/  (已清理)       │                  │  │
│  │  └─────────────────────────────────┘                  │  │
│  └───────────────────────────────────────────────────────┘  │
│                                                             │
│  volumes:                                                   │
│    - ./config:/app/config:ro    (只读挂载)                   │
│    - ./data/user:/app/data/user (读写挂载)                   │
└─────────────────────────────────────────────────────────────┘
```

### 2.2 核心实现

#### 2.2.1 WorkspaceManager — 工作空间管理器

WorkspaceManager 是隔离的核心组件，负责工作空间目录管理和路径安全校验（`src/tools/code_executor.py:115-244`）：

```python
# src/tools/code_executor.py:115-178
class WorkspaceManager:
    """Manages isolated workspace, similar to code_implementation_server workspace logic"""

    def __init__(self):
        config = _load_config()

        # 优先级：环境变量 > 配置文件 > 默认值
        env_path = os.getenv(RUN_CODE_WORKSPACE_ENV)
        if env_path:
            self.base_dir = Path(env_path).expanduser().resolve()
        else:
            config_workspace = config.get("workspace")
            if config_workspace:
                workspace_path = Path(config_workspace).expanduser()
                if workspace_path.is_absolute():
                    self.base_dir = workspace_path.resolve()
                else:
                    self.base_dir = (PROJECT_ROOT / workspace_path).resolve()
            else:
                self.base_dir = (PROJECT_ROOT / "data" / "user" / DEFAULT_WORKSPACE_NAME).resolve()

        # 路径白名单：默认包含项目根和用户数据目录
        self.allowed_roots: list[Path] = [
            PROJECT_ROOT.resolve(),
            (PROJECT_ROOT / "data" / "user").resolve(),
        ]
        # ... 从配置文件和环境变量追加额外白名单
        self._initialized = False
```

路径安全校验方法（`src/tools/code_executor.py:219-244`）：

```python
# src/tools/code_executor.py:219-244
def _ensure_within_allowed_roots(self, path: Path):
    resolved_path = path.resolve()
    for root in self.allowed_roots:
        try:
            if hasattr(resolved_path, "is_relative_to"):
                if resolved_path.is_relative_to(root):
                    return
            else:
                resolved_str = str(resolved_path).lower().replace("\\", "/")
                root_str = str(root.resolve()).lower().replace("\\", "/")
                if resolved_str.startswith(root_str):
                    return
        except (ValueError, AttributeError):
            resolved_str = str(resolved_path).lower().replace("\\", "/")
            root_str = str(root.resolve()).lower().replace("\\", "/")
            if resolved_str.startswith(root_str):
                return
    allowed = "\n".join(str(root) for root in self.allowed_roots)
    raise ValueError(
        f"Assets directory {resolved_path} must be located under one of the following allowed paths:\n{allowed}"
    )
```

#### 2.2.2 ImportGuard — AST 导入检查

ImportGuard 在代码执行前通过 AST 静态分析拦截未授权模块（`src/tools/code_executor.py:247-274`）：

```python
# src/tools/code_executor.py:247-274
class ImportGuard:
    """Parse AST, restrict import modules"""

    @staticmethod
    def validate(code: str, allowed_imports: list[str] | None):
        if not allowed_imports:
            return  # 未配置白名单时不检查

        allowed = set(allowed_imports)
        try:
            tree = ast.parse(code)
        except SyntaxError as exc:
            raise CodeExecutionError(f"Code syntax error: {exc}") from exc

        imported: list[str] = []
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                for alias in node.names:
                    imported.append(alias.name.split(".")[0])
            elif isinstance(node, ast.ImportFrom):
                if node.module:
                    imported.append(node.module.split(".")[0])

        unauthorized = sorted({name for name in imported if name not in allowed})
        if unauthorized:
            raise CodeExecutionError(
                f"The following modules are not in the allowed list: {', '.join(unauthorized)}"
            )
```

#### 2.2.3 CodeExecutionEnvironment — 子进程执行

实际代码执行通过 `subprocess.run` 在独立进程中完成（`src/tools/code_executor.py:277-312`）：

```python
# src/tools/code_executor.py:283-312
def run_python(
    self, code: str, timeout: int, assets_dir: Path | None,
) -> tuple[str, str, int, float]:
    env = os.environ.copy()
    env["PYTHONIOENCODING"] = "utf-8"

    with self.workspace.create_temp_dir() as temp_dir:
        code_file = temp_dir / "code.py"
        code_file.write_text(code, encoding="utf-8")

        work_dir = assets_dir if assets_dir else temp_dir
        start_time = time.time()

        result = subprocess.run(
            [sys.executable, str(code_file)],
            check=False,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout,
            cwd=str(work_dir),
            env=env,
        )

        elapsed_ms = (time.time() - start_time) * 1000
        return result.stdout, result.stderr, result.returncode, elapsed_ms
```

关键设计点：
- `tempfile.TemporaryDirectory` 作为上下文管理器，执行完自动清理临时文件
- `cwd` 设置为 assets_dir 或 temp_dir，限制代码的工作目录
- `capture_output=True` 捕获 stdout/stderr，不让子进程输出泄漏到主进程
- `timeout` 参数由调用方传入，默认 10s（solve 场景 20s，research 场景 30s）

#### 2.2.4 ToolAgent 集成 — 代码执行的调用链

ToolAgent 是 Solve 流程中调用 `run_code` 的入口（`src/agents/solve/solve_loop/tool_agent.py:260-313`）：

```python
# src/agents/solve/solve_loop/tool_agent.py:277-284
code = await self._generate_code_from_intent(query)

exec_result = await run_code(
    language="python",
    code=code,
    timeout=self.agent_config.get("code_timeout", 20),
    assets_dir=artifacts_dir,
)
```

注意 ToolAgent 不直接执行用户输入的代码，而是先通过 LLM 将用户意图转换为 Python 代码（`_generate_code_from_intent`），再交给 `run_code` 执行。这增加了一层"意图→代码"的转换，降低了直接注入风险。

### 2.3 实现细节

#### 配置层级与优先级

`main.yaml` 中的 `run_code` 配置（`config/main.yaml:17-21`）：

```yaml
tools:
  run_code:
    workspace: ./data/user/run_code_workspace
    allowed_roots:
    - ./data/user
    - ./src/tools
```

配置加载优先级链（`src/tools/code_executor.py:30-82`）：
1. 环境变量 `RUN_CODE_WORKSPACE` / `RUN_CODE_ALLOWED_ROOTS`
2. `solve_config.yaml` → `tools.run_code`
3. `question_config.yaml` → `tools.run_code`
4. `main.yaml` → `tools.run_code`
5. 硬编码默认值 `data/user/run_code_workspace`

#### Docker 部署层隔离

Dockerfile 采用 4 阶段构建（`Dockerfile:18-370`）：
- Stage 1: frontend-builder（Node.js 构建前端）
- Stage 2: python-base（安装 Python 依赖）
- Stage 3: production（最终生产镜像）
- Stage 4: development（开发镜像，继承 production）

生产镜像中预创建 `run_code_workspace` 目录（`Dockerfile:152`）：
```dockerfile
RUN mkdir -p data/user/run_code_workspace
```

docker-compose.yml 通过 volume mount 实现数据持久化（`docker-compose.yml:78-84`）：
```yaml
volumes:
  - ./config:/app/config:ro          # 配置只读
  - ./data/user:/app/data/user       # 用户数据读写
  - ./data/knowledge_bases:/app/data/knowledge_bases
```

开发模式下源码以只读方式挂载（`docker-compose.dev.yml:18-19`）：
```yaml
volumes:
  - ./src:/app/src:ro
```

#### 数据流图

```
用户提问 → SolveAgent → ManagerAgent → ToolAgent
                                          │
                                          ├─ _generate_code_from_intent(query)
                                          │   └─ LLM 生成 Python 代码
                                          │
                                          ├─ run_code(language, code, timeout, assets_dir)
                                          │   ├─ ImportGuard.validate()  ← AST 检查
                                          │   ├─ WorkspaceManager.ensure_initialized()
                                          │   ├─ WorkspaceManager.resolve_assets_dir()
                                          │   │   └─ _ensure_within_allowed_roots()  ← 路径白名单
                                          │   └─ CodeExecutionEnvironment.run_python()
                                          │       ├─ create_temp_dir()  ← 临时目录
                                          │       ├─ write code.py
                                          │       └─ subprocess.run(timeout=N)  ← 进程隔离
                                          │
                                          └─ collect_artifacts() → 返回执行结果
```

---

## 第 3 章 迁移指南

### 3.1 迁移清单

**阶段 1：基础进程隔离（必选）**
- [ ] 创建 WorkspaceManager 类，配置 base_dir 和 allowed_roots
- [ ] 实现 `_ensure_within_allowed_roots` 路径校验
- [ ] 实现 `create_temp_dir` 临时目录管理
- [ ] 实现 `run_python` 方法，使用 subprocess.run + timeout
- [ ] 配置 YAML 中的 workspace 和 allowed_roots

**阶段 2：安全增强（推荐）**
- [ ] 实现 ImportGuard AST 导入检查
- [ ] 添加 OperationLogger 审计日志
- [ ] 配置环境变量覆盖机制

**阶段 3：容器化部署（生产环境）**
- [ ] 编写多阶段 Dockerfile
- [ ] 配置 docker-compose volume mount（config 只读、data 读写）
- [ ] 添加 healthcheck

### 3.2 适配代码模板

以下是一个可直接复用的最小化实现：

```python
"""Minimal sandbox executor inspired by DeepTutor's code_executor.py"""

import ast
import asyncio
import os
import subprocess
import sys
import tempfile
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Any


class SandboxError(Exception):
    """Sandbox execution error"""


class ImportGuard:
    """AST-based import whitelist checker"""

    @staticmethod
    def validate(code: str, allowed_imports: list[str] | None = None):
        if not allowed_imports:
            return
        allowed = set(allowed_imports)
        tree = ast.parse(code)
        imported = []
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                imported.extend(a.name.split(".")[0] for a in node.names)
            elif isinstance(node, ast.ImportFrom) and node.module:
                imported.append(node.module.split(".")[0])
        unauthorized = sorted(set(imported) - allowed)
        if unauthorized:
            raise SandboxError(f"Unauthorized imports: {', '.join(unauthorized)}")


class WorkspaceManager:
    """Manages isolated code execution workspace with path whitelisting"""

    def __init__(self, base_dir: Path, allowed_roots: list[Path] | None = None):
        self.base_dir = base_dir.resolve()
        self.allowed_roots = [r.resolve() for r in (allowed_roots or [])]
        if self.base_dir not in self.allowed_roots:
            self.allowed_roots.append(self.base_dir)
        self._initialized = False

    def ensure_initialized(self):
        if not self._initialized:
            self.base_dir.mkdir(parents=True, exist_ok=True)
            self._initialized = True

    @contextmanager
    def temp_dir(self):
        self.ensure_initialized()
        with tempfile.TemporaryDirectory(dir=self.base_dir) as td:
            yield Path(td)

    def validate_path(self, path: Path):
        resolved = path.resolve()
        for root in self.allowed_roots:
            if resolved.is_relative_to(root):
                return
        raise SandboxError(f"Path {resolved} outside allowed roots")


async def run_code(
    code: str,
    workspace: WorkspaceManager,
    timeout: int = 10,
    allowed_imports: list[str] | None = None,
) -> dict[str, Any]:
    """Execute Python code in isolated subprocess"""
    ImportGuard.validate(code, allowed_imports)
    workspace.ensure_initialized()

    def _execute():
        env = os.environ.copy()
        env["PYTHONIOENCODING"] = "utf-8"
        with workspace.temp_dir() as tmp:
            code_file = tmp / "code.py"
            code_file.write_text(code, encoding="utf-8")
            start = time.time()
            try:
                result = subprocess.run(
                    [sys.executable, str(code_file)],
                    capture_output=True, text=True, timeout=timeout,
                    cwd=str(tmp), env=env, check=False,
                )
                return {
                    "stdout": result.stdout,
                    "stderr": result.stderr,
                    "exit_code": result.returncode,
                    "elapsed_ms": (time.time() - start) * 1000,
                }
            except subprocess.TimeoutExpired:
                return {
                    "stdout": "",
                    "stderr": f"Timeout after {timeout}s",
                    "exit_code": -1,
                    "elapsed_ms": timeout * 1000,
                }

    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(None, _execute)
```

### 3.3 适用场景

| 场景 | 适用度 | 说明 |
|------|--------|------|
| 教育平台代码执行 | ⭐⭐⭐ | DeepTutor 的原生场景，LLM 生成代码 + 进程隔离足够 |
| Agent 工具调用（计算/可视化） | ⭐⭐⭐ | 代码由 LLM 生成，风险可控，超时保护防止资源耗尽 |
| 用户直接提交代码（低信任） | ⭐ | 进程级隔离不够，需要 Docker/gVisor 等容器级隔离 |
| 多租户 SaaS 平台 | ⭐ | 缺少资源配额（CPU/内存限制），需要 cgroup 或容器 |
| CI/CD 构建任务 | ⭐⭐ | 可用于简单脚本执行，复杂构建需要完整容器环境 |

---

## 第 4 章 测试用例

```python
"""Tests for DeepTutor-style sandbox isolation"""

import asyncio
import os
import tempfile
from pathlib import Path
from unittest.mock import patch

import pytest

from sandbox_executor import ImportGuard, SandboxError, WorkspaceManager, run_code


@pytest.fixture
def workspace(tmp_path):
    return WorkspaceManager(
        base_dir=tmp_path / "workspace",
        allowed_roots=[tmp_path],
    )


class TestImportGuard:
    def test_allowed_imports_pass(self):
        """正常路径：白名单内的 import 通过"""
        ImportGuard.validate("import math\nimport json", ["math", "json"])

    def test_unauthorized_import_blocked(self):
        """边界情况：未授权 import 被拦截"""
        with pytest.raises(SandboxError, match="Unauthorized imports: os"):
            ImportGuard.validate("import os", ["math"])

    def test_from_import_checked(self):
        """from X import Y 也被检查"""
        with pytest.raises(SandboxError, match="subprocess"):
            ImportGuard.validate("from subprocess import run", ["math"])

    def test_no_whitelist_skips_check(self):
        """未配置白名单时不检查"""
        ImportGuard.validate("import os; import subprocess", None)

    def test_syntax_error_raises(self):
        """语法错误的代码被拒绝"""
        with pytest.raises(SandboxError, match="syntax"):
            ImportGuard.validate("def foo(:", ["math"])


class TestWorkspaceManager:
    def test_lazy_initialization(self, workspace):
        """懒初始化：构造时不创建目录"""
        assert not workspace._initialized
        assert not workspace.base_dir.exists()

    def test_ensure_initialized_creates_dir(self, workspace):
        """首次调用时创建目录"""
        workspace.ensure_initialized()
        assert workspace._initialized
        assert workspace.base_dir.exists()

    def test_temp_dir_created_and_cleaned(self, workspace):
        """临时目录在上下文退出后被清理"""
        with workspace.temp_dir() as td:
            assert td.exists()
            (td / "test.txt").write_text("hello")
            temp_path = td
        assert not temp_path.exists()

    def test_path_within_allowed_roots(self, workspace, tmp_path):
        """白名单内路径通过校验"""
        workspace.validate_path(tmp_path / "subdir")

    def test_path_outside_allowed_roots_rejected(self, workspace):
        """白名单外路径被拒绝"""
        with pytest.raises(SandboxError, match="outside allowed roots"):
            workspace.validate_path(Path("/etc/passwd"))


class TestRunCode:
    def test_normal_execution(self, workspace):
        """正常代码执行"""
        result = asyncio.run(run_code("print('hello')", workspace, timeout=5))
        assert result["exit_code"] == 0
        assert "hello" in result["stdout"]

    def test_timeout_protection(self, workspace):
        """超时保护：死循环被终止"""
        result = asyncio.run(
            run_code("import time; time.sleep(30)", workspace, timeout=2)
        )
        assert result["exit_code"] == -1
        assert "Timeout" in result["stderr"]

    def test_error_captured(self, workspace):
        """运行时错误被捕获"""
        result = asyncio.run(
            run_code("raise ValueError('test')", workspace, timeout=5)
        )
        assert result["exit_code"] != 0
        assert "ValueError" in result["stderr"]

    def test_import_guard_integration(self, workspace):
        """ImportGuard 与 run_code 集成"""
        with pytest.raises(SandboxError):
            asyncio.run(
                run_code("import os", workspace, allowed_imports=["math"])
            )
```

---

## 第 5 章 跨域关联

| 关联域 | 关系类型 | 说明 |
|--------|----------|------|
| PD-04 工具系统 | 依赖 | `run_code` 作为 ToolAgent 的工具之一被注册和调用，工具系统决定何时触发代码执行 |
| PD-03 容错与重试 | 协同 | ResearchPipeline 对 `run_code` 调用包装了 `_call_tool_with_retry`（max_retries=1, timeout=30s），超时和异常都有降级处理 |
| PD-01 上下文管理 | 协同 | ToolAgent 将代码执行结果（stdout/stderr/artifacts）压缩为 summary 后注入上下文，避免原始输出撑爆 context window |
| PD-11 可观测性 | 协同 | OperationLogger 记录每次执行的 action/status/elapsed_ms，ToolAgent 通过 `log_tool_call` 上报执行指标 |
| PD-07 质量检查 | 协同 | ToolAgent 检测 exit_code != 0 时标记 `execution_failed`，并在 raw_answer 前添加错误前缀，帮助下游 Agent 识别失败 |

---

## 第 6 章 来源文件索引

| 文件 | 行范围 | 关键实现 |
|------|--------|----------|
| `src/tools/code_executor.py` | L20-23 | 环境变量和默认值常量定义 |
| `src/tools/code_executor.py` | L30-82 | `_load_config()` 配置加载链 |
| `src/tools/code_executor.py` | L89-113 | OperationLogger 审计日志 |
| `src/tools/code_executor.py` | L115-244 | WorkspaceManager 完整实现 |
| `src/tools/code_executor.py` | L247-274 | ImportGuard AST 导入检查 |
| `src/tools/code_executor.py` | L277-312 | CodeExecutionEnvironment.run_python |
| `src/tools/code_executor.py` | L320-428 | run_code 异步入口 + 错误处理 |
| `src/agents/solve/solve_loop/tool_agent.py` | L50-78 | _generate_code_from_intent LLM 代码生成 |
| `src/agents/solve/solve_loop/tool_agent.py` | L260-313 | code_execution 分支完整逻辑 |
| `src/agents/research/research_pipeline.py` | L361-371 | ResearchPipeline 中 run_code 调用 |
| `config/main.yaml` | L17-21 | run_code workspace 和 allowed_roots 配置 |
| `Dockerfile` | L84-314 | 多阶段构建 production 镜像 |
| `docker-compose.yml` | L16-101 | 服务编排 + volume mount |
| `docker-compose.dev.yml` | L12-49 | 开发模式只读源码挂载 |
| `src/services/setup/init.py` | L32-191 | init_user_directories 创建 run_code_workspace |

---

## 第 7 章 横向对比维度

> **重要：** 本章用于自动填充 Butcher Wiki 的横向对比表。

```json comparison_data
{
  "project": "DeepTutor",
  "dimensions": {
    "隔离级别": "进程级：subprocess.run + tempfile 临时目录，生产环境叠加 Docker 容器",
    "虚拟路径": "无虚拟路径翻译，直接使用 allowed_roots 白名单校验真实路径",
    "生命周期管理": "懒初始化 + TemporaryDirectory 上下文管理器自动清理",
    "防御性设计": "三层纵深：ImportGuard(AST) + 路径白名单 + subprocess 超时",
    "代码修复": "ToolAgent 检测 exit_code 失败后添加错误前缀提示路径修正"
  }
}
```

### 域元数据补充

```json domain_metadata
{
  "description": "教育场景下轻量级进程隔离：不依赖外部沙箱服务，通过 subprocess + AST 检查实现应用层安全",
  "sub_problems": [
    "导入控制：限制代码可 import 的模块，防止调用危险 API",
    "意图转代码隔离：LLM 将用户意图转为代码再执行，避免直接注入"
  ],
  "best_practices": [
    "AST 静态分析 import 白名单是零开销的预执行安全检查，适合补充进程隔离",
    "配置加载优先级链（环境变量 > 模块配置 > 全局配置 > 默认值）让同一套代码适配多种部署环境",
    "LLM 意图→代码转换比直接执行用户输入更安全，ToolAgent 的 _generate_code_from_intent 模式值得借鉴"
  ]
}
```
