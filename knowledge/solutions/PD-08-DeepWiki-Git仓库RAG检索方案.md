# PD-08.03 DeepWiki — Git 仓库 RAG 检索

> 文档编号：PD-08.03
> 来源：DeepWiki `api/rag/` / `api/data_pipeline/`
> GitHub：https://github.com/AsyncFuncAI/deepwiki-open
> 问题域：PD-08 搜索与检索 Search & Retrieval
> 状态：可复用方案

---

## 第 1 章 问题与动机

### 1.1 核心问题

理解一个 Git 仓库的代码需要回答各种问题：

```
"这个项目的入口文件在哪？"
"AuthService 类的依赖关系是什么？"
"数据库迁移是怎么处理的？"
"这个函数被哪些模块调用？"
```

传统搜索（grep/ripgrep）只能做文本匹配，无法理解代码语义。RAG（Retrieval-Augmented Generation）通过向量嵌入实现语义检索：

- 将代码文件切分为 chunk，生成向量嵌入
- 用户查询也生成向量
- 通过向量相似度找到最相关的代码片段
- 将相关代码作为上下文传给 LLM 回答问题

### 1.2 DeepWiki 的解法概述

DeepWiki 实现了完整的 Git 仓库 RAG 流水线：

- **仓库克隆与文件索引**：git clone → 文件遍历 → 过滤二进制/大文件
- **智能分块**：按文件类型选择分块策略（代码按函数/类，文档按段落）
- **向量嵌入**：使用 OpenAI/本地模型生成代码嵌入
- **向量存储**：ChromaDB / FAISS 存储和检索
- **RAG 查询**：语义检索 + LLM 生成回答

### 1.3 设计思想

| 原则 | 说明 |
|------|------|
| 代码感知分块 | 按语法结构（函数、类）分块，而非固定长度 |
| 文件结构保留 | 嵌入时保留文件路径信息，支持结构查询 |
| 增量索引 | 只索引变更文件，避免全量重建 |
| 多粒度检索 | 文件级 + 函数级 + 行级多粒度 |
| 元数据增强 | 嵌入附带文件路径、语言、大小等元数据 |

---

## 第 2 章 源码实现分析

### 2.1 整体架构

```
DeepWiki RAG Pipeline:

  git clone → FileScanner → Chunker → Embedder → VectorStore
                  │              │          │           │
                  ▼              ▼          ▼           ▼
            文件列表        代码块列表    向量列表     ChromaDB
                                                       │
  用户查询 → QueryEmbedder → VectorSearch → Context → LLM → 回答
```

### 2.2 文件扫描与过滤

```python
# 源码简化自 DeepWiki api/data_pipeline/file_scanner.py
import os
from pathlib import Path
from dataclasses import dataclass, field


IGNORE_PATTERNS = {
    "dirs": {".git", "node_modules", "__pycache__", ".venv", "dist", "build",
             ".next", ".nuxt", "vendor", ".tox", "eggs"},
    "extensions": {".pyc", ".pyo", ".so", ".dll", ".exe", ".bin", ".dat",
                   ".png", ".jpg", ".gif", ".svg", ".ico", ".woff", ".ttf",
                   ".lock", ".map"},
    "files": {"package-lock.json", "yarn.lock", "pnpm-lock.yaml",
              "poetry.lock", "Pipfile.lock"},
}

MAX_FILE_SIZE = 500_000  # 500KB


@dataclass
class FileInfo:
    """文件信息"""
    path: str           # 相对路径
    language: str       # 编程语言
    size: int           # 文件大小（字节）
    content: str = ""   # 文件内容


class FileScanner:
    """Git 仓库文件扫描器"""

    def __init__(self, repo_path: str, ignore_patterns: dict | None = None):
        self.repo_path = Path(repo_path)
        self.patterns = ignore_patterns or IGNORE_PATTERNS

    def scan(self) -> list[FileInfo]:
        """扫描仓库，返回可索引的文件列表"""
        files = []
        for root, dirs, filenames in os.walk(self.repo_path):
            # 过滤忽略目录
            dirs[:] = [d for d in dirs if d not in self.patterns["dirs"]]

            for fname in filenames:
                filepath = Path(root) / fname
                rel_path = str(filepath.relative_to(self.repo_path))

                # 过滤规则
                if fname in self.patterns["files"]:
                    continue
                if filepath.suffix in self.patterns["extensions"]:
                    continue
                if filepath.stat().st_size > MAX_FILE_SIZE:
                    continue

                try:
                    content = filepath.read_text(encoding="utf-8", errors="ignore")
                except Exception:
                    continue

                files.append(FileInfo(
                    path=rel_path,
                    language=self._detect_language(filepath.suffix),
                    size=len(content),
                    content=content,
                ))

        return files

    @staticmethod
    def _detect_language(suffix: str) -> str:
        LANG_MAP = {
            ".py": "python", ".js": "javascript", ".ts": "typescript",
            ".java": "java", ".go": "go", ".rs": "rust", ".rb": "ruby",
            ".cpp": "cpp", ".c": "c", ".cs": "csharp", ".php": "php",
            ".swift": "swift", ".kt": "kotlin", ".md": "markdown",
            ".yaml": "yaml", ".yml": "yaml", ".json": "json",
            ".toml": "toml", ".html": "html", ".css": "css",
        }
        return LANG_MAP.get(suffix, "text")
```

### 2.3 代码感知分块

```python
# 源码简化自 DeepWiki api/rag/chunker.py
import re
from dataclasses import dataclass


@dataclass
class CodeChunk:
    """代码块"""
    file_path: str
    language: str
    content: str
    start_line: int
    end_line: int
    chunk_type: str  # function, class, module, paragraph
    metadata: dict = field(default_factory=dict)


class CodeChunker:
    """代码感知分块器"""

    def __init__(self, max_chunk_size: int = 1500, overlap: int = 200):
        self.max_chunk_size = max_chunk_size
        self.overlap = overlap

    def chunk_file(self, file_info: FileInfo) -> list[CodeChunk]:
        """根据文件类型选择分块策略"""
        if file_info.language in ("python", "javascript", "typescript", "java", "go"):
            return self._chunk_by_syntax(file_info)
        elif file_info.language in ("markdown", "text"):
            return self._chunk_by_paragraph(file_info)
        else:
            return self._chunk_by_lines(file_info)

    def _chunk_by_syntax(self, file_info: FileInfo) -> list[CodeChunk]:
        """按语法结构分块（函数、类）"""
        chunks = []
        lines = file_info.content.split("\n")

        # 简化的语法分块：按 def/class/function 关键词分割
        patterns = {
            "python": r"^(class |def |async def )",
            "javascript": r"^(function |class |const \w+ = |export )",
            "typescript": r"^(function |class |const \w+ = |export |interface )",
            "java": r"^(\s*(public|private|protected)?\s*(static)?\s*(class|interface|void|int|String))",
            "go": r"^(func |type )",
        }

        pattern = patterns.get(file_info.language, r"^(def |class |function )")
        current_chunk_start = 0
        current_chunk_lines = []

        for i, line in enumerate(lines):
            if re.match(pattern, line) and current_chunk_lines:
                # 保存当前块
                content = "\n".join(current_chunk_lines)
                if content.strip():
                    chunks.append(CodeChunk(
                        file_path=file_info.path,
                        language=file_info.language,
                        content=content,
                        start_line=current_chunk_start + 1,
                        end_line=i,
                        chunk_type="function",
                        metadata={"file_size": file_info.size},
                    ))
                current_chunk_start = i
                current_chunk_lines = [line]
            else:
                current_chunk_lines.append(line)

            # 超过最大块大小时强制分割
            if len("\n".join(current_chunk_lines)) > self.max_chunk_size:
                content = "\n".join(current_chunk_lines)
                chunks.append(CodeChunk(
                    file_path=file_info.path,
                    language=file_info.language,
                    content=content,
                    start_line=current_chunk_start + 1,
                    end_line=i + 1,
                    chunk_type="module",
                ))
                current_chunk_start = i + 1
                current_chunk_lines = []

        # 最后一块
        if current_chunk_lines:
            content = "\n".join(current_chunk_lines)
            if content.strip():
                chunks.append(CodeChunk(
                    file_path=file_info.path,
                    language=file_info.language,
                    content=content,
                    start_line=current_chunk_start + 1,
                    end_line=len(lines),
                    chunk_type="function",
                ))

        return chunks if chunks else [CodeChunk(
            file_path=file_info.path, language=file_info.language,
            content=file_info.content, start_line=1,
            end_line=len(lines), chunk_type="module",
        )]

    def _chunk_by_paragraph(self, file_info: FileInfo) -> list[CodeChunk]:
        """按段落分块（Markdown/文本）"""
        paragraphs = re.split(r"\n\n+", file_info.content)
        chunks = []
        current = ""
        start_line = 1

        for para in paragraphs:
            if len(current) + len(para) > self.max_chunk_size and current:
                chunks.append(CodeChunk(
                    file_path=file_info.path, language=file_info.language,
                    content=current.strip(), start_line=start_line,
                    end_line=start_line + current.count("\n"),
                    chunk_type="paragraph",
                ))
                start_line += current.count("\n") + 2
                current = para
            else:
                current += "\n\n" + para if current else para

        if current.strip():
            chunks.append(CodeChunk(
                file_path=file_info.path, language=file_info.language,
                content=current.strip(), start_line=start_line,
                end_line=start_line + current.count("\n"),
                chunk_type="paragraph",
            ))
        return chunks

    def _chunk_by_lines(self, file_info: FileInfo) -> list[CodeChunk]:
        """按固定行数分块（通用）"""
        lines = file_info.content.split("\n")
        chunk_lines = self.max_chunk_size // 80  # 假设平均每行 80 字符
        chunks = []

        for i in range(0, len(lines), chunk_lines - self.overlap // 80):
            chunk = lines[i:i + chunk_lines]
            content = "\n".join(chunk)
            if content.strip():
                chunks.append(CodeChunk(
                    file_path=file_info.path, language=file_info.language,
                    content=content, start_line=i + 1,
                    end_line=min(i + chunk_lines, len(lines)),
                    chunk_type="module",
                ))
        return chunks
```

### 2.4 向量嵌入与存储

```python
"""embedder.py — 代码向量嵌入"""
from dataclasses import dataclass
from typing import Protocol


class EmbeddingModel(Protocol):
    """嵌入模型协议"""
    async def embed(self, texts: list[str]) -> list[list[float]]: ...


@dataclass
class EmbeddedChunk:
    """带向量的代码块"""
    chunk: CodeChunk
    embedding: list[float]
    chunk_id: str


class CodeEmbedder:
    """代码嵌入器"""

    def __init__(self, model: EmbeddingModel, batch_size: int = 100):
        self.model = model
        self.batch_size = batch_size

    async def embed_chunks(self, chunks: list[CodeChunk]) -> list[EmbeddedChunk]:
        """批量嵌入代码块"""
        results = []
        for i in range(0, len(chunks), self.batch_size):
            batch = chunks[i:i + self.batch_size]
            # 构建嵌入文本：文件路径 + 语言 + 内容
            texts = [
                f"File: {c.file_path}\nLanguage: {c.language}\n\n{c.content}"
                for c in batch
            ]
            embeddings = await self.model.embed(texts)
            for chunk, emb in zip(batch, embeddings):
                results.append(EmbeddedChunk(
                    chunk=chunk,
                    embedding=emb,
                    chunk_id=f"{chunk.file_path}:{chunk.start_line}-{chunk.end_line}",
                ))
        return results
```

### 2.5 RAG 查询管道

```python
"""rag_pipeline.py — RAG 查询管道"""
import logging
from typing import Any

logger = logging.getLogger(__name__)


class RAGPipeline:
    """Git 仓库 RAG 查询管道"""

    def __init__(self, vector_store, embedding_model: EmbeddingModel,
                 llm, top_k: int = 5):
        self.vector_store = vector_store
        self.embedding_model = embedding_model
        self.llm = llm
        self.top_k = top_k

    async def query(self, question: str) -> dict:
        """RAG 查询：检索 → 构建上下文 → LLM 回答"""
        # 1. 嵌入查询
        query_embedding = (await self.embedding_model.embed([question]))[0]

        # 2. 向量检索
        results = self.vector_store.search(query_embedding, top_k=self.top_k)

        # 3. 构建上下文
        context_parts = []
        sources = []
        for result in results:
            chunk = result["chunk"]
            context_parts.append(
                f"### {chunk.file_path} (lines {chunk.start_line}-{chunk.end_line})\n"
                f"```{chunk.language}\n{chunk.content}\n```"
            )
            sources.append({
                "file": chunk.file_path,
                "lines": f"{chunk.start_line}-{chunk.end_line}",
                "score": result.get("score", 0.0),
            })
        context = "\n\n".join(context_parts)

        # 4. LLM 回答
        prompt = f"""基于以下代码片段回答问题。如果代码片段不足以回答，请说明。

代码上下文:
{context}

问题: {question}

回答:"""

        response = await self.llm.ainvoke(prompt)

        return {
            "answer": response.content,
            "sources": sources,
            "chunks_used": len(results),
        }
```

### 2.6 关键设计决策

| 决策 | DeepWiki 的选择 | 理由 |
|------|-----------------|------|
| 分块策略 | 按语法结构 | 保持代码语义完整性 |
| 嵌入文本 | 路径 + 语言 + 内容 | 元数据增强检索精度 |
| 向量存储 | ChromaDB | 轻量、易部署、支持元数据过滤 |
| 检索数量 | top_k=5 | 平衡上下文长度和覆盖率 |
| 文件过滤 | 忽略二进制/锁文件 | 减少噪音 |

---

## 第 3 章 可复用方案设计

### 3.1 完整流水线

```python
"""repo_rag.py — 完整的 Git 仓库 RAG 流水线"""
import asyncio


class RepoRAG:
    """Git 仓库 RAG 系统 — 一键索引 + 查询"""

    def __init__(self, embedding_model, llm, vector_store_factory,
                 chunk_size: int = 1500, top_k: int = 5):
        self.scanner = FileScanner("")
        self.chunker = CodeChunker(max_chunk_size=chunk_size)
        self.embedder = CodeEmbedder(embedding_model)
        self.llm = llm
        self.vector_store_factory = vector_store_factory
        self.top_k = top_k
        self.pipeline: RAGPipeline | None = None

    async def index_repo(self, repo_path: str) -> dict:
        """索引整个仓库"""
        self.scanner = FileScanner(repo_path)

        # 1. 扫描文件
        files = self.scanner.scan()

        # 2. 分块
        all_chunks = []
        for f in files:
            chunks = self.chunker.chunk_file(f)
            all_chunks.extend(chunks)

        # 3. 嵌入
        embedded = await self.embedder.embed_chunks(all_chunks)

        # 4. 存储
        store = self.vector_store_factory()
        for ec in embedded:
            store.add(ec.chunk_id, ec.embedding, {
                "file_path": ec.chunk.file_path,
                "language": ec.chunk.language,
                "start_line": ec.chunk.start_line,
                "end_line": ec.chunk.end_line,
                "chunk_type": ec.chunk.chunk_type,
                "content": ec.chunk.content,
            })

        self.pipeline = RAGPipeline(
            store, self.embedder.model, self.llm, self.top_k
        )

        return {
            "files_scanned": len(files),
            "chunks_created": len(all_chunks),
            "chunks_embedded": len(embedded),
        }

    async def query(self, question: str) -> dict:
        """查询已索引的仓库"""
        if not self.pipeline:
            raise RuntimeError("请先调用 index_repo() 索引仓库")
        return await self.pipeline.query(question)
```

### 3.2 配置参数

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `max_chunk_size` | 1500 | 最大块大小（字符） |
| `overlap` | 200 | 块间重叠（字符） |
| `top_k` | 5 | 检索返回的最相关块数 |
| `batch_size` | 100 | 嵌入批处理大小 |
| `max_file_size` | 500KB | 最大可索引文件大小 |

---

## 第 4 章 测试用例

```python
"""test_repo_rag.py — Git 仓库 RAG 测试"""
import pytest
from unittest.mock import AsyncMock, MagicMock
from dataclasses import dataclass


# === 文件扫描测试 ===

class TestFileScanner:

    def test_scan_filters_binary(self, tmp_path):
        """二进制文件应被过滤"""
        (tmp_path / "code.py").write_text("print('hello')")
        (tmp_path / "image.png").write_bytes(b"\x89PNG")
        scanner = FileScanner(str(tmp_path))
        files = scanner.scan()
        assert len(files) == 1
        assert files[0].path == "code.py"

    def test_scan_filters_node_modules(self, tmp_path):
        """node_modules 目录应被跳过"""
        (tmp_path / "src").mkdir()
        (tmp_path / "src" / "app.js").write_text("const x = 1;")
        (tmp_path / "node_modules").mkdir()
        (tmp_path / "node_modules" / "lib.js").write_text("module.exports = {};")
        scanner = FileScanner(str(tmp_path))
        files = scanner.scan()
        assert all("node_modules" not in f.path for f in files)

    def test_scan_filters_large_files(self, tmp_path):
        """超大文件应被过滤"""
        (tmp_path / "small.py").write_text("x = 1")
        (tmp_path / "large.py").write_text("x" * 600_000)
        scanner = FileScanner(str(tmp_path))
        files = scanner.scan()
        assert len(files) == 1
        assert files[0].path == "small.py"

    def test_detect_language(self):
        assert FileScanner._detect_language(".py") == "python"
        assert FileScanner._detect_language(".ts") == "typescript"
        assert FileScanner._detect_language(".xyz") == "text"


# === 分块测试 ===

class TestCodeChunker:

    def test_python_function_chunking(self):
        """Python 文件应按函数分块"""
        content = '''def foo():
    return 1

def bar():
    return 2

class Baz:
    def method(self):
        pass
'''
        file_info = FileInfo(path="test.py", language="python",
                            size=len(content), content=content)
        chunker = CodeChunker(max_chunk_size=5000)
        chunks = chunker.chunk_file(file_info)
        assert len(chunks) >= 2  # 至少 foo 和 bar/Baz

    def test_markdown_paragraph_chunking(self):
        """Markdown 应按段落分块"""
        content = "# Title\n\nParagraph 1\n\nParagraph 2\n\nParagraph 3"
        file_info = FileInfo(path="README.md", language="markdown",
                            size=len(content), content=content)
        chunker = CodeChunker(max_chunk_size=50)
        chunks = chunker.chunk_file(file_info)
        assert len(chunks) >= 1

    def test_chunk_preserves_file_path(self):
        """分块应保留文件路径"""
        file_info = FileInfo(path="src/main.py", language="python",
                            size=10, content="x = 1")
        chunker = CodeChunker()
        chunks = chunker.chunk_file(file_info)
        assert all(c.file_path == "src/main.py" for c in chunks)

    def test_empty_file_returns_single_chunk(self):
        """空文件应返回空列表或单块"""
        file_info = FileInfo(path="empty.py", language="python",
                            size=0, content="")
        chunker = CodeChunker()
        chunks = chunker.chunk_file(file_info)
        # 空内容可能返回 0 或 1 个块
        assert len(chunks) <= 1

    def test_max_chunk_size_respected(self):
        """块大小不应超过最大限制（大幅超出）"""
        content = "x = 1\n" * 1000
        file_info = FileInfo(path="big.py", language="python",
                            size=len(content), content=content)
        chunker = CodeChunker(max_chunk_size=500)
        chunks = chunker.chunk_file(file_info)
        assert len(chunks) > 1


# === 嵌入测试 ===

class TestCodeEmbedder:

    @pytest.mark.asyncio
    async def test_embed_chunks(self):
        """应为每个块生成嵌入向量"""
        model = AsyncMock()
        model.embed.return_value = [[0.1, 0.2], [0.3, 0.4]]
        embedder = CodeEmbedder(model, batch_size=10)

        chunks = [
            CodeChunk(file_path="a.py", language="python",
                     content="def foo(): pass", start_line=1,
                     end_line=1, chunk_type="function"),
            CodeChunk(file_path="b.py", language="python",
                     content="def bar(): pass", start_line=1,
                     end_line=1, chunk_type="function"),
        ]
        results = await embedder.embed_chunks(chunks)
        assert len(results) == 2
        assert results[0].embedding == [0.1, 0.2]

    @pytest.mark.asyncio
    async def test_embed_includes_metadata(self):
        """嵌入文本应包含文件路径和语言"""
        model = AsyncMock()
        model.embed.return_value = [[0.1]]
        embedder = CodeEmbedder(model)

        chunks = [CodeChunk(
            file_path="src/utils.py", language="python",
            content="def helper(): pass", start_line=1,
            end_line=1, chunk_type="function",
        )]
        await embedder.embed_chunks(chunks)

        call_args = model.embed.call_args[0][0]
        assert "src/utils.py" in call_args[0]
        assert "python" in call_args[0].lower()


# === RAG 管道测试 ===

class TestRAGPipeline:

    @pytest.mark.asyncio
    async def test_query_returns_answer(self):
        """查询应返回 LLM 生成的回答"""
        # Mock 向量存储
        store = MagicMock()
        store.search.return_value = [{
            "chunk": CodeChunk(
                file_path="main.py", language="python",
                content="def main(): print('hello')",
                start_line=1, end_line=1, chunk_type="function",
            ),
            "score": 0.95,
        }]

        # Mock 嵌入模型
        embed_model = AsyncMock()
        embed_model.embed.return_value = [[0.1, 0.2]]

        # Mock LLM
        llm = AsyncMock()
        llm.ainvoke.return_value = MagicMock(content="main.py 是入口文件")

        pipeline = RAGPipeline(store, embed_model, llm, top_k=3)
        result = await pipeline.query("入口文件在哪？")

        assert result["answer"] == "main.py 是入口文件"
        assert len(result["sources"]) == 1
        assert result["sources"][0]["file"] == "main.py"

    @pytest.mark.asyncio
    async def test_empty_results(self):
        """无检索结果时 LLM 仍应回答"""
        store = MagicMock()
        store.search.return_value = []
        embed_model = AsyncMock()
        embed_model.embed.return_value = [[0.1]]
        llm = AsyncMock()
        llm.ainvoke.return_value = MagicMock(content="未找到相关代码")

        pipeline = RAGPipeline(store, embed_model, llm)
        result = await pipeline.query("不存在的功能")
        assert result["chunks_used"] == 0
```

---

## 第 5 章 跨域关联

| 关联域 | 关系 | 说明 |
|--------|------|------|
| PD-01 上下文管理 | 核心 | 检索结果需要裁剪后放入 LLM 上下文窗口 |
| PD-08.01 多源搜索 | 互补 | RAG 检索私有代码，多源搜索检索公开信息 |
| PD-08.02 树状搜索 | 互补 | 树状搜索发现方向，RAG 检索具体代码 |
| PD-11 可观测性 | 监控 | 索引大小、检索延迟、命中率需要追踪 |

---

## 第 6 章 来源文件索引

| 编号 | 文件 | 说明 |
|------|------|------|
| S1 | `api/data_pipeline/file_scanner.py` | 文件扫描与过滤 |
| S2 | `api/rag/chunker.py` | 代码感知分块 |
| S3 | `api/rag/embedder.py` | 向量嵌入 |
| S4 | `api/rag/vector_store.py` | 向量存储（ChromaDB） |
| S5 | `api/rag/pipeline.py` | RAG 查询管道 |
