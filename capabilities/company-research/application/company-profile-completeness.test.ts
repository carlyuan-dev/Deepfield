import { describe, expect, it } from "vitest";
import type { Company } from "../contracts/index.js";
import { hasUnknownCompanyProfileFields } from "./company-profile-completeness.js";

const company = (fields: Partial<Company>): Company => ({
  id: "company" as Company["id"], name: "测试公司", normalizedName: "测试公司",
  profileStatus: "ready", createdAt: "", updatedAt: "", ...fields,
});

describe("company profile completeness", () => {
  it("treats each missing profile field as unknown while ignoring topic notes", () => {
    const known = { legalName: "测试公司有限公司", aliases: [], headquarters: "北京", foundedAt: "2020", officialWebsite: null, stockListings: [], businessTags: ["软件"] };
    expect(hasUnknownCompanyProfileFields(company({ ...known, note: "备注" } as Partial<Company>))).toBe(false);
    for (const field of Object.keys(known) as Array<keyof typeof known>) {
      const incomplete = { ...known };
      delete (incomplete as Partial<typeof known>)[field];
      expect(hasUnknownCompanyProfileFields(company(incomplete))).toBe(true);
    }
  });
});
