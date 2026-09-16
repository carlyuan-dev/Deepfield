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

const TITLE_MAX_LENGTH = 28;

export class CompanyRecognitionError extends Error {
  constructor() { super("company recognition failed"); this.name = "CompanyRecognitionError"; }
}

export function normalizeConversationTitle(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const firstLine = value.split(/\r?\n/, 1)[0]?.trim();
  if (!firstLine) return undefined;
  const normalized = firstLine
    .replace(/^(?:标题|题目|title)\s*[:：]\s*/i, "")
    .replace(/^[「『“"'`]+|[」』”"'`]+$/g, "")
    .trim()
    .replace(/\s+/g, " ");
  if (!normalized) return undefined;
  const characters = Array.from(normalized);
  return characters.length <= TITLE_MAX_LENGTH
    ? normalized
    : `${characters.slice(0, TITLE_MAX_LENGTH).join("")}…`;
}

export class ConfiguredLlmService implements ConversationTitleGenerator, CompanyRecognizer {
  constructor(
    private readonly resolveActiveLlm: () => Promise<LlmRuntimeSnapshot>,
    private readonly gateway: ModelGateway,
  ) {}

  async checkConnection(): Promise<"connected" | "disconnected"> {
    try {
      const snapshot = await this.resolveActiveLlm();
      await this.gateway.completeText(snapshot, "只回复 OK。", "connection check");
      return "connected";
    } catch {
      return "disconnected";
    }
  }

  async generateConversationTitle(content: string): Promise<string | undefined> {
    try {
      const snapshot = await this.resolveActiveLlm();
      const text = await this.gateway.completeText(
        snapshot,
        "请将用户的首条消息概括为一个简短中文标题，建议 6–16 字，不加引号，不要输出解释。",
        content.slice(0, 2000),
      );
      return normalizeConversationTitle(text);
    } catch {
      return undefined;
    }
  }

  async recognize(text: string): Promise<CompanyDraft[]> {
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
