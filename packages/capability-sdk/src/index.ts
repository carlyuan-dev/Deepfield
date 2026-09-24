export {
  validateManifest,
  isCompiledActionDeclaration,
  type CapabilityActionDeclaration,
  type CapabilityActionDeclarationV1,
  type CapabilityActionDeclarationV2,
  type CapabilityManifest,
  type CapabilityManifestV1,
  type CapabilityManifestV2,
  type ManifestResult,
  type PackageEntry,
} from "./manifest.js";
export {
  ActionCallSchema,
  type ActionCall,
  ActionEffectsSchema,
  canonicalActionJson,
  defineAction,
  type ActionDefinition,
  type ActionInputPresentation,
  type ActionDocumentationSource,
  type ActionEffects,
  type ActionInvocationContext,
  type CompiledActionDeclaration,
  type CompiledActionDocumentation,
  type RegisteredAction,
} from "./actions.js";
export {
  ActionOutcomeSchema,
  ActionResultSchema,
  ActionResultMetadataSchema,
  OperationPresentationSchema,
  ArtifactRefSchema,
  DraftRefSchema,
  ReadSliceSchema,
  TaskRefSchema,
  TaskSnapshotSchema,
  TaskStatusSchema,
  ViewOpenResultSchema,
  ViewRefSchema,
  type ActionOutcome,
  type ActionResult,
  type ActionResultMetadata,
  type OperationPresentation,
  type ArtifactProvider,
  type ArtifactReadRequest,
  type ArtifactRef,
  type DraftRef,
  type ReadSlice,
  type TaskProvider,
  type TaskRef,
  type TaskSnapshot,
  type TaskStatus,
  type ViewOpenResult,
  type ViewProvider,
  type ViewResolution,
  type ViewRef,
} from "./interaction.js";
export {
  createResourceScope,
  type Cleanup,
  type ResourceScope,
  type ResourceScopeIssue,
} from "./lifecycle.js";
export type { CapabilityBridge, CapabilityCall, CapabilityEvent, CapabilityUiOpenResult, CapabilityUiOpenTarget, CapabilityUiRuntime, CapabilityUiProps, CapabilityUiModule } from "./ui.js";
export * from "./transport.js";
export type { CapabilityUiNavigationHandler, CapabilityUiNavigation, CapabilityNavigationRequest, CapabilityNavigationEvent, CapabilityNavigationBridge } from "./ui.js";
export type * from "./execution.js";
export type * from "./forms.js";
export type { CapabilityInteractionEditor } from "./ui.js";
export type { CapabilityRegistrar, CapabilityWorkerRegistrar } from "./host.js";
export { createCapabilityHostServices, type CapabilityHostServices } from "./services.js";
export { TaskAuthorizationSchema, TaskScopeProposalSchema, TaskScopeRuleSchema, type TaskAuthorization, type TaskScopeProposal } from "./task-scope.js";
