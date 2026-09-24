import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { canonicalActionJson, type ActionDefinition, type CompiledActionDeclaration } from "../../packages/capability-sdk/src/actions.ts";
import { isCompiledActionDeclaration, validateManifest } from "../../packages/capability-sdk/src/manifest.ts";

interface CompileActionCatalogOptions {
  capabilityRoot: string;
  actions: readonly ActionDefinition[];
}

function digest(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function isPackageRelativePath(path: string): boolean {
  return path.length > 0
    && !isAbsolute(path)
    && !path.startsWith("\\")
    && !/^[A-Za-z][A-Za-z0-9+.-]*:/.test(path)
    && !path.split(/[\\/]/).includes("..");
}

function contained(root: string, candidate: string): boolean {
  const remainder = relative(root, candidate);
  return remainder === "" || (!remainder.startsWith("..") && !isAbsolute(remainder));
}

async function readDocumentation(capabilityRoot: string, path: string): Promise<string> {
  if (!isPackageRelativePath(path)) throw new Error("invalid_action_documentation_path");
  try {
    const [canonicalRoot, canonicalDocument] = await Promise.all([
      realpath(capabilityRoot),
      realpath(join(capabilityRoot, path)),
    ]);
    if (!contained(canonicalRoot, canonicalDocument)) throw new Error("invalid_action_documentation_path");
    const content = await readFile(canonicalDocument, "utf8");
    if (content.trim().length === 0) throw new Error("action_documentation_missing");
    return content;
  } catch (error) {
    if (error instanceof Error && (error.message === "invalid_action_documentation_path" || error.message === "action_documentation_missing")) throw error;
    throw new Error("action_documentation_missing", { cause: error });
  }
}

function compiledContract(action: ActionDefinition, documentationDigest: string): Omit<CompiledActionDeclaration, "contractDigest"> {
  return {
    id: action.id,
    title: action.title,
    description: action.description,
    mode: action.mode,
    effects: { ...action.effects },
    inputSchema: JSON.parse(JSON.stringify(action.inputSchema)) as Record<string, unknown>,
    outputSchema: JSON.parse(JSON.stringify(action.outputSchema)) as Record<string, unknown>,
    documentation: { ...action.documentation, digest: documentationDigest },
    permissions: [...action.permissions],
    requiresConfirmation: action.requiresConfirmation,
    ...(action.taskAuthorization ? { taskAuthorization: { ...action.taskAuthorization } } : {}),
  };
}

/** Node-only compiler. The SDK definition stays safe to import in renderer bundles. */
export async function compileActionCatalog(options: CompileActionCatalogOptions): Promise<CompiledActionDeclaration[]> {
  const ids = new Set<string>();
  const compiled: CompiledActionDeclaration[] = [];
  for (const action of options.actions) {
    if (ids.has(action.id)) throw new Error("duplicate_action_id");
    ids.add(action.id);
    const documentation = await readDocumentation(options.capabilityRoot, action.documentation.path);
    const contract = compiledContract(action, digest(documentation));
    const declaration = { ...contract, contractDigest: digest(canonicalActionJson(contract)) };
    if (!isCompiledActionDeclaration(declaration)) throw new Error("invalid_action_definition");
    compiled.push(declaration);
  }
  return compiled;
}

function contractFromDeclaration(action: CompiledActionDeclaration): Omit<CompiledActionDeclaration, "contractDigest"> {
  const { contractDigest: _contractDigest, ...contract } = action;
  return contract;
}

/** Verifies the shipped manifest/docs pair after every package build. */
export async function verifyBuiltActionCatalog(capabilityRoot: string): Promise<void> {
  const raw = await readFile(join(capabilityRoot, "capability.json"), "utf8");
  const validation = validateManifest(JSON.parse(raw) as unknown);
  if (!validation.ok) throw new Error(validation.code);
  if (validation.manifest.protocolVersion !== 2) return;

  for (const action of validation.manifest.actions) {
    const documentation = await readDocumentation(capabilityRoot, action.documentation.path);
    if (digest(documentation) !== action.documentation.digest) throw new Error("action_documentation_digest_mismatch");
    if (digest(canonicalActionJson(contractFromDeclaration(action))) !== action.contractDigest) throw new Error("action_contract_digest_mismatch");
  }
}
