import { WeChatApi } from './api.js';
import { MessageItemType, MessageType, MessageState, type MessageItem, type OutboundMessage } from './types.js';
import { logger } from '../logger.js';
import { uploadImage, uploadFile, uploadVoice, uploadVideo, encodeMessageAesKey } from './upload.js';

export function createSender(api: WeChatApi, botAccountId: string, baseUrl: string, token: string) {
  let clientCounter = 0;

  function generateClientId(): string {
    return `wcc-${Date.now()}-${++clientCounter}`;
  }

  function buildMessage(
    toUserId: string,
    contextToken: string,
    item: MessageItem,
  ): { clientId: string; msg: OutboundMessage } {
    const clientId = generateClientId();
    return {
      clientId,
      msg: {
        from_user_id: botAccountId,
        to_user_id: toUserId,
        client_id: clientId,
        message_type: MessageType.BOT,
        message_state: MessageState.FINISH,
        context_token: contextToken,
        item_list: [item],
      },
    };
  }

  async function sendBuiltMessage(
    label: string,
    toUserId: string,
    contextToken: string,
    item: MessageItem,
    logData: Record<string, unknown> = {},
  ): Promise<void> {
    const { clientId, msg } = buildMessage(toUserId, contextToken, item);
    logger.info(`Sending ${label} message`, { toUserId, clientId, ...logData });
    await api.sendMessage({ msg });
    logger.info(`${label[0].toUpperCase()}${label.slice(1)} message sent`, { toUserId, clientId });
  }

  async function sendText(toUserId: string, contextToken: string, text: string): Promise<void> {
    await sendBuiltMessage(
      'text',
      toUserId,
      contextToken,
      {
        type: MessageItemType.TEXT,
        text_item: { text },
      },
      { textLength: text.length },
    );
  }

  async function sendImage(toUserId: string, contextToken: string, imagePath: string, caption?: string): Promise<void> {
    if (caption?.trim()) {
      await sendText(toUserId, contextToken, caption.trim());
    }

    const upload = await uploadImage(baseUrl, token, toUserId, imagePath);
    await sendBuiltMessage(
      'image',
      toUserId,
      contextToken,
      {
        type: MessageItemType.IMAGE,
        image_item: {
          media: {
            encrypt_query_param: upload.downloadParam,
            aes_key: encodeMessageAesKey(upload.aeskey),
            encrypt_type: 1,
          },
          mid_size: upload.filesize,
        },
      },
      { imagePath },
    );
  }

  async function sendFile(toUserId: string, contextToken: string, filePath: string, caption?: string): Promise<void> {
    if (caption?.trim()) {
      await sendText(toUserId, contextToken, caption.trim());
    }

    const upload = await uploadFile(baseUrl, token, toUserId, filePath);
    await sendBuiltMessage(
      'file',
      toUserId,
      contextToken,
      {
        type: MessageItemType.FILE,
        file_item: {
          file_name: upload.fileName,
          len: String(upload.rawSize),
          media: {
            encrypt_query_param: upload.downloadParam,
            aes_key: encodeMessageAesKey(upload.aeskey),
            encrypt_type: 1,
          },
        },
      },
      { filePath },
    );
  }

  async function sendVoice(toUserId: string, contextToken: string, filePath: string): Promise<void> {
    const upload = await uploadVoice(baseUrl, token, toUserId, filePath);
    await sendBuiltMessage(
      'voice',
      toUserId,
      contextToken,
      {
        type: MessageItemType.VOICE,
        voice_item: {
          media: {
            encrypt_query_param: upload.downloadParam,
            aes_key: encodeMessageAesKey(upload.aeskey),
            encrypt_type: 1,
          },
        },
      },
      { filePath },
    );
  }

  async function sendVideo(toUserId: string, contextToken: string, filePath: string, caption?: string): Promise<void> {
    if (caption?.trim()) {
      await sendText(toUserId, contextToken, caption.trim());
    }
    const upload = await uploadVideo(baseUrl, token, toUserId, filePath);
    await sendBuiltMessage(
      'video',
      toUserId,
      contextToken,
      {
        type: MessageItemType.VIDEO,
        video_item: {
          media: {
            encrypt_query_param: upload.downloadParam,
            aes_key: encodeMessageAesKey(upload.aeskey),
            encrypt_type: 1,
          },
          video_size: upload.filesize,
        },
      },
      { filePath },
    );
  }

  return { sendText, sendImage, sendFile, sendVoice, sendVideo };
}
