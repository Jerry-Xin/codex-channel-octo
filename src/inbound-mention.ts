/** Bounded facts from the original transport payload, never from visible text. */
export interface InboundMentionMetadata {
  bot_uid: string | null;
  mentioned_uids: string[];
  mention_source: 'entities' | 'uids' | 'none' | 'invalid';
  is_explicitly_mentioned: boolean;
  mentioned_ais: boolean;
  mentioned_humans: boolean;
  mentioned_all: boolean;
}

const MAX_MENTION_ENTRIES = 128;
const MAX_UID_CHARS = 256;
const MAX_MESSAGE_ID_CHARS = 512;
const CONTROL_OR_LINE_SEPARATOR = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

function boundedIdentifier(value: unknown, limit: number): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= limit
    && !CONTROL_OR_LINE_SEPARATOR.test(value) ? value : null;
}

export function normalizeMessageId(value: unknown): string | null {
  return boundedIdentifier(value, MAX_MESSAGE_ID_CHARS);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Entity UIDs take precedence; legacy UIDs are only a fallback, never a union. */
export function normalizeInboundMention(mention: unknown, botUid: unknown): InboundMentionMetadata {
  const empty: InboundMentionMetadata = {
    bot_uid: boundedIdentifier(botUid, MAX_UID_CHARS),
    mentioned_uids: [],
    mention_source: 'none',
    is_explicitly_mentioned: false,
    mentioned_ais: false,
    mentioned_humans: false,
    mentioned_all: false,
  };
  if (mention === undefined) return empty;
  if (!isRecord(mention)) return { ...empty, mention_source: 'invalid' };
  for (const entries of [mention.entities, mention.uids]) {
    if (entries !== undefined && (!Array.isArray(entries) || entries.length > MAX_MENTION_ENTRIES)) {
      return { ...empty, mention_source: 'invalid' };
    }
  }
  const entities: unknown[] = Array.isArray(mention.entities) ? mention.entities : [];
  const uids: unknown[] = Array.isArray(mention.uids) ? mention.uids : [];
  const entityUids = entities.map((entry) => isRecord(entry) ? boundedIdentifier(entry.uid, MAX_UID_CHARS) : null)
    .filter((uid): uid is string => uid !== null);
  const legacyUids = uids.map((uid) => boundedIdentifier(uid, MAX_UID_CHARS))
    .filter((uid): uid is string => uid !== null);
  const mentionedUids = [...new Set(entityUids.length > 0 ? entityUids : legacyUids)];
  return {
    ...empty,
    mentioned_uids: mentionedUids,
    mention_source: entityUids.length > 0 ? 'entities' : legacyUids.length > 0 ? 'uids' : 'none',
    is_explicitly_mentioned: empty.bot_uid !== null && mentionedUids.includes(empty.bot_uid),
    mentioned_ais: mention.ais === true || mention.ais === 1,
    mentioned_humans: mention.humans === true || mention.humans === 1,
    mentioned_all: mention.all === true || mention.all === 1,
  };
}
