import { loadJson, saveJson } from './store.js';
import { mkdirSync } from 'fs';
import { DATA_DIR } from './constants.js';
import { join } from 'path';
import { DEFAULT_WORKING_DIRECTORY } from './config.js';

const SESSIONS_DIR = join(DATA_DIR, 'sessions');

export type ExecutionMode = 'plan' | 'workspace' | 'danger';
export type SessionState = 'idle' | 'processing';

export interface Session {
  threadId?: string;
  workingDirectory: string;
  model?: string;
  mode?: ExecutionMode;
  state: SessionState;
}

export function createSessionStore() {
  function getSessionPath(accountId: string): string {
    return join(SESSIONS_DIR, `${accountId}.json`);
  }

  function load(accountId: string): Session {
    return loadJson<Session>(getSessionPath(accountId), {
      workingDirectory: DEFAULT_WORKING_DIRECTORY,
      state: 'idle',
    });
  }

  function save(accountId: string, session: Session): void {
    mkdirSync(SESSIONS_DIR, { recursive: true });
    saveJson(getSessionPath(accountId), session);
  }

  function clear(accountId: string, currentSession?: Session): Session {
    const session: Session = {
      workingDirectory: currentSession?.workingDirectory ?? DEFAULT_WORKING_DIRECTORY,
      model: currentSession?.model,
      mode: currentSession?.mode,
      state: 'idle',
    };
    save(accountId, session);
    return session;
  }

  return { load, save, clear };
}
