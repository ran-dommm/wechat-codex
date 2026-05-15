export type CodexSpawnMode = 'plan' | 'workspace' | 'danger';

export interface CodexSpawnOptions {
  mode: CodexSpawnMode;
  model?: string;
}

export function buildCodexArgs(options: CodexSpawnOptions): string[] {
  const args: string[] = [];
  if (options.model) {
    args.push('-m', options.model);
  }

  switch (options.mode) {
    case 'plan':
      args.push('-s', 'read-only', '-c', 'approval_policy="never"');
      break;
    case 'danger':
      args.push('--dangerously-bypass-approvals-and-sandbox');
      break;
    case 'workspace':
    default:
      args.push('-s', 'workspace-write', '-c', 'approval_policy="never"');
      break;
  }

  return args;
}
