"""
Comparator — 跨项目对比器
对同一问题域下的多个解决方案进行横向对比分析
"""
from dataclasses import dataclass, field


@dataclass
class ComparisonDimension:
    """对比维度"""
    name: str                    # "估算方式"
    solutions: dict[str, str]    # {"mirothinker": "tiktoken 精确估算", "deerflow": "配置阈值"}


@dataclass
class Inspiration:
    """对其他问题域的启发"""
    target_domain: str           # "PD-03"
    insight: str                 # "上下文超限本质上是一种可预防的失败"


@dataclass
class DomainComparison:
    """问题域横向对比"""
    domain_id: str
    dimensions: list[ComparisonDimension] = field(default_factory=list)
    best_practices: list[str] = field(default_factory=list)
    inspirations: list[Inspiration] = field(default_factory=list)
    scenario_matrix: list[dict] = field(default_factory=list)  # 适用场景矩阵


class Comparator:
    """跨项目对比器"""

    async def compare(self, domain_id: str, solutions: list[dict]) -> DomainComparison:
        """对同一问题域下的解决方案进行横向对比"""
        if len(solutions) < 2:
            return DomainComparison(domain_id=domain_id)

        # TODO: 调用 LLM 生成对比分析
        # 输入：多个 Solution 的 mechanism + code_snippets
        # 输出：维度对比表 + 最佳实践 + 启发

        comparison = DomainComparison(domain_id=domain_id)
        return comparison

    def _build_comparison_prompt(self, domain_id: str, solutions: list[dict]) -> str:
        """构建对比分析的 LLM prompt"""
        prompt = f"""你是一个 Agent 工程专家。以下是问题域 {domain_id} 下来自不同开源项目的解决方案。

请从以下维度进行横向对比：
1. 设计思想差异
2. 实现机制对比（表格形式）
3. 各自的优劣势
4. 适用场景矩阵
5. 最佳实践建议
6. 对其他问题域的启发

解决方案列表：
"""
        for s in solutions:
            prompt += f"\n### {s['project']}: {s['title']}\n{s['mechanism']}\n"

        return prompt
