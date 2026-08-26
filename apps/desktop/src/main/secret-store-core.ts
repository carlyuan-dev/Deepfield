import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

export interface SecretCrypto {
  isAvailable(): boolean;
  encrypt(value: string): Buffer;
  decrypt(value: Buffer): string;
}

export class SecretEncryptionUnavailableError extends Error {
  constructor() {
    super("Secret encryption is unavailable on this device");
    this.name = "SecretEncryptionUnavailableError";
  }
}

export class SecretStoreCorruptError extends Error {
  constructor(filePath: string) {
    super(`Secret store file is corrupted or unreadable: ${filePath}`);
    this.name = "SecretStoreCorruptError";
  }
}

export interface FileOps {
  existsSync(path: string): boolean;
  mkdirSync(path: string, options: { recursive: boolean; mode?: number }): void;
  openSync(path: string, flags: string, mode?: number): number;
  writeSync(fd: number, buffer: Buffer): number;
  fsyncSync(fd: number): void;
  closeSync(fd: number): void;
  renameSync(oldPath: string, newPath: string): void;
  unlinkSync(path: string): void;
  readFileSync(path: string): Buffer;
}

export const defaultFileOps: FileOps = {
  existsSync,
  mkdirSync: (path, options) => mkdirSync(path, options),
  openSync,
  writeSync,
  fsyncSync,
  closeSync,
  renameSync,
  unlinkSync,
  readFileSync,
};

export interface SecretStoreCore {
  has(name: string): boolean;
  set(name: string, value: string): void;
  get(name: string): string | undefined;
}

const UNSUPPORTED_DIR_FSYNC_CODES = new Set(["EINVAL", "ENOTSUP", "EOPNOTSUPP", "ENOSYS", "EISDIR"]);

function isUnsupportedError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const code = (error as NodeJS.ErrnoException).code;
  return typeof code === "string" && UNSUPPORTED_DIR_FSYNC_CODES.has(code);
}

function isCanonicalBase64(value: string): boolean {
  if (value.length === 0 || value.length % 4 !== 0) {
    return false;
  }
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    return false;
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.length === 0) {
    return false;
  }
  return decoded.toString("base64") === value;
}

function assertNonBlank(value: string, what: "secret name" | "secret value"): void {
  if (value.trim().length === 0) {
    throw new TypeError(`${what} must not be blank`);
  }
}

function parseStore(raw: Buffer, filePath: string): Record<string, string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString("utf8"));
  } catch {
    throw new SecretStoreCorruptError(filePath);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new SecretStoreCorruptError(filePath);
  }
  const record: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value !== "string") {
      throw new SecretStoreCorruptError(filePath);
    }
    record[key] = value;
  }
  return record;
}

export function createSecretStoreCore(
  filePath: string,
  crypto: SecretCrypto,
  fileOps: FileOps,
): SecretStoreCore {
  const readStore = (): Record<string, string> | undefined => {
    if (!fileOps.existsSync(filePath)) {
      return undefined;
    }
    let raw: Buffer;
    try {
      raw = fileOps.readFileSync(filePath);
    } catch {
      throw new SecretStoreCorruptError(filePath);
    }
    return parseStore(raw, filePath);
  };

  const ensureParentDirectory = (): void => {
    fileOps.mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
  };

  const fsyncDirectory = (directory: string): void => {
    try {
      const fd = fileOps.openSync(directory, "r");
      try {
        fileOps.fsyncSync(fd);
      } finally {
        fileOps.closeSync(fd);
      }
    } catch (error) {
      if (!isUnsupportedError(error)) {
        throw error;
      }
    }
  };

  const writeFileAtomically = (content: Buffer): void => {
    const tempPath = join(dirname(filePath), `${basename(filePath)}.${randomUUID()}.tmp`);
    let fd: number | undefined;
    try {
      fd = fileOps.openSync(tempPath, "wx", 0o600);
      let written = 0;
      while (written < content.length) {
        const remaining = content.subarray(written);
        const result = fileOps.writeSync(fd, remaining);
        if (!Number.isInteger(result) || result <= 0 || result > remaining.length) {
          throw new Error("failed to write secret file");
        }
        written += result;
      }
      fileOps.fsyncSync(fd);
      fileOps.closeSync(fd);
      fd = undefined;
      fileOps.renameSync(tempPath, filePath);
      fsyncDirectory(dirname(filePath));
    } catch (error) {
      if (fd !== undefined) {
        try {
          fileOps.closeSync(fd);
        } catch {
          // best effort close during failure cleanup
        }
      }
      try {
        fileOps.unlinkSync(tempPath);
      } catch {
        // temp may never have been created or already renamed away
      }
      throw error;
    }
  };

  return {
    has(name: string): boolean {
      assertNonBlank(name, "secret name");
      const store = readStore();
      return store !== undefined && Object.prototype.hasOwnProperty.call(store, name);
    },

    set(name: string, value: string): void {
      assertNonBlank(name, "secret name");
      assertNonBlank(value, "secret value");
      if (!crypto.isAvailable()) {
        throw new SecretEncryptionUnavailableError();
      }
      let ciphertext: unknown;
      try {
        ciphertext = crypto.encrypt(value);
      } catch {
        throw new Error("secret encryption failed");
      }
      if (!Buffer.isBuffer(ciphertext) || ciphertext.length === 0) {
        throw new Error("secret encryption produced an invalid result");
      }
      const existing = readStore() ?? {};
      existing[name] = ciphertext.toString("base64");
      ensureParentDirectory();
      writeFileAtomically(Buffer.from(`${JSON.stringify(existing, null, 2)}\n`, "utf8"));
    },

    get(name: string): string | undefined {
      assertNonBlank(name, "secret name");
      const store = readStore();
      if (store === undefined) {
        return undefined;
      }
      const encoded = store[name];
      if (encoded === undefined) {
        return undefined;
      }
      if (!crypto.isAvailable()) {
        throw new SecretEncryptionUnavailableError();
      }
      if (!isCanonicalBase64(encoded)) {
        throw new SecretStoreCorruptError(filePath);
      }
      let buffer: Buffer;
      try {
        buffer = Buffer.from(encoded, "base64");
      } catch {
        throw new SecretStoreCorruptError(filePath);
      }
      try {
        const decrypted: unknown = crypto.decrypt(buffer);
        if (typeof decrypted !== "string") {
          throw new SecretStoreCorruptError(filePath);
        }
        return decrypted;
      } catch {
        throw new SecretStoreCorruptError(filePath);
      }
    },
  };
}
