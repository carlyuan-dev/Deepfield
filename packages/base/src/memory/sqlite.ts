import { createHash, randomUUID } from 'node:crypto';
import type { Database } from '../database/index.js';
import { BaseError } from '../errors/index.js';
import type { MemoryScope, MemorySource, MemorySourceRef, MemoryInput, MemoryRecord, MemoryOrigin, MemoryReader, MemoryWriter, MemoryLimits, MemoryIndex, MemoryWriteResult } from './index.js';
export function memoryError(code: string): never {
  throw new BaseError(`memory_${code}`, 'business');
}
const clone = <T,>(v: T): T => structuredClone(v);
const key = (s: MemoryScope) => JSON.stringify([s.ownerId, s.namespace, s.scopeKey]);
const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
function text(v: unknown, max: number) {
  if (typeof v !== 'string' || !v.trim() || v.length > max) memoryError('invalid_input');
}
export function validateInput(v: MemoryInput) {
  if (!v || !['profile', 'preference', 'convention', 'experience'].includes(v.kind)) memoryError('invalid_input');
  text(v.summary, 120);
  text(v.content, 2000);
  // Deterministic defense for credential-shaped content. Broader semantic sensitivity
  // remains a host/model policy; no blacklist can classify every private fact.
  const prose = `${v.summary}\n${v.content}\n${v.applicability}`;
  if (/-----BEGIN(?: [A-Z]+)? PRIVATE KEY-----|\b(?:sk-[A-Za-z0-9_-]{16,}|AKIA[A-Z0-9]{16}|gh[pousr]_[A-Za-z0-9]{20,})\b|(?:password|api[_ -]?key|access[_ -]?token|secret|密码|口令|密钥|令牌)\s*[:=：]\s*\S+/iu.test(prose)) memoryError('sensitive_content');
  if (typeof v.applicability !== 'string' || v.applicability.length > 300 || v.kind === 'experience' && !v.applicability.trim()) memoryError('invalid_input');
  if (v.expiresAt !== undefined && (!Number.isSafeInteger(v.expiresAt) || v.expiresAt <= 0)) memoryError('invalid_input');
}
function input(v: MemoryInput): MemoryInput {
  validateInput(v);
  return {
    kind: v.kind,
    summary: v.summary,
    content: v.content,
    applicability: v.applicability,
    ...(v.expiresAt === undefined ? {} : {
      expiresAt: v.expiresAt
    })
  };
}
export function estimatedTokens(v: unknown) {
  return Math.ceil(JSON.stringify(v).length / 2);
}
function terms(v: string): Set<string> {
  const words = v.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  return new Set(words.flatMap(w => /\p{Script=Han}/u.test(w) ? [w, ...Array.from(w).slice(1).map((_, i) => w.slice(i, i + 2))] : [w]));
}
interface State {
  generation: number;
  epoch: number;
  enabled: number;
  watermark: number;
  clear_watermark: number;
  revision: number;
  manual_revision: number;
}
export interface MemoryTicket {
  readonly token: string;
}
interface Ticket {
  scope: MemoryScope;
  sources: MemorySourceRef[];
  sourceGenerations: number[];
  ownerGeneration: number;
  scopeGeneration: number;
  manualRevision: number;
  epoch: number;
  automatic: boolean;
  learningSources: MemorySourceRef[];
  valid: () => void;
}
export function createSqliteMemory(options: {
  database: Database;
  now?: () => number;
  onChange?: () => void;
}) {
  const db = options.database,
    now = options.now ?? Date.now;
  db.migrate([{
    version: 1,
    key: 'memory-lifecycle-v1',
    up(d) {
      d.exec(`
    CREATE TABLE memory_owners(id TEXT PRIMARY KEY, generation INTEGER NOT NULL DEFAULT 0, epoch INTEGER NOT NULL DEFAULT 0, enabled INTEGER NOT NULL DEFAULT 0, watermark INTEGER NOT NULL DEFAULT 0, clear_watermark INTEGER NOT NULL DEFAULT 0, revision INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE memory_scopes(id TEXT PRIMARY KEY, owner TEXT NOT NULL, generation INTEGER NOT NULL DEFAULT 0, watermark INTEGER NOT NULL DEFAULT 0, manual_revision INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE memory_sources(owner TEXT NOT NULL, id TEXT NOT NULL, version TEXT NOT NULL, generation INTEGER NOT NULL DEFAULT 0, live INTEGER NOT NULL DEFAULT 1, suppressed INTEGER NOT NULL DEFAULT 0, data TEXT NOT NULL, PRIMARY KEY(owner,id,version));
    CREATE TABLE memory_source_tombstones(owner TEXT NOT NULL, id TEXT NOT NULL, PRIMARY KEY(owner,id));
    CREATE TABLE memory_records(id TEXT PRIMARY KEY, owner TEXT NOT NULL, scope TEXT NOT NULL, dedup TEXT NOT NULL, data TEXT NOT NULL);
    CREATE INDEX memory_records_scope ON memory_records(scope,dedup);
    CREATE TABLE memory_record_sources(record TEXT NOT NULL, owner TEXT NOT NULL, source TEXT NOT NULL, version TEXT NOT NULL, PRIMARY KEY(record,source,version));
    CREATE TABLE memory_history(id TEXT NOT NULL, revision INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(id,revision));
    CREATE TABLE memory_operations(scope TEXT NOT NULL, operation TEXT NOT NULL, fingerprint TEXT NOT NULL, id TEXT NOT NULL, revision INTEGER NOT NULL, PRIMARY KEY(scope,operation));
  `);
    }
  }], () => {});
  let revoked = false;
  const tickets = new WeakMap<MemoryTicket, Ticket>();
  function active() {
    if (revoked) memoryError('unavailable');
  }
  function changed(ownerId: string) {
    db.run('UPDATE memory_owners SET revision=revision+1 WHERE id=?', ownerId);
  }
  function notify() {
    try {
      options.onChange?.();
    } catch {/* Observers cannot undo committed storage. */}
  }
  function owner(id: string): State {
    active();
    text(id, 256);
    db.run('INSERT OR IGNORE INTO memory_owners(id) VALUES (?)', id);
    return db.get('SELECT * FROM memory_owners WHERE id=?', id) as unknown as State;
  }
  function scope(s: MemoryScope) {
    text(s.ownerId, 256);
    text(s.namespace, 256);
    text(s.scopeKey, 512);
    owner(s.ownerId);
    db.run('INSERT OR IGNORE INTO memory_scopes(id,owner) VALUES (?,?)', key(s), s.ownerId);
    return db.get('SELECT * FROM memory_scopes WHERE id=?', key(s)) as unknown as State;
  }
  function source(ownerId: string, ref: MemorySourceRef) {
    return db.get('SELECT * FROM memory_sources WHERE owner=? AND id=? AND version=?', ownerId, ref.id, ref.version);
  }
  function raw(id: string): MemoryRecord | undefined {
    const row = db.get('SELECT data FROM memory_records WHERE id=?', id);
    return row ? JSON.parse(String(row.data)) as MemoryRecord : undefined;
  }
  function records(scopes: readonly MemoryScope[]) {
    return scopes.flatMap(s => db.all('SELECT data FROM memory_records WHERE scope=?', key(s)).map(r => JSON.parse(String(r.data)) as MemoryRecord));
  }
  function capture(s: MemoryScope, refs: readonly MemorySourceRef[], automatic: boolean, valid = active, supportingRefs: readonly MemorySourceRef[] = []): MemoryTicket {
    valid();
    const bound = clone(s),
      o = owner(s.ownerId),
      st = scope(s);
    if (!refs.length || refs.length > 20) memoryError('invalid_sources');
    const allRefs = [...refs, ...supportingRefs.filter(r => !refs.some(s => s.id === r.id && s.version === r.version))];
    const t: Ticket = {
      scope: bound,
      learningSources: clone([...refs]),
      sources: clone(allRefs),
      sourceGenerations: allRefs.map(r => Number(source(s.ownerId, r)?.generation ?? -1)),
      ownerGeneration: o.generation,
      scopeGeneration: st.generation,
      manualRevision: st.manual_revision,
      epoch: o.epoch,
      automatic,
      valid
    };
    const handle = Object.freeze({
      token: randomUUID()
    });
    tickets.set(handle, t);
    check(handle);
    return handle;
  }
  function check(handle: MemoryTicket): Ticket {
    active();
    const t = tickets.get(handle);
    if (!t) memoryError('invalidated');
    t.valid();
    const o = owner(t.scope.ownerId),
      s = scope(t.scope);
    if (o.generation !== t.ownerGeneration || s.generation !== t.scopeGeneration || t.automatic && (!o.enabled || o.epoch !== t.epoch || s.manual_revision !== t.manualRevision)) memoryError('invalidated');
    t.sources.forEach((r, i) => {
      const row = source(t.scope.ownerId, r);
      if (!row || !row.live || row.suppressed || row.generation !== t.sourceGenerations[i]) memoryError('invalidated');
      const data = JSON.parse(String(row.data)) as MemorySource;
      if (data.sequence <= Math.max(o.clear_watermark, s.watermark)) memoryError('invalidated');
      const learningSource = t.learningSources.some(s => s.id === r.id && s.version === r.version);
      if (t.automatic && learningSource && data.sequence <= o.watermark) memoryError('invalidated');
      if (t.automatic && learningSource && (!data.eligible || !['user', 'confirmed', 'receipt'].includes(data.kind))) memoryError('invalid_sources');
    });
    return t;
  }
  function reader(scopesInput: readonly MemoryScope[]): MemoryReader & {
    revoke(): void;
  } {
    const scopes = clone([...scopesInput]);
    scopes.forEach(scope);
    let live = true;
    function valid() {
      active();
      if (!live) memoryError('unavailable');
    }
    const accessible = (id: string) => {
      valid();
      const r = raw(id);
      return r && scopes.some(s => key(s) === key(r.scope)) ? r : undefined;
    };
    const usable = (r: MemoryRecord, limits?: MemoryLimits) => limits?.includeInactive || r.status === 'active' && (r.expiresAt === undefined || r.expiresAt > now());
    function budget<T>(rows: T[], limits: MemoryLimits | undefined, cap: number, contiguous = false) {
      if (limits?.limit !== undefined && (!Number.isSafeInteger(limits.limit) || limits.limit < 0)) memoryError('invalid_input');
      if (limits?.tokenBudget !== undefined && (!Number.isFinite(limits.tokenBudget) || limits.tokenBudget < 0)) memoryError('invalid_input');
      const n = Math.max(0, Math.min(cap, limits?.limit ?? cap)),
        max = Math.max(0, Math.min(2000, limits?.tokenBudget ?? 2000));
      let used = 0, full = false;
      return rows.filter(r => {
        const size = estimatedTokens(r);
        if (full) return false;
        if (used + size > max) { full = contiguous; return false; }
        used += size;
        return true;
      }).slice(0, n);
    }
    return Object.freeze({
      version: 1 as const,
      revoke() {
        live = false;
      },
      get: accessible,
      history(id: string) {
        if (!accessible(id)) return [];
        return db.all('SELECT data FROM memory_history WHERE id=? ORDER BY revision DESC LIMIT 5', id).map(r => JSON.parse(String(r.data)) as MemoryRecord);
      },
      listIndex(limits?: MemoryLimits) {
        valid();
        const rows = records(scopes).filter(r => usable(r, limits)).sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id)).map(({
          content: _c,
          sources: _s,
          ...r
        }): MemoryIndex => r);
        const offset = limits?.offset ?? 0;
        if (!Number.isSafeInteger(offset) || offset < 0) memoryError('invalid_input');
        return budget(rows.slice(offset), limits, 100, true);
      },
      search(query: string, limits?: MemoryLimits) {
        valid();
        if (typeof query !== 'string' || query.length > 10000) memoryError('invalid_input');
        const q = terms(query);
        return budget(records(scopes).filter(r => usable(r, limits)).map(r => {
          const a = terms(r.summary),
            b = terms(r.content),
            c = terms(r.applicability);
          const score = [...q].reduce((n, t) => n + (a.has(t) ? 3 : 0) + (b.has(t) ? 1 : 0) + (c.has(t) ? 2 : 0), 0);
          return {
            r,
            score
          };
        }).filter(x => x.score > 0).sort((a, b) => b.score - a.score || Number(b.r.origin.startsWith('user_')) - Number(a.r.origin.startsWith('user_')) || b.r.updatedAt - a.r.updatedAt).map(x => x.r), limits, 8);
      }
    });
  }
  function save(r: MemoryRecord) {
    for (const ref of r.sources) db.run('INSERT OR IGNORE INTO memory_record_sources VALUES (?,?,?,?)', r.id, r.scope.ownerId, ref.id, ref.version);
    db.run('INSERT INTO memory_records(id,owner,scope,dedup,data) VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data,dedup=excluded.dedup', r.id, r.scope.ownerId, key(r.scope), hash(input(r)), JSON.stringify(r));
  }
  function remove(id: string) {
    db.run('DELETE FROM memory_record_sources WHERE record=?', id);
    db.run('DELETE FROM memory_records WHERE id=?', id);
    db.run('DELETE FROM memory_history WHERE id=?', id);
  }
  function write(handle: MemoryTicket, origin: MemoryOrigin, value: MemoryInput, operationKey: string, id?: string, expectedRevision?: number, selectedSources?: MemorySourceRef[], status: MemoryRecord['status'] = 'active', readSet: readonly { id: string; revision: number }[] = []): MemoryWriteResult {
    const t = check(handle),
      v = input(value);
    text(operationKey, 256);
    let refs = selectedSources ?? t.sources;
    if (!refs.length || refs.some(r => !t.sources.some(s => s.id === r.id && s.version === r.version))) memoryError('invalid_sources');
    const fingerprint = hash({
      v,
      id,
      expectedRevision,
      refs,
      origin,
      status
    });
    const previous = db.get('SELECT * FROM memory_operations WHERE scope=? AND operation=?', key(t.scope), operationKey);
    if (previous) {
      const r = raw(String(previous.id));
      if (previous.fingerprint !== fingerprint || !r || r.revision !== previous.revision) memoryError('conflict');
      return {
        status: 'unchanged',
        record: r
      };
    }
    let old = id ? raw(id) : undefined;
    if (id && (!old || key(old.scope) !== key(t.scope))) memoryError('inaccessible');
    if (old && old.revision !== expectedRevision) memoryError('conflict');
    if (t.automatic && old && (old.origin !== 'auto_extracted' || old.status !== 'active')) memoryError('protected');
    if (t.automatic && v.kind === 'experience' && !refs.some(r => ['confirmed', 'receipt'].includes((JSON.parse(String(source(t.scope.ownerId, r)!.data)) as MemorySource).kind))) memoryError('invalid_sources');
    if (!old) {
      const duplicate = db.all('SELECT data FROM memory_records WHERE scope=? AND dedup=?', key(t.scope), hash(v)).map(row => JSON.parse(String(row.data)) as MemoryRecord).find(r => hash(input(r)) === hash(v) && r.status === status);
      if (duplicate) {
        const protectedDuplicate = t.automatic && (duplicate.origin !== 'auto_extracted' || !readSet.some(r => r.id === duplicate.id && r.revision === duplicate.revision));
        const strength = { auto_extracted: 0, consumer_confirmed: 1, user_explicit: 2, user_edited: 3 };
        const mergedOrigin = strength[duplicate.origin] > strength[origin] ? duplicate.origin : origin;
        if (protectedDuplicate || mergedOrigin === duplicate.origin && refs.every(ref => duplicate.sources.some(s => s.id === ref.id && s.version === ref.version))) {
          db.run('INSERT INTO memory_operations VALUES (?,?,?,?,?)', key(t.scope), operationKey, fingerprint, duplicate.id, duplicate.revision);
          return { status: 'unchanged', record: duplicate };
        }
        old = duplicate;
        origin = mergedOrigin;
        refs = [...duplicate.sources, ...refs.filter(ref => !duplicate.sources.some(s => s.id === ref.id && s.version === ref.version))];
      }
      if (!old && Number(db.get('SELECT COUNT(*) AS n FROM memory_records WHERE owner=?', t.scope.ownerId)?.n) >= 2000) memoryError('capacity');
    }
    if (old) {
      db.run('INSERT INTO memory_history VALUES (?,?,?)', old.id, old.revision, JSON.stringify(old));
      db.run('DELETE FROM memory_history WHERE id=? AND revision NOT IN (SELECT revision FROM memory_history WHERE id=? ORDER BY revision DESC LIMIT 5)', old.id, old.id);
    }
    const record: MemoryRecord = {
      ...v,
      id: old?.id ?? randomUUID(),
      revision: (old?.revision ?? 0) + 1,
      scope: clone(t.scope),
      origin,
      sources: clone(refs),
      status,
      createdAt: old?.createdAt ?? now(),
      updatedAt: now()
    };
    save(record);
    changed(t.scope.ownerId);
    if (!t.automatic) db.run('UPDATE memory_scopes SET manual_revision=manual_revision+1 WHERE id=?', key(t.scope));
    db.run('INSERT INTO memory_operations VALUES (?,?,?,?,?)', key(t.scope), operationKey, fingerprint, record.id, record.revision);
    return {
      status: 'saved',
      record
    };
  }
  function writer(s: MemoryScope, binding: {
    origin: Exclude<MemoryOrigin, 'auto_extracted'>;
    sources: readonly MemorySourceRef[];
  }): MemoryWriter & {
    revoke(): void;
  } {
    if (!['user_explicit', 'user_edited', 'consumer_confirmed'].includes(binding.origin)) memoryError('invalid_input');
    const bound = clone(s),
      r = reader([bound]);
    let live = true;
    const valid = () => {
      active();
      if (!live) memoryError('unavailable');
    };
    const ticket = capture(bound, binding.sources, false, valid),
      origin = binding.origin;
    return Object.freeze({
      ...r,
      revoke() {
        live = false;
        r.revoke();
      },
      remember(v: MemoryInput, o: {
        operationKey: string;
      }) {
        const result = db.transaction(() => write(ticket, origin, v, o.operationKey));
        notify();
        return result;
      },
      revise(id: string, revision: number, v: MemoryInput, o: {
        operationKey: string;
      }) {
        const result = db.transaction(() => write(ticket, origin === 'user_explicit' ? 'user_edited' : origin, v, o.operationKey, id, revision));
        notify();
        return result;
      },
      forget(id: string, revision: number) {
        valid();
        db.transaction(() => {
          check(ticket);
          const old = r.get(id);
          if (!old) memoryError('inaccessible');
          if (old.revision !== revision) memoryError('conflict');
          db.all('SELECT source,version FROM memory_record_sources WHERE record=?', id).forEach(ref => db.run('UPDATE memory_sources SET suppressed=1,generation=generation+1 WHERE owner=? AND id=? AND version=?', bound.ownerId, String(ref.source), String(ref.version)));
          db.run('UPDATE memory_scopes SET generation=generation+1 WHERE id=?', key(bound));
          remove(id);
          changed(bound.ownerId);
        });
        notify();
      }
    });
  }
  function invalidate(ownerId: string, ids: readonly string[], permanent = true) {
    active();
    changed(ownerId);
    if (permanent) for (const id of ids) db.run('INSERT OR IGNORE INTO memory_source_tombstones VALUES (?,?)', ownerId, id);
    for (const row of db.all('SELECT h.id,h.revision,h.data FROM memory_history h JOIN memory_records r ON r.id=h.id WHERE r.owner=?', ownerId)) {
      const history = JSON.parse(String(row.data)) as MemoryRecord;
      if (history.sources.some(s => ids.includes(s.id))) db.run('DELETE FROM memory_history WHERE id=? AND revision=?', String(row.id), Number(row.revision));
    }
    for (const id of ids) db.run('UPDATE memory_sources SET live=0,generation=generation+1 WHERE owner=? AND id=?', ownerId, id);
    const affected = db.all('SELECT data FROM memory_records WHERE owner=?', ownerId).map(r => JSON.parse(String(r.data)) as MemoryRecord).filter(r => r.sources.some(s => ids.includes(s.id)));
    for (const r of affected) {
      if (r.sources.every(s => ids.includes(s.id))) remove(r.id);else {
        r.status = 'expired';
        r.revision++;
        r.updatedAt = now();
        save(r);
        db.run('DELETE FROM memory_history WHERE id=?', r.id);
      }
    }
  }
  return {
    reader,
    writer,
    capture,
    check,
    listScopes(ownerId: string): MemoryScope[] {
      owner(ownerId);
      return db.all('SELECT id FROM memory_scopes WHERE owner=?', ownerId).map(r => {
        const [ownerId, namespace, scopeKey] = JSON.parse(String(r.id)) as [string, string, string];
        return {
          ownerId,
          namespace,
          scopeKey
        };
      });
    },
    snapshot(ownerId: string) {
      const o = owner(ownerId);
      return {
        revision: o.revision,
        generation: o.generation,
        learningEpoch: o.epoch,
        learningEnabled: Boolean(o.enabled),
        learningWatermark: o.watermark
      };
    },
    isCurrent(scopes: readonly MemoryScope[], refs: readonly {
      id: string;
      revision: number;
    }[]) {
      const r = reader(scopes);
      return refs.every(ref => {
        const row = r.get(ref.id);
        return row?.revision === ref.revision && row.status === 'active' && (row.expiresAt === undefined || row.expiresAt > now());
      });
    },
    sourceState(ownerId: string, ref: MemorySourceRef) {
      active();
      const r = source(ownerId, ref);
      return r ? {
        source: JSON.parse(String(r.data)) as MemorySource,
        live: Boolean(r.live),
        suppressed: Boolean(r.suppressed),
        generation: Number(r.generation)
      } : undefined;
    },
    listRecords(scopes: readonly MemoryScope[], limits: {
      offset?: number;
      limit?: number;
      includeInactive?: boolean;
    } = {}) {
      active();
      const offset = limits.offset ?? 0,
        limit = limits.limit ?? 100;
      if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 0 || limit > 2000) memoryError('invalid_input');
      return records(scopes).filter(r => limits.includeInactive || r.status === 'active' && (r.expiresAt === undefined || r.expiresAt > now())).sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id)).slice(offset, offset + limit);
    },
    commitBatch(handle: MemoryTicket, changes: MemoryChange[], expectedRecords: readonly {
      id: string;
      revision: number;
    }[] = []) {
      if (changes.length > 5) memoryError('invalid_proposal');
      const result = db.transaction(() => {
        const t = check(handle);
        if (!t.automatic) memoryError('invalid_proposal');
        // Read-set validation also protects decisions based on existing records that are not rewritten.
        for (const ref of expectedRecords) {
          const r = raw(ref.id);
          if (!r || key(r.scope) !== key(t.scope) || r.revision !== ref.revision) memoryError('conflict');
        }
        const results = changes.map(c => write(handle, 'auto_extracted', c.input, c.operationKey, c.id, c.expectedRevision, c.sources, c.conflictsWith?.length ? 'conflicted' : 'active', expectedRecords));
        for (const c of changes) for (const ref of c.conflictsWith ?? []) {
          if (!expectedRecords.some(r => r.id === ref.id && r.revision === ref.revision)) memoryError('invalid_proposal');
          const r = raw(ref.id);
          if (!r || key(r.scope) !== key(t.scope)) memoryError('inaccessible');
          if (r.origin !== 'auto_extracted' || r.status === 'conflicted') continue;
          if (r.revision !== ref.revision) memoryError('conflict');
          db.run('INSERT INTO memory_history VALUES (?,?,?)', r.id, r.revision, JSON.stringify(r));
          db.run('DELETE FROM memory_history WHERE id=? AND revision NOT IN (SELECT revision FROM memory_history WHERE id=? ORDER BY revision DESC LIMIT 5)', r.id, r.id);
          r.status = 'conflicted';
          r.revision++;
          r.updatedAt = now();
          save(r);
          changed(t.scope.ownerId);
        }
        return results;
      });
      notify();
      return result;
    },
    registerSources(ownerId: string, sources: readonly MemorySource[]) {
      owner(ownerId);
      db.transaction(() => {
        for (const supplied of sources) {
          text(supplied.id, 512);
          text(supplied.version, 128);
          if (!Number.isSafeInteger(supplied.sequence) || supplied.sequence < 1 || !['user', 'confirmed', 'receipt', 'external', 'assistant'].includes(supplied.kind) || typeof supplied.eligible !== 'boolean' || supplied.locator !== undefined && (typeof supplied.locator !== 'string' || supplied.locator.length > 512)) memoryError('invalid_sources');
          const s: MemorySource = {
            id: supplied.id,
            version: supplied.version,
            sequence: supplied.sequence,
            kind: supplied.kind,
            eligible: supplied.eligible,
            ...(supplied.locator === undefined ? {} : {
              locator: supplied.locator
            })
          };
          const old = source(ownerId, s);
          if (old && old.data !== JSON.stringify(s)) memoryError('source_conflict');
          if (!old) {
            // A changed source revision retires all earlier versions and their derived support.
            const previous = db.all('SELECT version FROM memory_sources WHERE owner=? AND id=? AND live=1', ownerId, s.id);
            if (previous.length) invalidate(ownerId, [s.id], false);
            if (db.get('SELECT id FROM memory_source_tombstones WHERE owner=? AND id=?', ownerId, s.id)) memoryError('invalidated');
            db.run('INSERT INTO memory_sources(owner,id,version,data,suppressed) VALUES (?,?,?,?,?)', ownerId, s.id, s.version, JSON.stringify(s), db.get('SELECT id FROM memory_sources WHERE owner=? AND id=? AND suppressed=1', ownerId, s.id) ? 1 : 0);
          }
        }
      });
      notify();
    },
    setLearning(ownerId: string, enabled: boolean, highWatermark: number) {
      if (!Number.isSafeInteger(highWatermark) || highWatermark < 0) memoryError('invalid_input');
      const o = owner(ownerId);
      if (Boolean(o.enabled) !== enabled) db.run('UPDATE memory_owners SET enabled=?,epoch=epoch+1,revision=revision+1,watermark=MAX(watermark,?) WHERE id=?', Number(enabled), highWatermark, ownerId);
      notify();
    },
    learningState(ownerId: string) {
      return clone(owner(ownerId));
    },
    clearOwner(ownerId: string, highWatermark: number) {
      owner(ownerId);
      if (!Number.isSafeInteger(highWatermark) || highWatermark < 0) memoryError('invalid_input');
      db.transaction(() => {
        db.run('UPDATE memory_owners SET generation=generation+1,revision=revision+1,clear_watermark=MAX(clear_watermark,?) WHERE id=?', highWatermark, ownerId);
        db.all('SELECT id FROM memory_records WHERE owner=?', ownerId).forEach(r => remove(String(r.id)));
      });
      notify();
    },
    clearScope(s: MemoryScope, highWatermark: number) {
      scope(s);
      if (!Number.isSafeInteger(highWatermark) || highWatermark < 0) memoryError('invalid_input');
      db.transaction(() => {
        db.run('UPDATE memory_scopes SET generation=generation+1,watermark=MAX(watermark,?) WHERE id=?', highWatermark, key(s));
        records([s]).forEach(r => remove(r.id));
        changed(s.ownerId);
      });
      notify();
    },
    /** Caller owns the transaction; call notifyChange only after its commit. */
    invalidateSourcesInTransaction: invalidate,
    notifyChange: notify,
    revoke() {
      revoked = true;
    },
    health() {
      active();
      db.get('SELECT COUNT(*) FROM memory_records');
      return {
        status: 'ready' as const
      };
    }
  };
}
export interface MemoryChange {
  input: MemoryInput;
  operationKey: string;
  id?: string;
  expectedRevision?: number;
  sources: MemorySourceRef[];
  conflictsWith?: {
    id: string;
    revision: number;
  }[];
}
export type SqliteMemory = ReturnType<typeof createSqliteMemory>;
