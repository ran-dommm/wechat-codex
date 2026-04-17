import { readFileSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import { createHash, randomBytes, createCipheriv } from 'node:crypto';
import { logger } from '../logger.js';

function randomWechatUin(): string {
  const uint32 = randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(uint32), 'utf-8').toString('base64');
}

const CDN_BASE_URL = 'https://novac2c.cdn.weixin.qq.com/c2c';
const CDN_MAX_RETRIES = 3;
const SEND_TIMEOUT_MS = 30_000;
const IMAGE_MAX_SIZE = 20 * 1024 * 1024; // 20 MB
const FILE_MAX_SIZE = 100 * 1024 * 1024; // 100 MB
// Mirrors the channel_version CLI-WeChat-Bridge sends with every WeChat API
// call. Some endpoints (including getuploadurl) reject requests that omit it.
const CHANNEL_VERSION = '0.3.0';

// Matches wechat-transport in CLI-WeChat-Bridge: 1=image, 2=video, 3=file, 4=voice.
const MEDIA_TYPE_IMAGE = 1;
const MEDIA_TYPE_VIDEO = 2;
const MEDIA_TYPE_FILE = 3;
const MEDIA_TYPE_VOICE = 4;

function aesEcbPaddedSize(plaintextSize: number): number {
  return Math.ceil((plaintextSize + 1) / 16) * 16;
}

function encryptAesEcb(plaintext: Buffer, key: Buffer): Buffer {
  const cipher = createCipheriv('aes-128-ecb', key, null);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}

export function encodeMessageAesKey(aeskey: Buffer): string {
  return Buffer.from(aeskey.toString('hex')).toString('base64');
}

interface UploadResult {
  downloadParam: string;
  aeskey: Buffer;
  filesize: number;
}

export interface FileUploadResult extends UploadResult {
  fileName: string;
  md5: string;
  rawSize: number;
}

async function getUploadUrl(
  baseUrl: string,
  token: string,
  params: {
    filekey: string;
    media_type: number;
    to_user_id: string;
    rawsize: number;
    rawfilemd5: string;
    filesize: number;
    aeskey: string;
  },
): Promise<{ upload_param?: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);

  try {
    const url = `${baseUrl}/ilink/bot/getuploadurl`;
    const body = JSON.stringify({
      ...params,
      no_need_thumb: true,
      base_info: { channel_version: CHANNEL_VERSION },
    });
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
        'AuthorizationType': 'ilink_bot_token',
        'X-WECHAT-UIN': randomWechatUin(),
        'Content-Length': String(Buffer.byteLength(body, 'utf-8')),
      },
      body,
      signal: controller.signal,
    });

    const rawBody = await res.text();
    if (!res.ok) {
      throw new Error(`getUploadUrl HTTP ${res.status}: ${rawBody}`);
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      throw new Error(`getUploadUrl returned non-JSON body: ${rawBody.slice(0, 400)}`);
    }
    logger.debug('getUploadUrl response', parsed);
    return parsed as { upload_param?: string };
  } finally {
    clearTimeout(timer);
  }
}

function buildCdnUploadUrl(uploadParam: string, filekey: string): string {
  return `${CDN_BASE_URL}/upload?encrypted_query_param=${encodeURIComponent(uploadParam)}&filekey=${encodeURIComponent(filekey)}`;
}

async function uploadBufferToCdn(
  buf: Buffer,
  uploadParam: string,
  filekey: string,
  aeskey: Buffer,
): Promise<string> {
  const ciphertext = encryptAesEcb(buf, aeskey);
  const cdnUrl = buildCdnUploadUrl(uploadParam, filekey);

  let downloadParam: string | undefined;
  let lastError: unknown;

  for (let attempt = 1; attempt <= CDN_MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(cdnUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: new Uint8Array(ciphertext),
      });

      if (res.status >= 400 && res.status < 500) {
        const errMsg = res.headers.get('x-error-message') ?? (await res.text());
        throw new Error(`CDN client error ${res.status}: ${errMsg}`);
      }
      if (res.status !== 200) {
        const errMsg = res.headers.get('x-error-message') ?? `status ${res.status}`;
        throw new Error(`CDN server error: ${errMsg}`);
      }

      downloadParam = res.headers.get('x-encrypted-param') ?? undefined;
      if (!downloadParam) {
        throw new Error('CDN response missing x-encrypted-param header');
      }
      break;
    } catch (err) {
      lastError = err;
      if (err instanceof Error && err.message.includes('client error')) {
        throw err;
      }
      if (attempt >= CDN_MAX_RETRIES) break;
      logger.warn(`CDN upload attempt ${attempt} failed, retrying...`);
    }
  }

  if (!downloadParam) {
    throw lastError instanceof Error ? lastError : new Error('CDN upload failed');
  }

  return downloadParam;
}

async function prepareUpload(
  baseUrl: string,
  token: string,
  toUserId: string,
  filePath: string,
  mediaType: number,
  label: string,
  maxSize: number,
): Promise<FileUploadResult> {
  const stat = statSync(filePath);
  if (!stat.isFile()) {
    throw new Error(`Not a file: ${filePath}`);
  }
  if (stat.size > maxSize) {
    throw new Error(`${label} too large: ${stat.size} bytes exceeds ${maxSize} limit`);
  }

  const plaintext = readFileSync(filePath);
  const rawsize = plaintext.length;
  const rawfilemd5 = createHash('md5').update(plaintext).digest('hex');
  const filesize = aesEcbPaddedSize(rawsize);
  const filekey = randomBytes(16).toString('hex');
  const aeskey = randomBytes(16);
  const fileName = basename(filePath);

  logger.info(`Uploading ${label}`, { filePath, rawsize });

  const uploadResp = await getUploadUrl(baseUrl, token, {
    filekey,
    media_type: mediaType,
    to_user_id: toUserId,
    rawsize,
    rawfilemd5,
    filesize,
    aeskey: aeskey.toString('hex'),
  });

  if (!uploadResp.upload_param) {
    throw new Error('getUploadUrl returned no upload_param');
  }

  const downloadParam = await uploadBufferToCdn(plaintext, uploadResp.upload_param, filekey, aeskey);

  logger.info(`${label} upload complete`, { downloadParamLength: downloadParam.length });

  return { downloadParam, aeskey, filesize, fileName, md5: rawfilemd5, rawSize: rawsize };
}

export async function uploadImage(
  baseUrl: string,
  token: string,
  toUserId: string,
  filePath: string,
): Promise<UploadResult> {
  const result = await prepareUpload(
    baseUrl, token, toUserId, filePath,
    MEDIA_TYPE_IMAGE, 'image', IMAGE_MAX_SIZE,
  );
  return { downloadParam: result.downloadParam, aeskey: result.aeskey, filesize: result.filesize };
}

export async function uploadFile(
  baseUrl: string,
  token: string,
  toUserId: string,
  filePath: string,
): Promise<FileUploadResult> {
  return prepareUpload(
    baseUrl, token, toUserId, filePath,
    MEDIA_TYPE_FILE, 'file', FILE_MAX_SIZE,
  );
}

export async function uploadVoice(
  baseUrl: string,
  token: string,
  toUserId: string,
  filePath: string,
): Promise<FileUploadResult> {
  return prepareUpload(
    baseUrl, token, toUserId, filePath,
    MEDIA_TYPE_VOICE, 'voice', FILE_MAX_SIZE,
  );
}

export async function uploadVideo(
  baseUrl: string,
  token: string,
  toUserId: string,
  filePath: string,
): Promise<FileUploadResult> {
  return prepareUpload(
    baseUrl, token, toUserId, filePath,
    MEDIA_TYPE_VIDEO, 'video', FILE_MAX_SIZE,
  );
}
