# PD-05.02 MiroThinker — Docker 容器 + E2B 云沙箱

> 文档编号：PD-05.02
> 来源：MiroThinker `sandbox/docker_executor.py` / `sandbox/e2b_executor.py`
> GitHub：https://github.com/MiroMindAI/MiroThinker
> 问题域：PD-05 沙箱隔离 Sandbox Isolation
> 状态：可复用方案

---

## 第 1 章 问题与动机

### 1.1 核心问题

subprocess + tempdir 方案（PD-05.01）提供了基础的进程隔离，但在以下场景中安全性不足：

- **文件系统未隔离**：子进程仍可读取 `/etc/passwd`、`~/.ssh/` 等敏感路径
- **网络未隔离**：恶意代码可发起网络请求、扫描内网、外传数据
- **系统调用未限制**：可执行 `fork bomb`、挂载文件系统、修改内核参数
- **依赖环境污染**：`pip install malicious-package` 可能影响宿主机
- **资源限制粗糙**：仅有 timeout，无 CPU/内存/磁盘 IO 限制

生产级 Agent 系统需要更强的隔离边界：容器级或 VM 级隔离。

### 1.2 MiroThinker 的解法概述

MiroThinker 实现了双模式沙箱架构：

1. **Docker 容器模式**（本地部署）：预构建的 Python 镜像，通过 Docker API 创建一次性容器执行代码，容器销毁后所有状态消失
2. **E2B 云沙箱模式**（云端部署）：调用 E2B（e2b.dev）API 在远程微型 VM 中执行代码，完全隔离于宿主机

两种模式共享统一接口 `SandboxExecutor`，通过配置切换，调用方无需感知底层实现。

### 1.3 设计思想

| 原则 | 说明 |
|------|------|
| 双模式架构 | Docker（本地高性能）+ E2B（云端零运维），按部署环境选择 |
| 统一接口 | 调用方只看到 `execute(code)` → `Result`，底层可替换 |
| 一次性容器 | 每次执行创建新容器/沙箱，执行后销毁，无状态残留 |
| 预构建镜像 | Docker 镜像预装常用库（pandas/numpy/matplotlib），启动快 |
| 资源硬限制 | Docker: cgroup 限制 CPU/内存；E2B: 平台级资源隔离 |
| 网络隔离 | Docker: `--network=none`；E2B: 平台控制网络策略 |

---

## 第 2 章 源码实现分析

### 2.1 整体架构

```
sandbox/
├── __init__.py           # 统一入口：SandboxExecutor 工厂
├── base.py               # 抽象基类：BaseSandbox
├── docker_executor.py    # Docker 容器执行器
├── e2b_executor.py       # E2B 云沙箱执行器
├── config.py             # 沙箱配置
└── Dockerfile            # 预构建 Python 沙箱镜像
```

调用链路：

```
调用方 → SandboxExecutor.create(mode="docker"|"e2b")
           │
           ├── DockerSandbox:
           │     ├── docker.from_env() 连接 Docker daemon
           │     ├── client.containers.run() 创建一次性容器
           │     │     ├── image: "sandbox-python:latest"
           │     │     ├── network_disabled: True
           │     │     ├── mem_limit: "256m"
           │     │     ├── cpu_period/cpu_quota: 限制 CPU
           │     │     └── command: ["python3", "-c", code]
           │     ├── container.wait(timeout=30)
           │     ├── container.logs() 收集输出
           │     └── container.remove(force=True)
           │
           └── E2BSandbox:
                 ├── Sandbox.create(template="python3")
                 ├── sandbox.run_code(code, timeout=30)
                 ├── 收集 stdout/stderr
                 └── sandbox.close()
```

### 2.2 抽象基类

**源文件**: `sandbox/base.py`

```python
# sandbox/base.py（核心逻辑还原）
from abc import ABC, abstractmethod
from dataclasses import dataclass


@dataclass
class SandboxResult:
    stdout: str
    stderr: str
    exit_code: int
    timed_out: bool = False

    @property
    def success(self) -> bool:
        return self.exit_code == 0 and not self.timed_out


class BaseSandbox(ABC):
    """沙箱执行器抽象基类。"""

    @abstractmethod
    async def execute(self, code: str, language: str = "python",
                      timeout: int = 30) -> SandboxResult:
        """在沙箱中执行代码。"""
        ...

    @abstractmethod
    async def cleanup(self) -> None:
        """清理沙箱资源。"""
        ...
```

### 2.3 Docker 容器执行器

**源文件**: `sandbox/docker_executor.py`

核心逻辑：通过 Docker SDK 创建一次性容器，禁用网络，限制 CPU/内存，执行后强制删除。

```python
# sandbox/docker_executor.py（核心逻辑还原）
import docker
import logging
from docker.errors import ContainerError, ImageNotFound, APIError

logger = logging.getLogger(__name__)

DEFAULT_IMAGE = "sandbox-python:latest"
MEMORY_LIMIT = "256m"
CPU_QUOTA = 50000      # 50% 单核
CPU_PERIOD = 100000


class DockerSandbox(BaseSandbox):
    """Docker 容器沙箱：每次执行创建新容器，执行后销毁。"""

    def __init__(self, image: str = DEFAULT_IMAGE,
                 memory_limit: str = MEMORY_LIMIT,
                 network_disabled: bool = True):
        self.image = image
        self.memory_limit = memory_limit
        self.network_disabled = network_disabled
        self.client = docker.from_env()
        self._verify_image()

    def _verify_image(self):
        """确认沙箱镜像存在。"""
        try:
            self.client.images.get(self.image)
        except ImageNotFound:
            logger.warning(f"Image {self.image} not found, pulling...")
            self.client.images.pull(self.image)

    async def execute(self, code: str, language: str = "python",
                      timeout: int = 30) -> SandboxResult:
        container = None
        try:
            container = self.client.containers.run(
                image=self.image,
                command=["python3", "-c", code],
                detach=True,
                network_disabled=self.network_disabled,
                mem_limit=self.memory_limit,
                cpu_period=CPU_PERIOD,
                cpu_quota=CPU_QUOTA,
                # 安全选项
                read_only=False,       # 允许写 /tmp
                security_opt=["no-new-privileges"],
                user="sandbox",        # 非 root 用户
            )

            # 等待执行完成
            result = container.wait(timeout=timeout)
            exit_code = result.get("StatusCode", -1)

            # 收集日志
            logs = container.logs(stdout=True, stderr=True).decode("utf-8", errors="replace")
            stdout_logs = container.logs(stdout=True, stderr=False).decode("utf-8", errors="replace")
            stderr_logs = container.logs(stdout=False, stderr=True).decode("utf-8", errors="replace")

            return SandboxResult(
                stdout=stdout_logs,
                stderr=stderr_logs,
                exit_code=exit_code,
            )

        except Exception as e:
            if "timed out" in str(e).lower() or "read timeout" in str(e).lower():
                return SandboxResult("", f"Timed out after {timeout}s", -1, timed_out=True)
            return SandboxResult("", f"Docker error: {str(e)}", -1)

        finally:
            if container:
                try:
                    container.remove(force=True)
                except Exception:
                    pass

    async def cleanup(self) -> None:
        self.client.close()
```

### 2.4 E2B 云沙箱执行器

**源文件**: `sandbox/e2b_executor.py`

E2B（e2b.dev）提供远程微型 VM，通过 API 调用执行代码。完全隔离于宿主机，无需本地 Docker。

```python
# sandbox/e2b_executor.py（核心逻辑还原）
import logging
from e2b_code_interpreter import Sandbox

logger = logging.getLogger(__name__)

E2B_TEMPLATE = "Python3_DataAnalysis"  # 预装 pandas/numpy/matplotlib


class E2BSandbox(BaseSandbox):
    """E2B 云沙箱：在远程微型 VM 中执行代码。"""

    def __init__(self, api_key: str, template: str = E2B_TEMPLATE,
                 keep_alive: int = 300):
        self.api_key = api_key
        self.template = template
        self.keep_alive = keep_alive
        self._sandbox = None

    async def _get_or_create_sandbox(self) -> Sandbox:
        """获取或创建 E2B 沙箱实例。"""
        if self._sandbox is None:
            self._sandbox = Sandbox(
                template=self.template,
                api_key=self.api_key,
            )
        return self._sandbox

    async def execute(self, code: str, language: str = "python",
                      timeout: int = 30) -> SandboxResult:
        try:
            sandbox = await self._get_or_create_sandbox()
            execution = sandbox.run_code(code, timeout=timeout)

            stdout = "\n".join(
                line.line for line in execution.logs.stdout
            ) if execution.logs.stdout else ""

            stderr = "\n".join(
                line.line for line in execution.logs.stderr
            ) if execution.logs.stderr else ""

            # E2B 的 error 字段
            if execution.error:
                stderr += f"\n{execution.error.name}: {execution.error.value}"
                return SandboxResult(stdout, stderr, 1)

            return SandboxResult(stdout, stderr, 0)

        except TimeoutError:
            return SandboxResult("", f"E2B timed out after {timeout}s", -1, timed_out=True)
        except Exception as e:
            logger.error(f"E2B execution error: {e}")
            return SandboxResult("", f"E2B error: {str(e)}", -1)

    async def cleanup(self) -> None:
        if self._sandbox:
            self._sandbox.close()
            self._sandbox = None
```

### 2.5 工厂模式统一入口

```python
# sandbox/__init__.py
class SandboxExecutor:
    """沙箱执行器工厂：根据配置创建 Docker 或 E2B 沙箱。"""

    @staticmethod
    def create(mode: str = "docker", **kwargs) -> BaseSandbox:
        if mode == "docker":
            return DockerSandbox(**kwargs)
        elif mode == "e2b":
            return E2BSandbox(**kwargs)
        else:
            raise ValueError(f"Unknown sandbox mode: {mode}")
```

### 2.6 预构建 Docker 镜像

```dockerfile
# sandbox/Dockerfile
FROM python:3.11-slim

# 创建非 root 用户
RUN useradd -m -s /bin/bash sandbox

# 预装常用数据分析库
RUN pip install --no-cache-dir \
    pandas==2.1.4 \
    numpy==1.26.2 \
    matplotlib==3.8.2 \
    requests==2.31.0 \
    beautifulsoup4==4.12.2

# 安全加固
RUN chmod 755 /home/sandbox && \
    rm -rf /root/.cache

USER sandbox
WORKDIR /home/sandbox

CMD ["python3"]
```

构建命令：`docker build -t sandbox-python:latest -f sandbox/Dockerfile .`

### 2.7 安全边界对比

| 威胁 | subprocess+tempdir | Docker 容器 | E2B 云沙箱 |
|------|-------------------|-------------|-----------|
| 文件系统隔离 | 部分（cwd 限定） | 完全（容器文件系统） | 完全（独立 VM） |
| 网络隔离 | 无 | 有（`--network=none`） | 有（平台控制） |
| 进程隔离 | 基础（子进程） | 强（namespace） | 完全（VM 级） |
| 资源限制 | timeout 仅 | CPU/内存/IO cgroup | 平台级限制 |
| 依赖隔离 | 无 | 完全（镜像内） | 完全（VM 内） |
| 启动延迟 | ~10ms | ~500ms-2s | ~2-5s |
| 运维成本 | 零 | 需 Docker daemon | 需 E2B 账号+费用 |

---

## 第 3 章 迁移指南

### 3.1 可复用方案架构

```
┌──────────────────────────────────────────────────────┐
│              DualModeSandbox                          │
│                                                      │
│  ┌─────────────┐    ┌─────────────┐                  │
│  │ DockerMode  │    │ E2BMode     │                  │
│  │ (本地高性能) │    │ (云端零运维) │                  │
│  └──────┬──────┘    └──────┬──────┘                  │
│         └────────┬─────────┘                         │
│           BaseSandbox 统一接口                        │
│                                                      │
│  ┌──────────┐  ┌──────────┐  ┌──────────────────┐   │
│  │ Config   │  │ Validator│  │ ResultCollector   │   │
│  └──────────┘  └──────────┘  └──────────────────┘   │
└──────────────────────────────────────────────────────┘
```

### 3.2 配置与核心类

```python
"""
dual_sandbox.py — Docker + E2B 双模式沙箱执行器

用法：
    # Docker 模式
    sandbox = DualModeSandbox(mode="docker")
    result = await sandbox.execute("print('hello')")

    # E2B 模式
    sandbox = DualModeSandbox(mode="e2b", e2b_api_key="e2b_...")
    result = await sandbox.execute("import pandas as pd; print(pd.__version__)")
"""

from __future__ import annotations

import asyncio
import logging
import os
import tempfile
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Optional

logger = logging.getLogger(__name__)


# ─── 配置 ───────────────────────────────────────────────

@dataclass
class DockerConfig:
    """Docker 沙箱配置。"""
    image: str = "python:3.11-slim"
    memory_limit: str = "256m"
    cpu_quota: int = 50000           # 50% 单核
    cpu_period: int = 100000
    network_disabled: bool = True
    read_only: bool = False
    user: str = "nobody"
    timeout: int = 30


@dataclass
class E2BConfig:
    """E2B 云沙箱配置。"""
    api_key: str = ""
    template: str = "Python3_DataAnalysis"
    timeout: int = 30
    keep_alive: int = 300            # 沙箱保活秒数


@dataclass
class SandboxConfig:
    """双模式沙箱配置。"""
    mode: str = "docker"             # "docker" | "e2b"
    docker: DockerConfig = field(default_factory=DockerConfig)
    e2b: E2BConfig = field(default_factory=E2BConfig)
    max_output_length: int = 50_000
    max_code_length: int = 100_000   # 代码最大长度


@dataclass
class SandboxResult:
    """沙箱执行结果。"""
    stdout: str
    stderr: str
    exit_code: int
    timed_out: bool = False
    mode: str = "docker"
    duration_ms: float = 0.0

    @property
    def success(self) -> bool:
        return self.exit_code == 0 and not self.timed_out
```

### 3.3 抽象基类与 Docker 实现

```python
class BaseSandbox(ABC):
    """沙箱执行器抽象基类。"""

    @abstractmethod
    async def execute(self, code: str, language: str = "python",
                      timeout: int | None = None) -> SandboxResult:
        ...

    @abstractmethod
    async def cleanup(self) -> None:
        ...

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        await self.cleanup()


class DockerSandbox(BaseSandbox):
    """Docker 容器沙箱。每次执行创建新容器，执行后销毁。"""

    def __init__(self, config: DockerConfig | None = None):
        self.config = config or DockerConfig()
        self._client = None

    def _get_client(self):
        if self._client is None:
            import docker
            self._client = docker.from_env()
        return self._client

    async def execute(self, code: str, language: str = "python",
                      timeout: int | None = None) -> SandboxResult:
        import time
        timeout = timeout or self.config.timeout
        client = self._get_client()
        container = None
        start = time.monotonic()

        try:
            # 创建一次性容器
            container = client.containers.run(
                image=self.config.image,
                command=["python3", "-c", code],
                detach=True,
                network_disabled=self.config.network_disabled,
                mem_limit=self.config.memory_limit,
                cpu_period=self.config.cpu_period,
                cpu_quota=self.config.cpu_quota,
                read_only=self.config.read_only,
                security_opt=["no-new-privileges"],
                user=self.config.user,
                # tmpfs 挂载允许写入临时文件
                tmpfs={"/tmp": "size=64m,mode=1777"},
            )

            # 等待完成
            result = container.wait(timeout=timeout)
            duration_ms = (time.monotonic() - start) * 1000
            exit_code = result.get("StatusCode", -1)

            stdout = container.logs(stdout=True, stderr=False).decode("utf-8", errors="replace")
            stderr = container.logs(stdout=False, stderr=True).decode("utf-8", errors="replace")

            return SandboxResult(stdout, stderr, exit_code, mode="docker", duration_ms=duration_ms)

        except Exception as e:
            duration_ms = (time.monotonic() - start) * 1000
            if "timed out" in str(e).lower():
                return SandboxResult("", f"Docker timed out after {timeout}s", -1,
                                     timed_out=True, mode="docker", duration_ms=duration_ms)
            return SandboxResult("", f"Docker error: {e}", -1, mode="docker", duration_ms=duration_ms)

        finally:
            if container:
                try:
                    container.remove(force=True)
                except Exception:
                    pass

    async def cleanup(self) -> None:
        if self._client:
            self._client.close()
            self._client = None
```

### 3.4 E2B 云沙箱实现

```python
class E2BSandbox(BaseSandbox):
    """E2B 云沙箱。在远程微型 VM 中执行代码。"""

    def __init__(self, config: E2BConfig | None = None):
        self.config = config or E2BConfig()
        self._sandbox = None

    async def _get_sandbox(self):
        if self._sandbox is None:
            from e2b_code_interpreter import Sandbox
            self._sandbox = Sandbox(
                template=self.config.template,
                api_key=self.config.api_key,
            )
        return self._sandbox

    async def execute(self, code: str, language: str = "python",
                      timeout: int | None = None) -> SandboxResult:
        import time
        timeout = timeout or self.config.timeout
        start = time.monotonic()

        try:
            sandbox = await self._get_sandbox()
            execution = sandbox.run_code(code, timeout=timeout)
            duration_ms = (time.monotonic() - start) * 1000

            stdout = "\n".join(l.line for l in execution.logs.stdout) if execution.logs.stdout else ""
            stderr = "\n".join(l.line for l in execution.logs.stderr) if execution.logs.stderr else ""

            if execution.error:
                stderr += f"\n{execution.error.name}: {execution.error.value}"
                return SandboxResult(stdout, stderr, 1, mode="e2b", duration_ms=duration_ms)

            return SandboxResult(stdout, stderr, 0, mode="e2b", duration_ms=duration_ms)

        except TimeoutError:
            duration_ms = (time.monotonic() - start) * 1000
            return SandboxResult("", f"E2B timed out after {timeout}s", -1,
                                 timed_out=True, mode="e2b", duration_ms=duration_ms)
        except Exception as e:
            duration_ms = (time.monotonic() - start) * 1000
            return SandboxResult("", f"E2B error: {e}", -1, mode="e2b", duration_ms=duration_ms)

    async def cleanup(self) -> None:
        if self._sandbox:
            self._sandbox.close()
            self._sandbox = None
```

### 3.5 工厂与自动降级

```python
class DualModeSandbox:
    """双模式沙箱：Docker 优先，失败自动降级到 E2B（或反之）。"""

    def __init__(self, config: SandboxConfig | None = None, **kwargs):
        self.config = config or SandboxConfig(**kwargs)
        self._primary: BaseSandbox | None = None
        self._fallback: BaseSandbox | None = None
        self._init_sandboxes()

    def _init_sandboxes(self):
        if self.config.mode == "docker":
            self._primary = DockerSandbox(self.config.docker)
            if self.config.e2b.api_key:
                self._fallback = E2BSandbox(self.config.e2b)
        else:
            self._primary = E2BSandbox(self.config.e2b)
            self._fallback = DockerSandbox(self.config.docker)

    async def execute(self, code: str, language: str = "python",
                      timeout: int | None = None) -> SandboxResult:
        """执行代码，主模式失败时自动降级到备选模式。"""
        # 代码长度检查
        if len(code) > self.config.max_code_length:
            return SandboxResult("", f"Code too long: {len(code)} > {self.config.max_code_length}", 1)

        try:
            result = await self._primary.execute(code, language, timeout)
            if result.success or self._fallback is None:
                return result
            # 主模式执行失败（非代码错误），尝试降级
            if result.exit_code == -1 and not result.timed_out:
                logger.warning(f"Primary sandbox failed, falling back: {result.stderr}")
                return await self._fallback.execute(code, language, timeout)
            return result
        except Exception as e:
            if self._fallback:
                logger.warning(f"Primary sandbox error, falling back: {e}")
                return await self._fallback.execute(code, language, timeout)
            return SandboxResult("", f"Sandbox error: {e}", -1)

    async def cleanup(self):
        if self._primary:
            await self._primary.cleanup()
        if self._fallback:
            await self._fallback.cleanup()
```

### 3.6 配置参数速查

| 参数 | 默认值 | 说明 | 调优建议 |
|------|--------|------|----------|
| `mode` | "docker" | 主模式 | 本地开发用 docker，云部署用 e2b |
| `docker.image` | python:3.11-slim | Docker 镜像 | 预装库的自定义镜像启动更快 |
| `docker.memory_limit` | 256m | 内存限制 | 数据分析任务可增大到 1g |
| `docker.network_disabled` | True | 禁用网络 | 需要 API 调用时设 False |
| `docker.cpu_quota` | 50000 | CPU 配额 | 50% 单核，计算密集可增大 |
| `e2b.template` | Python3_DataAnalysis | E2B 模板 | 按需选择预装库的模板 |
| `e2b.keep_alive` | 300s | 沙箱保活 | 频繁调用时增大减少冷启动 |
| `max_output_length` | 50KB | 输出截断 | 防止大量输出占用内存 |

---

## 第 4 章 测试用例

```python
"""test_dual_sandbox.py — Docker + E2B 双模式沙箱完整测试"""
import pytest
from unittest.mock import AsyncMock, MagicMock, patch
from dual_sandbox import (
    DockerSandbox, E2BSandbox, DualModeSandbox,
    DockerConfig, E2BConfig, SandboxConfig, SandboxResult,
    BaseSandbox,
)


class TestSandboxResult:
    """SandboxResult 数据类测试。"""

    def test_success(self):
        r = SandboxResult(stdout="ok", stderr="", exit_code=0)
        assert r.success is True

    def test_failure(self):
        r = SandboxResult(stdout="", stderr="error", exit_code=1)
        assert r.success is False

    def test_timeout(self):
        r = SandboxResult(stdout="", stderr="", exit_code=-1, timed_out=True)
        assert r.success is False
        assert r.timed_out is True

    def test_mode_tracking(self):
        r = SandboxResult("", "", 0, mode="e2b")
        assert r.mode == "e2b"

    def test_duration_tracking(self):
        r = SandboxResult("", "", 0, duration_ms=150.5)
        assert r.duration_ms == 150.5


class TestDockerSandbox:
    """Docker 沙箱测试（使用 mock Docker client）。"""

    def _mock_docker_client(self, stdout=b"hello", stderr=b"", exit_code=0):
        """创建 mock Docker client。"""
        container = MagicMock()
        container.wait.return_value = {"StatusCode": exit_code}
        container.logs.side_effect = lambda stdout=True, stderr=True: (
            stdout if stdout and not stderr else
            stderr if stderr and not stdout else
            stdout + stderr
        )
        # 简化 logs mock
        container.logs = MagicMock(side_effect=lambda **kw: (
            stdout if kw.get("stdout") and not kw.get("stderr") else
            stderr if kw.get("stderr") and not kw.get("stdout") else
            stdout + stderr
        ))
        container.remove = MagicMock()

        client = MagicMock()
        client.containers.run.return_value = container
        return client, container

    @pytest.mark.asyncio
    async def test_successful_execution(self):
        client, container = self._mock_docker_client(b"hello world\n", b"")
        sandbox = DockerSandbox(DockerConfig())
        sandbox._client = client

        result = await sandbox.execute("print('hello world')")
        assert result.exit_code == 0
        assert "hello world" in result.stdout
        container.remove.assert_called_once_with(force=True)

    @pytest.mark.asyncio
    async def test_execution_error(self):
        client, container = self._mock_docker_client(b"", b"NameError: x\n", exit_code=1)
        sandbox = DockerSandbox(DockerConfig())
        sandbox._client = client

        result = await sandbox.execute("print(x)")
        assert result.exit_code == 1
        assert "NameError" in result.stderr

    @pytest.mark.asyncio
    async def test_container_always_removed(self):
        """即使执行失败，容器也被清理。"""
        client, container = self._mock_docker_client(exit_code=1)
        sandbox = DockerSandbox(DockerConfig())
        sandbox._client = client

        await sandbox.execute("bad code")
        container.remove.assert_called_once_with(force=True)

    @pytest.mark.asyncio
    async def test_network_disabled_by_default(self):
        client, _ = self._mock_docker_client()
        sandbox = DockerSandbox(DockerConfig())
        sandbox._client = client

        await sandbox.execute("print(1)")
        call_kwargs = client.containers.run.call_args[1]
        assert call_kwargs["network_disabled"] is True

    @pytest.mark.asyncio
    async def test_memory_limit_applied(self):
        client, _ = self._mock_docker_client()
        sandbox = DockerSandbox(DockerConfig(memory_limit="512m"))
        sandbox._client = client

        await sandbox.execute("print(1)")
        call_kwargs = client.containers.run.call_args[1]
        assert call_kwargs["mem_limit"] == "512m"

    @pytest.mark.asyncio
    async def test_docker_daemon_error(self):
        """Docker daemon 不可用时返回错误。"""
        sandbox = DockerSandbox(DockerConfig())
        sandbox._client = MagicMock()
        sandbox._client.containers.run.side_effect = Exception("Cannot connect to Docker daemon")

        result = await sandbox.execute("print(1)")
        assert result.success is False
        assert "Docker error" in result.stderr


class TestE2BSandbox:
    """E2B 沙箱测试（使用 mock E2B client）。"""

    def _mock_execution(self, stdout_lines=None, stderr_lines=None, error=None):
        """创建 mock E2B execution result。"""
        execution = MagicMock()
        execution.logs.stdout = [MagicMock(line=l) for l in (stdout_lines or [])]
        execution.logs.stderr = [MagicMock(line=l) for l in (stderr_lines or [])]
        execution.error = error
        return execution

    @pytest.mark.asyncio
    async def test_successful_execution(self):
        sandbox = E2BSandbox(E2BConfig(api_key="test-key"))
        mock_sb = MagicMock()
        mock_sb.run_code.return_value = self._mock_execution(stdout_lines=["hello"])
        sandbox._sandbox = mock_sb

        result = await sandbox.execute("print('hello')")
        assert result.success is True
        assert "hello" in result.stdout

    @pytest.mark.asyncio
    async def test_execution_with_error(self):
        sandbox = E2BSandbox(E2BConfig(api_key="test-key"))
        mock_sb = MagicMock()
        error = MagicMock()
        error.name = "NameError"
        error.value = "name 'x' is not defined"
        mock_sb.run_code.return_value = self._mock_execution(error=error)
        sandbox._sandbox = mock_sb

        result = await sandbox.execute("print(x)")
        assert result.success is False
        assert "NameError" in result.stderr

    @pytest.mark.asyncio
    async def test_timeout(self):
        sandbox = E2BSandbox(E2BConfig(api_key="test-key"))
        mock_sb = MagicMock()
        mock_sb.run_code.side_effect = TimeoutError("timed out")
        sandbox._sandbox = mock_sb

        result = await sandbox.execute("import time; time.sleep(100)", timeout=5)
        assert result.timed_out is True

    @pytest.mark.asyncio
    async def test_cleanup_closes_sandbox(self):
        sandbox = E2BSandbox(E2BConfig(api_key="test-key"))
        mock_sb = MagicMock()
        sandbox._sandbox = mock_sb

        await sandbox.cleanup()
        mock_sb.close.assert_called_once()
        assert sandbox._sandbox is None


class TestDualModeSandbox:
    """双模式沙箱测试。"""

    @pytest.mark.asyncio
    async def test_primary_mode_success(self):
        """主模式成功时直接返回。"""
        config = SandboxConfig(mode="docker")
        sandbox = DualModeSandbox(config)
        sandbox._primary = AsyncMock(spec=BaseSandbox)
        sandbox._primary.execute.return_value = SandboxResult("ok", "", 0, mode="docker")

        result = await sandbox.execute("print('ok')")
        assert result.success is True
        assert result.mode == "docker"

    @pytest.mark.asyncio
    async def test_fallback_on_infrastructure_error(self):
        """主模式基础设施错误时降级到备选。"""
        config = SandboxConfig(mode="docker")
        sandbox = DualModeSandbox(config)
        sandbox._primary = AsyncMock(spec=BaseSandbox)
        sandbox._primary.execute.return_value = SandboxResult(
            "", "Cannot connect to Docker daemon", -1, mode="docker"
        )
        sandbox._fallback = AsyncMock(spec=BaseSandbox)
        sandbox._fallback.execute.return_value = SandboxResult("ok", "", 0, mode="e2b")

        result = await sandbox.execute("print('ok')")
        assert result.success is True
        assert result.mode == "e2b"

    @pytest.mark.asyncio
    async def test_no_fallback_on_code_error(self):
        """代码本身的错误不触发降级。"""
        config = SandboxConfig(mode="docker")
        sandbox = DualModeSandbox(config)
        sandbox._primary = AsyncMock(spec=BaseSandbox)
        sandbox._primary.execute.return_value = SandboxResult(
            "", "NameError: x", 1, mode="docker"
        )
        sandbox._fallback = AsyncMock(spec=BaseSandbox)

        result = await sandbox.execute("print(x)")
        assert result.success is False
        sandbox._fallback.execute.assert_not_called()

    @pytest.mark.asyncio
    async def test_code_too_long_rejected(self):
        """超长代码被拒绝。"""
        config = SandboxConfig(max_code_length=100)
        sandbox = DualModeSandbox(config)
        sandbox._primary = AsyncMock(spec=BaseSandbox)

        result = await sandbox.execute("x" * 200)
        assert result.success is False
        assert "too long" in result.stderr

    @pytest.mark.asyncio
    async def test_no_fallback_available(self):
        """无备选模式时，主模式失败直接返回。"""
        config = SandboxConfig(mode="docker")
        sandbox = DualModeSandbox(config)
        sandbox._primary = AsyncMock(spec=BaseSandbox)
        sandbox._primary.execute.return_value = SandboxResult("", "error", -1)
        sandbox._fallback = None

        result = await sandbox.execute("print(1)")
        assert result.success is False

    @pytest.mark.asyncio
    async def test_cleanup_both_modes(self):
        """cleanup 清理主模式和备选模式。"""
        sandbox = DualModeSandbox(SandboxConfig())
        sandbox._primary = AsyncMock(spec=BaseSandbox)
        sandbox._fallback = AsyncMock(spec=BaseSandbox)

        await sandbox.cleanup()
        sandbox._primary.cleanup.assert_called_once()
        sandbox._fallback.cleanup.assert_called_once()


class TestDockerConfig:
    """Docker 配置测试。"""

    def test_default_config(self):
        config = DockerConfig()
        assert config.memory_limit == "256m"
        assert config.network_disabled is True
        assert config.timeout == 30

    def test_custom_config(self):
        config = DockerConfig(memory_limit="1g", network_disabled=False)
        assert config.memory_limit == "1g"
        assert config.network_disabled is False


class TestE2BConfig:
    """E2B 配置测试。"""

    def test_default_config(self):
        config = E2BConfig()
        assert config.template == "Python3_DataAnalysis"
        assert config.timeout == 30

    def test_custom_api_key(self):
        config = E2BConfig(api_key="e2b_test_key")
        assert config.api_key == "e2b_test_key"
```

---

## 第 5 章 跨域关联

| 关联域 | 关系 | 说明 |
|--------|------|------|
| PD-02 多 Agent 编排 | 集成 | code_executor 作为 DAG 中的 worker 节点 |
| PD-03 容错与重试 | 互补 | Docker daemon 不可用时降级到 E2B，E2B 超时时重试 |
| PD-04 工具系统 | 上游 | 沙箱执行器注册为 Agent Tool |
| PD-05.01 subprocess 方案 | 对比 | 本方案是 PD-05.01 的增强版，提供更强隔离 |
| PD-07 质量检查 | 下游 | 执行结果的正确性校验 |
| PD-11 可观测性 | 监控 | 容器启动时间、执行时间、降级次数等指标 |

---

## 第 6 章 来源文件索引

| 编号 | 文件 | 说明 |
|------|------|------|
| S1 | `sandbox/__init__.py` | 统一入口：SandboxExecutor 工厂 |
| S2 | `sandbox/base.py` | 抽象基类：BaseSandbox + SandboxResult |
| S3 | `sandbox/docker_executor.py` | Docker 容器执行器 |
| S4 | `sandbox/e2b_executor.py` | E2B 云沙箱执行器 |
| S5 | `sandbox/config.py` | 沙箱配置：DockerConfig / E2BConfig |
| S6 | `sandbox/Dockerfile` | 预构建 Python 沙箱镜像 |
