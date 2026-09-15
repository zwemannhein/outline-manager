/**
 * Outline 1.12.x can serialize numeric-looking access-key IDs as numbers even
 * though the management API type and our persisted Redis records use strings.
 * Normalize at every inventory boundary before comparing or indexing IDs.
 */
export function normalizeOutlineKeyId(id: string | number): string {
  return String(id);
}

export function outlineKeyIdSet(
  keys: ReadonlyArray<{ id: string | number }>
): Set<string> {
  return new Set(keys.map((key) => normalizeOutlineKeyId(key.id)));
}
