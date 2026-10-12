import type { PiToolSource } from "../agent/pi-execution-contract.js";

export function toolResultProjection(result: unknown, includeSourceRanks = false): { sources?: PiToolSource[]; sourceRanks?: Array<number | undefined>; resultCount?: number } {
  const content = (result as { content?: { type?: string; text?: string }[] } | null)?.content;
  if (!Array.isArray(content)) return {};
  try {
    const payload = JSON.parse(content.filter(part => part.type === "text").map(part => part.text ?? "").join("")) as Record<string, unknown>;
    const results = Array.isArray(payload.results) ? payload.results : [payload];
    const sources: PiToolSource[] = [];
    const sourceRanks: Array<number | undefined> = [];
    for (const result of results) {
      if (!result || typeof result !== "object") continue;
      const { url, title, rank } = result as { url?: unknown; title?: unknown; rank?: unknown };
      if (typeof url !== "string" || url.length > 8192) continue;
      try {
        const parsed = new URL(url);
        if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) continue;
        sources.push({ url, title: typeof title === "string" ? title.slice(0, 300) : parsed.hostname });
        sourceRanks.push(typeof rank === "number" && Number.isInteger(rank) && rank > 0 ? rank : undefined);
      } catch { /* Invalid links cannot become sources. */ }
    }
    return { sources: sources.slice(0, 20), ...(includeSourceRanks ? { sourceRanks: sourceRanks.slice(0, 20) } : {}), ...(Array.isArray(payload.results) ? { resultCount: payload.results.length } : {}) };
  } catch { return {}; }
}
