import { Agent } from "@earendil-works/pi-agent-core";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import { PiModelGateway, type ModelGateway, type ModelGatewayError } from "../../shared/model-gateway.js";
import type { PiRuntime } from "./pi-runtime.js";

export function defaultPiRuntime(gateway: ModelGateway = new PiModelGateway()): PiRuntime {
  return {
    createSession(snapshot, observer) {
      let modelFailure: ModelGatewayError | undefined;
      const stream = gateway.createStream?.(snapshot, observer, error => { modelFailure = error; }) ?? streamSimple;
      return {
        model: gateway.createModel(snapshot),
        streamFn: (model, context, options) => { modelFailure = undefined; return stream(model, context, options); },
        getModelFailure: () => modelFailure,
      };
    },
    createAgent(options) {
      return new Agent(options);
    },
  };
}
