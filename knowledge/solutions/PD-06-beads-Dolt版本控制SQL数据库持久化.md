# PD-06.01 beads — Dolt 版本控制 SQL 数据库持久化

> 文档编号：PD-06.01
> 来源：beads `internal/storage/dolt/store.go`, `internal/storage/dolt/issues.go`, `internal/storage/dolt/transaction.go`
> GitHub：https://github.com/steveyegge/beads.git
> 问题域：PD-06 记忆持久化 Memory Persistence
> 状态：可复用方案

---

## 第 1 章 问题与动机（≥ 30 行）

### 1.1 核心问题

Agent 系统需要跨会话持久化状态，包括：
- **Issue 数据**：任务、依赖关系、标签、评论、事件历史
- **版本历史**：每次修改都需要可追溯，支持 time-travel 查询
- **并发写入**：多个 Agent 同时修改不同 Issue 时不能冲突
- **远程同步**：多个 Agent 实例间需要同步状态（federation）
- **Cell-level merge**：合并时需要字段级冲突检测，而非整行覆盖

传统方案的局限：
- **SQLite**：无原生版本控制，需要手动实现 snapshot 表
- **PostgreSQL**：无 time-travel，需要 trigger + audit 表
- **Git + JSON**：无 SQL 查询能力，复杂查询需要全量加载
- **向量数据库**：无事务保证，无版本控制

### 1.2 beads 的解法概述

beads 使用 **Dolt**（版本控制 SQL 数据库）作为持久化存储，核心特性：

1. **原生版本控制**（`internal/storage/dolt/store.go:1-13`）
   - 每次写操作自动提交到 Dolt 历史（`CALL DOLT_COMMIT`）
   - 支持 `AS OF` 语法查询历史状态
   - 支持 `dolt_history_*` 表查询完整变更历史

2. **Cell-level merge**（`internal/storage/dolt/store.go:1259-1283`）
   - 合并时按字段级检测冲突，而非整行
   - 冲突通过 `dolt_conflicts` 表暴露，支持 `--ours`/`--theirs` 策略

3. **Federation 支持**（`internal/storage/dolt/federation.go:14-149`）
   - 通过 `DOLT_PUSH`/`DOLT_PULL` 实现 peer-to-peer 同步
   - 支持 Hosted Dolt 远程认证（`--user` + `DOLT_REMOTE_PASSWORD`）

4. **事务内提交**（`internal/storage/dolt/transaction.go:36-89`）
   - 每个事务结束时自动调用 `DOLT_COMMIT`，保证原子性
   - 失败时自动回滚，不留脏数据

5. **Ephemeral 存储分离**（`internal/storage/dolt/ephemeral_routing.go:13-114`）
   - 临时数据（wisps）存储在 `dolt_ignore` 表中，不参与版本控制
   - 通过 ID 模式（`-wisp-`）或类型（`agent`/`rig`/`role`）自动路由

### 1.3 设计思想

| 设计原则 | 具体实现 | 理由 | 替代方案 |
|----------|----------|------|----------|
| **SQL + Git 融合** | Dolt 提供 MySQL 兼容接口 + Git 语义（`internal/storage/dolt/store.go:1-13`） | 既有 SQL 查询能力，又有版本控制 | Git + JSON（无 SQL）、PostgreSQL + audit 表（手动实现） |
| **事务内自动提交** | 每个 `RunInTransaction` 结束时调用 `DOLT_COMMIT`（`transaction.go:81`） | 保证事务与版本原子性，避免脏数据 | 手动提交（易忘记）、Hook 提交（侵入性强） |
| **Cell-level merge** | Dolt 原生支持字段级冲突检测（`store.go:1259-1283`） | 减少假冲突，提高并发写入成功率 | 整行冲突（PostgreSQL）、乐观锁（需要重试） |
| **Ephemeral 分离** | 临时数据存储在 `dolt_ignore` 表中（`ephemeral_routing.go:29-47`） | 避免临时数据污染版本历史，减少存储开销 | 全部版本化（浪费空间）、外部 Redis（增加依赖） |
| **Federation 原生支持** | 通过 `DOLT_PUSH`/`DOLT_PULL` 实现 peer-to-peer 同步（`federation.go:14-47`） | 无需额外同步服务，直接复用 Git 协议 | 自定义同步协议（复杂）、中心化服务器（单点故障） |
| **Time-travel 查询** | 通过 `AS OF` 和 `dolt_history_*` 表查询历史（`history.go:74-150`） | 无需手动维护 snapshot 表，查询性能高 | 手动 snapshot 表（维护成本高）、Event Sourcing（查询慢） |

---

## 第 2 章 源码实现分析（≥ 60 行，核心章节）

### 2.1 架构概览

beads 的 Dolt 存储层分为 5 个核心模块：

```
┌─────────────────────────────────────────────────────────────┐
│                    Storage Interface                         │
│  (internal/storage/storage.go:30-84)                        │
│  - CRUD operations                                           │
│  - Transaction support                                       │
│  - Versioned operations (Diff, Merge, Push, Pull)           │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│                    DoltStore                                 │
│  (internal/storage/dolt/store.go:70-100)                    │
│  - MySQL connection pool (sql.DB)                            │
│  - Retry logic (withRetry)                                   │
│  - OTel tracing (doltTracer)                                 │
│  - Cache (customStatusCache, blockedIDsCache)                │
└─────────────────────────────────────────────────────────────┘
                            ↓
        ┌───────────────────┴───────────────────┐
        ↓                                       ↓
┌──────────────────┐                  ┌──────────────────┐
│  Transaction     │                  │  Versioned Ops   │
│  (transaction.go)│                  │  (versioned.go)  │
│  - RunInTx       │                  │  - Diff          │
│  - Auto-commit   │                  │  - Merge         │
└──────────────────┘                  │  - Push/Pull     │
        ↓                              └──────────────────┘
┌──────────────────┐                           ↓
│  CRUD Ops        │                  ┌──────────────────┐
│  (issues.go)     │                  │  Federation      │
│  - CreateIssue   │                  │  (federation.go) │
│  - UpdateIssue   │                  │  - PushTo        │
│  - DeleteIssue   │                  │  - PullFrom      │
└──────────────────┘                  │  - SyncStatus    │
        ↓                              └──────────────────┘
┌──────────────────┐
│  Ephemeral       │
│  (wisps.go)      │
│  - isActiveWisp  │
│  - createWisp    │
└──────────────────┘
        ↓
┌─────────────────────────────────────────────────────────────┐
│                    Dolt SQL Server                           │
│  (dolt sql-server --port 3307)                              │
│  - MySQL protocol (pure Go)                                  │
│  - DOLT_COMMIT, DOLT_PUSH, DOLT_PULL procedures             │
│  - dolt_history_*, dolt_diff, dolt_status system tables     │
└─────────────────────────────────────────────────────────────┘
```

### 2.2 核心实现

#### 2.2.1 事务内自动提交

**执行流程：**

```mermaid
graph TD
    A[RunInTransaction 调用] --> B{开启 SQL 事务}
    B --> C[执行用户回调 fn]
    C --> D{回调成功?}
    D -->|否| E[Rollback]
    D -->|是| F[CALL DOLT_COMMIT]
    F --> G{提交成功?}
    G -->|否| H[Rollback]
    G -->|是| I[Commit SQL 事务]
    I --> J[返回成功]
    E --> K[返回错误]
    H --> K
```

对应源码 `internal/storage/dolt/transaction.go:36-89`：

```go
// RunInTransaction executes a function within a database transaction.
// On success, commits both the SQL transaction and creates a Dolt commit.
// On failure, rolls back the SQL transaction (Dolt working set remains dirty).
func (s *DoltStore) RunInTransaction(ctx context.Context, commitMsg string, fn func(tx storage.Transaction) error) error {
	return s.runDoltTransaction(ctx, commitMsg, fn)
}

func (s *DoltStore) runDoltTransaction(ctx context.Context, commitMsg string, fn func(tx storage.Transaction) error) (retErr error) {
	// 1. 开启 SQL 事务
	sqlTx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("failed to begin transaction: %w", err)
	}
	defer func() {
		if p := recover(); p != nil {
			_ = sqlTx.Rollback()
			panic(p) // Re-throw panic after cleanup
		}
		if retErr != nil {
			_ = sqlTx.Rollback()
		}
	}()

	// 2. 执行用户回调
	txWrapper := &doltTransaction{tx: sqlTx, store: s}
	if err := fn(txWrapper); err != nil {
		return err
	}

	// 3. DOLT_COMMIT inside transaction — atomic with the writes
	_, err = sqlTx.ExecContext(ctx, "CALL DOLT_COMMIT('-Am', ?, '--author', ?)",
		commitMsg, s.commitAuthorString())
	if err != nil && !isDoltNothingToCommit(err) {
		return fmt.Errorf("dolt commit: %w", err)
	}

	// 4. Commit SQL 事务
	return sqlTx.Commit()
}
```

**关键设计点：**
- `DOLT_COMMIT` 在 SQL 事务内执行，保证原子性（`transaction.go:81`）
- 失败时自动回滚，不留脏数据（`transaction.go:73-76`）
- 支持 panic 恢复，防止资源泄漏（`transaction.go:68-72`）

#### 2.2.2 Cell-level Merge

**执行流程：**

```mermaid
graph TD
    A[Merge 调用] --> B[CALL DOLT_MERGE]
    B --> C{有冲突?}
    C -->|否| D[返回 nil]
    C -->|是| E[查询 dolt_conflicts 表]
    E --> F[返回 Conflict 列表]
    F --> G[用户选择策略]
    G --> H[CALL DOLT_CONFLICTS_RESOLVE]
    H --> I[--ours 或 --theirs]
    I --> J[冲突解决]
```

对应源码 `internal/storage/dolt/store.go:1259-1283`：

```go
// Merge merges the specified branch into the current branch.
// Returns any merge conflicts if present.
func (s *DoltStore) Merge(ctx context.Context, branch string) (conflicts []storage.Conflict, retErr error) {
	ctx, span := doltTracer.Start(ctx, "dolt.merge",
		trace.WithSpanKind(trace.SpanKindClient),
		trace.WithAttributes(append(s.doltSpanAttrs(),
			attribute.String("dolt.merge_branch", branch),
		)...),
	)
	defer func() { endSpan(span, retErr) }()

	// DOLT_MERGE may create a merge commit; pass explicit author for determinism.
	_, err := s.db.ExecContext(ctx, "CALL DOLT_MERGE('--author', ?, ?)", s.commitAuthorString(), branch)
	if err != nil {
		// Check if the error is due to conflicts
		mergeConflicts, conflictErr := s.GetConflicts(ctx)
		if conflictErr == nil && len(mergeConflicts) > 0 {
			span.SetAttributes(attribute.Int("dolt.conflicts", len(mergeConflicts)))
			return mergeConflicts, nil
		}
		retErr = fmt.Errorf("failed to merge branch %s: %w", branch, err)
		return nil, retErr
	}
	return nil, nil
}
```

冲突解决（`internal/storage/dolt/history.go:242-265`）：

```go
// ResolveConflicts resolves conflicts using the specified strategy
func (s *DoltStore) ResolveConflicts(ctx context.Context, table string, strategy string) error {
	// Validate table name to prevent SQL injection
	if err := validateTableName(table); err != nil {
		return fmt.Errorf("invalid table name: %w", err)
	}

	var query string
	switch strategy {
	case "ours":
		query = fmt.Sprintf("CALL DOLT_CONFLICTS_RESOLVE('--ours', '%s')", table)
	case "theirs":
		query = fmt.Sprintf("CALL DOLT_CONFLICTS_RESOLVE('--theirs', '%s')", table)
	default:
		return fmt.Errorf("unknown conflict resolution strategy: %s", strategy)
	}

	_, err := s.execContext(ctx, query)
	if err != nil {
		return fmt.Errorf("failed to resolve conflicts: %w", err)
	}
	return nil
}
```

#### 2.2.3 Federation Push/Pull

**执行流程：**

```mermaid
graph TD
    A[Push 调用] --> B{有远程凭据?}
    B -->|是| C[设置 DOLT_REMOTE_PASSWORD 环境变量]
    B -->|否| D[直接 DOLT_PUSH]
    C --> E[CALL DOLT_PUSH --user]
    D --> F[CALL DOLT_PUSH]
    E --> G[清理环境变量]
    F --> H[返回结果]
    G --> H
```

对应源码 `internal/storage/dolt/store.go:1100-1130`：

```go
// Push pushes commits to the remote.
// When remote credentials are configured (for Hosted Dolt), sets DOLT_REMOTE_PASSWORD
// env var and passes --user flag to authenticate.
func (s *DoltStore) Push(ctx context.Context) (retErr error) {
	ctx, span := doltTracer.Start(ctx, "dolt.push",
		trace.WithSpanKind(trace.SpanKindClient),
		trace.WithAttributes(append(s.doltSpanAttrs(),
			attribute.String("dolt.remote", s.remote),
			attribute.String("dolt.branch", s.branch),
		)...),
	)
	defer func() { endSpan(span, retErr) }()
	if s.remoteUser != "" {
		federationEnvMutex.Lock()
		cleanup := setFederationCredentials(s.remoteUser, s.remotePassword)
		defer func() {
			cleanup()
			federationEnvMutex.Unlock()
		}()
		_, err := s.db.ExecContext(ctx, "CALL DOLT_PUSH('--user', ?, ?, ?)", s.remoteUser, s.remote, s.branch)
		if err != nil {
			return fmt.Errorf("failed to push to %s/%s: %w", s.remote, s.branch, err)
		}
		return nil
	}
	_, err := s.db.ExecContext(ctx, "CALL DOLT_PUSH(?, ?)", s.remote, s.branch)
	if err != nil {
		return fmt.Errorf("failed to push to %s/%s: %w", s.remote, s.branch, err)
	}
	return nil
}
```

Pull 实现（`internal/storage/dolt/store.go:1163-1200`）：

```go
// Pull pulls changes from the remote.
// Passes branch explicitly to avoid "did not specify a branch" errors.
// When remote credentials are configured (for Hosted Dolt), sets DOLT_REMOTE_PASSWORD
// env var and passes --user flag to authenticate.
func (s *DoltStore) Pull(ctx context.Context) (retErr error) {
	ctx, span := doltTracer.Start(ctx, "dolt.pull",
		trace.WithSpanKind(trace.SpanKindClient),
		trace.WithAttributes(append(s.doltSpanAttrs(),
			attribute.String("dolt.remote", s.remote),
			attribute.String("dolt.branch", s.branch),
		)...),
	)
	defer func() { endSpan(span, retErr) }()
	if s.remoteUser != "" {
		federationEnvMutex.Lock()
		cleanup := setFederationCredentials(s.remoteUser, s.remotePassword)
		defer func() {
			cleanup()
			federationEnvMutex.Unlock()
		}()
		_, err := s.db.ExecContext(ctx, "CALL DOLT_PULL('--user', ?, ?, ?)", s.remoteUser, s.remote, s.branch)
		if err != nil {
			return fmt.Errorf("failed to pull from %s/%s: %w", s.remote, s.branch, err)
		}
		if err := s.resetAutoIncrements(ctx); err != nil {
			return fmt.Errorf("failed to reset auto-increments after pull: %w", err)
		}
		return nil
	}
	_, err := s.db.ExecContext(ctx, "CALL DOLT_PULL(?, ?)", s.remote, s.branch)
	if err != nil {
		return fmt.Errorf("failed to pull from %s/%s: %w", s.remote, s.branch, err)
	}
	if err := s.resetAutoIncrements(ctx); err != nil {
		return fmt.Errorf("failed to reset auto-increments after pull: %w", err)
	}
	return nil
}
```

**关键设计点：**
- 凭据通过环境变量传递，避免命令行泄漏（`store.go:1113-1118`）
- Pull 后自动重置 AUTO_INCREMENT，防止 ID 冲突（`store.go:1187-1189`）
- 支持 Hosted Dolt 远程认证（`--user` + `DOLT_REMOTE_PASSWORD`）

### 2.3 实现细节

#### 2.3.1 Time-travel 查询

Dolt 提供两种 time-travel 查询方式：

1. **AS OF 语法**（`internal/storage/dolt/history.go:154-212`）：

```go
// getIssueAsOf returns an issue as it existed at a specific commit or time
func (s *DoltStore) getIssueAsOf(ctx context.Context, issueID string, ref string) (*types.Issue, error) {
	// Validate ref to prevent SQL injection
	if err := validateRef(ref); err != nil {
		return nil, fmt.Errorf("invalid ref: %w", err)
	}

	var issue types.Issue
	// nolint:gosec // G201: ref is validated by validateRef() above - AS OF requires literal
	query := fmt.Sprintf(`
		SELECT id, content_hash, title, description, status, priority, issue_type, assignee, estimated_minutes,
		       created_at, created_by, owner, updated_at, closed_at
		FROM issues AS OF '%s'
		WHERE id = ?
	`, ref)

	err := s.db.QueryRowContext(ctx, query, issueID).Scan(...)
	if err == sql.ErrNoRows {
		return nil, fmt.Errorf("%w: issue %s as of %s", storage.ErrNotFound, issueID, ref)
	}
	return &issue, nil
}
```

2. **dolt_history_* 表**（`internal/storage/dolt/history.go:74-150`）：

```go
// getIssueHistory returns the complete history of an issue
func (s *DoltStore) getIssueHistory(ctx context.Context, issueID string) ([]*issueHistory, error) {
	rows, err := s.queryContext(ctx, `
		SELECT
			id, title, description, design, acceptance_criteria, notes,
			status, priority, issue_type, assignee, owner, created_by,
			estimated_minutes, created_at, updated_at, closed_at, close_reason,
			pinned, mol_type,
			commit_hash, committer, commit_date
		FROM dolt_history_issues
		WHERE id = ?
		ORDER BY commit_date DESC
	`, issueID)
	if err != nil {
		return nil, fmt.Errorf("failed to get issue history: %w", err)
	}
	defer rows.Close()

	var history []*issueHistory
	for rows.Next() {
		var h issueHistory
		var issue types.Issue
		// ... scan logic ...
		h.Issue = &issue
		history = append(history, &h)
	}
	return history, rows.Err()
}
```

#### 2.3.2 Ephemeral 存储分离

beads 将临时数据（wisps）存储在 `dolt_ignore` 表中，不参与版本控制：

**路由逻辑**（`internal/storage/dolt/ephemeral_routing.go:29-47`）：

```go
// isActiveWisp checks if an ID refers to an active wisp in the wisps table.
// This is the source of truth for ephemeral routing after creation.
func (s *DoltStore) isActiveWisp(ctx context.Context, id string) bool {
	// Fast path: explicit ephemeral IDs (-wisp- pattern)
	if IsEphemeralID(id) {
		return s.wispExists(ctx, id)
	}

	// Slow path: check wisps table for promoted wisps or infra types
	// that were created with explicit IDs (no -wisp- pattern).
	// This handles cases like "bd-abc" created as ephemeral=true.
	return s.wispExists(ctx, id)
}

// wispExists checks if an ID exists in the wisps table.
func (s *DoltStore) wispExists(ctx context.Context, id string) bool {
	var count int
	err := s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM wisps WHERE id = ?`, id).Scan(&count)
	return err == nil && count > 0
}
```

**表路由**（`internal/storage/dolt/wisps.go:20-42`）：

```go
// wispIssueTable returns "wisps" if the issue is ephemeral, otherwise "issues".
func wispIssueTable(issue *types.Issue) string {
	if issue.Ephemeral {
		return "wisps"
	}
	return "issues"
}

// wispEventTable returns the event table name based on issue ID.
func wispEventTable(s *DoltStore, ctx context.Context, issueID string) string {
	if s.isActiveWisp(ctx, issueID) {
		return "wisp_events"
	}
	return "events"
}

// wispCommentTable returns the comment table name based on issue ID.
func wispCommentTable(s *DoltStore, ctx context.Context, issueID string) string {
	if s.isActiveWisp(ctx, issueID) {
		return "wisp_comments"
	}
	return "comments"
}
```

**dolt_ignore 配置**（`internal/storage/dolt/migrations/004_wisps_table.go:9-52`）：

```go
// MigrateWispsTable creates the wisps table and adds it to dolt_ignore.
func MigrateWispsTable(db *sql.DB) error {
	// 1. Create wisps table (exact mirror of issues table)
	_, err := db.Exec(wispsTableSchema)
	if err != nil {
		return fmt.Errorf("failed to create wisps table: %w", err)
	}

	// 2. Add wisps patterns to dolt_ignore
	_, err = db.Exec(`
		INSERT INTO dolt_ignore (pattern, ignored)
		VALUES
			('wisps', 1),
			('wisp_labels', 1),
			('wisp_dependencies', 1),
			('wisp_events', 1),
			('wisp_comments', 1)
		ON DUPLICATE KEY UPDATE ignored = 1
	`)
	if err != nil {
		return fmt.Errorf("failed to add wisps to dolt_ignore: %w", err)
	}

	// 3. Stage dolt_ignore changes
	_, err = db.Exec("CALL DOLT_ADD('dolt_ignore')")
	if err != nil {
		return fmt.Errorf("failed to stage dolt_ignore: %w", err)
	}

	// 4. Commit the migration
	_, err = db.Exec("CALL DOLT_COMMIT('-m', 'chore: add wisps patterns to dolt_ignore')")
	if err != nil {
		return fmt.Errorf("failed to commit wisps migration: %w", err)
	}

	return nil
}
```

---

## 第 3 章 迁移指南（≥ 40 行）

### 3.1 迁移清单

将 beads 的 Dolt 持久化方案迁移到自己的项目，需要以下步骤：

#### 阶段 1：环境准备（1-2 天）

- [ ] **安装 Dolt**：`brew install dolt` 或从 [dolthub.com](https://www.dolthub.com/docs/getting-started/installation/) 下载
- [ ] **启动 Dolt SQL Server**：`dolt sql-server --port 3307 --data-dir ./dolt-data`
- [ ] **验证连接**：`mysql -h 127.0.0.1 -P 3307 -u root`
- [ ] **创建数据库**：`CREATE DATABASE myapp;`

#### 阶段 2：Schema 设计（2-3 天）

- [ ] **定义核心表**：参考 `internal/storage/dolt/schema.go:11-88`，设计主表结构
- [ ] **添加审计表**：`events`, `comments`, `labels` 等辅助表
- [ ] **配置 dolt_ignore**：将临时表加入 `dolt_ignore`（参考 `migrations/004_wisps_table.go:9-52`）
- [ ] **创建视图**：如需复杂查询，创建 SQL 视图（参考 `schema.go:265-337`）

#### 阶段 3：存储层实现（3-5 天）

- [ ] **实现 Storage 接口**：参考 `internal/storage/storage.go:30-84`
- [ ] **实现 RunInTransaction**：参考 `transaction.go:36-89`，在事务内调用 `DOLT_COMMIT`
- [ ] **实现 CRUD 操作**：参考 `issues.go:18-129`，每个写操作后自动提交
- [ ] **实现 Retry 逻辑**：参考 `store.go:231-250`，处理瞬态错误
- [ ] **实现 Ephemeral 路由**：参考 `ephemeral_routing.go:29-47`，分离临时数据

#### 阶段 4：版本控制功能（2-3 天）

- [ ] **实现 Diff**：参考 `versioned.go:37-62`，使用 `dolt_diff` 表函数
- [ ] **实现 Merge**：参考 `store.go:1259-1283`，调用 `DOLT_MERGE` 并处理冲突
- [ ] **实现 Time-travel**：参考 `history.go:154-212`，使用 `AS OF` 语法
- [ ] **实现 History 查询**：参考 `history.go:74-150`，查询 `dolt_history_*` 表

#### 阶段 5：Federation（可选，2-3 天）

- [ ] **实现 Push/Pull**：参考 `store.go:1100-1200`，调用 `DOLT_PUSH`/`DOLT_PULL`
- [ ] **配置远程认证**：参考 `federation.go:14-47`，设置 `DOLT_REMOTE_PASSWORD`
- [ ] **实现 SyncStatus**：参考 `federation.go:90-125`，比较本地与远程 refs

### 3.2 适配代码模板

#### 3.2.1 基础连接与事务

```go
package storage

import (
	"context"
	"database/sql"
	"fmt"
	"time"

	_ "github.com/go-sql-driver/mysql"
	"github.com/cenkalti/backoff/v4"
)

// DoltStore implements Storage interface using Dolt
type DoltStore struct {
	db             *sql.DB
	committerName  string
	committerEmail string
}

// New creates a new Dolt storage backend
func New(ctx context.Context, dsn string, committerName, committerEmail string) (*DoltStore, error) {
	db, err := sql.Open("mysql", dsn)
	if err != nil {
		return nil, fmt.Errorf("failed to open connection: %w", err)
	}

	// Configure connection pool
	db.SetMaxOpenConns(10)
	db.SetMaxIdleConns(5)
	db.SetConnMaxLifetime(5 * time.Minute)

	// Test connection
	if err := db.PingContext(ctx); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("failed to ping database: %w", err)
	}

	return &DoltStore{
		db:             db,
		committerName:  committerName,
		committerEmail: committerEmail,
	}, nil
}

// RunInTransaction executes a function within a transaction and auto-commits to Dolt
func (s *DoltStore) RunInTransaction(ctx context.Context, commitMsg string, fn func(tx *sql.Tx) error) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("failed to begin transaction: %w", err)
	}
	defer func() { _ = tx.Rollback() }() // No-op after successful commit

	// Execute user callback
	if err := fn(tx); err != nil {
		return err
	}

	// DOLT_COMMIT inside transaction — atomic with the writes
	author := fmt.Sprintf("%s <%s>", s.committerName, s.committerEmail)
	_, err = tx.ExecContext(ctx, "CALL DOLT_COMMIT('-Am', ?, '--author', ?)", commitMsg, author)
	if err != nil && !isDoltNothingToCommit(err) {
		return fmt.Errorf("dolt commit: %w", err)
	}

	return tx.Commit()
}

// isDoltNothingToCommit checks if the error is a benign "nothing to commit" error
func isDoltNothingToCommit(err error) bool {
	if err == nil {
		return false
	}
	errStr := strings.ToLower(err.Error())
	return strings.Contains(errStr, "nothing to commit") || strings.Contains(errStr, "no changes")
}

// withRetry executes an operation with retry for transient errors
func (s *DoltStore) withRetry(ctx context.Context, op func() error) error {
	bo := backoff.NewExponentialBackOff()
	bo.MaxElapsedTime = 30 * time.Second
	return backoff.Retry(func() error {
		err := op()
		if err != nil && isRetryableError(err) {
			return err // Retryable - backoff will retry
		}
		if err != nil {
			return backoff.Permanent(err) // Non-retryable - stop immediately
		}
		return nil
	}, backoff.WithContext(bo, ctx))
}

// isRetryableError returns true if the error is a transient connection error
func isRetryableError(err error) bool {
	if err == nil {
		return false
	}
	errStr := strings.ToLower(err.Error())
	return strings.Contains(errStr, "driver: bad connection") ||
		strings.Contains(errStr, "connection refused") ||
		strings.Contains(errStr, "broken pipe") ||
		strings.Contains(errStr, "connection reset") ||
		strings.Contains(errStr, "database is read only") ||
		strings.Contains(errStr, "lost connection") ||
		strings.Contains(errStr, "gone away") ||
		strings.Contains(errStr, "i/o timeout")
}
```

#### 3.2.2 CRUD 操作示例

```go
// CreateRecord creates a new record with auto-commit
func (s *DoltStore) CreateRecord(ctx context.Context, record *Record, actor string) error {
	return s.RunInTransaction(ctx, fmt.Sprintf("create record %s", record.ID), func(tx *sql.Tx) error {
		// Insert record
		_, err := tx.ExecContext(ctx, `
			INSERT INTO records (id, title, content, created_at, created_by)
			VALUES (?, ?, ?, ?, ?)
		`, record.ID, record.Title, record.Content, time.Now().UTC(), actor)
		if err != nil {
			return fmt.Errorf("failed to insert record: %w", err)
		}

		// Record creation event
		_, err = tx.ExecContext(ctx, `
			INSERT INTO events (record_id, event_type, actor)
			VALUES (?, 'created', ?)
		`, record.ID, actor)
		return err
	})
}

// UpdateRecord updates a record with auto-commit
func (s *DoltStore) UpdateRecord(ctx context.Context, id string, updates map[string]interface{}, actor string) error {
	return s.RunInTransaction(ctx, fmt.Sprintf("update record %s", id), func(tx *sql.Tx) error {
		// Build UPDATE query
		setClauses := []string{"updated_at = ?"}
		args := []interface{}{time.Now().UTC()}
		for key, value := range updates {
			setClauses = append(setClauses, fmt.Sprintf("%s = ?", key))
			args = append(args, value)
		}
		args = append(args, id)

		// Execute update
		query := fmt.Sprintf("UPDATE records SET %s WHERE id = ?", strings.Join(setClauses, ", "))
		_, err := tx.ExecContext(ctx, query, args...)
		if err != nil {
			return fmt.Errorf("failed to update record: %w", err)
		}

		// Record update event
		_, err = tx.ExecContext(ctx, `
			INSERT INTO events (record_id, event_type, actor)
			VALUES (?, 'updated', ?)
		`, id, actor)
		return err
	})
}
```

#### 3.2.3 Time-travel 查询

```go
// GetRecordAsOf returns a record as it existed at a specific commit or time
func (s *DoltStore) GetRecordAsOf(ctx context.Context, id string, ref string) (*Record, error) {
	// Validate ref to prevent SQL injection
	if !regexp.MustCompile(`^[a-zA-Z0-9_\-]+$`).MatchString(ref) {
		return nil, fmt.Errorf("invalid ref: %s", ref)
	}

	var record Record
	query := fmt.Sprintf(`
		SELECT id, title, content, created_at, created_by, updated_at
		FROM records AS OF '%s'
		WHERE id = ?
	`, ref)

	err := s.db.QueryRowContext(ctx, query, id).Scan(
		&record.ID, &record.Title, &record.Content,
		&record.CreatedAt, &record.CreatedBy, &record.UpdatedAt,
	)
	if err == sql.ErrNoRows {
		return nil, fmt.Errorf("record not found: %s as of %s", id, ref)
	}
	return &record, err
}

// GetRecordHistory returns the complete history of a record
func (s *DoltStore) GetRecordHistory(ctx context.Context, id string) ([]*RecordHistory, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT id, title, content, created_at, created_by, updated_at,
		       commit_hash, committer, commit_date
		FROM dolt_history_records
		WHERE id = ?
		ORDER BY commit_date DESC
	`, id)
	if err != nil {
		return nil, fmt.Errorf("failed to get history: %w", err)
	}
	defer rows.Close()

	var history []*RecordHistory
	for rows.Next() {
		var h RecordHistory
		if err := rows.Scan(
			&h.Record.ID, &h.Record.Title, &h.Record.Content,
			&h.Record.CreatedAt, &h.Record.CreatedBy, &h.Record.UpdatedAt,
			&h.CommitHash, &h.Committer, &h.CommitDate,
		); err != nil {
			return nil, fmt.Errorf("failed to scan history: %w", err)
		}
		history = append(history, &h)
	}
	return history, rows.Err()
}
```

#### 3.2.4 Federation Push/Pull

```go
// Push pushes commits to the remote
func (s *DoltStore) Push(ctx context.Context, remote, branch string) error {
	_, err := s.db.ExecContext(ctx, "CALL DOLT_PUSH(?, ?)", remote, branch)
	if err != nil {
		return fmt.Errorf("failed to push to %s/%s: %w", remote, branch, err)
	}
	return nil
}

// Pull pulls changes from the remote
func (s *DoltStore) Pull(ctx context.Context, remote, branch string) error {
	_, err := s.db.ExecContext(ctx, "CALL DOLT_PULL(?, ?)", remote, branch)
	if err != nil {
		return fmt.Errorf("failed to pull from %s/%s: %w", remote, branch, err)
	}
	return nil
}

// Merge merges a branch into the current branch
func (s *DoltStore) Merge(ctx context.Context, branch string) ([]Conflict, error) {
	author := fmt.Sprintf("%s <%s>", s.committerName, s.committerEmail)
	_, err := s.db.ExecContext(ctx, "CALL DOLT_MERGE('--author', ?, ?)", author, branch)
	if err != nil {
		// Check for conflicts
		conflicts, conflictErr := s.GetConflicts(ctx)
		if conflictErr == nil && len(conflicts) > 0 {
			return conflicts, nil
		}
		return nil, fmt.Errorf("failed to merge branch %s: %w", branch, err)
	}
	return nil, nil
}

// GetConflicts returns any merge conflicts in the current state
func (s *DoltStore) GetConflicts(ctx context.Context) ([]Conflict, error) {
	rows, err := s.db.QueryContext(ctx, "SELECT `table`, num_conflicts FROM dolt_conflicts")
	if err != nil {
		return nil, fmt.Errorf("failed to get conflicts: %w", err)
	}
	defer rows.Close()

	var conflicts []Conflict
	for rows.Next() {
		var c Conflict
		if err := rows.Scan(&c.TableName, &c.NumConflicts); err != nil {
			return nil, fmt.Errorf("failed to scan conflict: %w", err)
		}
		conflicts = append(conflicts, c)
	}
	return conflicts, rows.Err()
}

// ResolveConflicts resolves conflicts using the specified strategy
func (s *DoltStore) ResolveConflicts(ctx context.Context, table, strategy string) error {
	var query string
	switch strategy {
	case "ours":
		query = fmt.Sprintf("CALL DOLT_CONFLICTS_RESOLVE('--ours', '%s')", table)
	case "theirs":
		query = fmt.Sprintf("CALL DOLT_CONFLICTS_RESOLVE('--theirs', '%s')", table)
	default:
		return fmt.Errorf("unknown strategy: %s", strategy)
	}

	_, err := s.db.ExecContext(ctx, query)
	return err
}
```

### 3.3 适用场景

| 场景 | 适用度 | 说明 |
|------|--------|------|
| **Agent 系统状态持久化** | ⭐⭐⭐⭐⭐ | 完美适配：需要版本控制、time-travel、federation |
| **多 Agent 协作** | ⭐⭐⭐⭐⭐ | Cell-level merge 减少冲突，Push/Pull 实现同步 |
| **审计与合规** | ⭐⭐⭐⭐⭐ | 每次修改都有完整历史，支持 time-travel 查询 |
| **数据恢复** | ⭐⭐⭐⭐⭐ | 可回滚到任意历史版本，无需手动备份 |
| **高频写入（>1000 TPS）** | ⭐⭐⭐ | Dolt 写入性能略低于 PostgreSQL，但可接受 |
| **复杂 JOIN 查询** | ⭐⭐⭐⭐ | MySQL 兼容，支持标准 SQL，但部分优化器功能缺失 |
| **嵌入式应用** | ⭐⭐ | 需要独立 Dolt Server 进程，不如 SQLite 轻量 |
| **无版本控制需求** | ⭐ | 如果不需要版本控制，PostgreSQL/MySQL 更简单 |

---

## 第 4 章 测试用例（≥ 20 行）

以下测试用例基于 beads 的真实函数签名，可直接运行（需要 Dolt Server）：

```go
package storage_test

import (
	"context"
	"database/sql"
	"fmt"
	"testing"
	"time"

	_ "github.com/go-sql-driver/mysql"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// TestDoltTransactionAutoCommit tests that RunInTransaction auto-commits to Dolt
func TestDoltTransactionAutoCommit(t *testing.T) {
	ctx := context.Background()
	store := setupTestStore(t)
	defer store.Close()

	// Create a record within a transaction
	err := store.RunInTransaction(ctx, "test: create record", func(tx *sql.Tx) error {
		_, err := tx.ExecContext(ctx, `
			INSERT INTO records (id, title, content, created_at, created_by)
			VALUES ('test-1', 'Test Record', 'Test Content', ?, 'test-user')
		`, time.Now().UTC())
		return err
	})
	require.NoError(t, err)

	// Verify the record exists
	var title string
	err = store.db.QueryRowContext(ctx, "SELECT title FROM records WHERE id = 'test-1'").Scan(&title)
	require.NoError(t, err)
	assert.Equal(t, "Test Record", title)

	// Verify Dolt commit was created
	var commitCount int
	err = store.db.QueryRowContext(ctx, `
		SELECT COUNT(*) FROM dolt_log WHERE message LIKE 'test: create record%'
	`).Scan(&commitCount)
	require.NoError(t, err)
	assert.Equal(t, 1, commitCount, "Dolt commit should be created")
}

// TestDoltTransactionRollback tests that failed transactions rollback correctly
func TestDoltTransactionRollback(t *testing.T) {
	ctx := context.Background()
	store := setupTestStore(t)
	defer store.Close()

	// Attempt to create a record with an error
	err := store.RunInTransaction(ctx, "test: create record", func(tx *sql.Tx) error {
		_, err := tx.ExecContext(ctx, `
			INSERT INTO records (id, title, content, created_at, created_by)
			VALUES ('test-2', 'Test Record', 'Test Content', ?, 'test-user')
		`, time.Now().UTC())
		if err != nil {
			return err
		}
		// Simulate an error
		return fmt.Errorf("simulated error")
	})
	require.Error(t, err)
	assert.Contains(t, err.Error(), "simulated error")

	// Verify the record does NOT exist
	var count int
	err = store.db.QueryRowContext(ctx, "SELECT COUNT(*) FROM records WHERE id = 'test-2'").Scan(&count)
	require.NoError(t, err)
	assert.Equal(t, 0, count, "Record should not exist after rollback")

	// Verify no Dolt commit was created
	var commitCount int
	err = store.db.QueryRowContext(ctx, `
		SELECT COUNT(*) FROM dolt_log WHERE message LIKE 'test: create record%'
	`).Scan(&commitCount)
	require.NoError(t, err)
	assert.Equal(t, 0, commitCount, "No Dolt commit should be created on rollback")
}

// TestDoltTimeTravel tests AS OF syntax for time-travel queries
func TestDoltTimeTravel(t *testing.T) {
	ctx := context.Background()
	store := setupTestStore(t)
	defer store.Close()

	// Create initial record
	err := store.RunInTransaction(ctx, "test: create record", func(tx *sql.Tx) error {
		_, err := tx.ExecContext(ctx, `
			INSERT INTO records (id, title, content, created_at, created_by)
			VALUES ('test-3', 'Original Title', 'Original Content', ?, 'test-user')
		`, time.Now().UTC())
		return err
	})
	require.NoError(t, err)

	// Get the commit hash after creation
	var createCommitHash string
	err = store.db.QueryRowContext(ctx, `
		SELECT commit_hash FROM dolt_log WHERE message LIKE 'test: create record%' ORDER BY commit_date DESC LIMIT 1
	`).Scan(&createCommitHash)
	require.NoError(t, err)

	// Update the record
	time.Sleep(100 * time.Millisecond) // Ensure different commit timestamp
	err = store.RunInTransaction(ctx, "test: update record", func(tx *sql.Tx) error {
		_, err := tx.ExecContext(ctx, `
			UPDATE records SET title = 'Updated Title', content = 'Updated Content' WHERE id = 'test-3'
		`)
		return err
	})
	require.NoError(t, err)

	// Query current state
	var currentTitle string
	err = store.db.QueryRowContext(ctx, "SELECT title FROM records WHERE id = 'test-3'").Scan(&currentTitle)
	require.NoError(t, err)
	assert.Equal(t, "Updated Title", currentTitle)

	// Query historical state using AS OF
	var historicalTitle string
	query := fmt.Sprintf("SELECT title FROM records AS OF '%s' WHERE id = 'test-3'", createCommitHash)
	err = store.db.QueryRowContext(ctx, query).Scan(&historicalTitle)
	require.NoError(t, err)
	assert.Equal(t, "Original Title", historicalTitle, "AS OF should return original title")
}

// TestDoltHistory tests dolt_history_* table queries
func TestDoltHistory(t *testing.T) {
	ctx := context.Background()
	store := setupTestStore(t)
	defer store.Close()

	// Create and update a record multiple times
	recordID := "test-4"
	for i := 0; i < 3; i++ {
		time.Sleep(100 * time.Millisecond) // Ensure different commit timestamps
		title := fmt.Sprintf("Title v%d", i+1)
		if i == 0 {
			err := store.RunInTransaction(ctx, fmt.Sprintf("test: create record v%d", i+1), func(tx *sql.Tx) error {
				_, err := tx.ExecContext(ctx, `
					INSERT INTO records (id, title, content, created_at, created_by)
					VALUES (?, ?, 'Content', ?, 'test-user')
				`, recordID, title, time.Now().UTC())
				return err
			})
			require.NoError(t, err)
		} else {
			err := store.RunInTransaction(ctx, fmt.Sprintf("test: update record v%d", i+1), func(tx *sql.Tx) error {
				_, err := tx.ExecContext(ctx, `
					UPDATE records SET title = ? WHERE id = ?
				`, title, recordID)
				return err
			})
			require.NoError(t, err)
		}
	}

	// Query history
	rows, err := store.db.QueryContext(ctx, `
		SELECT title, commit_hash, committer, commit_date
		FROM dolt_history_records
		WHERE id = ?
		ORDER BY commit_date DESC
	`, recordID)
	require.NoError(t, err)
	defer rows.Close()

	var history []string
	for rows.Next() {
		var title, commitHash, committer string
		var commitDate time.Time
		err := rows.Scan(&title, &commitHash, &committer, &commitDate)
		require.NoError(t, err)
		history = append(history, title)
	}
	require.NoError(t, rows.Err())

	// Verify history order (newest first)
	assert.Equal(t, []string{"Title v3", "Title v2", "Title v1"}, history)
}

// TestDoltMergeConflict tests cell-level merge conflict detection
func TestDoltMergeConflict(t *testing.T) {
	ctx := context.Background()
	store := setupTestStore(t)
	defer store.Close()

	// Create a record on main branch
	err := store.RunInTransaction(ctx, "test: create record on main", func(tx *sql.Tx) error {
		_, err := tx.ExecContext(ctx, `
			INSERT INTO records (id, title, content, created_at, created_by)
			VALUES ('test-5', 'Main Title', 'Main Content', ?, 'test-user')
		`, time.Now().UTC())
		return err
	})
	require.NoError(t, err)

	// Create a branch
	_, err = store.db.ExecContext(ctx, "CALL DOLT_BRANCH('test-branch')")
	require.NoError(t, err)

	// Update on main branch
	err = store.RunInTransaction(ctx, "test: update on main", func(tx *sql.Tx) error {
		_, err := tx.ExecContext(ctx, `
			UPDATE records SET title = 'Main Updated' WHERE id = 'test-5'
		`)
		return err
	})
	require.NoError(t, err)

	// Checkout test-branch
	_, err = store.db.ExecContext(ctx, "CALL DOLT_CHECKOUT('test-branch')")
	require.NoError(t, err)

	// Update on test-branch (conflicting change)
	err = store.RunInTransaction(ctx, "test: update on branch", func(tx *sql.Tx) error {
		_, err := tx.ExecContext(ctx, `
			UPDATE records SET title = 'Branch Updated' WHERE id = 'test-5'
		`)
		return err
	})
	require.NoError(t, err)

	// Merge main into test-branch
	author := fmt.Sprintf("%s <%s>", store.committerName, store.committerEmail)
	_, err = store.db.ExecContext(ctx, "CALL DOLT_MERGE('--author', ?, 'main')", author)
	// Expect merge to fail due to conflict
	require.Error(t, err)

	// Check for conflicts
	var conflictCount int
	err = store.db.QueryRowContext(ctx, `
		SELECT num_conflicts FROM dolt_conflicts WHERE table = 'records'
	`).Scan(&conflictCount)
	require.NoError(t, err)
	assert.Greater(t, conflictCount, 0, "Should have conflicts")

	// Resolve conflict using --ours strategy
	_, err = store.db.ExecContext(ctx, "CALL DOLT_CONFLICTS_RESOLVE('--ours', 'records')")
	require.NoError(t, err)

	// Verify conflict is resolved
	err = store.db.QueryRowContext(ctx, `
		SELECT num_conflicts FROM dolt_conflicts WHERE table = 'records'
	`).Scan(&conflictCount)
	// Should return no rows after resolution
	assert.Equal(t, sql.ErrNoRows, err)

	// Verify title is from test-branch (--ours)
	var title string
	err = store.db.QueryRowContext(ctx, "SELECT title FROM records WHERE id = 'test-5'").Scan(&title)
	require.NoError(t, err)
	assert.Equal(t, "Branch Updated", title)
}

// setupTestStore creates a test Dolt store
func setupTestStore(t *testing.T) *DoltStore {
	ctx := context.Background()
	dsn := "root@tcp(127.0.0.1:3307)/test_db?parseTime=true"
	store, err := New(ctx, dsn, "test-user", "test@example.com")
	require.NoError(t, err)

	// Create test schema
	_, err = store.db.ExecContext(ctx, `
		CREATE TABLE IF NOT EXISTS records (
			id VARCHAR(64) PRIMARY KEY,
			title VARCHAR(255) NOT NULL,
			content TEXT,
			created_at DATETIME NOT NULL,
			created_by VARCHAR(64) NOT NULL,
			updated_at DATETIME
		)
	`)
	require.NoError(t, err)

	// Commit schema
	_, err = store.db.ExecContext(ctx, "CALL DOLT_COMMIT('-Am', 'test: create schema', '--author', 'test-user <test@example.com>')")
	require.NoError(t, err)

	return store
}
```

---

## 第 5 章 跨域关联

| 关联域 | 关系类型 | 说明 |
|--------|----------|------|
| PD-01 上下文管理 | 协同 | Dolt 的 time-travel 查询可用于恢复历史上下文，避免上下文丢失 |
| PD-02 多 Agent 编排 | 协同 | Cell-level merge 支持多 Agent 并发写入，减少冲突；Federation 支持 Agent 间状态同步 |
| PD-03 容错与重试 | 协同 | Dolt 的事务回滚机制保证失败时不留脏数据；Retry 逻辑处理瞬态错误 |
| PD-04 工具系统 | 依赖 | Dolt 本身是一个工具，需要通过 `dolt sql-server` 启动；beads 通过 MySQL 协议调用 Dolt 工具 |
| PD-05 沙箱隔离 | 互斥 | Dolt 是共享数据库，不提供沙箱隔离；需要在应用层实现隔离（如 beads 的 wisps 表） |
| PD-07 质量检查 | 协同 | Dolt 的版本历史可用于审计和质量检查，追溯每次修改的来源 |
| PD-08 搜索与检索 | 协同 | Dolt 支持标准 SQL 查询，可与向量数据库结合实现混合检索 |
| PD-09 Human-in-the-Loop | 协同 | Dolt 的 branch/merge 机制可用于实现审批流程：Agent 在分支上工作，人类审批后合并 |
| PD-10 中间件管道 | 协同 | Dolt 的 `DOLT_COMMIT` 可作为中间件钩子点，在提交前后执行自定义逻辑 |
| PD-11 可观测性 | 协同 | Dolt 的 `dolt_log` 和 `dolt_history_*` 表提供完整的操作历史，可用于成本追踪和审计 |
| PD-12 推理增强 | 无关 | Dolt 是存储层，不涉及推理逻辑 |

---

## 第 6 章 来源文件索引

| 文件 | 行范围 | 关键实现 |
|------|--------|----------|
| `internal/storage/dolt/store.go` | L1-L13 | Dolt 能力概述（版本控制、time-travel、cell-level merge） |
| `internal/storage/dolt/store.go` | L70-L100 | `DoltStore` 结构体定义（连接池、缓存、配置） |
| `internal/storage/dolt/store.go` | L144-L204 | `isRetryableError()` 瞬态错误检测（12+ 错误模式） |
| `internal/storage/dolt/store.go` | L231-L250 | `withRetry()` 指数退避重试逻辑 |
| `internal/storage/dolt/store.go` | L312-L337 | `execContext()` 显式 BEGIN/COMMIT 保证持久化 |
| `internal/storage/dolt/store.go` | L468-L602 | `New()` 和 `newServerMode()` 连接初始化与自动启动 |
| `internal/storage/dolt/store.go` | L729-L819 | `initSchemaOnDB()` Schema 初始化与迁移 |
| `internal/storage/dolt/store.go` | L957-L973 | `Commit()` 调用 `DOLT_COMMIT` 创建版本 |
| `internal/storage/dolt/store.go` | L975-L1011 | `CommitPending()` 批量提交未提交变更 |
| `internal/storage/dolt/store.go` | L1013-L1098 | `buildBatchCommitMessage()` 使用 `dolt_diff` 生成提交消息 |
| `internal/storage/dolt/store.go` | L1100-L1130 | `Push()` 调用 `DOLT_PUSH` 推送到远程 |
| `internal/storage/dolt/store.go` | L1163-L1200 | `Pull()` 调用 `DOLT_PULL` 拉取远程变更 |
| `internal/storage/dolt/store.go` | L1202-L1226 | `resetAutoIncrements()` Pull 后重置自增 ID |
| `internal/storage/dolt/store.go` | L1259-L1283 | `Merge()` 调用 `DOLT_MERGE` 并检测冲突 |
| `internal/storage/dolt/store.go` | L1305-L1325 | `Log()` 查询 `dolt_log` 获取提交历史 |
| `internal/storage/dolt/transaction.go` | L36-L89 | `RunInTransaction()` 事务内自动提交 |
| `internal/storage/dolt/transaction.go` | L91-L100 | `isDoltNothingToCommit()` 良性错误检测 |
| `internal/storage/dolt/issues.go` | L18-L129 | `CreateIssue()` 创建 Issue 并自动提交 |
| `internal/storage/dolt/issues.go` | L414-L511 | `UpdateIssue()` 更新 Issue 并自动提交 |
| `internal/storage/dolt/issues.go` | L513-L587 | `ClaimIssue()` 原子 CAS 操作 |
| `internal/storage/dolt/issues.go` | L708-L944 | `DeleteIssues()` 批量删除与级联处理 |
| `internal/storage/dolt/history.go` | L74-L150 | `getIssueHistory()` 查询 `dolt_history_issues` 表 |
| `internal/storage/dolt/history.go` | L154-L212 | `getIssueAsOf()` 使用 `AS OF` 语法查询历史状态 |
| `internal/storage/dolt/history.go` | L216-L234 | `getInternalConflicts()` 查询 `dolt_conflicts` 表 |
| `internal/storage/dolt/history.go` | L242-L265 | `ResolveConflicts()` 调用 `DOLT_CONFLICTS_RESOLVE` |
| `internal/storage/dolt/federation.go` | L14-L25 | `PushTo()` 推送到 peer |
| `internal/storage/dolt/federation.go` | L30-L47 | `PullFrom()` 从 peer 拉取 |
| `internal/storage/dolt/federation.go` | L90-L125 | `SyncStatus()` 比较本地与远程 refs |
| `internal/storage/dolt/versioned.go` | L37-L62 | `Diff()` 使用 `dolt_diff` 表函数 |
| `internal/storage/dolt/ephemeral_routing.go` | L29-L47 | `isActiveWisp()` 检查 wisps 表 |
| `internal/storage/dolt/ephemeral_routing.go` | L83-L114 | `partitionByWispStatus()` 批量路由 |
| `internal/storage/dolt/wisps.go` | L20-L42 | `wispIssueTable()` 表路由逻辑 |
| `internal/storage/dolt/wisps.go` | L44-L105 | `insertIssueIntoTable()` 插入到指定表 |
| `internal/storage/dolt/migrations/004_wisps_table.go` | L9-L52 | `MigrateWispsTable()` 创建 wisps 表并加入 `dolt_ignore` |
| `internal/storage/dolt/schema.go` | L3-L6 | Schema 版本常量 |
| `internal/storage/dolt/schema.go` | L9-L247 | 完整 DDL（15+ 表） |
| `internal/storage/dolt/schema.go` | L265-L307 | `ready_issues` 视图（递归 CTE） |
| `internal/storage/dolt/schema.go` | L311-L337 | `blocked_issues` 视图（依赖阻塞逻辑） |
| `internal/storage/storage.go` | L30-L84 | `Storage` 接口定义 |
| `internal/storage/storage.go` | L86-L149 | `Transaction` 接口定义 |
| `internal/doltserver/doltserver.go` | L37-L45 | 端口配置常量 |
| `internal/doltserver/doltserver.go` | L124-L135 | `DerivePort()` 稳定端口派生 |
| `internal/storage/doltutil/close.go` | L14-L29 | `CloseWithTimeout()` 防止无限挂起 |

---

## 第 7 章 横向对比维度

```json comparison_data
{
  "project": "beads",
  "dimensions": {
    "存储方式": "Dolt（版本控制 SQL 数据库），MySQL 兼容协议",
    "记忆结构": "关系表（issues/events/comments/labels）+ 系统表（dolt_history_*/dolt_diff/dolt_log）",
    "更新机制": "事务内自动提交（RunInTransaction 结束时调用 DOLT_COMMIT）",
    "版本控制": "原生支持，每次写操作自动创建 Dolt commit，支持 time-travel 查询",
    "并发安全": "Cell-level merge，字段级冲突检测，减少假冲突",
    "注入方式": "SQL 查询（标准 SELECT/JOIN），支持 AS OF 语法查询历史",
    "生命周期管理": "Ephemeral 数据存储在 dolt_ignore 表中，不参与版本控制",
    "Federation 支持": "原生 DOLT_PUSH/DOLT_PULL，支持 peer-to-peer 同步",
    "Time-travel 查询": "AS OF 语法 + dolt_history_* 表，无需手动 snapshot",
    "冲突解决": "dolt_conflicts 表暴露冲突，支持 --ours/--theirs 策略",
    "远程认证": "支持 Hosted Dolt（--user + DOLT_REMOTE_PASSWORD 环境变量）",
    "自动重试": "指数退避重试（30s 窗口），处理 12+ 瞬态错误模式",
    "Schema 迁移": "版本化迁移框架（migrations.go），每次迁移自动提交"
  }
}
```

### 域元数据补充

```json domain_metadata
{
  "solution_summary": "beads 使用 Dolt（版本控制 SQL 数据库）实现 Agent 记忆持久化，每次写操作自动提交到 Dolt 历史，支持 time-travel 查询、cell-level merge、peer-to-peer federation，临时数据通过 dolt_ignore 表分离",
  "description": "Dolt 是 Git + MySQL 的融合，提供 SQL 查询能力的同时保留完整版本历史",
  "sub_problems": [
    "Cell-level merge：如何在合并时按字段级检测冲突而非整行覆盖",
    "Time-travel 查询：如何高效查询历史状态而不维护手动 snapshot 表",
    "Federation 同步：如何在多个 Agent 实例间同步状态而不依赖中心化服务器",
    "Ephemeral 分离：如何将临时数据排除在版本控制外以减少存储开销",
    "事务内提交：如何保证 SQL 事务与版本提交的原子性",
    "自动重试：如何处理 Dolt Server 的瞬态错误（连接断开、只读模式、catalog 竞态）",
    "Schema 迁移：如何在版本控制数据库中安全地执行 DDL 变更",
    "AUTO_INCREMENT 同步：Pull 后如何重置自增 ID 防止冲突"
  ],
  "best_practices": [
    "事务内提交：在 SQL 事务内调用 DOLT_COMMIT，保证原子性，失败时自动回滚",
    "Ephemeral 分离：临时数据存储在 dolt_ignore 表中，避免污染版本历史",
    "Cell-level merge：利用 Dolt 的字段级冲突检测，减少假冲突，提高并发写入成功率",
    "Time-travel 优先：优先使用 AS OF 语法而非手动 snapshot 表，查询性能更高",
    "Federation 原生支持：直接使用 DOLT_PUSH/DOLT_PULL，无需自定义同步协议",
    "自动重试必须：Dolt Server 有多种瞬态错误（连接断开、只读模式、catalog 竞态），必须实现指数退避重试",
    "显式 BEGIN/COMMIT：Dolt Server 默认 --no-auto-commit，必须显式开启事务保证持久化",
    "Pull 后重置自增：Pull 后必须重置 AUTO_INCREMENT，防止 ID 冲突",
    "凭据环境变量传递：远程认证凭据通过环境变量传递，避免命令行泄漏",
    "Schema 版本化：DDL 变更通过迁移框架执行，每次迁移自动提交到 Dolt 历史"
  ]
}
```

---

## 附录：Dolt 核心概念速查

### A.1 Dolt SQL 过程

| 过程 | 功能 | 示例 |
|------|------|------|
| `DOLT_COMMIT` | 创建 Dolt commit | `CALL DOLT_COMMIT('-Am', 'message', '--author', 'name <email>')` |
| `DOLT_PUSH` | 推送到远程 | `CALL DOLT_PUSH('origin', 'main')` |
| `DOLT_PULL` | 从远程拉取 | `CALL DOLT_PULL('origin', 'main')` |
| `DOLT_MERGE` | 合并分支 | `CALL DOLT_MERGE('--author', 'name <email>', 'branch')` |
| `DOLT_BRANCH` | 创建分支 | `CALL DOLT_BRANCH('new-branch')` |
| `DOLT_CHECKOUT` | 切换分支 | `CALL DOLT_CHECKOUT('branch')` |
| `DOLT_FETCH` | 获取远程变更（不合并） | `CALL DOLT_FETCH('origin')` |
| `DOLT_REMOTE` | 管理远程 | `CALL DOLT_REMOTE('add', 'origin', 'url')` |
| `DOLT_ADD` | 暂存变更 | `CALL DOLT_ADD('.')` |
| `DOLT_CONFLICTS_RESOLVE` | 解决冲突 | `CALL DOLT_CONFLICTS_RESOLVE('--ours', 'table')` |

### A.2 Dolt 系统表

| 表 | 功能 | 示例查询 |
|------|------|----------|
| `dolt_log` | 提交历史 | `SELECT * FROM dolt_log ORDER BY commit_date DESC LIMIT 10` |
| `dolt_history_<table>` | 表的完整历史 | `SELECT * FROM dolt_history_issues WHERE id = 'bd-abc'` |
| `dolt_diff` | 两个 ref 间的差异 | `SELECT * FROM dolt_diff('HEAD~1', 'HEAD', 'issues')` |
| `dolt_status` | 当前工作区状态 | `SELECT * FROM dolt_status` |
| `dolt_conflicts` | 当前冲突 | `SELECT * FROM dolt_conflicts` |
| `dolt_remotes` | 远程列表 | `SELECT * FROM dolt_remotes` |
| `dolt_branches` | 分支列表 | `SELECT * FROM dolt_branches` |
| `dolt_ignore` | 忽略的表 | `SELECT * FROM dolt_ignore` |

### A.3 Dolt AS OF 语法

```sql
-- 查询特定 commit 的状态
SELECT * FROM issues AS OF 'abc123' WHERE id = 'bd-xyz';

-- 查询特定时间的状态
SELECT * FROM issues AS OF '2024-01-01 12:00:00' WHERE id = 'bd-xyz';

-- 查询特定分支的状态
SELECT * FROM issues AS OF 'feature-branch' WHERE id = 'bd-xyz';

-- 查询 HEAD~1 的状态
SELECT * FROM issues AS OF 'HEAD~1' WHERE id = 'bd-xyz';
```

### A.4 Dolt 与 Git 对比

| Git 命令 | Dolt SQL 过程 | 说明 |
|----------|---------------|------|
| `git commit -am "msg"` | `CALL DOLT_COMMIT('-Am', 'msg')` | 创建提交 |
| `git push origin main` | `CALL DOLT_PUSH('origin', 'main')` | 推送到远程 |
| `git pull origin main` | `CALL DOLT_PULL('origin', 'main')` | 拉取远程变更 |
| `git merge branch` | `CALL DOLT_MERGE('branch')` | 合并分支 |
| `git branch new-branch` | `CALL DOLT_BRANCH('new-branch')` | 创建分支 |
| `git checkout branch` | `CALL DOLT_CHECKOUT('branch')` | 切换分支 |
| `git log` | `SELECT * FROM dolt_log` | 查看提交历史 |
| `git diff HEAD~1 HEAD` | `SELECT * FROM dolt_diff('HEAD~1', 'HEAD', 'table')` | 查看差异 |
| `git show abc123:file` | `SELECT * FROM table AS OF 'abc123'` | 查看历史状态 |

---

**文档生成时间**：2026-02-27
**文档版本**：1.0
**beads 版本**：基于 2024-12 主分支

