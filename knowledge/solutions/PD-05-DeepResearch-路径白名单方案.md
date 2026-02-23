# PD-05.03 DeepResearch — 虚拟文件系统 + 路径白名单

> 文档编号：PD-05.03
> 来源：DeepResearch `src/utils/file_access.py`
> GitHub：https://github.com/Alibaba-NLP/DeepResearch
> 问题域：PD-05 沙箱隔离 Sandbox Isolation
> 状态：可复用方案

---

## 第 1 章 问题与动机

### 1.1 核心问题

Agent 系统在执行研究任务时需要读写文件：保存搜索结果、生成报告、缓存中间数据。但不加限制的文件访问会带来安全风险：

- **路径穿越**：`../../etc/passwd`、符号链接指向敏感目录
- **敏感文件读取**：`.env`、`~/.ssh/id_rsa`、`/etc/shadow`
- **任意写入**：覆盖系统文件、写入 crontab、植入后门
- **磁盘耗尽**：无限写入大文件导致磁盘空间不足
- **跨任务污染**：不同 Agent 任务之间的文件互相干扰

与 PD-05.01（subprocess 隔离）和 PD-05.02（容器隔离）不同，DeepResearch 的场景不需要执行任意代码，而是需要控制 Agent 对文件系统的访问权限。这是一种更轻量但同样重要的隔离维度。

### 1.2 DeepResearch 的解法概述

DeepResearch 实现了 **虚拟文件系统 + 路径白名单** 的文件访问控制：

1. **路径白名单**：只允许访问预定义的目录列表，所有路径操作先经过白名单校验
2. **默认只读**：文件系统默认只读，写入需要显式授权特定目录
3. **路径规范化**：所有路径先 `os.path.realpath()` 解析符号链接，再校验是否在白名单内
4. **虚拟文件系统抽象**：统一的 `FileAccess` 接口，底层可切换真实文件系统或内存文件系统
5. **任务级隔离**：每个 Agent 任务有独立的工作目录和权限范围

### 1.3 设计思想

| 原则 | 说明 |
|------|------|
| 最小权限 | 默认只读，写入需显式授权 |
| 白名单优于黑名单 | 只允许已知安全路径，而非禁止已知危险路径 |
| 路径规范化 | realpath 解析符号链接，防止路径穿越 |
| 抽象层隔离 | FileAccess 接口屏蔽底层实现，可替换为内存 FS |
| 任务隔离 | 每个任务独立工作目录，互不干扰 |
| 零外部依赖 | 纯 Python 标准库实现，无需容器或 VM |

---

## 第 2 章 源码实现分析

### 2.1 整体架构

```
src/utils/
├── file_access.py        # 核心：路径白名单 + 虚拟文件系统
├── path_validator.py     # 路径校验：规范化 + 白名单匹配
└── workspace.py          # 工作空间管理：任务级目录隔离
```

调用链路：

```
Agent → FileAccess.read(path)
          │
          ├── PathValidator.validate(path, mode="read")
          │     ├── os.path.realpath(path) 规范化
          │     ├── 检查是否在 read_whitelist 内
          │     └── 拒绝 → raise PermissionError
          │
          ├── 通过 → 读取文件内容
          └── 返回内容

Agent → FileAccess.write(path, content)
          │
          ├── PathValidator.validate(path, mode="write")
          │     ├── os.path.realpath(path) 规范化
          │     ├── 检查是否在 write_whitelist 内
          │     ├── 检查文件大小限制
          │     └── 拒绝 → raise PermissionError
          │
          ├── 通过 → 写入文件
          └── 返回写入字节数
```

### 2.2 路径校验器

**源文件**: `src/utils/path_validator.py`

核心逻辑：所有路径先 `os.path.realpath()` 解析符号链接和 `..` 引用，然后检查规范化后的路径是否以白名单中的某个目录为前缀。

```python
# src/utils/path_validator.py（核心逻辑还原）
import os
from typing import Set


class PathValidator:
    """路径白名单校验器。

    所有路径先规范化（解析符号链接），再检查是否在白名单目录内。
    """

    def __init__(self, read_dirs: list[str], write_dirs: list[str] | None = None):
        # 规范化白名单路径本身
        self.read_whitelist: Set[str] = {os.path.realpath(d) for d in read_dirs}
        self.write_whitelist: Set[str] = {os.path.realpath(d) for d in (write_dirs or [])}

    def validate(self, path: str, mode: str = "read") -> str:
        """校验路径是否在白名单内。返回规范化后的路径。

        Args:
            path: 待校验的文件路径
            mode: "read" 或 "write"

        Returns:
            规范化后的安全路径

        Raises:
            PermissionError: 路径不在白名单内
            ValueError: 无效的 mode
        """
        real_path = os.path.realpath(path)
        whitelist = self.read_whitelist if mode == "read" else self.write_whitelist

        if mode not in ("read", "write"):
            raise ValueError(f"Invalid mode: {mode}. Must be 'read' or 'write'")

        for allowed_dir in whitelist:
            if real_path.startswith(allowed_dir + os.sep) or real_path == allowed_dir:
                return real_path

        raise PermissionError(
            f"Access denied: '{path}' (resolved: '{real_path}') "
            f"is not within allowed {mode} directories"
        )
```

### 2.3 虚拟文件系统接口

**源文件**: `src/utils/file_access.py`

统一的文件访问接口，所有读写操作都经过路径校验。支持真实文件系统和内存文件系统两种后端。

```python
# src/utils/file_access.py（核心逻辑还原）
import os
import logging
from typing import Protocol

logger = logging.getLogger(__name__)

MAX_FILE_SIZE = 10 * 1024 * 1024  # 10MB
MAX_FILES_PER_WORKSPACE = 1000


class FileBackend(Protocol):
    """文件系统后端协议。"""
    def read(self, path: str) -> str: ...
    def write(self, path: str, content: str) -> int: ...
    def exists(self, path: str) -> bool: ...
    def list_dir(self, path: str) -> list[str]: ...
    def delete(self, path: str) -> bool: ...


class RealFileBackend:
    """真实文件系统后端。"""

    def read(self, path: str) -> str:
        with open(path, "r", encoding="utf-8") as f:
            return f.read()

    def write(self, path: str, content: str) -> int:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            return f.write(content)

    def exists(self, path: str) -> bool:
        return os.path.exists(path)

    def list_dir(self, path: str) -> list[str]:
        return os.listdir(path) if os.path.isdir(path) else []

    def delete(self, path: str) -> bool:
        if os.path.exists(path):
            os.remove(path)
            return True
        return False


class MemoryFileBackend:
    """内存文件系统后端（用于测试和临时任务）。"""

    def __init__(self):
        self._files: dict[str, str] = {}

    def read(self, path: str) -> str:
        if path not in self._files:
            raise FileNotFoundError(f"File not found: {path}")
        return self._files[path]

    def write(self, path: str, content: str) -> int:
        self._files[path] = content
        return len(content)

    def exists(self, path: str) -> bool:
        return path in self._files

    def list_dir(self, path: str) -> list[str]:
        prefix = path.rstrip("/") + "/"
        return [k[len(prefix):].split("/")[0]
                for k in self._files if k.startswith(prefix)]

    def delete(self, path: str) -> bool:
        if path in self._files:
            del self._files[path]
            return True
        return False


class FileAccess:
    """带路径白名单的文件访问层。

    所有读写操作先经过 PathValidator 校验，再委托给 FileBackend 执行。
    """

    def __init__(self, validator: PathValidator,
                 backend: FileBackend | None = None,
                 max_file_size: int = MAX_FILE_SIZE):
        self.validator = validator
        self.backend = backend or RealFileBackend()
        self.max_file_size = max_file_size

    def read(self, path: str) -> str:
        safe_path = self.validator.validate(path, mode="read")
        logger.debug(f"Reading: {safe_path}")
        return self.backend.read(safe_path)

    def write(self, path: str, content: str) -> int:
        safe_path = self.validator.validate(path, mode="write")
        if len(content.encode("utf-8")) > self.max_file_size:
            raise ValueError(
                f"Content size ({len(content.encode('utf-8'))} bytes) "
                f"exceeds limit ({self.max_file_size} bytes)"
            )
        logger.debug(f"Writing: {safe_path} ({len(content)} chars)")
        return self.backend.write(safe_path, content)

    def exists(self, path: str) -> bool:
        safe_path = self.validator.validate(path, mode="read")
        return self.backend.exists(safe_path)

    def list_dir(self, path: str) -> list[str]:
        safe_path = self.validator.validate(path, mode="read")
        return self.backend.list_dir(safe_path)

    def delete(self, path: str) -> bool:
        safe_path = self.validator.validate(path, mode="write")
        logger.debug(f"Deleting: {safe_path}")
        return self.backend.delete(safe_path)
```

### 2.4 工作空间管理

**源文件**: `src/utils/workspace.py`

每个 Agent 任务创建独立的工作空间，包含专属的临时目录和文件访问权限。

```python
# src/utils/workspace.py（核心逻辑还原）
import os
import shutil
import tempfile
import uuid


class Workspace:
    """Agent 任务工作空间：独立目录 + 受限文件访问。"""

    def __init__(self, base_dir: str | None = None,
                 extra_read_dirs: list[str] | None = None):
        self.task_id = str(uuid.uuid4())[:8]
        self.base_dir = base_dir or tempfile.mkdtemp(prefix=f"workspace_{self.task_id}_")
        self.extra_read_dirs = extra_read_dirs or []

        # 创建子目录
        self.output_dir = os.path.join(self.base_dir, "output")
        self.cache_dir = os.path.join(self.base_dir, "cache")
        os.makedirs(self.output_dir, exist_ok=True)
        os.makedirs(self.cache_dir, exist_ok=True)

        # 配置文件访问权限
        self.validator = PathValidator(
            read_dirs=[self.base_dir] + self.extra_read_dirs,
            write_dirs=[self.output_dir, self.cache_dir],
        )
        self.file_access = FileAccess(self.validator)

    def cleanup(self):
        """清理工作空间。"""
        if os.path.exists(self.base_dir):
            shutil.rmtree(self.base_dir, ignore_errors=True)

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.cleanup()
```

### 2.5 安全边界分析

| 威胁 | 是否防护 | 说明 |
|------|----------|------|
| 路径穿越（`../`） | 是 | `realpath()` 解析后校验 |
| 符号链接攻击 | 是 | `realpath()` 解析符号链接到真实路径 |
| 敏感文件读取 | 是 | 白名单外的路径被拒绝 |
| 任意文件写入 | 是 | 只能写入 write_whitelist 目录 |
| 大文件写入 | 是 | `max_file_size` 限制 |
| 跨任务文件访问 | 是 | 每个任务独立工作空间 |
| 进程级隔离 | 否 | 不提供进程隔离（需配合 PD-05.01/02） |
| 网络隔离 | 否 | 不涉及网络控制 |

---

## 第 3 章 迁移指南

### 3.1 可复用方案架构

```
┌──────────────────────────────────────────────────────┐
│              SecureFileSystem                         │
│                                                      │
│  ┌──────────────┐  ┌──────────────┐                  │
│  │ PathValidator │  │ FileBackend  │                  │
│  │ (白名单校验)  │  │ (Real/Memory)│                  │
│  └──────┬───────┘  └──────┬───────┘                  │
│         └────────┬─────────┘                         │
│           FileAccess 统一接口                         │
│                  │                                   │
│         ┌────────┴────────┐                          │
│         │   Workspace     │                          │
│         │ (任务级隔离)     │                          │
│         └─────────────────┘                          │
└──────────────────────────────────────────────────────┘
```

### 3.2 配置与核心类

```python
"""
secure_filesystem.py — 路径白名单 + 虚拟文件系统

用法：
    # 基础用法
    fs = SecureFileSystem(read_dirs=["/data/input"], write_dirs=["/data/output"])
    content = fs.read("/data/input/report.txt")
    fs.write("/data/output/result.json", '{"status": "ok"}')

    # 工作空间用法
    with TaskWorkspace(extra_read_dirs=["/data/shared"]) as ws:
        ws.write("output/report.md", "# Report")
        content = ws.read("output/report.md")
"""

from __future__ import annotations

import os
import shutil
import tempfile
import uuid
import logging
from dataclasses import dataclass, field
from typing import Protocol

logger = logging.getLogger(__name__)


# ─── 配置 ───────────────────────────────────────────────

@dataclass
class FileSystemConfig:
    """安全文件系统配置。"""
    read_dirs: list[str] = field(default_factory=list)
    write_dirs: list[str] = field(default_factory=list)
    max_file_size: int = 10 * 1024 * 1024    # 10MB
    max_files_per_dir: int = 1000
    allowed_extensions: set[str] | None = None  # None=不限制
    blocked_extensions: set[str] = field(
        default_factory=lambda: {".exe", ".sh", ".bat", ".cmd", ".ps1"}
    )
    follow_symlinks: bool = False              # 是否允许符号链接
```

### 3.3 路径校验模块

```python
class PathValidator:
    """路径白名单校验器。

    核心安全机制：
    1. os.path.realpath() 解析符号链接和 .. 引用
    2. 检查规范化路径是否以白名单目录为前缀
    3. 可选的扩展名过滤
    """

    def __init__(self, config: FileSystemConfig):
        self.config = config
        self.read_whitelist = {os.path.realpath(d) for d in config.read_dirs}
        self.write_whitelist = {os.path.realpath(d) for d in config.write_dirs}
        # 写目录自动加入读白名单
        self.read_whitelist |= self.write_whitelist

    def validate(self, path: str, mode: str = "read") -> str:
        """校验并返回规范化路径。不通过则抛 PermissionError。"""
        if mode not in ("read", "write"):
            raise ValueError(f"Invalid mode: {mode}")

        # 规范化路径
        real_path = os.path.realpath(path)

        # 符号链接检查
        if not self.config.follow_symlinks and os.path.islink(path):
            raise PermissionError(f"Symlinks not allowed: {path}")

        # 白名单检查
        whitelist = self.read_whitelist if mode == "read" else self.write_whitelist
        if not self._is_within(real_path, whitelist):
            raise PermissionError(
                f"Access denied: '{path}' (resolved: '{real_path}') "
                f"not in {mode} whitelist"
            )

        # 扩展名检查（仅写入时）
        if mode == "write":
            ext = os.path.splitext(real_path)[1].lower()
            if ext in self.config.blocked_extensions:
                raise PermissionError(f"Blocked extension: {ext}")
            if self.config.allowed_extensions and ext not in self.config.allowed_extensions:
                raise PermissionError(f"Extension not allowed: {ext}")

        return real_path

    @staticmethod
    def _is_within(path: str, whitelist: set[str]) -> bool:
        """检查路径是否在白名单目录内。"""
        for allowed in whitelist:
            if path == allowed or path.startswith(allowed + os.sep):
                return True
        return False
```

### 3.4 文件后端

```python
class FileBackend(Protocol):
    """文件系统后端协议。"""
    def read(self, path: str) -> str: ...
    def write(self, path: str, content: str) -> int: ...
    def exists(self, path: str) -> bool: ...
    def list_dir(self, path: str) -> list[str]: ...
    def delete(self, path: str) -> bool: ...
    def size(self, path: str) -> int: ...


class RealFileBackend:
    """真实文件系统后端。"""

    def read(self, path: str) -> str:
        with open(path, "r", encoding="utf-8") as f:
            return f.read()

    def write(self, path: str, content: str) -> int:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            return f.write(content)

    def exists(self, path: str) -> bool:
        return os.path.exists(path)

    def list_dir(self, path: str) -> list[str]:
        return sorted(os.listdir(path)) if os.path.isdir(path) else []

    def delete(self, path: str) -> bool:
        if os.path.exists(path):
            os.remove(path)
            return True
        return False

    def size(self, path: str) -> int:
        return os.path.getsize(path) if os.path.exists(path) else 0


class MemoryFileBackend:
    """内存文件系统后端。用于测试和无磁盘场景。"""

    def __init__(self):
        self._files: dict[str, str] = {}

    def read(self, path: str) -> str:
        if path not in self._files:
            raise FileNotFoundError(f"Not found: {path}")
        return self._files[path]

    def write(self, path: str, content: str) -> int:
        self._files[path] = content
        return len(content)

    def exists(self, path: str) -> bool:
        return path in self._files

    def list_dir(self, path: str) -> list[str]:
        prefix = path.rstrip("/") + "/"
        items = set()
        for k in self._files:
            if k.startswith(prefix):
                items.add(k[len(prefix):].split("/")[0])
        return sorted(items)

    def delete(self, path: str) -> bool:
        return self._files.pop(path, None) is not None

    def size(self, path: str) -> int:
        return len(self._files.get(path, "").encode("utf-8"))
```

### 3.5 安全文件系统

```python
class SecureFileSystem:
    """带路径白名单的安全文件系统。

    所有操作先经过 PathValidator 校验，再委托给 FileBackend。
    """

    def __init__(self, config: FileSystemConfig | None = None,
                 backend: FileBackend | None = None, **kwargs):
        self.config = config or FileSystemConfig(**kwargs)
        self.validator = PathValidator(self.config)
        self.backend = backend or RealFileBackend()
        self._stats = {"reads": 0, "writes": 0, "denials": 0}

    def read(self, path: str) -> str:
        """读取文件。路径必须在 read_whitelist 内。"""
        try:
            safe_path = self.validator.validate(path, "read")
            self._stats["reads"] += 1
            return self.backend.read(safe_path)
        except PermissionError:
            self._stats["denials"] += 1
            raise

    def write(self, path: str, content: str) -> int:
        """写入文件。路径必须在 write_whitelist 内。"""
        try:
            safe_path = self.validator.validate(path, "write")
            # 文件大小检查
            size = len(content.encode("utf-8"))
            if size > self.config.max_file_size:
                raise ValueError(f"Content too large: {size} > {self.config.max_file_size}")
            self._stats["writes"] += 1
            return self.backend.write(safe_path, content)
        except PermissionError:
            self._stats["denials"] += 1
            raise

    def exists(self, path: str) -> bool:
        safe_path = self.validator.validate(path, "read")
        return self.backend.exists(safe_path)

    def list_dir(self, path: str) -> list[str]:
        safe_path = self.validator.validate(path, "read")
        return self.backend.list_dir(safe_path)

    def delete(self, path: str) -> bool:
        safe_path = self.validator.validate(path, "write")
        return self.backend.delete(safe_path)

    @property
    def stats(self) -> dict:
        return dict(self._stats)
```

### 3.6 任务工作空间

```python
class TaskWorkspace:
    """Agent 任务工作空间。

    每个任务创建独立的临时目录，配置受限的文件访问权限。
    支持 context manager 自动清理。
    """

    def __init__(self, base_dir: str | None = None,
                 extra_read_dirs: list[str] | None = None,
                 backend: FileBackend | None = None):
        self.task_id = str(uuid.uuid4())[:8]
        self.base_dir = base_dir or tempfile.mkdtemp(prefix=f"task_{self.task_id}_")

        # 创建子目录
        self.output_dir = os.path.join(self.base_dir, "output")
        self.cache_dir = os.path.join(self.base_dir, "cache")
        os.makedirs(self.output_dir, exist_ok=True)
        os.makedirs(self.cache_dir, exist_ok=True)

        # 配置安全文件系统
        config = FileSystemConfig(
            read_dirs=[self.base_dir] + (extra_read_dirs or []),
            write_dirs=[self.output_dir, self.cache_dir],
        )
        self.fs = SecureFileSystem(config, backend)

    def read(self, relative_path: str) -> str:
        return self.fs.read(os.path.join(self.base_dir, relative_path))

    def write(self, relative_path: str, content: str) -> int:
        full_path = os.path.join(self.base_dir, relative_path)
        return self.fs.write(full_path, content)

    def cleanup(self):
        if os.path.exists(self.base_dir):
            shutil.rmtree(self.base_dir, ignore_errors=True)

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.cleanup()
```

### 3.7 配置参数速查

| 参数 | 默认值 | 说明 | 调优建议 |
|------|--------|------|----------|
| `read_dirs` | [] | 可读目录白名单 | 按需添加数据目录 |
| `write_dirs` | [] | 可写目录白名单 | 仅开放必要的输出目录 |
| `max_file_size` | 10MB | 单文件大小限制 | 大文件场景可增大 |
| `max_files_per_dir` | 1000 | 目录文件数限制 | 防止文件数爆炸 |
| `blocked_extensions` | .exe/.sh/.bat | 禁止写入的扩展名 | 按安全策略调整 |
| `follow_symlinks` | False | 是否允许符号链接 | 生产环境建议 False |

### 3.8 场景适配矩阵

| 场景 | 推荐配置 | 说明 |
|------|----------|------|
| 研究报告生成 | read=[data], write=[output] | 读取数据，写入报告 |
| 代码分析 | read=[repo], write=[] | 只读分析，不修改源码 |
| 数据处理管道 | read=[input], write=[output,cache] | 读输入，写输出和缓存 |
| 多任务并行 | TaskWorkspace 独立实例 | 每个任务独立工作空间 |
| 测试环境 | MemoryFileBackend | 无磁盘 IO，速度快 |

---

## 第 4 章 测试用例

```python
"""test_secure_filesystem.py — 路径白名单 + 虚拟文件系统完整测试"""
import os
import tempfile
import shutil
import pytest
from secure_filesystem import (
    PathValidator, FileSystemConfig, SecureFileSystem,
    RealFileBackend, MemoryFileBackend, TaskWorkspace,
)


@pytest.fixture
def tmp_dirs():
    """创建临时的读/写目录。"""
    read_dir = tempfile.mkdtemp(prefix="test_read_")
    write_dir = tempfile.mkdtemp(prefix="test_write_")
    # 写入测试文件
    with open(os.path.join(read_dir, "test.txt"), "w") as f:
        f.write("hello")
    yield read_dir, write_dir
    shutil.rmtree(read_dir, ignore_errors=True)
    shutil.rmtree(write_dir, ignore_errors=True)


class TestPathValidator:
    """路径校验器测试。"""

    def test_valid_read_path(self, tmp_dirs):
        read_dir, _ = tmp_dirs
        config = FileSystemConfig(read_dirs=[read_dir])
        validator = PathValidator(config)
        result = validator.validate(os.path.join(read_dir, "test.txt"), "read")
        assert result == os.path.realpath(os.path.join(read_dir, "test.txt"))

    def test_read_outside_whitelist_denied(self, tmp_dirs):
        read_dir, _ = tmp_dirs
        config = FileSystemConfig(read_dirs=[read_dir])
        validator = PathValidator(config)
        with pytest.raises(PermissionError, match="not in read whitelist"):
            validator.validate("/etc/passwd", "read")

    def test_path_traversal_blocked(self, tmp_dirs):
        read_dir, _ = tmp_dirs
        config = FileSystemConfig(read_dirs=[read_dir])
        validator = PathValidator(config)
        # ../.. 尝试逃逸
        evil_path = os.path.join(read_dir, "..", "..", "etc", "passwd")
        with pytest.raises(PermissionError):
            validator.validate(evil_path, "read")

    def test_write_to_read_only_dir_denied(self, tmp_dirs):
        read_dir, _ = tmp_dirs
        config = FileSystemConfig(read_dirs=[read_dir], write_dirs=[])
        validator = PathValidator(config)
        with pytest.raises(PermissionError, match="not in write whitelist"):
            validator.validate(os.path.join(read_dir, "new.txt"), "write")

    def test_valid_write_path(self, tmp_dirs):
        _, write_dir = tmp_dirs
        config = FileSystemConfig(write_dirs=[write_dir])
        validator = PathValidator(config)
        result = validator.validate(os.path.join(write_dir, "output.txt"), "write")
        assert write_dir in result

    def test_write_dir_auto_readable(self, tmp_dirs):
        """写目录自动加入读白名单。"""
        _, write_dir = tmp_dirs
        config = FileSystemConfig(read_dirs=[], write_dirs=[write_dir])
        validator = PathValidator(config)
        # 写目录应该可读
        result = validator.validate(os.path.join(write_dir, "file.txt"), "read")
        assert write_dir in result

    def test_blocked_extension(self, tmp_dirs):
        _, write_dir = tmp_dirs
        config = FileSystemConfig(write_dirs=[write_dir])
        validator = PathValidator(config)
        with pytest.raises(PermissionError, match="Blocked extension"):
            validator.validate(os.path.join(write_dir, "evil.exe"), "write")

    def test_invalid_mode(self, tmp_dirs):
        read_dir, _ = tmp_dirs
        config = FileSystemConfig(read_dirs=[read_dir])
        validator = PathValidator(config)
        with pytest.raises(ValueError, match="Invalid mode"):
            validator.validate(os.path.join(read_dir, "test.txt"), "execute")

    def test_symlink_blocked_by_default(self, tmp_dirs):
        """符号链接默认被拒绝。"""
        read_dir, _ = tmp_dirs
        link_path = os.path.join(read_dir, "link.txt")
        target = os.path.join(read_dir, "test.txt")
        os.symlink(target, link_path)

        config = FileSystemConfig(read_dirs=[read_dir], follow_symlinks=False)
        validator = PathValidator(config)
        with pytest.raises(PermissionError, match="Symlinks not allowed"):
            validator.validate(link_path, "read")

    def test_symlink_allowed_when_configured(self, tmp_dirs):
        """配置允许符号链接时可以访问。"""
        read_dir, _ = tmp_dirs
        link_path = os.path.join(read_dir, "link2.txt")
        target = os.path.join(read_dir, "test.txt")
        os.symlink(target, link_path)

        config = FileSystemConfig(read_dirs=[read_dir], follow_symlinks=True)
        validator = PathValidator(config)
        result = validator.validate(link_path, "read")
        assert os.path.realpath(target) == result


class TestMemoryFileBackend:
    """内存文件系统后端测试。"""

    def setup_method(self):
        self.backend = MemoryFileBackend()

    def test_write_and_read(self):
        self.backend.write("/data/test.txt", "hello")
        assert self.backend.read("/data/test.txt") == "hello"

    def test_read_nonexistent(self):
        with pytest.raises(FileNotFoundError):
            self.backend.read("/data/missing.txt")

    def test_exists(self):
        assert self.backend.exists("/data/test.txt") is False
        self.backend.write("/data/test.txt", "x")
        assert self.backend.exists("/data/test.txt") is True

    def test_delete(self):
        self.backend.write("/data/test.txt", "x")
        assert self.backend.delete("/data/test.txt") is True
        assert self.backend.exists("/data/test.txt") is False

    def test_delete_nonexistent(self):
        assert self.backend.delete("/data/missing.txt") is False

    def test_list_dir(self):
        self.backend.write("/data/a.txt", "a")
        self.backend.write("/data/b.txt", "b")
        self.backend.write("/data/sub/c.txt", "c")
        items = self.backend.list_dir("/data")
        assert "a.txt" in items
        assert "b.txt" in items
        assert "sub" in items

    def test_size(self):
        self.backend.write("/data/test.txt", "hello")
        assert self.backend.size("/data/test.txt") == 5


class TestSecureFileSystem:
    """安全文件系统集成测试。"""

    def test_read_allowed(self, tmp_dirs):
        read_dir, _ = tmp_dirs
        config = FileSystemConfig(read_dirs=[read_dir])
        fs = SecureFileSystem(config)
        content = fs.read(os.path.join(read_dir, "test.txt"))
        assert content == "hello"

    def test_read_denied(self, tmp_dirs):
        read_dir, _ = tmp_dirs
        config = FileSystemConfig(read_dirs=[read_dir])
        fs = SecureFileSystem(config)
        with pytest.raises(PermissionError):
            fs.read("/etc/hostname")

    def test_write_allowed(self, tmp_dirs):
        _, write_dir = tmp_dirs
        config = FileSystemConfig(write_dirs=[write_dir])
        fs = SecureFileSystem(config)
        written = fs.write(os.path.join(write_dir, "out.txt"), "result")
        assert written > 0
        assert os.path.exists(os.path.join(write_dir, "out.txt"))

    def test_write_denied(self, tmp_dirs):
        read_dir, _ = tmp_dirs
        config = FileSystemConfig(read_dirs=[read_dir])
        fs = SecureFileSystem(config)
        with pytest.raises(PermissionError):
            fs.write(os.path.join(read_dir, "hack.txt"), "evil")

    def test_write_too_large(self, tmp_dirs):
        _, write_dir = tmp_dirs
        config = FileSystemConfig(write_dirs=[write_dir], max_file_size=100)
        fs = SecureFileSystem(config)
        with pytest.raises(ValueError, match="too large"):
            fs.write(os.path.join(write_dir, "big.txt"), "x" * 200)

    def test_stats_tracking(self, tmp_dirs):
        read_dir, write_dir = tmp_dirs
        config = FileSystemConfig(read_dirs=[read_dir], write_dirs=[write_dir])
        fs = SecureFileSystem(config)
        fs.read(os.path.join(read_dir, "test.txt"))
        fs.write(os.path.join(write_dir, "out.txt"), "data")
        try:
            fs.read("/etc/passwd")
        except PermissionError:
            pass
        assert fs.stats == {"reads": 1, "writes": 1, "denials": 1}

    def test_with_memory_backend(self):
        """使用内存后端的安全文件系统。"""
        backend = MemoryFileBackend()
        config = FileSystemConfig(read_dirs=["/data"], write_dirs=["/data/output"])
        fs = SecureFileSystem(config, backend)
        fs.write("/data/output/test.txt", "memory data")
        assert fs.read("/data/output/test.txt") == "memory data"


class TestTaskWorkspace:
    """任务工作空间测试。"""

    def test_workspace_creates_dirs(self):
        with TaskWorkspace() as ws:
            assert os.path.isdir(ws.output_dir)
            assert os.path.isdir(ws.cache_dir)

    def test_workspace_write_and_read(self):
        with TaskWorkspace() as ws:
            ws.write("output/report.md", "# Report")
            content = ws.read("output/report.md")
            assert content == "# Report"

    def test_workspace_write_outside_denied(self):
        with TaskWorkspace() as ws:
            with pytest.raises(PermissionError):
                ws.write("../../etc/evil.txt", "hack")

    def test_workspace_cleanup(self):
        ws = TaskWorkspace()
        base = ws.base_dir
        assert os.path.exists(base)
        ws.cleanup()
        assert not os.path.exists(base)

    def test_workspace_context_manager_cleanup(self):
        with TaskWorkspace() as ws:
            base = ws.base_dir
            assert os.path.exists(base)
        assert not os.path.exists(base)

    def test_workspace_extra_read_dirs(self, tmp_dirs):
        read_dir, _ = tmp_dirs
        with TaskWorkspace(extra_read_dirs=[read_dir]) as ws:
            content = ws.fs.read(os.path.join(read_dir, "test.txt"))
            assert content == "hello"

    def test_workspace_isolation(self):
        """两个工作空间互相隔离。"""
        with TaskWorkspace() as ws1, TaskWorkspace() as ws2:
            ws1.write("output/data.txt", "ws1 data")
            # ws2 不能读取 ws1 的文件
            with pytest.raises(PermissionError):
                ws2.fs.read(os.path.join(ws1.output_dir, "data.txt"))
```

---

## 第 5 章 跨域关联

| 关联域 | 关系 | 说明 |
|--------|------|------|
| PD-05.01 subprocess 方案 | 互补 | 本方案控制文件访问，PD-05.01 控制进程隔离，可组合使用 |
| PD-05.02 Docker/E2B 方案 | 替代/互补 | 容器内也可叠加路径白名单做纵深防御 |
| PD-06 记忆持久化 | 集成 | 持久化存储的读写通过 SecureFileSystem 控制权限 |
| PD-08 搜索与检索 | 上游 | 搜索结果保存到工作空间的 output 目录 |
| PD-11 可观测性 | 监控 | 文件访问统计（reads/writes/denials）接入监控 |

---

## 第 6 章 来源文件索引

| 编号 | 文件 | 说明 |
|------|------|------|
| S1 | `src/utils/file_access.py` | 核心：FileAccess 统一接口 + 路径校验 |
| S2 | `src/utils/path_validator.py` | 路径校验器：规范化 + 白名单匹配 |
| S3 | `src/utils/workspace.py` | 工作空间管理：任务级目录隔离 |
| S4 | `src/config/security.py` | 安全配置：白名单路径、文件大小限制 |
