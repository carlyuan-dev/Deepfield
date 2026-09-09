import type {
  CompanyResearchWorkerEvent,
  CompanyResearchWorkerRequest,
} from "@deepfield/contracts";
import { buildCompanyResearchPrompt } from "./company-research-prompt.js";

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
      const identity = { requestId: request.requestId, runId: request.runId };
      let settled = false;
      const settleFailed = (): void => {
        if (settled) return;
        settled = true;
        emit({
          ...identity,
          type: "failed",
          code: "research_failed",
          message: "company research failed",
        });
      };
      const settleCancelled = (): void => {
        if (settled) return;
        settled = true;
        emit({ ...identity, type: "cancelled" });
      };

      emit({ ...identity, type: "started" });
      if (signal.aborted) {
        settleCancelled();
        return;
      }

      const prompt = buildCompanyResearchPrompt(request.context);
      let response: Response;
      try {
        response = await fetchFn("https://api.deepseek.com/responses", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${request.apiKey}`,
          },
          body: JSON.stringify({
            model: request.modelId,
            instructions: prompt.instructions,
            input: [{ role: "user", content: prompt.input }],
            tools: [{ type: "web_search" }],
            tool_choice: { type: "web_search" },
            max_output_tokens: 32768,
            stream: true,
          }),
          signal,
        });
      } catch {
        if (signal.aborted) settleCancelled();
        else settleFailed();
        return;
      }
      if (!response.ok || response.body === null) {
        if (signal.aborted) settleCancelled();
        else settleFailed();
        return;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let pending = "";
      let finalText = "";
      let completed = false;

      const consume = (block: string): void => {
        const event = parseSseBlock(block);
        if (event?.type === "response.output_text.delta" && typeof event.delta === "string") {
          finalText += event.delta;
          emit({ ...identity, type: "text_delta", delta: event.delta });
          return;
        }
        if (event?.type === "response.completed" && event.response?.status === "completed") {
          completed = true;
          return;
        }
        if (event?.type === "response.incomplete" || event?.type === "response.failed") {
          throw new Error("research stream failed");
        }
      };

      try {
        while (true) {
          const part = await reader.read();
          pending += decoder.decode(part.value, { stream: !part.done });
          const blocks = pending.split(/\r?\n\r?\n/u);
          pending = blocks.pop() ?? "";
          for (const block of blocks) consume(block);
          if (part.done) break;
        }
        if (pending.trim().length > 0) consume(pending);
      } catch {
        if (signal.aborted) settleCancelled();
        else settleFailed();
        return;
      }

      if (signal.aborted) {
        settleCancelled();
        return;
      }
      if (!completed || finalText.trim().length === 0) {
        settleFailed();
        return;
      }
      settled = true;
      emit({ ...identity, type: "completed", text: finalText });
    },
  };
}
