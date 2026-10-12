import { ChannelType, type BotMessage } from './octo/types.js';
import { safeSenderMetadata, type SafeText } from './prompt-safety.js';

export function buildSenderContext(message: BotMessage, ownerUid: string): SafeText {
  const senderUid = typeof message.from_uid === 'string' && message.from_uid.length > 0
    && message.from_uid.length <= 256 && !/[\x00-\x20\x7f-\x9f\u2028\u2029]/.test(message.from_uid)
    ? message.from_uid : null;
  const metadata = {
    from_uid: senderUid,
    channel_id: typeof message.channel_id === 'string' && message.channel_id.length > 0
      && message.channel_id.length <= 512 ? message.channel_id : null,
    channel_type: [ChannelType.DM, ChannelType.Group, ChannelType.CommunityTopic].includes(message.channel_type!)
      ? message.channel_type : null,
    is_owner: senderUid !== null && typeof ownerUid === 'string' && ownerUid.length > 0 && senderUid === ownerUid,
  };
  return safeSenderMetadata(metadata);
}
