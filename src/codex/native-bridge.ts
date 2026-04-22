import { homedir } from 'node:os';
import { isAbsolute, join, resolve as resolvePath } from 'node:path';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import * as pty from 'node-pty';

const CODEX_HOME = process.env.CODEX_HOME || join(homedir(), '.codex');
const SESSIONS_ROOT = join(CODEX_HOME, 'sessions');
const SESSION_POLL_INTERVAL_MS = 300;
const SESSION_DISCOVER_INTERVAL_MS = 1000;

export type CodexSpawnMode = 'plan' | 'workspace' | 'danger';

export type AttachmentKind = 'image' | 'file' | 'voice' | 'video';

export interface WechatAttachment {
  kind: AttachmentKind;
  path: string;
}

export interface NativeBridgeEvents {
  onWechatReply: (text: string) => void;
  onWechatAttachment: (attachment: WechatAttachment) => void;
  onWechatTurnComplete: () => void;
  onTurnFinalized?: (info: { source: BridgeTurnSource; reason: BridgeTurnReason }) => void;
  onError: (message: string) => void;
  onExit: (code: number | null) => void;
}

export interface NativeCodexBridgeOptions {
  proxyMode?: 'inherit' | 'clear';
}

export interface CodexRateLimitWindow {
  usedPercent: number;
  windowMinutes?: number;
  resetsAt?: number;
}

export interface CodexRateLimitsSnapshot {
  planType?: string;
  primary?: CodexRateLimitWindow;
  secondary?: CodexRateLimitWindow;
}

function buildCodexArgs(_mode: CodexSpawnMode): string[] {
  return ['--sandbox', 'workspace-write', '--ask-for-approval', 'on-request'];
}

type TurnSource = 'unknown' | 'wechat' | 'terminal';
export type BridgeTurnSource = TurnSource;
export type BridgeTurnReason = 'complete' | 'aborted';

interface ActiveTurn {
  turnId: string | null;
  source: TurnSource;
  texts: string[];
  // Buffered commentary messages that arrived before user_message (rare).
  // Once source is resolved they are flushed to WeChat.
  pendingCommentary: string[];
}

export class NativeCodexBridge {
  private ptyProc: pty.IPty | null = null;
  private threadId: string | null = null;

  private sessionFilePath: string | null = null;
  private sessionReadOffset = 0;
  private sessionPartialLine = '';
  private sessionStartedAtMs = 0;
  private pollTimer: NodeJS.Timeout | null = null;
  private discoverTimer: NodeJS.Timeout | null = null;

  private wechatQueue: string[] = [];
  private activeTurn: ActiveTurn | null = null;
  // Text we injected via PTY that is still waiting to be echoed by Codex as
  // a `user_message` event. When we see a user_message matching this, we know
  // the turn is WeChat-sourced; anything else is terminal.
  private pendingWechatInjection: string | null = null;
  private latestRateLimits: CodexRateLimitsSnapshot | null = null;
  private screen = new TerminalScreen(process.stdout.columns || 120, process.stdout.rows || 30);
  private ansiStripper = new AnsiStripper();
  private rawScreenFallback = '';
  private screenNotifyTimer: NodeJS.Timeout | null = null;
  private lastInteractivePromptSignature = '';
  private lastInteractiveScreenSentAt = 0;
  private suppressInteractiveScreenUntil = 0;

  private shuttingDown = false;
  private originalRawMode: boolean | null = null;

  // Monotonically increasing generation counter for the underlying Codex PTY
  // process. Every launch bumps this. Per-launch callbacks capture their
  // generation and bail if it no longer matches, so we can kill+respawn
  // without triggering the top-level onExit (which shuts the daemon down).
  private generation = 0;
  private restarting: Promise<void> | null = null;

  constructor(
    private cwd: string,
    private events: NativeBridgeEvents,
    private mode: CodexSpawnMode = 'workspace',
    private options: NativeCodexBridgeOptions = {},
  ) {}

  get isBusy(): boolean {
    return (
      this.activeTurn !== null ||
      this.pendingWechatInjection !== null ||
      this.wechatQueue.length > 0
    );
  }

  getThreadId(): string | null {
    return this.threadId;
  }

  setCwd(cwd: string): void {
    this.cwd = cwd;
  }

  getLatestRateLimits(): CodexRateLimitsSnapshot | null {
    return this.latestRateLimits;
  }

  getScreenText(): string {
    return this.screen.snapshot() || this.rawScreenFallback.trim();
  }

  interruptAndClearQueue(): { interrupted: boolean; clearedQueued: number } {
    const clearedQueued = this.wechatQueue.length;
    this.wechatQueue = [];
    this.pendingWechatInjection = null;

    if (!this.ptyProc) {
      return { interrupted: false, clearedQueued };
    }

    // Send Ctrl-C to interrupt the current foreground action in the TUI.
    this.ptyProc.write('\x03');
    return { interrupted: true, clearedQueued };
  }

  sendRawInputToCodex(input: string): boolean {
    if (!this.ptyProc) return false;
    this.ptyProc.write(input);
    return true;
  }

  suppressAutoScreenNotice(ms: number): void {
    this.suppressInteractiveScreenUntil = Math.max(this.suppressInteractiveScreenUntil, Date.now() + ms);
  }

  async start(): Promise<void> {
    this.launchCodex();
    this.startForwardingStdin();
    this.handleResize();
    process.stdout.on('resize', this.handleResize);
  }

  private launchCodex(): void {
    this.sessionStartedAtMs = Date.now();
    const myGen = ++this.generation;

    const child = pty.spawn('codex', buildCodexArgs(this.mode), {
      name: 'xterm-256color',
      cols: process.stdout.columns || 120,
      rows: process.stdout.rows || 30,
      cwd: this.cwd,
      env: buildEnv(this.options),
    });

    this.ptyProc = child;
    this.screen.reset(process.stdout.columns || 120, process.stdout.rows || 30);
    this.ansiStripper.reset();
    this.rawScreenFallback = '';
    this.lastInteractivePromptSignature = '';
    this.lastInteractiveScreenSentAt = 0;
    this.suppressInteractiveScreenUntil = 0;

    child.onData((data) => {
      if (myGen !== this.generation) return;
      this.screen.write(data);
      this.appendRawScreenFallback(data);
      this.scheduleInteractiveScreenNotice();
      process.stdout.write(data);
    });

    child.onExit(({ exitCode }) => {
      if (myGen !== this.generation) return;
      // Keep stdin forwarding active while daemon is alive. Stop it only on
      // process shutdown; otherwise /cwd restarts would break terminal input.
      if (!this.shuttingDown) {
        this.events.onExit(exitCode ?? null);
      }
    });

    this.startPolling();
  }

  async restart(newCwd?: string): Promise<void> {
    if (this.restarting) {
      await this.restarting;
    }
    this.restarting = this.doRestart(newCwd);
    try {
      await this.restarting;
    } finally {
      this.restarting = null;
    }
  }

  private async doRestart(newCwd?: string): Promise<void> {
    if (newCwd) this.cwd = newCwd;

    this.stopPolling();
    this.sessionFilePath = null;
    this.sessionReadOffset = 0;
    this.sessionPartialLine = '';
    this.sessionStartedAtMs = Date.now();
    this.threadId = null;
    this.activeTurn = null;
    this.pendingWechatInjection = null;
    this.latestRateLimits = null;
    this.wechatQueue = [];

    const old = this.ptyProc;
    this.ptyProc = null;
    // Mark existing process callbacks stale before killing.
    this.generation++;
    if (old) {
      try { old.kill(); } catch { /* best effort */ }
    }

    await delay(200);
    this.launchCodex();
  }

  async stop(): Promise<void> {
    this.shuttingDown = true;
    this.stopForwardingStdin();
    this.stopPolling();
    if (this.ptyProc) {
      try { this.ptyProc.kill(); } catch { /* cleanup */ }
      this.ptyProc = null;
    }
  }

  sendWechatTurn(text: string, imagePaths?: string[]): void {
    const parts: string[] = [];
    if (imagePaths?.length) {
      for (const p of imagePaths) {
        parts.push(`[image: ${p}]`);
      }
    }
    if (text) parts.push(text);
    const fullText = parts.join('\n');
    this.wechatQueue.push(fullText);
    this.maybeDispatchQueued();
  }

  // ── stdin forwarding ──

  private stdinListener = (data: Buffer) => {
    if (this.ptyProc) {
      this.ptyProc.write(data.toString('utf8'));
    }
  };

  private startForwardingStdin(): void {
    if (process.stdin.isTTY) {
      this.originalRawMode = process.stdin.isRaw;
      process.stdin.setRawMode(true);
    }
    process.stdin.resume();
    process.stdin.on('data', this.stdinListener);
  }

  private stopForwardingStdin(): void {
    process.stdin.off('data', this.stdinListener);
    if (process.stdin.isTTY && this.originalRawMode !== null) {
      try { process.stdin.setRawMode(this.originalRawMode); } catch { /* cleanup */ }
      this.originalRawMode = null;
    }
  }

  private handleResize = (): void => {
    if (!this.ptyProc) return;
    const cols = process.stdout.columns || 120;
    const rows = process.stdout.rows || 30;
    this.screen.resize(cols, rows);
    try { this.ptyProc.resize(cols, rows); } catch { /* resize best effort */ }
  };

  private scheduleInteractiveScreenNotice(): void {
    if (this.screenNotifyTimer) return;
    this.screenNotifyTimer = setTimeout(() => {
      this.screenNotifyTimer = null;
      this.maybeSendInteractiveScreenNotice();
    }, 250);
    this.screenNotifyTimer.unref?.();
  }

  private maybeSendInteractiveScreenNotice(): void {
    const snapshot = this.getScreenText();
    if (!snapshot || !looksLikeInteractivePrompt(snapshot)) return;

    const now = Date.now();
    if (now < this.suppressInteractiveScreenUntil) return;
    const signature = interactivePromptSignature(snapshot);
    if (signature && signature === this.lastInteractivePromptSignature) {
      return;
    }
    if (now - this.lastInteractiveScreenSentAt < 2_500) {
      return;
    }

    this.lastInteractivePromptSignature = signature;
    this.lastInteractiveScreenSentAt = now;
    this.events.onWechatReply(formatScreenForWechat(snapshot, true));
  }

  private appendRawScreenFallback(data: string): void {
    const stripped = this.ansiStripper.write(data);
    if (!stripped.trim()) return;
    this.rawScreenFallback = `${this.rawScreenFallback}${stripped}`;
    if (this.rawScreenFallback.length > 5000) {
      this.rawScreenFallback = this.rawScreenFallback.slice(-5000);
    }
  }

  // ── WeChat input dispatch ──

  private maybeDispatchQueued(): void {
    if (!this.ptyProc) return;
    // Don't inject while any turn is running or another WeChat injection is
    // still awaiting its user_message echo.
    if (this.activeTurn || this.pendingWechatInjection !== null) return;
    const next = this.wechatQueue.shift();
    if (!next) return;

    this.pendingWechatInjection = next;
    void this.injectMessage(next);
  }

  // Inject a message into the PTY as if typed by the user, then submit.
  //
  // Codex's TUI detects fast multi-char input as a "paste" and holds a
  // trailing Enter, waiting for the user to press Enter again. To work around
  // this, we write the body, settle for a moment so the TUI exits paste mode,
  // then send a standalone Enter to actually submit.
  private async injectMessage(text: string): Promise<void> {
    if (!this.ptyProc) return;

    // Normalize: Codex composer uses \r for newline within the input field;
    // \n can be interpreted inconsistently depending on TUI state.
    const normalized = text.replace(/\r?\n/g, '\r');

    this.ptyProc.write(normalized);
    await delay(120);
    if (!this.ptyProc) return;
    this.ptyProc.write('\r');

    // Safety net: if we still haven't seen our injection echoed back after a
    // grace period, retry the submit Enter once. Some TUI states (warmup,
    // welcome modal) swallow the first Enter.
    setTimeout(() => {
      if (this.pendingWechatInjection !== null && this.ptyProc) {
        this.ptyProc.write('\r');
      }
    }, 2500);
  }

  // ── Session log polling ──

  private startPolling(): void {
    this.discoverTimer = setInterval(() => {
      if (!this.sessionFilePath) this.discoverSessionFile();
    }, SESSION_DISCOVER_INTERVAL_MS);
    this.discoverTimer.unref?.();

    this.pollTimer = setInterval(() => this.pollOnce(), SESSION_POLL_INTERVAL_MS);
    this.pollTimer.unref?.();
  }

  private stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.discoverTimer) {
      clearInterval(this.discoverTimer);
      this.discoverTimer = null;
    }
  }

  private discoverSessionFile(): void {
    const candidate = findLatestSessionFile(this.cwd, this.sessionStartedAtMs);
    if (candidate) {
      this.sessionFilePath = candidate.path;
      this.threadId = candidate.threadId;
      this.sessionReadOffset = 0;
      this.sessionPartialLine = '';
    }
  }

  private pollOnce(): void {
    if (!this.sessionFilePath) {
      this.discoverSessionFile();
      if (!this.sessionFilePath) return;
    }

    let content: string;
    try {
      content = readFileSync(this.sessionFilePath, 'utf8');
    } catch {
      this.sessionFilePath = null;
      this.sessionReadOffset = 0;
      this.sessionPartialLine = '';
      return;
    }

    if (content.length < this.sessionReadOffset) {
      this.sessionReadOffset = 0;
      this.sessionPartialLine = '';
    }

    const newData = content.slice(this.sessionReadOffset);
    this.sessionReadOffset = content.length;

    if (!newData) return;

    const combined = this.sessionPartialLine + newData;
    const lines = combined.split('\n');
    this.sessionPartialLine = lines.pop() ?? '';

    for (const line of lines) {
      if (line.trim()) this.handleSessionLine(line);
    }
  }

  private handleSessionLine(line: string): void {
    let parsed: Record<string, unknown>;
    try { parsed = JSON.parse(line); } catch { return; }
    if (!parsed || typeof parsed !== 'object') return;

    const type = parsed.type;
    const payload = parsed.payload as Record<string, unknown> | undefined;
    if (!payload) return;

    if (type === 'session_meta') {
      const id = (payload as Record<string, unknown>).id;
      if (typeof id === 'string') this.threadId = id;
      return;
    }

    if (type !== 'event_msg') return;

    const payloadType = payload.type;

    if (payloadType === 'token_count') {
      const parsed = parseRateLimitsFromTokenCountPayload(payload);
      if (parsed) {
        this.latestRateLimits = parsed;
      }
      return;
    }

    if (payloadType === 'task_started') {
      const turnId = typeof payload.turn_id === 'string' ? payload.turn_id : null;
      // Source is unknown until we see the matching user_message. Attributing
      // now would race with in-flight WeChat injections.
      this.activeTurn = {
        turnId,
        source: 'unknown',
        texts: [],
        pendingCommentary: [],
      };
      return;
    }

    if (payloadType === 'user_message') {
      if (!this.activeTurn) return;
      const message = typeof payload.message === 'string' ? payload.message : '';

      // If this matches our pending WeChat injection, the turn is WeChat-sourced.
      if (
        this.pendingWechatInjection !== null &&
        textsMatch(message, this.pendingWechatInjection)
      ) {
        this.activeTurn.source = 'wechat';
        this.pendingWechatInjection = null;
      } else {
        this.activeTurn.source = 'terminal';
        if (message.trim()) {
          this.events.onWechatReply(`⌨️ 终端输入：${message}`);
        }
      }

      // Flush any commentary that arrived before source was resolved.
      for (const c of this.activeTurn.pendingCommentary) {
        this.events.onWechatReply(`💭 ${c}`);
      }
      this.activeTurn.pendingCommentary = [];
      return;
    }

    if (payloadType === 'agent_message') {
      const message = typeof payload.message === 'string' ? payload.message : '';
      const phase = typeof payload.phase === 'string' ? payload.phase : '';
      if (!message || !this.activeTurn) return;
      if (phase === 'final_answer') {
        this.activeTurn.texts.push(message);
      } else if (phase === 'commentary') {
        if (this.activeTurn.source === 'unknown') {
          this.activeTurn.pendingCommentary.push(message);
        } else {
          this.events.onWechatReply(`💭 ${message}`);
        }
      }
      return;
    }

    if (payloadType === 'task_complete' || payloadType === 'turn_aborted') {
      this.completeActiveTurn(payloadType === 'turn_aborted' ? 'aborted' : 'complete');
      return;
    }
  }

  private completeActiveTurn(reason: BridgeTurnReason): void {
    const turn = this.activeTurn;
    this.activeTurn = null;
    this.lastInteractivePromptSignature = '';

    if (!turn) {
      this.maybeDispatchQueued();
      return;
    }

    const source = turn.source;
    const texts = turn.texts.map((t) => t.trim()).filter(Boolean);
    const rawFinal = texts.join('\n\n');
    const parsed = parseWechatAttachments(rawFinal);
    const { visibleText } = parsed;
    const attachments = parsed.attachments.map((a) => ({
      kind: a.kind,
      path: isAbsolute(a.path) ? a.path : resolvePath(this.cwd, a.path),
    }));

    // Only emit to WeChat for resolved turns. An 'unknown' source means the
    // turn had no user_message (internal/background turn) — silently ignore.
    if (source === 'wechat' || source === 'terminal') {
      if (reason === 'aborted') {
        if (source === 'wechat') this.events.onError('Turn aborted');
      } else {
        if (visibleText) this.events.onWechatReply(visibleText);
        for (const a of attachments) this.events.onWechatAttachment(a);
      }
      if (source === 'wechat') {
        this.events.onWechatTurnComplete();
      }
    }

    this.events.onTurnFinalized?.({ source, reason });
    this.maybeDispatchQueued();
  }
}

class TerminalScreen {
  private lines: string[][] = [];
  private cursorRow = 0;
  private cursorCol = 0;
  private escBuffer: string | null = null;

  constructor(private cols: number, private rows: number) {
    this.reset(cols, rows);
  }

  reset(cols = this.cols, rows = this.rows): void {
    this.cols = Math.max(20, cols);
    this.rows = Math.max(5, rows);
    this.lines = Array.from({ length: this.rows }, () => []);
    this.cursorRow = 0;
    this.cursorCol = 0;
    this.escBuffer = null;
  }

  resize(cols: number, rows: number): void {
    const nextCols = Math.max(20, cols);
    const nextRows = Math.max(5, rows);
    this.cols = nextCols;
    if (nextRows > this.rows) {
      for (let i = this.rows; i < nextRows; i++) this.lines.push([]);
    } else if (nextRows < this.rows) {
      this.lines = this.lines.slice(this.rows - nextRows);
      this.cursorRow = Math.max(0, Math.min(this.cursorRow, nextRows - 1));
    }
    this.rows = nextRows;
    this.cursorCol = Math.max(0, Math.min(this.cursorCol, this.cols - 1));
  }

  write(data: string): void {
    for (const ch of Array.from(data)) {
      if (this.escBuffer !== null) {
        this.escBuffer += ch;
        if (this.tryHandleEscape(this.escBuffer)) {
          this.escBuffer = null;
        } else if (this.escBuffer.length > 80) {
          this.escBuffer = null;
        }
        continue;
      }

      if (ch === '\x1b') {
        this.escBuffer = ch;
        continue;
      }
      this.writeChar(ch);
    }
  }

  snapshot(): string {
    const rendered = this.lines.map((line) => line.join('').replace(/\s+$/g, ''));
    while (rendered.length > 0 && !rendered[0].trim()) rendered.shift();
    while (rendered.length > 0 && !rendered[rendered.length - 1].trim()) rendered.pop();
    const text = rendered.join('\n').trim();
    return text.length > 3500 ? text.slice(-3500).trimStart() : text;
  }

  private writeChar(ch: string): void {
    if (ch === '\r') {
      this.cursorCol = 0;
      return;
    }
    if (ch === '\n') {
      this.newLine();
      return;
    }
    if (ch === '\b' || ch === '\x7f') {
      this.cursorCol = Math.max(0, this.cursorCol - 1);
      return;
    }
    if (ch === '\t') {
      const spaces = 4 - (this.cursorCol % 4);
      for (let i = 0; i < spaces; i++) this.putPrintable(' ');
      return;
    }
    if (ch < ' ' || ch === '\x9b') return;
    this.putPrintable(ch);
  }

  private putPrintable(ch: string): void {
    if (this.cursorCol >= this.cols) this.newLine();
    const line = this.lines[this.cursorRow] ?? [];
    while (line.length < this.cursorCol) line.push(' ');
    line[this.cursorCol] = ch;
    this.lines[this.cursorRow] = line;
    this.cursorCol++;
  }

  private newLine(): void {
    this.cursorCol = 0;
    this.cursorRow++;
    if (this.cursorRow >= this.rows) {
      this.lines.shift();
      this.lines.push([]);
      this.cursorRow = this.rows - 1;
    }
  }

  private tryHandleEscape(seq: string): boolean {
    if (seq === '\x1b' || seq === '\x1b[' || seq === '\x1b]') {
      return false;
    }
    if (seq === '\x1bc') {
      this.clearAll();
      return true;
    }
    if (seq.startsWith('\x1b]')) {
      return seq.endsWith('\x07') || seq.endsWith('\x1b\\');
    }
    if (!seq.startsWith('\x1b[')) {
      return seq.length >= 2;
    }
    if (seq.length <= 2) return false;

    const final = seq[seq.length - 1];
    if (!final || final < '@' || final > '~') return false;
    const body = seq.slice(2, -1).replace(/[?=]/g, '');
    const nums = body
      .split(';')
      .filter(Boolean)
      .map((part) => Number.parseInt(part, 10))
      .map((n) => Number.isFinite(n) ? n : 0);
    const first = nums[0] ?? 0;

    switch (final) {
      case 'A':
        this.cursorRow = Math.max(0, this.cursorRow - (first || 1));
        break;
      case 'B':
        this.cursorRow = Math.min(this.rows - 1, this.cursorRow + (first || 1));
        break;
      case 'C':
        this.cursorCol = Math.min(this.cols - 1, this.cursorCol + (first || 1));
        break;
      case 'D':
        this.cursorCol = Math.max(0, this.cursorCol - (first || 1));
        break;
      case 'G':
        this.cursorCol = Math.max(0, Math.min(this.cols - 1, (first || 1) - 1));
        break;
      case 'H':
      case 'f':
        this.cursorRow = Math.max(0, Math.min(this.rows - 1, (nums[0] || 1) - 1));
        this.cursorCol = Math.max(0, Math.min(this.cols - 1, (nums[1] || 1) - 1));
        break;
      case 'J':
        this.eraseDisplay(first);
        break;
      case 'K':
        this.eraseLine(first);
        break;
      case 'm':
      case 'h':
      case 'l':
      case 's':
      case 'u':
        break;
      default:
        break;
    }
    return true;
  }

  private clearAll(): void {
    this.lines = Array.from({ length: this.rows }, () => []);
    this.cursorRow = 0;
    this.cursorCol = 0;
  }

  private eraseDisplay(mode: number): void {
    if (mode === 2 || mode === 3) {
      this.clearAll();
      return;
    }
    if (mode === 1) {
      for (let r = 0; r < this.cursorRow; r++) this.lines[r] = [];
      this.lines[this.cursorRow] = (this.lines[this.cursorRow] ?? []).slice(this.cursorCol);
      return;
    }
    this.lines[this.cursorRow] = (this.lines[this.cursorRow] ?? []).slice(0, this.cursorCol);
    for (let r = this.cursorRow + 1; r < this.rows; r++) this.lines[r] = [];
  }

  private eraseLine(mode: number): void {
    const line = this.lines[this.cursorRow] ?? [];
    if (mode === 2) {
      this.lines[this.cursorRow] = [];
    } else if (mode === 1) {
      this.lines[this.cursorRow] = line.slice(this.cursorCol);
    } else {
      this.lines[this.cursorRow] = line.slice(0, this.cursorCol);
    }
  }
}

class AnsiStripper {
  private pending = '';

  reset(): void {
    this.pending = '';
  }

  write(input: string): string {
    const combined = this.pending + input;
    this.pending = '';
    let output = '';

    for (let i = 0; i < combined.length; i++) {
      const ch = combined[i];
      if (ch !== '\x1b') {
        output += ch === '\r' ? '\n' : ch;
        continue;
      }

      const parsed = this.consumeEscape(combined, i);
      if (parsed === null) {
        this.pending = combined.slice(i);
        break;
      }
      i = parsed - 1;
    }

    if (this.pending.length > 120) {
      this.pending = '';
    }
    return output;
  }

  private consumeEscape(input: string, start: number): number | null {
    const next = input[start + 1];
    if (!next) return null;

    if (next === '[') {
      for (let i = start + 2; i < input.length; i++) {
        const code = input.charCodeAt(i);
        if (code >= 0x40 && code <= 0x7e) {
          return i + 1;
        }
      }
      return null;
    }

    if (next === ']') {
      for (let i = start + 2; i < input.length; i++) {
        if (input[i] === '\x07') return i + 1;
        if (input[i] === '\x1b' && input[i + 1] === '\\') return i + 2;
      }
      return null;
    }

    if (next === 'P' || next === '_' || next === '^') {
      for (let i = start + 2; i < input.length; i++) {
        if (input[i] === '\x1b' && input[i + 1] === '\\') return i + 2;
      }
      return null;
    }

    return start + 2;
  }
}

export function formatScreenForWechat(screenText: string, automatic = false): string {
  const text = screenText.trim() || '当前 Codex TUI 没有可显示内容。';
  const title = automatic ? 'Codex 可能正在等待你选择：' : 'Codex 当前界面：';
  return [
    title,
    '',
    '```text',
    text,
    '```',
    '',
    '可用操作：/key up、/key down、/key enter、/key esc、/key y、/key p、/screen',
  ].join('\n');
}

function looksLikeInteractivePrompt(screenText: string): boolean {
  const lower = screenText.toLowerCase();
  const hasQuestion =
    lower.includes('run the following command') ||
    lower.includes('would you like') ||
    lower.includes('do you want') ||
    lower.includes('execute command') ||
    lower.includes('continue?') ||
    screenText.includes('权限') ||
    screenText.includes('运行命令') ||
    screenText.includes('执行命令');

  if (
    !hasQuestion &&
    (
      lower.includes('you approved') ||
      lower.includes('• working') ||
      lower.includes('• running') ||
      lower.includes('• ran ')
    )
  ) {
    return false;
  }

  const hasChoice =
    lower.includes('yes, proceed') ||
    lower.includes("don't ask again") ||
    lower.includes('tell codex what to do differently') ||
    lower.includes('no, and') ||
    screenText.includes('(y/n)') ||
    screenText.includes('(y)') ||
    screenText.includes('(p)') ||
    screenText.includes('(esc)');

  const hasActiveChoiceMarker =
    screenText.includes('›') ||
    screenText.includes('❯') ||
    screenText.includes('▸') ||
    screenText.includes('▶') ||
    screenText.includes('› 1.') ||
    screenText.includes('❯ 1.') ||
    screenText.includes('▸ 1.') ||
    screenText.includes('▶ 1.') ||
    screenText.includes('> 1.') ||
    screenText.includes('[?]');

  return hasQuestion && hasChoice && hasActiveChoiceMarker;
}

function interactivePromptSignature(screenText: string): string {
  const stableLines = screenText
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => {
      const lower = line.toLowerCase();
      if (lower.startsWith('running')) return false;
      if (lower.includes('press enter to confirm')) return false;
      if (lower.includes('press enter') && lower.includes('esc')) return false;
      return (
        lower.includes('would you like') ||
        lower.includes('run the following command') ||
        lower.includes('reason:') ||
        lower.startsWith('$ ') ||
        lower.includes('yes, proceed') ||
        lower.includes("don't ask again") ||
        lower.includes('tell codex what to do differently') ||
        lower.includes('no, and') ||
        line.includes('权限') ||
        line.includes('运行命令') ||
        line.includes('执行命令') ||
        line.includes('(y)') ||
        line.includes('(p)') ||
        line.includes('(esc)')
      );
    });

  const basis = stableLines.length > 0 ? stableLines.join('\n') : screenText;
  return basis.replace(/\s+/g, ' ').trim().slice(0, 1200);
}

// ── Helpers ──

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Compare two user-message texts loosely: whitespace-normalised and trimmed.
// We use this to recognise when Codex's `user_message` event echoes back a
// message we injected via PTY (so we can tag the turn as WeChat-sourced).
function textsMatch(a: string, b: string): boolean {
  const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
  const na = norm(a);
  const nb = norm(b);
  if (!na || !nb) return false;
  return na === nb;
}

// Parse a fenced ```wechat-attachments ... ``` block at the end of Codex's
// final answer. Matches the convention used by CLI-WeChat-Bridge so users can
// instruct Codex uniformly across projects.
//
// Example:
//   Here is the chart you requested.
//
//   ```wechat-attachments
//   image /abs/path/to/chart.png
//   file  /abs/path/to/report.pdf
//   ```
const WECHAT_ATTACHMENT_BLOCK_RE =
  /\n```wechat-attachments[ \t]*\n([\s\S]*?)\n```[ \t]*\s*$/;

function parseWechatAttachments(text: string): {
  visibleText: string;
  attachments: WechatAttachment[];
} {
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\s+$/, '');
  const padded = normalized.startsWith('\n') ? normalized : `\n${normalized}`;
  const match = padded.match(WECHAT_ATTACHMENT_BLOCK_RE);
  if (!match) return { visibleText: normalized.trim(), attachments: [] };

  const attachments: WechatAttachment[] = [];
  const lines = match[1]
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const lineRe = /^(image|file|video|voice)\s+(.+)$/i;

  for (const line of lines) {
    const m = line.match(lineRe);
    if (!m) {
      // Bail on malformed block; treat whole text as visible.
      return { visibleText: normalized.trim(), attachments: [] };
    }
    const kind = m[1].toLowerCase() as AttachmentKind;
    const path = m[2].trim().replace(/^["']|["']$/g, '');
    if (!path) continue;
    attachments.push({ kind, path });
  }

  const blockStart = padded.length - match[0].length;
  const visibleText = padded.slice(0, blockStart).trim();
  return { visibleText, attachments };
}

const PROXY_ENV_KEYS = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
  'no_proxy',
];

function buildEnv(options: NativeCodexBridgeOptions = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === 'string') env[k] = v;
  }
  if (options.proxyMode === 'clear') {
    for (const key of PROXY_ENV_KEYS) {
      delete env[key];
    }
  }
  env.TERM = env.TERM || 'xterm-256color';
  return env;
}

function parseRateLimitsFromTokenCountPayload(payload: Record<string, unknown>): CodexRateLimitsSnapshot | null {
  const info = asRecord(payload.info);
  const rateLimits = asRecord(info?.rate_limits) ?? asRecord(payload.rate_limits);
  if (!rateLimits) return null;

  const primary = parseRateLimitWindow(asRecord(rateLimits.primary));
  const secondary = parseRateLimitWindow(asRecord(rateLimits.secondary));
  const planType = typeof rateLimits.plan_type === 'string' ? rateLimits.plan_type : undefined;

  if (!primary && !secondary && !planType) return null;
  return {
    planType,
    primary: primary ?? undefined,
    secondary: secondary ?? undefined,
  };
}

function parseRateLimitWindow(input: Record<string, unknown> | null): CodexRateLimitWindow | null {
  if (!input) return null;
  const usedPercentRaw = input.used_percent;
  if (typeof usedPercentRaw !== 'number' || Number.isNaN(usedPercentRaw)) return null;
  const windowMinutes = typeof input.window_minutes === 'number' ? input.window_minutes : undefined;
  const resetsAt = typeof input.resets_at === 'number' ? input.resets_at : undefined;
  return {
    usedPercent: usedPercentRaw,
    windowMinutes,
    resetsAt,
  };
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
}

interface SessionCandidate {
  path: string;
  threadId: string;
  mtimeMs: number;
}

function findLatestSessionFile(cwd: string, notBeforeMs: number): SessionCandidate | null {
  if (!existsSync(SESSIONS_ROOT)) return null;

  const files: SessionCandidate[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > 4) return;
    let entries: string[];
    try { entries = readdirSync(dir); } catch { return; }
    for (const name of entries) {
      const full = join(dir, name);
      let st;
      try { st = statSync(full); } catch { continue; }
      if (st.isDirectory()) {
        walk(full, depth + 1);
      } else if (st.isFile() && name.endsWith('.jsonl') && name.startsWith('rollout-')) {
        if (st.mtimeMs + 1000 < notBeforeMs) continue;
        const match = /rollout-.+-([0-9a-f-]{36})\.jsonl$/.exec(name);
        const threadId = match ? match[1] : '';
        if (!threadId) continue;
        if (sessionMatchesCwd(full, cwd)) {
          files.push({ path: full, threadId, mtimeMs: st.mtimeMs });
        }
      }
    }
  };

  walk(SESSIONS_ROOT, 0);
  if (!files.length) return null;
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return files[0];
}

function sessionMatchesCwd(path: string, cwd: string): boolean {
  try {
    const content = readFileSync(path, 'utf8');
    const firstNewline = content.indexOf('\n');
    const firstLine = firstNewline === -1 ? content : content.slice(0, firstNewline);
    const parsed = JSON.parse(firstLine) as Record<string, unknown>;
    if (parsed.type !== 'session_meta') return false;
    const payload = parsed.payload as Record<string, unknown> | undefined;
    return typeof payload?.cwd === 'string' && payload.cwd === cwd;
  } catch {
    return false;
  }
}
