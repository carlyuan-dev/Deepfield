import {
  createModels,
  createProvider,
  type Api,
  type Model,
  type MutableModels,
  type Provider,
  type ProviderStreams,
} from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import type { LlmRuntimeSnapshot } from "@deepfield/contracts";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import { createLlmUsageTransport } from "./usage-collection.js";
import type { ModelRequestObserver } from "@deepfield/capability-sdk";
import { observeSerializedRequest, type ObservedStreamOptions } from "./model-request-observation.js";

export interface ModelGateway {
  createStream?(snapshot: LlmRuntimeSnapshot, observer?: ModelRequestObserver): typeof streamSimple;
  createModel(snapshot: LlmRuntimeSnapshot): Model<any>;
  getApiKey(snapshot: LlmRuntimeSnapshot, providerId: string): Promise<string>;
  completeText(
    snapshot: LlmRuntimeSnapshot,
    system: string,
    prompt: string,
    signal?: AbortSignal,
    options?: { maxTokens: number },
  ): Promise<string>;
  completeTextResult?(
    snapshot: LlmRuntimeSnapshot,
    system: string,
    prompt: string,
    signal?: AbortSignal,
    options?: { maxTokens: number },
  ): Promise<ModelCompletionResult>;
}

export interface ModelCompletionResult {
  text: string;
  stopReason: "stop" | "length" | "tool_use" | "error" | "aborted" | "unknown";
}

interface ModelGatewayFactories {
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

export type ModelGatewayErrorCategory = "authentication" | "rate_limit" | "server" | "network" | "timeout" | "request" | "context_budget" | "unknown";

export class ModelGatewayError extends Error {
  constructor(
    readonly category: ModelGatewayErrorCategory = "unknown",
    readonly retryable = false,
  ) {
    super("model request failed");
    this.name = "ModelGatewayError";
  }
}

export function classifyModelGatewayError(error: unknown): ModelGatewayError {
  if (error instanceof ModelGatewayError) return error;
  if (typeof error !== "object" || error === null) return new ModelGatewayError();
  const record = error as Record<string, unknown>;
  if (typeof record.message === "string" && /context[_ ]?(?:length|window)|maximum context|too many tokens|prompt is too long/i.test(record.message)) return new ModelGatewayError("context_budget", false);
  const status = typeof record.status === "number"
    ? record.status
    : typeof record.statusCode === "number" ? record.statusCode : undefined;
  if (status === 401 || status === 403) return new ModelGatewayError("authentication", false);
  if (status === 429) return new ModelGatewayError("rate_limit", true);
  if (status !== undefined && status >= 500 && status <= 599) return new ModelGatewayError("server", true);
  if (status !== undefined && status >= 400 && status <= 499) return new ModelGatewayError("request", false);
  if (record.name === "AbortError" || record.name === "TimeoutError") return new ModelGatewayError("timeout", true);
  const retryableNetworkCodes = new Set(["ECONNRESET", "ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH", "ETIMEDOUT", "EAI_AGAIN"]);
  if (typeof record.code === "string" && retryableNetworkCodes.has(record.code)) {
    return new ModelGatewayError("network", true);
  }
  if (typeof record.cause === "object" && record.cause !== null) {
    const causeCode = (record.cause as Record<string, unknown>).code;
    if (typeof causeCode === "string" && retryableNetworkCodes.has(causeCode)) {
      return new ModelGatewayError("network", true);
    }
  }
  return new ModelGatewayError();
}

export class PiModelGateway implements ModelGateway {
  constructor(private readonly factories: ModelGatewayFactories = defaultFactories) {}

  createModel(snapshot: LlmRuntimeSnapshot): Model<any> {
    return this.createSession(snapshot).model;
  }

  createStream(snapshot: LlmRuntimeSnapshot, observer?: ModelRequestObserver): typeof streamSimple {
    return (model, context, options) => {
      const usage = createLlmUsageTransport(snapshot, options?.signal, options?.fetch ?? globalThis.fetch);
      const observation = observer ? observeSerializedRequest(context, options as ObservedStreamOptions, observer, usage.fetch) : undefined;
      const stream = streamSimple(model, context, { ...options, maxRetries: 0, fetch: usage.fetch, ...(observation ? { onPayload: observation.onPayload, fetch: observation.fetch } : {}) });
      const finished = stream.result().then((message) => { usage.finish(message.stopReason); observation?.finish(message.stopReason); return message; }, error => { usage.finish("error"); observation?.finish("error"); throw error; });
      // Pi represents provider failures as messages; observer/storage failures
      // must still reject the execution result instead of appearing successful.
      if (observation) stream.result = () => finished;
      void finished.catch(() => undefined);
      return stream;
    };
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
  ): Promise<string> {
    return (await this.completeTextResult(snapshot, system, prompt, signal)).text;
  }

  async completeTextResult(
    snapshot: LlmRuntimeSnapshot,
    system: string,
    prompt: string,
    signal?: AbortSignal,
    options?: { maxTokens: number },
  ): Promise<ModelCompletionResult> {
    const usage = createLlmUsageTransport(snapshot, signal);
    let transportFailure: ModelGatewayError | undefined;
    const captureFetch: typeof globalThis.fetch = async (input, init) => {
      try {
        const response = await usage.fetch(input, init);
        if (!response.ok) transportFailure = classifyModelGatewayError({ status: response.status, message: (await response.clone().text()).slice(0, 8192) });
        return response;
      } catch (error) {
        transportFailure = classifyModelGatewayError(error);
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
        },
        {
          apiKey: await this.getApiKey(snapshot, model.provider),
          ...(signal === undefined ? {} : { signal }),
          fetch: captureFetch,
          maxRetries: 0,
          maxTokens: options?.maxTokens ?? Math.min(8192, Math.max(1024, Math.floor(snapshot.contextWindow / 8))),
        },
      );
      usage.finish(message.stopReason);
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
      usage.finish(signal?.aborted ? "aborted" : "error");
      throw classifyModelGatewayError(error);
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
