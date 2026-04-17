import { homedir } from 'node:os';
import { join } from 'node:path';

export const DATA_DIR = process.env.WCB_DATA_DIR || join(homedir(), '.wechat-codex-bridge');
export const LOG_DIR = join(DATA_DIR, 'logs');
export const TMP_DIR = join(DATA_DIR, 'tmp');
export const DEFAULT_MESSAGE_CHUNK = 2048;
export const CODEX_RUN_TIMEOUT_MS = 120_000;
export const MEDIA_MAX_DURATION_SECONDS = 600;
export const MEDIA_TOOL_TIMEOUT_MS = 120_000;
