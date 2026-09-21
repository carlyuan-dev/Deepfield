import { Type } from "typebox";
import { Value } from "typebox/value";

export type PackageEntry = "main" | "worker" | "ui";

export interface CapabilityActionDeclaration {
  id: string;
  description: string;
  mode: "immediate" | "task";
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  documentation: { path: string; version: string };
  permissions: string[];
  requiresConfirmation: boolean;
}

export interface CapabilityManifest {
  id: string;
  name: string;
  description: string;
  version: string;
  protocolVersion: 1;
  hostApiVersion: 1;
  entries: { main: string; worker: string; ui?: string };
  navigation?: { title: string; order: number; route: string };
  requirements: string[];
  actions: CapabilityActionDeclaration[];
}

export type ManifestResult =
  | { ok: true; manifest: CapabilityManifest }
  | { ok: false; code: "invalid_manifest" | "incompatible" };

const nonEmptyText = Type.String({ minLength: 1 });
// Keep untrusted JSON comfortably below recursive validator and snapshot stack limits.
const MAX_MANIFEST_DEPTH = 128;
const semVerPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const declarationSchema = Type.Cyclic({ Declaration: Type.Object({
  type: Type.Optional(Type.Union([
    Type.Literal("object"),
    Type.Literal("array"),
    Type.Literal("string"),
    Type.Literal("number"),
    Type.Literal("integer"),
    Type.Literal("boolean"),
    Type.Literal("null"),
  ])),
  properties: Type.Optional(Type.Record(Type.String(), Type.Ref("Declaration"))),
  required: Type.Optional(Type.Array(Type.String())),
  items: Type.Optional(Type.Ref("Declaration")),
  enum: Type.Optional(Type.Array(Type.Unknown())),
  description: Type.Optional(Type.String()),
  additionalProperties: Type.Optional(Type.Boolean()),
  minimum: Type.Optional(Type.Number()),
  maximum: Type.Optional(Type.Number()),
  minLength: Type.Optional(Type.Integer({ minimum: 0 })),
  maxLength: Type.Optional(Type.Integer({ minimum: 0 })),
  minItems: Type.Optional(Type.Integer({ minimum: 0 })),
  maxItems: Type.Optional(Type.Integer({ minimum: 0 })),
}, { additionalProperties: false }) }, "Declaration");

const actionSchema = Type.Object({
  id: nonEmptyText,
  description: nonEmptyText,
  mode: Type.Union([Type.Literal("immediate"), Type.Literal("task")]),
  inputSchema: declarationSchema,
  outputSchema: declarationSchema,
  documentation: Type.Object({ path: nonEmptyText, version: nonEmptyText }, { additionalProperties: false }),
  permissions: Type.Array(nonEmptyText),
  requiresConfirmation: Type.Boolean(),
}, { additionalProperties: false });

const manifestSchema = Type.Object({
  id: nonEmptyText,
  name: nonEmptyText,
  description: nonEmptyText,
  version: nonEmptyText,
  protocolVersion: Type.Integer(),
  hostApiVersion: Type.Integer(),
  entries: Type.Object({
    main: nonEmptyText,
    worker: nonEmptyText,
    ui: Type.Optional(nonEmptyText),
  }, { additionalProperties: false }),
  navigation: Type.Optional(Type.Object({
    title: nonEmptyText,
    order: Type.Number(),
    route: nonEmptyText,
  }, { additionalProperties: false })),
  requirements: Type.Array(nonEmptyText),
  actions: Type.Array(actionSchema),
}, { additionalProperties: false });

function isPackageRelativePath(path: string): boolean {
  if (path.startsWith("/") || path.startsWith("\\") || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(path)) return false;
  return !path.split(/[\\/]/).includes("..");
}

function isWithinManifestDepth(value: unknown): boolean {
  const pending: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  const visited = new WeakSet<object>();
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (current.depth > MAX_MANIFEST_DEPTH) return false;
    if (current.value === null || typeof current.value !== "object") continue;
    if (visited.has(current.value)) continue;
    visited.add(current.value);
    for (const nested of Object.values(current.value)) {
      pending.push({ value: nested, depth: current.depth + 1 });
    }
  }
  return true;
}

function validateManifestValue(value: unknown): ManifestResult {
  if (!Value.Check(manifestSchema, value)) return { ok: false, code: "invalid_manifest" };

  const candidate = value as Omit<CapabilityManifest, "protocolVersion" | "hostApiVersion"> & {
    protocolVersion: number;
    hostApiVersion: number;
  };
  if (candidate.protocolVersion !== 1 || candidate.hostApiVersion !== 1) {
    return { ok: false, code: "incompatible" };
  }
  if (!semVerPattern.test(candidate.version)) return { ok: false, code: "invalid_manifest" };

  const paths = [
    candidate.entries.main,
    candidate.entries.worker,
    candidate.entries.ui,
    ...candidate.actions.map((action) => action.documentation.path),
  ];
  if (paths.some((path) => path !== undefined && !isPackageRelativePath(path))) {
    return { ok: false, code: "invalid_manifest" };
  }

  const actionIds = new Set<string>();
  for (const action of candidate.actions) {
    if (actionIds.has(action.id)) return { ok: false, code: "invalid_manifest" };
    actionIds.add(action.id);
  }

  return { ok: true, manifest: candidate as CapabilityManifest };
}

export function validateManifest(value: unknown): ManifestResult {
  try {
    if (!isWithinManifestDepth(value)) return { ok: false, code: "invalid_manifest" };
    return validateManifestValue(value);
  } catch {
    return { ok: false, code: "invalid_manifest" };
  }
}
