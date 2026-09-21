import type { CompanyProfileFields, CompanyProfileResult } from "../../../../capabilities/company-research/contracts/index.js";
export function profileResult(fields: CompanyProfileFields = { headquarters: "北京，中国" }): CompanyProfileResult {
  const ref = { url: "https://example.test/company", kind: "search_snippet" as const };
  return { identity: { disposition: "matched", matchedName: "测试公司", reason: "测试证据匹配主体", sources: [ref] }, fields,
    fieldEvidence: Object.fromEntries(Object.keys(fields).map((field) => [field, [ref]])),
    sources: [{ ...ref, title: "测试公司资料", excerpt: "测试公司位于北京，中国" }] };
}
