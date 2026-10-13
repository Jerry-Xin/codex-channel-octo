/** Validate an opaque UID without case folding, prefix stripping or Unicode equivalence. */
export function normalizeOwnerUid(uid: unknown): string | null {
  if (typeof uid !== 'string' || uid.length === 0 || uid.length > 256
    || /[\x00-\x20\x7f-\x9f\u2028\u2029]/.test(uid)) return null;
  return uid;
}

/** Parse the adapter's s{spaceId}_{opaqueId} transport shape without guessing its alphabet. */
export function transportSpaceId(value: unknown): string {
  if (typeof value !== 'string') return '';
  const first = value.split('@')[0];
  const separator = first.lastIndexOf('_');
  return first.startsWith('s') && separator > 1 ? first.slice(1, separator) : '';
}

/** Accept the registration UID itself or its single prefix in this transport's space only. */
export function isRegistrationOwner(senderUid: unknown, ownerUid: unknown, spaceId = ''): boolean {
  const sender = normalizeOwnerUid(senderUid);
  const owner = normalizeOwnerUid(ownerUid);
  return sender !== null && owner !== null
    && (sender === owner || (spaceId.length > 0 && sender === `s${spaceId}_${owner}`));
}
