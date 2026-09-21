/** Frozen legacy SQLite validation contract. Do not depend on optional capability code. */
import { Type, type Static } from "typebox";

export const RESEARCH_DIRECTIONS = Object.freeze([
  "product_and_technology",
  "market_and_commercialization",
  "value_chain_and_competition",
  "operations_and_performance",
] as const);
export type ResearchDirection = typeof RESEARCH_DIRECTIONS[number];
// Keep tuple inference: a mapped array produces Static<...> = never in TypeBox 1.
export const ResearchDirectionSchema = Type.Union([
  Type.Literal(RESEARCH_DIRECTIONS[0]),
  Type.Literal(RESEARCH_DIRECTIONS[1]),
  Type.Literal(RESEARCH_DIRECTIONS[2]),
  Type.Literal(RESEARCH_DIRECTIONS[3]),
]);

export const CompanyResearchTemplateSnapshotSchema = Type.Immutable(Type.Object({
  templateId: ResearchDirectionSchema,
  templateVersion: Type.Literal(1),
  title: Type.String({ minLength: 1, maxLength: 1000 }),
  sections: Type.Array(Type.Object({
    sectionId: Type.String({ minLength: 1, maxLength: 100 }),
    title: Type.String({ minLength: 1, maxLength: 1000 }),
    coreQuestion: Type.String({ minLength: 1, maxLength: 4000 }),
    coverage: Type.String({ minLength: 1, maxLength: 4000 }),
    boundary: Type.String({ minLength: 1, maxLength: 4000 }),
  }, { additionalProperties: false }), { minItems: 5, maxItems: 5 }),
}, { additionalProperties: false }));
export type CompanyResearchTemplateSnapshot = Static<typeof CompanyResearchTemplateSnapshotSchema>;
