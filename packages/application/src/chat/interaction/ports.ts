import type { InteractionResponseSource, OperationRef, OperationResult, OperationSnapshot } from "@deepfield/contracts";
import type { InteractionRepository } from "@deepfield/persistence";

export type { OperationResult, OperationSnapshot, InteractionRepository };

export interface OperationAdapter {
  read(ref: OperationRef): Promise<OperationSnapshot>;
  /** Must compare expectedContentVersion at the execution boundary before committing a write. */
  execute(ref: OperationRef, revision: number, receiptId: string, expectedContentVersion: string): Promise<OperationResult>;
  reconcile(receiptId: string): Promise<OperationResult | "unknown">;
  release?(ref: OperationRef): Promise<void>;
}

export interface TrustedInteractionContext {
  /** Bound by the host to the actual sender; never copied from model or renderer arguments. */
  conversationId: string;
  source: InteractionResponseSource;
}
