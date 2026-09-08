import {
  DEFAULT_DEEPSEEK_MODEL_ID,
} from "@deepfield/contracts";
import type { ConversationTitleGenerator, SecretReader } from "@deepfield/application";

export type DeepSeekConnectionStatus = "connected" | "disconnected";

interface DeepSeekServiceOptions {
  fetch?: typeof fetch;
  timeoutMs?: number;
  enabled?: boolean;
}

const DEEPSEEK_BASE_URL = "https://api.deepseek.com";
const DEFAULT_TIMEOUT_MS = 7000;
const TITLE_MAX_LENGTH = 28;

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

export class DeepSeekService implements ConversationTitleGenerator {
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

  private async request(path: string, init: RequestInit): Promise<Response | undefined> {
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
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
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
