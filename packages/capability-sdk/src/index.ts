export {
  validateManifest,
  type CapabilityActionDeclaration,
  type CapabilityManifest,
  type ManifestResult,
  type PackageEntry,
} from "./manifest.js";
export {
  createResourceScope,
  type Cleanup,
  type ResourceScope,
  type ResourceScopeIssue,
} from "./lifecycle.js";
export type { CapabilityBridge, CapabilityCall, CapabilityEvent, CapabilityUiRuntime, CapabilityUiProps, CapabilityUiModule } from "./ui.js";
