import { homedir } from 'node:os';
import { resolve } from 'node:path';
import {
  CODEX_AUTH_PATH,
  CODEX_AUTH_PROFILE_DIR,
  deleteAuthProfile,
  getCurrentAuthProfile,
  importAuthProfile,
  listAuthProfiles,
  saveCurrentAuthProfile,
  useAuthProfile,
} from './auth-profiles.js';

const HELP_TEXT = `用法:
  npm run codex-auth current
  npm run codex-auth list
  npm run codex-auth save <name>
  npm run codex-auth use <name>
  npm run codex-auth import <name> <path>
  npm run codex-auth delete <name>

只切换 ${CODEX_AUTH_PATH}，不会复制 config.toml、AGENTS.md、history 或 sessions。`;

export function runCodexAuthCli(args: string[]): void {
  const [command, ...rest] = args;

  try {
    switch (command) {
      case 'current':
        printCurrent();
        return;
      case 'list':
        printList();
        return;
      case 'save':
        requireArg(rest[0], '缺少 profile name');
        console.log(saveCurrentAuthProfile(rest[0]).message);
        return;
      case 'use':
        requireArg(rest[0], '缺少 profile name');
        printAction(useAuthProfile(rest[0]));
        return;
      case 'import':
        requireArg(rest[0], '缺少 profile name');
        requireArg(rest[1], '缺少 auth.json 路径');
        printAction(importAuthProfile(rest[0], expandPath(rest[1])));
        return;
      case 'delete':
        requireArg(rest[0], '缺少 profile name');
        console.log(deleteAuthProfile(rest[0]).message);
        return;
      case 'help':
      case '--help':
      case '-h':
      case undefined:
        console.log(HELP_TEXT);
        return;
      default:
        throw new Error(`未知 codex-auth 命令: ${command}\n\n${HELP_TEXT}`);
    }
  } catch (err) {
    console.error(`codex-auth: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
}

function printCurrent(): void {
  const current = getCurrentAuthProfile();
  if (!current.exists) {
    console.log(`当前未找到 Codex auth: ${CODEX_AUTH_PATH}`);
    return;
  }

  const lines = [
    `auth.json: ${current.authPath}`,
    `类型: ${current.isSymlink ? 'symlink' : 'regular file'}`,
    `当前 profile: ${current.name ?? '未纳入 codex-auth 管理'}`,
  ];
  if (current.targetPath) lines.push(`目标: ${current.targetPath}`);
  console.log(lines.join('\n'));
}

function printList(): void {
  const profiles = listAuthProfiles();
  if (profiles.length === 0) {
    console.log(`未找到 Codex auth profiles。\n目录: ${CODEX_AUTH_PROFILE_DIR}`);
    return;
  }

  console.log(profiles.map((p) => `${p.isCurrent ? '*' : ' '} ${p.name}`).join('\n'));
}

function printAction(result: { message: string; profilePath?: string; backupPath?: string }): void {
  const lines = [result.message];
  if (result.profilePath) lines.push(`profile: ${result.profilePath}`);
  if (result.backupPath) lines.push(`backup: ${result.backupPath}`);
  console.log(lines.join('\n'));
}

function requireArg(value: string | undefined, message: string): asserts value is string {
  if (!value) throw new Error(message);
}

function expandPath(input: string): string {
  if (input === '~') return homedir();
  if (input.startsWith('~/')) return resolve(homedir(), input.slice(2));
  return resolve(input);
}
