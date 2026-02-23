"""
Knowledge Store — 知识库读取层
从 knowledge/ 目录读取 YAML/Markdown 文件，提供结构化查询
"""
import os
import yaml
import frontmatter
from pathlib import Path
from typing import Optional

KNOWLEDGE_DIR = Path(__file__).parent.parent / "knowledge"


class KnowledgeStore:
    def __init__(self):
        self.registry = self._load_registry()

    def _load_registry(self) -> dict:
        registry_path = KNOWLEDGE_DIR / "registry.yaml"
        if registry_path.exists():
            with open(registry_path, "r", encoding="utf-8") as f:
                # registry.yaml 第一行是注释，跳过
                content = f.read()
                # 去掉第一行的 markdown 标题
                if content.startswith("#"):
                    content = "\n".join(content.split("\n")[1:])
                return yaml.safe_load(content)
        return {"domains": [], "projects": []}

    def list_domains(self) -> list[dict]:
        """列出所有问题域（卡片概览用）"""
        domains = self.registry.get("domains", [])
        # 统计每个域下的解决方案数
        for d in domains:
            slug = d["slug"]
            solutions_dir = KNOWLEDGE_DIR / "solutions"
            domain_id = d["id"]
            count = len(list(solutions_dir.glob(f"{domain_id}-*.md")))
            d["solution_count"] = count
        return domains
