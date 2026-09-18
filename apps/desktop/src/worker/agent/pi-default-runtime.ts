import { Agent } from "@earendil-works/pi-agent-core";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import { PiModelGateway, type ModelGateway } from "../../shared/model-gateway.js";
import type { PiRuntime } from "./pi-runtime.js";

export function defaultPiRuntime(gateway: ModelGateway = new PiModelGateway()): PiRuntime {
  return {
    createSession(snapshot) {
      return { model: gateway.createModel(snapshot), streamFn: gateway.createStream?.(snapshot) ?? streamSimple };
    },
    createAgent(options) {
      return new Agent(options);
    },
  };
}
