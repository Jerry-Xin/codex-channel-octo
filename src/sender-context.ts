import { ChannelType, type BotMessage } from './octo/types.js';
import { safeSenderMetadata, type SafeText } from './prompt-safety.js';
import { isRegistrationOwner, normalizeOwnerUid, transportSpaceId } from './owner-identity.js';
import { parentGroupNo } from './channel-id.js';

function senderMetadata(message: BotMessage, ownerUid: string) {
  const senderUid = normalizeOwnerUid(message.from_uid);
  const channelId = typeof message.channel_id === 'string' && message.channel_id.length > 0
    && message.channel_id.length <= 512 ? message.channel_id : null;
  const senderSpace = transportSpaceId(senderUid, ownerUid);
  // Split before topic extraction so even malformed topic-typed compound
  // channels cannot hide another endpoint. DM endpoint UIDs stay opaque.
  const endpoints = channelId?.split('@').map((endpoint) =>
    message.channel_type === ChannelType.CommunityTopic ? parentGroupNo(endpoint) : endpoint);
  const prefix = `s${senderSpace}_`;
  const matchesChannel = endpoints !== undefined
    && endpoints.every((endpoint) => endpoint.startsWith(prefix) && endpoint.length > prefix.length);
  const metadata = {
    from_uid: senderUid,
    channel_id: channelId,
    channel_type: message.channel_type !== undefined && [ChannelType.DM, ChannelType.Group, ChannelType.CommunityTopic].includes(message.channel_type)
      ? message.channel_type : null,
    is_owner: isRegistrationOwner(senderUid, ownerUid)
      || (matchesChannel && isRegistrationOwner(senderUid, ownerUid, senderSpace)),
  };
  return metadata;
}

/** Uses only transport fields and the registered owner binding, never body text. */
export function isOwnerSender(message: BotMessage, ownerUid: string): boolean {
  return senderMetadata(message, ownerUid).is_owner;
}
export function buildSenderContext(message: BotMessage, ownerUid: string): SafeText {
  return safeSenderMetadata(senderMetadata(message, ownerUid));
}
