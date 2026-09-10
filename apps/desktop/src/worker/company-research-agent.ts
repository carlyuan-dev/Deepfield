import type {
  CompanyResearchWorkerEvent,
  CompanyResearchWorkerRequest,
} from "@deepfield/contracts";
import { buildCompanyResearchPrompt } from "./company-research-prompt.js";
import { buildCompanyResearchStructuringPrompt } from "./company-research-structuring-prompt.js";
import { researchFailure } from "./message-loop-types.js";

type FetchFn = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface CompanyResearchAgentOptions {
  fetchFn?: FetchFn;
}

export interface CompanyResearchAgent {
  run(
    request: CompanyResearchWorkerRequest,
    emit: (event: CompanyResearchWorkerEvent) => void,
    signal: AbortSignal,
  ): Promise<void>;
}

interface SseEvent {
  type?: unknown;
  delta?: unknown;
  response?: { status?: unknown };
}

function parseSseBlock(block: string): SseEvent | undefined {
  const data = block
    .split(/\r?\n/u)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");
  if (data.length === 0) return undefined;
  const parsed: unknown = JSON.parse(data);
  return typeof parsed === "object" && parsed !== null ? (parsed as SseEvent) : undefined;
}

export function createCompanyResearchAgent(
  options: CompanyResearchAgentOptions = {},
): CompanyResearchAgent {
  const fetchFn = options.fetchFn ?? globalThis.fetch.bind(globalThis);
  return {
    async run(request, emit, signal) {
      const identity = { requestId: request.requestId, runId: request.runId, stage: request.stage };
      let settled = false;
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      const settle = (event: CompanyResearchWorkerEvent): void => {
        if (settled) return;
        settled = true;
        emit(event);
      };
      let rejectAborted!: (error: Error) => void;
      const aborted = new Promise<never>((_resolve, reject) => { rejectAborted = reject; });
      // A pre-aborted signal can reject before the first race attaches.
      void aborted.catch(() => {});
      const onAbort = (): void => {
        settle({ ...identity, type: "cancelled" });
        rejectAborted(new Error("research cancelled"));
      };
      emit({ ...identity, type: "started" });
      signal.addEventListener("abort", onAbort, { once: true });
      try {
        if (signal.aborted) {
          onAbort();
          return;
        }
        const prompt = request.stage === "raw"
          ? buildCompanyResearchPrompt(request.context, request.template)
          : buildCompanyResearchStructuringPrompt(request);
        const fetching = fetchFn("https://api.deepseek.com/responses", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${request.apiKey}`,
          },
          body: JSON.stringify({
            model: request.modelId,
            instructions: prompt.instructions,
            input: [{ role: "user", content: prompt.input }],
            ...(request.stage === "raw"
              ? { tools: [{ type: "web_search" }], tool_choice: { type: "web_search" } }
              : { text: { format: { type: "json_object" } } }),
            max_output_tokens: 32768,
            stream: true,
          }),
          signal,
        });
        // If an injected/remote transport ignores abort, dispose its eventual body.
        void fetching.then((response) => {
          if (signal.aborted) void response.body?.cancel().catch(() => {});
        }, () => {});
        const response = await Promise.race([fetching, aborted]);
        if (response.body === null) throw new Error("research response failed");
        reader = response.body.getReader();
        if (!response.ok) throw new Error("research response failed");
        const decoder = new TextDecoder();
        let pending = "";
        let finalText = "";
        let completed = false;
        const consume = (block: string): void => {
          if (settled || completed) return;
          const event = parseSseBlock(block);
          if (event?.type === "response.output_text.delta" && typeof event.delta === "string") {
            finalText += event.delta;
            if (finalText.length > 1_000_000) throw new Error("research output too large");
            if (request.stage === "raw") emit({ ...identity, stage: "raw", type: "text_delta", delta: event.delta });
          } else if (event?.type === "response.completed") {
            if (event.response?.status !== "completed") throw new Error("research response not completed");
            completed = true;
          } else if (event?.type === "response.incomplete" || event?.type === "response.failed" || event?.type === "error") {
            throw new Error("research stream failed");
          }
        };
        while (!completed && !settled) {
          const part = await Promise.race([reader.read(), aborted]);
          pending += decoder.decode(part.value, { stream: !part.done });
          const blocks = pending.split(/\r?\n\r?\n/u);
          pending = blocks.pop() ?? "";
          for (const block of blocks) consume(block);
          if (part.done) {
            if (pending.trim().length > 0) consume(pending);
            break;
          }
        }
        if (signal.aborted) onAbort();
        else if (!completed || finalText.trim().length === 0) throw new Error("research output incomplete");
        else settle({ ...identity, type: "completed", text: finalText });
      } catch {
        if (signal.aborted) onAbort();
        else settle({ ...identity, type: "failed", ...researchFailure(request.stage) });
      } finally {
        signal.removeEventListener("abort", onAbort);
        // Never wait for a provider's cancel acknowledgement to finish a stage.
        if (reader) {
          void reader.cancel().catch(() => {});
          reader.releaseLock();
        }
      }
    },
  };
}
