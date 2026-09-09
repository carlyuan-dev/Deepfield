import type { AgentWorkerEvent, AgentWorkerRequest } from "@deepfield/contracts";
import type { ChatAgent } from "./message-loop.js";
import type { SkillCatalogProvider } from "./pi-chat-agent.js";
import {
  buildRuntimeSystemContext,
  type RuntimeSystemContextOptions,
} from "./runtime-system-context.js";

type FetchFn = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface DeepSeekWebSearchAgentOptions extends RuntimeSystemContextOptions {
  fetchFn?: FetchFn;
  skills?: SkillCatalogProvider;
}

export class DeepSeekWebSearchAgentError extends Error {
  constructor() {
    super("web search failed");
    this.name = "DeepSeekWebSearchAgentError";
  }
}

interface SseEvent {
  type?: unknown;
  delta?: unknown;
  response?: { status?: unknown };
}

function webSearchInstructions(
  base: string,
  runtimeContext: RuntimeSystemContextOptions,
): string {
  return [
    base,
    buildRuntimeSystemContext(runtimeContext),
    "本轮已启用联网搜索，web_search 工具可用。",
    "对话历史中关于联网能力不可用的旧表述只适用于过去轮次，不适用于本轮；不要把过去轮次的能力限制延续到本轮，也不要要求用户调整联网设置。",
    "用户需要最新或实时信息时，必须实际搜索后再回答。",
    "优先使用官网、官方机构和其他可靠且可追责来源；不要在最终回答中叙述搜索过程。",
    "在相关表述附近保留可直接访问的完整的 http/https 来源网址；没有材料支持的内容要明确说明。",
  ].join("\n");
}

function parseSseBlock(block: string): SseEvent | undefined {
  const data = block
    .split(/\r?\n/u)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");
  if (data.length === 0) {
    return undefined;
  }
  const parsed: unknown = JSON.parse(data);
  return typeof parsed === "object" && parsed !== null ? (parsed as SseEvent) : undefined;
}

async function promptFor(
  request: AgentWorkerRequest,
  skills: SkillCatalogProvider | undefined,
): Promise<string> {
  const skillName = request.options.skillName;
  if (skillName === undefined) {
    return request.prompt;
  }
  if (!skills) {
    throw new DeepSeekWebSearchAgentError();
  }
  try {
    return (await skills.get()).formatInvocation(skillName, request.prompt);
  } catch {
    throw new DeepSeekWebSearchAgentError();
  }
}

export function createDeepSeekWebSearchAgent(
  options: DeepSeekWebSearchAgentOptions = {},
): ChatAgent {
  const fetchFn = options.fetchFn ?? globalThis.fetch.bind(globalThis);
  return {
    async run(request, emit, signal) {
      if (signal.aborted) {
        throw new DeepSeekWebSearchAgentError();
      }
      const prompt = await promptFor(request, options.skills);
      emit({
        requestId: request.requestId,
        type: "started",
        webSearch: true,
        ...(request.options.skillName !== undefined
          ? { skillName: request.options.skillName }
          : {}),
      });
      const activity = {
        requestId: request.requestId,
        type: "tool_activity" as const,
        callKey: "web-search",
        name: "web_search",
      };
      let activitySettled = false;
      emit({ ...activity, status: "running" });
      const settleActivity = (status: "completed" | "failed"): void => {
        if (activitySettled) return;
        activitySettled = true;
        emit({ ...activity, status });
      };
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
            instructions: webSearchInstructions(request.context.systemPrompt, options),
            input: [
              ...request.context.messages.map((message) => ({
                role: message.role,
                content: message.content,
              })),
              { role: "user", content: prompt },
            ],
            tools: [{ type: "web_search" }],
            tool_choice: { type: "web_search" },
            reasoning: { effort: "low" },
            max_output_tokens: 4096,
            stream: true,
          }),
          signal,
        });
      } catch {
        settleActivity("failed");
        throw new DeepSeekWebSearchAgentError();
      }
      if (!response.ok || response.body === null) {
        settleActivity("failed");
        throw new DeepSeekWebSearchAgentError();
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
          emit({ requestId: request.requestId, type: "text_delta", delta: event.delta });
          return;
        }
        if (event?.type === "response.completed" && event.response?.status === "completed") {
          completed = true;
          return;
        }
        if (event?.type === "response.failed" || event?.type === "response.incomplete") {
          throw new DeepSeekWebSearchAgentError();
        }
      };

      try {
        while (true) {
          const part = await reader.read();
          pending += decoder.decode(part.value, { stream: !part.done });
          const blocks = pending.split(/\r?\n\r?\n/u);
          pending = blocks.pop() ?? "";
          for (const block of blocks) {
            consume(block);
          }
          if (part.done) {
            break;
          }
        }
        if (pending.trim().length > 0) {
          consume(pending);
        }
      } catch {
        settleActivity("failed");
        throw new DeepSeekWebSearchAgentError();
      }

      if (!completed || finalText.trim().length === 0) {
        settleActivity("failed");
        throw new DeepSeekWebSearchAgentError();
      }
      settleActivity("completed");
      emit({ requestId: request.requestId, type: "completed", text: finalText });
    },
  };
}

export function routeWebSearchChatAgent(plain: ChatAgent, webSearch: ChatAgent): ChatAgent {
  return {
    run(request, emit, signal) {
      return (request.options.webSearch ? webSearch : plain).run(request, emit, signal);
    },
  };
}
