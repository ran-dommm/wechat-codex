import { join } from 'node:path';
import { copyFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { loadJson, saveJson } from '../store.js';
import { logger } from '../logger.js';
import { DATA_DIR } from '../constants.js';

export const DEFAULT_BASE_URL = 'https://ilinkai.weixin.qq.com';
export const CDN_BASE_URL = 'https://novac2c.cdn.weixin.qq.com/c2c';

export interface AccountData {
  botToken: string;
  accountId: string;
  baseUrl: string;
  userId: string;
  createdAt: string;
}

const ACCOUNT_PATH = join(DATA_DIR, 'wechat-account.json');
const LEGACY_ACCOUNTS_DIR = join(DATA_DIR, 'accounts');

export function saveAccount(data: AccountData): void {
  saveJson(ACCOUNT_PATH, data);
  logger.info('Account saved', { accountId: data.accountId });
}

export function loadAccount(): AccountData | null {
  migrateLegacyAccountIfNeeded();
  const data = loadJson<AccountData | null>(ACCOUNT_PATH, null);
  if (data) {
    logger.info('Account loaded', { accountId: data.accountId });
  }
  return data;
}

function migrateLegacyAccountIfNeeded(): void {
  if (existsSync(ACCOUNT_PATH)) return;

  try {
    const files = readdirSync(LEGACY_ACCOUNTS_DIR).filter((f) => f.endsWith('.json'));
    if (files.length === 0) return;

    let latestFile = files[0];
    let latestMtime = 0;

    for (const file of files) {
      const stat = statSync(join(LEGACY_ACCOUNTS_DIR, file));
      if (stat.mtimeMs > latestMtime) {
        latestMtime = stat.mtimeMs;
        latestFile = file;
      }
    }

    const from = join(LEGACY_ACCOUNTS_DIR, latestFile);
    copyFileSync(from, ACCOUNT_PATH);
    logger.warn('Migrated legacy WeChat account to single-account storage', {
      from,
      to: ACCOUNT_PATH,
      legacyCount: files.length,
    });
  } catch {
    return;
  }
}
