import type { Session } from '../session.js';
import { findSkill } from '../codex/skill-scanner.js';
import { logger } from '../logger.js';
import { handleHelp, handleClear, handleModel, handleMode, handleCwd, handleStatus, handleSkills, handleUnknown, handlePermissionAlias } from './handlers.js';

export interface CommandContext {
  accountId: string;
  session: Session;
  updateSession: (partial: Partial<Session>) => void;
  clearSession: () => Session;
  text: string;
}

export interface CommandResult {
  reply?: string;
  handled: boolean;
  codexPrompt?: string; // If set, this text should be sent to Codex
  nowPrompt?: string; // If set, interrupt current work and run this immediately
  codexInput?: {
    sequence: string;
    label: string;
  }; // If set, write raw key input directly to the Codex TUI
  screenRequested?: boolean; // If true, return the latest Codex TUI screen
}

/**
 * Parse and dispatch a slash command.
 *
 * Supported commands:
 *   /help     - Show help text with all available commands
 *   /clear    - Clear the current session
 *   /model <name> - Update the session model
 *   /cwd <path> - Update the working directory
 *   /mode <mode> - Update execution mode
 *   /status   - Show current session info
 *   /now <text> - Interrupt current turn, clear queue, and run text now
 *   /allow    - Press Enter in the Codex TUI, useful for approval prompts
 *   /deny     - Press Escape in the Codex TUI, useful for approval prompts
 *   /key <key> - Send a supported key to the Codex TUI
 *   /screen   - Show the current Codex TUI screen
 *   /skills   - List all installed skills
 *   /<skill>  - Invoke a skill by name (args are forwarded to Claude)
 */
export function routeCommand(ctx: CommandContext): CommandResult {
  const text = ctx.text.trim();

  if (!text.startsWith('/')) {
    return { handled: false };
  }

  const spaceIdx = text.indexOf(' ');
  const cmd = (spaceIdx === -1 ? text.slice(1) : text.slice(1, spaceIdx)).toLowerCase();
  const args = spaceIdx === -1 ? '' : text.slice(spaceIdx + 1).trim();

  logger.info(`Slash command: /${cmd} ${args}`.trimEnd());

  switch (cmd) {
    case 'help':
      return handleHelp(args);
    case 'clear':
      return handleClear(ctx);
    case 'model':
      return handleModel(ctx, args);
    case 'cwd':
      return handleCwd(ctx, args);
    case 'mode':
      return handleMode(ctx, args);
    case 'permission':
      return handlePermissionAlias();
    case 'allow':
    case 'approve':
      return {
        handled: true,
        codexInput: {
          sequence: '\r',
          label: 'Enter',
        },
        reply: '已向 Codex 发送 Enter。若当前停在权限确认框，通常会执行当前选中的选项。',
      };
    case 'deny':
    case 'reject':
      return {
        handled: true,
        codexInput: {
          sequence: '\x1b',
          label: 'Esc',
        },
        reply: '已向 Codex 发送 Esc。若当前停在权限确认框，通常会取消/返回。',
      };
    case 'key':
      return handleKey(args);
    case 'screen':
    case 'ui':
      return {
        handled: true,
        screenRequested: true,
      };
    case 'status':
      return handleStatus(ctx);
    case 'now':
      return {
        handled: true,
        nowPrompt: args,
      };
    case 'skills':
      return handleSkills();
    default:
      return handleUnknown(cmd, args);
  }
}

function handleKey(args: string): CommandResult {
  const key = args.trim().toLowerCase();
  const keyMap: Record<string, { sequence: string; label: string }> = {
    enter: { sequence: '\r', label: 'Enter' },
    return: { sequence: '\r', label: 'Enter' },
    esc: { sequence: '\x1b', label: 'Esc' },
    escape: { sequence: '\x1b', label: 'Esc' },
    up: { sequence: '\x1b[A', label: 'Up' },
    down: { sequence: '\x1b[B', label: 'Down' },
    right: { sequence: '\x1b[C', label: 'Right' },
    left: { sequence: '\x1b[D', label: 'Left' },
    tab: { sequence: '\t', label: 'Tab' },
    space: { sequence: ' ', label: 'Space' },
    y: { sequence: 'y', label: 'y' },
    p: { sequence: 'p', label: 'p' },
    n: { sequence: 'n', label: 'n' },
    '1': { sequence: '1', label: '1' },
    '2': { sequence: '2', label: '2' },
    '3': { sequence: '3', label: '3' },
  };

  const mapped = keyMap[key];
  if (!mapped) {
    return {
      handled: true,
      reply: '用法: /key <enter|esc|up|down|left|right|tab|space|y|p|n|1|2|3>',
    };
  }

  return {
    handled: true,
    codexInput: mapped,
    reply: `已向 Codex 发送按键: ${mapped.label}`,
  };
}
