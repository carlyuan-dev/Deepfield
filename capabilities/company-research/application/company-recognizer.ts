import { CompanyDraftSchema, type CompanyDraft } from "../contracts/index.js";
import { RECOGNITION_CHUNK_MAX_CODE_POINTS, countUnicodeCodePoints, type LlmRuntimeSnapshot } from "@deepfield/contracts";
import { normalizeCompanyName } from "@deepfield/persistence";
import { Value } from "typebox/value";
import type { CompanyRecognizer, CompanyRecognitionModelGateway, UsageContextRunner } from "../host-ports.js";
export class CompanyRecognitionError extends Error {
  constructor() { super("company recognition failed"); this.name = "CompanyRecognitionError"; }
}

export class ConfiguredCompanyRecognizer implements CompanyRecognizer {
  constructor(private readonly resolveActiveLlm: () => Promise<LlmRuntimeSnapshot>, private readonly gateway: CompanyRecognitionModelGateway, private readonly withUsageContext: UsageContextRunner) {}
  recognize(text: string): Promise<CompanyDraft[]> {
    return this.withUsageContext({ sourceId: "company-recognition" }, () => this.recognizeNames(text));
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
