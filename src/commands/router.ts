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
    case 'status':
      return handleStatus(ctx);
    case 'skills':
      return handleSkills();
    default:
      return handleUnknown(cmd, args);
  }
}
