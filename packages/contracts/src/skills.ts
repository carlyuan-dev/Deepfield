import { Type, type Static } from "typebox";

export const SkillSummarySchema = Type.Object(
  {
    name: Type.String({ minLength: 1 }),
    description: Type.String(),
  },
  { additionalProperties: false },
);
export type SkillSummary = Static<typeof SkillSummarySchema>;
