export type ErrorCategory = "configuration" | "external" | "input" | "business"
  | "resource" | "storage" | "internal";

export interface ErrorIdentity<C extends string = string, X = unknown> {
  code: C;
  category: ErrorCategory;
  context?: X;
}

export class BaseError<C extends string = string, X = unknown> extends Error {
  readonly code: C;
  readonly category: ErrorCategory;
  readonly context?: X;

  constructor(code: C, category: ErrorCategory, context?: X, options?: ErrorOptions) {
    super(code, options);
    this.name = "BaseError";
    this.code = code;
    this.category = category;
    if (context !== undefined) this.context = context;
  }
}

/** A boundary-owned validator that returns independent, explicitly allowed DTOs. */
export interface PublicErrorCodec<E extends ErrorIdentity> {
  parse(candidate: unknown): E | undefined;
  unknown(): E;
}

export function serializeError<E extends ErrorIdentity>(value: unknown, codec: PublicErrorCodec<E>): E {
  let candidate = value;
  if (value instanceof Error) {
    const error = value as Error & Partial<ErrorIdentity>;
    candidate = {
      code: error.code,
      category: error.category,
      ...(error.context === undefined ? {} : { context: error.context }),
    };
  }
  return codec.parse(candidate) ?? codec.unknown();
}

export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };

export async function captureResult<T, E>(
  work: () => T | Promise<T>,
  toError: (error: unknown) => E,
): Promise<Result<T, E>> {
  try {
    return { ok: true, value: await work() };
  } catch (error) {
    return { ok: false, error: toError(error) };
  }
}
