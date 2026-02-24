# PD-06.04 OpenClaw — SQLite + sqlite-vec 混合搜索记忆系统

> 文档编号：PD-06.04
> 来源：OpenClaw `src/memory/manager.ts`, `src/memory/hybrid.ts`, `src/memory/embeddings.ts`
> GitHub：https://github.com/openclaw/openclaw.git
> 问题域：PD-06 记忆持久化 Memory Persistence
> 状态：可复用方案

---

## 第 1 章 问题与动机

### 1.1 核心问题

Agent 在多轮对话和跨会话场景中需要持久化记忆能力。核心挑战包括：

1. **存储后端选择**：向量数据库（Pinecone/Weaviate）部署成本高，文件系统检索效率低，需要一个轻量但功能完整的方案
2. **检索质量**：纯向量搜索对精确关键词匹配弱，纯全文检索对语义理解差，需要混合搜索
3. **Embedding 供应商锁定**：依赖单一 embedding provider 导致可用性风险
4. **实时同步**：记忆文件变更后需要自动感知并重新索引，不能依赖手动触发
5. **降级能力**：当 embedding provider 不可用时，系统不应完全失效

### 1.2 OpenClaw 的解法概述

OpenClaw 构建了一个基于 SQLite 的完整记忆持久化系统，核心特点：

1. **SQLite + sqlite-vec 双引擎**：用 Node.js 内置 `node:sqlite` 做关系存储，sqlite-vec 扩展做向量索引，FTS5 做全文检索，三者共享同一个 SQLite 数据库文件（`src/memory/memory-schema.ts:9-83`）
2. **BM25 + 向量混合搜索 + MMR 去重**：加权融合 BM25 全文分数和向量余弦相似度，再用 MMR（Maximal Marginal Relevance）算法去除冗余结果（`src/memory/hybrid.ts:51-149`）
3. **多 Provider 自动 Fallback**：支持 OpenAI/Gemini/Voyage/Mistral/本地 LLaMA 五种 embedding provider，auto 模式按优先级尝试，全部失败则降级为 FTS-only 模式（`src/memory/embeddings.ts:144-260`）
4. **文件监听自动同步**：chokidar 监听 `MEMORY.md` 和 `memory/` 目录变更，防抖后自动触发重新索引（`src/memory/manager-sync-ops.ts:356-398`）
5. **时间衰减评分**：对搜索结果施加指数衰减，半衰期可配置，日期型记忆文件（`memory/2024-01-15.md`）自动解析日期，常青记忆不衰减（`src/memory/temporal-decay.ts:24-34`）

### 1.3 设计思想

| 设计原则 | 具体实现 | 理由 | 替代方案 |
|----------|----------|------|----------|
| 零外部依赖 | SQLite 单文件数据库 | 无需部署向量数据库服务，开箱即用 | Pinecone/Weaviate/Chroma |
| 优雅降级 | FTS-only 模式 | embedding 不可用时仍能搜索 | 直接报错拒绝服务 |
| Provider 无关 | 5 种 embedding + auto 选择 | 避免供应商锁定 | 硬编码 OpenAI |
| 原子重索引 | temp DB → swap 模式 | 重索引失败不破坏现有数据 | 就地更新 |
| 多信号融合 | BM25 + vector + temporal decay + MMR | 单一信号各有盲区 | 纯向量搜索 |

---

## 第 2 章 源码实现分析

### 2.1 架构概览

```
┌─────────────────────────────────────────────────────────────────┐
│                    MemoryIndexManager                           │
│                    (src/memory/manager.ts)                      │
│  ┌──────────┐  ┌──────────────┐  ┌───────────────────────┐     │
│  │ search() │  │   sync()     │  │   close()             │     │
│  └────┬─────┘  └──────┬───────┘  └───────────────────────┘     │
│       │               │                                         │
│  ┌────▼─────────────────▼──────────────────────────────────┐    │
│  │              SQLite Database (node:sqlite)               │    │
│  │  ┌─────────┐  ┌──────────┐  ┌────────────────────────┐ │    │
│  │  │  files   │  │  chunks  │  │  embedding_cache       │ │    │
│  │  └─────────┘  └──────────┘  └────────────────────────┘ │    │
│  │  ┌──────────────┐  ┌──────────────┐                     │    │
│  │  │ chunks_fts   │  │ chunks_vec   │                     │    │
│  │  │ (FTS5 BM25)  │  │ (sqlite-vec) │                     │    │
│  │  └──────┬───────┘  └──────┬───────┘                     │    │
│  └─────────┼─────────────────┼─────────────────────────────┘    │
│            │                 │                                   │
│  ┌─────────▼─────────────────▼──────────────────────────────┐   │
│  │           mergeHybridResults (hybrid.ts)                  │   │
│  │  vectorWeight * vecScore + textWeight * bm25Score         │   │
│  │       ↓ temporalDecay ↓ MMR rerank                        │   │
│  └───────────────────────────────────────────────────────────┘   │
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐    │
│  │         EmbeddingProvider (embeddings.ts)                 │    │
│  │  OpenAI │ Gemini │ Voyage │ Mistral │ Local LLaMA        │    │
│  │         auto fallback chain                               │    │
│  └──────────────────────────────────────────────────────────┘    │
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐    │
│  │         File Watcher (chokidar)                           │    │
│  │  MEMORY.md │ memory/**/*.md │ extraPaths                  │    │
│  │  + Session Transcript Listener (.jsonl)                   │    │
│  └──────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────┘
```

<!-- PLACEHOLDER_CH2_CONTINUE -->
