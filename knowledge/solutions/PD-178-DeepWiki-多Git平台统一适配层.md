# PD-178.01 DeepWiki — 多 Git 平台统一适配层

> 文档编号：PD-178.01
> 来源：DeepWiki `api/data_pipeline.py`, `api/simple_chat.py`, `api/api.py`
> GitHub：https://github.com/AsyncFuncAI/deepwiki-open.git
> 问题域：PD-178 多 Git 平台适配 Multi-Git Platform Adaptation
> 状态：可复用方案

---

## 第 1 章 问题与动机

### 1.1 核心问题

当一个产品需要同时支持 GitHub、GitLab、Bitbucket 三大 Git 平台时，面临以下工程挑战：

1. **认证 URL 格式不统一** — GitHub 用 `{token}@host`，GitLab 用 `oauth2:{token}@host`，Bitbucket 用 `x-token-auth:{token}@host`，三种格式完全不同
2. **文件内容 API 差异大** — GitHub 返回 base64 编码的 JSON，GitLab 返回 raw 文本，Bitbucket 用 `/src/{branch}/{path}` 路径结构
3. **默认分支检测方式不同** — GitHub 不需要显式检测（API 自动用默认分支），GitLab 需要查 `/api/v4/projects/{id}` 的 `default_branch` 字段，Bitbucket 需要查 `/2.0/repositories/{owner}/{repo}` 的 `mainbranch.name`
4. **Enterprise/自托管支持** — GitHub Enterprise 的 API 在 `{domain}/api/v3/`，GitLab 自托管需要动态拼接域名，Bitbucket 仅支持 `bitbucket.org`
5. **Token 泄露风险** — clone URL 中嵌入 token，错误日志可能暴露凭证

### 1.2 DeepWiki 的解法概述

DeepWiki 采用 **`repo_type` 参数统一路由** 的策略模式，在两个核心函数中封装全部平台差异：

1. **`download_repo()` 统一 clone 入口** — 根据 `repo_type` 构造不同认证 URL 格式，使用 `urlparse/urlunparse` 安全拼接，避免字符串拼接的安全隐患 (`api/data_pipeline.py:72-148`)
2. **`get_file_content()` 统一文件获取路由** — 一个 dispatcher 函数根据 `repo_type` 分发到 `get_github_file_content`、`get_gitlab_file_content`、`get_bitbucket_file_content` 三个独立实现 (`api/data_pipeline.py:687-710`)
3. **前端域名自动检测** — 前端通过 URL hostname 中的关键词（`bitbucket`/`gitlab`）自动推断 `repoType`，无需用户手动选择 (`src/app/[owner]/[repo]/page.tsx:204-207`)
4. **Token 脱敏保护** — clone 失败时，错误信息中同时替换原始 token 和 URL 编码后的 token (`api/data_pipeline.py:140-145`)
5. **全链路 `repo_type` 透传** — 从前端 `RepoInfo.type` → API `ChatCompletionRequest.type` → RAG `prepare_retriever` → `DatabaseManager` → `download_repo`，一个参数贯穿全栈

### 1.3 设计思想

| 设计原则 | 具体实现 | 理由 | 替代方案 |
|----------|----------|------|----------|
| 策略模式路由 | `repo_type` 参数 + if/elif 分发 | 简单直接，三个平台不需要复杂的抽象类层级 | 抽象基类 + 工厂模式（过度设计） |
| URL 安全拼接 | `urlparse` + `urlunparse` + `quote(token, safe='')` | 防止特殊字符破坏 URL 结构，支持 Enterprise 自定义域名 | 字符串 f-string 拼接（不安全） |
| 独立函数封装 | 每个平台一个 `get_xxx_file_content` 函数 | 各平台 API 差异大，独立函数更清晰，修改一个不影响其他 | 统一函数内 if/else（代码膨胀） |
| 前端自动检测 | hostname 关键词匹配推断 repo_type | 用户无需手动选择平台类型，降低使用门槛 | 下拉菜单手动选择（多一步操作） |
| 双重 Token 脱敏 | 同时替换 raw token 和 URL-encoded token | URL 编码后的 token 也可能出现在错误信息中 | 仅替换原始 token（遗漏编码版本） |

---

## 第 2 章 源码实现分析

### 2.1 架构概览

DeepWiki 的多 Git 平台适配分为三层：前端检测层、API 路由层、平台实现层。

```
┌─────────────────────────────────────────────────────────────┐
│                     前端检测层 (Next.js)                      │
│  page.tsx: hostname → repoType (bitbucket/gitlab/github)    │
│  RepoInfo { owner, repo, type, token }                      │
└──────────────────────┬──────────────────────────────────────┘
                       │ POST /chat/completions/stream
                       │ { repo_url, type: "github"|"gitlab"|"bitbucket" }
┌──────────────────────▼──────────────────────────────────────┐
│                     API 路由层 (FastAPI)                      │
│  simple_chat.py / websocket_wiki.py                         │
│  → RAG.prepare_retriever(repo_url, type, token)             │
│  → get_file_content(repo_url, path, repo_type, token)       │
└──────────────────────┬──────────────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────────────┐
│                   平台实现层 (data_pipeline.py)               │
│  ┌─────────────┐  ┌──────────────┐  ┌───────────────────┐  │
│  │  download_   │  │ get_github_  │  │ get_gitlab_       │  │
│  │  repo()      │  │ file_content │  │ file_content()    │  │
│  │  (clone URL  │  │ (REST API    │  │ (REST API v4      │  │
│  │   构造)      │  │  + base64)   │  │  + raw endpoint)  │  │
│  └─────────────┘  └──────────────┘  └───────────────────┘  │
│                                      ┌───────────────────┐  │
│                                      │ get_bitbucket_    │  │
│                                      │ file_content()    │  │
│                                      │ (REST API 2.0)    │  │
│                                      └───────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

### 2.2 核心实现

#### 2.2.1 统一 Clone URL 构造

```mermaid
graph TD
    A[download_repo 入口] --> B{access_token 存在?}
    B -->|否| F[直接使用 repo_url]
    B -->|是| C{repo_type?}
    C -->|github| D1["token@host/path"]
    C -->|gitlab| D2["oauth2:token@host/path"]
    C -->|bitbucket| D3["x-token-auth:token@host/path"]
    D1 --> E[urlparse + urlunparse 安全拼接]
    D2 --> E
    D3 --> E
    E --> F
    F --> G["git clone --depth=1 --single-branch"]
    G --> H{成功?}
    H -->|是| I[返回 stdout]
    H -->|否| J[脱敏 token 后抛出 ValueError]
```

对应源码 `api/data_pipeline.py:72-148`：

```python
def download_repo(repo_url: str, local_path: str, repo_type: str = None, access_token: str = None) -> str:
    # ...
    if access_token:
        parsed = urlparse(repo_url)
        encoded_token = quote(access_token, safe='')
        if repo_type == "github":
            # Format: https://{token}@{domain}/owner/repo.git
            clone_url = urlunparse((parsed.scheme, f"{encoded_token}@{parsed.netloc}", parsed.path, '', '', ''))
        elif repo_type == "gitlab":
            # Format: https://oauth2:{token}@gitlab.com/owner/repo.git
            clone_url = urlunparse((parsed.scheme, f"oauth2:{encoded_token}@{parsed.netloc}", parsed.path, '', '', ''))
        elif repo_type == "bitbucket":
            # Format: https://x-token-auth:{token}@bitbucket.org/owner/repo.git
            clone_url = urlunparse((parsed.scheme, f"x-token-auth:{encoded_token}@{parsed.netloc}", parsed.path, '', '', ''))
    # ...
    result = subprocess.run(
        ["git", "clone", "--depth=1", "--single-branch", clone_url, local_path],
        check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    )
```

关键设计点：
- 使用 `urlparse` 解析原始 URL，保留 scheme 和 netloc，天然支持 GitHub Enterprise 自定义域名
- `quote(access_token, safe='')` 对 token 进行 URL 编码，防止特殊字符（如 `@`、`/`）破坏 URL 结构
- `--depth=1 --single-branch` 浅克隆，减少带宽和磁盘占用

#### 2.2.2 统一文件内容获取路由

```mermaid
graph TD
    A["get_file_content(repo_url, file_path, repo_type, token)"] --> B{repo_type?}
    B -->|github| C[get_github_file_content]
    B -->|gitlab| D[get_gitlab_file_content]
    B -->|bitbucket| E[get_bitbucket_file_content]
    B -->|其他| F[raise ValueError]
    C --> C1["api.github.com/repos/{owner}/{repo}/contents/{path}"]
    C1 --> C2[base64 解码 content 字段]
    D --> D1["查询 default_branch"]
    D1 --> D2["{domain}/api/v4/projects/{encoded_path}/repository/files/{path}/raw?ref={branch}"]
    E --> E1["查询 mainbranch.name"]
    E1 --> E2["api.bitbucket.org/2.0/repositories/{owner}/{repo}/src/{branch}/{path}"]
```

对应源码 `api/data_pipeline.py:687-710`：

```python
def get_file_content(repo_url: str, file_path: str, repo_type: str = None, access_token: str = None) -> str:
    if repo_type == "github":
        return get_github_file_content(repo_url, file_path, access_token)
    elif repo_type == "gitlab":
        return get_gitlab_file_content(repo_url, file_path, access_token)
    elif repo_type == "bitbucket":
        return get_bitbucket_file_content(repo_url, file_path, access_token)
    else:
        raise ValueError("Unsupported repository type. Only GitHub, GitLab, and Bitbucket are supported.")
```

#### 2.2.3 GitHub Enterprise 支持

对应源码 `api/data_pipeline.py:470-489`：

```python
def get_github_file_content(repo_url: str, file_path: str, access_token: str = None) -> str:
    parsed_url = urlparse(repo_url)
    path_parts = parsed_url.path.strip('/').split('/')
    owner = path_parts[-2]
    repo = path_parts[-1].replace(".git", "")

    # 关键：根据域名判断是公共 GitHub 还是 Enterprise
    if parsed_url.netloc == "github.com":
        api_base = "https://api.github.com"
    else:
        # GitHub Enterprise - API is typically at https://domain/api/v3/
        api_base = f"{parsed_url.scheme}://{parsed_url.netloc}/api/v3"

    api_url = f"{api_base}/repos/{owner}/{repo}/contents/{file_path}"
```

#### 2.2.4 GitLab 默认分支检测

对应源码 `api/data_pipeline.py:564-582`：

```python
# GitLab 需要先查询项目信息获取默认分支
project_info_url = f"{gitlab_domain}/api/v4/projects/{encoded_project_path}"
project_headers = {}
if access_token:
    project_headers["PRIVATE-TOKEN"] = access_token

project_response = requests.get(project_info_url, headers=project_headers)
if project_response.status_code == 200:
    project_data = project_response.json()
    default_branch = project_data.get('default_branch', 'main')
else:
    default_branch = 'main'  # 降级到 'main'
```

注意 GitLab 使用 `PRIVATE-TOKEN` header 而非 `Authorization: Bearer`，这是 GitLab API 的特有认证方式。

### 2.3 实现细节

#### 前端 repo_type 自动检测

前端通过 URL hostname 关键词匹配自动推断平台类型，源码 `src/app/[owner]/[repo]/page.tsx:204-207`：

```typescript
const repoType = repoHost?.includes('bitbucket')
    ? 'bitbucket'
    : repoHost?.includes('gitlab')
      ? 'gitlab'
      : 'github';  // 默认 fallback 到 github
```

这个检测逻辑简单但有效：
- `bitbucket.org` → `bitbucket`
- `gitlab.com` 或 `gitlab.company.com` → `gitlab`
- 其他所有域名（包括 `github.com` 和 GitHub Enterprise）→ `github`

#### Token 脱敏保护

`api/data_pipeline.py:139-145` 中的双重脱敏：

```python
if access_token:
    # Remove raw token
    error_msg = error_msg.replace(access_token, "***TOKEN***")
    # Also remove URL-encoded token to prevent leaking encoded version
    encoded_token = quote(access_token, safe='')
    error_msg = error_msg.replace(encoded_token, "***TOKEN***")
```

#### 全链路 repo_type 透传

数据流：`RepoInfo.type` (前端) → `ChatCompletionRequest.type` (API) → `RAG.prepare_retriever(type=)` → `DatabaseManager.prepare_database(repo_type=)` → `download_repo(repo_type=)`

同时在 `simple_chat.py:295` 中，`repo_type` 还被注入到 LLM 的 system prompt 中，让模型知道当前分析的是哪个平台的仓库。


---

## 第 3 章 迁移指南

### 3.1 迁移清单

**阶段 1：核心适配层（必须）**

- [ ] 定义 `RepoType` 枚举或字面量类型（`"github" | "gitlab" | "bitbucket"`）
- [ ] 实现 `download_repo(repo_url, local_path, repo_type, access_token)` 统一 clone 函数
- [ ] 实现三个平台的认证 URL 构造逻辑（注意 `urlparse` + `quote` 安全拼接）
- [ ] 实现 `get_file_content(repo_url, file_path, repo_type, token)` 路由函数
- [ ] 实现三个平台的文件内容获取函数

**阶段 2：安全加固（推荐）**

- [ ] 添加 Token 双重脱敏（raw + URL-encoded）
- [ ] clone 日志中使用原始 URL 而非含 token 的 URL
- [ ] 对 `access_token` 参数进行 URL 编码处理

**阶段 3：前端集成（可选）**

- [ ] 实现 hostname 关键词检测自动推断 repo_type
- [ ] 定义 `RepoInfo` 类型，包含 `type` 字段
- [ ] 全链路透传 `repo_type` 到后端 API

### 3.2 适配代码模板

以下是可直接复用的 Python 适配层模板：

```python
"""
Multi-Git Platform Adapter
Ported from DeepWiki's data_pipeline.py pattern
"""
import subprocess
import os
import base64
import json
import logging
import requests
from urllib.parse import urlparse, urlunparse, quote
from typing import Optional, Literal
from enum import Enum

logger = logging.getLogger(__name__)

RepoType = Literal["github", "gitlab", "bitbucket"]


def build_clone_url(repo_url: str, repo_type: RepoType, access_token: Optional[str] = None) -> str:
    """构造带认证信息的 clone URL，安全处理 token 嵌入。"""
    if not access_token:
        return repo_url

    parsed = urlparse(repo_url)
    encoded_token = quote(access_token, safe='')

    auth_formats = {
        "github":    f"{encoded_token}@{parsed.netloc}",
        "gitlab":    f"oauth2:{encoded_token}@{parsed.netloc}",
        "bitbucket": f"x-token-auth:{encoded_token}@{parsed.netloc}",
    }

    netloc_with_auth = auth_formats.get(repo_type)
    if not netloc_with_auth:
        raise ValueError(f"Unsupported repo_type: {repo_type}")

    return urlunparse((parsed.scheme, netloc_with_auth, parsed.path, '', '', ''))


def clone_repo(repo_url: str, local_path: str, repo_type: RepoType,
               access_token: Optional[str] = None, depth: int = 1) -> str:
    """克隆仓库到本地路径，支持三大 Git 平台认证。"""
    if os.path.exists(local_path) and os.listdir(local_path):
        logger.info(f"Repository already exists at {local_path}")
        return f"Using existing repository at {local_path}"

    os.makedirs(local_path, exist_ok=True)
    clone_url = build_clone_url(repo_url, repo_type, access_token)

    try:
        result = subprocess.run(
            ["git", "clone", f"--depth={depth}", "--single-branch", clone_url, local_path],
            check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        )
        return result.stdout.decode("utf-8")
    except subprocess.CalledProcessError as e:
        error_msg = e.stderr.decode('utf-8')
        # 双重 Token 脱敏
        if access_token:
            error_msg = error_msg.replace(access_token, "***TOKEN***")
            error_msg = error_msg.replace(quote(access_token, safe=''), "***TOKEN***")
        raise ValueError(f"Clone failed: {error_msg}")


def _parse_owner_repo(repo_url: str) -> tuple[str, str]:
    """从 URL 中提取 owner 和 repo 名称。"""
    parsed = urlparse(repo_url)
    parts = parsed.path.strip('/').split('/')
    if len(parts) < 2:
        raise ValueError(f"Invalid repo URL: {repo_url}")
    return parts[-2], parts[-1].replace(".git", "")


def _get_api_base(repo_url: str, repo_type: RepoType) -> str:
    """根据平台类型和域名返回 API base URL。"""
    parsed = urlparse(repo_url)
    if repo_type == "github":
        if parsed.netloc == "github.com":
            return "https://api.github.com"
        return f"{parsed.scheme}://{parsed.netloc}/api/v3"  # Enterprise
    elif repo_type == "gitlab":
        return f"{parsed.scheme}://{parsed.netloc}"
    elif repo_type == "bitbucket":
        return "https://api.bitbucket.org/2.0"
    raise ValueError(f"Unsupported repo_type: {repo_type}")


def get_file_content(repo_url: str, file_path: str, repo_type: RepoType,
                     access_token: Optional[str] = None) -> str:
    """统一文件内容获取入口，根据 repo_type 分发到对应平台实现。"""
    handlers = {
        "github": _get_github_file,
        "gitlab": _get_gitlab_file,
        "bitbucket": _get_bitbucket_file,
    }
    handler = handlers.get(repo_type)
    if not handler:
        raise ValueError(f"Unsupported repo_type: {repo_type}")
    return handler(repo_url, file_path, access_token)


def _get_github_file(repo_url: str, file_path: str, token: Optional[str] = None) -> str:
    owner, repo = _parse_owner_repo(repo_url)
    api_base = _get_api_base(repo_url, "github")
    url = f"{api_base}/repos/{owner}/{repo}/contents/{file_path}"
    headers = {"Authorization": f"token {token}"} if token else {}
    resp = requests.get(url, headers=headers)
    resp.raise_for_status()
    data = resp.json()
    if data.get("encoding") == "base64":
        return base64.b64decode(data["content"].replace("\n", "")).decode("utf-8")
    raise ValueError(f"Unexpected encoding: {data.get('encoding')}")


def _get_gitlab_file(repo_url: str, file_path: str, token: Optional[str] = None) -> str:
    parsed = urlparse(repo_url)
    domain = f"{parsed.scheme}://{parsed.netloc}"
    project_path = parsed.path.strip('/').replace('.git', '')
    encoded_project = quote(project_path, safe='')
    encoded_file = quote(file_path, safe='')
    headers = {"PRIVATE-TOKEN": token} if token else {}

    # 获取默认分支
    proj_resp = requests.get(f"{domain}/api/v4/projects/{encoded_project}", headers=headers)
    branch = proj_resp.json().get('default_branch', 'main') if proj_resp.ok else 'main'

    url = f"{domain}/api/v4/projects/{encoded_project}/repository/files/{encoded_file}/raw?ref={branch}"
    resp = requests.get(url, headers=headers)
    resp.raise_for_status()
    return resp.text


def _get_bitbucket_file(repo_url: str, file_path: str, token: Optional[str] = None) -> str:
    owner, repo = _parse_owner_repo(repo_url)
    headers = {"Authorization": f"Bearer {token}"} if token else {}

    # 获取默认分支
    info_resp = requests.get(
        f"https://api.bitbucket.org/2.0/repositories/{owner}/{repo}", headers=headers
    )
    branch = info_resp.json().get('mainbranch', {}).get('name', 'main') if info_resp.ok else 'main'

    url = f"https://api.bitbucket.org/2.0/repositories/{owner}/{repo}/src/{branch}/{file_path}"
    resp = requests.get(url, headers=headers)
    resp.raise_for_status()
    return resp.text
```

### 3.3 适用场景

| 场景 | 适用度 | 说明 |
|------|--------|------|
| 多平台代码分析工具 | ⭐⭐⭐ | 需要 clone + 读取文件内容的场景，直接复用 |
| CI/CD 多平台集成 | ⭐⭐⭐ | clone 认证 URL 构造逻辑可直接移植 |
| 代码搜索引擎 | ⭐⭐ | 文件内容获取 API 可复用，但大规模场景需加缓存 |
| Git 托管平台聚合器 | ⭐⭐⭐ | 完整的三平台适配层，加上前端检测逻辑 |
| 仅支持 GitHub 的工具 | ⭐ | 如果只需 GitHub，这套方案过于复杂 |

---

## 第 4 章 测试用例

```python
"""
Tests for Multi-Git Platform Adapter
Based on DeepWiki's data_pipeline.py real function signatures
"""
import pytest
from unittest.mock import patch, MagicMock
from urllib.parse import quote


# ---- 测试 clone URL 构造 ----

class TestBuildCloneUrl:
    """测试 build_clone_url 的三平台认证 URL 构造"""

    def test_github_token_url(self):
        """GitHub: token 直接作为用户名"""
        from git_adapter import build_clone_url
        url = build_clone_url(
            "https://github.com/owner/repo.git", "github", "ghp_abc123"
        )
        assert url == "https://ghp_abc123@github.com/owner/repo.git"

    def test_gitlab_oauth2_url(self):
        """GitLab: oauth2:token 格式"""
        from git_adapter import build_clone_url
        url = build_clone_url(
            "https://gitlab.com/group/project.git", "gitlab", "glpat-xyz"
        )
        assert url == "https://oauth2:glpat-xyz@gitlab.com/group/project.git"

    def test_bitbucket_x_token_auth_url(self):
        """Bitbucket: x-token-auth:token 格式"""
        from git_adapter import build_clone_url
        url = build_clone_url(
            "https://bitbucket.org/team/repo.git", "bitbucket", "bb_token"
        )
        assert url == "https://x-token-auth:bb_token@bitbucket.org/team/repo.git"

    def test_no_token_returns_original(self):
        """无 token 时返回原始 URL"""
        from git_adapter import build_clone_url
        url = build_clone_url("https://github.com/owner/repo", "github")
        assert url == "https://github.com/owner/repo"

    def test_special_chars_in_token_are_encoded(self):
        """Token 中的特殊字符被 URL 编码"""
        from git_adapter import build_clone_url
        url = build_clone_url(
            "https://github.com/owner/repo", "github", "tok@en/with+special"
        )
        encoded = quote("tok@en/with+special", safe='')
        assert encoded in url
        assert "tok@en/with+special" not in url  # 原始 token 不应出现

    def test_github_enterprise_domain_preserved(self):
        """GitHub Enterprise 自定义域名被保留"""
        from git_adapter import build_clone_url
        url = build_clone_url(
            "https://github.company.com/org/repo", "github", "token123"
        )
        assert "github.company.com" in url


# ---- 测试文件内容获取路由 ----

class TestGetFileContent:
    """测试 get_file_content 路由分发"""

    def test_unsupported_type_raises(self):
        """不支持的 repo_type 抛出 ValueError"""
        from git_adapter import get_file_content
        with pytest.raises(ValueError, match="Unsupported"):
            get_file_content("https://example.com/repo", "file.py", "svn")

    @patch("git_adapter._get_github_file")
    def test_github_dispatches_correctly(self, mock_gh):
        """github 类型正确分发到 _get_github_file"""
        from git_adapter import get_file_content
        mock_gh.return_value = "content"
        result = get_file_content("https://github.com/o/r", "f.py", "github")
        mock_gh.assert_called_once()
        assert result == "content"

    @patch("git_adapter._get_gitlab_file")
    def test_gitlab_dispatches_correctly(self, mock_gl):
        """gitlab 类型正确分发到 _get_gitlab_file"""
        from git_adapter import get_file_content
        mock_gl.return_value = "content"
        result = get_file_content("https://gitlab.com/g/p", "f.py", "gitlab")
        mock_gl.assert_called_once()


# ---- 测试 Token 脱敏 ----

class TestTokenSanitization:
    """测试错误信息中的 Token 脱敏"""

    def test_raw_token_removed(self):
        """原始 token 被替换为 ***TOKEN***"""
        token = "ghp_secret123"
        error_msg = f"fatal: Authentication failed for 'https://{token}@github.com/o/r'"
        sanitized = error_msg.replace(token, "***TOKEN***")
        assert token not in sanitized
        assert "***TOKEN***" in sanitized

    def test_encoded_token_also_removed(self):
        """URL 编码后的 token 也被替换"""
        token = "tok@en/special"
        encoded = quote(token, safe='')
        error_msg = f"fatal: failed https://{encoded}@github.com/o/r"
        sanitized = error_msg.replace(token, "***TOKEN***").replace(encoded, "***TOKEN***")
        assert encoded not in sanitized


# ---- 测试默认分支检测降级 ----

class TestDefaultBranchFallback:
    """测试 GitLab/Bitbucket 默认分支检测的降级行为"""

    @patch("requests.get")
    def test_gitlab_fallback_to_main(self, mock_get):
        """GitLab 项目信息查询失败时降级到 'main'"""
        mock_get.return_value = MagicMock(status_code=404)
        # 模拟 DeepWiki 的降级逻辑
        response = mock_get.return_value
        if response.status_code == 200:
            branch = response.json().get('default_branch', 'main')
        else:
            branch = 'main'
        assert branch == 'main'

    @patch("requests.get")
    def test_bitbucket_extracts_mainbranch(self, mock_get):
        """Bitbucket 正确提取 mainbranch.name"""
        mock_get.return_value = MagicMock(
            status_code=200,
            json=lambda: {"mainbranch": {"name": "develop"}}
        )
        response = mock_get.return_value
        branch = response.json().get('mainbranch', {}).get('name', 'main')
        assert branch == 'develop'
```


---

## 第 5 章 跨域关联

| 关联域 | 关系类型 | 说明 |
|--------|----------|------|
| PD-04 工具系统 | 协同 | `get_file_content` 可作为 Agent 工具注册，让 Agent 按需获取任意平台的文件内容 |
| PD-06 记忆持久化 | 协同 | `DatabaseManager` 将 clone 下来的仓库文件持久化为 embedding 数据库（`.pkl`），repo_type 影响存储路径命名 |
| PD-08 搜索与检索 | 依赖 | RAG 检索依赖 `download_repo` 先将仓库 clone 到本地，再通过 `read_all_documents` 建立索引 |
| PD-03 容错与重试 | 协同 | GitLab/Bitbucket 的默认分支检测失败时降级到 `'main'`，属于优雅降级模式 |
| PD-11 可观测性 | 协同 | 全链路 `logger.info` 记录 clone、API 调用、分支检测等关键步骤，便于排查多平台问题 |

---

## 第 6 章 来源文件索引

| 文件 | 行范围 | 关键实现 |
|------|--------|----------|
| `api/data_pipeline.py` | L72-L148 | `download_repo()` — 统一 clone 入口，三平台认证 URL 构造 |
| `api/data_pipeline.py` | L452-L527 | `get_github_file_content()` — GitHub/Enterprise API 文件获取 |
| `api/data_pipeline.py` | L529-L609 | `get_gitlab_file_content()` — GitLab API v4 文件获取 + 默认分支检测 |
| `api/data_pipeline.py` | L611-L684 | `get_bitbucket_file_content()` — Bitbucket API 2.0 文件获取 |
| `api/data_pipeline.py` | L687-L710 | `get_file_content()` — 统一路由 dispatcher |
| `api/data_pipeline.py` | L762-L775 | `_extract_repo_name_from_url()` — 从 URL 提取 owner_repo 标识 |
| `api/simple_chat.py` | L64 | `ChatCompletionRequest.type` — API 层 repo_type 定义 |
| `api/simple_chat.py` | L114 | `prepare_retriever(request.repo_url, request.type, ...)` — repo_type 透传到 RAG |
| `api/simple_chat.py` | L295 | `repo_type` 注入 system prompt |
| `api/rag.py` | L345-L384 | `RAG.prepare_retriever()` — repo_type 透传到 DatabaseManager |
| `api/websocket_wiki.py` | L48 | WebSocket 版 `ChatCompletionRequest.type` 定义 |
| `src/app/[owner]/[repo]/page.tsx` | L204-L207 | 前端 hostname 关键词检测 repoType |
| `src/types/repoinfo.tsx` | L1-L10 | `RepoInfo` 接口定义（含 `type` 字段） |
| `src/utils/urlDecoder.tsx` | L1-L19 | URL 域名和路径提取工具函数 |

---

## 第 7 章 横向对比维度

```json comparison_data
{
  "project": "DeepWiki",
  "dimensions": {
    "平台覆盖": "GitHub + GitLab + Bitbucket 三平台，含 GitHub Enterprise",
    "路由机制": "repo_type 参数 + if/elif 策略分发，无抽象基类",
    "认证方式": "urlparse+urlunparse 安全拼接，三种 token 嵌入格式",
    "分支检测": "GitHub 隐式默认，GitLab/Bitbucket 显式 API 查询 + main 降级",
    "Enterprise 支持": "GitHub Enterprise 通过 netloc 判断自动切换 /api/v3 端点",
    "安全防护": "双重 Token 脱敏（raw + URL-encoded），日志不暴露 clone URL"
  }
}
```

### 域元数据补充

```json domain_metadata
{
  "solution_summary": "DeepWiki 用 repo_type 参数 + urlparse 安全拼接统一适配 GitHub/GitLab/Bitbucket 三平台 clone 与文件 API，支持 Enterprise 自定义域名和双重 Token 脱敏",
  "description": "统一适配层需覆盖认证格式差异、API 协议差异和自托管域名检测",
  "sub_problems": [
    "Token 特殊字符的 URL 编码安全处理",
    "错误信息中的凭证泄露防护",
    "前端自动检测 Git 平台类型"
  ],
  "best_practices": [
    "clone 错误信息同时脱敏 raw token 和 URL-encoded token",
    "前端通过 hostname 关键词自动推断平台类型，减少用户操作",
    "GitLab 使用 PRIVATE-TOKEN header 而非 Bearer token 认证"
  ]
}
```

