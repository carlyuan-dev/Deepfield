export type Brand<T, TName extends string> = T & { readonly __brand: TName };
export type ProjectId = Brand<string, "ProjectId">;
export type ConversationId = Brand<string, "ConversationId">;
export type MessageId = Brand<string, "MessageId">;
export type RequestId = Brand<string, "RequestId">;
