import { Type, type Static } from "typebox";
import type { ProjectId, ConversationId } from "./ids.js";

export const ProjectScopeSchema = Type.Object({
  focus: Type.Optional(Type.String()),
  geography: Type.Optional(Type.String()),
  timeRange: Type.Optional(Type.String()),
  exclusions: Type.Optional(Type.Array(Type.String())),
  customRequirements: Type.Optional(Type.Array(Type.String())),
});
export type ProjectScope = Static<typeof ProjectScopeSchema>;

export const CreateProjectInputSchema = Type.Object({
  industry: Type.String({ minLength: 1 }),
  scope: ProjectScopeSchema,
  launchSource: Type.Union([Type.Literal("chat"), Type.Literal("direct-ui")]),
});
export type CreateProjectInput = Static<typeof CreateProjectInputSchema>;

export interface Project {
  id: ProjectId;
  industry: string;
  scope: ProjectScope;
  status: "draft";
  createdAt: string;
  updatedAt: string;
}

export interface Conversation {
  id: ConversationId;
  projectId: ProjectId;
  hasUserMessage: boolean;
  createdAt: string;
  updatedAt: string;
}
