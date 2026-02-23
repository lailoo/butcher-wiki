"""
Extractor — 特性提取器
从代码文件中提取 Agent 工程组件的设计模式和实现细节
这是 Horizon Wiki 的核心 — "项目切割机"
"""
from dataclasses import dataclass, field


@dataclass
class EngineeringComponent:
    """一个可移植的工程组件"""
    name: str                          # "tiktoken 精确估算"
    domain_id: str                     # "PD-01"
    project: str                       # "mirothinker"
    source_files: list[dict] = field(default_factory=list)  # [{file, lines, description}]
    design_philosophy: list[str] = field(default_factory=list)
    mechanism: str = ""                # 机制描述 (Markdown)
    code_snippets: list[dict] = field(default_factory=list)
    pros: list[str] = field(default_factory=list)
    cons: list[str] = field(default_factory=list)
    applicable_scenarios: list[str] = field(default_factory=list)
    related_domains: list[str] = field(default_factory=list)  # 对其他问题域的启发


# 问题域关键词映射 — 用于初步匹配
DOMAIN_KEYWORDS = {
    "PD-01": ["token", "context", "truncat", "compress", "tiktoken", "max_tokens", "sliding_window", "summariz"],
    "PD-02": ["orchestrat", "multi.agent", "parallel", "subagent", "dag", "dispatch", "coordinator"],
    "PD-03": ["retry", "fallback", "rollback", "resilient", "fault", "recover", "backoff", "degrad"],
    "PD-04": ["tool.manager", "mcp", "tool.call", "register.*tool", "hot.reload", "permission"],
    "PD-05": ["sandbox", "isolat", "docker", "e2b", "subprocess", "container"],
    "PD-06": ["memory", "persist", "vector.store", "embedding.*store", "cross.session", "long.term"],
    "PD-07": ["review", "quality", "fact.check", "critic", "evaluat", "scoring", "consistency"],
    "PD-08": ["search", "retriev", "rag", "knowledge.gap", "multi.source", "crawl", "scrape"],
    "PD-09": ["human.in", "clarif", "approval", "interrupt", "ask.*user", "confirm"],
    "PD-10": ["middleware", "pipeline", "hook", "lifecycle", "intercept", "plugin"],
    "PD-11": ["observ", "trac", "monitor", "cost", "token.usage", "log.*struct", "langfuse"],
    "PD-12": ["think", "reason", "extended.think", "chain.of.thought", "moe", "tiered.*llm"],
}


class ComponentExtractor:
    """从代码中提取工程组件"""

    def extract_from_file(self, filepath: str, content: str) -> list[EngineeringComponent]:
        """分析单个文件，提取可能的工程组件"""
        components = []
        matched_domains = self._match_domains(content)

        for domain_id in matched_domains:
            comp = EngineeringComponent(
                name=f"[待 LLM 命名] from {filepath}",
                domain_id=domain_id,
                project="",
                source_files=[{"file": filepath, "lines": "", "description": ""}],
            )
            components.append(comp)

        return components

    def _match_domains(self, content: str) -> list[str]:
        """基于关键词初步匹配问题域"""
        import re
        content_lower = content.lower()
        matched = []
        for domain_id, keywords in DOMAIN_KEYWORDS.items():
            score = sum(1 for kw in keywords if re.search(kw, content_lower))
            if score >= 2:  # 至少匹配 2 个关键词
                matched.append(domain_id)
        return matched
