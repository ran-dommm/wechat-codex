import type {
  GetUpdatesResp,
  SendMessageReq,
  SendMessageResp,
  GetUploadUrlResp,
} from './types.js';
import { logger } from '../logger.js';
import { createBotJsonHeaders, WECHAT_CHANNEL_VERSION } from './transport.js';

export class WeChatApi {
  private readonly token: string;
  private readonly baseUrl: string;

  constructor(token: string, baseUrl: string = 'https://ilinkai.weixin.qq.com') {
    if (baseUrl && (!baseUrl.startsWith('https://') || !/(?:^|\.)(?:weixin\.qq\.com|wechat\.com)(\/|$)/.test(baseUrl.slice('https://'.length)))) {
      logger.warn('Untrusted baseUrl, using default', { baseUrl });
      baseUrl = 'https://ilinkai.weixin.qq.com';
    }
    this.token = token;
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  private headers(bodyLength: number): Record<string, string> {
    return createBotJsonHeaders(this.token, bodyLength);
  }

  private async request<T>(
    path: string,
    body: Record<string, unknown>,
    timeoutMs: number = 15_000,
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const url = `${this.baseUrl}/${path}`;
    const payload = { ...body, base_info: { channel_version: WECHAT_CHANNEL_VERSION } };
    const bodyStr = JSON.stringify(payload);

    logger.debug('API request', { url, body: payload });

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: this.headers(Buffer.byteLength(bodyStr, 'utf-8')),
        body: bodyStr,
        signal: controller.signal,
      });

      if (!res.ok) {
        const text = await res.text();
        throw new Error(`HTTP ${res.status}: ${text}`);
      }

      const json = (await res.json()) as T;
      logger.debug('API response', json);
      return json;
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        throw new Error(`Request to ${url} timed out after ${timeoutMs}ms`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  async getUpdates(buf?: string): Promise<GetUpdatesResp> {
    return this.request<GetUpdatesResp>(
      'ilink/bot/getupdates',
      buf ? { get_updates_buf: buf } : {},
      35_000,
    );
  }

  async sendMessage(req: SendMessageReq): Promise<void> {
    const resp = await this.request<SendMessageResp>(
      'ilink/bot/sendmessage',
      req as unknown as Record<string, unknown>,
    );
    if (typeof resp.ret === 'number' && resp.ret !== 0) {
      const suffix = resp.retmsg ? `: ${resp.retmsg}` : '';
      throw new Error(`sendmessage failed ret=${resp.ret}${suffix}`);
    }
  }

  async getUploadUrl(
    fileType: string,
    fileSize: number,
    fileName: string,
  ): Promise<GetUploadUrlResp> {
    return this.request<GetUploadUrlResp>(
      'ilink/bot/getuploadurl',
      { file_type: fileType, file_size: fileSize, file_name: fileName },
    );
  }
}
