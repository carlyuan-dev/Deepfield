import type { Company } from "../contracts/index.js";

const profileFields = [
  "legalName", "aliases", "headquarters", "foundedAt", "officialWebsite", "stockListings", "businessTags",
] as const satisfies ReadonlyArray<keyof Company>;

/** An omitted field is unknown; empty arrays and a null website are known answers. */
export function hasUnknownCompanyProfileFields(company: Company): boolean {
  return profileFields.some(field => company[field] === undefined);
}
