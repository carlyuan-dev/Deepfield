import { existsSync, readFileSync, readdirSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import {
  SecretStore,
  SecretStoreCorruptError,
  type SecretCrypto,
} from "./secret-store.js";
import {
  createSecretStoreCore,
  defaultFileOps,
  type FileOps,
} from "./secret-store-core.js";
import {
  cleanupTempDirs,
  makeCrypto,
  makeDir,
  storePath,
} from "./secret-store-test-helpers.js";

afterEach(cleanupTempDirs);

describe("secret store hardening", () => {
  it("rejects an encrypt result that is not a Buffer", () => {
    const dir = makeDir();
    const file = storePath(dir);
    const secret = "sk-plaintext-leak";
    const badCrypto = {
      isAvailable: () => true,
      encrypt: (value: string) => value,
      decrypt: (value: Buffer) => value.toString(),
    } as unknown as SecretCrypto;
    const store = new SecretStore(file, badCrypto);
    let caught: unknown;
    try {
      store.set("deepseek.apiKey", secret);
      expect.unreachable("should have thrown");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).not.toContain(secret);
    expect(existsSync(file)).toBe(false);
  });

  it("rejects an empty encrypt result without creating a file", () => {
    const dir = makeDir();
    const file = storePath(dir);
    const badCrypto = {
      isAvailable: () => true,
      encrypt: () => Buffer.alloc(0),
      decrypt: (value: Buffer) => value.toString(),
    };
    const store = new SecretStore(file, badCrypto);
    expect(() => store.set("deepseek.apiKey", "sk-x")).toThrow(/invalid result/);
    expect(existsSync(file)).toBe(false);
  });

  it("never leaks the secret through encryption errors or a cause", () => {
    const dir = makeDir();
    const file = storePath(dir);
    new SecretStore(file, makeCrypto()).set("deepseek.apiKey", "sk-existing");
    const before = readFileSync(file);
    const secret = "sk-ultra-secret";
    const leaking = {
      isAvailable: () => true,
      encrypt: () => {
        throw new Error(`encrypt failed for ${secret}`);
      },
      decrypt: (value: Buffer) => value.toString(),
    };
    const store = new SecretStore(file, leaking);
    let caught: unknown;
    try {
      store.set("deepseek.apiKey", secret);
      expect.unreachable("should have thrown");
    } catch (error) {
      caught = error;
    }
    const error = caught as Error;
    expect(error.message).not.toContain(secret);
    expect((error as { cause?: unknown }).cause).toBeUndefined();
    const enumerable: Record<string, unknown> = {};
    for (const key of Object.keys(error)) {
      enumerable[key] = (error as unknown as Record<string, unknown>)[key];
    }
    const serialized = JSON.stringify({
      message: error.message,
      cause: (error as { cause?: unknown }).cause,
      enumerable,
    });
    expect(serialized).not.toContain(secret);
    expect(readFileSync(file)).toEqual(before);
  });

  it("fails fast when writeSync makes no progress", () => {
    const dir = makeDir();
    const file = storePath(dir);
    new SecretStore(file, makeCrypto()).set("deepseek.apiKey", "sk-original");
    const originalBytes = readFileSync(file);
    const secret = "sk-new-value";
    let writeCalls = 0;
    const zeroWriteOps: FileOps = {
      ...defaultFileOps,
      writeSync: () => {
        writeCalls += 1;
        return 0;
      },
    };
    const store = createSecretStoreCore(file, makeCrypto(), zeroWriteOps);
    expect(() => store.set("deepseek.apiKey", secret)).toThrow(/failed to write secret file/);
    expect(writeCalls).toBe(1);
    expect(readFileSync(file)).toEqual(originalBytes);
    expect(readdirSync(dir)).toEqual(["secrets.json"]);
  }, 2000);

  it("maps a non-string decrypt result to SecretStoreCorruptError", () => {
    const dir = makeDir();
    const file = storePath(dir);
    new SecretStore(file, makeCrypto()).set("deepseek.apiKey", "sk-x");
    const before = readFileSync(file);
    const badDecrypt = {
      isAvailable: () => true,
      encrypt: (value: string) => Buffer.from(`encrypted:${value}`),
      decrypt: () => 42,
    } as unknown as SecretCrypto;
    const store = new SecretStore(file, badDecrypt);
    expect(() => store.get("deepseek.apiKey")).toThrow(SecretStoreCorruptError);
    expect(readFileSync(file)).toEqual(before);
  });
});
