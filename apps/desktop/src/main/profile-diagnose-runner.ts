import { Value } from "typebox/value";
import { CompanyProfileWorkerEventSchema, CompanyProfileWorkerRequestSchema, type CompanyProfileWorkerEvent } from "../../../../capabilities/company-research/contracts/index.js";
import { createCompanyProfileAgent, type CompanyProfileAgent } from "../../../../capabilities/company-research/runtime/company-profile-agent.js";
import { createToolRuntime } from "../worker/tools/tool-runtime.js";

/** Isolated single-attempt harness. No production database/settings/file writes. */
export async function runProfileDiagnostic(value: unknown, write: (safeJsonLine: string) => void, agent?: CompanyProfileAgent): Promise<0 | 1 | 2> {
  if (!Value.Check(CompanyProfileWorkerRequestSchema, value)) return 1;
  const runtime = agent ? undefined : createToolRuntime({ audit: { start: async () => {}, finish: async () => {}, recordSynthetic: async () => {} } });
  const profileAgent = agent ?? createCompanyProfileAgent({ toolSessions: runtime! });
  let terminal: Extract<CompanyProfileWorkerEvent, { type: "completed" | "failed" }> | undefined;
  try {
    await profileAgent.run(value, (event) => {
      if (!Value.Check(CompanyProfileWorkerEventSchema, event)) throw new Error("invalid profile event");
      if (event.requestId !== value.requestId || event.companyId !== value.companyId) return;
      if (event.type === "diagnostic") {
        write(JSON.stringify(event));
      } else terminal = event;
    }, new AbortController().signal);
    if (!terminal) return 1;
    write(JSON.stringify({ kind: "profile-diagnose.terminal", requestId: value.requestId, companyId: value.companyId, status: terminal.type,
      ...(terminal.type === "failed" ? { code: terminal.code } : {}) }));
    return terminal.type === "completed" ? 0 : 2;
  } catch { return 1; }
}
