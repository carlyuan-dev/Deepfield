import { randomUUID } from "node:crypto";
import type { UsageDeliveryHealth } from "@deepfield/base/usage";
import { createUsageDelivery } from "../shared/usage-delivery.js";
import { HostRpcError, type HostClient } from "./host-client.js";

export function createWorkerUsageRuntime(host: HostClient) {
  const sessionId = randomUUID();
  let latest: UsageDeliveryHealth | undefined;
  let publishing: Promise<void> | undefined;
  // At most one health RPC and one latest snapshot, regardless of token rate.
  async function publish() {
    while (latest) {
      const value = latest; latest = undefined;
      try { await host.request("usage.health", { sessionId, health: value }); }
      catch { /* Record delivery failure will also carry health on the next change. */ }
    }
  }
  const recorder = createUsageDelivery(async (value) => {
    try {
      const reply = await host.request("usage.record", value);
      return typeof reply === "object" && reply !== null && (reply as { acknowledged?: unknown }).acknowledged === true;
    } catch (error) {
      // Main's sole writer has already retained this durable-write failure.
      // Throws/timeouts from the transport remain owned by this queue.
      if (error instanceof HostRpcError && error.code === "usage_failed") return false;
      throw error;
    }
  }, { negativeAckOwnsFailure: true, onHealth(value) {
    latest = value;
    if (!publishing) publishing = publish().finally(() => { publishing = undefined; });
  } });
  return { recorder, retry: () => recorder.retry(), async flush() { await recorder.flush(1500); await publishing; } };
}
