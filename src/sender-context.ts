import { ChannelType, type BotMessage } from './octo/types.js';
import { safeSenderMetadata, type SafeText } from './prompt-safety.js';
import { isRegistrationOwner, normalizeOwnerUid, transportSpaceId } from './owner-identity.js';

export function buildSenderContext(message: BotMessage, ownerUid: string): SafeText {
  const senderUid = normalizeOwnerUid(message.from_uid);
  const metadata = {
    from_uid: senderUid,
    channel_id: typeof message.channel_id === 'string' && message.channel_id.length > 0
      && message.channel_id.length <= 512 ? message.channel_id : null,
    channel_type: message.channel_type !== undefined && [ChannelType.DM, ChannelType.Group, ChannelType.CommunityTopic].includes(message.channel_type)
      ? message.channel_type : null,
    is_owner: isRegistrationOwner(senderUid, ownerUid,
      transportSpaceId(message.channel_id) || transportSpaceId(senderUid)),
  };
  return safeSenderMetadata(metadata);
}
