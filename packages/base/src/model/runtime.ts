import {
  createModels,
  createProvider,
  type Api,
  type Model,
  type MutableModels,
  type Provider,
  type ProviderStreams,
  type Tool,
} from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import type { LlmRuntimeSnapshot } from "../config/llm.js";
import type { ModelUsagePort } from "../usage/contracts.js";
import { ModelGatewayError, classifyModelGatewayError } from "./errors.js";
import type { ModelGateway, ModelCompletionOptions, ModelCompletionResult, ModelStream } from "./contracts.js";
import { classifyModelHttpDiagnostic, readModelErrorPrefix } from "./http-diagnostic.js";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import { createLlmUsageTransport } from "./llm-usage-transport.js";
import type { ModelRequestObserver } from "./observation.js";
import { observeSerializedRequest } from "./request-observation.js";
import { captureTraceContent } from "../trace/content-runtime.js";
import { currentTrace } from "../trace/runtime.js";
import { traceModelStream, traceModelCompletion } from "./trace.js";
export { traceModelStream } from "./trace.js";
export { createLlmUsageTransport } from "./llm-usage-transport.js";
export { classifyModelHttpDiagnostic, readModelErrorPrefix } from "./http-diagnostic.js";
export { observeSerializedRequest } from "./request-observation.js";

export interface ModelGatewayFactories {
  createModels: typeof createModels;
  createProvider: typeof createProvider;
  openAICompletionsApi: typeof openAICompletionsApi;
  anthropicMessagesApi: typeof anthropicMessagesApi;
}

const defaultFactories: ModelGatewayFactories = {
  createModels,
  createProvider,
  openAICompletionsApi,
  anthropicMessagesApi,
};

export interface ModelRequestAssociation {
  readonly requestId?: string;
  readonly modelRequestId?: string;
  readonly operationId: string;
  readonly attemptId: string;
}
export interface ModelRuntimeOptions {
  usage: ModelUsagePort;
  snapshotIdentity(snapshot: object): object;
  /** Best-effort internal correlation after fetch starts; failures do not affect execution or imply durable delivery. */
  onRequestAttempt?(association: ModelRequestAssociation): void;
}

export class PiModelGateway<Origin = unknown, Phase extends string = string> implements ModelGateway<Origin, Phase> {
  constructor(private readonly runtime: ModelRuntimeOptions, private readonly factories: ModelGatewayFactories = defaultFactories) {}

  createModel(snapshot: LlmRuntimeSnapshot): Model<any> {
    return this.createSession(snapshot).model;
  }

  createStream(snapshot: LlmRuntimeSnapshot, observer?: ModelRequestObserver<Origin, Phase>, onModelFailure?: (error: ModelGatewayError) => void): ModelStream<Origin, Phase> {
    const streamModel: ModelStream<Origin, Phase> = (model, context, options) => {
      const contentScope = currentTrace();
      let transportFailure: ModelGatewayError | undefined;
      const usage = createLlmUsageTransport(this.runtime, snapshot, options?.signal, options?.fetch ?? globalThis.fetch, undefined, () => observation?.identity, error => { transportFailure = error; });
      const observation = observer ? observeSerializedRequest(context, options, observer, usage.fetch, contentScope?.modelRequestId) : undefined;
      const responseDraft = () => ({ kind: "model.response" as const, source: "pi.assistant_message" as const, ...(observation?.identity.modelRequestId ? { modelRequestId: observation.identity.modelRequestId } : {}) });
      const stream = streamSimple(model, context, { ...options, maxRetries: 0, fetch: usage.fetch, ...(observation ? { onPayload: observation.onPayload, fetch: observation.fetch } : {}) });
      const finished = stream.result().then((message) => {
        captureTraceContent(responseDraft(), () => ({ content: message.content, stopReason: message.stopReason }), { secrets: [snapshot.apiKey], ...(message.stopReason === "error" || message.stopReason === "aborted" ? { incomplete: options?.signal?.aborted ? "cancelled" as const : "execution_failed" as const } : {}) }, contentScope);
        usage.finish(message.stopReason);
        observation?.finish(message.stopReason);
        if (!options?.signal?.aborted && transportFailure && (message.stopReason === "error" || message.stopReason === "aborted")) onModelFailure?.(transportFailure);
        return message;
      }, error => { captureTraceContent(responseDraft(), () => undefined, { incomplete: options?.signal?.aborted ? "cancelled" : "execution_failed" }, contentScope); usage.finish("error"); observation?.finish("error"); throw error; });
      // Pi represents provider failures as messages; observer/storage failures
      // must still reject the execution result instead of appearing successful.
      stream.result = () => finished;
      void finished.catch(() => undefined);
      return stream;
    };
    return traceModelStream(streamModel);
  }

  async getApiKey(snapshot: LlmRuntimeSnapshot, providerId: string): Promise<string> {
    if (providerId !== this.providerId(snapshot)) throw new ModelGatewayError();
    return snapshot.apiKey;
  }

  async completeText(
    snapshot: LlmRuntimeSnapshot,
    system: string,
    prompt: string,
    signal?: AbortSignal,
    options?: ModelCompletionOptions,
  ): Promise<string> {
    return (await this.completeTextResult(snapshot, system, prompt, signal, options)).text;
  }

  async completeTextResult(
    snapshot: LlmRuntimeSnapshot,
    system: string,
    prompt: string,
    signal?: AbortSignal,
    options?: ModelCompletionOptions,
  ): Promise<ModelCompletionResult> {
    return traceModelCompletion(signal, () => this.completeTextInScope(snapshot, system, prompt, signal, options));
  }

  private async completeTextInScope(snapshot: LlmRuntimeSnapshot, system: string, prompt: string, signal?: AbortSignal, options?: ModelCompletionOptions): Promise<ModelCompletionResult> {
    const contentScope = currentTrace();
    let responseCaptured = false;
    let transportFailure: ModelGatewayError | undefined;
    const usage = createLlmUsageTransport(this.runtime, snapshot, signal, globalThis.fetch, undefined, undefined, error => { transportFailure = error; });
    const captureFetch: typeof globalThis.fetch = async (input, init) => {
      try {
        const response = await usage.fetch(input, init);
        if (!response.ok) {
          const prefix = await readModelErrorPrefix(response, signal);
          const classified = classifyModelGatewayError({ status: response.status, message: prefix });
          transportFailure = new ModelGatewayError(classified.category, classified.retryable,
            classifyModelHttpDiagnostic(response.status, prefix, options?.tools?.map(tool => tool.name) ?? []));
        }
        return response;
      } catch (error) {
        transportFailure ??= classifyModelGatewayError(error);
        throw error;
      }
    };
    try {
      const { models, model } = this.createSession(snapshot);
      const message = await models.completeSimple(
        model,
        {
          systemPrompt: system,
          messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
          ...(options?.tools ? { tools: [...options.tools] } : {}),
        },
        {
          apiKey: await this.getApiKey(snapshot, model.provider),
          ...(signal === undefined ? {} : { signal }),
          fetch: captureFetch,
          maxRetries: 0,
          maxTokens: options?.maxTokens ?? Math.min(8192, Math.max(1024, Math.floor(snapshot.contextWindow / 8))),
        },
      );
      responseCaptured = true;
      captureTraceContent({ kind: "model.response", source: "pi.assistant_message" }, () => ({ content: message.content, stopReason: message.stopReason }), { secrets: [snapshot.apiKey], ...(message.stopReason === "error" || message.stopReason === "aborted" ? { incomplete: signal?.aborted ? "cancelled" as const : "execution_failed" as const } : {}) }, contentScope);
      usage.finish(message.stopReason);
      if (signal?.aborted) throw new ModelGatewayError("timeout", true);
      if (message.stopReason === "error") {
        throw transportFailure ?? new ModelGatewayError();
      }
      if (message.stopReason === "aborted") {
        throw transportFailure ?? new ModelGatewayError("timeout", true);
      }
      const text = message.content
        .filter((content): content is Extract<typeof content, { type: "text" }> => content.type === "text")
        .map((content) => content.text)
        .join("");
      const stopReason: ModelCompletionResult["stopReason"] = message.stopReason === "toolUse"
        ? "tool_use"
        : message.stopReason === "stop" || message.stopReason === "length" ? message.stopReason : "unknown";
      return { text, stopReason };
    } catch (error) {
      if (!responseCaptured) captureTraceContent({ kind: "model.response", source: "pi.assistant_message" }, () => undefined, { incomplete: signal?.aborted ? "cancelled" : "execution_failed" }, contentScope);
      usage.finish(signal?.aborted ? "aborted" : "error");
      throw signal?.aborted ? new ModelGatewayError("timeout", true) : classifyModelGatewayError(error);
    }
  }

  private providerId(snapshot: LlmRuntimeSnapshot): string {
    return `deepfield-${snapshot.id}`;
  }

  private createSession(snapshot: LlmRuntimeSnapshot): {
    models: MutableModels;
    model: Model<Api>;
  } {
    const providerId = this.providerId(snapshot);
    const api = snapshot.protocol === "anthropic_messages"
      ? "anthropic-messages"
      : "openai-completions";
    const isDeepSeek = snapshot.provider === "deepseek" && api === "openai-completions";
    const model: Model<typeof api> = {
      id: snapshot.modelId,
      name: snapshot.name,
      provider: providerId,
      baseUrl: snapshot.baseUrl,
      api,
      // Pi needs controllable reasoning metadata to serialize the current off policy.
      reasoning: isDeepSeek,
      ...(isDeepSeek ? {
        compat: {
          thinkingFormat: "deepseek" as const,
          supportsStore: false,
          supportsDeveloperRole: false,
          maxTokensField: "max_tokens" as const,
          requiresReasoningContentOnAssistantMessages: true,
        },
      } : {}),
      input: ["text"],
      contextWindow: snapshot.contextWindow,
      maxTokens: Math.min(8192, Math.max(1024, Math.floor(snapshot.contextWindow / 8))),
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    };
    const provider = this.factories.createProvider({
      id: providerId,
      name: snapshot.name,
      baseUrl: snapshot.baseUrl,
      auth: {
        apiKey: {
          name: `${snapshot.name} API key`,
          resolve: async () => ({ auth: { apiKey: snapshot.apiKey } }),
        },
      },
      models: [model],
      api: (snapshot.protocol === "anthropic_messages"
        ? this.factories.anthropicMessagesApi()
        : this.factories.openAICompletionsApi()) as ProviderStreams,
    }) as Provider;
    const models = this.factories.createModels();
    models.setProvider(provider);
    return { models, model };
  }
}
