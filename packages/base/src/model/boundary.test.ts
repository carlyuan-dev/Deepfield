import { expect, it } from "vitest";
import { build } from "esbuild";
import { ModelGatewayError } from "./index.js";
import { ModelGatewayError as LegacyError } from "../../../../apps/desktop/src/shared/model-gateway.js";
import { classifyModelHttpDiagnostic } from "./http-diagnostic.js";

it("loads the safe model entry in a browser without Pi or Node and preserves error identity", async () => {
  const result = await build({ entryPoints: [new URL("./index.ts", import.meta.url).pathname], bundle: true, platform: "browser", write: false, metafile: true });
  expect(Object.keys(result.metafile!.inputs).every(path => !path.includes("node_modules") && !path.includes("runtime"))).toBe(true);
  expect(new LegacyError()).toBeInstanceOf(ModelGatewayError);
});

it("identifies only valid requested tool indexes without guessing duplicate names", () => {
  expect(classifyModelHttpDiagnostic(400, "Invalid schema for function 'custom_tool'", ["custom_tool"])).toEqual({ httpStatus: 400, reason: "invalid_tool_schema", toolIndex: 0 });
  expect(classifyModelHttpDiagnostic(400, "Invalid schema for function 'custom-tool-2'", ["custom-tool-2"])).toEqual({ httpStatus: 400, reason: "invalid_tool_schema", toolIndex: 0 });
  expect(classifyModelHttpDiagnostic(400, "Invalid schema for function 'custom_tool'", ["custom_tool", "custom_tool"])).toEqual({ httpStatus: 400, reason: "invalid_tool_schema" });
  expect(classifyModelHttpDiagnostic(400, "tools[2].function.parameters: missing field `type`", ["custom_tool"])).toEqual({ httpStatus: 400, reason: "invalid_tool_schema" });
});
