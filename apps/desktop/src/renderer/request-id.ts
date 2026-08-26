export function createRequestId(): string {
  return globalThis.crypto.randomUUID();
}
