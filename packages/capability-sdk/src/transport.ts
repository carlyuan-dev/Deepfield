import { Type, type Static } from "typebox";
import { DraftRefSchema, ViewRefSchema } from "./interaction.js";

export const CapabilityNavigationEventSchema = Type.Union([
  Type.Object({ kind: Type.Literal("open"), requestId: Type.String({ minLength: 1 }), target: Type.Union([ViewRefSchema, DraftRefSchema]), view: ViewRefSchema, expiresAt: Type.Number() }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal("cancel"), requestId: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
]);

const Id = Type.String({ minLength: 1, maxLength: 200 });
export const CapabilityCallSchema = Type.Object({ capabilityId: Id, operation: Id, requestId: Id, input: Type.Unknown() }, { additionalProperties: false });
export const CapabilityEventSchema = Type.Object({ capabilityId: Id, topic: Id, payload: Type.Unknown() }, { additionalProperties: false });
export const CapabilityWorkerRequestSchema = Type.Object({ kind: Type.Literal("capability.run"), capabilityId: Id, operation: Id, requestId: Id, input: Type.Unknown() }, { additionalProperties: false });
export const CapabilityWorkerCancelSchema = Type.Object({ kind: Type.Literal("capability.cancel"), capabilityId: Id, operation: Id, requestId: Id }, { additionalProperties: false });
export const CapabilityWorkerEventSchema = Type.Object({ kind: Type.Literal("capability.event"), capabilityId: Id, operation: Id, requestId: Id, type: Type.Union([Type.Literal("progress"), Type.Literal("completed"), Type.Literal("failed"), Type.Literal("cancelled")]), payload: Type.Unknown() }, { additionalProperties: false });
export const CapabilityActivationRequestSchema = Type.Object({ kind: Type.Literal("capability.activate"), requestId: Id, capabilityId: Id, entry: Type.String({ minLength: 1 }) }, { additionalProperties: false });
export const CapabilityActivationReplySchema = Type.Object({ kind: Type.Literal("capability.activated"), requestId: Id, capabilityId: Id, ok: Type.Boolean() }, { additionalProperties: false });
export const CapabilityDeactivationSchema = Type.Object({ kind: Type.Literal("capability.deactivate"), requestId: Id, capabilityId: Id }, { additionalProperties: false });
export type CapabilityWorkerRequest = Static<typeof CapabilityWorkerRequestSchema>;
export type CapabilityWorkerEvent = Static<typeof CapabilityWorkerEventSchema>;
export type CapabilityWorkerCancel = Static<typeof CapabilityWorkerCancelSchema>;
export type CapabilityActivationRequest = Static<typeof CapabilityActivationRequestSchema>;
export type CapabilityActivationReply = Static<typeof CapabilityActivationReplySchema>;
export class CapabilityUnavailableError extends Error {
  readonly code = "capability_unavailable";
  constructor() { super("capability_unavailable"); }
}
