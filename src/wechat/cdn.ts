import { decryptAesEcb } from "./crypto.js";
import { logger } from "../logger.js";
import { CDN_BASE_URL } from "./accounts.js";

export function buildCdnDownloadUrl(encryptQueryParam: string): string {
  if (!encryptQueryParam) {
    throw new Error('Invalid CDN query parameter');
  }
  return `${CDN_BASE_URL}/download?encrypted_query_param=${encodeURIComponent(encryptQueryParam)}`;
}

export async function downloadAndDecrypt(
  encryptQueryParam: string,
  aesKeyBase64: string,
): Promise<Buffer> {
  const url = buildCdnDownloadUrl(encryptQueryParam);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  let response: Response;
  try {
    response = await fetch(url, { signal: controller.signal });
  } catch (err) {
    clearTimeout(timer);
    throw new Error(`CDN download failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  clearTimeout(timer);

  if (!response.ok) {
    throw new Error(`CDN download failed: ${response.status} ${response.statusText}`);
  }

  const encrypted = Buffer.from(await response.arrayBuffer());

  let aesKey: Buffer;
  const raw = Buffer.from(aesKeyBase64, "base64");

  if (raw.length === 16) {
    aesKey = raw;
  } else {
    const hexStr = raw.toString("utf-8");
    aesKey = Buffer.from(hexStr, "hex");
  }

  const decrypted = decryptAesEcb(aesKey, encrypted);
  logger.info("CDN download and decrypt succeeded", { size: decrypted.length });

  return decrypted;
}
