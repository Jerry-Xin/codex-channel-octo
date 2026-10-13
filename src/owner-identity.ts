/** Validate an opaque UID without case folding, prefix stripping or Unicode equivalence. */
export function normalizeOwnerUid(uid: unknown): string | null {
  if (typeof uid !== 'string' || uid.length === 0 || uid.length > 256
    || /[\x00-\x20\x7f-\x9f\u2028\u2029]/.test(uid)) return null;
  return uid;
}

/** Parse parent channels; a known opaque UID fixes the sender prefix boundary without splitting its underscores. */
export function transportSpaceId(value: unknown, knownUid?: unknown): string {
  if (typeof value !== 'string') return '';
  if (knownUid !== undefined) {
    const uid = normalizeOwnerUid(knownUid);
    if (!uid || !value.startsWith('s') || !value.endsWith(`_${uid}`)) return '';
    return value.slice(1, -uid.length - 1);
  }
  const first = value.split('@')[0].split('____')[0];
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
