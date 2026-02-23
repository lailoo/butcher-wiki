# Butcher Wiki — 项目设计文档

## 一、定位与差异化

### 1.1 三者关系：DeepWiki × Butcher Wiki × EvoMap

| 维度 | DeepWiki | Butcher Wiki | EvoMap |
|------|----------|-------------|--------|
| 分析轴 | 纵向：单项目深度分析 | 横向：跨项目同一问题对比 | 运行时：Agent 自动获取经验 |
| 输入 | 一个 Git 仓库 URL | 多个仓库 + 问题域定义 | Agent 运行日志 + 错误信号 |
| 输出 | 项目架构 Wiki | 问题域解决方案图谱 | Gene + Capsule（可执行经验） |
| 消费者 | 人类（了解项目） | 人类（解决工程问题） | Agent（自动应用经验） |
| 类比 | 一本书的目录和章节 | 一篇综述论文的引用网络 | DNA 遗传系统 |

### 1.2 核心隐喻：项目切割机

Butcher Wiki 就是一个"项目切割机"——把开源项目大卸八块，
切割成一个个可移植的工程组件（设计模式、实现机制、解决方案），
按问题域重新组织，让开发者能按需挑选零件，重组出自己的实现。

```
开源项目 A ──┐                    ┌── PD-01 上下文管理 ── [A的解法, B的解法, C的解法]
开源项目 B ──┤  Butcher Wiki 切割  ├── PD-02 多Agent编排 ── [A的解法, D的解法]
开源项目 C ──┤  ──────────────→   ├── PD-03 容错重试   ── [B的解法, C的解法, E的解法]
开源项目 D ──┤                    ├── ...
开源项目 E ──┘                    └── PD-12 推理增强   ── [C的解法, D的解法]
```

### 1.3 与 EvoMap GEP 协议的关系

EvoMap 的 Gene（基因）= 结构化的经验模板，面向 Agent 运行时自动消费。
Butcher Wiki 的 Solution = 人类可读的工程组件，面向开发者参考借鉴。

两者可以互通：
- Butcher Wiki Solution → 导出为 GEP Gene（人类经验 → 机器可用）
- EvoMap Capsule → 反哺 Butcher Wiki（Agent 验证过的方案 → 人类参考）

未来可选：为每个 Solution 生成 GEP 兼容的 Gene 格式，
让 Agent 在遇到问题时自动从 Butcher Wiki 获取解决方案。

### 1.4 核心价值主张

```
"当你在构建 Agent 时遇到上下文超限问题，
 不需要翻遍 10 个开源项目的源码，
 Butcher Wiki 直接告诉你：
 MiroThinker 用 tiktoken 估算 + 分级裁剪，
 DeerFlow 用 SummarizationMiddleware 三触发压缩，
 GPT-Researcher 用 Embedding 相似度压缩，
 以及它们各自的 trade-off。"
```

## 二、数据模型

### 2.1 三层知识结构

```
Problem Domain（问题域）
  ├── Solution（解决方案）  ← 来自具体项目
  │     ├── 设计思想
  │     ├── 核心代码片段 + file:line 引用
  │     ├── 架构图（Mermaid）
  │     └── 优劣势分析
  ├── Solution（另一个项目的解法）
  │     └── ...
  └── Comparison（横向对比）
        ├── 维度对比表
        ├── 适用场景分析
        ├── 最佳实践建议
        └── 借鉴思路（对其他问题域的启发）
```

### 2.2 核心实体

```typescript
// 问题域
interface ProblemDomain {
  id: string;              // "PD-01"
  slug: string;            // "context-management"
  title: string;           // "上下文管理"
  subtitle: string;        // "Context Window Management"
  description: string;     // 核心问题描述
  tags: string[];          // ["token", "compression", "truncation"]
  severity: 'critical' | 'high' | 'medium';
  solutions: Solution[];
  comparison?: Comparison;
}

// 解决方案（来自某个项目）
interface Solution {
  id: string;              // "PD-01-mirothinker"
  domainId: string;        // "PD-01"
  project: ProjectRef;     // 来源项目
  title: string;           // "tiktoken 精确估算 + 分级裁剪"
  designPhilosophy: string[];  // 设计思想
  mechanism: string;       // 机制描述（Markdown）
  codeSnippets: CodeSnippet[];
  architecture?: string;   // Mermaid 图
  pros: string[];
  cons: string[];
  applicableScenarios: string[];
  relatedDomains: string[]; // 对其他问题域的借鉴
}

// 代码片段
interface CodeSnippet {
  file: string;            // "openai_client.py"
  lines: string;           // "384-444"
  language: string;
  code: string;
  explanation: string;
}

// 项目引用
interface ProjectRef {
  name: string;            // "MiroThinker"
  repo: string;            // "github.com/xxx/mirothinker"
  stars: number;
  language: string;
  description: string;
}

// 横向对比
interface Comparison {
  domainId: string;
  dimensions: ComparisonDimension[];
  bestPractices: string[];
  inspirations: Inspiration[];  // 对其他问题域的启发
}
```

## 三、系统架构

```
┌─────────────────────────────────────────────────┐
│                  Next.js 前端                     │
│  ┌──────────┐ ┌──────────┐ ┌──────────────────┐ │
│  │ 问题域    │ │ 解决方案  │ │ 横向对比         │ │
│  │ 总览页    │ │ 详情页   │ │ 可视化页         │ │
│  └──────────┘ └──────────┘ └──────────────────┘ │
│         visionOS 玻璃态卡片 + Mermaid 图表        │
└────────────────────┬────────────────────────────┘
                     │ HTTP / WebSocket
┌────────────────────┴────────────────────────────┐
│                FastAPI 后端                       │
│  ┌──────────┐ ┌──────────┐ ┌──────────────────┐ │
│  │ Scanner  │ │Extractor │ │   Comparator     │ │
│  │ 仓库扫描  │ │特性提取   │ │   跨项目对比      │ │
│  └──────────┘ └──────────┘ └──────────────────┘ │
│  ┌──────────────────────────────────────────────┐│
│  │          Knowledge Store (YAML/MD)           ││
│  │  domains/ → solutions/ → comparisons/        ││
│  └──────────────────────────────────────────────┘│
└──────────────────────────────────────────────────┘
```

### 3.1 工作流

#### 流程 A：手动录入（从已有方案迁移）
```
vibe-blog-plan-方案/*.md → 解析提取 → 按问题域分类 → 写入 knowledge/
```

#### 流程 B：自动扫描（新项目分析）
```
输入 Git URL → clone → 代码扫描 → LLM 特性提取 → 匹配问题域 → 生成 Solution → 自动对比
```

#### 流程 C：交互式探索（前端）
```
用户浏览问题域 → 查看各项目解法 → 对比分析 → RAG 问答深入了解
```

## 四、前端设计

### 4.1 视觉风格：visionOS 玻璃态

参考 Apple Vision Pro 的设计语言：
- 深色背景（#0a0a0a ~ #1a1a2e）
- 毛玻璃半透明卡片（backdrop-blur + rgba 背景）
- 彩色边缘光晕（渐变 border + box-shadow）
- 层叠透视效果（transform: perspective + rotateX）
- 微妙的光影变化（hover 时光晕增强）

### 4.2 页面结构

```
/                          → 首页：问题域总览（12 张玻璃卡片网格）
/domain/[slug]             → 问题域详情：解决方案列表 + 对比图
/domain/[slug]/[solution]  → 解决方案详情：代码 + 架构图 + 分析
/compare/[slug]            → 横向对比页：多项目并排对比
/projects                  → 项目索引：所有被分析的开源项目
/scan                      → 扫描新项目：输入 URL 自动分析
```

## 五、与 vibe-blog-evolve 的整合

### 5.1 方法论借鉴

| evolve 阶段 | horizon-wiki 对应 |
|-------------|-------------------|
| scan（扫描 trending） | Scanner：扫描仓库，但不限于 trending |
| deep-compare（深度对比） | Extractor：提取特性，但按问题域组织而非按项目 |
| assess（5 维评估） | 每个 Solution 的 pros/cons + 适用场景 |
| plan（迁移方案） | Comparison 中的最佳实践建议 |
| record（经验沉淀） | Knowledge Store 本身就是沉淀 |

### 5.2 D1-D17 映射

evolve 的 17 个进化方向中，与 Agent 工程通用性强的映射到 horizon-wiki 的问题域：

| evolve 方向 | horizon-wiki 问题域 | 通用性 |
|-------------|-------------------|--------|
| D3 深度研究 | PD-08 搜索与检索 | ★★★★★ |
| D8 Agent 执行架构 | PD-02 多Agent编排 + PD-10 中间件 | ★★★★★ |
| D9 专业 Agent 设计 | PD-02 + PD-07 | ★★★★☆ |
| D16 开发运维 | PD-11 可观测性 | ★★★★★ |
| D17 Agent 开发范式 | 所有问题域 | ★★★★★ |
| D4 事实核查 | PD-07 质量检查 | ★★★★☆ |
| D7 用户交互 | PD-09 Human-in-Loop | ★★★★☆ |

### 5.3 数据流通

```
vibe-blog-evolve 产出方案 → 提取问题域特性 → 写入 horizon-wiki knowledge/
horizon-wiki 积累最佳实践 → 反哺 evolve 的 assess 和 plan 阶段
```
