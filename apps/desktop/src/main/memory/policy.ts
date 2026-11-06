import { Type } from "typebox";
import { defineConfig } from "@deepfield/base/config";
export const memoryPolicyDefinition = defineConfig({ key: "memory", schemaVersion: 1,
  schema: Type.Object({ useEnabled: Type.Boolean(), autoLearnEnabled: Type.Boolean(), noticeSeen: Type.Boolean() }, { additionalProperties: false }),
  defaults: { useEnabled: true, autoLearnEnabled: true, noticeSeen: false },
});
