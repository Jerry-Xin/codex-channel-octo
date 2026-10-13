export function normalizeOwnerUid(uid: unknown): string | null {
  if (typeof uid !== 'string' || uid.length === 0 || uid.length > 256
    || /[\x00-\x20\x7f-\x9f\u2028\u2029]/.test(uid)) return null;
  return /^s\d+_(.+)$/.exec(uid)?.[1] ?? uid;
}

export function isRegistrationOwner(senderUid: unknown, ownerUid: unknown): boolean {
  const sender = normalizeOwnerUid(senderUid);
  const owner = normalizeOwnerUid(ownerUid);
  return sender !== null && owner !== null && sender === owner;
}
