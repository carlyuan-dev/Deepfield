/** Persistence-local shape checks: parsed JSON is untrusted, even when syntactically valid. */
type RecordValue = Record<string, unknown>;
const record = (value: unknown): value is RecordValue => value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === "string";
const fetchUrl = (value: unknown): boolean => text(value) && value.length > 0 && value.length <= 2048 && /^https?:\/\//.test(value);
const count = (value: unknown): boolean => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const hash = (value: unknown): boolean => text(value) && /^[a-f0-9]{64}$/.test(value);
const optional = (value: unknown, check: (item: unknown) => boolean): boolean => value === undefined || check(value);
const list = (value: unknown, check: (item: unknown) => boolean): boolean => Array.isArray(value) && value.every(check);
const member = (value: unknown, choices: string[]): boolean => text(value) && choices.includes(value);
function sourceDate(value: unknown): boolean {
  return record(value) && text(value.provider) && value.provider.length <= 64 && optional(value.fieldName, field => text(field) && field.length <= 64) &&
    optional(value.rawValue, raw => text(raw) && Buffer.byteLength(raw, "utf8") <= 2048) && optional(value.normalizedValue, date => text(date) && /^\d{4}-\d{2}-\d{2}$/.test(date)) &&
    member(value.precision, ["day", "datetime", "unknown"]) && member(value.nature, ["published", "unknown"]) && member(value.evidenceSource, ["provider_metadata", "unknown"]) &&
    member(value.status, ["valid", "missing", "unparseable", "invalid_type", "unknown"]) && optional(value.rawType, type => member(type, ["null", "number", "boolean", "object", "array"])) &&
    optional(value.rawValueTruncated, flag => typeof flag === "boolean") && optional(value.rawValueBytes, count) && optional(value.rawValueHash, hash);
}
function clipping(value: unknown): boolean {
  return record(value) && text(value.version) && count(value.beforeBytes) && hash(value.beforeHash) && count(value.afterBytes) && hash(value.afterHash) && (value.omittedItems === null || count(value.omittedItems));
}
function projection(value: unknown): boolean {
  return record(value) && text(value.evidenceId) && text(value.toolCallId) && typeof value.messageIndex === "number" && Number.isSafeInteger(value.messageIndex) && value.messageIndex >= -1 && optional(value.contentBlockIndex, count) &&
    member(value.mapping, ["mapped", "unmapped"]) && text(value.toolName) && text(value.capturedAt) &&
    list(value.sources, source => record(source) && text(source.url) && text(source.title) && optional(source.requestedUrl, fetchUrl) && optional(source.finalUrl, fetchUrl) && optional(source.sourceDate, sourceDate) && optional(source.kind, kind => member(kind, ["search_snippet", "page_excerpt"]))) &&
    optional(value.savedText, text) && count(value.visibleBytes) && hash(value.visibleHash) && count(value.savedBytes) && hash(value.savedHash) &&
    optional(value.modelClipping, clipping) && optional(value.formatting, clipping) && record(value.archiveClipping) && member(value.archiveClipping.reason, ["none", "item_limit", "total_limit", "entry_limit"]) && count(value.archiveClipping.omittedBytes);
}
export function storedReceiptShape(value: unknown): boolean {
  return record(value) && count(value.sequence) && value.sequence !== 0 && text(value.modelRequestId) && text(value.requestId) &&
    member(value.phase, ["ordinary", "synthesis"]) && member(value.state, ["prepared", "dispatched", "failed"]) && member(value.responseState, ["not_sent", "pending", "succeeded", "failed"]) && optional(value.responseStatus, count) && list(value.projections, projection);
}
function manifest(value: unknown): boolean {
  return record(value) && value.version === 1 && hash(value.snapshotHash) && ["lastSequence", "receipts", "dispatched", "prepared", "visibleEntries", "savedEntries", "visibleBytes", "savedBytes", "omittedEntries", "omittedBytes"].every(key => count(value[key]));
}
export function storedSnapshotShape(value: unknown): boolean {
  return record(value) && value.version === 1 && value.frozen === true && text(value.runId) && text(value.attemptId) && manifest(value.manifest) && list(value.events, storedReceiptShape);
}
export function storedPacketShape(value: unknown): boolean {
  return record(value) && text(value.body) && hash(value.hash) && value.packetVersion === 1 && text(value.algorithmVersion) && hash(value.snapshotHash) &&
    record(value.parameters) && count(value.parameters.maxCharacters) && count(value.parameters.maxExcerptCharacters) &&
    list(value.selected, selection => record(selection) && text(selection.evidenceId) && text(selection.modelRequestId) && ["start", "end", "visibleBytes", "savedBytes", "includedBytes"].every(key => count(selection[key])) && hash(selection.includedHash)) &&
    list(value.omitted, omission => record(omission) && text(omission.evidenceId) && text(omission.reason)) && optional(value.emptyReason, reason => reason === "no_matching_saved_material");
}
