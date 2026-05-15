import { homedir } from 'node:os';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  readdirSync,
  readlinkSync,
  renameSync,
  statSync,
  symlinkSync,
  unlinkSync,
} from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { DATA_DIR } from '../constants.js';
import { loadJson, saveJson } from '../store.js';

export const CODEX_HOME = process.env.CODEX_HOME || join(homedir(), '.codex');
export const CODEX_AUTH_PATH = join(CODEX_HOME, 'auth.json');
export const CODEX_AUTH_PROFILE_DIR = join(DATA_DIR, 'codex-auth');
export const CODEX_AUTH_META_PATH = join(CODEX_AUTH_PROFILE_DIR, 'meta.json');

const PROFILE_NAME_RE = /^[a-zA-Z0-9_.@-]{1,64}$/;

interface CodexAuthMeta {
  profiles?: Record<string, {
    savedAt?: string;
    importedAt?: string;
    source?: string;
    lastUsedAt?: string;
  }>;
}

export interface CodexAuthProfileInfo {
  name: string;
  path: string;
  mtimeMs: number;
  isCurrent: boolean;
}

export interface CurrentCodexAuthProfile {
  exists: boolean;
  isSymlink: boolean;
  name: string | null;
  authPath: string;
  targetPath?: string;
}

export interface CodexAuthActionResult {
  changed: boolean;
  message: string;
  profilePath?: string;
  backupPath?: string;
}

export function validateProfileName(name: string): string {
  const trimmed = name.trim();
  if (!PROFILE_NAME_RE.test(trimmed)) {
    throw new Error('Profile name must match /^[a-zA-Z0-9_.@-]{1,64}$/');
  }
  if (trimmed === 'meta') {
    throw new Error('Profile name "meta" is reserved');
  }
  return trimmed;
}

export function getAuthProfilePath(name: string): string {
  return join(CODEX_AUTH_PROFILE_DIR, `${validateProfileName(name)}.json`);
}

export function listAuthProfiles(): CodexAuthProfileInfo[] {
  mkdirSync(CODEX_AUTH_PROFILE_DIR, { recursive: true });
  const current = getCurrentAuthProfile();
  const currentReal = current.targetPath ? realpathSafe(current.targetPath) : null;
  const entries = lstatEntries(CODEX_AUTH_PROFILE_DIR)
    .filter((entry) => entry.name.endsWith('.json') && entry.name !== 'meta.json')
    .map((entry) => {
      const profilePath = join(CODEX_AUTH_PROFILE_DIR, entry.name);
      const name = entry.name.slice(0, -'.json'.length);
      const profileReal = realpathSafe(profilePath);
      return {
        name,
        path: profilePath,
        mtimeMs: entry.mtimeMs,
        isCurrent: currentReal !== null && profileReal === currentReal,
      };
    });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  return entries;
}

export function getCurrentAuthProfile(): CurrentCodexAuthProfile {
  const stat = lstatSafe(CODEX_AUTH_PATH);
  if (!stat) {
    return { exists: false, isSymlink: false, name: null, authPath: CODEX_AUTH_PATH };
  }

  const isSymlink = stat.isSymbolicLink();
  const targetPath = isSymlink ? resolve(CODEX_HOME, readlinkSync(CODEX_AUTH_PATH)) : CODEX_AUTH_PATH;
  const targetReal = realpathSafe(targetPath);
  const name = findProfileNameByRealPath(targetReal);
  return {
    exists: true,
    isSymlink,
    name,
    authPath: CODEX_AUTH_PATH,
    targetPath,
  };
}

export function saveCurrentAuthProfile(name: string): CodexAuthActionResult {
  const profileName = validateProfileName(name);
  const target = getAuthProfilePath(profileName);
  const authStat = lstatSafe(CODEX_AUTH_PATH);
  if (!authStat) {
    throw new Error(`Codex auth file does not exist: ${CODEX_AUTH_PATH}`);
  }

  const sourceReal = realpathSafe(CODEX_AUTH_PATH);
  const targetReal = existsSync(target) ? realpathSafe(target) : null;
  if (sourceReal && targetReal && sourceReal === targetReal) {
    touchMeta(profileName, { savedAt: new Date().toISOString() });
    return {
      changed: false,
      message: `Codex auth profile "${profileName}" is already active; nothing to save.`,
      profilePath: target,
    };
  }

  mkdirSync(CODEX_AUTH_PROFILE_DIR, { recursive: true });
  copyFileSync(CODEX_AUTH_PATH, target);
  chmodPrivate(target);
  touchMeta(profileName, { savedAt: new Date().toISOString(), source: CODEX_AUTH_PATH });
  return {
    changed: true,
    message: `Saved current Codex auth as "${profileName}".`,
    profilePath: target,
  };
}

export function importAuthProfile(name: string, sourcePath: string): CodexAuthActionResult {
  const profileName = validateProfileName(name);
  const source = resolve(sourcePath);
  if (!existsSync(source) || !statSync(source).isFile()) {
    throw new Error(`Source auth file does not exist or is not a file: ${source}`);
  }

  const target = getAuthProfilePath(profileName);
  mkdirSync(CODEX_AUTH_PROFILE_DIR, { recursive: true });
  copyFileSync(source, target);
  chmodPrivate(target);
  touchMeta(profileName, { importedAt: new Date().toISOString(), source });
  return {
    changed: true,
    message: `Imported Codex auth profile "${profileName}" from ${source}.`,
    profilePath: target,
  };
}

export function useAuthProfile(name: string, opts: { backup?: boolean } = {}): CodexAuthActionResult {
  const profileName = validateProfileName(name);
  const target = getAuthProfilePath(profileName);
  if (!existsSync(target) || !statSync(target).isFile()) {
    throw new Error(`Codex auth profile does not exist: ${profileName}`);
  }

  mkdirSync(CODEX_HOME, { recursive: true });
  chmodPrivate(target);

  const backup = opts.backup ?? true;
  const current = lstatSafe(CODEX_AUTH_PATH);
  let backupPath: string | undefined;

  if (current) {
    if (current.isSymbolicLink()) {
      unlinkSync(CODEX_AUTH_PATH);
    } else {
      if (!backup) {
        throw new Error(`Current ${CODEX_AUTH_PATH} is a regular file. Re-run with backup enabled.`);
      }
      backupPath = join(CODEX_HOME, `auth.json.backup.${formatTimestamp(new Date())}`);
      renameSync(CODEX_AUTH_PATH, backupPath);
      chmodPrivate(backupPath);
    }
  }

  const tmpLink = join(CODEX_HOME, `.auth.json.tmp-${process.pid}-${Date.now()}`);
  try {
    symlinkSync(target, tmpLink);
    renameSync(tmpLink, CODEX_AUTH_PATH);
  } catch (err) {
    try {
      if (existsSync(tmpLink) || lstatSafe(tmpLink)) unlinkSync(tmpLink);
    } catch {
      // ignore cleanup failure
    }
    throw err;
  }

  touchMeta(profileName, { lastUsedAt: new Date().toISOString() });
  return {
    changed: true,
    message: `Switched Codex auth profile to "${profileName}".`,
    profilePath: target,
    backupPath,
  };
}

export function deleteAuthProfile(name: string): CodexAuthActionResult {
  const profileName = validateProfileName(name);
  const current = getCurrentAuthProfile();
  if (current.name === profileName) {
    throw new Error(`Cannot delete active Codex auth profile: ${profileName}`);
  }

  const target = getAuthProfilePath(profileName);
  if (!existsSync(target)) {
    throw new Error(`Codex auth profile does not exist: ${profileName}`);
  }

  unlinkSync(target);
  const meta = loadMeta();
  if (meta.profiles) {
    delete meta.profiles[profileName];
    saveJson(CODEX_AUTH_META_PATH, meta);
  }
  return {
    changed: true,
    message: `Deleted Codex auth profile "${profileName}".`,
    profilePath: target,
  };
}

function findProfileNameByRealPath(realPath: string | null): string | null {
  if (!realPath || !existsSync(CODEX_AUTH_PROFILE_DIR)) return null;
  for (const entry of lstatEntries(CODEX_AUTH_PROFILE_DIR)) {
    if (!entry.name.endsWith('.json') || entry.name === 'meta.json') continue;
    const profilePath = join(CODEX_AUTH_PROFILE_DIR, entry.name);
    if (realpathSafe(profilePath) === realPath) {
      return basename(entry.name, '.json');
    }
  }
  return null;
}

function lstatSafe(path: string): ReturnType<typeof lstatSync> | null {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}

function lstatEntries(dir: string): Array<{ name: string; mtimeMs: number }> {
  try {
    return readdirSync(dir).map((name) => ({
      name,
      mtimeMs: statSync(join(dir, name)).mtimeMs,
    }));
  } catch {
    return [];
  }
}

function realpathSafe(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

function chmodPrivate(path: string): void {
  if (process.platform !== 'win32') {
    chmodSync(path, 0o600);
  }
}

function loadMeta(): CodexAuthMeta {
  return loadJson<CodexAuthMeta>(CODEX_AUTH_META_PATH, { profiles: {} });
}

function touchMeta(profileName: string, patch: NonNullable<CodexAuthMeta['profiles']>[string]): void {
  const meta = loadMeta();
  const profiles = meta.profiles ?? {};
  profiles[profileName] = { ...(profiles[profileName] ?? {}), ...patch };
  meta.profiles = profiles;
  saveJson(CODEX_AUTH_META_PATH, meta);
}

function formatTimestamp(date: Date): string {
  return date.toISOString().replace(/[:.]/g, '-');
}
