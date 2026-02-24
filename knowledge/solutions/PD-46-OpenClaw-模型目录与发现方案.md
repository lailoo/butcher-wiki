# PD-46.01 OpenClaw — 多层模型目录与动态发现系统

> 文档编号：PD-46.01
> 来源：OpenClaw `src/agents/model-catalog.ts` `src/agents/model-selection.ts` `src/agents/models-config.providers.ts`
> GitHub：https://github.com/openclaw/openclaw
> 问题域：PD-46 模型目录与发现 Model Catalog & Discovery
> 状态：可复用方案

---

## 第 1 章 问题与动机

### 1.1 核心问题

Agent 系统需要对接多个 LLM Provider（Anthropic、OpenAI、Google、AWS Bedrock、Ollama、HuggingFace、BytePlus、MiniMax、Qwen 等 20+ 家），每家的 API 协议、认证方式、模型 ID 命名规则、能力特征（推理、视觉、上下文窗口）各不相同。核心挑战：

1. **模型发现碎片化**：有的 Provider 提供 REST API 列举模型（Ollama `/api/tags`、HuggingFace `/v1/models`、Bedrock `ListFoundationModels`），有的只能硬编码静态目录
2. **命名混乱**：同一 Provider 历史上有多个名称（`bytedance` → `volcengine`、`z.ai` → `zai`、`qwen` → `qwen-portal`），模型 ID 也有别名（`opus-4.6` → `claude-opus-4-6`）
3. **凭证注入复杂**：API Key、OAuth Token、AWS SDK 凭证链、GitHub Copilot Token 交换，每种 Provider 的认证路径不同
4. **配置合并策略**：用户自定义配置需要与系统内置目录合并，既不能丢失用户的 cost/headers 自定义，又要刷新能力元数据

### 1.2 OpenClaw 的解法概述

OpenClaw 构建了一个三层模型目录架构：

1. **静态目录层**：每个 Provider 有独立的 `*-models.ts` 文件，硬编码已知模型的完整元数据（`models-config.providers.ts:453-765`）
2. **动态发现层**：运行时通过 HTTP API 探测本地/远程 Provider 的可用模型（`discoverOllamaModels`、`discoverBedrockModels`、`discoverHuggingfaceModels`、`discoverVeniceModels`、`discoverVllmModels`）
3. **统一注册层**：`loadModelCatalog()` 将所有来源合并为统一的 `ModelCatalogEntry[]`，通过 pi-coding-agent 的 `ModelRegistry` 持久化到 `models.json`（`model-catalog.ts:81-168`）

### 1.3 设计思想

| 设计原则 | 具体实现 | 理由 | 替代方案 |
|----------|----------|------|----------|
| 隐式发现优先 | `resolveImplicitProviders()` 自动检测环境变量和 auth profiles 来激活 Provider | 零配置体验，有 key 就能用 | 要求用户手动配置每个 Provider |
| 合并而非替换 | `mergeProviderModels()` 保留用户 cost/headers，刷新 reasoning/contextWindow | 用户自定义不丢失，能力元数据保持最新 | 全量覆盖或全量保留 |
| Provider ID 归一化 | `normalizeProviderId()` 将历史别名映射到规范 ID | 向后兼容，用户无感迁移 | 强制用户更新配置 |
| 别名索引 | `buildModelAliasIndex()` 构建双向 Map（alias→ref, key→aliases） | O(1) 查找，支持用户自定义短名 | 线性扫描配置 |
| 缓存 + 防毒 | `modelCatalogPromise` 单例缓存，失败时清空防止毒化 | 避免重复加载，瞬态错误可恢复 | 无缓存或永久缓存 |

---

## 第 2 章 源码实现分析

### 2.1 架构概览

```
┌─────────────────────────────────────────────────────────────────────┐
│                        loadModelCatalog()                          │
│                     (model-catalog.ts:81)                          │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │              ensureOpenClawModelsJson()                      │  │
│  │                (models-config.ts:100)                        │  │
│  │  ┌────────────────────┐   ┌──────────────────────────────┐  │  │
│  │  │ resolveImplicit    │   │ cfg.models.providers         │  │  │
│  │  │ Providers()        │   │ (用户显式配置)                │  │  │
│  │  │ (providers.ts:767) │   │                              │  │  │
│  │  └────────┬───────────┘   └──────────────┬───────────────┘  │  │
│  │           │                              │                  │  │
│  │           ▼                              ▼                  │  │
│  │  ┌────────────────────────────────────────────────────┐     │  │
│  │  │         mergeProviders() (models-config.ts:75)     │     │  │
│  │  │  implicit ∪ explicit, 同 ID 模型走 mergeModels     │     │  │
│  │  └────────────────────────┬───────────────────────────┘     │  │
│  │                           ▼                                 │  │
│  │  ┌────────────────────────────────────────────────────┐     │  │
│  │  │    normalizeProviders() (providers.ts:384)         │     │  │
│  │  │  修复 apiKey 格式 + 从 env/profiles 注入凭证       │     │  │
│  │  └────────────────────────┬───────────────────────────┘     │  │
│  │                           ▼                                 │  │
│  │              写入 agentDir/models.json                      │  │
│  └──────────────────────────────────────────────────────────────┘  │
│                              ▼                                     │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │  pi-coding-agent ModelRegistry                              │  │
│  │  读取 auth.json + models.json → getAll() → ModelCatalogEntry│  │
│  └──────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────┘

隐式 Provider 发现源:
  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐
  │ Ollama   │  │ Bedrock  │  │ HuggingFace│ │ Venice   │  │ vLLM     │
  │ /api/tags│  │ ListFM   │  │ /v1/models │ │ discover │  │ /models  │
  └──────────┘  └──────────┘  └──────────┘  └──────────┘  └──────────┘
  + 静态目录: MiniMax, Xiaomi, Moonshot, Kimi, Qwen, Doubao, BytePlus,
              Together, Synthetic, OpenRouter, Qianfan, NVIDIA, Copilot
```

OpenClaw 的模型目录系统分为三个核心层次：

1. **Provider 发现层**（`models-config.providers.ts`）：20+ 个 Provider 的静态目录 + 5 个动态发现源
2. **配置合并层**（`models-config.ts`）：隐式发现 + 显式配置的智能合并，输出 `models.json`
3. **统一目录层**（`model-catalog.ts`）：通过 `ModelRegistry` 加载 `models.json`，提供统一查询接口

### 2.2 核心实现

#### 2.2.1 隐式 Provider 发现（`models-config.providers.ts:767-955`）

`resolveImplicitProviders()` 是整个发现系统的入口。它遍历所有已知 Provider，检查环境变量或 auth profiles 中是否存在凭证，有则自动激活该 Provider：

```typescript
// src/agents/models-config.providers.ts:767-780
export async function resolveImplicitProviders(params: {
  agentDir: string;
  explicitProviders?: Record<string, ProviderConfig> | null;
}): Promise<ModelsConfig["providers"]> {
  const providers: Record<string, ProviderConfig> = {};
  const authStore = ensureAuthProfileStore(params.agentDir, {
    allowKeychainPrompt: false,
  });

  const minimaxKey =
    resolveEnvApiKeyVarName("minimax") ??
    resolveApiKeyFromProfiles({ provider: "minimax", store: authStore });
  if (minimaxKey) {
    providers.minimax = { ...buildMinimaxProvider(), apiKey: minimaxKey };
  }
  // ... 对每个 Provider 重复此模式
}
```

每个 Provider 的发现逻辑遵循统一模式：`resolveEnvApiKeyVarName(provider) ?? resolveApiKeyFromProfiles(provider)`，优先环境变量，其次 auth profiles。

#### 2.2.2 动态模型发现（以 Ollama 为例）

对于支持 API 列举的 Provider，OpenClaw 在运行时探测可用模型（`models-config.providers.ts:230-267`）：

```typescript
// src/agents/models-config.providers.ts:230-267
async function discoverOllamaModels(baseUrl?: string): Promise<ModelDefinitionConfig[]> {
  if (process.env.VITEST || process.env.NODE_ENV === "test") {
    return [];  // 测试环境跳过网络调用
  }
  try {
    const apiBase = resolveOllamaApiBase(baseUrl);
    const response = await fetch(`${apiBase}/api/tags`, {
      signal: AbortSignal.timeout(5000),  // 5s 超时保护
    });
    if (!response.ok) {
      log.warn(`Failed to discover Ollama models: ${response.status}`);
      return [];
    }
    const data = (await response.json()) as OllamaTagsResponse;
    return data.models.map((model) => {
      const isReasoning =
        modelId.toLowerCase().includes("r1") ||
        modelId.toLowerCase().includes("reasoning");
      return {
        id: model.name,
        name: model.name,
        reasoning: isReasoning,
        input: ["text"],
        cost: OLLAMA_DEFAULT_COST,
        contextWindow: OLLAMA_DEFAULT_CONTEXT_WINDOW,
        maxTokens: OLLAMA_DEFAULT_MAX_TOKENS,
      };
    });
  } catch (error) {
    log.warn(`Failed to discover Ollama models: ${String(error)}`);
    return [];  // 优雅降级：发现失败不阻塞启动
  }
}
```

