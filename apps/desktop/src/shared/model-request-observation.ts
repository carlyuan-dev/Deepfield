import type { ModelToolOrigin } from "@deepfield/capability-sdk";
import { observeSerializedRequest as baseObserveSerializedRequest } from "@deepfield/base/model/runtime";
import type { ObservedStreamOptions as BaseObservedStreamOptions } from "@deepfield/base/model";
export type ObservedStreamOptions = BaseObservedStreamOptions<ModelToolOrigin, "ordinary" | "synthesis">;
export const observeSerializedRequest = baseObserveSerializedRequest<ModelToolOrigin, "ordinary" | "synthesis">;
