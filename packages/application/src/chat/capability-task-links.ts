import type { ChatCapabilityTask } from "@deepfield/persistence";
import type { TaskSnapshot } from "@deepfield/capability-sdk";
import { createHash } from "node:crypto";

const terminal = new Set(["succeeded", "failed", "cancelled", "interrupted"]);

/** Conservative intent detection; the task card may offer a separate explicit choice. */
export function requestedCompletionAnalysis(text: string): boolean {
  if (/(?:不要|不用|无需|别|不必).{0,18}(?:分析|解读)|(?:do not|don't|no need to).{0,30}(?:analy[sz]e|review)/iu.test(text)) return false;
  return /(?:完成|结束|做好|出来)后.{0,12}(?:分析|解读)|(?:分析|解读).{0,12}(?:完成|结束)后/u.test(text)
    || /(?:analy[sz]e|review).{0,30}(?:when|after).{0,20}(?:finished|complete|done)|(?:when|after).{0,20}(?:finished|complete|done).{0,30}(?:analy[sz]e|review)/iu.test(text);
}

export function taskEventId(snapshot: TaskSnapshot): string {
  return createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
}

export function shouldScheduleAnalysis(link: ChatCapabilityTask): boolean {
  return link.analyzeAfter && link.analysisState === "pending" && terminal.has(link.snapshot.status);
}
