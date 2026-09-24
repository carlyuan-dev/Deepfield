import { canonicalActionJson } from "@deepfield/capability-sdk";
import type { ResearchRun } from "../contracts/index.js";

/** Browser-safe equivalent of the package artifact's content/metadata revision. */
export async function reportRevision(run: ResearchRun): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalActionJson(run)));
  return `sha256:${Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, "0")).join("")}`;
}
