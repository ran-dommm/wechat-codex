import { loadJson, saveJson } from './store.js';
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'fs';
import { DATA_DIR } from './constants.js';
import { join } from 'path';
import { DEFAULT_WORKING_DIRECTORY } from './config.js';
import { logger } from './logger.js';

const SESSION_PATH = join(DATA_DIR, 'session.json');
const LEGACY_SESSIONS_DIR = join(DATA_DIR, 'sessions');

export type ExecutionMode = 'plan' | 'workspace' | 'danger';
export type SessionState = 'idle' | 'processing';

export interface Session {
  threadId?: string;
  workingDirectory: string;
  model?: string;
  mode?: ExecutionMode;
  state: SessionState;
  lastRecipient?: {
    userId: string;
    contextToken: string;
  };
}

export function createSessionStore() {
  function load(): Session {
    migrateLegacySessionIfNeeded();
    return loadJson<Session>(SESSION_PATH, {
      workingDirectory: DEFAULT_WORKING_DIRECTORY,
      state: 'idle',
    });
  }

  function save(session: Session): void {
    mkdirSync(DATA_DIR, { recursive: true });
    saveJson(SESSION_PATH, session);
  }

  function clear(currentSession?: Session): Session {
    const session: Session = {
      workingDirectory: currentSession?.workingDirectory ?? DEFAULT_WORKING_DIRECTORY,
      model: currentSession?.model,
      mode: currentSession?.mode,
      lastRecipient: currentSession?.lastRecipient,
      state: 'idle',
    };
    save(session);
    return session;
  }

  return { load, save, clear };
}

function migrateLegacySessionIfNeeded(): void {
  if (existsSync(SESSION_PATH)) return;

  try {
    const files = readdirSync(LEGACY_SESSIONS_DIR).filter((f) => f.endsWith('.json'));
    if (files.length === 0) return;

    let latestFile = files[0];
    let latestMtime = 0;
    for (const file of files) {
      const stat = statSync(join(LEGACY_SESSIONS_DIR, file));
      if (stat.mtimeMs > latestMtime) {
        latestMtime = stat.mtimeMs;
        latestFile = file;
      }
    }

    const from = join(LEGACY_SESSIONS_DIR, latestFile);
    copyFileSync(from, SESSION_PATH);
    logger.warn('Migrated legacy WeChat session to single-session storage', {
      from,
      to: SESSION_PATH,
      legacyCount: files.length,
    });
  } catch {
    return;
  }
}
