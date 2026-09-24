import { Type, type Static } from "typebox";

const text = (maxLength: number) => Type.String({ maxLength });
export const CapabilityIdSchema = Type.String({ minLength: 1, maxLength: 100, pattern: "^[a-z][a-z0-9-]*$" });
export const CAPABILITY_ISSUES = {
  capability_state_unavailable: "无法读取能力启用设置",
  scan_failed: "无法读取能力目录",
  manifest_missing: "缺少能力清单",
  manifest_read_failed: "无法读取能力清单",
  invalid_manifest: "能力清单无效",
  manifest_too_large: "能力清单过大",
  incompatible: "能力版本与当前应用不兼容",
  path_outside_package: "能力文件路径无效",
  entry_missing: "缺少能力文件",
  duplicate_id: "能力标识重复",
  missing_host_service: "当前应用缺少能力需要的服务",
  activation_failed: "能力启动失败",
  worker_unavailable: "能力运行进程不可用",
  runtime_disposed: "能力已停止",
  unavailable: "能力不可用",
} as const;
export const CapabilityIssueSchema = Type.Object({
  code: Type.Union(Object.keys(CAPABILITY_ISSUES).map(code => Type.Literal(code))),
  message: text(200),
}, { additionalProperties: false });
export interface CapabilityIssue { code: keyof typeof CAPABILITY_ISSUES; message: string }
export function safeCapabilityIssue(code: string): CapabilityIssue {
  const safe = Object.hasOwn(CAPABILITY_ISSUES, code) ? code as keyof typeof CAPABILITY_ISSUES : "unavailable";
  return { code: safe, message: CAPABILITY_ISSUES[safe] };
}
export const CapabilityStatusSchema = Type.Object({
  id: CapabilityIdSchema, name: text(200), description: text(4000), version: text(100),
  status: Type.Union([Type.Literal("disabled"), Type.Literal("loading"), Type.Literal("ready"), Type.Literal("incompatible"), Type.Literal("failed")]),
  enabledNextStart: Type.Boolean(), issue: Type.Optional(CapabilityIssueSchema),
  navigation: Type.Optional(Type.Object({ title: text(200), order: Type.Number(), route: text(500) }, { additionalProperties: false })),
  uiEntry: Type.Optional(Type.String({ maxLength: 1000, pattern: "^deepfield-capability://[a-z][a-z0-9-]*/[^?#]+\\.js$" })),
}, { additionalProperties: false });
export type ManagedCapability = Omit<Static<typeof CapabilityStatusSchema>, "issue"> & { issue?: CapabilityIssue };
export const CapabilitySnapshotSchema = Type.Object({
  packages: Type.Array(CapabilityStatusSchema, { maxItems: 1000 }),
  issues: Type.Array(CapabilityIssueSchema, { maxItems: 1000 }),
}, { additionalProperties: false });
export interface CapabilitySnapshot { packages: ManagedCapability[]; issues: CapabilityIssue[] }
export const CapabilitySetEnabledArgsSchema = Type.Tuple([CapabilityIdSchema, Type.Boolean()]);
export interface CapabilityManagementApi {
  list(): Promise<CapabilitySnapshot>;
  setEnabled(id: string, enabled: boolean): Promise<void>;
  restart(): Promise<void>;
  subscribe(listener: (snapshot: CapabilitySnapshot) => void): () => void;
}
