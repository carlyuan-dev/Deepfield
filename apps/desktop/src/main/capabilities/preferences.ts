import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

export interface CapabilityPreferences { schemaVersion: 1; initialized: boolean; enabledIds: string[] }
export async function readCapabilityPreferences(statePath: string): Promise<CapabilityPreferences | undefined> {
  let text: string;
  try { text = await readFile(statePath, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error("capability_state_corrupt"); }
  if (!value || typeof value !== "object") throw new Error("capability_state_corrupt");
  const state = value as Partial<CapabilityPreferences>;
  // The former enabledIds-only format represents an already initialized install.
  if ((state.schemaVersion === 1 && typeof state.initialized !== "boolean") ||
      (state.schemaVersion === undefined && state.initialized !== undefined) ||
      (state.schemaVersion !== undefined && state.schemaVersion !== 1) ||
      (state.initialized !== undefined && typeof state.initialized !== "boolean") ||
      !Array.isArray(state.enabledIds) || state.enabledIds.some(id => typeof id !== "string" || !/^[a-z][a-z0-9-]*$/.test(id))) throw new Error("capability_state_corrupt");
  return { schemaVersion: 1, initialized: state.initialized ?? true, enabledIds: [...new Set(state.enabledIds)] };
}
export async function writeCapabilityPreferences(statePath: string, state: CapabilityPreferences): Promise<void> {
  await mkdir(dirname(statePath), { recursive: true });
  const temporary = `${statePath}.${randomUUID()}.tmp`;
  try { await writeFile(temporary, JSON.stringify(state), { flag: "wx" }); await rename(temporary, statePath); }
  finally { await unlink(temporary).catch(() => {}); }
}
export async function readEnabledIds(statePath: string): Promise<readonly string[]> {
  return (await readCapabilityPreferences(statePath))?.enabledIds ?? [];
}
export async function writeEnabledIds(statePath: string, ids: readonly string[]): Promise<void> {
  if (ids.some(id => !/^[a-z][a-z0-9-]*$/.test(id))) throw new Error("invalid_capability_id");
  const state = await readCapabilityPreferences(statePath);
  await writeCapabilityPreferences(statePath, { schemaVersion: 1, initialized: state?.initialized ?? true, enabledIds: [...new Set(ids)] });
}
