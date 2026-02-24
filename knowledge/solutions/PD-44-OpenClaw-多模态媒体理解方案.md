# PD-44.01 OpenClaw — 多模态媒体理解统一管道

> 文档编号：PD-44.01
> 来源：OpenClaw `src/media-understanding/`
> GitHub：https://github.com/openclaw/openclaw
> 问题域：PD-44 多模态媒体理解 Media Understanding
> 状态：可复用方案

---

## 第 1 章 问题与动机

### 1.1 核心问题

Agent 系统需要理解用户发送的多种媒体类型——图片、音频、视频——并将理解结果转化为文本注入对话上下文。核心挑战包括：

1. **多 Provider 异构接口**：OpenAI Whisper、Google Gemini、Deepgram、Anthropic Claude Vision 等各有不同的 API 格式、认证方式和能力边界
2. **媒体格式多样性**：用户可能发送 HEIC 图片、OGG 语音、M4V 视频等数十种格式，需要统一的格式检测和路由
3. **跨渠道一致性**：同一套理解能力需要在 Telegram、Slack、Discord、微信等 8+ 渠道上一致工作
4. **资源约束**：媒体处理耗时长、占内存大，需要并发控制和超时保护
5. **语音笔记特殊场景**：群聊中 requireMention 模式下，语音消息需要先转写才能判断是否 @了 bot

### 1.2 OpenClaw 的解法概述

OpenClaw 构建了一套完整的多模态媒体理解管道，核心设计：

1. **三能力统一抽象**：将 image/audio/video 三种能力统一为 `MediaUnderstandingCapability`，共享同一套 runner 管道（`runner.ts:659`）
2. **Provider Registry 模式**：8 个 provider 注册到统一 Map，按 capability 自动匹配（`providers/index.ts:31`）
3. **多级 Fallback 链**：配置 entries → 自动发现本地 CLI → Gemini CLI → API Key 探测，逐级降级（`runner.ts:453`）
4. **Scope-based 门控**：按 channel/chatType/sessionKey 维度控制媒体理解的启用范围（`scope.ts:26`）
5. **Audio Preflight 机制**：在 mention 检查之前预转写音频，解决群聊语音笔记的鸡蛋问题（`audio-preflight.ts:20`）

### 1.3 设计思想

| 设计原则 | 具体实现 | 理由 | 替代方案 |
|----------|----------|------|----------|
| 能力而非格式 | 按 image/audio/video 三能力路由，不按 MIME 路由 | 同一能力的不同格式可复用同一 provider | 按 MIME 类型建立路由表 |
| Provider 可插拔 | `MediaUnderstandingProvider` 接口 + Map 注册表 | 新增 provider 只需实现接口并注册 | 硬编码 if-else 分支 |
| 配置优先于约定 | 用户可配置 models 列表覆盖自动发现 | 生产环境需要确定性的 provider 选择 | 纯自动发现 |
| 本地优先降级 | 先查本地 whisper-cli/sherpa-onnx，再查云 API | 离线场景可用，降低 API 成本 | 仅云 API |
| 缓存复用 | `MediaAttachmentCache` 避免重复下载/读取 | 同一附件可能被多个 capability 使用 | 每次重新获取 |

---

## 第 2 章 源码实现分析

### 2.1 架构概览

OpenClaw 的媒体理解系统分为四层：

```
┌─────────────────────────────────────────────────────────┐
│                   apply.ts (入口层)                       │
│  applyMediaUnderstanding() → 并发执行三能力 → 注入上下文    │
├─────────────────────────────────────────────────────────┤
│                   runner.ts (编排层)                      │
│  runCapability() → scope 门控 → vision 跳过 → entry 解析  │
│  resolveAutoEntries() → 本地CLI/Gemini/API Key 自动发现   │
├─────────────────────────────────────────────────────────┤
│               runner.entries.ts (执行层)                  │
│  runProviderEntry() → 按 capability 分发到 provider       │
│  runCliEntry() → spawn 本地命令 + 模板变量替换             │
├─────────────────────────────────────────────────────────┤
│              providers/ (Provider 层)                     │
│  openai/ google/ deepgram/ anthropic/ groq/ mistral/     │
│  minimax/ zai/ — 各自实现 transcribe/describe 方法        │
└─────────────────────────────────────────────────────────┘
         ↕                    ↕                  ↕
   attachments.ts        concurrency.ts       scope.ts
   (附件缓存+格式检测)    (并发控制)          (作用域门控)
```

### 2.2 核心实现

#### 2.2.1 统一 Provider 接口与注册

Provider 接口定义在 `types.ts:109-115`，每个 provider 只需声明支持的能力和对应方法：

```typescript
// src/media-understanding/types.ts:109-115
export type MediaUnderstandingProvider = {
  id: string;
  capabilities?: MediaUnderstandingCapability[];
  transcribeAudio?: (req: AudioTranscriptionRequest) => Promise<AudioTranscriptionResult>;
  describeVideo?: (req: VideoDescriptionRequest) => Promise<VideoDescriptionResult>;
  describeImage?: (req: ImageDescriptionRequest) => Promise<ImageDescriptionResult>;
};
```

注册表构建在 `providers/index.ts:31-53`，使用 Map 存储，支持运行时 override：

```typescript
// src/media-understanding/providers/index.ts:12-21
const PROVIDERS: MediaUnderstandingProvider[] = [
  groqProvider, openaiProvider, googleProvider, anthropicProvider,
  minimaxProvider, mistralProvider, zaiProvider, deepgramProvider,
];

// providers/index.ts:31-53
export function buildMediaUnderstandingRegistry(
  overrides?: Record<string, MediaUnderstandingProvider>,
): Map<string, MediaUnderstandingProvider> {
  const registry = new Map<string, MediaUnderstandingProvider>();
  for (const provider of PROVIDERS) {
    registry.set(normalizeMediaProviderId(provider.id), provider);
  }
  if (overrides) {
    for (const [key, provider] of Object.entries(overrides)) {
      const existing = registry.get(normalizeMediaProviderId(key));
      const merged = existing ? { ...existing, ...provider } : provider;
      registry.set(normalizeMediaProviderId(key), merged);
    }
  }
  return registry;
}
```

#### 2.2.2 能力执行管道 runCapability

`runner.ts:659-805` 是单个能力的完整执行流程，包含 5 个阶段：

1. **启用检查**：`config?.enabled === false` 直接返回 disabled
2. **附件筛选**：`selectAttachments()` 按 capability 过滤匹配的附件
3. **Scope 门控**：`resolveScopeDecision()` 按 channel/chatType 判断是否允许
4. **Vision 跳过**：如果主模型原生支持 vision，跳过 image understanding（`runner.ts:707-741`）
5. **Entry 解析与执行**：先查配置 entries，空则自动发现，逐 attachment 执行 fallback 链

Vision 跳过是一个精妙的优化——当主聊天模型（如 GPT-4o）本身支持 vision 时，图片会直接注入模型上下文，无需额外调用 image understanding：

```typescript
// src/media-understanding/runner.ts:707-741
const activeProvider = params.activeModel?.provider?.trim();
if (capability === "image" && activeProvider) {
  const catalog = await loadModelCatalog({ config: cfg });
  const entry = findModelInCatalog(catalog, activeProvider, params.activeModel?.model ?? "");
  if (modelSupportsVision(entry)) {
    if (shouldLogVerbose()) {
      logVerbose("Skipping image understanding: primary model supports vision natively");
    }
    return {
      outputs: [],
      decision: {
        capability,
        outcome: "skipped",
        attachments: selected.map((item) => ({
          attachmentIndex: item.index,
          attempts: [{ type: "provider", provider: activeProvider, outcome: "skipped",
            reason: "primary model supports vision natively" }],
        })),
      },
    };
  }
}
```

#### 2.2.3 多级自动发现 resolveAutoEntries

当用户未配置 model entries 时，`runner.ts:453-485` 执行自动发现链：

```typescript
// src/media-understanding/runner.ts:453-485
async function resolveAutoEntries(params): Promise<MediaUnderstandingModelConfig[]> {
  // 1. 尝试当前活跃模型
  const activeEntry = await resolveActiveModelEntry(params);
  if (activeEntry) return [activeEntry];
  // 2. 音频：尝试本地 CLI (sherpa-onnx → whisper-cli → whisper)
  if (params.capability === "audio") {
    const localAudio = await resolveLocalAudioEntry();
    if (localAudio) return [localAudio];
  }
  // 3. 图片：尝试 agent 默认 imageModel 配置
  if (params.capability === "image") {
    const imageModelEntries = resolveImageModelFromAgentDefaults(params.cfg);
    if (imageModelEntries.length > 0) return imageModelEntries;
  }
  // 4. 尝试 Gemini CLI
  const gemini = await resolveGeminiCliEntry(params.capability);
  if (gemini) return [gemini];
  // 5. 按优先级探测 API Key
  const keys = await resolveKeyEntry(params);
  if (keys) return [keys];
  return [];
}
```

本地 CLI 发现（`runner.ts:306-316`）按优先级尝试三种本地转写引擎：

```typescript
// src/media-understanding/runner.ts:306-316
async function resolveLocalAudioEntry(): Promise<MediaUnderstandingModelConfig | null> {
  const sherpa = await resolveSherpaOnnxEntry();  // 最快，纯离线
  if (sherpa) return sherpa;
  const whisperCpp = await resolveLocalWhisperCppEntry();  // C++ 实现
  if (whisperCpp) return whisperCpp;
  return await resolveLocalWhisperEntry();  // Python whisper
}
```

#### 2.2.4 附件缓存与安全路径验证

`MediaAttachmentCache`（`attachments.ts:223-485`）是媒体数据的统一访问层，核心特性：

- **懒加载**：首次 `getBuffer()` 时才读取文件或下载 URL
- **路径安全**：通过 `isInboundPathAllowed()` + `realpath` 双重验证防止路径穿越
- **大小限制**：`maxBytes` 检查在读取前（stat）和读取后（buffer.length）双重执行
- **临时文件管理**：CLI 模式需要文件路径时自动创建临时文件，`cleanup()` 统一清理

#### 2.2.5 Scope 门控系统

`scope.ts:26-64` 实现了基于规则的媒体理解作用域控制：

```typescript
// src/media-understanding/scope.ts:26-64
export function resolveMediaUnderstandingScope(params: {
  scope?: MediaUnderstandingScopeConfig;
  sessionKey?: string; channel?: string; chatType?: string;
}): MediaUnderstandingScopeDecision {
  const scope = params.scope;
  if (!scope) return "allow";
  for (const rule of scope.rules ?? []) {
    const action = normalizeDecision(rule.action) ?? "allow";
    const match = rule.match ?? {};
    if (matchChannel && matchChannel !== channel) continue;
    if (matchChatType && matchChatType !== chatType) continue;
    if (matchPrefix && !sessionKey.startsWith(matchPrefix)) continue;
    return action;  // 首条匹配规则生效
  }
  return normalizeDecision(scope.default) ?? "allow";
}
```

### 2.3 实现细节

#### Decision Tracking 机制

每次执行都会生成 `MediaUnderstandingDecision` 记录（`types.ts:45-49`），包含每个 attachment 的所有尝试和最终选择。这为调试和可观测性提供了完整的决策链路：

```
decision = {
  capability: "audio",
  outcome: "success",
  attachments: [{
    attachmentIndex: 0,
    attempts: [
      { provider: "groq", outcome: "failed", reason: "HTTP 401" },
      { provider: "openai", outcome: "success", model: "gpt-4o-mini-transcribe" }
    ],
    chosen: { provider: "openai", outcome: "success" }
  }]
}
```

#### API Key 轮转

`runProviderEntry()`（`runner.entries.ts:342-523`）通过 `executeWithApiKeyRotation()` 支持多 API Key 轮转，当一个 Key 失败时自动切换到下一个。

#### CLI 模板变量

CLI entry 支持模板变量替换（`runner.entries.ts:555-566`），变量包括 `{{MediaPath}}`、`{{OutputDir}}`、`{{Prompt}}`、`{{MaxChars}}` 等，使得任意命令行工具都可以作为 media understanding backend。

