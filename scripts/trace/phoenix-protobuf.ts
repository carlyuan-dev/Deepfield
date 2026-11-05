import protobuf from "protobufjs";

// Adapted field subset from opentelemetry-proto v1.9.0 (trace/common/resource/collector).
// https://github.com/open-telemetry/opentelemetry-proto/tree/v1.9.0/opentelemetry/proto
// Copyright 2019, OpenTelemetry Authors. Licensed under the Apache License, Version 2.0.
// You may obtain the License at https://www.apache.org/licenses/LICENSE-2.0
// Distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND.
// See the License for the specific language governing permissions and limitations.
// Changes: flattened messages, omitted unused fields/options, enum wire types as int32.
// Only fields emitted by the metadata projection are declared; protobufjs owns encoding.
const schema = protobuf.parse(`syntax = "proto3";
message AnyValue { string string_value = 1; int64 int_value = 3; }
message KeyValue { string key = 1; AnyValue value = 2; }
message Resource { repeated KeyValue attributes = 1; }
message Scope { string name = 1; string version = 2; }
message Status { string message = 2; int32 code = 3; }
message Event { fixed64 time_unix_nano = 1; string name = 2; repeated KeyValue attributes = 3; }
message Link { bytes trace_id = 1; bytes span_id = 2; }
message Span {
  bytes trace_id = 1; bytes span_id = 2; bytes parent_span_id = 4;
  string name = 5; int32 kind = 6; fixed64 start_time_unix_nano = 7;
  fixed64 end_time_unix_nano = 8; repeated KeyValue attributes = 9;
  repeated Event events = 11; repeated Link links = 13; Status status = 15;
}
message ScopeSpans { Scope scope = 1; repeated Span spans = 2; }
message ResourceSpans { Resource resource = 1; repeated ScopeSpans scope_spans = 2; }
message ExportTraceServiceRequest { repeated ResourceSpans resource_spans = 1; }
message PartialSuccess { int64 rejected_spans = 1; string error_message = 2; }
message ExportTraceServiceResponse { PartialSuccess partial_success = 1; }
`).root;
const requestType = schema.lookupType("ExportTraceServiceRequest");
const responseType = schema.lookupType("ExportTraceServiceResponse");
export function encodePhoenix(body: { resourceSpans: { resource: unknown; scopeSpans: { scope: unknown; spans: { traceId: string; spanId: string; parentSpanId?: string; links: { traceId: string; spanId: string }[] }[] }[] }[] }) {
  const ids = (v: { traceId: string; spanId: string }) => ({ ...v, traceId: Buffer.from(v.traceId, "hex"), spanId: Buffer.from(v.spanId, "hex") });
  const wire = { resourceSpans: body.resourceSpans.map(r => ({ ...r, scopeSpans: r.scopeSpans.map(s => ({ ...s, spans: s.spans.map(v => ({ ...ids(v),
    ...(v.parentSpanId ? { parentSpanId: Buffer.from(v.parentSpanId, "hex") } : {}), links: v.links.map(ids) })) })) })) };
  return requestType.encode(requestType.fromObject(wire)).finish();
}
export function decodePhoenixResponse(bytes: Uint8Array) {
  return responseType.toObject(responseType.decode(bytes), { longs: String }) as { partialSuccess?: { rejectedSpans?: string; errorMessage?: string } };
}
