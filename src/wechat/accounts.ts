import { join } from 'node:path';
import { readdirSync, statSync } from 'node:fs';
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

const ACCOUNTS_DIR = join(DATA_DIR, 'accounts');

function validateAccountId(accountId: string): void {
  if (!/^[a-zA-Z0-9_.@=-]+$/.test(accountId)) {
    throw new Error(`Invalid accountId: "${accountId}"`);
  }
}

function accountPath(accountId: string): string {
  validateAccountId(accountId);
  return join(ACCOUNTS_DIR, `${accountId}.json`);
}

export function saveAccount(data: AccountData): void {
  const filePath = accountPath(data.accountId);
  saveJson(filePath, data);
  logger.info('Account saved', { accountId: data.accountId });
}

export function loadAccount(accountId: string): AccountData | null {
  const filePath = accountPath(accountId);
  const data = loadJson<AccountData | null>(filePath, null);
  if (data) {
    logger.info('Account loaded', { accountId });
  }
  return data;
}

export function loadLatestAccount(): AccountData | null {
  try {
    const files = readdirSync(ACCOUNTS_DIR).filter((f) => f.endsWith('.json'));
    if (files.length === 0) return null;

    let latestFile = files[0];
    let latestMtime = 0;

    for (const file of files) {
      const stat = statSync(join(ACCOUNTS_DIR, file));
      if (stat.mtimeMs > latestMtime) {
        latestMtime = stat.mtimeMs;
        latestFile = file;
      }
    }

    const accountId = latestFile.replace(/\.json$/, '');
    return loadAccount(accountId);
  } catch {
    return null;
  }
}
