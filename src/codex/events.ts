export interface CodexCommandExecution {
  command: string;
  exitCode: number | null;
  status: string;
}

export interface CodexFileChange {
  path: string;
  kind: string;
}

export interface ParsedCodexOutput {
  threadId?: string;
  replyText: string;
  messages: string[];
  commands: CodexCommandExecution[];
  fileChanges: CodexFileChange[];
  stderrText: string;
  error?: string;
}

function parseJsonLine(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

export function parseCodexOutput(stdout: string, stderr: string, exitCode: number | null): ParsedCodexOutput {
  let threadId: string | undefined;
  const messages: string[] = [];
  const commands: CodexCommandExecution[] = [];
  const fileChanges: CodexFileChange[] = [];

  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    const event = parseJsonLine(line) as any;
    if (!event || typeof event !== 'object') continue;

    if (event.type === 'thread.started' && typeof event.thread_id === 'string') {
      threadId = event.thread_id;
      continue;
    }

    if (event.type !== 'item.completed' && event.type !== 'item.started') {
      continue;
    }

    const item = event.item;
    if (!item || typeof item !== 'object') continue;

    if (event.type === 'item.completed' && item.type === 'agent_message' && typeof item.text === 'string') {
      messages.push(item.text);
      continue;
    }

    if (item.type === 'command_execution' && typeof item.command === 'string') {
      commands.push({
        command: item.command,
        exitCode: typeof item.exit_code === 'number' ? item.exit_code : null,
        status: typeof item.status === 'string' ? item.status : 'unknown',
      });
      continue;
    }

    if (event.type === 'item.completed' && item.type === 'file_change' && Array.isArray(item.changes)) {
      for (const change of item.changes) {
        if (change && typeof change.path === 'string' && typeof change.kind === 'string') {
          fileChanges.push({ path: change.path, kind: change.kind });
        }
      }
    }
  }

  const allMessagesText = messages.map(m => m.trim()).filter(Boolean).join('\n\n');

  const parts: string[] = [];
  if (allMessagesText) {
    parts.push(allMessagesText);
  }

  const failedCommands = commands.filter(cmd => cmd.exitCode !== null && cmd.exitCode !== 0);
  if (failedCommands.length > 0) {
    const cmdLines = failedCommands.map(cmd => {
      return `✕ ${cmd.command}  [exit ${cmd.exitCode}]`;
    });
    parts.push('失败的命令:\n' + cmdLines.join('\n'));
  }

  if (fileChanges.length > 0) {
    const changeLines = fileChanges.map(c => `${c.kind}: ${c.path}`);
    parts.push('文件变更:\n' + changeLines.join('\n'));
  }

  const replyText = parts.join('\n\n');

  let error: string | undefined;
  const trimmedStderr = stderr.trim();
  if (exitCode && exitCode !== 0) {
    error = trimmedStderr || `Codex exited with code ${exitCode}`;
  } else if (!replyText && trimmedStderr) {
    error = trimmedStderr;
  }

  return {
    threadId,
    replyText,
    messages,
    commands,
    fileChanges,
    stderrText: trimmedStderr,
    error,
  };
}
