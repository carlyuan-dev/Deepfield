import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ConfigAddress, ConfigDocumentStore } from "@deepfield/base/config/runtime";

function readDocument(file: string): unknown | undefined {
  let text: string;
  try { text = readFileSync(file, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  return JSON.parse(text);
}

function writeDocument(file: string, document: unknown): void {
  const json = `${JSON.stringify(document, null, 2)}\n`;
  mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, json, { mode: 0o600, flag: "wx" });
    renameSync(temp, file);
  } catch (error) {
    try { unlinkSync(temp); } catch { /* Preserve the original write failure. */ }
    throw error;
  }
}

/** The legacy manager owns document validation; this port preserves the v1 file. */
export function createLegacyConfigFileStore(file: string): { read(): unknown | undefined; write(document: unknown): void } {
  return { read: () => readDocument(file), write: document => writeDocument(file, document) };
}

/** Names are identities, never paths. Hashing also bounds filenames for long keys. */
function segment(value: string): string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value)) throw new Error("invalid_config_address");
  return createHash("sha256").update(value).digest("hex");
}

export function createScopedConfigFileStore(root: string): ConfigDocumentStore {
  const file = ({ scope, key }: ConfigAddress) => join(root, segment(scope), `${segment(key)}.json`);
  return { read: address => readDocument(file(address)), write: (address, document) => writeDocument(file(address), document) };
}
