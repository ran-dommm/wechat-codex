import { mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { MessageItem } from './types.js';
import { MessageItemType, type CDNMedia } from './types.js';
import { downloadAndDecrypt } from './cdn.js';
import { logger } from '../logger.js';
import { MEDIA_MAX_DURATION_SECONDS, TMP_DIR } from '../constants.js';
import {
  extractAudioForTranscription as defaultExtractAudioForTranscription,
  extractVideoPreviewImage as defaultExtractVideoPreviewImage,
  probeMedia as defaultProbeMedia,
  transcribeAudio as defaultTranscribeAudio,
  type MediaProbeResult,
} from '../media/transcribe.js';

export type SupportedMediaKind = 'image' | 'voice' | 'audio' | 'video';

export interface SupportedMedia {
  kind: SupportedMediaKind;
  item: MessageItem;
}

export interface PreparedMediaForCodex {
  kind: SupportedMediaKind;
  defaultPrompt: string;
  promptFragments: string[];
  imagePaths: string[];
  tempFiles: string[];
  immediateReply?: string;
}

export interface MediaPreparationDeps {
  downloadBinaryMediaToTemp: (item: MessageItem) => Promise<string | null>;
  probeMedia: (filePath: string) => Promise<MediaProbeResult>;
  extractAudioForTranscription: (filePath: string, maxDurationSeconds?: number) => Promise<string>;
  extractVideoPreviewImage: (filePath: string) => Promise<string>;
  transcribeAudio: (filePath: string, durationSeconds?: number) => Promise<string>;
}

const defaultMediaPreparationDeps: MediaPreparationDeps = {
  downloadBinaryMediaToTemp,
  probeMedia: defaultProbeMedia,
  extractAudioForTranscription: defaultExtractAudioForTranscription,
  extractVideoPreviewImage: defaultExtractVideoPreviewImage,
  transcribeAudio: defaultTranscribeAudio,
};

function detectMimeType(data: Buffer): string {
  if (data[0] === 0x89 && data[1] === 0x50) return 'image/png';
  if (data[0] === 0xFF && data[1] === 0xD8) return 'image/jpeg';
  if (data[0] === 0x47 && data[1] === 0x49) return 'image/gif';
  if (data[0] === 0x52 && data[1] === 0x49) return 'image/webp';
  if (data[0] === 0x42 && data[1] === 0x4D) return 'image/bmp';
  return 'image/jpeg'; // fallback
}

function extensionForMimeType(mimeType: string): string {
  switch (mimeType) {
    case 'image/png':
      return '.png';
    case 'image/gif':
      return '.gif';
    case 'image/webp':
      return '.webp';
    case 'image/bmp':
      return '.bmp';
    default:
      return '.jpg';
  }
}

function detectBinaryExtension(data: Buffer, item: MessageItem): string {
  const fileName = item.file_item?.file_name;
  const hintedExtension = fileName ? extname(fileName) : '';
  if (hintedExtension) {
    return hintedExtension;
  }
  if (data.length >= 12 && data.subarray(4, 8).toString('ascii') === 'ftyp') return '.mp4';
  if (data.subarray(0, 3).toString('ascii') === 'ID3') return '.mp3';
  if (data.length >= 10 && data.subarray(1, 10).toString('ascii') === '#!SILK_V3') return '.silk';
  if (data.subarray(0, 4).toString('ascii') === 'RIFF') return '.wav';
  if (data.subarray(0, 4).toString('ascii') === 'OggS') return '.ogg';
  if (data.subarray(0, 4).toString('ascii') === 'fLaC') return '.flac';
  return '.bin';
}

function createTempFilePath(extension: string): string {
  mkdirSync(TMP_DIR, { recursive: true });
  return join(TMP_DIR, `${randomUUID()}${extension}`);
}

function createPreparedMedia(kind: SupportedMediaKind, defaultPrompt: string): PreparedMediaForCodex {
  return {
    kind,
    defaultPrompt,
    promptFragments: [],
    imagePaths: [],
    tempFiles: [],
  };
}

function trimTranscript(text?: string): string | undefined {
  const trimmed = text?.trim();
  return trimmed ? trimmed : undefined;
}

function describeMediaError(kind: 'audio' | 'video', error: unknown): string {
  const msg = error instanceof Error ? error.message : String(error);

  if (msg.includes('Missing required tool: whisper')) {
    return `⚠️ ${kind === 'audio' ? '音频' : '视频'}已收到，但本机缺少 whisper，无法转写语音。`;
  }
  if (msg.includes('Missing required tool: ffmpeg') || msg.includes('Missing required tool: ffprobe')) {
    return `⚠️ ${kind === 'audio' ? '音频' : '视频'}已收到，但本机缺少 ffmpeg/ffprobe，暂时无法处理。`;
  }
  if (msg.includes('timed out')) {
    return `⚠️ ${kind === 'audio' ? '音频' : '视频'}已收到，但转写超时。请发送更短的${kind === 'audio' ? '音频' : '视频'}。`;
  }
  return `⚠️ ${kind === 'audio' ? '音频' : '视频'}已收到，但处理失败：${msg.slice(0, 160)}`;
}

/**
 * Download a CDN image, decrypt it, and write it to a local temp file for
 * `codex --image`.
 */
export async function downloadImageToTemp(item: MessageItem): Promise<string | null> {
  const cdnMedia = extractImageCdnMedia(item);
  if (!cdnMedia) {
    return null;
  }

  try {
    const encryptQueryParam = cdnMedia.encrypt_query_param;
    const aesKeyBase64 = extractImageAesKeyBase64(item);
    if (!encryptQueryParam || !aesKeyBase64) {
      logger.warn('Image payload missing CDN download fields');
      return null;
    }

    const decrypted = await downloadAndDecrypt(encryptQueryParam, aesKeyBase64);
    const mimeType = detectMimeType(decrypted);
    const filePath = createTempFilePath(extensionForMimeType(mimeType));
    writeFileSync(filePath, decrypted);
    logger.info('Image downloaded to temp file', { filePath, size: decrypted.length });
    return filePath;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn('Failed to download image', { error: msg });
    return null;
  }
}

export function cleanupTempFiles(filePaths: string[]): void {
  for (const filePath of filePaths) {
    try {
      unlinkSync(filePath);
    } catch {
      logger.warn('Failed to remove temp image', { filePath });
    }
  }
}

/**
 * Extract text content from a message item.
 * Returns text_item.text or empty string.
 */
export function extractText(item: MessageItem): string {
  return item.text_item?.text ?? '';
}

export function extractAnyCdnMedia(item: MessageItem): CDNMedia | undefined {
  switch (item.type) {
    case MessageItemType.IMAGE:
      return item.image_item?.cdn_media ?? item.image_item?.media;
    case MessageItemType.VOICE:
      return item.voice_item?.media ?? item.voice_item?.cdn_media;
    case MessageItemType.FILE:
      return item.file_item?.media ?? item.file_item?.cdn_media;
    case MessageItemType.VIDEO:
      return item.video_item?.media ?? item.video_item?.cdn_media;
    default:
      return undefined;
  }
}

export function extractImageCdnMedia(item: MessageItem): CDNMedia | undefined {
  return extractAnyCdnMedia(item);
}

export function extractImageAesKeyBase64(item: MessageItem): string | undefined {
  const hexKey = item.image_item?.aeskey;
  if (hexKey) {
    return Buffer.from(hexKey, 'hex').toString('base64');
  }
  return extractImageCdnMedia(item)?.aes_key;
}

export function extractVoiceTranscript(item: MessageItem): string | undefined {
  return trimTranscript(item.voice_item?.text) ?? trimTranscript(item.voice_item?.voice_text);
}

export function extractFirstSupportedMedia(items?: MessageItem[]): SupportedMedia | undefined {
  const match = items?.find((item) => (
    item.type === MessageItemType.IMAGE
    || item.type === MessageItemType.VOICE
    || item.type === MessageItemType.FILE
    || item.type === MessageItemType.VIDEO
  ));

  if (!match) {
    return undefined;
  }

  switch (match.type) {
    case MessageItemType.IMAGE:
      return { kind: 'image', item: match };
    case MessageItemType.VOICE:
      return { kind: 'voice', item: match };
    case MessageItemType.FILE:
      return { kind: 'audio', item: match };
    case MessageItemType.VIDEO:
      return { kind: 'video', item: match };
    default:
      return undefined;
  }
}

export async function downloadBinaryMediaToTemp(item: MessageItem): Promise<string | null> {
  const cdnMedia = extractAnyCdnMedia(item);
  if (!cdnMedia?.encrypt_query_param || !cdnMedia?.aes_key) {
    return null;
  }

  try {
    const decrypted = await downloadAndDecrypt(cdnMedia.encrypt_query_param, cdnMedia.aes_key);
    const filePath = createTempFilePath(detectBinaryExtension(decrypted, item));
    writeFileSync(filePath, decrypted);
    logger.info('Binary media downloaded to temp file', { filePath, size: decrypted.length, type: item.type });
    return filePath;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn('Failed to download binary media', { error: msg, type: item.type });
    return null;
  }
}

function buildVideoDurationText(durationSeconds: number, fallbackSeconds?: number): string | undefined {
  const seconds = durationSeconds > 0 ? durationSeconds : (fallbackSeconds ?? 0);
  if (!seconds) {
    return undefined;
  }
  return `视频时长：${Math.round(seconds)} 秒`;
}

async function prepareAudioForCodex(
  item: MessageItem,
  deps: MediaPreparationDeps,
): Promise<PreparedMediaForCodex> {
  const prepared = createPreparedMedia('audio', '请根据下面的微信音频转写内容回答用户。');

  try {
    const mediaPath = await deps.downloadBinaryMediaToTemp(item);
    if (!mediaPath) {
      prepared.immediateReply = '⚠️ 音频已收到，但下载或解密失败。请重发一次音频。';
      return prepared;
    }
    prepared.tempFiles.push(mediaPath);

    const probe = await deps.probeMedia(mediaPath);
    if (!probe.hasAudio) {
      prepared.immediateReply = '⚠️ 文件已收到，但没有检测到可转写的音频流。请发送音频或视频文件。';
      return prepared;
    }
    if (probe.durationSeconds > MEDIA_MAX_DURATION_SECONDS) {
      prepared.immediateReply = '⚠️ 音频已收到，但当前只自动处理 10 分钟内的音频。请截短后重发。';
      return prepared;
    }

    const extractedAudioPath = await deps.extractAudioForTranscription(mediaPath, MEDIA_MAX_DURATION_SECONDS);
    prepared.tempFiles.push(extractedAudioPath);

    const transcript = trimTranscript(await deps.transcribeAudio(extractedAudioPath, probe.durationSeconds));
    if (!transcript) {
      prepared.immediateReply = '⚠️ 音频已收到，但没有识别出可用语音内容。请换一段更清晰的音频再试。';
      return prepared;
    }

    if (item.file_item?.file_name) {
      prepared.promptFragments.push(`音频文件：${item.file_item.file_name}`);
    }
    prepared.promptFragments.push(`音频转写：\n${transcript}`);
    return prepared;
  } catch (error) {
    prepared.immediateReply = describeMediaError('audio', error);
    return prepared;
  }
}

async function prepareVideoForCodex(
  item: MessageItem,
  deps: MediaPreparationDeps,
): Promise<PreparedMediaForCodex> {
  const prepared = createPreparedMedia('video', '请结合下面的视频关键帧和语音转写内容回答用户。');

  try {
    const mediaPath = await deps.downloadBinaryMediaToTemp(item);
    if (!mediaPath) {
      prepared.immediateReply = '⚠️ 视频已收到，但下载或解密失败。请重发一次视频。';
      return prepared;
    }
    prepared.tempFiles.push(mediaPath);

    const probe = await deps.probeMedia(mediaPath);
    const durationText = buildVideoDurationText(probe.durationSeconds, item.video_item?.play_length);
    if (durationText) {
      prepared.promptFragments.push(durationText);
    }

    if (probe.hasVideo) {
      try {
        const previewPath = await deps.extractVideoPreviewImage(mediaPath);
        prepared.tempFiles.push(previewPath);
        prepared.imagePaths.push(previewPath);
      } catch (error) {
        logger.warn('Failed to extract video preview image', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (probe.hasAudio) {
      if (probe.durationSeconds > MEDIA_MAX_DURATION_SECONDS) {
        prepared.promptFragments.push('未提取视频语音转写：视频时长超过 10 分钟自动转写上限。');
      } else {
        try {
          const extractedAudioPath = await deps.extractAudioForTranscription(mediaPath, MEDIA_MAX_DURATION_SECONDS);
          prepared.tempFiles.push(extractedAudioPath);
          const transcript = trimTranscript(await deps.transcribeAudio(extractedAudioPath, probe.durationSeconds));
          if (transcript) {
            prepared.promptFragments.push(`视频语音转写：\n${transcript}`);
          } else {
            prepared.promptFragments.push('未提取视频语音转写：未识别到可用语音内容。');
          }
        } catch (error) {
          prepared.promptFragments.push(`未提取视频语音转写：${describeMediaError('video', error)}`);
        }
      }
    }

    if (!prepared.promptFragments.some((fragment) => fragment.startsWith('视频语音转写：'))) {
      prepared.defaultPrompt = prepared.imagePaths.length
        ? '请先根据下面的视频关键帧回答用户，并说明当前没有可用的语音转写。'
        : '请根据下面的视频信息回答用户，并说明当前没有可用的语音转写。';
    }

    if (!prepared.imagePaths.length && !prepared.promptFragments.some((fragment) => fragment.startsWith('视频语音转写：'))) {
      prepared.immediateReply = '⚠️ 视频已收到，但未能提取关键帧或语音转写。请重发更短的视频。';
    }

    return prepared;
  } catch (error) {
    prepared.immediateReply = describeMediaError('video', error);
    return prepared;
  }
}

export async function prepareMediaForCodex(
  media: SupportedMedia,
  deps: Partial<MediaPreparationDeps> = {},
): Promise<PreparedMediaForCodex> {
  const resolvedDeps = { ...defaultMediaPreparationDeps, ...deps };

  if (media.kind === 'image') {
    const prepared = createPreparedMedia('image', '请分析这张图片');
    const imagePath = await downloadImageToTemp(media.item);
    if (!imagePath) {
      prepared.immediateReply = '⚠️ 图片已收到，但下载或解密失败。请重发一次图片；如果还失败，我会继续按日志排查。';
      return prepared;
    }
    prepared.imagePaths.push(imagePath);
    prepared.tempFiles.push(imagePath);
    return prepared;
  }

  if (media.kind === 'voice') {
    const prepared = createPreparedMedia('voice', '请根据下面的微信语音转写内容回答用户。');
    const transcript = extractVoiceTranscript(media.item);
    if (!transcript) {
      prepared.immediateReply = '⚠️ 语音已收到，但当前未拿到可用转写文本。请改发文字，或转成音频文件后重发。';
      return prepared;
    }
    prepared.promptFragments.push(`微信语音转写：\n${transcript}`);
    return prepared;
  }

  if (media.kind === 'audio') {
    return prepareAudioForCodex(media.item, resolvedDeps);
  }

  return prepareVideoForCodex(media.item, resolvedDeps);
}

export function buildCodexPrompt(userText: string, prepared?: PreparedMediaForCodex): string {
  const trimmedUserText = userText.trim();
  const parts: string[] = [];

  if (trimmedUserText) {
    parts.push(trimmedUserText);
  } else if (prepared) {
    parts.push(prepared.defaultPrompt);
  }

  if (prepared?.promptFragments.length) {
    parts.push(...prepared.promptFragments);
  }

  return parts.join('\n\n').trim();
}

/**
 * Find the first IMAGE type item in a list.
 */
export function extractFirstImageUrl(items?: MessageItem[]): MessageItem | undefined {
  return items?.find((item) => item.type === MessageItemType.IMAGE);
}
