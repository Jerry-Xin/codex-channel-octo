import { ChannelType, type BotMessage } from './octo/types.js';
import { safeSenderMetadata, type SafeText } from './prompt-safety.js';
import { isRegistrationOwner, normalizeOwnerUid, transportSpaceId } from './owner-identity.js';
import { parentGroupNo } from './channel-id.js';

export function buildSenderContext(message: BotMessage, ownerUid: string): SafeText {
  const senderUid = normalizeOwnerUid(message.from_uid);
  const channelId = typeof message.channel_id === 'string' && message.channel_id.length > 0
    && message.channel_id.length <= 512 ? message.channel_id : null;
  const senderSpace = transportSpaceId(senderUid, ownerUid);
  const matchesChannel = channelId !== null && parentGroupNo(channelId).split('@').every((endpoint) => endpoint.startsWith(`s${senderSpace}_`));
  const metadata = {
    from_uid: senderUid,
    channel_id: channelId,
    channel_type: message.channel_type !== undefined && [ChannelType.DM, ChannelType.Group, ChannelType.CommunityTopic].includes(message.channel_type)
      ? message.channel_type : null,
    is_owner: isRegistrationOwner(senderUid, ownerUid)
      || (matchesChannel && isRegistrationOwner(senderUid, ownerUid, senderSpace)),
  };
  return safeSenderMetadata(metadata);
}
