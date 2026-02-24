# PD-45.01 OpenClaw — 多引擎 TTS 管道与语音交互全栈方案

> 文档编号：PD-45.01
> 来源：OpenClaw `src/tts/tts-core.ts` `src/tts/tts.ts`
> GitHub：https://github.com/openclaw/openclaw
> 问题域：PD-45 语音合成与交互 TTS & Voice Interaction
> 状态：可复用方案

---

## 第 1 章 问题与动机

### 1.1 核心问题

Agent 系统需要将文本回复转化为语音输出，以支持多渠道（Telegram 语音条、Discord 语音消息、电话通话）的自然交互。核心挑战包括：

1. **多 TTS 引擎统一接入** — 不同引擎（OpenAI、ElevenLabs、Edge TTS）的 API 协议、音频格式、计费模型各异，需要统一抽象
2. **渠道适配** — Telegram 要求 Opus 格式语音条，Discord 要求 OGG/Opus + 波形数据，电话要求 8kHz mu-law PCM，同一文本需输出不同格式
3. **长文本处理** — Agent 回复可能超过 TTS 引擎的合理输入长度，需要自动摘要或截断
4. **运行时可控** — 用户需要通过斜杠命令或 API 实时切换 TTS 开关、引擎、参数，无需重启
5. **LLM 内联指令** — 模型输出中嵌入 `[[tts:voice=nova]]` 等指令，动态控制语音参数

### 1.2 OpenClaw 的解法概述

OpenClaw 实现了一套完整的多引擎 TTS 管道，核心设计：

1. **三引擎策略模式 + 自动降级** — 支持 OpenAI / ElevenLabs / Edge TTS 三个引擎，按优先级自动 fallback（`src/tts/tts.ts:513-515`）
2. **渠道感知输出格式** — 根据目标渠道（telegram/discord/telephony）自动选择音频编码和格式（`src/tts/tts.ts:67-86`）
3. **指令解析系统** — 从 LLM 输出中解析 `[[tts:...]]` 内联指令，支持 provider/voice/model/voiceSettings 等 12+ 参数覆盖（`src/tts/tts-core.ts:99-326`）
4. **LLM 摘要降级链** — 长文本先尝试 LLM 摘要，失败则截断，确保 TTS 始终可用（`src/tts/tts.ts:858-887`）
5. **用户偏好持久化** — 通过 JSON 文件原子写入保存用户 TTS 偏好，支持 session 级覆盖（`src/tts/tts.ts:386-406`）

### 1.3 设计思想

| 设计原则 | 具体实现 | 理由 | 替代方案 |
|----------|----------|------|----------|
| 策略模式 + 有序降级 | `resolveTtsProviderOrder()` 构建 [primary, ...fallbacks] 数组，for 循环逐个尝试 | 单引擎故障不影响用户体验 | 固定单引擎（无容错） |
| 渠道感知输出 | `resolveOutputFormat(channelId)` 按渠道返回不同编码参数 | Telegram/Discord/电话对音频格式要求不同 | 统一 MP3（部分渠道不兼容） |
| 配置分层覆盖 | config.yaml → 用户偏好 JSON → session 参数 → LLM 指令，四层优先级 | 灵活性与可控性兼顾 | 单一配置源（不够灵活） |
| 零 API Key 可用 | Edge TTS 作为默认引擎，无需 API Key | 降低使用门槛，开箱即用 | 强制要求 API Key（阻碍新用户） |
| 原子文件写入 | `atomicWriteFileSync()` 先写 tmp 再 rename | 防止偏好文件写入中断导致损坏 | 直接 writeFileSync（有损坏风险） |

---

## 第 2 章 源码实现分析

### 2.1 架构概览

OpenClaw 的 TTS 系统采用分层管道架构，从 LLM 输出到音频文件经过 5 个阶段：

```
┌─────────────────────────────────────────────────────────────────┐
│                    maybeApplyTtsToPayload()                      │
│  src/tts/tts.ts:791                                             │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ① Auto-Mode 门控                                               │
│     off / always / inbound / tagged                              │
│         ↓                                                        │
│  ② 指令解析 parseTtsDirectives()                                │
│     [[tts:voice=nova]] → overrides                               │
│         ↓                                                        │
│  ③ 文本预处理                                                    │
│     stripMarkdown → summarize/truncate                           │
│         ↓                                                        │
│  ④ 多引擎合成 textToSpeech()                                    │
│     ┌──────────┐  ┌───────────┐  ┌──────────┐                   │
│     │  OpenAI   │→│ ElevenLabs │→│ Edge TTS  │  (fallback chain) │
│     └──────────┘  └───────────┘  └──────────┘                   │
│         ↓                                                        │
│  ⑤ 渠道适配                                                     │
│     Telegram: opus → voice bubble                                │
│     Discord:  ogg/opus + waveform + flag 8192                    │
│     Telephony: PCM → resample 8kHz → mu-law G.711               │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

关键组件关系：

- `tts.ts` — 高层 API，配置解析，偏好管理，自动 TTS 管道
- `tts-core.ts` — 底层引擎调用（ElevenLabs/OpenAI/Edge），指令解析，摘要
- `tts-tool.ts` — Agent 工具封装，返回 `MEDIA:path` 标记
- `commands-tts.ts` — `/tts` 斜杠命令处理
- `telephony-tts.ts` — 电话场景 TTS 适配（PCM → mu-law 转码）
- `voice-mapping.ts` — OpenAI 语音名到 Twilio Polly 的映射

### 2.2 核心实现

#### 2.2.1 多引擎降级链（`src/tts/tts.ts:532-700`）

`textToSpeech()` 是核心合成入口。它构建一个有序的引擎列表，逐个尝试直到成功：

```typescript
// src/tts/tts.ts:513-515
export function resolveTtsProviderOrder(primary: TtsProvider): TtsProvider[] {
  return [primary, ...TTS_PROVIDERS.filter((provider) => provider !== primary)];
}

// src/tts/tts.ts:556-694 — 核心降级循环
for (const provider of providers) {
  const providerStart = Date.now();
  try {
    if (provider === "edge") {
      // Edge TTS: 无需 API Key，通过 node-edge-tts 库调用微软 Edge 语音服务
      const tts = new EdgeTTS({ voice: config.voice, lang: config.lang, ... });
      await tts.ttsPromise(text, outputPath);
      return { success: true, audioPath, provider, ... };
    }
    const apiKey = resolveTtsApiKey(config, provider);
    if (!apiKey) { errors.push(`${provider}: no API key`); continue; }
    // OpenAI / ElevenLabs: 通过 HTTP API 调用
    audioBuffer = provider === "elevenlabs"
      ? await elevenLabsTTS({ text, apiKey, voiceId, modelId, voiceSettings, ... })
      : await openaiTTS({ text, apiKey, model, voice, responseFormat, ... });
    return { success: true, audioPath, provider, ... };
  } catch (err) {
    errors.push(formatTtsProviderError(provider, err));
  }
}
return { success: false, error: `TTS conversion failed: ${errors.join("; ")}` };
```

每个引擎都有独立的超时控制（`AbortController` + `setTimeout`），超时后自动跳到下一个引擎。

#### 2.2.2 LLM 内联指令解析（`src/tts/tts-core.ts:99-326`）

OpenClaw 允许 LLM 在输出中嵌入 TTS 控制指令，通过正则解析提取：

```typescript
// src/tts/tts-core.ts:112-119 — 文本块指令
const blockRegex = /\[\[tts:text\]\]([\s\S]*?)\[\[\/tts:text\]\]/gi;
cleanedText = cleanedText.replace(blockRegex, (_match, inner: string) => {
  hasDirective = true;
  if (policy.allowText && overrides.ttsText == null) {
    overrides.ttsText = inner.trim();  // 用指定文本替代原文进行 TTS
  }
  return "";  // 从可见文本中移除指令
});

// src/tts/tts-core.ts:121-317 — 参数指令
const directiveRegex = /\[\[tts:([^\]]+)\]\]/gi;
// 支持: provider, voice, voiceId, model, stability, similarityBoost,
//        style, speed, speakerBoost, normalize, language, seed
```

关键设计：指令解析受 `ResolvedTtsModelOverrides` 策略控制，每个参数类别（provider/voice/model/voiceSettings/normalization/seed）都有独立的 allow 开关，管理员可精细控制 LLM 的覆盖权限（`src/tts/tts.ts:225-253`）。

#### 2.2.3 渠道感知输出格式（`src/tts/tts.ts:67-86`）

不同渠道对音频格式有严格要求，OpenClaw 通过预定义的输出配置解决：

```typescript
// src/tts/tts.ts:67-86
const TELEGRAM_OUTPUT = {
  openai: "opus" as const,
  elevenlabs: "opus_48000_64",  // Opus @ 48kHz/64kbps
  extension: ".opus",
  voiceCompatible: true,  // 标记为语音条兼容
};

const DEFAULT_OUTPUT = {
  openai: "mp3" as const,
  elevenlabs: "mp3_44100_128",
  extension: ".mp3",
  voiceCompatible: false,
};

const TELEPHONY_OUTPUT = {
  openai: { format: "pcm" as const, sampleRate: 24000 },
  elevenlabs: { format: "pcm_22050", sampleRate: 22050 },
};
```

电话场景还需要额外的音频转码（`extensions/voice-call/src/telephony-audio.ts:54-57`）：

```typescript
// PCM → 8kHz 重采样 → mu-law G.711 编码
export function convertPcmToMulaw8k(pcm: Buffer, inputSampleRate: number): Buffer {
  const pcm8k = resamplePcmTo8k(pcm, inputSampleRate);  // 线性插值降采样
  return pcmToMulaw(pcm8k);  // G.711 mu-law 编码
}
```

#### 2.2.4 自动 TTS 管道（`src/tts/tts.ts:791-934`）

`maybeApplyTtsToPayload()` 是自动 TTS 的入口，将 Agent 回复自动转为语音：

```typescript
// src/tts/tts.ts:791-934 — 自动 TTS 管道（简化）
export async function maybeApplyTtsToPayload(params) {
  // 1. 解析 auto mode: off/always/inbound/tagged
  const autoMode = resolveTtsAutoMode({ config, prefsPath, sessionAuto });
  if (autoMode === "off") return params.payload;

  // 2. 解析 LLM 内联指令
  const directives = parseTtsDirectives(text, config.modelOverrides);

  // 3. tagged 模式：仅当 LLM 输出包含 [[tts]] 指令时触发
  if (autoMode === "tagged" && !directives.hasDirective) return nextPayload;
  // inbound 模式：仅当用户发送了语音消息时触发
  if (autoMode === "inbound" && params.inboundAudio !== true) return nextPayload;

  // 4. 长文本处理：摘要 → 截断 → stripMarkdown
  if (textForAudio.length > maxLength) {
    if (isSummarizationEnabled(prefsPath)) {
      const summary = await summarizeText({ text, targetLength: maxLength, ... });
      textForAudio = summary.summary;
    } else {
      textForAudio = `${textForAudio.slice(0, maxLength - 3)}...`;
    }
  }
  textForAudio = stripMarkdown(textForAudio).trim();

  // 5. 调用 TTS 引擎
  const result = await textToSpeech({ text: textForAudio, cfg, channel, overrides });

  // 6. 附加音频到 payload
  return { ...nextPayload, mediaUrl: result.audioPath, audioAsVoice: shouldVoice };
}
```

### 2.3 实现细节

#### 语音唤醒（Voice Wake）

OpenClaw 支持语音唤醒词检测（`src/infra/voicewake.ts`），默认触发词为 `["openclaw", "claude", "computer"]`。配置通过 JSON 文件持久化，支持 Gateway RPC 动态修改（`src/gateway/server-methods/voicewake.ts`）。唤醒词变更时通过 `broadcastVoiceWakeChanged()` 广播到所有连接的客户端。

#### 音频转录前置（Audio Preflight）

`src/media-understanding/audio-preflight.ts:20-100` 实现了一个关键优化：在群聊的 mention 检查之前先转录语音消息。这解决了"群聊中用户发语音但 bot 因为没检测到 @mention 而忽略"的问题。转录后标记 `alreadyTranscribed = true` 避免重复处理。

#### Discord 语音消息协议

`src/discord/voice-message.ts:230-323` 实现了 Discord 语音消息的完整发送流程：
1. 请求上传 URL（`POST /channels/{id}/attachments`）
2. 上传 OGG/Opus 文件到 Discord CDN
3. 发送消息（flag `8192` = IS_VOICE_MESSAGE），附带波形数据和时长

波形数据通过 ffmpeg 提取 PCM → 采样 256 个振幅点 → base64 编码（`src/discord/voice-message.ts:75-131`）。

#### OpenAI 语音到 Twilio Polly 映射

`extensions/voice-call/src/voice-mapping.ts:20-27` 维护了 OpenAI 语音名到 Twilio Polly 等价语音的映射表，用于电话场景的 TwiML 生成：

```typescript
const OPENAI_TO_POLLY_MAP: Record<string, string> = {
  alloy: "Polly.Joanna",   // neutral, warm
  echo: "Polly.Matthew",   // male, warm
  fable: "Polly.Amy",      // British, expressive
  onyx: "Polly.Brian",     // deep male
  nova: "Polly.Salli",     // female, friendly
  shimmer: "Polly.Kimberly", // female, clear
};
```

---

## 第 3 章 迁移指南

### 3.1 迁移清单

**阶段 1：核心 TTS 引擎抽象（1-2 天）**

- [ ] 定义 `TtsProvider` 接口：`synthesize(text, options) → Buffer`
- [ ] 实现 OpenAI TTS provider（`fetch` 调用 `/v1/audio/speech`）
- [ ] 实现 Edge TTS provider（`node-edge-tts` 库，零成本）
- [ ] 实现 ElevenLabs provider（可选，需 API Key）
- [ ] 实现降级链：`resolveTtsProviderOrder()` + for 循环 try/catch

**阶段 2：配置与偏好系统**

- [ ] 定义 `TtsConfig` 类型（provider/auto/mode/maxTextLength/timeoutMs）
- [ ] 实现 `resolveTtsConfig()` 从全局配置解析
- [ ] 实现用户偏好 JSON 持久化（原子写入）
- [ ] 实现四层配置优先级：config → prefs → session → LLM 指令

**阶段 3：渠道适配**

- [ ] 定义渠道输出格式映射（Telegram: opus, Discord: ogg/opus, 默认: mp3）
- [ ] 实现 Telegram 语音兼容性检测（MIME + 扩展名）
- [ ] 实现 Discord 语音消息协议（上传 + flag 8192 + 波形）
- [ ] 实现电话 PCM → mu-law 转码（可选）

**阶段 4：自动 TTS 管道**

- [ ] 实现 `maybeApplyTtsToPayload()` 自动管道
- [ ] 实现 4 种 auto mode（off/always/inbound/tagged）
- [ ] 实现 LLM 指令解析（`[[tts:...]]` 正则）
- [ ] 实现长文本摘要/截断降级

### 3.2 适配代码模板

以下是一个可直接运行的多引擎 TTS 降级链实现：

```typescript
// tts-provider.ts — 可复用的多引擎 TTS 降级链
import { EdgeTTS } from "node-edge-tts";

type TtsProvider = "openai" | "elevenlabs" | "edge";
type TtsResult = { success: boolean; audioBuffer?: Buffer; provider?: string; error?: string };

const PROVIDER_ORDER: TtsProvider[] = ["openai", "elevenlabs", "edge"];

export function buildProviderOrder(primary: TtsProvider): TtsProvider[] {
  return [primary, ...PROVIDER_ORDER.filter((p) => p !== primary)];
}

export async function synthesize(text: string, primary: TtsProvider): Promise<TtsResult> {
  const providers = buildProviderOrder(primary);
  const errors: string[] = [];

  for (const provider of providers) {
    try {
      const buffer = await callProvider(provider, text);
      return { success: true, audioBuffer: buffer, provider };
    } catch (err) {
      errors.push(`${provider}: ${(err as Error).message}`);
    }
  }
  return { success: false, error: errors.join("; ") };
}

async function callProvider(provider: TtsProvider, text: string): Promise<Buffer> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  try {
    if (provider === "edge") {
      const tts = new EdgeTTS({ voice: "en-US-MichelleNeural" });
      // Edge TTS 写文件，需要临时路径
      const tmpPath = `/tmp/tts-${Date.now()}.mp3`;
      await tts.ttsPromise(text, tmpPath);
      return require("fs").readFileSync(tmpPath);
    }
    if (provider === "openai") {
      const res = await fetch("https://api.openai.com/v1/audio/speech", {
        method: "POST",
        headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: "gpt-4o-mini-tts", input: text, voice: "alloy", response_format: "mp3" }),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`OpenAI TTS error (${res.status})`);
      return Buffer.from(await res.arrayBuffer());
    }
    throw new Error("Provider not implemented");
  } finally {
    clearTimeout(timeout);
  }
}
```

### 3.3 适用场景

| 场景 | 适用度 | 说明 |
|------|--------|------|
| 多渠道聊天 Bot（Telegram + Discord） | ⭐⭐⭐ | 完整的渠道适配和语音格式处理 |
| 电话/语音通话 Agent | ⭐⭐⭐ | 内置 PCM → mu-law 转码和 Twilio 集成 |
| 单渠道 TTS（仅 Web） | ⭐⭐ | 架构偏重，可简化为单引擎 |
| 实时流式 TTS | ⭐ | 当前为批量合成，不支持流式输出 |
| 离线/本地 TTS | ⭐⭐ | 支持 Sherpa ONNX 本地引擎，但集成较浅 |

---

## 第 4 章 测试用例

基于 OpenClaw 真实函数签名编写的测试代码：

```typescript
import { describe, it, expect, vi } from "vitest";
import {
  parseTtsDirectives,
  isValidVoiceId,
  isValidOpenAIVoice,
  isValidOpenAIModel,
  OPENAI_TTS_VOICES,
} from "./tts-core";
import {
  resolveTtsConfig,
  resolveTtsProviderOrder,
  normalizeTtsAutoMode,
  isTtsEnabled,
} from "./tts";

describe("parseTtsDirectives", () => {
  const enabledPolicy = {
    enabled: true, allowText: true, allowProvider: true,
    allowVoice: true, allowModelId: true, allowVoiceSettings: true,
    allowNormalization: true, allowSeed: true,
  };

  it("正常路径：解析 voice 指令", () => {
    const result = parseTtsDirectives("Hello [[tts:voice=nova]] world", enabledPolicy);
    expect(result.overrides.openai?.voice).toBe("nova");
    expect(result.cleanedText.trim()).toBe("Hello  world");
    expect(result.hasDirective).toBe(true);
  });

  it("正常路径：解析 tts:text 块指令", () => {
    const result = parseTtsDirectives(
      "Code: `x=1` [[tts:text]]x equals one[[/tts:text]]",
      enabledPolicy,
    );
    expect(result.overrides.ttsText).toBe("x equals one");
    expect(result.cleanedText).not.toContain("[[tts:text]]");
  });

  it("边界情况：policy 禁用时忽略指令", () => {
    const disabledPolicy = { ...enabledPolicy, enabled: false };
    const result = parseTtsDirectives("[[tts:voice=nova]]", disabledPolicy);
    expect(result.overrides).toEqual({});
    expect(result.hasDirective).toBe(false);
  });

  it("边界情况：无效 voice 产生 warning", () => {
    const result = parseTtsDirectives("[[tts:voice=invalid_voice_xyz]]", enabledPolicy);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it("降级行为：多参数同时解析", () => {
    const result = parseTtsDirectives(
      "[[tts:provider=openai voice=echo model=tts-1-hd speed=1.5]]",
      enabledPolicy,
    );
    expect(result.overrides.provider).toBe("openai");
    expect(result.overrides.openai?.voice).toBe("echo");
    expect(result.overrides.elevenlabs?.voiceSettings?.speed).toBe(1.5);
  });
});

describe("resolveTtsProviderOrder", () => {
  it("primary 排在第一位", () => {
    expect(resolveTtsProviderOrder("elevenlabs")).toEqual(["elevenlabs", "openai", "edge"]);
  });

  it("edge 作为 primary 时其他引擎作为 fallback", () => {
    expect(resolveTtsProviderOrder("edge")).toEqual(["edge", "openai", "elevenlabs"]);
  });
});

describe("normalizeTtsAutoMode", () => {
  it("合法值正常解析", () => {
    expect(normalizeTtsAutoMode("always")).toBe("always");
    expect(normalizeTtsAutoMode("INBOUND")).toBe("inbound");
    expect(normalizeTtsAutoMode(" tagged ")).toBe("tagged");
  });

  it("非法值返回 undefined", () => {
    expect(normalizeTtsAutoMode("invalid")).toBeUndefined();
    expect(normalizeTtsAutoMode(123)).toBeUndefined();
  });
});

describe("isValidVoiceId", () => {
  it("合法 ElevenLabs voiceId", () => {
    expect(isValidVoiceId("pMsXgVXv3BLzUgSXRplE")).toBe(true);
  });
  it("拒绝过短 ID", () => {
    expect(isValidVoiceId("short")).toBe(false);
  });
});
```

---

<!-- APPEND_MARKER_CH5 -->
