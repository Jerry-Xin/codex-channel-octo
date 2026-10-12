import type { BotMessage } from './octo/types.js';
import { safeSenderMetadata, type SafeText } from './prompt-safety.js';

export function buildSenderContext(message: BotMessage, ownerUid: string): SafeText {
  const senderUid = typeof message.from_uid === 'string' && message.from_uid.length > 0
    && message.from_uid.length <= 256 && !/[\x00-\x20\x7f-\x9f\u2028\u2029]/.test(message.from_uid)
    ? message.from_uid : null;
  const metadata = {
    from_uid: senderUid,
    channel_id: message.channel_id && message.channel_id.length <= 512 ? message.channel_id : null,
    channel_type: message.channel_type ?? 1,
    is_owner: senderUid !== null && ownerUid.length > 0 && senderUid === ownerUid,
  };
  return safeSenderMetadata(metadata);
}
