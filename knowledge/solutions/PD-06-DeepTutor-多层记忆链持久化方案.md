# PD-06.03 DeepTutor — 多层记忆链 + 分域 JSON 持久化

> 文档编号：PD-06.03
> 来源：DeepTutor `src/agents/solve/memory/` / `src/agents/chat/session_manager.py`
> GitHub：https://github.com/HKUDS/DeepTutor.git
> 问题域：PD-06 记忆持久化 Memory Persistence
> 状态：可复用方案

---

## 第 1 章 问题与动机

### 1.1 核心问题

教育辅导类 Agent 需要在一次求解过程中维护多种类型的记忆：调查阶段收集的知识碎片、求解阶段的步骤链、工具调用的引用溯源、以及跨会话的对话历史。这些记忆具有不同的生命周期和访问模式——调查记忆在分析循环中高频读写，求解链在步骤推进时顺序追加，引用记忆需要全局去重和 ID 映射，会话记忆则需要跨请求持久化。

如果用单一数据结构管理所有记忆，会导致序列化开销大、并发冲突多、版本迁移困难。DeepTutor 的解法是将记忆按职责分域，每个域独立持久化为 JSON 文件，通过 `cite_id` 作为跨域关联键。

### 1.2 DeepTutor 的解法概述

1. **三层记忆分域**：InvestigateMemory（调查知识链）、SolveMemory（求解步骤链）、CitationMemory（引用索引），各自独立序列化到 `output_dir/` 下的不同 JSON 文件（`investigate_memory.json`、`solve_chain.json`、`citation_memory.json`）——见 `src/agents/solve/memory/investigate_memory.py:93-96`、`src/agents/solve/memory/solve_memory.py:149`、`src/agents/solve/memory/citation_memory.py:62-64`
2. **统一 `load_or_create` 模式**：所有记忆类都实现 `load_or_create(output_dir)` 类方法，文件存在则加载并恢复状态，不存在则创建空实例——见 `investigate_memory.py:98-167`、`solve_memory.py:154-188`、`citation_memory.py:66-99`
3. **`cite_id` 跨域关联**：CitationMemory 生成全局唯一的 `[prefix-N]` 格式 ID，InvestigateMemory 的 KnowledgeItem 和 SolveMemory 的 ToolCallRecord 都通过 `cite_id` 引用同一条引用记录——见 `citation_memory.py:321-325`、`investigate_memory.py:17`、`solve_memory.py:27`
4. **ToolCallRecord 生命周期状态机**：每个工具调用记录有 `pending → running → success/failed` 的完整状态流转，支持中断恢复——见 `solve_memory.py:30`、`solve_memory.py:48-64`
5. **多版本向后兼容**：InvestigateMemory 支持 v1.0/v2.0/v3.0 三个版本的数据迁移，自动将旧格式字段映射到新结构——见 `investigate_memory.py:116-160`

### 1.3 设计思想

| 设计原则 | 具体实现 | 理由 | 替代方案 |
|----------|----------|------|----------|
| 记忆分域 | 三个独立 Memory 类各自管理一个 JSON 文件 | 不同记忆的读写频率和生命周期不同，分离减少锁竞争 | 单一 State 对象（LangGraph 风格） |
| 统一加载协议 | `load_or_create` 类方法 + `save()` 实例方法 | 调用方无需关心文件是否存在，简化恢复逻辑 | 外部 ORM / 数据库 |
| 跨域关联键 | `cite_id` 字符串（`[rag-1]`、`[web-2]`） | 轻量级引用，不需要外键约束，人类可读 | UUID / 数据库外键 |
| 状态机驱动 | ToolCallRecord 和 SolveChainStep 都有显式 status 字段 | 支持中断恢复和进度追踪 | 隐式状态推断 |
| 向后兼容 | `from_dict` 中做字段重命名和默认值填充 | 数据格式演进不破坏已有持久化文件 | 数据库 migration |

---

## 第 2 章 源码实现分析

### 2.1 架构概览

DeepTutor 的记忆系统由三个核心 Memory 类和两个 SessionManager 组成，服务于双循环（Analysis Loop + Solve Loop）架构：

```
┌─────────────────────────────────────────────────────────────┐
│                      MainSolver                              │
│                  (main_solver.py:37)                          │
├──────────────────────┬──────────────────────────────────────┤
│   Analysis Loop      │         Solve Loop                    │
│                      │                                       │
│  InvestigateAgent    │  ManagerAgent → SolveAgent → Response │
│  NoteAgent           │  ToolAgent                            │
├──────────────────────┴──────────────────────────────────────┤
│                    Memory Layer                               │
│                                                               │
│  ┌──────────────────┐  ┌───────────────┐  ┌───────────────┐ │
│  │InvestigateMemory │  │  SolveMemory  │  │CitationMemory │ │
│  │ knowledge_chain  │  │ solve_chains  │  │  citations[]  │ │
│  │ reflections      │  │ metadata      │  │ tool_counters │ │
│  │ metadata         │  │               │  │               │ │
│  └───────┬──────────┘  └───────┬───────┘  └───────┬───────┘ │
│          │ cite_id             │ cite_id           │          │
│          └─────────────────────┴───────────────────┘          │
│                         ↓ JSON                                │
│  output_dir/investigate_memory.json                           │
│  output_dir/solve_chain.json                                  │
│  output_dir/citation_memory.json                              │
├───────────────────────────────────────────────────────────────┤
│                   Session Layer                                │
│  ┌─────────────────────┐  ┌──────────────────────────┐       │
│  │  SessionManager     │  │  SolverSessionManager    │       │
│  │  (Chat sessions)    │  │  (Solver sessions)       │       │
│  │  chat_sessions.json │  │  solver_sessions.json    │       │
│  └─────────────────────┘  └──────────────────────────┘       │
│  ┌──────────────────────────┐                                 │
│  │  GuideManager             │                                │
│  │  session_{id}.json        │                                │
│  └──────────────────────────┘                                 │
└───────────────────────────────────────────────────────────────┘
```

### 2.2 核心实现

**2.2.1 InvestigateMemory — 调查知识链**

InvestigateMemory 管理 Analysis Loop 中收集的知识碎片。核心数据结构是 `knowledge_chain`（KnowledgeItem 列表）和 `reflections`（剩余问题）。

`src/agents/solve/memory/investigate_memory.py:63-96`:
```python
class InvestigateMemory:
    """Analysis loop memory management (Refactored: uses unified cite_id)"""

    def __init__(self, task_id=None, user_question="", output_dir=None):
        self.task_id = task_id or f"investigate_{datetime.now().strftime('%Y%m%d_%H%M%S')}"
        self.user_question = user_question
        self.version = "3.0"
        # Core data
        self.knowledge_chain: list[KnowledgeItem] = []
        self.reflections: Reflections = Reflections()
        # Metadata (for statistics and monitoring)
        self.metadata: dict[str, Any] = {
            "total_iterations": 0,
            "coverage_rate": 0.0,
            "avg_confidence": 0.0,
            "total_knowledge_items": 0,
        }
        # File path
        if output_dir:
            self.file_path = Path(output_dir) / "investigate_memory.json"
```

版本迁移是亮点——v1.0 的 `knowledge_id` 自动映射为 `cite_id`，旧的 `notes` 列表合并进 `knowledge_chain` 的 `summary` 字段：

`src/agents/solve/memory/investigate_memory.py:121-153`:
```python
# Load knowledge chain (supports v1.0/v2.0 compatibility)
knowledge_chain_data = data.get("knowledge_chain", [])
memory.knowledge_chain = [
    KnowledgeItem.from_dict(item) for item in knowledge_chain_data
]

# If v1.0, need to migrate data
if file_version == "1.0":
    # Merge notes summary into knowledge_chain
    notes_data = data.get("notes", [])
    for note in notes_data:
        related_knowledge_ids = note.get("related_knowledge_ids", [])
        for knowledge_id in related_knowledge_ids:
            for k_item in memory.knowledge_chain:
                if k_item.cite_id == knowledge_id:
                    if not k_item.summary:
                        k_item.summary = note.get("summary", "")
                    break
    # Convert reflections to remaining_questions
    reflections_data = data.get("reflections", [])
    remaining_questions = []
    for reflection in reflections_data:
        action_items = reflection.get("action_items", [])
        remaining_questions.extend(action_items)
```

**2.2.2 SolveMemory — 求解步骤链**

SolveMemory 管理 Solve Loop 的步骤链。每个 `SolveChainStep` 包含多个 `ToolCallRecord`，形成两级嵌套结构。

`src/agents/solve/memory/solve_memory.py:67-122`:
```python
@dataclass
class SolveChainStep:
    """Single step structure in solve-chain"""
    step_id: str
    step_target: str
    available_cite: List[str] = field(default_factory=list)
    tool_calls: List[ToolCallRecord] = field(default_factory=list)
    step_response: Optional[str] = None
    status: str = "undone"  # undone | in_progress | waiting_response | done | failed
    used_citations: List[str] = field(default_factory=list)

    def append_tool_call(self, tool_call: ToolCallRecord):
        self.tool_calls.append(tool_call)
        self.updated_at = _now()
        if self.status == "undone":
            self.status = "in_progress"  # 自动状态流转

    def update_response(self, response: str, used_citations=None):
        self.step_response = response
        self.status = "done"
        self.used_citations = used_citations or []
```

ToolCallRecord 的状态机（`solve_memory.py:22-64`）：

```
pending ──→ running ──→ success
                    └──→ failed
                    └──→ none / finish
```

SolveMemory 还支持 legacy 文件迁移（`solve_memory.py:303-341`），将旧版 `solve_memory.json` 的 `steps[].tool_logs[]` 转换为新版 `solve_chains[].tool_calls[]`。

**2.2.3 CitationMemory — 全局引用索引**

CitationMemory 是跨域的引用管理中心。它维护一个按工具类型分组的计数器，生成 `[rag-1]`、`[web-2]` 格式的全局唯一 ID。

`src/agents/solve/memory/citation_memory.py:45-64`:
```python
class CitationMemory:
    """Global citation management system"""
    def __init__(self, output_dir=None):
        self.citations: list[CitationItem] = []
        self.tool_counters: dict[str, int] = {}  # 按工具前缀递增
        if output_dir:
            self.file_path = Path(output_dir) / "citation_memory.json"
```

ID 生成逻辑（`citation_memory.py:321-325`）：
```python
def _generate_cite_id(self, tool_type: str) -> str:
    prefix = self._get_tool_prefix(tool_type)  # rag_naive → "rag"
    current = self.tool_counters.get(prefix, 0) + 1
    self.tool_counters[prefix] = current
    return f"[{prefix}-{current}]"
```

### 2.3 实现细节

**会话层持久化**

除了求解记忆，DeepTutor 还有三个独立的会话管理器：

1. **SessionManager**（`src/agents/chat/session_manager.py:20`）：Chat 模块的对话历史，存储在 `data/user/chat_sessions.json`，单文件存储所有会话（最多 100 条），支持 CRUD + 自动标题生成。
2. **SolverSessionManager**（`src/agents/solve/session_manager.py:20`）：Solve 模块的会话历史，存储在 `data/user/solver_sessions.json`，结构与 SessionManager 几乎相同，额外记录 `kb_name` 和 `token_stats`。
3. **GuideManager**（`src/agents/guide/guide_manager.py:46`）：引导学习会话，每个会话独立文件 `session_{id}.json`，包含 `knowledge_points`、`chat_history`、`status` 等。

两个 SessionManager 都使用单例模式（`session_manager.py:300-308`）：
```python
_session_manager: SessionManager | None = None

def get_session_manager() -> SessionManager:
    global _session_manager
    if _session_manager is None:
        _session_manager = SessionManager()
    return _session_manager
```

**Research 模块的 CitationManager**

Research 模块有独立的 `CitationManager`（`src/agents/research/utils/citation_manager.py:19`），使用不同的 ID 格式（`PLAN-XX` / `CIT-X-XX`），支持 `asyncio.Lock` 的线程安全并发写入（`citation_manager.py:47`），以及引用验证和无效引用清理（`citation_manager.py:176-233`）。

**数据流：MainSolver 中的记忆协作**

`src/agents/solve/main_solver.py:386-508` 展示了三个 Memory 如何在双循环中协作：

```
Analysis Loop:
  investigate_memory = InvestigateMemory.load_or_create(output_dir)
  citation_memory = CitationMemory.load_or_create(output_dir)
  for i in range(max_iterations):
      investigate_agent.process(memory=investigate_memory, citation_memory=citation_memory)
      note_agent.process(memory=investigate_memory, citation_memory=citation_memory)
  investigate_memory.save()

Solve Loop:
  solve_memory = SolveMemory.load_or_create(output_dir)
  manager_agent.process(investigate_memory=investigate_memory, solve_memory=solve_memory)
  for step in solve_memory.solve_chains:
      solve_agent.process(solve_memory=solve_memory, citation_memory=citation_memory)
  solve_memory.save()
```

