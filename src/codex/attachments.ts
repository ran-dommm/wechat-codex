import { isAbsolute, resolve as resolvePath } from 'node:path';

export type AttachmentKind = 'image' | 'file' | 'voice' | 'video';

export interface WechatAttachment {
  kind: AttachmentKind;
  path: string;
}

const WECHAT_ATTACHMENT_BLOCK_RE =
  /\n```wechat-attachments[ \t]*\n([\s\S]*?)\n```[ \t]*\s*$/;

export function parseWechatAttachments(text: string): {
  visibleText: string;
  attachments: WechatAttachment[];
} {
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\s+$/, '');
  const padded = normalized.startsWith('\n') ? normalized : `\n${normalized}`;
  const match = padded.match(WECHAT_ATTACHMENT_BLOCK_RE);
  if (!match) return { visibleText: normalized.trim(), attachments: [] };

  const attachments: WechatAttachment[] = [];
  const lines = match[1]
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const lineRe = /^(image|file|video|voice)\s+(.+)$/i;

  for (const line of lines) {
    const m = line.match(lineRe);
    if (!m) {
      return { visibleText: normalized.trim(), attachments: [] };
    }
    const kind = m[1].toLowerCase() as AttachmentKind;
    const path = m[2].trim().replace(/^["']|["']$/g, '');
    if (!path) continue;
    attachments.push({ kind, path });
  }

  const blockStart = padded.length - match[0].length;
  const visibleText = padded.slice(0, blockStart).trim();
  return { visibleText, attachments };
}

export function resolveWechatAttachmentPaths(
  attachments: WechatAttachment[],
  cwd: string,
): WechatAttachment[] {
  return attachments.map((attachment) => ({
    kind: attachment.kind,
    path: isAbsolute(attachment.path) ? attachment.path : resolvePath(cwd, attachment.path),
  }));
}
