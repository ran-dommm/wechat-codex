import { WeChatApi } from './api.js';
import { MessageItemType, MessageType, MessageState, type MessageItem, type OutboundMessage } from './types.js';
import { logger } from '../logger.js';
import { uploadImage, uploadFile, uploadVoice, uploadVideo, encodeMessageAesKey } from './upload.js';

export function createSender(api: WeChatApi, botAccountId: string, baseUrl: string, token: string) {
  let clientCounter = 0;

  function generateClientId(): string {
    return `wcc-${Date.now()}-${++clientCounter}`;
  }

  async function sendText(toUserId: string, contextToken: string, text: string): Promise<void> {
    const clientId = generateClientId();

    const items: MessageItem[] = [
      {
        type: MessageItemType.TEXT,
        text_item: { text },
      },
    ];

    const msg: OutboundMessage = {
      from_user_id: botAccountId,
      to_user_id: toUserId,
      client_id: clientId,
      message_type: MessageType.BOT,
      message_state: MessageState.FINISH,
      context_token: contextToken,
      item_list: items,
    };

    logger.info('Sending text message', { toUserId, clientId, textLength: text.length });
    await api.sendMessage({ msg });
    logger.info('Text message sent', { toUserId, clientId });
  }

  async function sendImage(toUserId: string, contextToken: string, imagePath: string, caption?: string): Promise<void> {
    if (caption?.trim()) {
      await sendText(toUserId, contextToken, caption.trim());
    }

    const upload = await uploadImage(baseUrl, token, toUserId, imagePath);
    const clientId = generateClientId();

    const items: MessageItem[] = [
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
    ];

    const msg: OutboundMessage = {
      from_user_id: botAccountId,
      to_user_id: toUserId,
      client_id: clientId,
      message_type: MessageType.BOT,
      message_state: MessageState.FINISH,
      context_token: contextToken,
      item_list: items,
    };

    logger.info('Sending image message', { toUserId, clientId, imagePath });
    await api.sendMessage({ msg });
    logger.info('Image message sent', { toUserId, clientId });
  }

  async function sendFile(toUserId: string, contextToken: string, filePath: string, caption?: string): Promise<void> {
    if (caption?.trim()) {
      await sendText(toUserId, contextToken, caption.trim());
    }

    const upload = await uploadFile(baseUrl, token, toUserId, filePath);
    const clientId = generateClientId();

    const items: MessageItem[] = [
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
    ];

    const msg: OutboundMessage = {
      from_user_id: botAccountId,
      to_user_id: toUserId,
      client_id: clientId,
      message_type: MessageType.BOT,
      message_state: MessageState.FINISH,
      context_token: contextToken,
      item_list: items,
    };

    logger.info('Sending file message', { toUserId, clientId, filePath });
    await api.sendMessage({ msg });
    logger.info('File message sent', { toUserId, clientId });
  }

  async function sendVoice(toUserId: string, contextToken: string, filePath: string): Promise<void> {
    const upload = await uploadVoice(baseUrl, token, toUserId, filePath);
    const clientId = generateClientId();
    const items: MessageItem[] = [
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
    ];
    const msg: OutboundMessage = {
      from_user_id: botAccountId,
      to_user_id: toUserId,
      client_id: clientId,
      message_type: MessageType.BOT,
      message_state: MessageState.FINISH,
      context_token: contextToken,
      item_list: items,
    };
    logger.info('Sending voice message', { toUserId, clientId, filePath });
    await api.sendMessage({ msg });
    logger.info('Voice message sent', { toUserId, clientId });
  }

  async function sendVideo(toUserId: string, contextToken: string, filePath: string, caption?: string): Promise<void> {
    if (caption?.trim()) {
      await sendText(toUserId, contextToken, caption.trim());
    }
    const upload = await uploadVideo(baseUrl, token, toUserId, filePath);
    const clientId = generateClientId();
    const items: MessageItem[] = [
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
    ];
    const msg: OutboundMessage = {
      from_user_id: botAccountId,
      to_user_id: toUserId,
      client_id: clientId,
      message_type: MessageType.BOT,
      message_state: MessageState.FINISH,
      context_token: contextToken,
      item_list: items,
    };
    logger.info('Sending video message', { toUserId, clientId, filePath });
    await api.sendMessage({ msg });
    logger.info('Video message sent', { toUserId, clientId });
  }

  return { sendText, sendImage, sendFile, sendVoice, sendVideo };
}
