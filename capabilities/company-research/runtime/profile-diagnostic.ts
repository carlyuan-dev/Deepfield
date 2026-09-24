import { Value } from "typebox/value";
import type { TSchema } from "typebox";
import { CompanyProfileCandidateSchema, type ProfileSchemaIssue } from "../contracts/index.js";

const fields = new Set(["identity", "disposition", "matchedName", "reason", "sources", "fields", "fieldEvidence", "legalName", "aliases", "headquarters", "foundedAt", "officialWebsite", "stockListings", "businessTags", "exchange", "ticker", "url", "kind"]);
export function safeProfilePath(path: string): string {
  return path.split("/").slice(1, 9).map((part) => `/${fields.has(part) || /^\d{1,3}$/u.test(part) ? part : "*"}`).join("").slice(0, 160);
}
function typeOf(value: unknown): ProfileSchemaIssue["actual"] {
  return value === null ? "null" : Array.isArray(value) ? "array" : ["object", "string", "number", "boolean", "undefined"].includes(typeof value) ? typeof value as ProfileSchemaIssue["actual"] : "undefined";
}
function at(value: unknown, path: string): unknown {
  for (const segment of path.split("/").slice(1)) {
    if (typeof value !== "object" || value === null) return undefined;
    value = (value as Record<string, unknown>)[segment.replace(/~1/gu, "/").replace(/~0/gu, "~")];
  }
  return value;
}
/** Validator messages, field values and unknown property names never leave here. */
export function profileSchemaIssues(value: unknown, schema: TSchema = CompanyProfileCandidateSchema): ProfileSchemaIssue[] {
  const expectedNames = new Set(["object", "array", "string", "number", "boolean", "null", "pattern", "minItems", "maxItems", "minLength", "maxLength", "anyOf"]);
  return Value.Errors(schema, value).slice(0, 20).map((error) => {
    const params = error.params as Record<string, unknown>;
    const required = error.keyword === "required" && Array.isArray(params.requiredProperties) ? params.requiredProperties[0] : undefined;
    const path = `${error.instancePath}${typeof required === "string" ? `/${required}` : ""}`;
    const expected = error.keyword === "required" ? "required" : error.keyword === "additionalProperties" ? "allowed_property"
      : error.keyword === "const" || error.keyword === "enum" ? "enum" : error.keyword === "type" && typeof params.type === "string" ? params.type : error.keyword;
    return { path: safeProfilePath(path), expected: (["required", "allowed_property", "enum"].includes(expected) || expectedNames.has(expected) ? expected : "schema") as ProfileSchemaIssue["expected"], actual: typeOf(at(value, path)) };
  });
}
