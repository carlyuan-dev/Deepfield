import { type LlmRuntimeSnapshot } from "@deepfield/contracts";
import type {
  ConversationTitleGenerator,
} from "@deepfield/application";
import type { ModelGateway } from "../shared/model-gateway.js";
import { ModelGatewayError } from "../shared/model-gateway.js";
import { withUsageContext } from "../shared/usage-collection.js";

const TITLE_MAX_LENGTH = 24;
const TITLE_INPUT_MAX_LENGTH = 1000;
const TITLE_TIMEOUT_MS = 20_000;

export interface TitleGenerationDiagnostic {
  category: "configuration" | "request_retry" | "request_failed" | "timeout" | "invalid_output";
}

export interface ConfiguredLlmServiceOptions {
  titleTimeoutMs?: number;
  onTitleDiagnostic?: (diagnostic: TitleGenerationDiagnostic) => void;
}


export function normalizeConversationTitle(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const lines = value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length !== 1) return undefined;
  const firstLine = lines[0];
  if (!firstLine) return undefined;
  if (
    /^```|```$/u.test(firstLine) ||
    /^(?:\[|\{).*(?:\]|\})$/u.test(firstLine) ||
    /^(?:\*\*|__|#{1,6}\s|[-*+]\s).*(?:\*\*|__)?$/u.test(firstLine) ||
    /^<[^>]+>.*<\/[^>]+>$/u.test(firstLine) ||
    /^(?:下面|以下|这是).{0,8}(?:标题|题目)\s*[:：]/u.test(firstLine) ||
    /^作为.{0,4}(?:AI|模型)/iu.test(firstLine)
  ) return undefined;
  const normalized = firstLine
    .replace(/^(?:标题|题目|title)\s*[:：]\s*/i, "")
    .replace(/^[「『“"'`]+|[」』”"'`]+$/g, "")
    .trim()
    .replace(/\s+/g, " ");
  if (!normalized) return undefined;
  const characters = Array.from(normalized);
  if (characters.length === 0 || characters.length > TITLE_MAX_LENGTH) return undefined;
  return normalized;
}

export class ConfiguredLlmService implements ConversationTitleGenerator {
  constructor(
    private readonly resolveActiveLlm: () => Promise<LlmRuntimeSnapshot>,
    private readonly gateway: ModelGateway,
    private readonly options: ConfiguredLlmServiceOptions = {},
  ) {}

  async checkConnection(): Promise<"connected" | "disconnected"> {
    try {
      const snapshot = await this.resolveActiveLlm();
      await withUsageContext({ sourceId: "connection-check" }, () => this.gateway.completeText(snapshot, "只回复 OK。", "connection check"));
      return "connected";
    } catch {
      return "disconnected";
    }
  }

  generateConversationTitle(content: string): Promise<string | undefined> {
    return withUsageContext({ sourceId: "conversation-title" }, () => this.generateTitle(content));
  }

  private async generateTitle(content: string): Promise<string | undefined> {
    let snapshot: LlmRuntimeSnapshot;
    try {
      snapshot = await this.resolveActiveLlm();
    } catch {
      this.reportTitleDiagnostic("configuration");
      return undefined;
    }
    const prompt = Array.from(content).slice(0, TITLE_INPUT_MAX_LENGTH).join("");
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const text = await this.completeTitleWithTimeout(snapshot, prompt);
        const normalized = normalizeConversationTitle(text);
        if (normalized === undefined) this.reportTitleDiagnostic("invalid_output");
        return normalized;
      } catch (error) {
        const timedOut = error instanceof Error && error.name === "AbortError";
        const retryable = timedOut || (error instanceof ModelGatewayError && error.retryable);
        if (attempt === 0 && retryable) {
          this.reportTitleDiagnostic("request_retry");
          continue;
        }
        this.reportTitleDiagnostic(timedOut ? "timeout" : "request_failed");
        return undefined;
      }
    }
    return undefined;
  }

  private async completeTitleWithTimeout(snapshot: LlmRuntimeSnapshot, prompt: string): Promise<string> {
    const controller = new AbortController();
    const timeoutMs = this.options.titleTimeoutMs ?? TITLE_TIMEOUT_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        const error = new Error("title generation timed out"); error.name = "AbortError"; reject(error);
      }, timeoutMs);
    });
    try {
      return await Promise.race([
        this.gateway.completeText(
          snapshot,
          "请将用户首条消息概括为简短中文标题。只输出 6–16 个汉字，保留主题和意图，删除“请帮我”等请求套话；不要使用工具或搜索，不加引号、标点或解释。",
          prompt,
          controller.signal,
        ),
        timeout,
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  private reportTitleDiagnostic(category: TitleGenerationDiagnostic["category"]): void {
    try { this.options.onTitleDiagnostic?.({ category }); } catch { /* Diagnostics are best-effort. */ }
  }

}
