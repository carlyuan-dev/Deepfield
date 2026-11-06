/** Browser-safe memory.v1 contracts. Authority is bound by the host, never model input. */
export interface MemoryScope {
  ownerId: string;
  namespace: string;
  scopeKey: string;
}
export type MemoryKind = 'profile' | 'preference' | 'convention' | 'experience';
export type MemoryOrigin = 'user_explicit' | 'user_edited' | 'auto_extracted' | 'consumer_confirmed';
export type MemoryStatus = 'active' | 'conflicted' | 'superseded' | 'expired';
export interface MemorySourceRef {
  id: string;
  version: string;
}
export interface MemorySource extends MemorySourceRef {
  sequence: number;
  kind: 'user' | 'confirmed' | 'receipt' | 'external' | 'assistant';
  eligible: boolean;
  locator?: string;
}
export interface MemoryInput {
  kind: MemoryKind;
  summary: string;
  content: string;
  applicability: string;
  expiresAt?: number;
}
export interface MemoryRecord extends MemoryInput {
  id: string;
  revision: number;
  scope: MemoryScope;
  origin: MemoryOrigin;
  sources: MemorySourceRef[];
  status: MemoryStatus;
  createdAt: number;
  updatedAt: number;
  lastUsedAt?: number;
}
export type MemoryIndex = Omit<MemoryRecord, 'content' | 'sources'>;
export interface MemoryLimits {
  /** Directory pagination; applied by listIndex before its token budget. */
  offset?: number;
  limit?: number;
  tokenBudget?: number;
  includeInactive?: boolean;
}
export interface MemoryReader {
  readonly version: 1;
  get(id: string): MemoryRecord | undefined;
  history(id: string): MemoryRecord[];
  listIndex(limits?: MemoryLimits): MemoryIndex[];
  search(query: string, limits?: MemoryLimits): MemoryRecord[];
}
export interface MemoryWriteResult {
  status: 'saved' | 'unchanged';
  record: MemoryRecord;
}
export interface MemoryWriter extends MemoryReader {
  remember(input: MemoryInput, options: {
    operationKey: string;
  }): MemoryWriteResult;
  revise(id: string, expectedRevision: number, input: MemoryInput, options: {
    operationKey: string;
  }): MemoryWriteResult;
  forget(id: string, expectedRevision: number): void;
}
export interface MemoryService {
  readonly version: 1;
  reader: MemoryReader;
  writer?: MemoryWriter;
  /** Optional host-bound package resource scope and writable scope cleanup. */
  resource?(key: string): MemoryService;
  clear?(): void;
}
export function assertMemory(value: unknown): asserts value is MemoryService {
  if (!value || typeof value !== 'object' || !('version' in value) || value.version !== 1 || !('reader' in value) || !value.reader || typeof value.reader !== 'object' || !('search' in value.reader) || typeof value.reader.search !== 'function') throw new Error('incompatible_host_service:memory.v1');
}
