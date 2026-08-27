/**
 * Bounded PDF text joining: stable reading order (larger y first, then smaller
 * x) with a hard character budget applied DURING construction — items are
 * appended one at a time with the separator counted, and string building stops
 * the moment the budget is exhausted. An oversized page never materializes as
 * a full string first.
 */
export interface TextItem {
  str: string;
  transform: number[];
}

export const MAX_PDF_CHARS = 400_000;
export const MAX_PDF_PAGES = 200;
export const MAX_PDF_METADATA_LENGTH = 500;

export function joinPageTextBounded(
  items: readonly TextItem[],
  maxChars: number,
): { text: string; truncated: boolean } {
  const sorted = [...items].sort((a, b) => {
    const yOrder = b.transform[5]! - a.transform[5]!;
    if (yOrder !== 0) {
      return yOrder;
    }
    return a.transform[4]! - b.transform[4]!;
  });
  const parts: string[] = [];
  let used = 0;
  for (const item of sorted) {
    const str = item.str; // read each item's string exactly once
    const separator = parts.length > 0 ? 1 : 0;
    const cost = separator + str.length;
    if (used + cost > maxChars) {
      const remaining = maxChars - used - separator;
      if (remaining > 0) {
        parts.push(str.slice(0, remaining));
        used = maxChars;
      }
      return { text: parts.join(" "), truncated: true };
    }
    parts.push(str);
    used += cost;
  }
  return { text: parts.join(" "), truncated: false };
}

/** Unbounded convenience join (used by tests/exporters; the tool itself is bounded). */
export function joinPageText(items: readonly TextItem[]): string {
  return joinPageTextBounded(items, Number.MAX_SAFE_INTEGER).text;
}
