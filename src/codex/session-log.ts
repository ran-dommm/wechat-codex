import { homedir } from 'node:os';
import { join, resolve as resolvePath } from 'node:path';
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';

const CODEX_HOME = process.env.CODEX_HOME || join(homedir(), '.codex');
const SESSIONS_ROOT = join(CODEX_HOME, 'sessions');

export interface SessionCandidate {
  path: string;
  threadId: string;
  mtimeMs: number;
}

export function findLatestSessionFile(cwd: string, notBeforeMs: number): SessionCandidate | null {
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
