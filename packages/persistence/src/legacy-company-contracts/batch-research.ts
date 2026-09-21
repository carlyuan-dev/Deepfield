/** Frozen legacy SQLite validation contract. Do not depend on optional capability code. */
import { Type, type Static } from "typebox";
import { StartCompanyResearchInputSchema } from "./research.js";
import { PublicAppErrorSchema, type PublicAppError } from "../../../contracts/src/errors.js";
export const BatchResearchEntryInputSchema = Type.Object({ companyId: Type.String({ minLength: 1, maxLength: 200 }), input: StartCompanyResearchInputSchema }, { additionalProperties: false });
export type BatchResearchEntryInput = Static<typeof BatchResearchEntryInputSchema>;
export interface BatchResearchEntry extends BatchResearchEntryInput {
  status: "pending" | "running" | "completed" | "failed" | "cancelled";
  runId?: string;
  stage?: "raw" | "structure";
  issue?: PublicAppError;
  interrupted?: boolean;
}
export interface CompanyResearchBatchState {
  batchId: string;
  itemId: string;
  status: "waiting_profile" | "running" | "paused" | "cancelling" | "completed" | "cancelled";
  entries: BatchResearchEntry[];
  processed: number;
  succeeded: number;
  failed: number;
  total: number;
  issue?: PublicAppError;
}
export interface CompanyProfileProgress {
  itemId: string;
  status: "idle" | "running" | "waiting" | "paused" | "completed";
  processed: number;
  total: number;
  failed: number;
  issue?: PublicAppError;
}
const status = <T extends string>(values: T[]) => Type.Union(values.map(value => Type.Literal(value)));
const count = Type.Integer({ minimum: 0 });
export const CompanyResearchBatchStateSchema = Type.Unsafe<CompanyResearchBatchState>(Type.Object({
  batchId: Type.String(), itemId: Type.String(), status: status(["waiting_profile", "running", "paused", "cancelling", "completed", "cancelled"]),
  entries: Type.Array(Type.Object({ companyId: Type.String(), input: StartCompanyResearchInputSchema,
    status: status(["pending", "running", "completed", "failed", "cancelled"]), runId: Type.Optional(Type.String()), stage: Type.Optional(status(["raw", "structure"])), issue: Type.Optional(PublicAppErrorSchema), interrupted: Type.Optional(Type.Boolean()) })),
  processed: count, succeeded: count, failed: count, total: count, issue: Type.Optional(PublicAppErrorSchema),
}));
export const CompanyProfileProgressSchema = Type.Unsafe<CompanyProfileProgress>(Type.Object({ itemId: Type.String(), status: status(["idle", "running", "waiting", "paused", "completed"]), processed: count, total: count, failed: count, issue: Type.Optional(PublicAppErrorSchema) }));
export const CompanyResearchBatchStartArgsSchema = Type.Tuple([Type.String({ minLength: 1, maxLength: 200 }), Type.Array(BatchResearchEntryInputSchema, { minItems: 1, maxItems: 1000 })]);
