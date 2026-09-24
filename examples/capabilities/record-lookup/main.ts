import type { CapabilityHostServices, CapabilityRegistrar, CompiledActionDeclaration } from "@deepfield/capability-sdk";
import { createActionDefinitions } from "./actions.js";

export { createActionDefinitions } from "./actions.js";
declare const __RECORD_LOOKUP_ACTION_DECLARATIONS__: CompiledActionDeclaration[];

export function bootstrap(registrar: CapabilityRegistrar, services: CapabilityHostServices): void {
  if (services.version !== 1 || !registrar.registerAction) throw new Error("incompatible_host_services");
  const definitions = createActionDefinitions();
  const declarations = __RECORD_LOOKUP_ACTION_DECLARATIONS__;
  if (definitions.length !== declarations.length) throw new Error("action_registration_mismatch");
  for (let index = 0; index < definitions.length; index++) {
    registrar.registerAction({ definition: definitions[index]!, declaration: declarations[index]! });
  }
}
