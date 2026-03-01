# PD-06.07 AgenticRAG — InMemorySaver 双层状态持久化与 Parent-Chunk 磁盘归档

> 文档编号：PD-06.07
> 来源：agentic-rag-for-dummies `project/rag_agent/graph.py` `project/core/rag_system.py` `project/db/parent_store_manager.py`
> GitHub：https://github.com/GiovanniPasq/agentic-rag-for-dummies.git
> 问题域：PD-06 记忆持久化 Memory Persistence
> 状态：可复用方案

---

## 第 1 章 问题与动机

### 1.1 核心问题

Agentic RAG 系统面临两层持久化需求：

1. **会话状态持久化** — LangGraph 图执行过程中的中间状态（消息历史、上下文摘要、检索键集合）需要跨轮次保持，以支持多轮对话和 interrupt 恢复。如果每轮调用都从零开始，Agent 无法理解"上一轮你说的那个文件"这类指代。

2. **知识块磁盘归档** — Parent chunk（大段原文）体积大、数量多，不适合全部放在向量库中。需要一个独立的持久化层，按 ID 快速加载原文，供 Agent 在检索到 child chunk 后回溯完整上下文。

这两层需求的特点不同：会话状态是短期的、按 thread 隔离的、进程内即可；知识块是长期的、跨会话共享的、需要磁盘持久化。agentic-rag-for-dummies 用两套独立机制分别解决这两个问题。

### 1.2 agentic-rag-for-dummies 的解法概述

1. **InMemorySaver 作为 checkpointer** — 在 `graph.py:14` 创建 `InMemorySaver()` 实例，编译外层图时传入 `checkpointer=checkpointer`（`graph.py:48`），LangGraph 自动在每个节点执行后保存完整 State 快照，支持 `interrupt_before` 恢复（`graph.py:48`）
2. **thread_id 隔离会话** — `rag_system.py:18` 用 `uuid.uuid4()` 生成唯一 thread_id，通过 `get_config()` 传入图调用的 `configurable` 字典（`rag_system.py:29-30`），不同对话互不干扰
3. **conversation_summary 跨轮次摘要** — `nodes.py:10-28` 的 `summarize_history` 节点在每轮开始时将最近 6 条消息压缩为 1-2 句摘要，写入 State 的 `conversation_summary` 字段，供后续 `rewrite_query` 节点使用
4. **ParentStoreManager JSON 磁盘归档** — `parent_store_manager.py:8-52` 将 parent chunk 以 `{parent_id}.json` 文件形式持久化到 `parent_store/` 目录，每个文件包含 `page_content` 和 `metadata`
5. **context_summary 压缩记忆** — `nodes.py:127-164` 的 `compress_context` 节点在 token 超阈值时将 Agent 子图的消息历史压缩为结构化摘要，并附加已执行的检索键防止重复检索

### 1.3 设计思想

| 设计原则 | 具体实现 | 理由 | 替代方案 |
|----------|----------|------|----------|
| 双层分离 | InMemorySaver 管会话状态，ParentStoreManager 管知识块 | 会话状态短期易变，知识块长期稳定，混在一起增加复杂度 | 统一用数据库存储（如 SQLite） |
| 最小依赖 | InMemorySaver 零配置，JSON 文件零依赖 | 教学项目优先降低门槛，无需 Redis/PostgreSQL | LangGraph PostgresSaver / RedisSaver |
| 摘要代替全量 | conversation_summary 只保留 1-2 句 | 避免 token 爆炸，Ollama 本地模型上下文窗口有限 | 滑动窗口截断消息历史 |
| 显式重置 | reset_thread 删除旧 checkpoint 并生成新 UUID | 防止旧会话状态污染新对话 | 自动过期（TTL） |
| 去重检索键 | retrieval_keys 集合记录已执行的搜索和已获取的 parent ID | 压缩后消息被删除，但 Agent 需要知道哪些检索已做过 | 在 prompt 中列出历史查询（不可靠） |

---

## 第 2 章 源码实现分析

### 2.1 架构概览

agentic-rag-for-dummies 的持久化架构分为三层：

```
┌─────────────────────────────────────────────────────────────┐
│                    LangGraph Runtime                         │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  InMemorySaver (checkpointer)                        │   │
│  │  ┌─────────┐  ┌─────────┐  ┌─────────┐              │   │
│  │  │thread-A │  │thread-B │  │thread-C │  ...          │   │
│  │  │ State{} │  │ State{} │  │ State{} │              │   │
│  │  └─────────┘  └─────────┘  └─────────┘              │   │
│  └──────────────────────────────────────────────────────┘   │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  State 内嵌记忆字段                                    │   │
│  │  • conversation_summary: str  (外层图)                │   │
│  │  • context_summary: str       (Agent 子图)            │   │
│  │  • retrieval_keys: Set[str]   (去重检索记录)           │   │
│  └──────────────────────────────────────────────────────┘   │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  ParentStoreManager (磁盘 JSON)                       │   │
│  │  parent_store/                                        │   │
│  │  ├── doc1_parent_0.json                               │   │
│  │  ├── doc1_parent_1.json                               │   │
│  │  └── doc2_parent_0.json                               │   │
│  └──────────────────────────────────────────────────────┘   │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  Qdrant (向量库 — child chunks)                       │   │
│  │  • dense: all-mpnet-base-v2                           │   │
│  │  • sparse: BM25                                       │   │
│  │  • mode: HYBRID                                       │   │
│  └──────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

### 2.2 核心实现

#### 2.2.1 InMemorySaver Checkpointer 与 Thread 隔离

```mermaid
graph TD
    A[RAGSystem.__init__] -->|uuid4| B[thread_id 生成]
    B --> C[get_config 构建 configurable]
    C --> D[agent_graph.invoke/stream config]
    D --> E{InMemorySaver}
    E -->|每个节点后| F[保存 State 快照]
    E -->|interrupt_before| G[恢复到中断点]
    H[reset_thread] -->|delete_thread| E
    H -->|uuid4| B
```

对应源码 `project/core/rag_system.py:10-37`：

```python
class RAGSystem:
    def __init__(self, collection_name=config.CHILD_COLLECTION):
        self.collection_name = collection_name
        self.vector_db = VectorDbManager()
        self.parent_store = ParentStoreManager()
        self.chunker = DocumentChuncker()
        self.agent_graph = None
        self.thread_id = str(uuid.uuid4())  # L18: 每个 RAGSystem 实例一个会话
        self.recursion_limit = 50

    def get_config(self):
        return {
            "configurable": {"thread_id": self.thread_id},  # L30: thread_id 传入图运行时
            "recursion_limit": self.recursion_limit
        }

    def reset_thread(self):
        try:
            self.agent_graph.checkpointer.delete_thread(self.thread_id)  # L34: 清除旧状态
        except Exception as e:
            print(f"Warning: Could not delete thread {self.thread_id}: {e}")
        self.thread_id = str(uuid.uuid4())  # L37: 生成新 thread
```

图编译时注入 checkpointer（`project/rag_agent/graph.py:14,48`）：

```python
checkpointer = InMemorySaver()  # L14: 进程内存储
# ...
agent_graph = graph_builder.compile(
    checkpointer=checkpointer,           # L48: 注入 checkpointer
    interrupt_before=["request_clarification"]  # 支持 human-in-the-loop
)
```

#### 2.2.2 conversation_summary 跨轮次摘要

```mermaid
graph TD
    A[用户发送消息] --> B[summarize_history 节点]
    B --> C{messages 数量 >= 4?}
    C -->|否| D[返回空摘要]
    C -->|是| E[过滤 Human/AI 消息]
    E --> F[取最近 6 条]
    F --> G[LLM 生成 1-2 句摘要]
    G --> H[写入 conversation_summary]
    H --> I[重置 agent_answers]
    I --> J[rewrite_query 节点读取摘要]
    J --> K[摘要注入查询改写 prompt]
```

对应源码 `project/rag_agent/nodes.py:10-28`：

```python
def summarize_history(state: State, llm):
    if len(state["messages"]) < 4:           # L11: 消息太少不摘要
        return {"conversation_summary": ""}

    relevant_msgs = [
        msg for msg in state["messages"][:-1]
        if isinstance(msg, (HumanMessage, AIMessage))
        and not getattr(msg, "tool_calls", None)  # L17: 过滤工具调用消息
    ]

    if not relevant_msgs:
        return {"conversation_summary": ""}

    conversation = "Conversation history:\n"
    for msg in relevant_msgs[-6:]:           # L23: 只取最近 6 条
        role = "User" if isinstance(msg, HumanMessage) else "Assistant"
        conversation += f"{role}: {msg.content}\n"

    summary_response = llm.with_config(temperature=0.2).invoke(
        [SystemMessage(content=get_conversation_summary_prompt()),
         HumanMessage(content=conversation)]
    )
    return {
        "conversation_summary": summary_response.content,
        "agent_answers": [{"__reset__": True}]  # L28: 重置上轮答案
    }
```

#### 2.2.3 ParentStoreManager JSON 磁盘归档

```mermaid
graph TD
    A[DocumentChuncker.create_chunks] --> B[Markdown 按标题拆分 parent]
    B --> C[merge/split/clean 三步规整]
    C --> D[生成 parent_id: stem_parent_N]
    D --> E[ParentStoreManager.save_many]
    E --> F[每个 parent → JSON 文件]
    F --> G[parent_store/doc1_parent_0.json]
    H[Agent 调用 retrieve_parent_chunks] --> I[ToolFactory._retrieve_parent_chunks]
    I --> J[ParentStoreManager.load_content]
    J --> K[读取 JSON 返回 content+metadata]
```

对应源码 `project/db/parent_store_manager.py:8-52`：

```python
class ParentStoreManager:
    __store_path: Path

    def __init__(self, store_path=config.PARENT_STORE_PATH):
        self.__store_path = Path(store_path)
        self.__store_path.mkdir(parents=True, exist_ok=True)  # L13: 自动创建目录

    def save(self, parent_id: str, content: str, metadata: Dict) -> None:
        file_path = self.__store_path / f"{parent_id}.json"
        file_path.write_text(
            json.dumps({"page_content": content, "metadata": metadata},
                       ensure_ascii=False, indent=2),
            encoding="utf-8"
        )  # L17-19: 直接写 JSON，无原子写入保护

    def load(self, parent_id: str) -> Dict:
        file_path = self.__store_path / (
            parent_id if parent_id.lower().endswith(".json")
            else f"{parent_id}.json"
        )
        return json.loads(file_path.read_text(encoding="utf-8"))  # L30: 按 ID 加载

    def load_content_many(self, parent_ids: List[str]) -> List[Dict]:
        unique_ids = set(parent_ids)  # L46: 去重
        return [self.load_content(pid)
                for pid in sorted(unique_ids, key=self._get_sort_key)]  # L47: 按序号排序

    def clear_store(self) -> None:
        if self.__store_path.exists():
            shutil.rmtree(self.__store_path)  # L51: 全量清除
        self.__store_path.mkdir(parents=True, exist_ok=True)
```

#### 2.2.4 context_summary 压缩记忆与去重检索

```mermaid
graph TD
    A[Agent 子图: tools 节点执行完毕] --> B[should_compress_context]
    B --> C[提取本轮 retrieval_keys]
    C --> D[estimate_context_tokens]
    D --> E{tokens > 阈值?}
    E -->|是| F[compress_context 节点]
    E -->|否| G[回到 orchestrator]
    F --> H[LLM 压缩消息为结构化摘要]
    H --> I[附加已执行检索键列表]
    I --> J[RemoveMessage 删除旧消息]
    J --> G
```

对应源码 `project/rag_agent/nodes.py:96-164`：

```python
def should_compress_context(state: AgentState) -> Command[Literal["compress_context", "orchestrator"]]:
    # L99-114: 从最近一条 AIMessage 的 tool_calls 提取检索键
    new_ids: Set[str] = set()
    for msg in reversed(messages):
        if isinstance(msg, AIMessage) and getattr(msg, "tool_calls", None):
            for tc in msg.tool_calls:
                if tc["name"] == "retrieve_parent_chunks":
                    raw = tc["args"].get("parent_id") or tc["args"].get("id") or []
                    new_ids.add(f"parent::{raw}" if isinstance(raw, str) else ...)
                elif tc["name"] == "search_child_chunks":
                    query = tc["args"].get("query", "")
                    if query:
                        new_ids.add(f"search::{query}")
            break

    # L118-122: token 估算与动态阈值
    current_tokens = estimate_context_tokens(messages) + estimate_context_tokens(
        [HumanMessage(content=state.get("context_summary", ""))]
    )
    max_allowed = BASE_TOKEN_THRESHOLD + int(current_token_summary * TOKEN_GROWTH_FACTOR)

    goto = "compress_context" if current_tokens > max_allowed else "orchestrator"
    return Command(update={"retrieval_keys": updated_ids}, goto=goto)
```

### 2.3 实现细节

**State 设计中的记忆字段**（`project/rag_agent/graph_state.py:13-29`）：

- `conversation_summary: str` — 外层图的跨轮次对话摘要，由 `summarize_history` 写入
- `context_summary: str` — Agent 子图的压缩研究上下文，由 `compress_context` 写入
- `retrieval_keys: Annotated[Set[str], set_union]` — 使用 `set_union` reducer 自动合并，确保跨压缩周期不丢失已执行的检索记录
- `agent_answers: Annotated[List[dict], accumulate_or_reset]` — 自定义 reducer 支持 `__reset__` 标记清空上轮答案

**双图嵌套的记忆隔离**：外层图（State）持有 `conversation_summary`，Agent 子图（AgentState）持有 `context_summary` 和 `retrieval_keys`。子图每次被 `Send` 调用时从空白 AgentState 开始，不继承上轮子图的压缩上下文。这意味着 context_summary 是单轮内的工作记忆，conversation_summary 才是跨轮次的长期记忆。

**Qdrant 混合检索作为知识记忆**（`project/db/vector_db_manager.py:36-45`）：child chunk 存储在 Qdrant 中，使用 dense（all-mpnet-base-v2）+ sparse（BM25）混合检索模式，score_threshold=0.7 过滤低相关结果。这是知识层面的"记忆"，与会话状态层面的记忆互补。

---

## 第 3 章 迁移指南

### 3.1 迁移清单

**阶段 1：会话状态持久化（最小可用）**

- [ ] 安装 `langgraph` 并选择 checkpointer 实现
- [ ] 在图编译时传入 `checkpointer` 参数
- [ ] 为每个会话生成唯一 `thread_id`，通过 `configurable` 传入
- [ ] 实现 `reset_thread` 清理旧会话状态

**阶段 2：对话摘要记忆**

- [ ] 在 State 中添加 `conversation_summary: str` 字段
- [ ] 实现 `summarize_history` 节点，在每轮开始时生成摘要
- [ ] 将摘要注入查询改写或回答生成的 prompt 中

**阶段 3：知识块磁盘归档**

- [ ] 实现 ParentStoreManager（或等价的 KV 存储）
- [ ] 在文档入库时同时保存 parent chunk 到磁盘
- [ ] 实现按 ID 加载的工具函数，注册为 Agent 工具

**阶段 4：上下文压缩（可选）**

- [ ] 实现 token 估算函数
- [ ] 添加 `compress_context` 节点和动态阈值判断
- [ ] 在 State 中添加 `retrieval_keys: Set[str]` 防止重复检索

### 3.2 适配代码模板

**生产级 ParentStoreManager（添加原子写入保护）：**

```python
import json
import tempfile
from pathlib import Path
from typing import Dict, List, Optional

class ParentStoreManager:
    """Parent chunk 磁盘归档管理器，支持原子写入。"""

    def __init__(self, store_path: str = "./parent_store"):
        self._store_path = Path(store_path)
        self._store_path.mkdir(parents=True, exist_ok=True)

    def save(self, parent_id: str, content: str, metadata: Dict) -> None:
        file_path = self._store_path / f"{parent_id}.json"
        data = json.dumps(
            {"page_content": content, "metadata": metadata},
            ensure_ascii=False, indent=2
        )
        # 原子写入：先写临时文件再 rename
        tmp_fd, tmp_path = tempfile.mkstemp(
            dir=self._store_path, suffix=".tmp"
        )
        try:
            with open(tmp_fd, "w", encoding="utf-8") as f:
                f.write(data)
            Path(tmp_path).replace(file_path)
        except Exception:
            Path(tmp_path).unlink(missing_ok=True)
            raise

    def load(self, parent_id: str) -> Optional[Dict]:
        file_path = self._store_path / f"{parent_id}.json"
        if not file_path.exists():
            return None
        return json.loads(file_path.read_text(encoding="utf-8"))

    def load_batch(self, parent_ids: List[str]) -> List[Dict]:
        results = []
        for pid in sorted(set(parent_ids)):
            data = self.load(pid)
            if data:
                results.append({
                    "parent_id": pid,
                    "content": data["page_content"],
                    "metadata": data.get("metadata", {})
                })
        return results
```

**将 InMemorySaver 替换为 PostgresSaver（生产环境）：**

```python
from langgraph.checkpoint.postgres import PostgresSaver

# 替换 InMemorySaver() 为：
checkpointer = PostgresSaver.from_conn_string(
    "postgresql://user:pass@localhost:5432/rag_db"
)
checkpointer.setup()  # 自动创建表

agent_graph = graph_builder.compile(
    checkpointer=checkpointer,
    interrupt_before=["request_clarification"]
)
```

### 3.3 适用场景

| 场景 | 适用度 | 说明 |
|------|--------|------|
| 教学/原型项目 | ⭐⭐⭐ | InMemorySaver + JSON 文件零配置，开箱即用 |
| 单用户本地 RAG | ⭐⭐⭐ | 进程内存足够，JSON 文件读写快 |
| 多用户 Web 服务 | ⭐☆☆ | InMemorySaver 进程重启丢失，需换 PostgresSaver |
| 大规模文档库 | ⭐☆☆ | JSON 文件无索引，万级 parent chunk 时 IO 成为瓶颈 |
| 需要会话恢复 | ⭐⭐☆ | checkpointer 支持 interrupt 恢复，但 InMemory 不跨进程 |

---

## 第 4 章 测试用例

```python
import json
import shutil
import tempfile
import pytest
from pathlib import Path
from unittest.mock import MagicMock, patch
from langchain_core.messages import HumanMessage, AIMessage, SystemMessage


class TestParentStoreManager:
    """测试 ParentStoreManager 的磁盘持久化行为。"""

    def setup_method(self):
        self.tmp_dir = tempfile.mkdtemp()
        # 直接实例化，传入临时目录
        from db.parent_store_manager import ParentStoreManager
        self.store = ParentStoreManager(store_path=self.tmp_dir)

    def teardown_method(self):
        shutil.rmtree(self.tmp_dir, ignore_errors=True)

    def test_save_and_load_single(self):
        """正常路径：保存后能按 ID 加载。"""
        self.store.save("doc1_parent_0", "Hello world", {"source": "doc1.pdf"})
        result = self.store.load("doc1_parent_0")
        assert result["page_content"] == "Hello world"
        assert result["metadata"]["source"] == "doc1.pdf"

    def test_load_with_json_extension(self):
        """边界：parent_id 已带 .json 后缀时不重复拼接。"""
        self.store.save("doc1_parent_0", "content", {})
        result = self.store.load("doc1_parent_0.json")
        assert result["page_content"] == "content"

    def test_load_content_many_dedup_and_sort(self):
        """去重 + 按序号排序。"""
        self.store.save("doc_parent_0", "first", {})
        self.store.save("doc_parent_2", "third", {})
        self.store.save("doc_parent_1", "second", {})
        results = self.store.load_content_many(
            ["doc_parent_2", "doc_parent_0", "doc_parent_1", "doc_parent_0"]
        )
        assert len(results) == 3  # 去重后 3 个
        assert results[0]["parent_id"] == "doc_parent_0"  # 按序号排序
        assert results[2]["parent_id"] == "doc_parent_2"

    def test_load_nonexistent_raises(self):
        """降级：加载不存在的 ID 应抛异常。"""
        with pytest.raises(FileNotFoundError):
            self.store.load("nonexistent_parent")

    def test_clear_store(self):
        """清除后目录为空但仍存在。"""
        self.store.save("doc_parent_0", "content", {})
        self.store.clear_store()
        assert Path(self.tmp_dir).exists()
        assert list(Path(self.tmp_dir).iterdir()) == []


class TestConversationSummary:
    """测试 summarize_history 节点的摘要行为。"""

    def test_skip_when_few_messages(self):
        """消息少于 4 条时返回空摘要。"""
        from rag_agent.nodes import summarize_history
        state = {"messages": [HumanMessage(content="hi"), AIMessage(content="hello")]}
        mock_llm = MagicMock()
        result = summarize_history(state, mock_llm)
        assert result["conversation_summary"] == ""
        mock_llm.invoke.assert_not_called()

    def test_filters_tool_call_messages(self):
        """过滤带 tool_calls 的 AIMessage。"""
        from rag_agent.nodes import summarize_history
        tool_msg = AIMessage(content="", tool_calls=[{"name": "search", "args": {}}])
        state = {
            "messages": [
                HumanMessage(content="q1"), AIMessage(content="a1"),
                HumanMessage(content="q2"), tool_msg,
                HumanMessage(content="q3"),
            ]
        }
        mock_llm = MagicMock()
        mock_response = MagicMock()
        mock_response.content = "Summary of q1, a1, q2, q3"
        mock_llm.with_config.return_value.invoke.return_value = mock_response
        result = summarize_history(state, mock_llm)
        assert result["conversation_summary"] == "Summary of q1, a1, q2, q3"
        assert result["agent_answers"] == [{"__reset__": True}]


class TestAccumulateOrReset:
    """测试自定义 reducer 的重置逻辑。"""

    def test_accumulate(self):
        from rag_agent.graph_state import accumulate_or_reset
        result = accumulate_or_reset([{"a": 1}], [{"b": 2}])
        assert result == [{"a": 1}, {"b": 2}]

    def test_reset(self):
        from rag_agent.graph_state import accumulate_or_reset
        result = accumulate_or_reset([{"a": 1}], [{"__reset__": True}])
        assert result == []
```

---

## 第 5 章 跨域关联

| 关联域 | 关系类型 | 说明 |
|--------|----------|------|
| PD-01 上下文管理 | 强依赖 | `compress_context` 节点同时是上下文压缩（PD-01）和工作记忆持久化（PD-06）的实现。token 估算阈值 `BASE_TOKEN_THRESHOLD=2000` + `TOKEN_GROWTH_FACTOR=0.9` 直接决定压缩触发时机 |
| PD-02 多 Agent 编排 | 协同 | 外层图通过 `Send` 并行派发多个 Agent 子图，每个子图有独立的 `context_summary`。checkpointer 保存的是外层图的 State，子图状态通过 `agent_answers` 汇聚回外层 |
| PD-04 工具系统 | 协同 | `retrieve_parent_chunks` 和 `search_child_chunks` 是 Agent 的检索工具，ParentStoreManager 是工具的存储后端。工具设计直接影响记忆的读取路径 |
| PD-08 搜索与检索 | 强依赖 | Qdrant 混合检索（dense + sparse）是知识记忆的检索层，child chunk → parent chunk 的两级检索是该项目的核心 RAG 模式 |
| PD-09 Human-in-the-Loop | 协同 | `interrupt_before=["request_clarification"]` 依赖 checkpointer 保存中断点状态，用户回复后从 checkpoint 恢复继续执行 |
| PD-12 推理增强 | 协同 | `rewrite_query` 节点利用 `conversation_summary` 改写查询，是记忆驱动推理增强的典型模式 |

---

## 第 6 章 来源文件索引

| 文件 | 行范围 | 关键实现 |
|------|--------|----------|
| `project/rag_agent/graph.py` | L1-51 | InMemorySaver 创建、双图编译、checkpointer 注入 |
| `project/core/rag_system.py` | L1-37 | RAGSystem 类、thread_id 生成与重置、config 构建 |
| `project/db/parent_store_manager.py` | L1-52 | ParentStoreManager 全部实现：save/load/clear |
| `project/rag_agent/nodes.py` | L10-28 | summarize_history 跨轮次摘要 |
| `project/rag_agent/nodes.py` | L96-164 | should_compress_context + compress_context 压缩记忆 |
| `project/rag_agent/graph_state.py` | L1-29 | State/AgentState 定义、accumulate_or_reset reducer |
| `project/rag_agent/prompts.py` | L1-19 | conversation_summary prompt |
| `project/rag_agent/prompts.py` | L118-150 | context_compression prompt |
| `project/db/vector_db_manager.py` | L36-45 | Qdrant 混合检索配置 |
| `project/rag_agent/tools.py` | L55-73 | retrieve_parent_chunks 工具实现 |
| `project/config.py` | L23-24 | BASE_TOKEN_THRESHOLD / TOKEN_GROWTH_FACTOR |
| `project/utils.py` | L27-37 | estimate_context_tokens tiktoken 估算 |

---

## 第 7 章 横向对比维度

> **重要：** 本章用于自动填充 Butcher Wiki 的横向对比表。

```json comparison_data
{
  "project": "agentic-rag-for-dummies",
  "dimensions": {
    "记忆结构": "三层分离：InMemorySaver 会话状态 + State 内嵌摘要字段 + JSON 文件知识块",
    "更新机制": "conversation_summary 每轮 LLM 重新生成，context_summary token 超阈值时压缩覆写",
    "存储方式": "InMemorySaver 进程内存 + parent chunk JSON 文件磁盘",
    "注入方式": "conversation_summary 注入 rewrite_query prompt，context_summary 注入 orchestrator prompt",
    "记忆检索": "Qdrant 混合检索 child chunk → parent_id → JSON 文件加载 parent chunk",
    "生命周期管理": "reset_thread 删除 checkpoint + uuid4 新建，clear_store 全量清除 JSON",
    "多渠道会话隔离": "uuid4 thread_id 隔离，每个 RAGSystem 实例独立会话",
    "记忆增长控制": "动态 token 阈值触发压缩，retrieval_keys 集合防止重复检索",
    "事实提取": "无独立事实提取，依赖 LLM 摘要隐式保留关键事实"
  }
}
```

### 域元数据补充

```json domain_metadata
{
  "solution_summary": "agentic-rag-for-dummies 用 InMemorySaver checkpointer + thread_id 隔离会话状态，conversation_summary LLM 摘要跨轮次维护上下文，ParentStoreManager 以 JSON 文件归档 parent chunk 供检索回溯",
  "description": "会话状态与知识块的双层持久化分离策略，适用于教学级 RAG 系统",
  "sub_problems": [
    "parent chunk 排序一致性：多 ID 批量加载时如何保证返回顺序与文档原始顺序一致",
    "摘要覆写丢失：每轮重新生成 conversation_summary 可能丢失早期对话的关键细节"
  ],
  "best_practices": [
    "双图嵌套记忆隔离：外层图持有跨轮次摘要，子图持有单轮工作记忆，互不污染",
    "retrieval_keys 集合去重：用 set_union reducer 跨压缩周期累积已执行检索，避免 Agent 重复调用相同工具"
  ]
}
```
