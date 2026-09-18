import {
  CompanyDraftSchema,
  RECOGNITION_CHUNK_MAX_CODE_POINTS,
  countUnicodeCodePoints,
  type CompanyDraft,
  type LlmRuntimeSnapshot,
} from "@deepfield/contracts";
import type {
  CompanyRecognizer,
  ConversationTitleGenerator,
} from "@deepfield/application";
import { normalizeCompanyName } from "@deepfield/persistence";
import { Value } from "typebox/value";
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

export class CompanyRecognitionError extends Error {
  constructor() { super("company recognition failed"); this.name = "CompanyRecognitionError"; }
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

export class ConfiguredLlmService implements ConversationTitleGenerator, CompanyRecognizer {
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

  recognize(text: string): Promise<CompanyDraft[]> {
    return withUsageContext({ sourceId: "company-recognition" }, () => this.recognizeNames(text));
  }

  private async recognizeNames(text: string): Promise<CompanyDraft[]> {
    if (countUnicodeCodePoints(text) > RECOGNITION_CHUNK_MAX_CODE_POINTS) {
      throw new CompanyRecognitionError();
    }
    let snapshot: LlmRuntimeSnapshot;
    try { snapshot = await this.resolveActiveLlm(); }
    catch { throw new CompanyRecognitionError(); }
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const output = await this.gateway.completeText(
          snapshot,
          '只提取用户输入中出现或明确指代的公司，不搜索、不自行补充外部公司。每一项只返回公司实体本身的名称，忽略括号内的产品、型号、业务、旧称等说明，例如“阿里（千问 AI 眼镜）”返回“阿里”，“XREAL（原 Nreal）”返回“XREAL”；只有括号确实属于公司正式名称时才保留。只返回公司名称，不返回国家、地区、备注或任何公司资料。只返回 JSON，不要 Markdown 或解释，格式为 {"names":["公司名称"]}。',
          text,
        );
        const parsed: unknown = JSON.parse(output);
        if (typeof parsed !== "object" || parsed === null) continue;
        const record = parsed as Record<string, unknown>;
        const candidates = Array.isArray(record.names)
          ? record.names
          : Array.isArray(record.companies)
            ? record.companies.map((item) => typeof item === "object" && item !== null
              ? (item as Record<string, unknown>).name
              : undefined)
            : undefined;
        if (!candidates) continue;
        const seen = new Set<string>();
        const drafts: CompanyDraft[] = [];
        for (const candidate of candidates) {
          if (typeof candidate !== "string") continue;
          const draft = { name: candidate.trim() };
          if (!Value.Check(CompanyDraftSchema, draft)) continue;
          const normalized = normalizeCompanyName(draft.name);
          if (!normalized || seen.has(normalized)) continue;
          seen.add(normalized);
          drafts.push(draft);
        }
        return drafts;
      } catch {
        // Retry once for malformed, empty, or unavailable output.
      }
    }
    throw new CompanyRecognitionError();
  }

}
