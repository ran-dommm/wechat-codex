import { spawn } from 'node:child_process';
import type { ExecutionMode } from '../session.js';
import { parseCodexOutput, type CodexCommandExecution, type CodexFileChange } from './events.js';
import { CODEX_RUN_TIMEOUT_MS } from '../constants.js';

export interface CodexRunOptions {
  prompt: string;
  cwd: string;
  threadId?: string;
  model?: string;
  mode: ExecutionMode;
  images?: string[];
}

export interface CodexRunResult {
  threadId?: string;
  replyText: string;
  commands: CodexCommandExecution[];
  fileChanges: CodexFileChange[];
  error?: string;
}

export interface CodexStreamEvent {
  type: 'thinking' | 'message_delta' | 'message_done' | 'command_start' | 'command_done' | 'file_change' | 'thread_started' | 'raw';
  text?: string;
  command?: string;
  exitCode?: number | null;
  status?: string;
  threadId?: string;
  changes?: Array<{ path: string; kind: string }>;
  raw?: any;
}

export type CodexStreamCallback = (event: CodexStreamEvent) => void;

export function buildCodexArgs(options: CodexRunOptions): string[] {
  if (options.threadId) {
    const args: string[] = ['exec', 'resume', '--json', '--skip-git-repo-check'];
    if (options.model) {
      args.push('-m', options.model);
    }
    for (const imagePath of options.images ?? []) {
      args.push('--image', imagePath);
    }
    args.push(options.threadId, options.prompt);
    return args;
  }

  const args: string[] = ['exec', '--json', '--skip-git-repo-check', '-C', options.cwd];
  if (options.model) {
    args.push('-m', options.model);
  }
  if (options.mode === 'plan') {
    args.push('-s', 'read-only', '-c', 'approval_policy="never"');
  } else if (options.mode === 'workspace') {
    args.push('-s', 'workspace-write', '-c', 'approval_policy="never"');
  } else {
    args.push('--dangerously-bypass-approvals-and-sandbox');
  }
  for (const imagePath of options.images ?? []) {
    args.push('--image', imagePath);
  }
  args.push(options.prompt);
  return args;
}

function tryParseJson(line: string): any | undefined {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

function processJsonLine(line: string, onEvent?: CodexStreamCallback): void {
  if (!onEvent) return;
  const event = tryParseJson(line);
  if (!event || typeof event !== 'object') return;

  if (event.type === 'thread.started' && typeof event.thread_id === 'string') {
    onEvent({ type: 'thread_started', threadId: event.thread_id });
    return;
  }

  if (event.type === 'message.delta' && typeof event.delta === 'string') {
    onEvent({ type: 'message_delta', text: event.delta });
    return;
  }

  if (event.type === 'item.started') {
    const item = event.item;
    if (!item || typeof item !== 'object') return;

    if (item.type === 'agent_message') {
      onEvent({ type: 'thinking', text: 'Codex is thinking...' });
      return;
    }
    if (item.type === 'command_execution' && typeof item.command === 'string') {
      onEvent({ type: 'command_start', command: item.command });
      return;
    }
  }

  if (event.type === 'item.completed') {
    const item = event.item;
    if (!item || typeof item !== 'object') return;

    if (item.type === 'agent_message' && typeof item.text === 'string') {
      onEvent({ type: 'message_done', text: item.text });
      return;
    }
    if (item.type === 'command_execution' && typeof item.command === 'string') {
      onEvent({
        type: 'command_done',
        command: item.command,
        exitCode: typeof item.exit_code === 'number' ? item.exit_code : null,
        status: typeof item.status === 'string' ? item.status : 'unknown',
      });
      return;
    }
    if (item.type === 'file_change' && Array.isArray(item.changes)) {
      const changes: Array<{ path: string; kind: string }> = [];
      for (const change of item.changes) {
        if (change && typeof change.path === 'string' && typeof change.kind === 'string') {
          changes.push({ path: change.path, kind: change.kind });
        }
      }
      if (changes.length > 0) {
        onEvent({ type: 'file_change', changes });
      }
      return;
    }
  }
}

export async function runCodex(options: CodexRunOptions, onEvent?: CodexStreamCallback): Promise<CodexRunResult> {
  const args = buildCodexArgs(options);

  return new Promise<CodexRunResult>((resolve, reject) => {
    const child = spawn('codex', args, {
      cwd: options.cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let settled = false;
    let lineBuf = '';

    const timer = setTimeout(() => {
      if (settled) return;
      stderr += `Codex timed out after ${CODEX_RUN_TIMEOUT_MS}ms`;
      child.kill('SIGTERM');
      setTimeout(() => {
        if (!settled) {
          child.kill('SIGKILL');
        }
      }, 3000);
    }, CODEX_RUN_TIMEOUT_MS);

    child.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      stdout += text;

      lineBuf += text;
      const lines = lineBuf.split('\n');
      lineBuf = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed) {
          processJsonLine(trimmed, onEvent);
        }
      }
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', (error) => {
      settled = true;
      clearTimeout(timer);
      reject(error);
    });

    child.on('close', (code) => {
      settled = true;
      clearTimeout(timer);

      if (lineBuf.trim()) {
        processJsonLine(lineBuf.trim(), onEvent);
      }

      const parsed = parseCodexOutput(stdout, stderr, code);
      resolve({
        threadId: parsed.threadId ?? options.threadId,
        replyText: parsed.replyText,
        commands: parsed.commands,
        fileChanges: parsed.fileChanges,
        error: parsed.error,
      });
    });
  });
}
