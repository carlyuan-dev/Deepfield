import type { CompanyResearchStructureWorkerRequest } from "../contracts/index.js";
import { evidenceBytes, evidenceHash, type FrozenSnapshot, type FrozenEvidencePacket } from "../persistence/research-evidence-data.js";
import { checkStructureBudget, type BudgetResult } from "./company-research-context-budget.js";
import { extractMarkdownSources } from "../application/company-research-harness.js";
export type PacketBuildContext = Omit<CompanyResearchStructureWorkerRequest, "evidencePacket" | "rawReportText">;
export type PacketBuildResult = { status: "ready"; packet: FrozenEvidencePacket } | { status: "budget_exceeded"; details: BudgetResult };
export function buildEvidencePacket(snapshot: FrozenSnapshot, rawReport: string, context: PacketBuildContext): PacketBuildResult {
  const request = { ...context, rawReportText: rawReport };
  const base = checkStructureBudget(request);
  if (!base.allowed) return { status: "budget_exceeded", details: base };
  const urls = [...extractMarkdownSources(rawReport)].map(pair => pair.slice(pair.indexOf("\u0000") + 1));
  // Fetch identities come from the tool, never the report's prose. Aliases only
  // associate saved material; the Harness still validates raw title/URL pairs.
  const citationIndex = (source: import("../persistence/research-evidence-data.js").EvidenceSource) => Math.min(...[source.url, source.requestedUrl, source.finalUrl].map(url => {
    const index = url === undefined ? -1 : urls.indexOf(url); return index < 0 ? Infinity : index;
  }));
  const latest = new Map(snapshot.events.map(event => [event.modelRequestId, event]));
  const all = [...latest.values()].filter(event => event.responseState !== "not_sent").flatMap(event => event.projections.map(p => ({ p, event })));
  const ordinaryTools = new Set(all.filter(({ event }) => event.phase === "ordinary").map(({ p }) => p.toolCallId));
  const candidates = all.filter(({ p, event }) => event.phase === "ordinary" || !ordinaryTools.has(p.toolCallId))
    .filter(({ p }) => p.savedText && p.sources.some(source => Number.isFinite(citationIndex(source))))
    .sort((a, b) => Math.min(...a.p.sources.map(citationIndex)) -
      Math.min(...b.p.sources.map(citationIndex)) ||
      (a.event.phase === b.event.phase ? a.event.sequence - b.event.sequence : a.event.phase === "ordinary" ? -1 : 1));
  const packet: FrozenEvidencePacket = { body: "", hash: evidenceHash(""), packetVersion: 1, algorithmVersion: "source-group-v1",
    snapshotHash: snapshot.manifest.snapshotHash, parameters: { maxCharacters: 24000, maxExcerptCharacters: 2000 }, selected: [], omitted: [] };
  for (const { p, event } of all) {
    if (event.phase === "synthesis" && ordinaryTools.has(p.toolCallId)) packet.omitted.push({ evidenceId: p.evidenceId, reason: "ordinary_projection_preferred" });
    else if (!p.sources.some(s => Number.isFinite(citationIndex(s)))) packet.omitted.push({ evidenceId: p.evidenceId, reason: "not_cited_in_raw" });
    else if (!p.savedText) packet.omitted.push({ evidenceId: p.evidenceId, reason: "archive_omitted" });
  }
  const seen = new Set<string>(); const chunks: string[] = [];
  for (const { p, event } of candidates) {
    if (seen.has(p.savedHash)) { packet.omitted.push({ evidenceId: p.evidenceId, reason: "duplicate_saved_text" }); continue; }
    seen.add(p.savedHash);
    const characters = [...p.savedText].slice(0, 2000);
    const render = (end: number) => JSON.stringify({ association: "tool_result_source_group_not_fact_support", sources: p.sources, text: characters.slice(0, end).join("") });
    const fits = (end: number) => {
      const body = [...chunks, render(end)].join("\n");
      return [...body].length <= 24000 && checkStructureBudget({ ...request, evidencePacket: { ...packet, body, hash: evidenceHash(body) } }).allowed;
    };
    let end = characters.length;
    if (!fits(end)) {
      let low = 0, high = end; while (low < high) { const mid = Math.ceil((low + high) / 2); if (fits(mid)) low = mid; else high = mid - 1; } end = low;
    }
    if (!end) { packet.omitted.push({ evidenceId: p.evidenceId, reason: "context_budget_exceeded" }); break; }
    const includedText = characters.slice(0, end).join(""); chunks.push(render(end));
    packet.selected.push({ evidenceId: p.evidenceId, modelRequestId: event.modelRequestId, start: 0, end, visibleBytes: p.visibleBytes, savedBytes: p.savedBytes, includedBytes: evidenceBytes(includedText), includedHash: evidenceHash(includedText) });
    if (end < characters.length) { packet.omitted.push({ evidenceId: p.evidenceId, reason: "packet_excerpt_truncated" }); break; }
  }
  if (candidates.length && !chunks.length) return { status: "budget_exceeded", details: checkStructureBudget(request) };
  for (const { p } of candidates) if (!packet.selected.some(s => s.evidenceId === p.evidenceId) && !packet.omitted.some(s => s.evidenceId === p.evidenceId)) packet.omitted.push({ evidenceId: p.evidenceId, reason: "packet_capacity" });
  packet.body = chunks.join("\n"); packet.hash = evidenceHash(packet.body);
  if (!candidates.length) packet.emptyReason = "no_matching_saved_material";
  return { status: "ready", packet };
}
