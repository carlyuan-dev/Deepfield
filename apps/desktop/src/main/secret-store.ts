import {
  createSecretStoreCore,
  defaultFileOps,
  type SecretCrypto,
  type SecretStoreCore,
} from "./secret-store-core.js";

export type { SecretCrypto } from "./secret-store-core.js";
export {
  SecretEncryptionUnavailableError,
  SecretStoreCorruptError,
} from "./secret-store-core.js";

export class SecretStore {
  private readonly core: SecretStoreCore;

  constructor(filePath: string, crypto: SecretCrypto) {
    this.core = createSecretStoreCore(filePath, crypto, defaultFileOps);
  }

  has(name: string): boolean {
    return this.core.has(name);
  }

  set(name: string, value: string): void {
    this.core.set(name, value);
  }

  get(name: string): string | undefined {
    return this.core.get(name);
  }
}
