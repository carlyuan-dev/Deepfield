import {
  CompanyDraftSchema,
  DEFAULT_DEEPSEEK_MODEL_ID,
  RECOGNITION_CHUNK_MAX_CODE_POINTS,
  countUnicodeCodePoints,
  type CompanyDraft,
} from "@deepfield/contracts";
import type {
  CompanyRecognizer,
  ConversationTitleGenerator,
  SecretReader,
} from "@deepfield/application";
import { normalizeCompanyName } from "@deepfield/persistence";
import { Value } from "typebox/value";

export type DeepSeekConnectionStatus = "connected" | "disconnected";

interface DeepSeekServiceOptions {
  fetch?: typeof fetch;
  timeoutMs?: number;
  enabled?: boolean;
}

const DEEPSEEK_BASE_URL = "https://api.deepseek.com";
const DEFAULT_TIMEOUT_MS = 7000;
const COMPANY_RECOGNITION_TIMEOUT_MS = 20_000;
const TITLE_MAX_LENGTH = 28;

export class CompanyRecognitionError extends Error {
  constructor() {
    super("company recognition failed");
    this.name = "CompanyRecognitionError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function normalizeConversationTitle(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const firstLine = value.split(/\r?\n/, 1)[0]?.trim();
  if (firstLine === undefined || firstLine.length === 0) {
    return undefined;
  }
  const withoutPrefix = firstLine.replace(/^(?:标题|题目|title)\s*[:：]\s*/i, "").trim();
  const withoutQuotes = withoutPrefix.replace(/^[「『“"'`]+|[」』”"'`]+$/g, "");
  const normalized = withoutQuotes.trim().replace(/\s+/g, " ");
  if (normalized.length === 0) {
    return undefined;
  }
  const characters = Array.from(normalized);
  return characters.length <= TITLE_MAX_LENGTH
    ? normalized
    : `${characters.slice(0, TITLE_MAX_LENGTH).join("")}…`;
}

export class DeepSeekService implements ConversationTitleGenerator, CompanyRecognizer {
  private readonly fetchImpl: typeof fetch | undefined;
  private readonly timeoutMs: number;
  private readonly enabled: boolean;

  constructor(
    private readonly secrets: SecretReader,
    options: DeepSeekServiceOptions = {},
  ) {
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.enabled = options.enabled ?? true;
  }

  async checkConnection(): Promise<DeepSeekConnectionStatus> {
    const response = await this.request("/models", { method: "GET" });
    if (response === undefined || response.status !== 200) {
      return "disconnected";
    }
    try {
      const body: unknown = await response.json();
      if (!isRecord(body) || !Array.isArray(body.data)) {
        return "disconnected";
      }
      return body.data.some(
        (model) => isRecord(model) && model.id === DEFAULT_DEEPSEEK_MODEL_ID,
      )
        ? "connected"
        : "disconnected";
    } catch {
      return "disconnected";
    }
  }

  async generateConversationTitle(content: string): Promise<string | undefined> {
    const response = await this.request("/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: DEFAULT_DEEPSEEK_MODEL_ID,
        messages: [
          {
            role: "system",
            content: "请将用户的首条消息概括为一个简短中文标题，建议 6–16 字，不加引号，不要输出解释。",
          },
          { role: "user", content: content.slice(0, 2000) },
        ],
        stream: false,
        max_tokens: 32,
      }),
    });
    if (response === undefined || response.status !== 200) {
      return undefined;
    }
    try {
      const body: unknown = await response.json();
      const contentValue =
        isRecord(body) && Array.isArray(body.choices) && isRecord(body.choices[0])
          ? body.choices[0].message
          : undefined;
      const generated = isRecord(contentValue) ? contentValue.content : undefined;
      return normalizeConversationTitle(generated);
    } catch {
      return undefined;
    }
  }

  async recognize(text: string): Promise<CompanyDraft[]> {
    if (countUnicodeCodePoints(text) > RECOGNITION_CHUNK_MAX_CODE_POINTS) {
      throw new CompanyRecognitionError();
    }
    const response = await this.request("/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: DEFAULT_DEEPSEEK_MODEL_ID,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content:
              '只提取输入中出现或明确指代的公司，不自行补充公司。note 仅保留一句极简候选备注。只返回 JSON，不要 Markdown 或解释，格式为 {"companies":[{"name":"公司名称","countryOrRegion":"可选","note":"可选的一句候选备注"}]}。',
          },
          { role: "user", content: text },
        ],
        stream: false,
        max_tokens: 2048,
      }),
    }, COMPANY_RECOGNITION_TIMEOUT_MS);
    if (response === undefined || response.status !== 200) {
      throw new CompanyRecognitionError();
    }

    try {
      const body: unknown = await response.json();
      const message =
        isRecord(body) && Array.isArray(body.choices) && isRecord(body.choices[0])
          ? body.choices[0].message
          : undefined;
      const contentValue = isRecord(message) ? message.content : undefined;
      if (typeof contentValue !== "string") {
        throw new CompanyRecognitionError();
      }
      const parsed: unknown = JSON.parse(contentValue);
      if (!isRecord(parsed) || !Array.isArray(parsed.companies)) {
        throw new CompanyRecognitionError();
      }
      const seen = new Set<string>();
      const drafts: CompanyDraft[] = [];
      for (const candidate of parsed.companies) {
        if (!isRecord(candidate) || typeof candidate.name !== "string") {
          continue;
        }
        const name = candidate.name.trim();
        if (name.length === 0) {
          continue;
        }
        const countryOrRegion =
          typeof candidate.countryOrRegion === "string"
            ? candidate.countryOrRegion.trim()
            : undefined;
        const note = typeof candidate.note === "string" ? candidate.note.trim() : undefined;
        const draft: CompanyDraft = {
          name,
          ...(countryOrRegion !== undefined && countryOrRegion.length > 0
            ? { countryOrRegion }
            : {}),
          ...(note !== undefined && note.length > 0 ? { note } : {}),
        };
        if (!Value.Check(CompanyDraftSchema, draft)) {
          continue;
        }
        const normalizedName = normalizeCompanyName(draft.name);
        if (normalizedName.length === 0 || seen.has(normalizedName)) {
          continue;
        }
        seen.add(normalizedName);
        drafts.push(draft);
      }
      return drafts;
    } catch (error) {
      if (error instanceof CompanyRecognitionError) {
        throw error;
      }
      throw new CompanyRecognitionError();
    }
  }

  private async request(
    path: string,
    init: RequestInit,
    timeoutMs = this.timeoutMs,
  ): Promise<Response | undefined> {
    if (!this.enabled) {
      return undefined;
    }
    let apiKey: string | undefined;
    try {
      apiKey = this.secrets.get("deepseek.apiKey");
    } catch {
      return undefined;
    }
    if (apiKey === undefined || apiKey.trim().length === 0 || this.fetchImpl === undefined) {
      return undefined;
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await this.fetchImpl(`${DEEPSEEK_BASE_URL}${path}`, {
        ...init,
        headers: {
          ...init.headers,
          authorization: `Bearer ${apiKey}`,
        },
        signal: controller.signal,
      });
    } catch {
      return undefined;
    } finally {
      clearTimeout(timeout);
    }
  }
}
