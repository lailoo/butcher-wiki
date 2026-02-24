# PD-50.01 OpenManus — browser-use + Playwright 双模浏览器自动化

> 文档编号：PD-50.01
> 来源：OpenManus `app/agent/browser.py` `app/tool/browser_use_tool.py` `app/tool/sandbox/sb_browser_tool.py`
> GitHub：https://github.com/FoundationAgents/OpenManus.git
> 问题域：PD-50 浏览器自动化 Browser Automation
> 状态：可复用方案

---

## 第 1 章 问题与动机

### 1.1 核心问题

Agent 系统需要与真实网页交互——导航、点击、填表、提取内容——但浏览器是有状态的、异步的、视觉驱动的。核心挑战包括：

1. **状态同步**：LLM 无法"看到"浏览器，需要在每个决策步骤前将当前页面状态（URL、标签页、滚动位置、可交互元素）结构化注入 prompt
2. **视觉感知**：纯文本 DOM 不足以理解复杂页面布局，需要截图作为多模态输入
3. **生命周期管理**：浏览器实例的创建、复用、清理需要可靠的资源管理，避免泄漏
4. **环境隔离**：生产环境中浏览器操作需要在沙箱内执行，防止恶意页面影响宿主系统
5. **动作空间设计**：需要一个覆盖导航、交互、滚动、标签管理、内容提取的完整动作枚举

### 1.2 OpenManus 的解法概述

OpenManus 采用三层架构解决浏览器自动化问题：

1. **BrowserAgent**（`app/agent/browser.py:87`）：继承 ToolCallAgent 的专用浏览器 Agent，在每步 `think()` 前通过 BrowserContextHelper 获取浏览器状态并注入截图到 memory
2. **BrowserUseTool**（`app/tool/browser_use_tool.py:39`）：基于 browser-use 库 + Playwright 的本地浏览器工具，提供 16 种动作（导航、点击、输入、滚动、标签管理、内容提取等）
3. **SandboxBrowserTool**（`app/tool/sandbox/sb_browser_tool.py:36`）：基于 Daytona 沙箱的远程浏览器工具，通过 HTTP API + curl 与沙箱内浏览器通信，提供 15 种动作
4. **BrowserContextHelper**（`app/agent/browser.py:19`）：解耦的状态管理辅助类，负责获取浏览器状态、格式化 prompt、注入截图到 memory
5. **BrowserSettings**（`app/config.py:69`）：TOML 配置驱动的浏览器参数（headless、proxy、CDP/WSS 连接、内容长度限制）

### 1.3 设计思想

| 设计原则 | 具体实现 | 理由 | 替代方案 |
|----------|----------|------|----------|
| 状态-动作分离 | BrowserContextHelper 只负责状态获取，BrowserUseTool 只负责动作执行 | 单一职责，Agent 层编排两者 | 状态和动作耦合在同一个 Tool 中 |
| 截图即上下文 | 每步 think 前将 base64 截图作为 user_message 注入 memory | 多模态 LLM 可直接"看到"页面，比纯 DOM 文本更准确 | 只用 DOM 文本描述页面 |
| 双模运行 | 本地 BrowserUseTool（直接 Playwright）+ 沙箱 SandboxBrowserTool（HTTP API） | 开发用本地模式，生产用沙箱隔离 | 只支持一种模式 |
| 配置驱动 | BrowserSettings 从 TOML 读取 headless/proxy/CDP 等参数 | 不同环境不改代码 | 硬编码浏览器参数 |
| asyncio.Lock 保护 | BrowserUseTool.execute 用 `async with self.lock` 串行化操作 | 防止并发操作导致浏览器状态混乱 | 无锁并发（会导致竞态） |

---

## 第 2 章 源码实现分析

### 2.1 架构概览

OpenManus 的浏览器自动化采用三层架构，Agent 层编排状态获取和动作执行：

```
┌─────────────────────────────────────────────────────────┐
│                    BrowserAgent                          │
│  (继承 ToolCallAgent → ReActAgent → BaseAgent)           │
│                                                          │
│  think() ──→ BrowserContextHelper.format_next_step_prompt│
│     │            │                                       │
│     │            ├─ get_browser_state()                   │
│     │            │    └─ tool.get_current_state()         │
│     │            │         ├─ 获取 URL/Title/Tabs         │
│     │            │         ├─ 获取可交互元素树              │
│     │            │         ├─ 获取滚动位置(pixels_above/below)│
│     │            │         └─ 截取 JPEG 全页截图 → base64  │
│     │            │                                       │
│     │            └─ 注入截图到 memory (user_message)       │
│     │                                                    │
│     └──→ super().think() → LLM 决策                      │
│                                                          │
│  act() ──→ ToolCallAgent.act()                           │
│     └─ execute_tool() → BrowserUseTool.execute(action)   │
│                           或 SandboxBrowserTool.execute() │
└─────────────────────────────────────────────────────────┘
         │                              │
         ▼                              ▼
┌─────────────────┐          ┌──────────────────────┐
│  BrowserUseTool  │          │  SandboxBrowserTool   │
│  (本地 Playwright)│          │  (Daytona 沙箱 HTTP)  │
│                  │          │                       │
│  browser-use lib │          │  curl → localhost:8003│
│  + Playwright    │          │  /api/automation/*    │
│                  │          │                       │
│  16 种 actions   │          │  15 种 actions        │
│  asyncio.Lock    │          │  + click_coordinates  │
│  LLM 内容提取    │          │  + drag_drop          │
└─────────────────┘          └──────────────────────┘
```

### 2.2 核心实现

#### 2.2.1 BrowserAgent 的 think 覆写

BrowserAgent 覆写了 `think()` 方法，在调用父类 LLM 决策前先获取浏览器状态（`app/agent/browser.py:120-125`）：

```python
class BrowserAgent(ToolCallAgent):
    max_observe: int = 10000
    max_steps: int = 20
    available_tools: ToolCollection = Field(
        default_factory=lambda: ToolCollection(BrowserUseTool(), Terminate())
    )
    tool_choices: ToolChoice = ToolChoice.AUTO
    browser_context_helper: Optional[BrowserContextHelper] = None

    @model_validator(mode="after")
    def initialize_helper(self) -> "BrowserAgent":
        self.browser_context_helper = BrowserContextHelper(self)
        return self

    async def think(self) -> bool:
        self.next_step_prompt = (
            await self.browser_context_helper.format_next_step_prompt()
        )
        return await super().think()
```

关键点：`think()` 每次被调用时都会重新获取浏览器状态，确保 LLM 看到的是最新页面。`max_observe=10000` 限制工具输出长度，防止浏览器状态信息过长撑爆上下文。

#### 2.2.2 BrowserContextHelper 的截图注入机制

`BrowserContextHelper.format_next_step_prompt()`（`app/agent/browser.py:47-79`）是状态注入的核心：

```python
async def format_next_step_prompt(self) -> str:
    browser_state = await self.get_browser_state()
    url_info, tabs_info, content_above_info, content_below_info = "", "", "", ""

    if browser_state and not browser_state.get("error"):
        url_info = f"\n   URL: {browser_state.get('url', 'N/A')}\n   Title: {browser_state.get('title', 'N/A')}"
        tabs = browser_state.get("tabs", [])
        if tabs:
            tabs_info = f"\n   {len(tabs)} tab(s) available"
        pixels_above = browser_state.get("pixels_above", 0)
        pixels_below = browser_state.get("pixels_below", 0)
        if pixels_above > 0:
            content_above_info = f" ({pixels_above} pixels)"
        if pixels_below > 0:
            content_below_info = f" ({pixels_below} pixels)"

        if self._current_base64_image:
            image_message = Message.user_message(
                content="Current browser screenshot:",
                base64_image=self._current_base64_image,
            )
            self.agent.memory.add_message(image_message)
            self._current_base64_image = None  # 消费后清空

    return NEXT_STEP_PROMPT.format(
        url_placeholder=url_info,
        tabs_placeholder=tabs_info,
        content_above_placeholder=content_above_info,
        content_below_placeholder=content_below_info,
        results_placeholder="",
    )
```

注意截图的"消费后清空"模式：`self._current_base64_image = None`，避免同一张截图被重复注入 memory。

#### 2.2.3 BrowserUseTool 的状态获取

`get_current_state()`（`app/tool/browser_use_tool.py:479-539`）是状态数据的源头：

```python
async def get_current_state(self, context=None) -> ToolResult:
    ctx = context or self.context
    if not ctx:
        return ToolResult(error="Browser context not initialized")

    state = await ctx.get_state()
    page = await ctx.get_current_page()
    await page.bring_to_front()
    await page.wait_for_load_state()

    screenshot = await page.screenshot(
        full_page=True, animations="disabled", type="jpeg", quality=100
    )
    screenshot = base64.b64encode(screenshot).decode("utf-8")

    state_info = {
        "url": state.url,
        "title": state.title,
        "tabs": [tab.model_dump() for tab in state.tabs],
        "interactive_elements": (
            state.element_tree.clickable_elements_to_string()
            if state.element_tree else ""
        ),
        "scroll_info": {
            "pixels_above": getattr(state, "pixels_above", 0),
            "pixels_below": getattr(state, "pixels_below", 0),
        },
    }
    return ToolResult(
        output=json.dumps(state_info, indent=4, ensure_ascii=False),
        base64_image=screenshot,
    )
```

关键设计：截图使用 `full_page=True` + JPEG quality=100，确保 LLM 能看到完整页面。`interactive_elements` 通过 browser-use 的 DOM 服务提取可交互元素树，以 `[index]<type>text</type>` 格式呈现。

#### 2.2.4 SandboxBrowserTool 的 HTTP 代理模式

沙箱模式下（`app/tool/sandbox/sb_browser_tool.py:195-276`），浏览器操作通过 HTTP API 代理到 Daytona 沙箱内：

```python
async def _execute_browser_action(self, endpoint, params=None, method="POST"):
    await self._ensure_sandbox()
    url = f"http://localhost:8003/api/automation/{endpoint}"
    curl_cmd = f"curl -s -X {method} '{url}' -H 'Content-Type: application/json'"
    if params:
        json_data = json.dumps(params)
        curl_cmd += f" -d '{json_data}'"
    response = self.sandbox.process.exec(curl_cmd, timeout=30)
    if response.exit_code == 0:
        result = json.loads(response.result)
        if "screenshot_base64" in result:
            is_valid, msg = self._validate_base64_image(result["screenshot_base64"])
            if not is_valid:
                del result["screenshot_base64"]
        # ...
```

沙箱模式的独特之处：通过 `sandbox.process.exec(curl_cmd)` 在沙箱内执行 curl 命令，与沙箱内运行的浏览器自动化服务（端口 8003）通信。还包含完整的 base64 图片验证（格式、大小、尺寸检查），防止无效截图污染上下文。

### 2.3 实现细节

#### 动作空间对比

| 动作类别 | BrowserUseTool (本地) | SandboxBrowserTool (沙箱) |
|----------|----------------------|--------------------------|
| 导航 | go_to_url, go_back, refresh, web_search | navigate_to, go_back |
| 交互 | click_element, input_text, send_keys | click_element, input_text, send_keys |
| 滚动 | scroll_down, scroll_up, scroll_to_text | scroll_down, scroll_up, scroll_to_text |
| 标签 | switch_tab, open_tab, close_tab | switch_tab, close_tab |
| 下拉框 | get_dropdown_options, select_dropdown_option | get_dropdown_options, select_dropdown_option |
| 提取 | extract_content (LLM 驱动) | — |
| 坐标 | — | click_coordinates, drag_drop |
| 等待 | wait | wait |

本地模式独有 `extract_content`：将页面 HTML 转 Markdown 后用 LLM function calling 提取结构化信息（`app/tool/browser_use_tool.py:375-444`）。沙箱模式独有 `click_coordinates` 和 `drag_drop`，支持基于坐标的精确操作。

#### 浏览器初始化与配置

`_ensure_browser_initialized()`（`app/tool/browser_use_tool.py:141-188`）采用懒初始化模式：

- 首次调用时创建 `BrowserUseBrowser` 实例和 `BrowserContext`
- 从全局 `config.browser_config` 读取 headless、proxy、CDP/WSS 连接等参数
- 支持通过 `cdp_url` 或 `wss_url` 连接已有浏览器实例（适用于调试和远程场景）
- `DomService` 在 context 创建后立即初始化，用于后续的元素索引查询

#### 资源清理

BrowserUseTool 实现了双重清理保障（`app/tool/browser_use_tool.py:541-560`）：

1. 显式 `cleanup()` 方法：先关 context 再关 browser，用 `async with self.lock` 保护
2. `__del__` 析构函数：兜底清理，处理 event loop 可能已关闭的情况

BrowserAgent 的 `run()` 方法（继承自 ToolCallAgent）在 `finally` 块中调用 `cleanup()`，确保无论成功还是异常都会清理浏览器资源。

---

## 第 3 章 迁移指南

### 3.1 迁移清单

**阶段 1：基础浏览器工具**

- [ ] 安装依赖：`pip install browser-use playwright && playwright install`
- [ ] 实现 `BrowserTool`：封装 Playwright 的 16 种动作，参考 `BrowserUseTool` 的 action enum 设计
- [ ] 实现 `ToolResult` 数据类：统一工具返回格式，支持 `output`、`error`、`base64_image` 三个字段
- [ ] 实现 `asyncio.Lock` 保护：防止并发浏览器操作

**阶段 2：状态感知层**

- [ ] 实现 `get_current_state()`：获取 URL/Title/Tabs/可交互元素/滚动位置 + 截图
- [ ] 实现 `BrowserContextHelper`：解耦状态获取逻辑，支持截图注入 memory
- [ ] 设计 `NEXT_STEP_PROMPT` 模板：包含 URL、标签数、滚动位置占位符

**阶段 3：Agent 集成**

- [ ] 创建 `BrowserAgent`：覆写 `think()` 方法，在 LLM 决策前注入浏览器状态
- [ ] 配置 `max_observe` 限制工具输出长度
- [ ] 实现 `cleanup()` 生命周期管理

**阶段 4（可选）：沙箱模式**

- [ ] 部署沙箱内浏览器自动化服务（HTTP API）
- [ ] 实现 `SandboxBrowserTool`：通过 HTTP 代理浏览器操作
- [ ] 添加 base64 图片验证逻辑

### 3.2 适配代码模板

以下是一个最小可运行的浏览器 Agent 实现，提取了 OpenManus 的核心模式：

```python
import asyncio
import base64
import json
from typing import Optional
from dataclasses import dataclass, field
from playwright.async_api import async_playwright, Browser, BrowserContext, Page


@dataclass
class ToolResult:
    output: Optional[str] = None
    error: Optional[str] = None
    base64_image: Optional[str] = None

    def __str__(self):
        return f"Error: {self.error}" if self.error else (self.output or "")


class BrowserTool:
    """最小浏览器工具，参考 OpenManus BrowserUseTool 设计"""

    ACTIONS = [
        "go_to_url", "click_element", "input_text",
        "scroll_down", "scroll_up", "extract_content",
        "switch_tab", "open_tab", "close_tab", "wait",
    ]

    def __init__(self):
        self._lock = asyncio.Lock()
        self._browser: Optional[Browser] = None
        self._context: Optional[BrowserContext] = None
        self._page: Optional[Page] = None

    async def _ensure_initialized(self):
        if self._browser is None:
            pw = await async_playwright().start()
            self._browser = await pw.chromium.launch(headless=False)
            self._context = await self._browser.new_context()
            self._page = await self._context.new_page()

    async def get_current_state(self) -> ToolResult:
        """获取浏览器状态 + 截图，参考 browser_use_tool.py:479"""
        await self._ensure_initialized()
        screenshot_bytes = await self._page.screenshot(
            full_page=True, type="jpeg", quality=100
        )
        screenshot_b64 = base64.b64encode(screenshot_bytes).decode()
        state = {
            "url": self._page.url,
            "title": await self._page.title(),
        }
        return ToolResult(
            output=json.dumps(state, ensure_ascii=False),
            base64_image=screenshot_b64,
        )

    async def execute(self, action: str, **kwargs) -> ToolResult:
        async with self._lock:
            await self._ensure_initialized()
            if action == "go_to_url":
                await self._page.goto(kwargs["url"])
                return ToolResult(output=f"Navigated to {kwargs['url']}")
            elif action == "click_element":
                # 简化版：用 selector 代替 index
                await self._page.click(kwargs["selector"])
                return ToolResult(output=f"Clicked {kwargs['selector']}")
            # ... 其他动作类似
            else:
                return ToolResult(error=f"Unknown action: {action}")

    async def cleanup(self):
        if self._context:
            await self._context.close()
        if self._browser:
            await self._browser.close()


class BrowserContextHelper:
    """状态管理辅助类，参考 browser.py:19"""

    def __init__(self, tool: BrowserTool):
        self.tool = tool
        self._screenshot: Optional[str] = None

    async def get_state_and_screenshot(self) -> tuple[dict, Optional[str]]:
        result = await self.tool.get_current_state()
        if result.error:
            return {}, None
        state = json.loads(result.output)
        return state, result.base64_image

    def format_prompt(self, state: dict) -> str:
        url = state.get("url", "N/A")
        title = state.get("title", "N/A")
        return f"Current page: {url} ({title})\nWhat should I do next?"
```

### 3.3 适用场景

| 场景 | 适用度 | 说明 |
|------|--------|------|
| Agent 驱动的网页信息采集 | ⭐⭐⭐ | 截图 + 状态注入让 LLM 准确理解页面 |
| 自动化表单填写和提交 | ⭐⭐⭐ | 16 种动作覆盖常见交互，元素索引机制精确 |
| 需要沙箱隔离的浏览器操作 | ⭐⭐⭐ | 双模架构天然支持本地/沙箱切换 |
| 高并发浏览器任务 | ⭐⭐ | asyncio.Lock 串行化保证安全但限制吞吐 |
| 需要精确像素操作的场景 | ⭐⭐ | 沙箱模式支持 click_coordinates，本地模式不支持 |
| 无头批量爬取（不需要 Agent 决策） | ⭐ | 架构偏重 Agent 交互，纯爬取场景过重 |

---

## 第 4 章 测试用例

基于 OpenManus 真实函数签名编写的测试代码：

```python
import asyncio
import json
import pytest
from unittest.mock import AsyncMock, MagicMock, patch


class TestBrowserContextHelper:
    """测试 BrowserContextHelper 的状态获取和截图注入"""

    def setup_method(self):
        """模拟 BrowserAgent 和 BrowserUseTool"""
        self.mock_agent = MagicMock()
        self.mock_agent.memory = MagicMock()
        self.mock_agent.memory.add_message = MagicMock()

        self.mock_tool = MagicMock()
        self.mock_tool.name = "browser_use"
        self.mock_agent.available_tools = MagicMock()
        self.mock_agent.available_tools.get_tool = MagicMock(return_value=self.mock_tool)

    @pytest.mark.asyncio
    async def test_get_browser_state_success(self):
        """正常路径：成功获取浏览器状态"""
        from app.tool.base import ToolResult

        mock_state = ToolResult(
            output=json.dumps({
                "url": "https://example.com",
                "title": "Example",
                "tabs": [],
                "pixels_above": 0,
                "pixels_below": 500,
            }),
            base64_image="base64_screenshot_data",
        )
        self.mock_tool.get_current_state = AsyncMock(return_value=mock_state)

        from app.agent.browser import BrowserContextHelper
        helper = BrowserContextHelper(self.mock_agent)
        state = await helper.get_browser_state()

        assert state is not None
        assert state["url"] == "https://example.com"
        assert helper._current_base64_image == "base64_screenshot_data"

    @pytest.mark.asyncio
    async def test_get_browser_state_error(self):
        """边界情况：浏览器状态获取失败"""
        from app.tool.base import ToolResult

        mock_state = ToolResult(error="Browser not connected")
        self.mock_tool.get_current_state = AsyncMock(return_value=mock_state)

        from app.agent.browser import BrowserContextHelper
        helper = BrowserContextHelper(self.mock_agent)
        state = await helper.get_browser_state()

        assert state is None
        assert helper._current_base64_image is None

    @pytest.mark.asyncio
    async def test_screenshot_injected_and_consumed(self):
        """关键行为：截图注入 memory 后被清空，不会重复注入"""
        from app.tool.base import ToolResult

        mock_state = ToolResult(
            output=json.dumps({"url": "https://test.com", "title": "Test"}),
            base64_image="screenshot_data",
        )
        self.mock_tool.get_current_state = AsyncMock(return_value=mock_state)

        from app.agent.browser import BrowserContextHelper
        helper = BrowserContextHelper(self.mock_agent)

        # 第一次调用：截图应被注入
        prompt1 = await helper.format_next_step_prompt()
        self.mock_agent.memory.add_message.assert_called_once()
        assert helper._current_base64_image is None  # 已消费

        # 重置 mock
        self.mock_agent.memory.add_message.reset_mock()
        mock_state_no_img = ToolResult(
            output=json.dumps({"url": "https://test.com", "title": "Test"}),
        )
        self.mock_tool.get_current_state = AsyncMock(return_value=mock_state_no_img)

        # 第二次调用：无截图，不应注入
        prompt2 = await helper.format_next_step_prompt()
        self.mock_agent.memory.add_message.assert_not_called()


class TestBrowserUseTool:
    """测试 BrowserUseTool 的动作执行"""

    @pytest.mark.asyncio
    async def test_execute_go_to_url(self):
        """导航动作测试"""
        from app.tool.browser_use_tool import BrowserUseTool

        tool = BrowserUseTool()
        # Mock browser initialization
        mock_page = AsyncMock()
        mock_context = AsyncMock()
        mock_context.get_current_page = AsyncMock(return_value=mock_page)
        tool.context = mock_context
        tool.browser = MagicMock()

        result = await tool.execute(action="go_to_url", url="https://example.com")
        assert "Navigated to" in result.output
        mock_page.goto.assert_called_once_with("https://example.com")

    @pytest.mark.asyncio
    async def test_execute_missing_url(self):
        """降级行为：缺少必需参数"""
        from app.tool.browser_use_tool import BrowserUseTool

        tool = BrowserUseTool()
        tool.browser = MagicMock()
        mock_context = AsyncMock()
        tool.context = mock_context

        result = await tool.execute(action="go_to_url")
        assert result.error is not None
        assert "URL is required" in result.error

    @pytest.mark.asyncio
    async def test_cleanup_releases_resources(self):
        """资源清理测试"""
        from app.tool.browser_use_tool import BrowserUseTool

        tool = BrowserUseTool()
        tool.context = AsyncMock()
        tool.browser = AsyncMock()
        tool.dom_service = MagicMock()

        await tool.cleanup()
        tool.context.close.assert_called_once()
        tool.browser.close.assert_called_once()
        assert tool.context is None
        assert tool.browser is None
        assert tool.dom_service is None
```

---

## 第 5 章 跨域关联

| 关联域 | 关系类型 | 说明 |
|--------|----------|------|
| PD-01 上下文管理 | 依赖 | 截图注入 memory 会快速消耗上下文窗口，`max_observe=10000` 和 `Memory.max_messages=100` 是关键限制 |
| PD-04 工具系统 | 协同 | BrowserUseTool 继承 BaseTool，通过 ToolCollection 注册，遵循统一的 `to_param()` / `execute()` 接口 |
| PD-05 沙箱隔离 | 协同 | SandboxBrowserTool 基于 Daytona 沙箱运行，浏览器操作在隔离环境中执行 |
| PD-01 上下文管理 | 依赖 | BrowserAgent 的 `max_steps=20` 和 Memory 的 `max_messages=100` 共同限制浏览器会话长度 |
| PD-03 容错与重试 | 协同 | `get_browser_state()` 的 try/except 降级（返回 None 而非抛异常），`is_stuck()` 检测重复响应 |

---

## 第 6 章 来源文件索引

| 文件 | 行范围 | 关键实现 |
|------|--------|----------|
| `app/agent/browser.py` | L19-45 | BrowserContextHelper：状态获取 + 截图缓存 |
| `app/agent/browser.py` | L47-79 | format_next_step_prompt：状态格式化 + 截图注入 memory |
| `app/agent/browser.py` | L87-130 | BrowserAgent：think 覆写 + model_validator 初始化 |
| `app/tool/browser_use_tool.py` | L39-122 | BrowserUseTool 类定义 + 16 种动作参数 schema |
| `app/tool/browser_use_tool.py` | L141-188 | _ensure_browser_initialized：懒初始化 + 配置读取 |
| `app/tool/browser_use_tool.py` | L190-477 | execute：16 种浏览器动作的完整实现 |
| `app/tool/browser_use_tool.py` | L479-539 | get_current_state：状态获取 + 全页截图 |
| `app/tool/browser_use_tool.py` | L541-560 | cleanup + __del__：双重资源清理 |
| `app/tool/sandbox/sb_browser_tool.py` | L36-127 | SandboxBrowserTool 类定义 + 15 种动作参数 schema |
| `app/tool/sandbox/sb_browser_tool.py` | L138-193 | _validate_base64_image：截图验证（格式/大小/尺寸） |
| `app/tool/sandbox/sb_browser_tool.py` | L195-276 | _execute_browser_action：HTTP 代理到沙箱 |
| `app/tool/sandbox/sb_browser_tool.py` | L416-445 | get_current_state（沙箱版）：从 ThreadMessage 提取状态 |
| `app/prompt/browser.py` | L1-94 | SYSTEM_PROMPT + NEXT_STEP_PROMPT 模板 |
| `app/config.py` | L69-91 | BrowserSettings：headless/proxy/CDP/WSS 配置 |
| `app/schema.py` | L54-104 | Message 类：支持 base64_image 的多模态消息 |
| `app/agent/toolcall.py` | L18-250 | ToolCallAgent：think/act/execute_tool 基类 |

---

## 第 7 章 横向对比维度

```json comparison_data
{
  "project": "OpenManus",
  "dimensions": {
    "浏览器引擎": "browser-use 库 + Playwright，支持 CDP/WSS 远程连接",
    "状态感知": "每步 think 前获取 URL/标签/滚动位置/可交互元素 + JPEG 全页截图",
    "截图策略": "full_page JPEG quality=100，base64 注入 memory 后立即清空",
    "动作空间": "本地 16 种 + 沙箱 15 种动作，含 LLM 驱动的内容提取",
    "双模架构": "本地 Playwright 直连 + Daytona 沙箱 HTTP API 代理",
    "并发控制": "asyncio.Lock 串行化所有浏览器操作",
    "资源管理": "cleanup() + __del__ 双重保障，run() finally 兜底"
  }
}
```

### 域元数据补充

```json domain_metadata
{
  "solution_summary": "OpenManus 用 browser-use + Playwright 双模架构实现浏览器自动化，BrowserContextHelper 每步注入 URL/标签/滚动位置 + JPEG 截图到 memory，支持本地和 Daytona 沙箱两种运行模式",
  "description": "浏览器自动化需要解决状态同步、视觉感知、动作空间设计和环境隔离四大问题",
  "sub_problems": [
    "LLM 驱动的页面内容提取（HTML→Markdown→function calling）",
    "浏览器实例懒初始化与双重资源清理",
    "base64 截图验证（格式/大小/尺寸校验）"
  ],
  "best_practices": [
    "截图消费后立即清空，避免重复注入 memory",
    "asyncio.Lock 串行化浏览器操作防止竞态",
    "支持 CDP/WSS 远程连接已有浏览器实例"
  ]
}
```
