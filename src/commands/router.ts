import type { Session } from '../session.js';
import { logger } from '../logger.js';
import {
  handleCodexAuth,
  handleHelp,
  handleClear,
  handleModel,
  handleMode,
  handleCwd,
  handleStatus,
  handleReceive,
  handleSkills,
  handleUnknown,
} from './handlers.js';

export interface CommandContext {
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
  codexAuthProfile?: string; // If set, switch auth profile in main runtime
  restartBridge?: boolean; // If true, restart the native Codex process to apply startup options
  receiveDeferred?: boolean; // If true, deliver deferred WeChat texts without sending a Codex turn
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
 *   /codex-auth - Show/save/switch Codex auth profile
 *   /now <text> - Interrupt current turn, clear queue, and run text now
 *   /receive - Deliver deferred WeChat texts without sending a Codex turn
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
    case 'status':
      return handleStatus(ctx);
    case 'receive':
      return handleReceive();
    case 'codex-auth':
      return handleCodexAuth(args);
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
