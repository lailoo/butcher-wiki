"""
Scanner — 仓库扫描器
克隆仓库 → 代码扫描 → LLM 特性提取 → 匹配问题域 → 生成 Solution
"""
import asyncio
import subprocess
from pathlib import Path
from fastapi import WebSocket


REPOS_DIR = Path.home() / ".butcher-wiki" / "repos"


class RepoScanner:
    """扫描 Git 仓库，提取 Agent 工程组件"""

    def __init__(self, websocket: WebSocket):
        self.ws = websocket

    async def scan(self, repo_url: str):
        """完整扫描流程"""
        await self._emit("status", "开始扫描...")

        # Step 1: Clone
        repo_name = repo_url.rstrip("/").split("/")[-1]
        repo_path = REPOS_DIR / repo_name
        await self._emit("phase", "clone", detail=f"克隆 {repo_url}")
        await self._clone(repo_url, repo_path)

        # Step 2: 文件扫描
        await self._emit("phase", "scan", detail="扫描代码文件")
        files = self._scan_files(repo_path)
        await self._emit("progress", f"发现 {len(files)} 个代码文件")

        # Step 3: LLM 特性提取
        await self._emit("phase", "extract", detail="LLM 提取工程组件")
        components = await self._extract_components(files)

        # Step 4: 匹配问题域
        await self._emit("phase", "match", detail="匹配问题域")
        matched = self._match_domains(components)

        # Step 5: 生成 Solution 文件
        await self._emit("phase", "generate", detail="生成解决方案文档")
        await self._generate_solutions(repo_name, matched)

        await self._emit("status", "扫描完成", detail=f"提取了 {len(matched)} 个工程组件")

    async def _clone(self, url: str, path: Path):
        if path.exists():
            return
        REPOS_DIR.mkdir(parents=True, exist_ok=True)
        proc = await asyncio.create_subprocess_exec(
            "git", "clone", "--depth=1", url, str(path),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        await proc.wait()

    def _scan_files(self, repo_path: Path) -> list[Path]:
        """扫描代码文件，排除无关文件"""
        exclude_dirs = {".git", "node_modules", "venv", "__pycache__", ".next", "dist", "build"}
        exclude_exts = {".lock", ".png", ".jpg", ".svg", ".ico", ".woff", ".ttf"}
        files = []
        for f in repo_path.rglob("*"):
            if f.is_file() and not any(d in f.parts for d in exclude_dirs):
                if f.suffix not in exclude_exts:
                    files.append(f)
        return files

    async def _extract_components(self, files: list[Path]) -> list[dict]:
        """用 LLM 从代码中提取工程组件（占位，待实现）"""
        # TODO: 调用 LLM 分析代码，提取工程组件
        return []

    def _match_domains(self, components: list[dict]) -> list[dict]:
        """将提取的组件匹配到问题域（占位，待实现）"""
        # TODO: 基于关键词和语义匹配到 PD-01 ~ PD-12
        return components

    async def _generate_solutions(self, project: str, components: list[dict]):
        """生成 Solution markdown 文件（占位，待实现）"""
        # TODO: 为每个匹配的组件生成标准格式的 Solution 文档
        pass

    async def _emit(self, event: str, message: str = "", **kwargs):
        await self.ws.send_json({"event": event, "message": message, **kwargs})
