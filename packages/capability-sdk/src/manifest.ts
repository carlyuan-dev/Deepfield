import { Type } from "typebox";
import { Value } from "typebox/value";
import type { CompiledActionDeclaration } from "./actions.js";
import { TaskAuthorizationSchema } from "./task-scope.ts";

export type PackageEntry = "main" | "worker" | "ui";

export interface CapabilityActionDeclarationV1 {
  id: string;
  description: string;
  mode: "immediate" | "task";
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  documentation: { path: string; version: string };
  permissions: string[];
  requiresConfirmation: boolean;
}

export type CapabilityActionDeclarationV2 = CompiledActionDeclaration;
export type CapabilityActionDeclaration = CapabilityActionDeclarationV1 | CapabilityActionDeclarationV2;

interface CapabilityManifestBase {
  id: string;
  name: string;
  description: string;
  version: string;
  navigation?: { title: string; order: number; route: string };
  requirements: string[];
}

export interface CapabilityManifestV1 extends CapabilityManifestBase {
  protocolVersion: 1;
  hostApiVersion: 1;
  entries: { main: string; worker: string; ui?: string };
  actions: CapabilityActionDeclarationV1[];
}

export interface CapabilityManifestV2 extends CapabilityManifestBase {
  protocolVersion: 2;
  hostApiVersion: 2;
  entries: { main: string; worker?: string; ui?: string };
  actions: CapabilityActionDeclarationV2[];
  help?: string;
  views?: Array<{ id: string; inputSchema: Record<string, unknown> }>;
}

export type CapabilityManifest = CapabilityManifestV1 | CapabilityManifestV2;

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
  anyOf: Type.Optional(Type.Array(Type.Ref("Declaration"), { minItems: 1 })),
  enum: Type.Optional(Type.Array(Type.Unknown())),
  const: Type.Optional(Type.Unknown()),
  description: Type.Optional(Type.String()),
  pattern: Type.Optional(Type.String()),
  additionalProperties: Type.Optional(Type.Boolean()),
  minimum: Type.Optional(Type.Number()),
  maximum: Type.Optional(Type.Number()),
  minLength: Type.Optional(Type.Integer({ minimum: 0 })),
  maxLength: Type.Optional(Type.Integer({ minimum: 0 })),
  minItems: Type.Optional(Type.Integer({ minimum: 0 })),
  maxItems: Type.Optional(Type.Integer({ minimum: 0 })),
}, { additionalProperties: false }) }, "Declaration");

const actionV1Schema = Type.Object({
  id: nonEmptyText,
  description: nonEmptyText,
  mode: Type.Union([Type.Literal("immediate"), Type.Literal("task")]),
  inputSchema: declarationSchema,
  outputSchema: declarationSchema,
  documentation: Type.Object({ path: nonEmptyText, version: nonEmptyText }, { additionalProperties: false }),
  permissions: Type.Array(nonEmptyText),
  requiresConfirmation: Type.Boolean(),
}, { additionalProperties: false });

const digestSchema = Type.String({ pattern: "^sha256:[a-f0-9]{64}$" });
const actionV2Schema = Type.Object({
  id: nonEmptyText,
  title: nonEmptyText,
  description: nonEmptyText,
  mode: Type.Union([Type.Literal("immediate"), Type.Literal("task")]),
  effects: Type.Object({
    data: Type.Union([Type.Literal("read"), Type.Literal("write"), Type.Literal("destructive")]),
    consumesResources: Type.Boolean(),
  }, { additionalProperties: false }),
  inputSchema: declarationSchema,
  outputSchema: declarationSchema,
  documentation: Type.Object({ path: nonEmptyText, version: nonEmptyText, digest: digestSchema }, { additionalProperties: false }),
  permissions: Type.Array(nonEmptyText),
  requiresConfirmation: Type.Boolean(),
  contractDigest: digestSchema,
  taskAuthorization: Type.Optional(TaskAuthorizationSchema),
}, { additionalProperties: false });

const manifestBase = {
  id: nonEmptyText,
  name: nonEmptyText,
  description: nonEmptyText,
  version: nonEmptyText,
  navigation: Type.Optional(Type.Object({
    title: nonEmptyText,
    order: Type.Number(),
    route: nonEmptyText,
  }, { additionalProperties: false })),
  requirements: Type.Array(nonEmptyText),
};

const manifestV1Schema = Type.Object({
  ...manifestBase,
  protocolVersion: Type.Literal(1),
  hostApiVersion: Type.Literal(1),
  entries: Type.Object({
    main: nonEmptyText,
    worker: nonEmptyText,
    ui: Type.Optional(nonEmptyText),
  }, { additionalProperties: false }),
  actions: Type.Array(actionV1Schema),
}, { additionalProperties: false });

const manifestV2Schema = Type.Object({
  ...manifestBase,
  protocolVersion: Type.Literal(2),
  hostApiVersion: Type.Literal(2),
  entries: Type.Object({
    main: nonEmptyText,
    worker: Type.Optional(nonEmptyText),
    ui: Type.Optional(nonEmptyText),
  }, { additionalProperties: false }),
  actions: Type.Array(actionV2Schema),
  help: Type.Optional(nonEmptyText),
  views: Type.Optional(Type.Array(Type.Object({ id: nonEmptyText, inputSchema: declarationSchema }, { additionalProperties: false }))),
}, { additionalProperties: false });

const manifestSchema = Type.Union([manifestV1Schema, manifestV2Schema]);

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
  if (typeof value === "object" && value !== null && "protocolVersion" in value && "hostApiVersion" in value) {
    const { protocolVersion, hostApiVersion } = value as { protocolVersion?: unknown; hostApiVersion?: unknown };
    if (Number.isInteger(protocolVersion) && Number.isInteger(hostApiVersion)
      && !((protocolVersion === 1 && hostApiVersion === 1) || (protocolVersion === 2 && hostApiVersion === 2))) {
      return { ok: false, code: "incompatible" };
    }
  }
  if (!Value.Check(manifestSchema, value)) return { ok: false, code: "invalid_manifest" };

  const candidate = value as CapabilityManifest;
  if (candidate.protocolVersion === 2 && candidate.views) {
    if (!candidate.entries.ui || new Set(candidate.views.map(view => view.id)).size !== candidate.views.length) return { ok: false, code: "invalid_manifest" };
  }
  if (!semVerPattern.test(candidate.version)) return { ok: false, code: "invalid_manifest" };

  const paths = [
    candidate.entries.main,
    candidate.entries.worker,
    candidate.entries.ui,
    ...(candidate.protocolVersion === 2 ? [candidate.help] : []),
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

  return { ok: true, manifest: candidate };
}

export function validateManifest(value: unknown): ManifestResult {
  try {
    if (!isWithinManifestDepth(value)) return { ok: false, code: "invalid_manifest" };
    return validateManifestValue(value);
  } catch {
    return { ok: false, code: "invalid_manifest" };
  }
}

export function isCompiledActionDeclaration(value: unknown): value is CapabilityActionDeclarationV2 {
  try {
    return isWithinManifestDepth(value) && Value.Check(actionV2Schema, value);
  } catch {
    return false;
  }
}
