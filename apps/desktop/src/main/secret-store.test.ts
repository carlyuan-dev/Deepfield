import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  SecretEncryptionUnavailableError,
  SecretStore,
  SecretStoreCorruptError,
  type SecretCrypto,
} from "./secret-store.js";
import {
  createSecretStoreCore,
  defaultFileOps,
  type FileOps,
} from "./secret-store-core.js";

function makeCrypto(): SecretCrypto {
  return {
    isAvailable: () => true,
    encrypt: (value: string) => Buffer.from(`encrypted:${value}`),
    decrypt: (value: Buffer) => value.toString().replace("encrypted:", ""),
  };
}

const tempDirs: string[] = [];

function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "deepfield-secret-"));
  tempDirs.push(dir);
  return dir;
}

function storePath(dir: string): string {
  return join(dir, "secrets.json");
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("secret store", () => {
  it("never writes the plaintext API key", () => {
    const file = storePath(makeDir());
    const store = new SecretStore(file, makeCrypto());
    store.set("deepseek.apiKey", "sk-private-value");
    expect(readFileSync(file, "utf8")).not.toContain("sk-private-value");
    expect(store.get("deepseek.apiKey")).toBe("sk-private-value");
  });

  it("stores only base64 ciphertext and leaves no temp files", () => {
    const dir = makeDir();
    const file = storePath(dir);
    const store = new SecretStore(file, makeCrypto());
    store.set("deepseek.apiKey", "sk-123456");

    const raw = readFileSync(file, "utf8");
    expect(raw).not.toContain("sk-123456");
    const parsed = JSON.parse(raw) as Record<string, string>;
    expect(Object.keys(parsed)).toEqual(["deepseek.apiKey"]);
    expect(parsed["deepseek.apiKey"]).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
    expect(readdirSync(dir)).toEqual(["secrets.json"]);

    expect(store.has("deepseek.apiKey")).toBe(true);
    expect(store.get("deepseek.apiKey")).toBe("sk-123456");
  });

  it("overwrites a name with only the new ciphertext", () => {
    const dir = makeDir();
    const file = storePath(dir);
    const store = new SecretStore(file, makeCrypto());
    store.set("deepseek.apiKey", "sk-old-value");
    store.set("deepseek.apiKey", "sk-new-value");

    const raw = readFileSync(file, "utf8");
    expect(raw).not.toContain("sk-old-value");
    expect(raw).not.toContain("sk-new-value");
    const parsed = JSON.parse(raw) as Record<string, string>;
    expect(Object.keys(parsed)).toEqual(["deepseek.apiKey"]);
    expect(store.get("deepseek.apiKey")).toBe("sk-new-value");
  });

  it("returns false and undefined when no store file exists", () => {
    const store = new SecretStore(storePath(makeDir()), makeCrypto());
    expect(store.has("deepseek.apiKey")).toBe(false);
    expect(store.get("deepseek.apiKey")).toBeUndefined();
  });

  it("throws SecretEncryptionUnavailableError without touching the file", () => {
    const dir = makeDir();
    const file = storePath(dir);
    const unavailable: SecretCrypto = {
      isAvailable: () => false,
      encrypt: (value: string) => Buffer.from(value),
      decrypt: (value: Buffer) => value.toString(),
    };

    const store = new SecretStore(file, unavailable);
    expect(() => store.set("deepseek.apiKey", "sk-x")).toThrow(SecretEncryptionUnavailableError);
    expect(existsSync(file)).toBe(false);
    expect(store.get("deepseek.apiKey")).toBeUndefined();
    expect(store.has("deepseek.apiKey")).toBe(false);

    new SecretStore(file, makeCrypto()).set("deepseek.apiKey", "sk-existing");
    const before = readFileSync(file);
    const unavailableOnExisting = new SecretStore(file, unavailable);
    expect(unavailableOnExisting.has("deepseek.apiKey")).toBe(true);
    expect(() => unavailableOnExisting.get("deepseek.apiKey")).toThrow(
      SecretEncryptionUnavailableError,
    );
    expect(readFileSync(file)).toEqual(before);
  });

  it("rejects blank names and values without creating a file", () => {
    const dir = makeDir();
    const file = storePath(dir);
    const store = new SecretStore(file, makeCrypto());
    expect(() => store.set("", "sk-x")).toThrow(/blank/);
    expect(() => store.set("   ", "sk-x")).toThrow(/blank/);
    expect(() => store.set("deepseek.apiKey", "")).toThrow(/blank/);
    expect(() => store.set("deepseek.apiKey", "   ")).toThrow(/blank/);
    expect(() => store.has("")).toThrow(/blank/);
    expect(() => store.get(" ")).toThrow(/blank/);
    expect(existsSync(file)).toBe(false);
  });

  it("maps corrupt store files to SecretStoreCorruptError without rewriting", () => {
    const dir = makeDir();
    const cases: Array<{ label: string; content: string }> = [
      { label: "illegal JSON", content: "{not json" },
      { label: "JSON string", content: JSON.stringify("just-a-string") },
      { label: "JSON array", content: JSON.stringify(["a"]) },
      { label: "JSON null", content: "null" },
      { label: "non-string ciphertext", content: JSON.stringify({ "deepseek.apiKey": 42 }) },
      { label: "missing base64 padding", content: JSON.stringify({ "deepseek.apiKey": "aGVsbG8" }) },
      { label: "invalid base64 characters", content: JSON.stringify({ "deepseek.apiKey": "!!!!" }) },
      { label: "empty ciphertext", content: JSON.stringify({ "deepseek.apiKey": "" }) },
    ];
    for (let index = 0; index < cases.length; index += 1) {
      const testCase = cases[index]!;
      const file = join(dir, `corrupt-${index}.json`);
      writeFileSync(file, testCase.content, { mode: 0o600 });
      const before = readFileSync(file);
      const store = new SecretStore(file, makeCrypto());
      expect(() => store.get("deepseek.apiKey")).toThrow(SecretStoreCorruptError);
      expect(readFileSync(file)).toEqual(before);
    }

    // has() checks stored metadata only: structural corruption throws,
    // value-level corruption (invalid base64) does not require decryption.
    const structuralFile = join(dir, "corrupt-structural.json");
    writeFileSync(structuralFile, "{bad json", { mode: 0o600 });
    expect(() => new SecretStore(structuralFile, makeCrypto()).has("deepseek.apiKey")).toThrow(
      SecretStoreCorruptError,
    );
    const base64File = join(dir, "corrupt-base64.json");
    writeFileSync(base64File, JSON.stringify({ "deepseek.apiKey": "aGVsbG8" }), { mode: 0o600 });
    expect(new SecretStore(base64File, makeCrypto()).has("deepseek.apiKey")).toBe(true);

    const setFile = join(dir, "corrupt-set.json");
    writeFileSync(setFile, "{bad json", { mode: 0o600 });
    const setBefore = readFileSync(setFile);
    expect(() => new SecretStore(setFile, makeCrypto()).set("deepseek.apiKey", "sk-new")).toThrow(
      SecretStoreCorruptError,
    );
    expect(readFileSync(setFile)).toEqual(setBefore);
  });

  it("maps decrypt failures to SecretStoreCorruptError without leaking the secret", () => {
    const dir = makeDir();
    const file = storePath(dir);
    const secret = "sk-top-secret-value";
    new SecretStore(file, makeCrypto()).set("deepseek.apiKey", secret);
    const before = readFileSync(file);
    const throwing: SecretCrypto = {
      isAvailable: () => true,
      encrypt: (value: string) => Buffer.from(`encrypted:${value}`),
      decrypt: () => {
        throw new Error("simulated decrypt failure");
      },
    };
    const store = new SecretStore(file, throwing);
    expect(() => store.get("deepseek.apiKey")).toThrow(SecretStoreCorruptError);
    expect(readFileSync(file)).toEqual(before);
    try {
      store.get("deepseek.apiKey");
      expect.unreachable("should have thrown");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).not.toContain(secret);
    }
  });

  it("writes the secret file with 0600 and creates missing parents with 0700", () => {
    const base = makeDir();
    const file = join(base, "nested", "deeper", "secrets.json");
    new SecretStore(file, makeCrypto()).set("deepseek.apiKey", "sk-x");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(join(base, "nested", "deeper")).mode & 0o777).toBe(0o700);
  });

  it("does not loosen permissions of an existing parent directory", () => {
    const base = makeDir();
    chmodSync(base, 0o755);
    const file = storePath(base);
    new SecretStore(file, makeCrypto()).set("deepseek.apiKey", "sk-x");
    expect(statSync(base).mode & 0o777).toBe(0o755);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("preserves the existing file when an overwrite fails", () => {
    const dir = makeDir();
    const file = storePath(dir);
    new SecretStore(file, makeCrypto()).set("deepseek.apiKey", "sk-original");
    const originalBytes = readFileSync(file);

    const failingOps: FileOps = {
      ...defaultFileOps,
      renameSync: () => {
        throw new Error("simulated rename failure");
      },
    };
    const store = createSecretStoreCore(file, makeCrypto(), failingOps);
    expect(() => store.set("deepseek.apiKey", "sk-new")).toThrow(/simulated rename failure/);
    expect(readFileSync(file)).toEqual(originalBytes);
    expect(readdirSync(dir)).toEqual(["secrets.json"]);
  });

  it("cleans the temp file and keeps the final file when fsync fails", () => {
    const dir = makeDir();
    const file = storePath(dir);
    new SecretStore(file, makeCrypto()).set("deepseek.apiKey", "sk-original");
    const originalBytes = readFileSync(file);

    const failingOps: FileOps = {
      ...defaultFileOps,
      fsyncSync: () => {
        throw new Error("simulated fsync failure");
      },
    };
    const store = createSecretStoreCore(file, makeCrypto(), failingOps);
    expect(() => store.set("deepseek.apiKey", "sk-new")).toThrow(/simulated fsync failure/);
    expect(readFileSync(file)).toEqual(originalBytes);
    expect(readdirSync(dir)).toEqual(["secrets.json"]);
  });

  it("ignores only unsupported directory fsync errors after rename", () => {
    const dir = makeDir();
    const file = storePath(dir);
    const unsupportedOps: FileOps = {
      ...defaultFileOps,
      openSync: (path: string, flags: string, mode?: number) => {
        if (path === dir) {
          const error = new Error("directory fsync not supported") as NodeJS.ErrnoException;
          error.code = "ENOTSUP";
          throw error;
        }
        return defaultFileOps.openSync(path, flags, mode);
      },
    };
    const store = createSecretStoreCore(file, makeCrypto(), unsupportedOps);
    store.set("deepseek.apiKey", "sk-x");
    expect(store.get("deepseek.apiKey")).toBe("sk-x");
  });

  it("propagates non-unsupported directory fsync errors", () => {
    const dir = makeDir();
    const file = storePath(dir);
    const failingOps: FileOps = {
      ...defaultFileOps,
      openSync: (path: string, flags: string, mode?: number) => {
        if (path === dir) {
          const error = new Error("directory fsync denied") as NodeJS.ErrnoException;
          error.code = "EACCES";
          throw error;
        }
        return defaultFileOps.openSync(path, flags, mode);
      },
    };
    const store = createSecretStoreCore(file, makeCrypto(), failingOps);
    expect(() => store.set("deepseek.apiKey", "sk-x")).toThrow(/directory fsync denied/);
  });

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
