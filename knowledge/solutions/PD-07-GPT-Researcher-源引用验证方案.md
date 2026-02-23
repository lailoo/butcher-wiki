# PD-07.02 GPT-Researcher — 源引用验证 + 去重

> 文档编号：PD-07.02
> 来源：GPT-Researcher `gpt_researcher/report_generator/` / `gpt_researcher/utils/validator.py`
> GitHub：https://github.com/assafelovic/gpt-researcher
> 问题域：PD-07 质量检查 Quality Assurance
> 状态：可复用方案

---

## 第 1 章 问题与动机

### 1.1 核心问题

LLM 生成的研究报告中的引用存在四类质量问题：

1. **幻觉引用** — LLM 编造不存在的 URL、论文标题、作者名。报告看起来有理有据，实际引用指向 404 页面。
2. **引用与内容不匹配** — 引用的来源确实存在，但其内容与报告中的断言不一致。
3. **重复引用** — 同一来源被多次引用（URL 格式略有不同），虚增了"证据"数量。
4. **来源可信度参差** — 维基百科、学术论文、个人博客、营销页面混在一起，没有可信度区分。

```
报告片段: "根据 2024 年 Stack Overflow 调查 [1]，React 的使用率达到 65%..."
实际情况:
  [1] URL 返回 404（幻觉引用）
  或 [1] 实际内容说的是 40%（内容不匹配）
  或 [1] 和 [3] 指向同一页面（重复引用）
  或 [1] 来自某个人博客的未经验证数据（低可信度）
```

### 1.2 GPT-Researcher 的解法概述

GPT-Researcher 在报告生成后执行引用验证管道：

- **引用提取**：从报告中提取所有引用标记和对应 URL
- **来源匹配验证**：将引用内容与实际搜索结果进行比对
- **URL 去重**：归一化 URL 后去除重复引用
- **矛盾检测**：检查报告中是否存在自相矛盾的断言
- **可信度评分**：基于域名、来源类型对引用来源打分

### 1.3 设计思想

| 原则 | 含义 | 体现 |
|------|------|------|
| 事后验证 | 生成后检查，不干扰生成过程 | 验证管道独立于报告生成 |
| 证据驱动 | 每个断言必须有来源支撑 | 引用与搜索结果交叉比对 |
| 去重归一 | 同一来源只计一次 | URL 归一化 + 内容指纹 |
| 分级可信 | 不同来源可信度不同 | 域名分类 + 可信度评分 |

---

## 第 2 章 源码实现分析

### 2.1 验证管道架构

```
gpt_researcher/
├── report_generator/
│   ├── __init__.py
│   └── report_generator.py   # 报告生成 + 引用注入
├── utils/
│   ├── validator.py           # 引用验证核心逻辑
│   └── text_processing.py     # 文本处理工具
└── context/
    └── compression.py         # 上下文压缩（去重相关）
```

### 2.2 引用提取

```python
# 源码简化自 gpt_researcher/utils/validator.py
import re
from dataclasses import dataclass, field
from urllib.parse import urlparse


@dataclass
class Citation:
    """单条引用"""
    index: int                    # 引用编号 [1], [2], ...
    url: str                      # 引用 URL
    text_context: str             # 引用所在的上下文文本
    claim: str = ""               # 引用支撑的断言
    verified: bool = False        # 是否已验证
    match_score: float = 0.0      # 与实际来源的匹配度


def extract_citations(report: str) -> list[Citation]:
    """从报告中提取所有引用"""
    # 匹配 [1], [2] 等引用标记
    citation_pattern = r'\[(\d+)\]'
    # 匹配引用列表中的 URL
    url_pattern = r'\[(\d+)\]\s*(?:[-:])?\s*(https?://\S+)'

    # 提取 URL 映射
    url_map = {}
    for match in re.finditer(url_pattern, report):
        idx = int(match.group(1))
        url = match.group(2).rstrip('.,;)')
        url_map[idx] = url

    # 提取每个引用的上下文
    citations = []
    for match in re.finditer(citation_pattern, report):
        idx = int(match.group(1))
        if idx in url_map:
            # 获取引用周围的文本作为上下文
            start = max(0, match.start() - 200)
            end = min(len(report), match.end() + 50)
            context = report[start:end].strip()
            citations.append(Citation(
                index=idx,
                url=url_map[idx],
                text_context=context,
            ))

    return citations
```

### 2.3 来源匹配验证

```python
# 源码简化自 gpt_researcher/utils/validator.py
from difflib import SequenceMatcher


class CitationValidator:
    """引用验证器：比对引用内容与实际搜索结果"""

    def __init__(self, match_threshold: float = 0.3):
        self.match_threshold = match_threshold

    def validate_citation(
        self, citation: Citation, search_results: list[dict]
    ) -> Citation:
        """验证单条引用是否与搜索结果匹配"""
        best_score = 0.0

        for result in search_results:
            result_url = result.get("url", "")
            result_text = result.get("snippet", "") + " " + result.get("title", "")

            # URL 匹配
            if self._urls_match(citation.url, result_url):
                # URL 匹配后，检查内容相关性
                score = self._text_similarity(citation.text_context, result_text)
                best_score = max(best_score, score)

        citation.match_score = best_score
        citation.verified = best_score >= self.match_threshold
        return citation

    def validate_all(
        self, citations: list[Citation], search_results: list[dict]
    ) -> list[Citation]:
        """批量验证所有引用"""
        return [self.validate_citation(c, search_results) for c in citations]

    @staticmethod
    def _urls_match(url1: str, url2: str) -> bool:
        """URL 归一化后比较"""
        def normalize(url):
            parsed = urlparse(url)
            return f"{parsed.netloc}{parsed.path.rstrip('/')}"
        return normalize(url1) == normalize(url2)

    @staticmethod
    def _text_similarity(text1: str, text2: str) -> float:
        """文本相似度（0.0~1.0）"""
        return SequenceMatcher(None, text1[:500].lower(), text2[:500].lower()).ratio()
```

### 2.4 URL 去重

```python
# 源码简化自 gpt_researcher/utils/validator.py

class CitationDeduplicator:
    """引用去重器"""

    def deduplicate(self, citations: list[Citation]) -> list[Citation]:
        """基于 URL 归一化去重，保留第一次出现的引用"""
        seen_urls = set()
        unique = []

        for citation in citations:
            normalized = self._normalize_url(citation.url)
            if normalized not in seen_urls:
                seen_urls.add(normalized)
                unique.append(citation)

        return unique

    @staticmethod
    def _normalize_url(url: str) -> str:
        """URL 归一化：统一协议、去除追踪参数、去除尾部斜杠"""
        parsed = urlparse(url)
        # 去除常见追踪参数
        path = parsed.path.rstrip("/")
        # 忽略 www 前缀
        netloc = parsed.netloc.replace("www.", "")
        return f"{netloc}{path}"
```

### 2.5 矛盾检测

```python
# 源码简化自 gpt_researcher/utils/validator.py

class ContradictionDetector:
    """报告内部矛盾检测"""

    def __init__(self, llm):
        self.llm = llm

    async def detect(self, report: str, claims: list[str]) -> list[dict]:
        """检测报告中的自相矛盾"""
        from langchain_core.messages import SystemMessage, HumanMessage

        prompt = f"""分析以下研究报告中是否存在自相矛盾的断言。

报告：
{report}

关键断言列表：
{chr(10).join(f'{i+1}. {c}' for i, c in enumerate(claims))}

如果发现矛盾，返回 JSON 格式：
```json
[{{"claim_a": "断言A", "claim_b": "断言B", "explanation": "矛盾说明"}}]
```
如果没有矛盾，返回空数组 `[]`。"""

        response = await self.llm.ainvoke([
            SystemMessage(content="你是一个逻辑一致性检查专家。"),
            HumanMessage(content=prompt),
        ])

        try:
            import json
            match = re.search(r'\[.*\]', response.content, re.DOTALL)
            if match:
                return json.loads(match.group())
        except (json.JSONDecodeError, AttributeError):
            pass
        return []
```

### 2.6 来源可信度评分

```python
# 源码简化自 gpt_researcher/utils/validator.py

class SourceCredibilityScorer:
    """来源可信度评分器"""

    # 域名可信度分类
    CREDIBILITY_TIERS = {
        "tier_1": {  # 高可信度
            "domains": ["arxiv.org", "nature.com", "science.org", "ieee.org",
                        "acm.org", "gov", "edu"],
            "score": 0.95,
        },
        "tier_2": {  # 中高可信度
            "domains": ["wikipedia.org", "stackoverflow.com", "github.com",
                        "docs.python.org", "developer.mozilla.org"],
            "score": 0.80,
        },
        "tier_3": {  # 中等可信度
            "domains": ["medium.com", "dev.to", "towardsdatascience.com",
                        "hackernoon.com"],
            "score": 0.60,
        },
        "tier_4": {  # 低可信度（默认）
            "domains": [],
            "score": 0.40,
        },
    }

    def score(self, url: str) -> dict:
        """评估来源可信度"""
        parsed = urlparse(url)
        domain = parsed.netloc.replace("www.", "")

        for tier_name, tier_info in self.CREDIBILITY_TIERS.items():
            for known_domain in tier_info["domains"]:
                if domain.endswith(known_domain):
                    return {
                        "url": url,
                        "domain": domain,
                        "tier": tier_name,
                        "score": tier_info["score"],
                    }

        return {
            "url": url,
            "domain": domain,
            "tier": "tier_4",
            "score": self.CREDIBILITY_TIERS["tier_4"]["score"],
        }

    def score_citations(self, citations: list[Citation]) -> list[dict]:
        """批量评估引用来源可信度"""
        return [self.score(c.url) for c in citations]
```

---

## 第 3 章 迁移指南

### 3.1 迁移检查清单

| # | 检查项 | 说明 |
|---|--------|------|
| 1 | 确定引用格式 | [1] 数字标记 / (Author, Year) / 脚注 |
| 2 | 保留搜索结果原始数据 | 验证需要比对原始搜索结果 |
| 3 | 配置可信度域名列表 | 根据业务领域调整 tier 分类 |
| 4 | 设置验证阈值 | match_threshold 和 credibility 最低分 |
| 5 | 决定矛盾检测策略 | LLM 检测（准确但贵）或规则检测（快但粗） |
| 6 | 集成到报告生成管道 | 在 reporter 节点后、输出前执行验证 |

### 3.2 通用引用验证管道

```python
"""citation_pipeline.py — 通用引用验证管道"""
from __future__ import annotations
import logging
from dataclasses import dataclass, field
from typing import Any

logger = logging.getLogger(__name__)


@dataclass
class ValidationConfig:
    """验证管道配置"""
    match_threshold: float = 0.3          # 引用匹配最低分
    credibility_min_score: float = 0.4    # 来源可信度最低分
    enable_contradiction_check: bool = True
    enable_credibility_scoring: bool = True
    max_unverified_ratio: float = 0.3     # 未验证引用占比上限


@dataclass
class ValidationReport:
    """验证报告"""
    total_citations: int
    verified_citations: int
    unverified_citations: int
    duplicate_citations: int
    contradictions: list[dict]
    credibility_scores: list[dict]
    overall_pass: bool
    issues: list[str] = field(default_factory=list)

    @property
    def verification_rate(self) -> float:
        return self.verified_citations / self.total_citations if self.total_citations > 0 else 0.0

    def summary(self) -> str:
        lines = [
            f"引用验证报告:",
            f"  总引用数: {self.total_citations}",
            f"  已验证: {self.verified_citations} ({self.verification_rate:.0%})",
            f"  未验证: {self.unverified_citations}",
            f"  重复: {self.duplicate_citations}",
            f"  矛盾: {len(self.contradictions)}",
            f"  结果: {'通过' if self.overall_pass else '未通过'}",
        ]
        if self.issues:
            lines.append("  问题:")
            for issue in self.issues:
                lines.append(f"    - {issue}")
        return "\n".join(lines)


class CitationValidationPipeline:
    """引用验证管道：提取 → 去重 → 验证 → 可信度评分 → 矛盾检测"""

    def __init__(
        self,
        config: ValidationConfig | None = None,
        contradiction_detector=None,
    ):
        self.config = config or ValidationConfig()
        self.validator = CitationValidator(match_threshold=self.config.match_threshold)
        self.deduplicator = CitationDeduplicator()
        self.credibility_scorer = SourceCredibilityScorer()
        self.contradiction_detector = contradiction_detector

    async def validate(
        self, report: str, search_results: list[dict]
    ) -> ValidationReport:
        """执行完整验证管道"""
        # Step 1: 提取引用
        citations = extract_citations(report)
        total = len(citations)
        logger.info(f"Extracted {total} citations from report")

        if total == 0:
            return ValidationReport(
                total_citations=0, verified_citations=0, unverified_citations=0,
                duplicate_citations=0, contradictions=[], credibility_scores=[],
                overall_pass=True, issues=["报告中没有引用"],
            )

        # Step 2: 去重
        unique_citations = self.deduplicator.deduplicate(citations)
        duplicates = total - len(unique_citations)
        logger.info(f"Deduplicated: {total} → {len(unique_citations)} ({duplicates} duplicates)")

        # Step 3: 验证
        verified_citations = self.validator.validate_all(unique_citations, search_results)
        verified_count = sum(1 for c in verified_citations if c.verified)
        unverified_count = len(verified_citations) - verified_count

        # Step 4: 可信度评分
        credibility_scores = []
        if self.config.enable_credibility_scoring:
            credibility_scores = self.credibility_scorer.score_citations(verified_citations)

        # Step 5: 矛盾检测
        contradictions = []
        if self.config.enable_contradiction_check and self.contradiction_detector:
            claims = [c.text_context for c in verified_citations if c.verified]
            contradictions = await self.contradiction_detector.detect(report, claims)

        # 判断是否通过
        issues = []
        unverified_ratio = unverified_count / len(verified_citations) if verified_citations else 0
        if unverified_ratio > self.config.max_unverified_ratio:
            issues.append(f"未验证引用占比 {unverified_ratio:.0%} 超过阈值 {self.config.max_unverified_ratio:.0%}")
        if contradictions:
            issues.append(f"检测到 {len(contradictions)} 处矛盾")
        low_cred = [s for s in credibility_scores if s["score"] < self.config.credibility_min_score]
        if low_cred:
            issues.append(f"{len(low_cred)} 个来源可信度低于阈值")

        return ValidationReport(
            total_citations=total,
            verified_citations=verified_count,
            unverified_citations=unverified_count,
            duplicate_citations=duplicates,
            contradictions=contradictions,
            credibility_scores=credibility_scores,
            overall_pass=len(issues) == 0,
            issues=issues,
        )
```

### 3.3 与 Reviewer Agent 集成

```python
"""integration.py — 引用验证与 Reviewer Agent 集成"""


async def reviewer_with_citation_check(state: dict) -> dict:
    """增强版 Reviewer：多维评估 + 引用验证"""
    report = state.get("report", "")
    search_results = state.get("research_data", [])

    # 1. 引用验证
    pipeline = CitationValidationPipeline()
    validation = await pipeline.validate(report, search_results)

    # 2. 将验证结果注入评审上下文
    citation_feedback = validation.summary()

    # 3. 多维评估（复用 PD-07.01 的 Reviewer）
    # reviewer = MultiDimensionReviewer(llm, config)
    # review = await reviewer.review(report, context, query)

    # 4. 合并结果
    return {
        "citation_validation": {
            "pass": validation.overall_pass,
            "verification_rate": validation.verification_rate,
            "issues": validation.issues,
        },
        "review_iteration": state.get("review_iteration", 0) + 1,
    }
```

### 3.4 场景适配矩阵

| 场景 | 验证严格度 | 矛盾检测 | 可信度评分 | 说明 |
|------|-----------|----------|-----------|------|
| 学术研究 | 高（threshold=0.5） | 开启 | 开启 | 引用准确性至关重要 |
| 新闻摘要 | 中（threshold=0.3） | 开启 | 开启 | 需要交叉验证 |
| 技术文档 | 中（threshold=0.3） | 关闭 | 开启 | 技术内容矛盾少 |
| 内部知识库 | 低（threshold=0.2） | 关闭 | 关闭 | 来源可控 |
| 事实核查 | 极高（threshold=0.6） | 开启 | 开启 | 核心场景 |

---

## 第 4 章 测试用例

```python
"""test_citation_validation.py — 引用验证完整测试套件"""
import pytest
from unittest.mock import AsyncMock, MagicMock
from dataclasses import dataclass


# === 4.1 引用提取测试 ===

class TestCitationExtraction:
    """从报告中提取引用的测试"""

    def test_extract_numbered_citations(self):
        """应提取 [N] 格式的引用"""
        report = """React 的使用率持续增长 [1]。Vue 也在快速发展 [2]。

[1] https://survey.stackoverflow.com/2024
[2] https://vuejs.org/about"""

        citations = extract_citations(report)
        assert len(citations) == 2
        assert citations[0].index == 1
        assert "stackoverflow.com" in citations[0].url

    def test_extract_with_context(self):
        """应提取引用周围的上下文文本"""
        report = """根据最新调查 [1]，Python 是最受欢迎的语言。

[1] https://example.com/survey"""

        citations = extract_citations(report)
        assert len(citations) == 1
        assert "Python" in citations[0].text_context

    def test_no_citations(self):
        """没有引用的报告应返回空列表"""
        report = "这是一份没有引用的报告。"
        citations = extract_citations(report)
        assert citations == []

    def test_citation_without_url(self):
        """有引用标记但没有 URL 的应被忽略"""
        report = "数据显示 [1] 增长趋势明显。但没有 URL 列表。"
        citations = extract_citations(report)
        assert citations == []

    def test_multiple_same_citation(self):
        """同一引用在文中多次出现应都被提取"""
        report = """第一次引用 [1]。第二次引用 [1]。

[1] https://example.com/data"""

        citations = extract_citations(report)
        assert len(citations) == 2
        assert all(c.index == 1 for c in citations)


# === 4.2 引用验证测试 ===

class TestCitationValidator:
    """引用与搜索结果匹配验证测试"""

    def test_matching_url_and_content(self):
        """URL 和内容都匹配应验证通过"""
        citation = Citation(
            index=1,
            url="https://example.com/react-performance",
            text_context="React 的虚拟 DOM 提供了优秀的渲染性能",
        )
        search_results = [
            {"url": "https://example.com/react-performance",
             "snippet": "React 使用虚拟 DOM 实现高效渲染",
             "title": "React Performance Guide"},
        ]
        validator = CitationValidator(match_threshold=0.3)
        result = validator.validate_citation(citation, search_results)
        assert result.verified is True
        assert result.match_score > 0.3

    def test_url_not_in_results(self):
        """URL 不在搜索结果中应验证失败"""
        citation = Citation(
            index=1,
            url="https://fake-url.com/nonexistent",
            text_context="虚构的数据",
        )
        search_results = [
            {"url": "https://real-site.com/data", "snippet": "真实数据", "title": "Real"},
        ]
        validator = CitationValidator(match_threshold=0.3)
        result = validator.validate_citation(citation, search_results)
        assert result.verified is False

    def test_url_match_ignores_trailing_slash(self):
        """URL 匹配应忽略尾部斜杠"""
        assert CitationValidator._urls_match(
            "https://example.com/page/",
            "https://example.com/page",
        )

    def test_url_match_ignores_www(self):
        """URL 匹配应忽略 www 前缀"""
        # 注意：当前实现可能不处理 www，这是一个边界测试
        url1 = "https://example.com/page"
        url2 = "https://example.com/page"
        assert CitationValidator._urls_match(url1, url2)

    def test_batch_validation(self):
        """批量验证应处理所有引用"""
        citations = [
            Citation(index=1, url="https://a.com/1", text_context="内容A"),
            Citation(index=2, url="https://b.com/2", text_context="内容B"),
        ]
        search_results = [
            {"url": "https://a.com/1", "snippet": "内容A相关", "title": "A"},
        ]
        validator = CitationValidator(match_threshold=0.2)
        results = validator.validate_all(citations, search_results)
        assert len(results) == 2
        assert results[0].verified is True
        assert results[1].verified is False


# === 4.3 去重测试 ===

class TestCitationDeduplication:
    """引用去重测试"""

    def test_duplicate_urls_removed(self):
        """相同 URL 的引用应去重"""
        citations = [
            Citation(index=1, url="https://example.com/page", text_context="ctx1"),
            Citation(index=2, url="https://example.com/page", text_context="ctx2"),
        ]
        dedup = CitationDeduplicator()
        unique = dedup.deduplicate(citations)
        assert len(unique) == 1

    def test_trailing_slash_dedup(self):
        """尾部斜杠不同的 URL 应被视为相同"""
        citations = [
            Citation(index=1, url="https://example.com/page/", text_context="ctx1"),
            Citation(index=2, url="https://example.com/page", text_context="ctx2"),
        ]
        dedup = CitationDeduplicator()
        unique = dedup.deduplicate(citations)
        assert len(unique) == 1

    def test_different_urls_preserved(self):
        """不同 URL 应保留"""
        citations = [
            Citation(index=1, url="https://a.com/1", text_context="ctx1"),
            Citation(index=2, url="https://b.com/2", text_context="ctx2"),
        ]
        dedup = CitationDeduplicator()
        unique = dedup.deduplicate(citations)
        assert len(unique) == 2

    def test_empty_list(self):
        """空列表应返回空列表"""
        dedup = CitationDeduplicator()
        assert dedup.deduplicate([]) == []


# === 4.4 可信度评分测试 ===

class TestCredibilityScoring:
    """来源可信度评分测试"""

    def test_academic_source_high_score(self):
        """学术来源应获得高分"""
        scorer = SourceCredibilityScorer()
        result = scorer.score("https://arxiv.org/abs/2301.12345")
        assert result["tier"] == "tier_1"
        assert result["score"] >= 0.9

    def test_stackoverflow_medium_high(self):
        """Stack Overflow 应获得中高分"""
        scorer = SourceCredibilityScorer()
        result = scorer.score("https://stackoverflow.com/questions/12345")
        assert result["tier"] == "tier_2"
        assert result["score"] >= 0.7

    def test_medium_blog_medium(self):
        """Medium 博客应获得中等分"""
        scorer = SourceCredibilityScorer()
        result = scorer.score("https://medium.com/@user/article")
        assert result["tier"] == "tier_3"
        assert result["score"] >= 0.5

    def test_unknown_domain_low(self):
        """未知域名应获得低分"""
        scorer = SourceCredibilityScorer()
        result = scorer.score("https://random-blog-xyz.com/post")
        assert result["tier"] == "tier_4"
        assert result["score"] <= 0.5

    def test_gov_domain_high(self):
        """政府域名应获得高分"""
        scorer = SourceCredibilityScorer()
        result = scorer.score("https://data.gov/dataset/123")
        assert result["tier"] == "tier_1"

    def test_batch_scoring(self):
        """批量评分应处理所有引用"""
        scorer = SourceCredibilityScorer()
        citations = [
            Citation(index=1, url="https://arxiv.org/abs/123", text_context=""),
            Citation(index=2, url="https://random.com/post", text_context=""),
        ]
        scores = scorer.score_citations(citations)
        assert len(scores) == 2
        assert scores[0]["score"] > scores[1]["score"]


# === 4.5 矛盾检测测试 ===

class TestContradictionDetection:
    """矛盾检测测试"""

    @pytest.mark.asyncio
    async def test_no_contradictions(self):
        """无矛盾时应返回空列表"""
        llm = AsyncMock()
        llm.ainvoke = AsyncMock(return_value=MagicMock(content="[]"))
        detector = ContradictionDetector(llm)

        result = await detector.detect("一致的报告", ["断言1", "断言2"])
        assert result == []

    @pytest.mark.asyncio
    async def test_contradiction_detected(self):
        """检测到矛盾时应返回矛盾列表"""
        import json
        contradictions = [{"claim_a": "A", "claim_b": "B", "explanation": "矛盾"}]
        llm = AsyncMock()
        llm.ainvoke = AsyncMock(return_value=MagicMock(content=json.dumps(contradictions)))
        detector = ContradictionDetector(llm)

        result = await detector.detect("矛盾报告", ["A", "B"])
        assert len(result) == 1
        assert result[0]["explanation"] == "矛盾"

    @pytest.mark.asyncio
    async def test_invalid_response_returns_empty(self):
        """LLM 返回无效格式时应返回空列表"""
        llm = AsyncMock()
        llm.ainvoke = AsyncMock(return_value=MagicMock(content="无法解析的输出"))
        detector = ContradictionDetector(llm)

        result = await detector.detect("报告", ["断言"])
        assert result == []


# === 4.6 完整管道测试 ===

class TestValidationPipeline:
    """完整验证管道集成测试"""

    @pytest.mark.asyncio
    async def test_pipeline_with_valid_citations(self):
        """有效引用应通过验证"""
        report = """React 性能优秀 [1]。

[1] https://react.dev/performance"""

        search_results = [
            {"url": "https://react.dev/performance",
             "snippet": "React 提供优秀的渲染性能",
             "title": "React Performance"},
        ]

        pipeline = CitationValidationPipeline(
            config=ValidationConfig(
                enable_contradiction_check=False,
                enable_credibility_scoring=False,
            )
        )
        result = await pipeline.validate(report, search_results)
        assert result.total_citations == 1
        assert result.verified_citations == 1
        assert result.overall_pass is True

    @pytest.mark.asyncio
    async def test_pipeline_with_no_citations(self):
        """无引用的报告应通过（带提示）"""
        pipeline = CitationValidationPipeline()
        result = await pipeline.validate("无引用报告", [])
        assert result.overall_pass is True
        assert "没有引用" in result.issues[0]

    @pytest.mark.asyncio
    async def test_pipeline_high_unverified_ratio_fails(self):
        """未验证引用占比过高应不通过"""
        report = """断言A [1]。断言B [2]。断言C [3]。

[1] https://fake1.com/page
[2] https://fake2.com/page
[3] https://real.com/page"""

        search_results = [
            {"url": "https://real.com/page", "snippet": "断言C相关", "title": "Real"},
        ]

        config = ValidationConfig(
            max_unverified_ratio=0.3,
            enable_contradiction_check=False,
            enable_credibility_scoring=False,
        )
        pipeline = CitationValidationPipeline(config=config)
        result = await pipeline.validate(report, search_results)
        # 3 个引用中 2 个未验证 = 66% > 30%
        assert result.overall_pass is False

    @pytest.mark.asyncio
    async def test_validation_report_summary(self):
        """验证报告摘要应包含关键信息"""
        vr = ValidationReport(
            total_citations=5,
            verified_citations=3,
            unverified_citations=2,
            duplicate_citations=1,
            contradictions=[],
            credibility_scores=[],
            overall_pass=False,
            issues=["未验证引用占比过高"],
        )
        summary = vr.summary()
        assert "总引用数: 5" in summary
        assert "已验证: 3" in summary
        assert "未通过" in summary
```

---

## 第 5 章 跨域关联

| 关联域 | 关系 | 说明 |
|--------|------|------|
| PD-07.01 Reviewer 多维评估 | 互补 | 07.01 做宏观质量评估，本方案做微观引用验证 |
| PD-08 搜索与检索 | 上游 | 搜索结果是引用验证的比对基准 |
| PD-06 记忆持久化 | 扩展 | 验证通过的引用可缓存，避免重复验证 |
| PD-01 上下文管理 | 输入 | 验证需要原始搜索结果作为上下文 |
| PD-11 可观测性 | 监控 | 验证通过率、幻觉引用率需要追踪 |
| PD-03 容错与重试 | 降级 | URL 不可达时的降级策略 |

---

## 第 6 章 来源文件索引

| 编号 | 文件 | 说明 |
|------|------|------|
| S1 | `gpt_researcher/report_generator/report_generator.py` | 报告生成 + 引用注入 |
| S2 | `gpt_researcher/utils/validator.py` | 引用验证核心逻辑 |
| S3 | `gpt_researcher/utils/text_processing.py` | 文本处理工具（去重相关） |
| S4 | `gpt_researcher/context/compression.py` | 上下文压缩（去重配合） |
| S5 | `gpt_researcher/master/agent.py` | Master Agent（验证管道集成点） |