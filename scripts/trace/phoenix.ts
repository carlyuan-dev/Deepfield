import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import type { exportTrace } from "./export.ts";
import { decodePhoenixResponse, encodePhoenix } from "./phoenix-protobuf.ts";
import { readPhoenixContent, validateContentSelection, projectPhoenixContent, type PhoenixContentSelection } from "./phoenix-content.ts";

type Snapshot = ReturnType<typeof exportTrace>;
type Attribute = { key: string; value: { stringValue: string } | { intValue: string } };
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
export const traceId = (root: string) => hash(JSON.stringify(["deepfield.trace.v1", root])).slice(0, 32);
export const spanId = (root: string, span: string) => hash(JSON.stringify(["deepfield.span.v1", root, span])).slice(0, 16);
const attr = (key: string, value: string | number): Attribute => ({ key, value: typeof value === "number" ? { intValue: String(value) } : { stringValue: value } });

/** Only a literal loopback HTTP origin; no credentials, paths, redirects or proxy configuration. */
export function localEndpoint(value = "http://127.0.0.1:6006") {
  const url = new URL(value);
  if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/?$/.test(value) || url.username || url.password) throw new Error("phoenix_local_origin_required");
  // Pin localhost to IPv4 loopback rather than consulting DNS.
  url.hostname = "127.0.0.1";
  return `${url.origin}/v1/traces`;
}

/** Input must be the metadata export, never raw provider payloads. Projection remains explicit. */
export function toPhoenix(snapshot: Snapshot, project = "deepfield-local", content?: PhoenixContentSelection) {
  if (!/^[A-Za-z0-9_.-]{1,100}$/.test(project)) throw new Error("invalid_phoenix_project");
  if (content) validateContentSelection(content, snapshot.rootTraceId, project);
  const contentManifest = content ? { selected: content.records.length, matched: 0, unmatched: 0, projected: 0, unavailable: 0 } : undefined;
  const timelines = [snapshot, ...snapshot.related];
  const all = timelines.flatMap(t => t.spans.map(s => ({ ...s, root: t.rootTraceId, timeline: t })));
  const key = (root: string, span: string) => JSON.stringify([root, span]);
  const omitted: { rootTraceId: string; spanId: string; reason: string }[] = [];
  const complete = all.filter(s => {
    const reason = !s.start ? "missing_start" : !s.end ? "missing_end" : Date.parse(s.end.time) < Date.parse(s.start.time) ? "invalid_interval" : null;
    if (reason) omitted.push({ rootTraceId: s.root, spanId: s.spanId, reason });
    return !reason;
  });
  const imported = new Set(complete.map(s => key(s.root, s.spanId)));
  const assigned = new Map<string, Snapshot["usage"]["attempts"]>();
  const attribution: { attemptId: string; status: string; target: string | null }[] = [];
  const seenAttempts = new Set<string>();
  for (const attempt of snapshot.usage.attempts) {
    if (seenAttempts.has(attempt.attemptId)) throw new Error("duplicate_usage_attempt");
    seenAttempts.add(attempt.attemptId);
    const links = timelines.flatMap(t => t.events.filter(e => e.type === "usage.link" && e.usageAttemptId === attempt.attemptId));
    const candidates = all.filter(s => s.kind === "model" && links.some(e => e.rootTraceId === s.root &&
      (e.spanId === s.spanId || (e.type === "usage.link" && e.modelRequestId && s.start?.type === "span.start" && e.modelRequestId === s.start.modelRequestId))));
    const target = candidates.length === 1 ? key(candidates[0]!.root, candidates[0]!.spanId) : null;
    const status = attempt.status === "missing" ? "missing" : target && imported.has(target) ? "attributed" : "unattributed";
    attribution.push({ attemptId: attempt.attemptId, status, target });
    if (target && imported.has(target)) assigned.set(target, [...(assigned.get(target) ?? []), attempt]);
  }
  const spans = complete.map(s => {
    const attributes: Attribute[] = [attr("openinference.span.kind", s.kind === "model" ? "LLM" : s.kind === "tool" ? "TOOL" : "CHAIN"),
      attr("deepfield.root_trace_id", s.root), attr("deepfield.span_id", s.spanId), attr("deepfield.kind", s.kind),
      attr("deepfield.status", s.status), attr("deepfield.coverage", s.timeline.coverage.status),
      attr("deepfield.associations", snapshot.associations.status), attr("deepfield.usage.coverage", snapshot.usage.status),
      attr("deepfield.omitted_span_count", omitted.length), attr("deepfield.unattributed_usage_count", attribution.filter(a => a.status === "unattributed").length)];
    if (s.end?.type === "span.end" && s.end.errorCode) attributes.push(attr("deepfield.error_code", s.end.errorCode));
    if (content) {
      const start = s.start as unknown as Record<string, unknown>;
      const records = content.records.filter(record => record.rootTraceId === s.root && record.spanId === s.spanId &&
        record.requestId === s.start!.requestId &&
        (record.kind.startsWith("model.") ? s.kind === "model" : s.kind === "tool") &&
        (!record.modelRequestId || !start.modelRequestId || record.modelRequestId === start.modelRequestId) &&
        (!record.executionId || !start.executionId || record.executionId === start.executionId) &&
        (!record.toolCallId || !start.toolCallId || record.toolCallId === start.toolCallId));
      const projected = records.map(projectPhoenixContent);
      contentManifest!.matched += records.length;
      contentManifest!.projected += projected.filter(record => record.projection === "projected").length;
      contentManifest!.unavailable += projected.filter(record => record.projection !== "projected").length;
      attributes.push(attr("deepfield.content.status", records.length ? "selected" : "missing"));
      attributes.push(attr("deepfield.content.records", JSON.stringify(projected.map(({ body: _body, ...metadata }) => metadata))));
      for (const [direction, kinds] of [["input", ["model.request", "tool.input"]], ["output", ["model.response", "tool.output"]]] as const) {
        const values = projected.filter(record => (kinds as readonly string[]).includes(record.kind) && "body" in record);
        if (values.length) {
          attributes.push(attr(`${direction}.value`, JSON.stringify(values)));
          attributes.push(attr(`${direction}.mime_type`, "application/json"));
        }
      }
    }
    if (s.timeline.timing) for (const field of ["executionMs", "humanWaitMs", "queueWaitMs", "partial"] as const) {
      const value = s.timeline.timing[field];
      attributes.push(attr(`deepfield.root_timing.${field}`, typeof value === "boolean" ? String(value) : value));
    }
    for (const field of ["requestId", "modelRequestId", "executionId", "toolCallId", "toolName", "capabilityId", "actionId", "invocationId", "interactionId", "receiptId", "taskId", "runId", "artifactId", "evidenceAttemptId", "stage", "phase", "turn", "revision"] as const) {
      const source = s.start as unknown as Record<string, unknown>;
      const value = source[field];
      if (typeof value === "string" || typeof value === "number") attributes.push(attr(`deepfield.${field}`, value));
    }
    const attempts = assigned.get(key(s.root, s.spanId)) ?? [];
    attributes.push(attr("deepfield.usage.attempt_ids", JSON.stringify(attempts.map(a => a.attemptId))));
    // Multiple physical attempts may link to one model span. Preserve individual nulls;
    // publish aggregate token counters only when every attributed attempt reported them.
    attributes.push(attr("deepfield.usage.attempts", JSON.stringify(attempts.map(a => a.status === "missing" ? { attemptId: a.attemptId, status: a.status } : {
      attemptId: a.attemptId, status: a.status, serviceKind: a.serviceKind, outcome: a.outcome,
      providerId: a.providerId, modelId: a.modelId, errorCode: a.errorCode,
      inputTokens: a.inputTokens, outputTokens: a.outputTokens, totalTokens: a.totalTokens,
      cacheReadTokens: a.cacheReadTokens, cacheWriteTokens: a.cacheWriteTokens,
      resultCount: a.resultCount, usageStatus: a.usageStatus, attemptCountStatus: a.attemptCountStatus,
    }))));
    const available = attempts.filter(a => a.status === "available");
    for (const [field, semantic] of [["modelId", "llm.model_name"], ["providerId", "llm.provider"]] as const) {
      const values = [...new Set(available.flatMap(a => a.status === "available" && a[field] ? [a[field]] : []))];
      if (values.length === 1) attributes.push(attr(semantic, values[0]!));
    }
    for (const [field, semantic] of [["inputTokens", "llm.token_count.prompt"], ["outputTokens", "llm.token_count.completion"], ["totalTokens", "llm.token_count.total"]] as const) {
      if (attempts.length && attempts.every(a => a.status === "available" && a[field] !== null)) {
        attributes.push(attr(semantic, attempts.reduce((n, a) => n + (a.status === "available" ? a[field] ?? 0 : 0), 0)));
      }
    }
    const links = new Map<string, { traceId: string; spanId: string }>();
    for (const event of s.timeline.events.filter(e => e.spanId === s.spanId)) for (const link of event.links ?? []) {
      links.set(key(link.rootTraceId, link.spanId), { traceId: traceId(link.rootTraceId), spanId: spanId(link.rootTraceId, link.spanId) });
    }
    attributes.push(attr("deepfield.links", JSON.stringify([...links].map(([original, mapped]) => ({ original: JSON.parse(original), ...mapped })))));
    const events = s.timeline.events.filter(e => e.spanId === s.spanId && (e.type === "span.state" || e.type === "coverage.gap")).map(e => ({
      name: e.type, timeUnixNano: String(BigInt(Date.parse(e.time)) * 1000000n),
      attributes: e.type === "span.state" ? [attr("deepfield.state", e.status)] : e.type === "coverage.gap" ? [attr("deepfield.reason", e.reason)] : [],
    }));
    const parent = s.start!.parentSpanId;
    if (parent && !imported.has(key(s.root, parent))) attributes.push(attr("deepfield.parent_coverage", "missing"));
    return { traceId: traceId(s.root), spanId: spanId(s.root, s.spanId), ...(parent ? { parentSpanId: spanId(s.root, parent) } : {}),
      name: `deepfield.${s.kind}`, kind: 1, startTimeUnixNano: String(BigInt(Date.parse(s.start!.time)) * 1000000n),
      endTimeUnixNano: String(BigInt(Date.parse(s.end!.time)) * 1000000n), attributes, links: [...links.values()], events,
      status: { code: s.status === "succeeded" ? 1 : ["failed", "timeout"].includes(s.status) ? 2 : 0 } };
  });
  if (contentManifest) contentManifest.unmatched = contentManifest.selected - contentManifest.matched;
  const body = { resourceSpans: [{ resource: { attributes: [attr("service.name", content ? "deepfield-content-export" : "deepfield-metadata-export"), attr("openinference.project.name", project)] },
    scopeSpans: [{ scope: { name: "deepfield.trace.metadata", version: "1" }, spans }] }] };
  return { body, manifest: { version: 1, hash: hash(JSON.stringify(body)), project, spanCount: spans.length, omitted, attribution,
    ...(contentManifest ? { content: contentManifest } : {}),
    coverage: omitted.length || snapshot.associations.status !== "observed" ? "partial" : snapshot.coverage.status } };
}

/** Durable reservation precedes network I/O. Any uncertain result blocks a resend, including overlapping snapshots. */
export async function sendPhoenix(converted: ReturnType<typeof toPhoenix>, origin: string, ledgerPath: string, retryRejected = false, reviewedUnreceivedHash?: string) {
  const endpoint = localEndpoint(origin);
  if (converted.manifest.hash !== hash(JSON.stringify(converted.body)) || (reviewedUnreceivedHash !== undefined &&
      (retryRejected || reviewedUnreceivedHash !== converted.manifest.hash))) throw new Error("phoenix_recovery_identity_mismatch");
  if (!converted.manifest.spanCount) throw new Error("phoenix_no_complete_spans");
  const payload = encodePhoenix(converted.body);
  mkdirSync(dirname(ledgerPath), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(ledgerPath);
  try {
    db.exec("CREATE TABLE IF NOT EXISTS imports (target TEXT, span TEXT, hash TEXT, state TEXT, manifest TEXT, PRIMARY KEY(target,span))");
    db.exec("CREATE TABLE IF NOT EXISTS import_history (target TEXT, hash TEXT, state TEXT, time TEXT)");
    const target = `${endpoint}:${converted.manifest.project}`;
    db.exec("BEGIN IMMEDIATE");
    try {
      const selectedSpans = converted.body.resourceSpans[0]!.scopeSpans[0]!.spans;
      if (reviewedUnreceivedHash) {
        // Human-reviewed receiver absence is an explicit operator precondition,
        // not inferred from a timeout or current receiver health.
        const rows = db.prepare("SELECT span,state,hash FROM imports WHERE target=? AND hash=?").all(target, reviewedUnreceivedHash) as { span: string; state: string; hash: string }[];
        const ids = new Set(selectedSpans.map(span => `${span.traceId}:${span.spanId}`));
        if (rows.length !== ids.size || rows.some(row => row.state !== "pending" || !ids.has(row.span))) throw new Error("recovery_not_pending");
        db.prepare("INSERT INTO import_history VALUES (?,?,?,?)").run(target, reviewedUnreceivedHash, "reviewed_retry_unreceived", new Date().toISOString());
      } else for (const span of selectedSpans) {
        const result = db.prepare("INSERT INTO imports VALUES (?,?,?,?,?) ON CONFLICT(target,span) DO UPDATE SET hash=excluded.hash,state=excluded.state,manifest=excluded.manifest WHERE imports.state='rejected_415' AND ?=1")
          .run(target, `${span.traceId}:${span.spanId}`, converted.manifest.hash, "pending", JSON.stringify(converted.manifest), retryRejected ? 1 : 0);
        if (!result.changes) throw new Error("duplicate");
      }
      db.prepare("INSERT INTO import_history VALUES (?,?,?,?)").run(target, converted.manifest.hash, "pending_protobuf", new Date().toISOString());
      db.exec("COMMIT");
    } catch { db.exec("ROLLBACK"); throw new Error("phoenix_duplicate_or_unresolved_import: inspect local ledger and receiver before retrying"); }
    // fetch has no automatic retries; redirect:error prevents forwarding metadata.
    const response = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/x-protobuf" }, body: Buffer.from(payload), redirect: "error", signal: AbortSignal.timeout(15000) });
    if (response.status === 415) {
      // Phoenix rejects unsupported media before decoding or scheduling any insertion.
      db.prepare("UPDATE imports SET state='rejected_415' WHERE target=? AND hash=?").run(target, converted.manifest.hash);
      db.prepare("INSERT INTO import_history VALUES (?,?,?,?)").run(target, converted.manifest.hash, "rejected_415", new Date().toISOString());
    }
    if (!response.ok) throw new Error(`phoenix_import_http_${response.status}: reservation retained`);
    const result = decodePhoenixResponse(new Uint8Array(await response.arrayBuffer()));
    if (result.partialSuccess && (Number(result.partialSuccess.rejectedSpans ?? 0) > 0 || result.partialSuccess.errorMessage)) throw new Error("phoenix_partial_import: reservation retained");
    db.prepare("UPDATE imports SET state='accepted' WHERE target=? AND hash=?").run(target, converted.manifest.hash);
    db.prepare("INSERT INTO import_history VALUES (?,?,?,?)").run(target, converted.manifest.hash, "accepted", new Date().toISOString());
    return converted.manifest;
  } finally { db.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(2);
    const send = args.includes("--send");
    const retryRejected = args.includes("--retry-rejected");
    const authorized = args.includes("--allow-public-content");
    let contentPath: string | undefined;
    let project: string | undefined;
    let reviewedUnreceivedHash: string | undefined;
    const positional: string[] = [];
    for (let i = 0; i < args.length; i++) {
      const arg = args[i]!;
      if (["--send", "--retry-rejected", "--allow-public-content"].includes(arg)) continue;
      if (arg === "--content-db" || arg === "--content-project" || arg === "--retry-confirmed-unreceived") {
        const value = args[++i]; if (!value || value.startsWith("--")) throw new Error("phoenix_invalid_arguments");
        if (arg === "--content-db") { if (contentPath) throw new Error("phoenix_invalid_arguments"); contentPath = value; }
        else if (arg === "--content-project") { if (project) throw new Error("phoenix_invalid_arguments"); project = value; }
        else { if (reviewedUnreceivedHash || !/^[a-f0-9]{64}$/.test(value)) throw new Error("phoenix_invalid_arguments"); reviewedUnreceivedHash = value; }
      } else { if (arg.startsWith("--")) throw new Error("phoenix_invalid_arguments"); positional.push(arg); }
    }
    if (Boolean(contentPath) !== authorized || (project && !contentPath)) throw new Error("phoenix_content_authorization_required");
    if (reviewedUnreceivedHash && (!send || retryRejected)) throw new Error("phoenix_invalid_arguments");
    const [file, root, usage] = positional;
    if (!file || !root || positional.length > 3) throw new Error("Usage: npm run trace:phoenix -- <trace.sqlite> <rootTraceId> [usage.sqlite] [--send]");
    const snapshot = (await import("./export.ts")).exportTrace(file, root, usage);
    const converted = contentPath ? toPhoenix(snapshot, project ?? "deepfield-content-public", { authorized, rootTraceId: root, records: readPhoenixContent(contentPath, root) }) : toPhoenix(snapshot);
    if (send) await sendPhoenix(converted, "http://127.0.0.1:6006", resolve("docs/local/phoenix-imports.sqlite"), retryRejected, reviewedUnreceivedHash);
    console.log(JSON.stringify({ mode: send ? "accepted" : "dry-run", ...converted.manifest }, null, 2));
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    console.error(/^phoenix_[a-z0-9_]+(?:: [a-z0-9 _,]+)?$/.test(message) ? message : "phoenix_import_failed"); process.exitCode = 1;
  }
}
