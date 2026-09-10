import { Value } from "typebox/value";
import {
  CompanyProfileInputSchema,
  type CompanyProfileInput,
} from "@deepfield/contracts";

function trimOptional(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

function isValidFoundedAt(value: string): boolean {
  const match = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/.exec(value);
  if (match === null) return false;
  const year = Number(match[1]);
  if (year < 1) return false;
  if (match[2] === undefined) return true;
  const month = Number(match[2]);
  if (month < 1 || month > 12) return false;
  if (match[3] === undefined) return true;
  const day = Number(match[3]);
  return day >= 1 && day <= new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function normalizeCompanyProfile(input: unknown): CompanyProfileInput {
  if (!Value.Check(CompanyProfileInputSchema, input)) throw new Error("invalid company profile");
  const value = input as CompanyProfileInput;
  const name = value.name.trim();
  const legalName = trimOptional(value.legalName);
  const headquarters = trimOptional(value.headquarters);
  const foundedAt = trimOptional(value.foundedAt);
  const aliases = value.aliases?.map((alias) => alias.trim());
  const stockListings = value.stockListings?.map((listing) => ({
    exchange: listing.exchange.trim(),
    ticker: listing.ticker.trim(),
  }));
  const businessTags = value.businessTags?.map((tag) => tag.trim());
  const officialWebsite = typeof value.officialWebsite === "string"
    ? value.officialWebsite.trim()
    : value.officialWebsite;
  let invalidWebsite = false;
  if (typeof officialWebsite === "string") {
    try {
      const url = new URL(officialWebsite);
      invalidWebsite = officialWebsite.length === 0 || (url.protocol !== "http:" && url.protocol !== "https:");
    } catch {
      invalidWebsite = true;
    }
  }
  if (
    name.length === 0 ||
    (value.legalName !== undefined && legalName === undefined) ||
    aliases?.some((alias) => alias.length === 0) ||
    (value.headquarters !== undefined && headquarters === undefined) ||
    (foundedAt !== undefined && !isValidFoundedAt(foundedAt)) ||
    invalidWebsite ||
    stockListings?.some((listing) => listing.exchange.length === 0 || listing.ticker.length === 0) ||
    businessTags?.some((tag) => tag.length === 0)
  ) {
    throw new Error("invalid company profile");
  }
  return {
    name,
    ...(legalName !== undefined ? { legalName } : {}),
    ...(aliases !== undefined ? { aliases } : {}),
    ...(headquarters !== undefined ? { headquarters } : {}),
    ...(foundedAt !== undefined ? { foundedAt } : {}),
    ...(officialWebsite !== undefined ? { officialWebsite } : {}),
    ...(stockListings !== undefined ? { stockListings } : {}),
    ...(businessTags !== undefined ? { businessTags } : {}),
  };
}
