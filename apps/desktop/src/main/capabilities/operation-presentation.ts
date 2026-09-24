import { Value } from "typebox/value";
import { OperationPresentationSchema, type OperationPresentation } from "@deepfield/capability-sdk";
import { bounded, GatewayError } from "./gateway-policy.js";

/** Cosmetic package metadata must never invalidate an otherwise valid operation. */
export function safeOperationPresentation(value: unknown, capabilityId: string): OperationPresentation | undefined {
  try {
    if (!Value.Check(OperationPresentationSchema, value)) return undefined;
    const candidate = value as OperationPresentation;
    if (candidate.target && candidate.target.capabilityId !== capabilityId) return undefined;
    const normalized = { ...candidate, text: candidate.text.trim(),
      ...(candidate.linkLabel === undefined ? {} : { linkLabel: candidate.linkLabel.trim() }) };
    const json = JSON.stringify(normalized);
    if (Buffer.byteLength(json, "utf8") > 16 * 1024) return undefined;
    const copy: unknown = JSON.parse(json);
    return Value.Check(OperationPresentationSchema, copy) ? copy as OperationPresentation : undefined;
  } catch { return undefined; }
}

/** Core response size rules remain; only optional presentation is elided at the boundary. */
export function boundedWithPresentation<T extends object>(core: T, presentation?: OperationPresentation): T & { presentation?: OperationPresentation } {
  const safeCore = bounded(core);
  if (!presentation) return safeCore;
  try { return bounded({ ...safeCore, presentation }); }
  catch (error) { if (error instanceof GatewayError && error.code === "response_too_large") return safeCore; throw error; }
}
