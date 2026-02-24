# PD-08.06 OpenManus — 四引擎自动 Fallback 搜索系统

> 文档编号：PD-08.06
> 来源：OpenManus `app/tool/web_search.py`, `app/tool/search/`, `app/tool/crawl4ai.py`
> GitHub：https://github.com/FoundationAgents/OpenManus.git
> 问题域：PD-08 搜索与检索 Search & Retrieval
> 状态：可复用方案

---

## 第 1 章 问题与动机

### 1.1 核心问题

Agent 系统在执行搜索任务时面临三个关键挑战：

1. **单引擎不可靠**：任何单一搜索引擎都可能因 API 限流、地域封锁、服务宕机而失败。Google 在中国不可用，Baidu 在海外质量差，DuckDuckGo 有请求频率限制，Bing 需要 HTML 解析容易被反爬。
2. **搜索结果浅层化**：搜索引擎返回的 snippet 信息量有限，Agent 需要深入抓取页面正文才能获得足够上下文。
3. **异构结果格式**：不同搜索引擎返回的数据结构各异（有的返回 dict，有的返回对象，有的返回纯 URL），需要统一的结构化输出。

### 1.2 OpenManus 的解法概述

OpenManus 实现了一套配置驱动的四引擎 Fallback 搜索系统：

1. **四引擎适配器**：Google/Baidu/DuckDuckGo/Bing 四个引擎通过统一的 `WebSearchEngine` 基类接入，每个引擎独立实现 `perform_search` 方法（`app/tool/search/base.py:20-40`）
2. **双层重试机制**：内层用 tenacity 对单引擎做指数退避重试（3 次），外层对全部引擎做循环重试（可配置 max_retries 次，间隔 60s）（`app/tool/web_search.py:387-408`）
3. **配置驱动引擎排序**：通过 TOML 配置文件指定首选引擎和 fallback 顺序，运行时动态构建引擎链（`app/config.py:39-60`）
4. **可选内容抓取**：`fetch_content` 参数控制是否深入抓取页面正文，用 BeautifulSoup 清洗 HTML 后截断到 10K 字符（`app/tool/web_search.py:106-153`）
5. **Crawl4AI 高级爬取**：独立的 `Crawl4aiTool` 提供 headless 浏览器级别的页面抓取，输出 AI-ready 的 Markdown（`app/tool/crawl4ai.py:16-269`）

### 1.3 设计思想

| 设计原则 | 具体实现 | 理由 | 替代方案 |
|----------|----------|------|----------|
| 适配器模式统一接口 | `WebSearchEngine` 基类 + 4 个子类 | 新增引擎只需实现一个方法，零侵入 | 条件分支 if/elif（不可扩展） |
| 配置驱动优先级 | TOML `[search]` 段定义 engine + fallback_engines | 不同部署环境可调整引擎顺序 | 硬编码顺序（不灵活） |
| 双层重试分离关注点 | tenacity 管单引擎网络抖动，外层管全引擎轮转 | 网络瞬断和引擎宕机是不同故障模式 | 单层重试（粒度不够） |
| 按需抓取降低成本 | `fetch_content=False` 默认不抓取正文 | 多数场景 snippet 够用，抓取正文耗时且费 token | 总是抓取（浪费资源） |
| 搜索与爬取正交 | WebSearch 和 Crawl4aiTool 是独立工具 | Agent 可按需组合，搜索后选择性深入爬取 | 搜索内嵌爬取（耦合） |

---

## 第 2 章 源码实现分析

### 2.1 架构概览

