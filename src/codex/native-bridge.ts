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
  onInteractiveConfirmation: (prompt: string) => void;
  onWechatTurnComplete: () => void;
  onError: (message: string) => void;
  onExit: (code: number | null) => void;
}

function buildCodexArgs(mode: CodexSpawnMode): string[] {
  switch (mode) {
    case 'plan':
      return ['-s', 'read-only', '-c', 'approval_policy="on-request"'];
    case 'danger':
      return ['--dangerously-bypass-approvals-and-sandbox'];
    case 'workspace':
    default:
      return ['-s', 'workspace-write', '-c', 'approval_policy="on-request"'];
  }
}

type TurnSource = 'unknown' | 'wechat' | 'terminal';

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
  private pendingInteractiveInputEcho: string | null = null;
  private awaitingConfirmation = false;
  private ttyTail = '';

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

  get isAwaitingConfirmation(): boolean {
    return this.awaitingConfirmation;
  }

  setCwd(cwd: string): void {
    this.cwd = cwd;
  }

  submitInteractiveConfirmation(answer: 'y' | 'n'): boolean {
    if (!this.ptyProc || !this.awaitingConfirmation) return false;
    this.awaitingConfirmation = false;
    this.pendingInteractiveInputEcho = answer;
    this.ptyProc.write(answer);
    this.ptyProc.write('\r');
    return true;
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
      this.inspectInteractiveConfirmationPrompt(data);
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
    this.pendingInteractiveInputEcho = null;
    this.awaitingConfirmation = false;
    this.ttyTail = '';
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
    try { this.ptyProc.resize(cols, rows); } catch { /* resize best effort */ }
  };

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
        if (
          this.pendingInteractiveInputEcho !== null &&
          textsMatch(message, this.pendingInteractiveInputEcho)
        ) {
          this.pendingInteractiveInputEcho = null;
          return;
        }
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

  private completeActiveTurn(reason: 'complete' | 'aborted'): void {
    const turn = this.activeTurn;
    this.activeTurn = null;
    this.awaitingConfirmation = false;
    this.pendingInteractiveInputEcho = null;
    this.ttyTail = '';

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

    this.maybeDispatchQueued();
  }

  private inspectInteractiveConfirmationPrompt(data: string): void {
    const stripped = stripAnsi(data).replace(/\r/g, '\n');
    this.ttyTail = (this.ttyTail + stripped).slice(-4000);
    if (this.awaitingConfirmation) return;

    const recent = this.ttyTail.split('\n').slice(-6).join(' ').replace(/\s+/g, ' ').trim();
    if (!recent) return;
    if (!isLikelyConfirmationPrompt(recent)) return;

    this.awaitingConfirmation = true;
    const prompt = recent.length > 260 ? `...${recent.slice(-260)}` : recent;
    this.events.onInteractiveConfirmation(prompt);
  }
}

// ── Helpers ──

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function stripAnsi(input: string): string {
  return input.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');
}

function isLikelyConfirmationPrompt(text: string): boolean {
  const yn = /[\(\[]\s*y\s*\/\s*n\s*[\)\]]/i;
  if (!yn.test(text)) return false;
  const intent = /(approve|approval|confirm|run|execute|allow|permission|continue|danger|sandbox|command|tool|操作|确认|同意|允许|执行)/i;
  return intent.test(text);
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

function buildEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === 'string') env[k] = v;
  }
  env.TERM = env.TERM || 'xterm-256color';
  return env;
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
