import { randomUUID } from "node:crypto";
import { Value } from "typebox/value";
import type { ConfigHandle } from "@deepfield/base/config";
import type { Database } from "@deepfield/base/database";
import type { MemoryIndex, MemoryInput, MemoryReader, MemoryRecord, MemoryScope, MemorySource, MemorySourceRef } from "@deepfield/base/memory";
import type { SqliteMemory } from "@deepfield/base/memory/sqlite";
import { estimatedTokens } from "@deepfield/base/memory/sqlite";
import { startTraceSpan, withTrace } from "@deepfield/base/trace/runtime";
import { MemoryCommandSchema, type AgentWorkerRequest, type ChatMemorySnapshot, type ConversationId, type MemoryCommand, type MemoryDashboard, type MemoryDetail, type MemoryEntry, type MemorySettings, type MemoryToolReply } from "@deepfield/contracts";
import type { Repositories } from "@deepfield/persistence";
import { hasCurrentUserRequest, memoryOperationFingerprint } from "./intent.js";

export interface MemorySourceRow { sequence: number; id: string; version: string; conversation: string; request: string; completed: number; handled: number }
interface RequestBinding { request: AgentWorkerRequest; source?: MemorySourceRef; text: string; grants: Set<string>; generation: number }
export interface LearningHooks { wake(): void; activity(): void; cancel(): void; retry(): Promise<void>; dispose(): void }

export class ChatMemoryHost {
  readonly ownerId: string;
  readonly userScope: MemoryScope;
  readonly requests = new Map<string, RequestBinding>();
  readonly listeners = new Set<() => void>();
  learning?: LearningHooks;
  private settings!: MemorySettings;
  private disposed = false;
  private configQueue: Promise<unknown> = Promise.resolve();
  private error: string | undefined;
  constructor(readonly store: SqliteMemory, readonly db: Database, readonly repositories: Repositories,
    private readonly config: ConfigHandle<MemorySettings>) {
    db.migrate([{ version: 1, key: "chat-memory-v1", up(d) { d.exec(`
      CREATE TABLE chat_memory_identity(id INTEGER PRIMARY KEY CHECK(id=1),owner TEXT NOT NULL);
      CREATE TABLE chat_memory_sources(sequence INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,version TEXT NOT NULL,conversation TEXT NOT NULL,request TEXT NOT NULL,completed INTEGER NOT NULL DEFAULT 0,handled INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX chat_memory_sources_pending ON chat_memory_sources(conversation,handled,completed);
      CREATE TABLE chat_memory_jobs(id TEXT PRIMARY KEY,conversation TEXT NOT NULL,request TEXT NOT NULL,state TEXT NOT NULL,sources TEXT NOT NULL,saved INTEGER NOT NULL DEFAULT 0,reason TEXT,updated INTEGER NOT NULL);
    `); } }], () => {});
    db.run("INSERT OR IGNORE INTO chat_memory_identity(id,owner) VALUES (1,?)", randomUUID());
    this.ownerId = String(db.get("SELECT owner FROM chat_memory_identity WHERE id=1")!.owner);
    this.userScope = { ownerId: this.ownerId, namespace: "chat", scopeKey: "user" };
  }
  async initialize(): Promise<void> {
    this.settings = (await this.config.getView()).values;
    this.store.setLearning(this.ownerId, this.settings.autoLearnEnabled, this.highWatermark());
    this.db.run("UPDATE chat_memory_jobs SET state='interrupted',reason='interrupted',updated=? WHERE state='running'", Date.now());
  }
  conversationScope(id: string): MemoryScope { return { ownerId: this.ownerId, namespace: "chat", scopeKey: `conversation:${id}` }; }
  scopes(id: string): MemoryScope[] { return [this.userScope, this.conversationScope(id)]; }
  currentSettings(): MemorySettings { return { ...this.settings }; }
  highWatermark(): number { return Number(this.db.get("SELECT seq FROM sqlite_sequence WHERE name='chat_memory_sources'")?.seq ?? 0); }
  sourceFor(id: string, conversation: string, request: string, kind: MemorySource["kind"]): MemorySourceRef {
    this.db.run("INSERT OR IGNORE INTO chat_memory_sources(id,version,conversation,request) VALUES (?,'1',?,?)", id, conversation, request);
    const row = this.db.get("SELECT * FROM chat_memory_sources WHERE id=?", id)!;
    const source: MemorySource = { id, version: "1", sequence: Number(row.sequence), kind, eligible: kind === "user", locator: conversation || "settings" };
    this.store.registerSources(this.ownerId, [source]);
    return { id, version: "1" };
  }
  prepare(request: AgentWorkerRequest): ChatMemorySnapshot | undefined {
    if (this.disposed) return { entries: [], state: "error", reason: "memory_disposed" };
    const span = startTraceSpan("stage", request.requestId, { stage: "memory.recall" });
    try {
      const messages = this.repositories.messages.listByConversation(request.context.conversationId as ConversationId);
      // Automatic follow-ups have no new human instruction and cannot grant a write.
      const human = messages.find(message => message.role === "user" && message.requestId === request.requestId);
      const source = human ? this.sourceFor(human.id, request.context.conversationId, request.requestId, "user") : undefined;
      this.requests.set(request.requestId, { request: structuredClone(request), ...(source ? { source } : {}), text: human?.content ?? "", grants: new Set(), generation: this.store.snapshot(this.ownerId).generation });
      if (!this.settings.useEnabled) { span.end("succeeded"); return { entries: [], state: "disabled" }; }
      const reader = this.store.reader(this.scopes(request.context.conversationId));
      // MEMORY.md is a live derived view. Every summary retains its own id/revision;
      // no synthesized prose or second on-disk fact source can outlive its record.
      const directory = this.directory(reader, 0, 1400);
      const entries = directory.entries;
      let budget = 2000 - estimatedTokens(entries);
      for (const record of reader.search(request.prompt.slice(0, 10000), { limit: 8, tokenBudget: 2000 })) {
        const entry = this.entry(record), old = entries.findIndex(item => item.id === entry.id);
        const size = estimatedTokens(entry) - (old >= 0 ? estimatedTokens(entries[old]) : 0);
        if (size > budget || entries.length >= 100 && old < 0) continue;
        budget -= size;
        if (old >= 0) entries[old] = entry; else entries.push(entry);
      }
      span.end("succeeded");
      return { entries, state: entries.length ? "ready" : "empty", ...(directory.nextOffset !== undefined ? { nextOffset: directory.nextOffset } : {}) };
    } catch (error) {
      span.end("failed", "execution_failed");
      const reason = this.reason(error);
      console.warn("[memory] recall_failed", { requestId: request.requestId, reason });
      this.failure("读取记忆暂时失败，可在设置中重试。");
      return { entries: [], state: "error", reason };
    }
  }
  private reason(error: unknown): string {
    return error instanceof Error ? /memory_[a-z_]+/u.exec(error.message)?.[0] ?? "storage_or_validation" : "unknown";
  }
  private summary(record: MemoryIndex): MemoryEntry {
    return { id: record.id, revision: record.revision, kind: record.kind, summary: record.summary,
      applicability: record.applicability, origin: record.origin, view: "summary",
      scope: record.scope.scopeKey === "user" ? "用户通用" : "当前会话" };
  }
  /** Walk compact live indexes, not keyword matches. nextOffset keeps omitted details discoverable. */
  private directory(reader: MemoryReader, offset = 0, tokenBudget = 2000): { entries: MemoryEntry[]; nextOffset?: number } {
    const entries: MemoryEntry[] = [];
    let cursor = offset, budget = tokenBudget;
    while (entries.length < 100) {
      const page = reader.listIndex({ offset: cursor, limit: 100, tokenBudget: 2000 });
      if (!page.length) return { entries };
      for (const index of page) {
        const entry = this.summary(index), size = estimatedTokens(entry);
        if (size > budget || entries.length >= 100) return { entries, nextOffset: cursor };
        budget -= size; entries.push(entry); cursor++;
      }
    }
    return { entries, nextOffset: cursor };
  }
  userActivity(): void { this.learning?.activity(); }
  completed(requestId: string): void {
    const binding = this.requests.get(requestId);
    if (binding?.source && this.settings.autoLearnEnabled) this.db.run("UPDATE chat_memory_sources SET completed=1 WHERE id=?", binding.source.id);
  }
  finished(requestId: string): void {
    this.requests.delete(requestId);
    if (!this.requests.size) this.learning?.activity();
    this.learning?.wake();
  }
  entry(record: MemoryRecord): MemoryEntry {
    return { id: record.id, revision: record.revision, kind: record.kind, view: "detail", summary: record.summary, content: record.content,
      applicability: record.applicability, origin: record.origin,
      scope: record.scope.namespace === "chat" ? record.scope.scopeKey === "user" ? "用户通用" : "当前会话" : "能力偏好" };
  }
  async call(requestId: string, toolCallId: string, rawCommand: MemoryCommand): Promise<MemoryToolReply> {
    if (!Value.Check(MemoryCommandSchema, rawCommand)) return { status: "failed", message: "记忆操作参数无效。" };
    const command = structuredClone(rawCommand);
    const binding = this.requests.get(requestId);
    if (this.disposed || !binding) return { status: "invalidated", message: "该请求已结束，请重新操作。" };
    const scopes = this.scopes(binding.request.context.conversationId);
    try {
      const reader = this.store.reader(scopes);
      if (command.operation === "validate") return { status: "ok", useEnabled: this.settings.useEnabled, validRefs: command.refs.filter(ref => this.store.isCurrent(scopes, [ref])) };
      if (command.operation === "search" || command.operation === "read") {
        if (!this.settings.useEnabled) return { status: "disabled", message: "使用记忆已关闭，仍可在设置中管理。" };
        if (command.operation === "search" && !command.query.trim()) {
          const page = this.directory(reader, command.offset ?? 0);
          return { status: page.entries.length ? "ok" : "miss", ...page,
            memoryRefs: page.entries.map(({ id, revision }) => ({ id, revision })) };
        }
        const result = command.operation === "search" ? reader.search(command.query) : (() => { const value = reader.get(command.id); return value?.status === "active" && (!value.expiresAt || value.expiresAt > Date.now()) ? [value] : []; })();
        return { status: result.length ? "ok" : "miss", entries: result.map(record => this.entry(record)), memoryRefs: result.map(({ id, revision }) => ({ id, revision })) };
      }
      if (!binding.source) return { status: "unclear", message: "请直接说明要记住、修改或删除的内容。" };
      const target = command.operation === "revise" || command.operation === "forget" ? reader.get(command.id) : undefined;
      if ((command.operation === "revise" || command.operation === "forget") && (!target || target.revision !== command.revision)) return { status: "conflict", message: "记忆已变化，请读取最新版本。" };
      const scope = target?.scope ?? (command.operation === "remember" && command.scope === "conversation" ? this.conversationScope(binding.request.context.conversationId) : this.userScope);
      if (!hasCurrentUserRequest(binding.text, command)) return { status: "unclear", message: "没有当前用户原话依据；请仅按用户明确的记忆请求操作。" };
      const fingerprint = memoryOperationFingerprint(command, { scope, target });
      if (!binding.grants.has(fingerprint) && binding.grants.size >= 8) return { status: "unclear", message: "本轮记忆操作较多，请分次明确需要保存的内容。" };
      binding.grants.add(fingerprint);
      const writer = this.store.writer(scope, { origin: "user_explicit", sources: [binding.source] });
      if (this.requests.get(requestId) !== binding || binding.generation !== this.store.snapshot(this.ownerId).generation) return { status: "invalidated" };
      const span = startTraceSpan("stage", requestId, { stage: "memory.commit" });
      let result;
      try {
        if (command.operation === "clear") { withTrace(span.context, () => this.clear()); span.end('succeeded'); return { status: "deleted", message: "已清空保存的记忆，原对话保留。" }; }
        if (command.operation === "forget") { withTrace(span.context, () => { writer.forget(command.id, command.revision); this.changed(); }); span.end('succeeded'); return { status: "deleted", message: "已删除保存的记忆及历史版本，原对话保留。" }; }
        result = withTrace(span.context, () => command.operation === "remember"
          ? writer.remember(command.input, { operationKey: `${requestId}:${toolCallId}` })
          : writer.revise(command.id, command.revision, command.input, { operationKey: `${requestId}:${toolCallId}` }));
      }
      catch (error) { span.end("failed", "execution_failed"); throw error; }
      span.end("succeeded");
      this.db.run("UPDATE chat_memory_sources SET handled=1 WHERE id=?", binding.source.id);
      this.changed();
      return { status: result.status, entries: [this.entry(result.record)], memoryRefs: [{ id: result.record.id, revision: result.record.revision }] };
    } catch (error) {
      const reason = error instanceof Error ? error.message : "unknown";
      console.warn("[memory] operation_failed", { requestId, operation: command.operation, reason: /memory_[a-z_]+/u.exec(reason)?.[0] ?? "storage_or_validation" });
      return { status: /conflict|protected/u.test(reason) ? "conflict" : /invalidated|inaccessible/u.test(reason) ? "invalidated" : "error", reason: this.reason(error), message: "记忆操作未完成，请核对内容或在设置中重试。" };
    }
  }
  get(query = ""): MemoryDashboard {
    try { return { available: true, settings: this.currentSettings(), records: this.store.listRecords(this.store.listScopes(this.ownerId), { limit: 2000, includeInactive: true })
      .filter(record => `${record.summary} ${record.content} ${record.applicability}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
      .map(({ content: _c, sources: _s, ...record }) => record), learning: this.learningStatus(), ...(this.error ? { error: this.error } : {}) }; }
    catch { return { available: false, settings: this.currentSettings(), records: [], learning: [], error: "暂时无法读取记忆，请重试。" }; }
  }
  read(id: string): MemoryDetail {
    const reader = this.store.reader(this.store.listScopes(this.ownerId)), record = reader.get(id);
    if (!record) throw new Error("memory_inaccessible");
    const sources = record.sources.map(ref => {
      const row = this.db.get("SELECT conversation,request FROM chat_memory_sources WHERE id=?", ref.id);
      if (!row?.conversation) return { label: ref.id.startsWith("capability:") ? "能力确认保存" : "记忆设置中修改" };
      const conversation = this.repositories.conversations.getById(String(row.conversation) as ConversationId);
      return { label: `对话：${conversation?.title || "未命名对话"}` };
    });
    return { record, history: reader.history(id), sources };
  }
  save(id: string, revision: number, input: MemoryInput): MemoryRecord {
    const { record } = this.read(id);
    const source = this.sourceFor(`settings:${randomUUID()}`, "", "", "confirmed");
    const result = this.store.writer(record.scope, { origin: "user_edited", sources: [source] }).revise(id, revision, input, { operationKey: randomUUID() });
    this.changed(); return result.record;
  }
  forget(id: string, revision: number): void {
    const { record } = this.read(id), source = this.sourceFor(`settings:${randomUUID()}`, "", "", "confirmed");
    this.store.writer(record.scope, { origin: "user_edited", sources: [source] }).forget(id, revision); this.changed();
  }
  clear(): void {
    this.learning?.cancel(); this.store.clearOwner(this.ownerId, this.highWatermark());
    this.db.run("UPDATE chat_memory_sources SET handled=1"); this.changed();
  }
  configure(patch: Partial<MemorySettings>): Promise<MemoryDashboard> {
    const next = this.configQueue.then(async () => {
      const values = { ...this.settings, ...patch };
      if (!values.autoLearnEnabled) { this.learning?.cancel(); this.settings.autoLearnEnabled = false; this.store.setLearning(this.ownerId, false, this.highWatermark()); }
      if (!values.useEnabled) this.settings.useEnabled = false;
      try { await this.config.save({ values }); }
      catch (error) { this.failure("设置未能保存；本次关闭已生效，请重试保存后再重启。"); throw error; }
      this.settings = values;
      this.store.setLearning(this.ownerId, values.autoLearnEnabled, this.highWatermark());
      this.changed(); this.learning?.wake(); return this.get();
    });
    this.configQueue = next.catch(() => {}); return next;
  }
  async retry(): Promise<void> { this.store.health(); this.error = undefined; await this.learning?.retry(); this.changed(); }
  learningStatus(): MemoryDashboard["learning"] {
    return this.db.all("SELECT * FROM chat_memory_jobs WHERE state<>'running' ORDER BY updated DESC LIMIT 40").map(row => ({ conversationId: String(row.conversation), requestId: String(row.request), status: row.state as MemoryDashboard["learning"][number]["status"], savedCount: Number(row.saved), updatedAt: Number(row.updated), ...(row.reason ? { reason: String(row.reason) } : {}) }));
  }
  /** Called by the conversation repository within its existing deletion transaction. */
  invalidateConversationInTransaction(id: string): void {
    const sources = this.db.all("SELECT id FROM chat_memory_sources WHERE conversation=?", id).map(row => String(row.id));
    this.store.invalidateSourcesInTransaction(this.ownerId, sources);
    this.db.run("DELETE FROM chat_memory_sources WHERE conversation=?", id);
    this.db.run("DELETE FROM chat_memory_jobs WHERE conversation=?", id);
    for (const [key, binding] of this.requests) if (binding.request.context.conversationId === id) this.requests.delete(key);
  }
  failure(message: string): void { this.error = message; this.changed(); }
  changed(): void { for (const listener of this.listeners) { try { listener(); } catch { /* Observer is optional. */ } } }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  dispose(): void { this.disposed = true; this.learning?.dispose(); this.requests.clear(); this.listeners.clear(); this.store.revoke(); }
}
