import { WeChatApi } from './api.js';
import { MessageItemType, MessageType, MessageState, type MessageItem, type OutboundMessage } from './types.js';
import { logger } from '../logger.js';
import { uploadImage, encodeMessageAesKey } from './upload.js';

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

    logger.info('Sending image message', { toUserId, clientId, imagePath });
    await api.sendMessage({ msg });
    logger.info('Image message sent', { toUserId, clientId });
  }

  return { sendText, sendImage };
}
