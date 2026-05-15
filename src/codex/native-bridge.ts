import { homedir } from 'node:os';
import { isAbsolute, join, resolve as resolvePath } from 'node:path';
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  statSync,
} from 'node:fs';
import * as pty from 'node-pty';
import { logger } from '../logger.js';

const CODEX_HOME = process.env.CODEX_HOME || join(homedir(), '.codex');
const SESSIONS_ROOT = join(CODEX_HOME, 'sessions');
const SESSION_POLL_INTERVAL_MS = 100;
const SESSION_DISCOVER_INTERVAL_MS = 200;
const TERMINAL_IDLE_BEFORE_INJECT_MS = 1500;

export type CodexSpawnMode = 'plan' | 'workspace' | 'danger';

export type AttachmentKind = 'image' | 'file' | 'voice' | 'video';

export interface WechatAttachment {
  kind: AttachmentKind;
  path: string;
}

export interface NativeBridgeEvents {
  onWechatReply: (text: string) => void | Promise<void>;
  onWechatAttachment: (attachment: WechatAttachment) => void | Promise<void>;
  onWechatTurnComplete: () => void;
  onTurnFinalized?: (info: { source: BridgeTurnSource; reason: BridgeTurnReason }) => void | Promise<void>;
  onTerminalUserMessage?: (message: string) => boolean;
  onError: (message: string) => void;
  onExit: (code: number | null) => void;
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

function buildCodexArgs(mode: CodexSpawnMode): string[] {
  switch (mode) {
    case 'plan':
      return ['-s', 'read-only', '-c', 'approval_policy="never"'];
    case 'danger':
      return ['--dangerously-bypass-approvals-and-sandbox'];
    case 'workspace':
    default:
      return ['-s', 'workspace-write', '-c', 'approval_policy="never"'];
  }
}

type TurnSource = 'unknown' | 'wechat' | 'terminal';
export type BridgeTurnSource = TurnSource;
export type BridgeTurnReason = 'complete' | 'aborted';

interface ActiveTurn {
  turnId: string | null;
  source: TurnSource;
  texts: string[];
  suppressWechatOutput?: boolean;
  finalEmitted?: boolean;
  finalDelivery?: Promise<void>;
  // Buffered commentary messages that arrived before user_message (rare).
  // Once source is resolved they are flushed to WeChat.
  pendingCommentary: string[];
}

interface PendingWechatInjection {
  id: string;
  text: string;
  startedAtMs: number;
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
  // WeChat text injected via PTY that is still waiting to be echoed by Codex as
  // a `user_message` event. When we see a matching user_message, we know the
  // turn is WeChat-sourced; anything else is terminal.
  private pendingWechatInjection: PendingWechatInjection | null = null;
  private latestRateLimits: CodexRateLimitsSnapshot | null = null;
  private injectionCounter = 0;
  private lastStdinAtMs = 0;
  private dispatchTimer: NodeJS.Timeout | null = null;

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

  interruptAndClearQueue(): { interrupted: boolean; clearedQueued: number } {
    const clearedQueued = this.wechatQueue.length;
    this.wechatQueue = [];
    this.pendingWechatInjection = null;
    this.clearDispatchTimer();

    if (!this.ptyProc) {
      return { interrupted: false, clearedQueued };
    }

    // Send Ctrl-C to interrupt the current foreground action in the TUI.
    this.ptyProc.write('\x03');
    return { interrupted: true, clearedQueued };
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
      env: buildEnv(),
    });

    this.ptyProc = child;

    child.onData((data) => {
      if (myGen !== this.generation) return;
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

  async restart(newCwd?: string, newMode?: CodexSpawnMode): Promise<void> {
    if (this.restarting) {
      await this.restarting;
    }
    this.restarting = this.doRestart(newCwd, newMode);
    try {
      await this.restarting;
    } finally {
      this.restarting = null;
    }
  }

  private async doRestart(newCwd?: string, newMode?: CodexSpawnMode): Promise<void> {
    if (newCwd) this.cwd = newCwd;
    if (newMode) this.mode = newMode;

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
    this.clearDispatchTimer();
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
    const fullText = sanitizeBridgeInjectionMarkers(parts.join('\n'));
    this.wechatQueue.push(fullText);
    this.maybeDispatchQueued();
  }

  // ── stdin forwarding ──

  private stdinListener = (data: Buffer) => {
    this.lastStdinAtMs = Date.now();
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
    try { this.ptyProc.resize(cols, rows); } catch { /* resize best effort */ }
  };

  // ── WeChat input dispatch ──

  private maybeDispatchQueued(): void {
    if (!this.ptyProc) return;
    // Don't inject while any turn is running or another WeChat injection is
    // still awaiting its user_message echo.
    if (this.activeTurn || this.pendingWechatInjection !== null) return;
    const idleForMs = Date.now() - this.lastStdinAtMs;
    if (this.lastStdinAtMs > 0 && idleForMs < TERMINAL_IDLE_BEFORE_INJECT_MS) {
      this.scheduleDispatch(TERMINAL_IDLE_BEFORE_INJECT_MS - idleForMs);
      return;
    }
    const next = this.wechatQueue.shift();
    if (!next) return;

    const injection = this.createWechatInjection(next);
    this.pendingWechatInjection = injection;
    void this.injectMessage(injection);
  }

  // Inject a message into the PTY as if typed by the user, then submit.
  //
  // Codex's TUI detects fast multi-char input as a "paste" and holds a
  // trailing Enter, waiting for the user to press Enter again. To work around
  // this, we write the body, settle for a moment so the TUI exits paste mode,
  // then send a standalone Enter to actually submit.
  private async injectMessage(injection: PendingWechatInjection): Promise<void> {
    if (!this.ptyProc) return;

    // Normalize: Codex composer uses \r for newline within the input field;
    // \n can be interpreted inconsistently depending on TUI state.
    const normalized = injection.text.replace(/\r?\n/g, '\r');

    this.ptyProc.write(normalized);
    await delay(120);
    if (!this.ptyProc) return;
    this.ptyProc.write('\r');

    // Safety net: retry Enter only while the terminal is idle. This avoids
    // submitting a human's half-written next prompt after Codex/TUI warmup.
    setTimeout(() => {
      const stillPending = this.pendingWechatInjection?.id === injection.id;
      const terminalIdle = Date.now() - this.lastStdinAtMs >= TERMINAL_IDLE_BEFORE_INJECT_MS;
      if (stillPending && terminalIdle && this.ptyProc) {
        this.ptyProc.write('\r');
      }
    }, 2500);
  }

  private createWechatInjection(text: string): PendingWechatInjection {
    const id = `${Date.now().toString(36)}-${++this.injectionCounter}`;
    return {
      id,
      text,
      startedAtMs: Date.now(),
    };
  }

  private scheduleDispatch(delayMs: number): void {
    if (this.dispatchTimer) return;
    this.dispatchTimer = setTimeout(() => {
      this.dispatchTimer = null;
      this.maybeDispatchQueued();
    }, Math.max(50, delayMs));
    this.dispatchTimer.unref?.();
  }

  private clearDispatchTimer(): void {
    if (this.dispatchTimer) {
      clearTimeout(this.dispatchTimer);
      this.dispatchTimer = null;
    }
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
      logger.info('Bound Codex session file', { path: candidate.path, threadId: candidate.threadId });
    }
  }

  private pollOnce(): void {
    if (!this.sessionFilePath) {
      this.discoverSessionFile();
      if (!this.sessionFilePath) return;
    }

    let size: number;
    try {
      size = statSync(this.sessionFilePath).size;
    } catch {
      this.sessionFilePath = null;
      this.sessionReadOffset = 0;
      this.sessionPartialLine = '';
      return;
    }

    if (size < this.sessionReadOffset) {
      logger.warn('Codex session log shrank; skipping existing content to avoid replay', {
        path: this.sessionFilePath,
        oldOffset: this.sessionReadOffset,
        newSize: size,
      });
      this.sessionReadOffset = size;
      this.sessionPartialLine = '';
      return;
    }

    if (size === this.sessionReadOffset) return;

    const readOffset = this.sessionReadOffset;
    const length = size - readOffset;
    const buffer = Buffer.allocUnsafe(length);
    let fd: number | null = null;
    let bytesRead = 0;
    try {
      fd = openSync(this.sessionFilePath, 'r');
      bytesRead = readSync(fd, buffer, 0, length, readOffset);
    } catch {
      this.sessionFilePath = null;
      this.sessionReadOffset = 0;
      this.sessionPartialLine = '';
      return;
    } finally {
      if (fd !== null) {
        try { closeSync(fd); } catch { /* best effort */ }
      }
    }
    this.sessionReadOffset = readOffset + bytesRead;
    if (bytesRead <= 0) return;

    const newData = buffer.subarray(0, bytesRead).toString('utf8');

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
      const injectionId = extractWechatInjectionId(message);
      const matchedPendingInjection =
        this.pendingWechatInjection !== null &&
        wechatInjectionMatches(message, this.pendingWechatInjection);

      // If this matches our pending WeChat injection, the turn is WeChat-sourced.
      if (matchedPendingInjection) {
        this.activeTurn.source = 'wechat';
        this.pendingWechatInjection = null;
      } else if (injectionId) {
        this.activeTurn.source = 'wechat';
        logger.warn('Observed stale or unknown WeChat injection marker', { injectionId });
      } else {
        if (this.pendingWechatInjection !== null) {
          logger.warn('Terminal turn arrived while WeChat injection was pending; requeueing injection', {
            injectionAgeMs: Date.now() - this.pendingWechatInjection.startedAtMs,
          });
          this.wechatQueue.unshift(this.pendingWechatInjection.text);
          this.pendingWechatInjection = null;
        }
        this.activeTurn.source = 'terminal';
        if (message.trim()) {
          const handled = this.events.onTerminalUserMessage?.(message) ?? false;
          if (handled) {
            this.activeTurn.suppressWechatOutput = true;
          }
          if (!handled) {
            logger.info('Forwarding terminal input to WeChat', { messageLength: message.length });
            this.events.onWechatReply(`⌨️ 终端输入：${message}`);
          }
        }
      }

      // Flush any commentary that arrived before source was resolved.
      if (!this.activeTurn.suppressWechatOutput) {
        for (const c of this.activeTurn.pendingCommentary) {
          void this.emitCommentary(this.activeTurn, c);
        }
      }
      this.activeTurn.pendingCommentary = [];
      if (
        this.activeTurn.texts.length > 0 &&
        !this.activeTurn.finalEmitted &&
        !this.activeTurn.suppressWechatOutput &&
        (this.activeTurn.source === 'wechat' || this.activeTurn.source === 'terminal')
      ) {
        void this.emitResolvedTurnFinal(this.activeTurn);
      }
      return;
    }

    if (payloadType === 'agent_message') {
      const message = typeof payload.message === 'string' ? payload.message : '';
      const phase = typeof payload.phase === 'string' ? payload.phase : '';
      if (!message || !this.activeTurn) return;
      if (phase === 'final_answer') {
        this.activeTurn.texts.push(message);
        if (
          !this.activeTurn.finalEmitted &&
          !this.activeTurn.suppressWechatOutput &&
          (this.activeTurn.source === 'wechat' || this.activeTurn.source === 'terminal')
        ) {
          void this.emitResolvedTurnFinal(this.activeTurn);
        }
      } else if (phase === 'commentary') {
        if (this.activeTurn.suppressWechatOutput) return;
        if (this.activeTurn.source === 'unknown') {
          this.activeTurn.pendingCommentary.push(message);
        } else {
          void this.emitCommentary(this.activeTurn, message);
        }
      }
      return;
    }

    if (payloadType === 'task_complete' || payloadType === 'turn_aborted') {
      void this.completeActiveTurn(payloadType === 'turn_aborted' ? 'aborted' : 'complete');
      return;
    }
  }

  private async completeActiveTurn(reason: BridgeTurnReason): Promise<void> {
    const turn = this.activeTurn;
    this.activeTurn = null;

    if (!turn) {
      this.maybeDispatchQueued();
      return;
    }

    const source = turn.source;

    try {
      if (turn.suppressWechatOutput) {
        logger.info('Suppressing Codex output for handled terminal command', { turnId: turn.turnId });
      } else if (source === 'wechat' || source === 'terminal') {
        if (reason === 'aborted') {
          if (source === 'wechat') this.events.onError('Turn aborted');
        } else {
          await this.emitResolvedTurnFinal(turn);
        }
        if (source === 'wechat') {
          this.events.onWechatTurnComplete();
        }
      } else if (reason === 'complete') {
        const { visibleText, attachments } = this.parseTurnOutput(turn);
        logger.warn('Completing Codex turn with unknown source', {
          turnId: turn.turnId,
          finalTextLength: visibleText.length,
          commentaryCount: turn.pendingCommentary.length,
        });
        for (const c of turn.pendingCommentary) {
          await this.emitCommentary(turn, c);
        }
        if (visibleText) {
          await this.events.onWechatReply(`⚠️ 未识别来源的 Codex 输出：\n${visibleText}`);
        }
        for (const a of attachments) {
          await this.events.onWechatAttachment(a);
        }
      }
    } catch (err) {
      logger.warn('Failed while finalizing Codex turn output', {
        turnId: turn.turnId,
        source,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    try {
      await this.events.onTurnFinalized?.({ source, reason });
    } finally {
      this.maybeDispatchQueued();
    }
  }

  private parseTurnOutput(turn: ActiveTurn): {
    visibleText: string;
    attachments: WechatAttachment[];
  } {
    const texts = turn.texts.map((t) => t.trim()).filter(Boolean);
    const rawFinal = texts.join('\n\n');
    const parsed = parseWechatAttachments(rawFinal);
    return {
      visibleText: parsed.visibleText,
      attachments: parsed.attachments.map((a) => ({
        kind: a.kind,
        path: isAbsolute(a.path) ? a.path : resolvePath(this.cwd, a.path),
      })),
    };
  }

  private async emitCommentary(turn: ActiveTurn, message: string): Promise<void> {
    if (turn.source !== 'wechat' && turn.source !== 'terminal') return;
    await this.events.onWechatReply(`💭 ${message}`);
  }

  private emitResolvedTurnFinal(turn: ActiveTurn): Promise<void> {
    if (turn.finalEmitted) {
      return turn.finalDelivery ?? Promise.resolve();
    }

    turn.finalEmitted = true;
    const delivery = (async () => {
      const { visibleText, attachments } = this.parseTurnOutput(turn);
      if (visibleText) await this.events.onWechatReply(visibleText);
      for (const a of attachments) {
        await this.events.onWechatAttachment(a);
      }
    })();

    turn.finalDelivery = delivery;
    return delivery;
  }
}

// ── Helpers ──

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function extractWechatInjectionId(text: string): string | null {
  const match = text.match(/<!--\s*wcb-injection:([a-z0-9-]+)\s*-->/i);
  return match?.[1] ?? null;
}

function sanitizeBridgeInjectionMarkers(text: string): string {
  return text.replace(/<!--\s*wcb-injection:[a-z0-9-]+\s*-->/gi, '');
}

function normalizeUserMessageText(text: string): string {
  return sanitizeBridgeInjectionMarkers(text).replace(/\s+/g, ' ').trim();
}

function wechatInjectionMatches(message: string, injection: PendingWechatInjection): boolean {
  const injectionId = extractWechatInjectionId(message);
  if (injectionId && injectionId === injection.id) return true;

  const normalizedMessage = normalizeUserMessageText(message);
  if (!normalizedMessage) return false;

  return (
    normalizedMessage === normalizeUserMessageText(injection.text)
  );
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

function buildEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === 'string') env[k] = v;
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
    return (
      typeof payload?.cwd === 'string' &&
      normalizePathForCompare(payload.cwd) === normalizePathForCompare(cwd) &&
      (payload.approval_policy === 'never' || payload.approval_policy === undefined)
    );
  } catch {
    return false;
  }
}

function normalizePathForCompare(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolvePath(path);
  }
}
