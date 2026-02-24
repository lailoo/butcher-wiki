#!/usr/bin/env tsx
// 端到端测试：预克隆 + CCRunner 扫描 openclaw

import path from 'path';
import fs from 'fs';
import { exec } from 'child_process';
import { CCRunner, CCProgressEvent } from '../src/lib/cc-runner';
import { buildCCPrompt } from '../src/lib/scan-prompt';

const repoUrl = 'https://github.com/openclaw/openclaw';
const repoName = 'openclaw';
const scanDir = `/tmp/butcher-scan-${repoName}`;
const PROJECT_ROOT = path.resolve(process.cwd());

async function preClone(): Promise<void> {
  if (fs.existsSync(scanDir) && fs.readdirSync(scanDir).length > 1) {
    console.log(`仓库已存在: ${scanDir}，跳过克隆`);
    return;
  }
  console.log(`预克隆: ${repoUrl} → ${scanDir}`);
  return new Promise((resolve, reject) => {
    exec(`rm -rf ${scanDir} && git clone --depth=1 ${repoUrl} ${scanDir}`,
      { timeout: 3_000_000 },
      (err) => err ? reject(err) : resolve()
    );
  });
}

async function main() {
  // Step 1: 预克隆
  await preClone();
  console.log('预克隆完成\n');

  // Step 2: 构建 prompt（preCloned=true，跳过 clone 步骤）
  const { system, prompt, resultFile } = buildCCPrompt(repoUrl, { preCloned: true });
  console.log('=== prompt (前 500 字) ===');
  console.log(prompt.slice(0, 500));
  console.log('');

  // Step 3: 启动 CCRunner
  console.log('=== 启动 CCRunner ===');
  const runner = new CCRunner({
    prompt,
    systemPrompt: system,
    cwd: PROJECT_ROOT,
    timeoutMs: 1_800_000,
    noOutputTimeoutMs: 600_000,
    allowedTools: 'Bash Read Glob Grep Write',
    disallowedTools: 'TodoWrite Task',
    maxBudgetUsd: 500,
    skipResultExtraction: true,
  });

  runner.on('event', (event: CCProgressEvent) => {
    const ts = new Date().toLocaleTimeString();
    if (event.type === 'log') {
      console.log(`[${ts}] LOG: ${String(event.data).slice(0, 200)}`);
    } else if (event.type === 'error') {
      console.error(`[${ts}] ERROR: ${event.data}`);
    } else if (event.type === 'phase') {
      console.log(`[${ts}] PHASE: ${event.data}`);
    } else if (event.type === 'progress') {
      console.log(`[${ts}] PROGRESS: ${event.data}%`);
    } else if (event.type === 'tool_use') {
      const d = event.data as Record<string, unknown>;
      console.log(`[${ts}] TOOL: ${d.tool} [${d.status}] ${String(d.input).slice(0, 150)}`);
    } else if (event.type === 'done') {
      const d = event.data as Record<string, unknown>;
      console.log(`\n[${ts}] DONE: toolCalls=${d.toolCallCount}, totalMs=${d.totalMs}`);
      // 检查结果文件
      if (fs.existsSync(resultFile)) {
        const result = JSON.parse(fs.readFileSync(resultFile, 'utf-8'));
        console.log(`结果文件存在: ${resultFile}`);
        console.log(`matches: ${result.matches?.length || 0}`);
        console.log(`new_domains: ${result.new_domains?.length || 0}`);
      } else {
        console.log('结果文件不存在，检查 resultText...');
        console.log('resultText 前 500 字:', String(d.resultText || '').slice(0, 500));
      }
      process.exit(0);
    }
  });

  runner.start();
  console.log('CCRunner 已启动，等待输出...\n');
}

main().catch(err => {
  console.error('测试失败:', err);
  process.exit(1);
});
