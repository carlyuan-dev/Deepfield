import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

export const APP_ERROR_CATEGORIES = {
  "CONFIG.CREDENTIAL_MISSING": "configuration", "CONFIG.PROFILE_MISSING": "configuration", "CONFIG.INVALID": "configuration",
  "EXTERNAL.AUTHENTICATION_FAILED": "external", "EXTERNAL.TIMEOUT": "external", "EXTERNAL.RATE_LIMITED": "external", "EXTERNAL.UNAVAILABLE": "external", "EXTERNAL.INVALID_RESPONSE": "external",
  "INPUT.INVALID": "input", "BUSINESS.CONFLICT": "business", "RESOURCE.NOT_FOUND": "resource", "STORAGE.FAILED": "storage", "INTERNAL.UNKNOWN": "internal",
} as const;
export type AppErrorCode = keyof typeof APP_ERROR_CATEGORIES;
export const AppErrorContextSchema = Type.Object({ service: Type.Optional(Type.Union([Type.Literal("llm"), Type.Literal("search")])) }, { additionalProperties: false });
export type AppErrorContext = Static<typeof AppErrorContextSchema>;
export type PublicAppError = { [C in AppErrorCode]: {
  code: C;
  category: typeof APP_ERROR_CATEGORIES[C];
  context?: AppErrorContext;
} }[AppErrorCode];
export const PublicAppErrorSchema = Type.Unsafe<PublicAppError>(Type.Union(Object.entries(APP_ERROR_CATEGORIES).map(([code, category]) => Type.Object({
  code: Type.Literal(code as AppErrorCode), category: Type.Literal(category), context: Type.Optional(AppErrorContextSchema),
}, { additionalProperties: false }))));

/** Internal exception only. Never send Error instances or causes across IPC. */
export class AppError extends Error {
  readonly category: PublicAppError["category"];
  constructor(readonly code: AppErrorCode, readonly context?: AppErrorContext, options?: ErrorOptions) {
    super(code, options);
    this.name = "AppError";
    this.category = APP_ERROR_CATEGORIES[code];
  }
}

/** Strict structural validation also works after Electron drops object prototypes. */
export function toPublicError(value: unknown): PublicAppError {
  const candidate = value instanceof AppError
    ? { code: value.code, category: value.category, ...(value.context === undefined ? {} : { context: value.context }) }
    : value;
  if (!Value.Check(PublicAppErrorSchema, candidate)) return { code: "INTERNAL.UNKNOWN", category: "internal" };
  return { code: candidate.code, category: candidate.category, ...(candidate.context === undefined ? {} : { context: { ...candidate.context } }) } as PublicAppError;
}

export type AppResult<T> = { ok: true; value: T } | { ok: false; error: PublicAppError };
export async function appResult<T>(work: () => T | Promise<T>): Promise<AppResult<T>> {
  try { return { ok: true, value: await work() }; }
  catch (error) { return { ok: false, error: toPublicError(error) }; }
}
