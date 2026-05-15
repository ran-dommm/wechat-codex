import { randomBytes } from 'node:crypto';

export const WECHAT_CHANNEL_VERSION = '0.3.0';

export function randomWechatUin(): string {
  const uint32 = randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(uint32), 'utf-8').toString('base64');
}

export function createBotJsonHeaders(token: string, bodyLength: number): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${token}`,
    'AuthorizationType': 'ilink_bot_token',
    'X-WECHAT-UIN': randomWechatUin(),
    'Content-Length': String(bodyLength),
  };
}
