import { PiModelGateway as BasePiModelGateway, type ModelGatewayFactories } from "@deepfield/base/model/runtime";
import type { ModelGateway as BaseModelGateway } from "@deepfield/base/model";
import type { ModelToolOrigin } from "@deepfield/capability-sdk";
import { modelUsagePort, snapshotIdentity } from "./usage-collection.js";
export { ModelGatewayError, classifyModelGatewayError } from "@deepfield/base/model";
export type { ModelCompletionOptions, ModelCompletionResult, ModelGatewayErrorCategory } from "@deepfield/base/model";
export type ModelGateway = BaseModelGateway<ModelToolOrigin, "ordinary" | "synthesis">;

/** Process-local assembly shared by main, Chat workers and Capability execution. */
export class PiModelGateway extends BasePiModelGateway<ModelToolOrigin, "ordinary" | "synthesis"> {
  constructor(factories?: ModelGatewayFactories) { super({ usage: modelUsagePort, snapshotIdentity }, factories); }
}
