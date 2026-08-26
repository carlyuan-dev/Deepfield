import type { ChatAgent } from "./message-loop.js";

export type ScheduleFn = (callback: () => void) => void;

export function createFakeChatAgent(
  schedule: ScheduleFn = (callback) => setTimeout(callback, 0),
): ChatAgent {
  return {
    async run(request, emit) {
      emit({ requestId: request.requestId, type: "started" });
      for (const delta of ["测", "试回", "复"]) {
        await new Promise<void>((resolve) => {
          schedule(resolve);
        });
        emit({ requestId: request.requestId, type: "text_delta", delta });
      }
      emit({ requestId: request.requestId, type: "completed", text: "测试回复" });
    },
  };
}
