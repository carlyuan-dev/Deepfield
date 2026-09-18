import { parseUsageAttempt, type UsageRecorder, type UsageRepository } from "./contracts.js";

export function createUsageService(repository: UsageRepository): UsageRecorder {
  async function record(value: unknown, start: boolean): Promise<boolean> {
    let errorCode = "invalid_record";
    try {
      const attempt = parseUsageAttempt(value);
      if ((attempt.outcome === "running") !== start) throw new Error("invalid_usage_event");
      errorCode = "write_failed";
      repository.upsert(attempt);
      return true;
    } catch {
      // Health may fail with the same unavailable store. Keep the business path non-fatal;
      // the transport retains its own pending queue and can report it after recovery.
      try {
        repository.setDeliveryHealth({ failedRecords: repository.getHealth().failedRecords + 1, lastErrorCode: errorCode });
      } catch { /* best effort; false is the explicit negative acknowledgement */ }
      return false;
    }
  }
  return { recordStart: (start) => record(start, true), recordFinish: (finish) => record(finish, false) };
}
