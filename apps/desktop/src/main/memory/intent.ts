import { createHash } from "node:crypto";
import type { MemoryCommand } from "@deepfield/contracts";

export function memoryOperationFingerprint(command: MemoryCommand, target: unknown): string {
  return createHash("sha256").update(JSON.stringify({ command, target })).digest("hex");
}

/** The primary Chat agent owns semantic intent, as for its other narrow tools.
 * This check binds its quoted evidence to the actual current human message;
 * remembered text, a web page or an assistant claim cannot supply that source. */
export function hasCurrentUserRequest(text: string, command: MemoryCommand): boolean {
  return "userRequest" in command && Boolean(command.userRequest.trim())
    && text.includes(command.userRequest);
}
