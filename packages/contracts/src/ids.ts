export type Brand<T, TName extends string> = T & { readonly __brand: TName };
export type CapabilityItemId = Brand<string, "CapabilityItemId">;
export type CompanyId = Brand<string, "CompanyId">;
export type ConversationId = Brand<string, "ConversationId">;
export type MessageId = Brand<string, "MessageId">;
export type RequestId = Brand<string, "RequestId">;
export type ResearchRunId = Brand<string, "ResearchRunId">;
