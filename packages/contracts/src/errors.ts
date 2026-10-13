import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { BaseError, captureResult, serializeError, type PublicErrorCodec, type Result } from "@deepfield/base/errors";

export const APP_ERROR_CATEGORIES = {
  "capability_unavailable": "resource",
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
export class AppError extends BaseError<AppErrorCode, AppErrorContext> {
  declare readonly category: PublicAppError["category"];
  constructor(code: AppErrorCode, context?: AppErrorContext, options?: ErrorOptions) {
    super(code, APP_ERROR_CATEGORIES[code], context, options);
    this.name = "AppError";
  }
}

const publicAppErrorCodec: PublicErrorCodec<PublicAppError> = {
  parse(candidate) {
    if (!Value.Check(PublicAppErrorSchema, candidate)) return undefined;
    return { code: candidate.code, category: candidate.category, ...(candidate.context === undefined ? {} : { context: { ...candidate.context } }) } as PublicAppError;
  },
  unknown: () => ({ code: "INTERNAL.UNKNOWN", category: "internal" }),
};

/** Packages bundle their own Error constructors; validate only the public fields. */
export function toPublicError(value: unknown): PublicAppError {
  return serializeError(value, publicAppErrorCodec);
}

export type AppResult<T> = Result<T, PublicAppError>;
export function appResult<T>(work: () => T | Promise<T>): Promise<AppResult<T>> {
  return captureResult(work, toPublicError);
}
