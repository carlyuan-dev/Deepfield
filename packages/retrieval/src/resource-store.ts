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

/** Zero-fills a buffer before it is dropped, best-effort body hygiene. */
function releaseBody(body: Buffer): void {
  try {
    zeroFillBuffer(body);
  } catch {
    // best-effort: never fail a release because zeroing failed
  }
}

/**
 * Trace-scoped in-memory resource store. Resources bind exactly to
 * traceId + projectId + ToolSet authorization fingerprint; bodies are copied on
 * put and returned as copies, so caller mutation can never change stored data.
 * There is no list/enumerate API and no LRU eviction: per-trace caps reject new
 * puts and expired resources are unreadable and safely released.
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
  }

  put(
    scope: ResourceScope,
    body: Buffer,
    metadata: ResourceMetadata,
  ): { id: string } {
    const now = this.#clock();
    this.#sweepExpired(now);
    let traceBytes = 0;
    let traceItems = 0;
    for (const resource of this.#resources.values()) {
      if (this.#sameScope(resource.scope, scope)) {
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
    const id = this.#idFactory();
    this.#resources.set(id, {
      id,
      scope: { ...scope },
      body: Buffer.from(body), // defensive copy: caller mutation cannot leak in
      metadata: { ...metadata },
      expiresAtMs: now + this.#ttlMs,
    });
    return { id };
  }

  get(id: string, scope: ResourceScope): Buffer | undefined {
    return this.#read(id, scope, false);
  }

  /** Atomically removes the resource after authorization succeeds. */
  consume(id: string, scope: ResourceScope): Buffer | undefined {
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

  #read(id: string, scope: ResourceScope, deleteAfter: boolean): Buffer | undefined {
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
    const copy = Buffer.from(resource.body);
    if (deleteAfter) {
      this.#delete(id, resource);
    }
    return copy;
  }

  #delete(id: string, resource: StoredResource): void {
    this.#resources.delete(id);
    releaseBody(resource.body);
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
