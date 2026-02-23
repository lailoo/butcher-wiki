# PD-10.02 DeepTutor — Fluent API 组合管道 + 工厂注册

> 文档编号：PD-10.02
> 来源：DeepTutor `src/services/rag/pipeline.py`, `src/services/rag/components/base.py`, `src/services/rag/factory.py`
> GitHub：https://github.com/HKUDS/DeepTutor.git
> 问题域：PD-10 中间件管道 Middleware Pipeline
> 状态：可复用方案

---

## 第 1 章 问题与动机（≥ 30 行）

### 1.1 核心问题

RAG（Retrieval-Augmented Generation）系统的处理流程天然是管道式的：文档解析 → 分块 → 嵌入 → 索引 → 检索。不同场景需要不同的组件组合——学术 PDF 需要 MinerU 解析器 + 知识图谱索引，纯文本文档只需简单分块 + 向量索引。如何让这些组件可以自由组合、按需替换，同时保持统一的调用接口？

传统做法是为每种组合写一个硬编码的 Pipeline 类，导致类爆炸。DeepTutor 面临的具体挑战：
- 4 种 RAG 后端（RAGAnything、RAGAnything-Docling、LightRAG、LlamaIndex），每种有不同的组件组合
- 组件有重量级依赖（llama_index、lightrag 等），不能在模块加载时全部导入
- 需要支持第三方扩展（自定义 pipeline 注册）
- Research 模块也有独立的三阶段管道（Planning → Researching → Reporting）

### 1.2 DeepTutor 的解法概述

1. **Protocol-based 组件协议**：`Component` 使用 `@runtime_checkable` Protocol 定义统一接口（`src/services/rag/components/base.py:12-35`），任何实现 `name` + `process()` 的类自动满足协议，无需继承
2. **Fluent API 管道组装**：`RAGPipeline` 通过链式调用 `.parser().chunker().embedder().indexer().retriever()` 组装管道（`src/services/rag/pipeline.py:63-86`），每个方法返回 `self`
3. **懒加载工厂注册**：`factory.py` 使用延迟初始化的全局注册表 `_PIPELINES`，每个 pipeline 的重量级依赖只在实际创建时导入（`src/services/rag/factory.py:20-63`）
4. **三阶段 Research Pipeline**：`ResearchPipeline` 实现 Planning → Researching → Reporting 的宏观管道，支持串行/并行执行模式（`src/agents/research/research_pipeline.py:391-504`）
5. **日志拦截中间件**：`LogInterceptor` 作为上下文管理器临时挂载 WebSocket handler 到 logger，实现日志流的动态拦截（`src/logging/handlers/websocket.py:94-131`）

### 1.3 设计思想

| 设计原则 | 具体实现 | 理由 | 替代方案 |
|----------|----------|------|----------|
| 鸭子类型优于继承 | `@runtime_checkable Protocol` 定义 Component | 第三方组件无需继承基类即可接入 | ABC 抽象基类（强制继承） |
| 组合优于配置 | Fluent API 链式调用组装管道 | 代码即配置，IDE 自动补全友好 | YAML 配置文件驱动 |
| 延迟加载 | 工厂函数内部 import 重量级依赖 | 避免未安装的可选依赖阻塞启动 | 全局 import + try/except |
| 向后兼容 | `get_plugin()` 映射到 `get_pipeline()` + deprecation warning | 平滑迁移旧 API 调用方 | 直接删除旧 API |
| 阶段隔离 | Research Pipeline 三阶段各自独立，通过 Queue 传递数据 | 每阶段可独立测试和替换 | 单一 run() 方法 |

---

## 第 2 章 源码实现分析（≥ 60 行，核心章节）

### 2.1 架构概览

DeepTutor 的管道体系分为两层：RAG 组件管道（微观）和 Research 工作流管道（宏观）。

```
┌─────────────────────────────────────────────────────────────────┐
│                    RAG Pipeline Layer                            │
│                                                                 │
│  RAGPipeline (Fluent API)                                       │
│  ┌────────┐  ┌─────────┐  ┌──────────┐  ┌─────────┐  ┌───────┐│
│  │ Parser │→│ Chunker  │→│ Embedder │→│ Indexer  │→│Retriever││
│  │(1个)   │  │(N个,顺序)│  │(1个)     │  │(N个,并行)│  │(1个)   ││
│  └────────┘  └─────────┘  └──────────┘  └─────────┘  └───────┘│
│       ↑                                                         │
│  FileTypeRouter (路由分类)                                       │
│                                                                 │
├─────────────────────────────────────────────────────────────────┤
│                    Factory Layer                                 │
│                                                                 │
│  _PIPELINES registry (lazy init)                                │
│  ┌──────────────┐ ┌─────────┐ ┌───────────┐ ┌──────────┐      │
│  │ raganything   │ │ lightrag│ │ llamaindex│ │ custom...│      │
│  │ (MinerU+KG)  │ │ (KG)   │ │ (Vector)  │ │          │      │
│  └──────────────┘ └─────────┘ └───────────┘ └──────────┘      │
│       ↑                                                         │
│  register_pipeline() — 第三方扩展入口                             │
│                                                                 │
├─────────────────────────────────────────────────────────────────┤
│                Research Pipeline Layer                           │
│                                                                 │
│  Phase 1: Planning    Phase 2: Researching    Phase 3: Reporting│
│  ┌──────────────┐    ┌──────────────────┐    ┌───────────────┐ │
│  │Rephrase Agent│    │Research Agent ×N  │    │Reporting Agent│ │
│  │Decompose     │    │(series/parallel)  │    │               │ │
│  │Agent         │    │+ Tool callbacks   │    │               │ │
│  └──────┬───────┘    └────────┬─────────┘    └───────────────┘ │
│         │  DynamicTopicQueue  │                                  │
│         └─────────────────────┘                                  │
└─────────────────────────────────────────────────────────────────┘
```

### 2.2 核心实现

#### 2.2.1 Component Protocol（`src/services/rag/components/base.py:12-35`）

```python
@runtime_checkable
class Component(Protocol):
    """
    Base protocol for all RAG components.
    All components must implement:
    - name: str - Component identifier
    - process(data, **kwargs) -> Any - Process input data
    """
    name: str

    async def process(self, data: Any, **kwargs) -> Any:
        ...
```

<!-- APPEND_PLACEHOLDER_1 -->
