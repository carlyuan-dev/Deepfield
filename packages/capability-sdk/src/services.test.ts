import { expect, it } from "vitest";
import { createCapabilityHostServices, getCapabilityTrace } from "./services.js";

it("treats absent, incompatible and broken optional trace services as unavailable", () => {
  expect(getCapabilityTrace(undefined)).toBeUndefined();
  expect(getCapabilityTrace(createCapabilityHostServices({}))).toBeUndefined();
  expect(getCapabilityTrace(createCapabilityHostServices({ "trace.v1": { version: 2 } }))).toBeUndefined();
  expect(getCapabilityTrace(createCapabilityHostServices({ "trace.v1": { version: 1 } }))).toBeUndefined();
  expect(getCapabilityTrace({ version: 1, has: () => true, get: () => { throw new Error("offline"); } })).toBeUndefined();
});
