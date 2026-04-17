import { createInterface, type Interface as ReadlineInterface } from 'node:readline';

const RESET = '\x1b[0m';
const GREEN = '\x1b[32m';
const BLUE = '\x1b[34m';
const CYAN = '\x1b[36m';
const YELLOW = '\x1b[33m';
const DIM = '\x1b[2m';
const RED = '\x1b[31m';
const BOLD = '\x1b[1m';
const MAGENTA = '\x1b[35m';

const PROMPT_IDLE = `${CYAN}${BOLD}❯${RESET} `;
const PROMPT_BUSY = `${DIM}${CYAN}⠿${RESET} `;

const SEPARATOR = `${DIM}${'─'.repeat(50)}${RESET}`;

export interface ReplCallbacks {
  onInput: (text: string) => void;
}

export interface Repl {
  run: () => Promise<void>;
  stop: () => void;
  setBusy: (busy: boolean) => void;
  printWechatMessage: (user: string, text: string) => void;
  printLocalInput: (text: string) => void;
  printCodexReply: (text: string, source: 'wechat' | 'console') => void;
  printCodexCommands: (commands: Array<{ command: string; exitCode: number | null; status: string }>) => void;
  printCodexFileChanges: (changes: Array<{ path: string; kind: string }>) => void;
  printError: (text: string) => void;
  printInfo: (text: string) => void;
  printSystem: (text: string) => void;
  printStreamStart: () => void;
  printStreamDelta: (text: string) => void;
  printStreamEnd: () => void;
  printCommandStart: (command: string) => void;
  printCommandDone: (command: string, exitCode: number | null, status: string) => void;
  printFileChange: (changes: Array<{ path: string; kind: string }>) => void;
}

function clearCurrentLine(rl: ReadlineInterface): void {
  const output = (rl as any).output;
  if (output?.clearLine && output?.cursorTo) {
    output.clearLine(0);
    output.cursorTo(0);
  }
}

function redrawPrompt(rl: ReadlineInterface): void {
  rl.prompt(true);
}

export function createRepl(callbacks: ReplCallbacks): Repl {
  let rl: ReadlineInterface | null = null;
  let busy = false;
  let stopped = false;
  let streaming = false;
  let needSeparator = false;

  function getCurrentPrompt(): string {
    return busy ? PROMPT_BUSY : PROMPT_IDLE;
  }

  function rawWrite(text: string): void {
    if (!rl) return;
    process.stdout.write(text);
  }

  function writeLine(line: string): void {
    if (!rl) return;
    clearCurrentLine(rl);
    process.stdout.write(line + '\n');
    if (!streaming) redrawPrompt(rl);
  }

  function ensureSeparator(): void {
    if (needSeparator) {
      writeLine(SEPARATOR);
      needSeparator = false;
    }
  }

  function run(): Promise<void> {
    return new Promise<void>((resolve) => {
      if (!process.stdin.isTTY) {
        resolve();
        return;
      }

      rl = createInterface({
        input: process.stdin,
        output: process.stdout,
        prompt: getCurrentPrompt(),
        terminal: true,
      });

      console.log(`\n ${CYAN}${BOLD}codex${RESET}  ${DIM}WeChat + Terminal bridge${RESET}`);
      console.log(`${DIM} Type a message or /help for commands${RESET}\n`);

      rl.prompt();

      rl.on('line', (line: string) => {
        const trimmed = line.trim();
        if (trimmed) {
          callbacks.onInput(trimmed);
        }
        if (rl) {
          rl.setPrompt(getCurrentPrompt());
          rl.prompt();
        }
      });

      rl.on('close', () => {
        stopped = true;
        resolve();
      });
    });
  }

  function stop(): void {
    if (rl && !stopped) {
      stopped = true;
      rl.close();
    }
  }

  function setBusy(isBusy: boolean): void {
    busy = isBusy;
    if (rl) {
      rl.setPrompt(getCurrentPrompt());
    }
    if (!isBusy) {
      needSeparator = true;
    }
  }

  function printWechatMessage(user: string, text: string): void {
    ensureSeparator();
    writeLine(`${GREEN}${BOLD}⬤${RESET} ${GREEN}${user}${RESET}  ${text}`);
  }

  function printLocalInput(_text: string): void {
    // User input is already echoed by readline; no duplication needed
  }

  function printCodexReply(text: string, _source: 'wechat' | 'console'): void {
    const lines = text.split('\n');
    for (const line of lines) {
      writeLine(`  ${line}`);
    }
  }

  function printCodexCommands(commands: Array<{ command: string; exitCode: number | null; status: string }>): void {
    const failed = commands.filter(c => c.exitCode !== null && c.exitCode !== 0);
    if (failed.length === 0) return;
    for (const cmd of failed) {
      const shortCmd = cmd.command.length > 60 ? cmd.command.slice(0, 57) + '…' : cmd.command;
      writeLine(`  ${RED}✕${RESET} ${DIM}${shortCmd}${RESET}  ${RED}exit ${cmd.exitCode}${RESET}`);
    }
  }

  function printCodexFileChanges(changes: Array<{ path: string; kind: string }>): void {
    if (changes.length === 0) return;
    for (const change of changes) {
      writeLine(`  ${DIM}${change.kind}${RESET} ${change.path}`);
    }
  }

  function printError(text: string): void {
    writeLine(`${RED}${BOLD}✕${RESET} ${text}`);
  }

  function printInfo(text: string): void {
    writeLine(`${DIM}${text}${RESET}`);
  }

  function printSystem(text: string): void {
    writeLine(`${DIM}${text}${RESET}`);
  }

  function printStreamStart(): void {
    if (!rl) return;
    if (streaming) return;
    clearCurrentLine(rl);
    streaming = true;
  }

  function printStreamDelta(text: string): void {
    if (!rl) return;
    if (!streaming) {
      printStreamStart();
    }
    rawWrite(text);
  }

  function printStreamEnd(): void {
    if (!rl || !streaming) return;
    rawWrite('\n');
    streaming = false;
    redrawPrompt(rl);
  }

  function printCommandStart(_command: string): void {
    // Silently track commands; don't clutter the output.
    // Text streaming continues to flow naturally after commands finish.
  }

  function printCommandDone(command: string, exitCode: number | null, _status: string): void {
    if (exitCode !== null && exitCode !== 0) {
      const shortCmd = command.length > 60 ? command.slice(0, 57) + '…' : command;
      writeLine(`  ${RED}✕${RESET} ${DIM}${shortCmd}${RESET}  ${RED}exit ${exitCode}${RESET}`);
    }
  }

  function printFileChange(changes: Array<{ path: string; kind: string }>): void {
    for (const change of changes) {
      const kindLabel = change.kind === 'created' ? `${GREEN}+${RESET}` :
                        change.kind === 'deleted' ? `${RED}-${RESET}` :
                        `${BLUE}~${RESET}`;
      writeLine(`  ${kindLabel} ${DIM}${change.path}${RESET}`);
    }
  }

  return {
    run,
    stop,
    setBusy,
    printWechatMessage,
    printLocalInput,
    printCodexReply,
    printCodexCommands,
    printCodexFileChanges,
    printError,
    printInfo,
    printSystem,
    printStreamStart,
    printStreamDelta,
    printStreamEnd,
    printCommandStart,
    printCommandDone,
    printFileChange,
  };
}
