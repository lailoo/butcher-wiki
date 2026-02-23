# PD-19.01 Nanobot — 9 渠道统一适配器 + 异步消息总线

> 文档编号：PD-19.01
> 来源：Nanobot `nanobot/channels/`, `nanobot/bus/`
> GitHub：https://github.com/HKUDS/nanobot.git
> 问题域：PD-19 多渠道消息适配 Multi-Channel Messaging
> 状态：可复用方案

---

## 第 1 章 问题与动机

### 1.1 核心问题

Agent 应用需要同时接入多个聊天平台（Telegram、Discord、Slack、WhatsApp、飞书、钉钉、QQ、Email、Mochat），但每个平台的 API 协议差异巨大：

- **连接方式不同**：Telegram 用 HTTP 长轮询，Discord/飞书/QQ/钉钉用 WebSocket，WhatsApp 通过 Node.js Bridge WebSocket 中转，Slack 用 Socket Mode，Email 用 IMAP 轮询 + SMTP 发送，Mochat 用 Socket.IO + HTTP 轮询降级
- **消息格式不同**：Telegram 支持 HTML 富文本，Slack 用 mrkdwn，飞书用 Interactive Card JSON，Discord 有 2000 字符限制，Email 是 MIME 格式
- **认证方式不同**：Bot Token、App ID + Secret、OAuth2 Access Token、IMAP/SMTP 账密、WebSocket Auth Token
- **媒体处理不同**：各平台上传/下载 API 完全不同，文件大小限制各异

如果 Agent 核心直接耦合任何一个平台 API，添加新渠道就需要修改核心逻辑，违反开闭原则。

### 1.2 Nanobot 的解法概述

Nanobot 采用 **ABC 适配器 + 异步消息总线** 的经典解耦架构：

1. **BaseChannel ABC** (`nanobot/channels/base.py:12`) — 定义 `start/stop/send` 三个抽象方法 + `_handle_message` 模板方法 + `is_allowed` 权限检查
2. **MessageBus** (`nanobot/bus/queue.py:8`) — 双向 asyncio.Queue，`publish_inbound` / `publish_outbound` 完全解耦渠道与 Agent
3. **InboundMessage / OutboundMessage** (`nanobot/bus/events.py:9-36`) — 统一消息数据结构，`session_key` 属性实现会话隔离
4. **ChannelManager** (`nanobot/channels/manager.py:16`) — 配置驱动的渠道生命周期管理，延迟导入 + 并行启动 + 出站消息分发
5. **9 个具体适配器** — 每个独立文件，各自处理平台特有的连接、消息解析、格式转换、媒体上传下载

### 1.3 设计思想

| 设计原则 | 具体实现 | 理由 | 替代方案 |
|----------|----------|------|----------|
| 适配器模式 | BaseChannel ABC + 9 个子类 | 新增渠道只需实现 3 个方法，零侵入 | 策略模式（更灵活但更复杂） |
| 消息总线解耦 | asyncio.Queue 双向队列 | Agent 核心完全不知道渠道存在 | 事件发布/订阅（更重但更灵活） |
| 延迟导入 | `_init_channels` 中 try/import | 缺少某平台 SDK 不影响其他渠道 | 全量导入（启动失败风险高） |
| 配置驱动 | Pydantic BaseSettings + camelCase 别名 | YAML/ENV 统一配置，`enabled` 开关 | 硬编码（不灵活） |
| 模板方法 | `_handle_message` 统一权限检查 + 消息构造 | 子类只需调用，不重复权限逻辑 | 每个子类自行检查（易遗漏） |

---

## 第 2 章 源码实现分析

### 2.1 架构概览

```
┌─────────────────────────────────────────────────────────────────┐
│                        ChannelManager                           │
│  _init_channels() → 按 config.enabled 延迟导入 + 实例化          │
│  start_all()      → asyncio.gather 并行启动所有渠道              │
│  _dispatch_outbound() → 消费 outbound 队列 → 路由到目标渠道       │
└──────────┬──────────────────────────────────────┬───────────────┘
           │                                      │
    ┌──────▼──────┐                        ┌──────▼──────┐
    │  Inbound    │                        │  Outbound   │
    │  Queue      │                        │  Queue      │
    │ (asyncio.Q) │                        │ (asyncio.Q) │
    └──────┬──────┘                        └──────▲──────┘
           │ publish_inbound                      │ publish_outbound
           │                                      │
    ┌──────▼──────────────────────────────────────┴──────┐
    │                   MessageBus                        │
    │  inbound: asyncio.Queue[InboundMessage]             │
    │  outbound: asyncio.Queue[OutboundMessage]           │
    └──────┬──────────────────────────────────────▲──────┘
           │ consume_inbound                      │ publish_outbound
           │                                      │
    ┌──────▼──────────────────────────────────────┴──────┐
    │                   AgentLoop                         │
    │  consume_inbound → _process_message → LLM 调用      │
    │  → publish_outbound 回写响应                         │
    └───────────────────────────────────────────────────┘

渠道层（9 个适配器）：
┌──────────┬──────────┬──────────┬──────────┬──────────┐
│ Telegram │ WhatsApp │ Discord  │  Feishu  │  Slack   │
│ 长轮询    │ WS Bridge│ Gateway  │ WS长连接  │ Socket   │
│          │ (Node.js)│ WS       │ (lark SDK)│ Mode    │
├──────────┼──────────┼──────────┼──────────┼──────────┤
│ DingTalk │   QQ     │  Email   │  Mochat  │          │
│ Stream   │ botpy SDK│ IMAP/SMTP│ Socket.IO│          │
│ Mode     │ WS       │ 轮询     │ +降级轮询 │          │
└──────────┴──────────┴──────────┴──────────┴──────────┘
```

### 2.2 核心实现

#### 2.2.1 BaseChannel — 适配器基类 (`nanobot/channels/base.py:12-128`)

```python
class BaseChannel(ABC):
    name: str = "base"

    def __init__(self, config: Any, bus: MessageBus):
        self.config = config
        self.bus = bus
        self._running = False

    @abstractmethod
    async def start(self) -> None: ...

    @abstractmethod
    async def stop(self) -> None: ...

    @abstractmethod
    async def send(self, msg: OutboundMessage) -> None: ...

    def is_allowed(self, sender_id: str) -> bool:
        allow_list = getattr(self.config, "allow_from", [])
        if not allow_list:
            return True
        sender_str = str(sender_id)
        if sender_str in allow_list:
            return True
        # 支持复合 ID（如 Telegram 的 "user_id|username"）
        if "|" in sender_str:
            for part in sender_str.split("|"):
                if part and part in allow_list:
                    return True
        return False

    async def _handle_message(
        self, sender_id: str, chat_id: str, content: str,
        media: list[str] | None = None, metadata: dict[str, Any] | None = None
    ) -> None:
        if not self.is_allowed(sender_id):
            logger.warning("Access denied for sender {} on channel {}", sender_id, self.name)
            return
        msg = InboundMessage(
            channel=self.name, sender_id=str(sender_id), chat_id=str(chat_id),
            content=content, media=media or [], metadata=metadata or {}
        )
        await self.bus.publish_inbound(msg)
```

关键设计点：
- `_handle_message` 是模板方法，统一执行权限检查后发布到总线（`base.py:86-123`）
- `is_allowed` 支持复合 ID 匹配（`base.py:61-84`），Telegram 的 `sender_id` 格式为 `"user_id|username"`，允许按任一部分匹配
- 子类只需在收到平台消息后调用 `await self._handle_message(...)`，无需关心权限和总线逻辑

#### 2.2.2 MessageBus — 异步双向队列 (`nanobot/bus/queue.py:8-44`)

```python
class MessageBus:
    def __init__(self):
        self.inbound: asyncio.Queue[InboundMessage] = asyncio.Queue()
        self.outbound: asyncio.Queue[OutboundMessage] = asyncio.Queue()

    async def publish_inbound(self, msg: InboundMessage) -> None:
        await self.inbound.put(msg)

    async def consume_inbound(self) -> InboundMessage:
        return await self.inbound.get()

    async def publish_outbound(self, msg: OutboundMessage) -> None:
        await self.outbound.put(msg)

    async def consume_outbound(self) -> OutboundMessage:
        return await self.outbound.get()
```

极简设计：两个无界 `asyncio.Queue`，零依赖。Agent 侧 `consume_inbound` 阻塞等待，渠道侧 `publish_inbound` 非阻塞投递。

#### 2.2.3 统一消息模型 (`nanobot/bus/events.py:9-36`)

```python
@dataclass
class InboundMessage:
    channel: str          # "telegram", "discord", "slack", ...
    sender_id: str        # 用户标识
    chat_id: str          # 会话标识
    content: str          # 消息文本
    timestamp: datetime = field(default_factory=datetime.now)
    media: list[str] = field(default_factory=list)      # 本地媒体文件路径
    metadata: dict[str, Any] = field(default_factory=dict)  # 渠道特有数据

    @property
    def session_key(self) -> str:
        return f"{self.channel}:{self.chat_id}"  # 跨渠道会话隔离
```

`session_key` 属性（`events.py:21-23`）通过 `channel:chat_id` 组合实现跨渠道会话隔离，Agent 用此 key 管理独立对话上下文。

#### 2.2.4 ChannelManager — 生命周期管理 (`nanobot/channels/manager.py:16-233`)

核心机制：

1. **延迟导入**（`manager.py:37-138`）：每个渠道在 `if config.xxx.enabled` 块内 `try: from ... import` ，缺少 SDK 只 warning 不崩溃
2. **并行启动**（`manager.py:147-163`）：`asyncio.gather(*tasks)` 并行启动所有渠道
3. **出站分发**（`manager.py:185-214`）：独立 `_dispatch_outbound` 协程消费 outbound 队列，按 `msg.channel` 路由到对应渠道的 `send()` 方法
4. **进度消息过滤**（`manager.py:196-200`）：通过 `_progress` 和 `_tool_hint` metadata 标记，配合 `send_progress` / `send_tool_hints` 配置控制是否转发中间状态

### 2.3 实现细节 — 各渠道适配策略

| 渠道 | 连接方式 | 消息格式转换 | 媒体处理 | 特殊机制 |
|------|----------|-------------|----------|----------|
| Telegram | HTTP 长轮询 (`python-telegram-bot`) | Markdown→HTML (`_markdown_to_telegram_html`) | 下载到 `~/.nanobot/media/`，语音用 Groq 转写 | 打字指示器循环、消息分片(4000字) |
| WhatsApp | WebSocket→Node.js Bridge (`baileys`) | 纯文本 JSON | Bridge 端处理 | 自动重连(5s)、QR 码认证 |
| Discord | Gateway WebSocket (原生实现) | 纯文本 | httpx 下载附件(≤20MB) | 心跳、IDENTIFY、速率限制重试(3次)、打字指示器 |
| Feishu | WebSocket 长连接 (`lark-oapi` SDK) | Markdown→Interactive Card (表格/标题解析) | SDK 上传图片/文件 | 消息去重(OrderedDict 1000条)、Emoji 反应、线程安全(`run_coroutine_threadsafe`) |
| Slack | Socket Mode (`slack-sdk`) | Markdown→mrkdwn (`slackify_markdown`) | `files_upload_v2` | @mention 去重、DM/群组分策略、线程回复、Emoji 反应 |
| DingTalk | Stream Mode (`dingtalk-stream` SDK) | Markdown | HTTP API 批量发送 | OAuth2 Token 自动刷新(提前60s)、`background_tasks` 防 GC |
| QQ | WebSocket (`botpy` SDK) | 纯文本 | 不支持 | 消息去重(deque 1000条)、动态 Client 子类生成 |
| Email | IMAP 轮询 + SMTP 发送 | 纯文本/HTML→文本 | 不支持 | `consent_granted` 显式授权、UID 去重(10万上限)、`In-Reply-To` 线程关联 |
| Mochat | Socket.IO + HTTP 轮询降级 | 纯文本 | 不支持 | 游标持久化、延迟合并发送、@mention 检测、自动发现 session/panel |

---

## 第 3 章 迁移指南

### 3.1 迁移清单

**阶段 1：核心框架（必须）**

- [ ] 创建 `bus/events.py` — 定义 InboundMessage / OutboundMessage dataclass
- [ ] 创建 `bus/queue.py` — 实现 MessageBus（双向 asyncio.Queue）
- [ ] 创建 `channels/base.py` — 实现 BaseChannel ABC（start/stop/send + _handle_message + is_allowed）
- [ ] 创建 `channels/manager.py` — 实现 ChannelManager（配置驱动初始化 + 并行启动 + 出站分发）
- [ ] 在 Agent 主循环中集成 `bus.consume_inbound()` 和 `bus.publish_outbound()`

**阶段 2：首个渠道适配器**

- [ ] 选择一个目标平台实现具体 Channel 子类
- [ ] 实现 `start()`（连接 + 监听）、`stop()`（清理）、`send()`（发送）
- [ ] 在 `_on_message` 回调中调用 `self._handle_message(...)` 转发到总线

**阶段 3：扩展渠道**

- [ ] 每个新渠道一个独立文件，继承 BaseChannel
- [ ] 在 ChannelManager._init_channels 中添加延迟导入块
- [ ] 在配置 schema 中添加对应 XxxConfig

### 3.2 适配代码模板

以下是可直接复用的最小框架：

```python
# bus/events.py
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any

@dataclass
class InboundMessage:
    channel: str
    sender_id: str
    chat_id: str
    content: str
    timestamp: datetime = field(default_factory=datetime.now)
    media: list[str] = field(default_factory=list)
    metadata: dict[str, Any] = field(default_factory=dict)

    @property
    def session_key(self) -> str:
        return f"{self.channel}:{self.chat_id}"

@dataclass
class OutboundMessage:
    channel: str
    chat_id: str
    content: str
    reply_to: str | None = None
    media: list[str] = field(default_factory=list)
    metadata: dict[str, Any] = field(default_factory=dict)
```

```python
# bus/queue.py
import asyncio
from bus.events import InboundMessage, OutboundMessage

class MessageBus:
    def __init__(self):
        self.inbound: asyncio.Queue[InboundMessage] = asyncio.Queue()
        self.outbound: asyncio.Queue[OutboundMessage] = asyncio.Queue()

    async def publish_inbound(self, msg: InboundMessage) -> None:
        await self.inbound.put(msg)

    async def consume_inbound(self) -> InboundMessage:
        return await self.inbound.get()

    async def publish_outbound(self, msg: OutboundMessage) -> None:
        await self.outbound.put(msg)

    async def consume_outbound(self) -> OutboundMessage:
        return await self.outbound.get()
```

```python
# channels/base.py
from abc import ABC, abstractmethod
from typing import Any
from bus.events import InboundMessage, OutboundMessage
from bus.queue import MessageBus

class BaseChannel(ABC):
    name: str = "base"

    def __init__(self, config: Any, bus: MessageBus):
        self.config = config
        self.bus = bus
        self._running = False

    @abstractmethod
    async def start(self) -> None: ...

    @abstractmethod
    async def stop(self) -> None: ...

    @abstractmethod
    async def send(self, msg: OutboundMessage) -> None: ...

    def is_allowed(self, sender_id: str) -> bool:
        allow_list = getattr(self.config, "allow_from", [])
        if not allow_list:
            return True
        return str(sender_id) in allow_list

    async def _handle_message(
        self, sender_id: str, chat_id: str, content: str,
        media: list[str] | None = None, metadata: dict[str, Any] | None = None
    ) -> None:
        if not self.is_allowed(sender_id):
            return
        msg = InboundMessage(
            channel=self.name, sender_id=str(sender_id),
            chat_id=str(chat_id), content=content,
            media=media or [], metadata=metadata or {}
        )
        await self.bus.publish_inbound(msg)

    @property
    def is_running(self) -> bool:
        return self._running
```

### 3.3 适用场景

| 场景 | 适用度 | 说明 |
|------|--------|------|
| 多平台聊天机器人 | ⭐⭐⭐ | 核心场景，直接复用 |
| Agent 应用接入 IM | ⭐⭐⭐ | BaseChannel + MessageBus 完美匹配 |
| 单平台 Bot | ⭐⭐ | 框架略重，但利于未来扩展 |
| 高吞吐消息系统 | ⭐ | asyncio.Queue 无持久化，需替换为 Redis/Kafka |
| 需要消息持久化 | ⭐ | 当前设计无消息落盘，需自行扩展 |

---

## 第 4 章 测试用例

```python
import asyncio
import pytest
from dataclasses import dataclass, field
from typing import Any

# 复用上方模板中的 InboundMessage, OutboundMessage, MessageBus, BaseChannel

@dataclass
class MockConfig:
    enabled: bool = True
    allow_from: list[str] = field(default_factory=list)

class MockChannel(BaseChannel):
    """测试用 Channel 实现"""
    name = "mock"

    def __init__(self, config, bus):
        super().__init__(config, bus)
        self.sent_messages: list[OutboundMessage] = []

    async def start(self) -> None:
        self._running = True

    async def stop(self) -> None:
        self._running = False

    async def send(self, msg: OutboundMessage) -> None:
        self.sent_messages.append(msg)


class TestMessageBus:
    """MessageBus 核心功能测试"""

    @pytest.mark.asyncio
    async def test_inbound_publish_consume(self):
        bus = MessageBus()
        msg = InboundMessage(channel="test", sender_id="u1", chat_id="c1", content="hello")
        await bus.publish_inbound(msg)
        result = await bus.consume_inbound()
        assert result.content == "hello"
        assert result.session_key == "test:c1"

    @pytest.mark.asyncio
    async def test_outbound_publish_consume(self):
        bus = MessageBus()
        msg = OutboundMessage(channel="test", chat_id="c1", content="reply")
        await bus.publish_outbound(msg)
        result = await bus.consume_outbound()
        assert result.content == "reply"

    @pytest.mark.asyncio
    async def test_queue_ordering(self):
        bus = MessageBus()
        for i in range(5):
            await bus.publish_inbound(
                InboundMessage(channel="test", sender_id="u1", chat_id="c1", content=f"msg-{i}")
            )
        for i in range(5):
            msg = await bus.consume_inbound()
            assert msg.content == f"msg-{i}"


class TestBaseChannel:
    """BaseChannel 权限与消息转发测试"""

    @pytest.mark.asyncio
    async def test_allowed_sender_publishes(self):
        bus = MessageBus()
        config = MockConfig(allow_from=["user123"])
        channel = MockChannel(config, bus)
        await channel._handle_message(sender_id="user123", chat_id="chat1", content="hi")
        assert bus.inbound.qsize() == 1

    @pytest.mark.asyncio
    async def test_denied_sender_blocked(self):
        bus = MessageBus()
        config = MockConfig(allow_from=["user123"])
        channel = MockChannel(config, bus)
        await channel._handle_message(sender_id="hacker", chat_id="chat1", content="hi")
        assert bus.inbound.qsize() == 0

    @pytest.mark.asyncio
    async def test_empty_allowlist_allows_all(self):
        bus = MessageBus()
        config = MockConfig(allow_from=[])
        channel = MockChannel(config, bus)
        await channel._handle_message(sender_id="anyone", chat_id="chat1", content="hi")
        assert bus.inbound.qsize() == 1

    @pytest.mark.asyncio
    async def test_composite_sender_id(self):
        """Telegram 风格的复合 ID: 'user_id|username'"""
        bus = MessageBus()
        config = MockConfig(allow_from=["alice"])
        channel = MockChannel(config, bus)
        # Nanobot 的 is_allowed 支持 | 分隔匹配
        # 这里测试基础模板的简化版本
        await channel._handle_message(sender_id="alice", chat_id="chat1", content="hi")
        assert bus.inbound.qsize() == 1

    @pytest.mark.asyncio
    async def test_session_key_isolation(self):
        """不同渠道的相同 chat_id 产生不同 session_key"""
        msg1 = InboundMessage(channel="telegram", sender_id="u1", chat_id="123", content="a")
        msg2 = InboundMessage(channel="discord", sender_id="u1", chat_id="123", content="b")
        assert msg1.session_key != msg2.session_key
        assert msg1.session_key == "telegram:123"
        assert msg2.session_key == "discord:123"
```

---

## 第 5 章 跨域关联

| 关联域 | 关系类型 | 说明 |
|--------|----------|------|
| PD-01 上下文管理 | 协同 | `session_key` 用于隔离不同渠道的对话上下文窗口 |
| PD-04 工具系统 | 协同 | Agent 的 MessageTool 通过 `bus.publish_outbound` 发送消息，工具系统与渠道通过总线解耦 |
| PD-06 记忆持久化 | 协同 | 记忆系统按 `session_key` 存储对话历史，渠道层提供 key |
| PD-09 Human-in-the-Loop | 依赖 | 人类审批/澄清消息通过渠道层收发，依赖 InboundMessage/OutboundMessage 流转 |
| PD-03 容错与重试 | 协同 | 各渠道自带重连机制（WhatsApp/Discord/Feishu/DingTalk/QQ 均有 5s 重连循环），Mochat 有 WebSocket→HTTP 轮询降级 |

---

## 第 6 章 来源文件索引

| 文件 | 行范围 | 关键实现 |
|------|--------|----------|
| `nanobot/channels/base.py` | L12-128 | BaseChannel ABC：start/stop/send 抽象方法 + _handle_message 模板方法 + is_allowed 权限检查 |
| `nanobot/bus/queue.py` | L8-44 | MessageBus：双向 asyncio.Queue 实现 |
| `nanobot/bus/events.py` | L9-36 | InboundMessage / OutboundMessage dataclass + session_key |
| `nanobot/channels/manager.py` | L16-233 | ChannelManager：延迟导入、并行启动、出站分发、进度过滤 |
| `nanobot/channels/telegram.py` | L101-458 | TelegramChannel：长轮询、Markdown→HTML、媒体下载、语音转写、打字指示器 |
| `nanobot/channels/whatsapp.py` | L15-149 | WhatsAppChannel：Node.js Bridge WebSocket、自动重连、QR 认证 |
| `nanobot/channels/discord.py` | L45-299 | DiscordChannel：Gateway WebSocket、心跳、IDENTIFY、速率限制重试 |
| `nanobot/channels/feishu.py` | L230-734 | FeishuChannel：WebSocket 长连接、Interactive Card、消息去重、线程安全 |
| `nanobot/channels/slack.py` | L21-253 | SlackChannel：Socket Mode、mrkdwn 转换、DM/群组分策略、@mention 处理 |
| `nanobot/channels/dingtalk.py` | L87-248 | DingTalkChannel：Stream Mode、OAuth2 Token 刷新、HTTP API 发送 |
| `nanobot/channels/qq.py` | L48-133 | QQChannel：botpy SDK、动态 Client 子类、消息去重 |
| `nanobot/channels/email.py` | L25-405 | EmailChannel：IMAP 轮询 + SMTP 发送、consent_granted、UID 去重 |
| `nanobot/channels/mochat.py` | L215-896 | MochatChannel：Socket.IO + HTTP 降级、游标持久化、延迟合并、@mention 检测 |
| `nanobot/config/schema.py` | L15-181 | 9 个渠道配置 Pydantic 模型 + ChannelsConfig 聚合 |
| `nanobot/agent/loop.py` | L239-261 | AgentLoop.run()：consume_inbound → process → publish_outbound 主循环 |

---

## 第 7 章 横向对比维度

```json comparison_data
{
  "project": "Nanobot",
  "dimensions": {
    "适配器基类": "ABC 定义 start/stop/send + _handle_message 模板方法 + is_allowed 权限检查",
    "消息总线": "双向 asyncio.Queue，零依赖，无持久化",
    "渠道数量": "9 个（Telegram/WhatsApp/Discord/Feishu/Slack/DingTalk/QQ/Email/Mochat）",
    "连接策略": "混合：长轮询/WebSocket/Socket Mode/IMAP，各渠道独立实现",
    "格式转换": "每渠道独立转换（Markdown→HTML/mrkdwn/Card JSON），无统一中间格式",
    "权限控制": "基类 allow_from 白名单 + Slack 分层策略（DM/群组/mention）",
    "容错机制": "各渠道自带重连循环(5s)，Mochat 有 WebSocket→HTTP 轮询降级",
    "消息去重": "Feishu OrderedDict/QQ deque/Mochat set，各渠道独立实现",
    "配置方式": "Pydantic BaseSettings + camelCase 别名，YAML/ENV 统一配置"
  }
}
```

### 域元数据补充

```json domain_metadata
{
  "description": "统一消息总线解耦渠道与 Agent 核心，支持混合连接协议和平台特有格式转换",
  "sub_problems": [
    "消息去重策略差异（OrderedDict vs deque vs set，各渠道独立实现）",
    "WebSocket 到 HTTP 轮询的自动降级与恢复",
    "跨线程事件桥接（飞书 SDK 回调在独立线程，需 run_coroutine_threadsafe）",
    "出站消息进度过滤（区分最终回复与中间状态推送）",
    "显式用户授权门控（Email 的 consent_granted 机制）"
  ],
  "best_practices": [
    "延迟导入渠道 SDK，缺少依赖只 warning 不崩溃，保证其他渠道正常运行",
    "模板方法统一权限检查，子类无需重复实现 ACL 逻辑",
    "出站分发协程独立运行，按 msg.channel 路由，支持进度消息过滤配置"
  ]
}
```
