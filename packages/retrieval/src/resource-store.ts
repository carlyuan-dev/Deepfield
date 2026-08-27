import { randomUUID } from "node:crypto";

export class ResourceStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResourceStoreError";
  }
}

export interface ResourceScope {
  traceId: string;
  projectId?: string;
  /** Immutable ToolSet authorization fingerprint (see ToolSet.fingerprint). */
  toolSetFingerprint: string;
}

export interface ResourceMetadata {
  finalUrl: string;
  contentType: string;
  size: number;
  sha256: string;
}

/** Read-only snapshot handed to get/consume: body is a fresh copy each time. */
export interface ResourceView {
  body: Buffer;
  metadata: Readonly<ResourceMetadata>;
}

interface StoredResource {
  id: string;
  scope: ResourceScope;
  body: Buffer;
  metadata: ResourceMetadata;
  expiresAtMs: number;
}

export interface ResourceStoreOptions {
  idFactory?: () => string;
  clock?: () => number;
  maxItemsPerTrace?: number;
  maxBytesPerTrace?: number;
  ttlMs?: number;
}

export function zeroFillBuffer(buffer: Buffer): void {
  buffer.fill(0);
}

function releaseBody(body: Buffer): void {
  try {
    zeroFillBuffer(body);
  } catch {
    // best-effort: never fail a release because zeroing failed
  }
}

function assertPositiveInteger(value: number | undefined, name: string): void {
  if (value === undefined) {
    return;
  }
  if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
    throw new ResourceStoreError(`invalid ${name}`);
  }
}

function assertNonNegativeInteger(value: number | undefined, name: string): void {
  if (value === undefined) {
    return;
  }
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
    throw new ResourceStoreError(`invalid ${name}`);
  }
}

const MAX_ID_ATTEMPTS = 8;

/**
 * Trace-scoped in-memory resource store. Per-trace item/byte caps aggregate by
 * traceId only (never split across project/fingerprint scopes); authorization
 * for reads still binds exactly to traceId + projectId + ToolSet fingerprint.
 * Bodies are copied on put and returned as fresh copies; ids are opaque and
 * colliding/empty factory output retries bounded instead of overwriting.
 */
export class ResourceStore {
  readonly #resources = new Map<string, StoredResource>();
  readonly #idFactory: () => string;
  readonly #clock: () => number;
  readonly #maxItemsPerTrace: number;
  readonly #maxBytesPerTrace: number;
  readonly #ttlMs: number;

  constructor(options: ResourceStoreOptions = {}) {
    this.#idFactory = options.idFactory ?? randomUUID;
    this.#clock = options.clock ?? Date.now;
    this.#maxItemsPerTrace = options.maxItemsPerTrace ?? 4;
    this.#maxBytesPerTrace = options.maxBytesPerTrace ?? 40 * 1024 * 1024;
    this.#ttlMs = options.ttlMs ?? 10 * 60 * 1000;
    assertPositiveInteger(this.#maxItemsPerTrace, "maxItemsPerTrace");
    assertNonNegativeInteger(this.#maxBytesPerTrace, "maxBytesPerTrace");
    assertPositiveInteger(this.#ttlMs, "ttlMs");
  }

  put(
    scope: ResourceScope,
    body: Buffer,
    metadata: ResourceMetadata,
  ): { id: string } {
    this.#assertValidScope(scope);
    this.#assertValidBodyAndMetadata(body, metadata);
    const now = this.#clock();
    this.#sweepExpired(now);
    let traceBytes = 0;
    let traceItems = 0;
    for (const resource of this.#resources.values()) {
      if (resource.scope.traceId === scope.traceId) {
        traceItems += 1;
        traceBytes += resource.body.length;
      }
    }
    if (traceItems >= this.#maxItemsPerTrace) {
      throw new ResourceStoreError("per-trace resource limit reached");
    }
    if (traceBytes + body.length > this.#maxBytesPerTrace) {
      throw new ResourceStoreError("per-trace byte limit reached");
    }
    // The unique id is allocated BEFORE the body copy so a failed allocation
    // (empty/duplicate factory output exhausted) can never leave an
    // uncleaned Buffer copy behind.
    const id = this.#allocateId();
    const entry: StoredResource = {
      id,
      scope: { ...scope },
      body: Buffer.from(body), // defensive copy: caller mutation cannot leak in
      metadata: { ...metadata },
      expiresAtMs: now + this.#ttlMs,
    };
    this.#resources.set(id, entry);
    return { id };
  }

  get(id: string, scope: ResourceScope): ResourceView | undefined {
    return this.#read(id, scope, false);
  }

  /** Atomically removes the resource after authorization succeeds. */
  consume(id: string, scope: ResourceScope): ResourceView | undefined {
    return this.#read(id, scope, true);
  }

  releaseTrace(traceId: string): number {
    let removed = 0;
    for (const [id, resource] of [...this.#resources]) {
      if (resource.scope.traceId === traceId) {
        this.#delete(id, resource);
        removed += 1;
      }
    }
    return removed;
  }

  dispose(): void {
    for (const [id, resource] of [...this.#resources]) {
      this.#delete(id, resource);
    }
  }

  size(): number {
    return this.#resources.size;
  }

  #read(id: string, scope: ResourceScope, deleteAfter: boolean): ResourceView | undefined {
    this.#assertValidScope(scope);
    const resource = this.#resources.get(id);
    if (resource === undefined) {
      return undefined;
    }
    if (!this.#sameScope(resource.scope, scope)) {
      return undefined; // authorization failure: never delete
    }
    if (this.#clock() >= resource.expiresAtMs) {
      this.#delete(id, resource);
      return undefined;
    }
    const view: ResourceView = {
      body: Buffer.from(resource.body),
      metadata: Object.freeze({ ...resource.metadata }),
    };
    if (deleteAfter) {
      this.#delete(id, resource);
    }
    return view;
  }

  #delete(id: string, resource: StoredResource): void {
    this.#resources.delete(id);
    releaseBody(resource.body);
  }

  #allocateId(): string {
    for (let attempt = 0; attempt < MAX_ID_ATTEMPTS; attempt += 1) {
      const candidate = this.#idFactory();
      if (typeof candidate !== "string" || candidate.length === 0) {
        continue; // empty ids are never used
      }
      if (this.#resources.has(candidate)) {
        continue; // collision: retry bounded, never overwrite an existing entry
      }
      return candidate;
    }
    throw new ResourceStoreError("resource id generation failed");
  }

  #assertValidScope(scope: ResourceScope): void {
    if (typeof scope.traceId !== "string" || scope.traceId.length === 0) {
      throw new ResourceStoreError("traceId must be a non-empty string");
    }
    if (typeof scope.toolSetFingerprint !== "string" || scope.toolSetFingerprint.length === 0) {
      throw new ResourceStoreError("toolSetFingerprint must be a non-empty string");
    }
    if (scope.projectId !== undefined && (typeof scope.projectId !== "string" || scope.projectId.length === 0)) {
      throw new ResourceStoreError("projectId must be a non-empty string when present");
    }
  }

  #assertValidBodyAndMetadata(body: unknown, metadata: ResourceMetadata): void {
    if (!Buffer.isBuffer(body)) {
      throw new ResourceStoreError("body must be a Buffer");
    }
    if (typeof metadata.finalUrl !== "string" || metadata.finalUrl.length === 0) {
      throw new ResourceStoreError("metadata.finalUrl must be a non-empty string");
    }
    if (typeof metadata.contentType !== "string" || metadata.contentType.length === 0) {
      throw new ResourceStoreError("metadata.contentType must be a non-empty string");
    }
    if (!Number.isFinite(metadata.size) || !Number.isInteger(metadata.size) || metadata.size < 0) {
      throw new ResourceStoreError("metadata.size must be a non-negative integer");
    }
    if (typeof metadata.sha256 !== "string" || metadata.sha256.length === 0) {
      throw new ResourceStoreError("metadata.sha256 must be a non-empty string");
    }
  }

  #sameScope(a: ResourceScope, b: ResourceScope): boolean {
    if (a.traceId !== b.traceId) {
      return false;
    }
    if (a.projectId !== b.projectId) {
      return false; // undefined vs defined must not match
    }
    if (a.toolSetFingerprint !== b.toolSetFingerprint) {
      return false;
    }
    return true;
  }

  #sweepExpired(now: number): void {
    for (const [id, resource] of [...this.#resources]) {
      if (now >= resource.expiresAtMs) {
        this.#delete(id, resource);
      }
    }
  }
}
