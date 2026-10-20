/** Ids per `IN (...)` list of a batch read: keeps each statement small however many cases a report holds. */
export const BATCH_CHUNK = 500;

/** Distinct ids split in lists of at most `size`, in first-seen order. */
export function chunksOf(
  ids: readonly string[],
  size: number = BATCH_CHUNK,
): readonly (readonly string[])[] {
  const distinct = [...new Set(ids)];
  const chunks: (readonly string[])[] = [];
  for (let at = 0; at < distinct.length; at += size) chunks.push(distinct.slice(at, at + size));
  return chunks;
}
