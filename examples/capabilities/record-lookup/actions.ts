import { Type } from "typebox";
import { defineAction } from "@deepfield/capability-sdk";

const records = [
  { id: "sample-1", text: "交付时间待客户确认" },
  { id: "sample-2", text: "发票已发送" },
  { id: "sample-3", text: "服务材料已归档" },
];

export function createActionDefinitions() {
  return [defineAction({
    id: "records.find",
    title: "查询记录",
    description: "在固定示例记录中按文本搜索；不访问实际工单库。",
    mode: "immediate",
    effects: { data: "read", consumesResources: false },
    inputSchema: Type.Object({
      query: Type.String({ minLength: 1, maxLength: 200 }),
      limit: Type.Integer({ minimum: 1, maximum: 50 }),
    }, { additionalProperties: false }),
    outputSchema: Type.Object({
      items: Type.Array(Type.Object({
        id: Type.String(),
        text: Type.String(),
      }, { additionalProperties: false })),
      truncated: Type.Boolean(),
    }, { additionalProperties: false }),
    documentation: { path: "docs/actions/records.find.md", version: "1" },
    permissions: [],
    requiresConfirmation: false,
    handler(input) {
      const matching = records.filter(record => record.text.includes(input.query));
      return { status: "completed", data: { items: matching.slice(0, input.limit), truncated: matching.length > input.limit } };
    },
  })];
}
