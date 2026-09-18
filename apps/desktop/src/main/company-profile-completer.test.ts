import { describe, expect, it, vi } from "vitest";
import { AppError, type Company, type CompanyProfileWorkerRequest } from "@deepfield/contracts";
import { createCompanyProfileCompleter } from "./company-profile-completer.js";
import { rawResearchRequest } from "../worker/capabilities/company-research/company-research-test-helpers.js";
import { profileResult } from "../../../../packages/application/src/testing/company-profile-test-fixtures.js";
import { AgentWorkerClient } from "./agent-worker-client.js";
import { createWorkerMessageLoop } from "../worker/message-loop.js";
import { FakeEndpoint } from "./agent-worker-client-test-helpers.js";
import { echoAgent, InMemoryEndpoint } from "../worker/message-loop-test-helpers.js";

const company: Company = { id: "company-1" as Company["id"], name: "测试", normalizedName: "测试", profileStatus: "pending", headquarters: "已有地点", profileIdentityHint: { name: "测试主体有限公司", officialWebsite: "https://example.test" }, createdAt: "", updatedAt: "" };
describe("profile main/worker typed boundary", () => {
  it("uses both active snapshots, existing fields and topics; never persists a chat or report identity", async () => {
    const raw = rawResearchRequest(); const main = new FakeEndpoint(); const utility = new InMemoryEndpoint();
    main.postMessage = (value) => utility.emit(value); utility.postMessage = (value) => main.emit(value);
    const received: CompanyProfileWorkerRequest[] = [];
    const loop = createWorkerMessageLoop(utility, echoAgent, { profileAgent: { async run(request, emit) {
      received.push(request); emit({ kind: "company-profile.event", requestId: request.requestId, companyId: request.companyId, type: "completed", result: profileResult() });
    } } });
    const client = new AgentWorkerClient(main);
    const profiles = { resolveActiveLlm: vi.fn(async () => raw.llm), resolveActiveSearch: vi.fn(async () => raw.search) };
    try {
      const run = await createCompanyProfileCompleter(profiles, client).prepare(company, ["机器人"]);
      expect(received).toEqual([]);
      await expect(run()).resolves.toEqual(profileResult());
      expect(received).toEqual([expect.objectContaining({ kind: "company-profile.enrich", companyId: company.id, existingFields: { headquarters: "已有地点" }, identityHint: company.profileIdentityHint, llm: raw.llm, search: raw.search, researchTopics: ["机器人"] })]);
      expect(received[0]).not.toHaveProperty("conversationId"); expect(received[0]).not.toHaveProperty("runId");
      expect(client.pendingCount()).toBe(0); expect(loop.activeCount()).toBe(0);
    } finally { loop.dispose(); client.dispose(); }
  });
  it("rejects missing Search credentials before dispatch", async () => {
    const sendProfile = vi.fn(); const raw = rawResearchRequest();
    const completer = createCompanyProfileCompleter({ resolveActiveLlm: async () => raw.llm, resolveActiveSearch: async () => { throw new AppError("CONFIG.CREDENTIAL_MISSING", { service: "search" }); } }, { sendProfile });
    await expect(completer.prepare(company, [])).rejects.toMatchObject({ code: "CONFIG.CREDENTIAL_MISSING", context: { service: "search" } });
    expect(sendProfile).not.toHaveBeenCalled();
  });
  it("persists the correlated diagnostic without treating it as terminal and retains worker failure identity", async () => {
    const raw = rawResearchRequest(); const main = new FakeEndpoint(); const utility = new InMemoryEndpoint();
    main.postMessage = (value) => utility.emit(value); utility.postMessage = (value) => main.emit(value);
    const record = vi.fn();
    const loop = createWorkerMessageLoop(utility, echoAgent, { profileAgent: { async run(request, emit) {
      const identity = { kind: "company-profile.event" as const, requestId: request.requestId, companyId: request.companyId };
      emit({ ...identity, type: "diagnostic", phase: "schema", code: "schema_invalid", schemaIssues: [{ path: "/fieldEvidence/legalName/0", expected: "object", actual: "string" }], searchSourceCount: 1, openedSourceCount: 0, searchToolCalls: 1, readToolCalls: 0, outputChars: 100 });
      emit({ ...identity, type: "failed", code: "invalid_evidence" });
    } } });
    const client = new AgentWorkerClient(main);
    try {
      const run = await createCompanyProfileCompleter({ resolveActiveLlm: async () => raw.llm, resolveActiveSearch: async () => raw.search }, client, record).prepare(company, []);
      await expect(run()).rejects.toMatchObject({ code: "EXTERNAL.INVALID_RESPONSE", context: { service: "llm" }, companyId: company.id, requestId: expect.any(String), failureCode: "invalid_evidence" });
      expect(record).toHaveBeenCalledOnce();
      expect(record.mock.calls[0]?.[0]).toMatchObject({ companyId: company.id, code: "schema_invalid", requestId: expect.any(String) });
      expect(client.pendingCount()).toBe(0); expect(loop.activeCount()).toBe(0);
    } finally { loop.dispose(); client.dispose(); }
  });
  it("keeps non-format evidence failures on the ordinary external failure path", async () => {
    const raw = rawResearchRequest();
    const sendProfile = vi.fn(async function* (request: CompanyProfileWorkerRequest) {
      const identity = { kind: "company-profile.event" as const, requestId: request.requestId, companyId: request.companyId };
      yield { ...identity, type: "diagnostic" as const, phase: "evidence" as const, code: "source_missing" as const, schemaIssues: [], searchSourceCount: 1, openedSourceCount: 0, searchToolCalls: 1, readToolCalls: 0, outputChars: 100 };
      yield { ...identity, type: "failed" as const, code: "invalid_evidence" as const };
    });
    const run = await createCompanyProfileCompleter({ resolveActiveLlm: async () => raw.llm, resolveActiveSearch: async () => raw.search }, { sendProfile }).prepare(company, []);
    await expect(run()).rejects.toMatchObject({ code: "EXTERNAL.UNAVAILABLE" });
  });
  it("rejects foreign company terminal events instead of accepting unrelated provenance", async () => {
    const raw = rawResearchRequest(); const endpoint = new FakeEndpoint(); const client = new AgentWorkerClient(endpoint);
    const stream = client.sendProfile({ kind: "company-profile.enrich", requestId: "r1", companyId: "c1", name: "测试", existingFields: {}, researchTopics: [], llm: raw.llm, search: raw.search });
    endpoint.emit({ kind: "company-profile.event", requestId: "r1", companyId: "other", type: "completed", result: profileResult() });
    await expect(stream[Symbol.asyncIterator]().next()).rejects.toThrow("invalid protocol"); client.dispose();
  });
});
