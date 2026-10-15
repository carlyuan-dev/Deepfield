import { expectTypeOf, it } from "vitest";
import type { ModelRequestObservation, ModelRequestObservationInput, ModelRequestObserver, ModelToolOrigin } from "@deepfield/capability-sdk";
import type { ModelGateway, ModelStream, ObservedStreamOptions } from "./index.js";

it("keeps SDK origin and phase exact through the stream options and observer", () => {
  expectTypeOf<ModelRequestObservation["phase"]>().toEqualTypeOf<"ordinary" | "synthesis">();
  expectTypeOf<ModelRequestObservationInput["origins"][number]["origin"]>().toEqualTypeOf<ModelToolOrigin>();
  expectTypeOf<ModelRequestObserver>().parameter(0).toEqualTypeOf<ModelRequestObservation>();
  expectTypeOf<NonNullable<ModelGateway<ModelToolOrigin, "ordinary" | "synthesis">["createStream"]>>().returns.toEqualTypeOf<ModelStream<ModelToolOrigin, "ordinary" | "synthesis">>();
});

// Checked by repository tsc; never dispatched to a provider.
function rejectMismatches(gateway: ModelGateway<ModelToolOrigin, "ordinary" | "synthesis">, snapshot: Parameters<typeof gateway.createModel>[0]) {
  const stream = gateway.createStream!(snapshot);
  const model = gateway.createModel(snapshot);
  // @ts-expect-error SDK phases are not arbitrary strings.
  stream(model, { messages: [] }, { requestObservation: { requestId: "r", phase: "other", origins: [] } });
  const wrong: ObservedStreamOptions<{ other: number }, "ordinary"> = { requestObservation: { requestId: "r", phase: "ordinary", origins: [] } };
  // @ts-expect-error A stream's origin must match its observer origin.
  stream(model, { messages: [] }, wrong);
  // @ts-expect-error Observers with a different origin cannot attach to the SDK gateway.
  gateway.createStream!(snapshot, (_event: import("./index.js").ModelRequestObservation<{ other: number }, "ordinary">) => {});
}
void rejectMismatches;
