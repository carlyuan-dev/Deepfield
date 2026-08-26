import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { SecretCrypto } from "./secret-store.js";

const tempDirs: string[] = [];

export function makeCrypto(): SecretCrypto {
  return {
    isAvailable: () => true,
    encrypt: (value: string) => Buffer.from(`encrypted:${value}`),
    decrypt: (value: Buffer) => value.toString().replace("encrypted:", ""),
  };
}

export function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "deepfield-secret-"));
  tempDirs.push(dir);
  return dir;
}

export function storePath(dir: string): string {
  return join(dir, "secrets.json");
}

export function cleanupTempDirs(): void {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
}
