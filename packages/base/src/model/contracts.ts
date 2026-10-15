import type { Api, Context, Model, Tool, AssistantMessageEventStream, SimpleStreamOptions } from "@earendil-works/pi-ai";
import type { LlmRuntimeSnapshot } from "../config/llm.js";
import type { ModelRequestObserver, ModelRequestObservationInput } from "./observation.js";
import type { ModelGatewayError } from "./errors.js";

export interface ObservedStreamOptions<Origin, Phase extends string> extends SimpleStreamOptions { requestObservation?: ModelRequestObservationInput<Origin, Phase> }
export type ModelStream<Origin, Phase extends string> = <TApi extends Api>(model: Model<TApi>, context: Context, options?: ObservedStreamOptions<Origin, Phase>) => AssistantMessageEventStream;

export interface ModelDiagnostic { httpStatus: number; reason: "unknown" | "auth" | "rate_limit" | "context" | "invalid_tool_schema"; toolIndex?: number; rootObjectRequired?: true }

export interface ModelCompletionOptions { maxTokens: number; tools?: readonly Tool[] }

export interface ModelGateway<Origin = unknown, Phase extends string = string> {
  createStream?(snapshot: LlmRuntimeSnapshot, observer?: ModelRequestObserver<Origin, Phase>, onModelFailure?: (error: ModelGatewayError) => void): ModelStream<Origin, Phase>;
  createModel(snapshot: LlmRuntimeSnapshot): Model<any>;
  getApiKey(snapshot: LlmRuntimeSnapshot, providerId: string): Promise<string>;
  completeText(
    snapshot: LlmRuntimeSnapshot,
    system: string,
    prompt: string,
    signal?: AbortSignal,
    options?: ModelCompletionOptions,
  ): Promise<string>;
  completeTextResult?(
    snapshot: LlmRuntimeSnapshot,
    system: string,
    prompt: string,
    signal?: AbortSignal,
    options?: ModelCompletionOptions,
  ): Promise<ModelCompletionResult>;
}

export interface ModelCompletionResult {
  text: string;
  stopReason: "stop" | "length" | "tool_use" | "error" | "aborted" | "unknown";
}
