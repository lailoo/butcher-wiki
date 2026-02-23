// CC (Claude Code) 进程管理 — 参考 OpenClaw supervisor 模式

import { spawn, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';

export interface CCRunOptions {
  prompt: string;
  systemPrompt?: string;
  cwd?: string;
  timeoutMs?: number;         // 整体超时，默认 5 分钟
  noOutputTimeoutMs?: number; // 无输出超时，默认 4 分钟
  maxBudgetUsd?: number;      // 成本限制
  allowedTools?: string;      // 允许的工具，默认 'Bash Read Glob Grep'
  disallowedTools?: string;   // 禁用的工具
  skipResultExtraction?: boolean; // 跳过 JSON 结果提取（用于 doc 生成等非 JSON 输出场景）
}

// 结构化工具调用事件（参考 OpenClaw ExecCommandDisplay）
export interface CCToolCallEvent {
  id: string;           // tool_use block id
  tool: string;         // Bash | Read | Glob | Grep
  status: 'running' | 'done' | 'error';
  input: string;        // 命令/路径/模式
  output?: string;      // 工具输出（截断到 2000 字符）
  exitCode?: number;    // Bash 退出码
  durationMs?: number;  // 耗时
  startedAt: number;    // Date.now()
}

export interface CCProgressEvent {
  type: 'phase' | 'log' | 'progress' | 'tool_use' | 'text' | 'result' | 'error' | 'done';
  data: unknown;
}

export class CCRunner extends EventEmitter {
  private proc: ChildProcess | null = null;
  private overallTimer: ReturnType<typeof setTimeout> | null = null;
  private watchdogTimer: ReturnType<typeof setTimeout> | null = null;
  private killed = false;
  private buffer = '';
  private toolCallCount = 0;
  private lastResultText = '';
  private startTime = 0;
  private textGenStarted = false;  // 是否已进入文本生成阶段
  // 追踪活跃的工具调用（id → event）
  private activeToolCalls = new Map<string, CCToolCallEvent>();

  constructor(private options: CCRunOptions) {
    super();
  }

  start(): void {
    const {
      prompt,
      systemPrompt,
      cwd,
      timeoutMs = 300_000,
      noOutputTimeoutMs = 240_000,
      maxBudgetUsd,
      allowedTools = 'Bash Read Glob Grep',
      disallowedTools,
    } = this.options;

    const args: string[] = [
      '-p', prompt,
      '--output-format', 'stream-json',
      '--verbose',
      '--allowedTools', allowedTools,
      '--dangerously-skip-permissions',
      '--no-session-persistence',
    ];

    if (maxBudgetUsd !== undefined) {
      args.push('--max-budget-usd', String(maxBudgetUsd));
    }

    if (disallowedTools) {
      args.push('--disallowedTools', disallowedTools);
    }

    if (systemPrompt) {
      args.push('--system-prompt', systemPrompt);
    }

    this.startTime = Date.now();
    this.proc = spawn('claude', args, {
      cwd: cwd || process.env.HOME || '/tmp',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    // 整体超时
    this.overallTimer = setTimeout(() => {
      this.emitEvent({ type: 'error', data: 'CC 分析超时（5分钟），已终止' });
      this.kill();
    }, timeoutMs);

    // 无输出 watchdog（4 分钟）
    this.resetWatchdog(noOutputTimeoutMs);

    // 监听 stdout
    this.proc.stdout?.on('data', (chunk: Buffer) => {
      this.resetWatchdog(noOutputTimeoutMs);
      this.buffer += chunk.toString();
      this.processBuffer();
    });

    // 监听 stderr（CC 的调试信息）
    this.proc.stderr?.on('data', (chunk: Buffer) => {
      this.resetWatchdog(noOutputTimeoutMs);
      const text = chunk.toString().trim();
      if (text) {
        this.emitEvent({ type: 'log', data: text });
      }
    });

    // 进程退出
    this.proc.on('close', (code) => {
      this.clearTimers();
      // 处理 buffer 中剩余的数据
      if (this.buffer.trim()) {
        try {
          const obj = JSON.parse(this.buffer.trim());
          this.handleStreamEvent(obj);
        } catch { /* ignore */ }
        this.buffer = '';
      }
      // 标记所有还在运行中的工具调用为完成（进程已退出）
      this.activeToolCalls.forEach((toolEvent) => {
        toolEvent.status = 'done';
        toolEvent.durationMs = Date.now() - toolEvent.startedAt;
        this.emitEvent({ type: 'tool_use', data: { ...toolEvent } });
      });
      this.activeToolCalls.clear();

      if (!this.killed) {
        if (code === 0) {
          if (!this.options.skipResultExtraction) {
            this.extractFinalResult();
          }
          const totalMs = Date.now() - this.startTime;
          this.emitEvent({ type: 'log', data: `CC 完成，共 ${this.toolCallCount} 次工具调用，耗时 ${(totalMs / 1000).toFixed(1)}s` });
          this.emitEvent({ type: 'done', data: { totalMs, toolCallCount: this.toolCallCount, resultText: this.lastResultText } });
        } else {
          this.emitEvent({ type: 'error', data: `CC 进程退出，code=${code}` });
          const totalMs = Date.now() - this.startTime;
          this.emitEvent({ type: 'done', data: { totalMs, toolCallCount: this.toolCallCount, exitCode: code, resultText: this.lastResultText } });
        }
      } else {
        const totalMs = Date.now() - this.startTime;
        this.emitEvent({ type: 'done', data: { totalMs, toolCallCount: this.toolCallCount, killed: true, resultText: this.lastResultText } });
      }
    });

    this.proc.on('error', (err) => {
      this.clearTimers();
      this.emitEvent({ type: 'error', data: `无法启动 Claude Code: ${err.message}` });
    });

    // 关闭 stdin
    this.proc.stdin?.end();
  }

  kill(): void {
    if (this.killed || !this.proc) return;
    this.killed = true;
    this.clearTimers();

    // SIGTERM 先礼后兵
    this.proc.kill('SIGTERM');
    setTimeout(() => {
      if (this.proc && !this.proc.killed) {
        this.proc.kill('SIGKILL');
      }
    }, 5000);
  }

  private resetWatchdog(timeoutMs: number): void {
    if (this.watchdogTimer) clearTimeout(this.watchdogTimer);
    this.watchdogTimer = setTimeout(() => {
      this.emitEvent({ type: 'error', data: 'CC 长时间无输出（4分钟），已终止' });
      this.kill();
    }, timeoutMs);
  }

  private clearTimers(): void {
    if (this.overallTimer) clearTimeout(this.overallTimer);
    if (this.watchdogTimer) clearTimeout(this.watchdogTimer);
    this.overallTimer = null;
    this.watchdogTimer = null;
  }

  private emitEvent(event: CCProgressEvent): void {
    this.emit('event', event);
  }

  private processBuffer(): void {
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      try {
        const obj = JSON.parse(trimmed);
        this.handleStreamEvent(obj);
      } catch {
        // 非 JSON 行，作为日志输出
        if (trimmed.length > 0) {
          this.emitEvent({ type: 'log', data: trimmed });
        }
      }
    }
  }

  private handleStreamEvent(obj: Record<string, unknown>): void {
    const type = obj.type as string;

    if (type === 'assistant') {
      const message = obj.message as Record<string, unknown> | undefined;
      const content = (message?.content || obj.content) as Array<Record<string, unknown>> | undefined;
      if (!Array.isArray(content)) return;

      for (const block of content) {
        if (block.type === 'tool_use') {
          this.toolCallCount++;
          const toolId = (block.id as string) || `tool-${this.toolCallCount}`;
          const toolName = block.name as string;
          const input = block.input as Record<string, string> | undefined;
          const inputStr = this.extractToolInput(toolName, input);

          // 调试日志：dump 原始 input
          const rawInput = JSON.stringify(input || {});
          if (!input || Object.keys(input).length === 0) {
            this.emitEvent({ type: 'log', data: `⚠ [${toolName}] 工具调用参数为空! raw block: ${JSON.stringify(block).slice(0, 500)}` });
          } else {
            this.emitEvent({ type: 'log', data: `[${toolName}] input: ${rawInput.slice(0, 200)}` });
          }

          // 创建结构化工具调用事件
          const toolEvent: CCToolCallEvent = {
            id: toolId,
            tool: toolName,
            status: 'running',
            input: inputStr,
            startedAt: Date.now(),
          };
          this.activeToolCalls.set(toolId, toolEvent);

          // 推送 tool_use 开始事件
          this.emitEvent({ type: 'tool_use', data: { ...toolEvent } });

          // 同时更新 phase 和 progress
          this.updatePhaseFromTool(toolName, input);
        } else if (block.type === 'text') {
          const text = block.text as string;
          this.lastResultText += text;
          // 首次收到文本 → 通知 UI 进入分析生成阶段
          if (!this.textGenStarted && this.toolCallCount > 0) {
            this.textGenStarted = true;
            this.emitEvent({ type: 'phase', data: 'analyzing' });
            this.emitEvent({ type: 'log', data: `CC 正在生成分析结果（已完成 ${this.toolCallCount} 次工具调用）...` });
            this.emitEvent({ type: 'progress', data: 92 });
          }
        }
      }
    } else if (type === 'user') {
      // --verbose 模式：工具结果包装在 type:"user" 事件中
      // 格式: { type:"user", message:{ content:[{ type:"tool_result", tool_use_id, content }] }, tool_use_result:{ stdout, stderr } }
      const message = obj.message as Record<string, unknown> | undefined;
      const content = message?.content as Array<Record<string, unknown>> | undefined;
      const toolUseResult = obj.tool_use_result as Record<string, string> | undefined;

      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === 'tool_result') {
            const toolUseId = block.tool_use_id as string | undefined;
            const isError = block.is_error as boolean | undefined;
            // 优先用 tool_use_result.stdout，其次用 content 字段
            const blockContent = typeof block.content === 'string'
              ? block.content
              : Array.isArray(block.content)
                ? (block.content as Array<Record<string, unknown>>).map(c => (c.text as string) || '').join('\n')
                : '';
            const outputText = toolUseResult?.stdout || blockContent;

            // 错误日志（仅检查 API 级别的错误标记，不检查内容中的 Error 字符串）
            if (isError || outputText.includes('<tool_use_error>')) {
              this.emitEvent({ type: 'log', data: `⚠ 工具返回错误: ${outputText.slice(0, 500)}` });
            }

            this.completeToolCall(toolUseId, outputText);
          }
        }
      }
    } else if (type === 'tool_result' || type === 'tool_output') {
      // 非 verbose 模式的兼容处理
      const toolUseId = obj.tool_use_id as string | undefined;
      const content = obj.content as string | Array<Record<string, unknown>> | undefined;
      const outputText = typeof content === 'string'
        ? content
        : Array.isArray(content)
          ? content.map(c => (c.text as string) || '').join('\n')
          : '';

      this.completeToolCall(toolUseId, outputText);
    } else if (type === 'result') {
      // verbose 模式: result 字段包含 CC 的完整最终文本输出
      const result = obj.result as string | undefined;
      if (typeof result === 'string' && result.length > 0) {
        // result 事件的文本是最权威的，优先使用
        this.lastResultText = result;
      }
    }
  }

  private completeToolCall(toolUseId: string | undefined, outputText: string): void {
    const toolEvent = toolUseId ? this.activeToolCalls.get(toolUseId) : this.getLastActiveToolCall();
    if (!toolEvent) return;

    toolEvent.status = 'done';
    toolEvent.output = outputText.slice(0, 2000);
    toolEvent.durationMs = Date.now() - toolEvent.startedAt;

    // Bash 工具提取退出码
    if (toolEvent.tool === 'Bash') {
      const exitMatch = outputText.match(/exit code: (\d+)/i);
      toolEvent.exitCode = exitMatch ? parseInt(exitMatch[1]) : 0;
      if (outputText.includes('Cloning into')) {
        this.emitEvent({ type: 'progress', data: 25 });
      }
    }

    // 推送 tool_use 完成事件
    this.emitEvent({ type: 'tool_use', data: { ...toolEvent } });
    this.activeToolCalls.delete(toolEvent.id);
  }

  private extractToolInput(toolName: string, input?: Record<string, string>): string {
    if (!input) return '';
    switch (toolName) {
      case 'Bash': return input.command || '';
      case 'Read': return input.file_path || '';
      case 'Glob': return input.pattern || '';
      case 'Grep': return input.pattern ? `/${input.pattern}/` + (input.path ? ` in ${input.path}` : '') : '';
      case 'Write': return input.file_path || '';
      default: return JSON.stringify(input).slice(0, 200);
    }
  }

  private getLastActiveToolCall(): CCToolCallEvent | undefined {
    let last: CCToolCallEvent | undefined;
    this.activeToolCalls.forEach((tc) => { last = tc; });
    return last;
  }

  private updatePhaseFromTool(toolName: string, input?: Record<string, string>): void {
    const command = input?.command || input?.file_path || input?.pattern || '';

    if (toolName === 'Bash') {
      if (command.includes('git clone')) {
        this.emitEvent({ type: 'phase', data: 'cloning' });
        this.emitEvent({ type: 'progress', data: 15 });
      }
    } else if (toolName === 'Glob') {
      this.emitEvent({ type: 'phase', data: 'scanning' });
      this.emitEvent({ type: 'progress', data: Math.min(35 + this.toolCallCount, 50) });
    } else if (toolName === 'Grep') {
      this.emitEvent({ type: 'phase', data: 'scanning' });
      this.emitEvent({ type: 'progress', data: Math.min(35 + this.toolCallCount, 55) });
    } else if (toolName === 'Read') {
      this.emitEvent({ type: 'phase', data: 'extracting' });
      this.emitEvent({ type: 'progress', data: Math.min(50 + this.toolCallCount * 2, 88) });
    }
  }

  private extractFinalResult(): void {
    // 从 CC 的最终输出中提取 JSON
    const text = this.lastResultText;
    if (!text) {
      this.emitEvent({ type: 'error', data: 'CC 未产生任何文本输出' });
      return;
    }

    // 策略 1: 提取 ```json ... ``` 代码块，用平衡括号解析
    const codeBlockStart = text.match(/```(?:json)?\s*\{/);
    if (codeBlockStart) {
      const jsonStart = text.indexOf('{', codeBlockStart.index!);
      const balanced = this.extractBalancedJSON(text, jsonStart);
      if (balanced) {
        try {
          const result = JSON.parse(balanced);
          this.emitEvent({ type: 'phase', data: 'matching' });
          this.emitEvent({ type: 'progress', data: 100 });
          this.emitEvent({ type: 'result', data: result });
          return;
        } catch { /* fall through */ }
      }
    }

    // 策略 2: 找第一个 { 开头且包含 "matches" 的 JSON 对象，用平衡括号
    const firstBrace = text.indexOf('{');
    if (firstBrace !== -1) {
      const balanced = this.extractBalancedJSON(text, firstBrace);
      if (balanced && balanced.includes('"matches"')) {
        try {
          const result = JSON.parse(balanced);
          this.emitEvent({ type: 'phase', data: 'matching' });
          this.emitEvent({ type: 'progress', data: 100 });
          this.emitEvent({ type: 'result', data: result });
          return;
        } catch { /* fall through */ }
      }
    }

    // 策略 3: 尝试匹配 JSON 数组
    const arrayMatch = text.match(/\[[\s\S]*\]/);
    if (arrayMatch) {
      try {
        const matches = JSON.parse(arrayMatch[0]);
        this.emitEvent({ type: 'phase', data: 'matching' });
        this.emitEvent({ type: 'progress', data: 100 });
        this.emitEvent({ type: 'result', data: { matches } });
        return;
      } catch { /* fall through */ }
    }

    this.emitEvent({ type: 'error', data: `CC 输出中未找到有效的 JSON 结果。输出前 500 字: ${text.slice(0, 500)}` });
  }

  private extractBalancedJSON(text: string, start: number): string | null {
    let depth = 0;
    let inString = false;
    let escape = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (escape) { escape = false; continue; }
      if (ch === '\\' && inString) { escape = true; continue; }
      if (ch === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (ch === '{') depth++;
      if (ch === '}') { depth--; if (depth === 0) return text.slice(start, i + 1); }
    }
    return null;
  }
}
