import { afterEach, describe, expect, it, vi } from "vitest";
import { AppError, type CompanyProfileFields, type CompanyProfileResult } from "@deepfield/contracts";
import { CompanyProfileEnrichmentService } from "./company-profile-enrichment-service.js";
import { profileResult } from "./company-profile-test-fixtures.js";
import { openTestDb, type TestDb } from "./application-test-helpers.js";
const dbs: TestDb[] = [];
afterEach(() => { for (const db of dbs.splice(0)) db.cleanup(); });
const database = () => { const db = openTestDb(); dbs.push(db); return db; };
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("company profile Agent queue", () => {
  it("clears old ambiguous evidence when a user retry fails for a new reason", async () => {
    const db = database(); const company = db.repos.companies.upsert({ name: "Ambiguous" }); let attempts = 0;
    const service = new CompanyProfileEnrichmentService(db.repos.companies, { prepare: async () => async () => {
      if (++attempts > 1) throw new AppError("EXTERNAL.TIMEOUT");
      return { ...profileResult({}), identity: { disposition: "ambiguous", reason: "同名主体待确认", sources: profileResult().identity.sources } };
    } });
    service.start(); await service.whenIdle();
    expect(db.repos.companies.getById(company.id)?.profileProvenance?.identity.disposition).toBe("ambiguous");
    service.retry(company.id); await service.whenIdle();
    expect(db.repos.companies.getById(company.id)).toMatchObject({ profileStatus: "failed", profileIssue: { code: "EXTERNAL.TIMEOUT" } });
    expect(db.repos.companies.getById(company.id)?.profileProvenance).toBeUndefined();
  });
  it.each(["delete", "dispose"])("never writes an in-flight result after %s", async (action) => {
    const db = database(); const company = db.repos.companies.upsert({ name: "Cancelled target" });
    let finish!: (result: CompanyProfileResult) => void;
    const complete = vi.spyOn(db.repos.companies, "completeProfile");
    const service = new CompanyProfileEnrichmentService(db.repos.companies, { prepare: async () => () => new Promise((resolve) => { finish = resolve; }) });
    service.start(); await flush();
    if (action === "delete") db.repos.companies.deleteIfUnreferenced(company.id); else service.dispose();
    finish(profileResult()); await service.whenIdle();
    expect(complete).not.toHaveBeenCalled();
    expect(db.repos.companies.getById(company.id)?.profileProvenance).toBeUndefined();
  });
  it("contains repository failure in the final queue probe and exposes a safe issue", async () => {
    const db = database();
    vi.spyOn(db.repos.companies, "getNextPendingProfile").mockReturnValueOnce(undefined).mockImplementation(() => { throw Error("database closed secret"); });
    const service = new CompanyProfileEnrichmentService(db.repos.companies, { prepare: async () => async () => profileResult() });
    service.start(); await expect(service.whenIdle()).resolves.toBeUndefined();
    expect(service.getIssue()).toMatchObject({ code: "STORAGE.FAILED" });
  });
  it("runs serially, fails once, and retries only the same company on user request", async () => {
    const db = database(); const first = db.repos.companies.upsert({ name: "First" }); const second = db.repos.companies.upsert({ name: "Second" });
    const calls: string[] = []; let active = 0; let maximum = 0; let succeed = false;
    const service = new CompanyProfileEnrichmentService(db.repos.companies, { prepare: async (company) => async () => {
      calls.push(company.name); maximum = Math.max(maximum, ++active); await flush(); active--;
      if (company.id === second.id && !succeed) throw new AppError("EXTERNAL.TIMEOUT");
      return profileResult();
    } });
    service.start(); await service.whenIdle();
    expect(calls).toEqual(["First", "Second"]); expect(maximum).toBe(1);
    expect(db.repos.companies.getById(first.id)?.profileStatus).toBe("ready");
    expect(db.repos.companies.getById(second.id)?.profileStatus).toBe("failed");
    succeed = true; expect(service.retry(second.id)).toBe(true); await service.whenIdle();
    expect(calls).toEqual(["First", "Second", "Second"]); expect(service.retry(first.id)).toBe(false);
  });
  it("confirms the same ambiguous company with a saved hint and retains it when the resumed run fails", async () => {
    const db = database(); const company = db.repos.companies.upsert({ name: "三星" });
    let rejectResume!: (error: Error) => void;
    const prepared: Array<{ id: string; name: string; hint: unknown }> = [];
    const service = new CompanyProfileEnrichmentService(db.repos.companies, { prepare: async (target) => {
      prepared.push({ id: target.id, name: target.name, hint: target.profileIdentityHint });
      if (prepared.length === 1) return async () => ({ ...profileResult({}), identity: { disposition: "ambiguous", reason: "存在多个同名主体", sources: profileResult().identity.sources } });
      return () => new Promise((_resolve, reject) => { rejectResume = reject; });
    } });
    const events: unknown[] = []; service.subscribe((event) => events.push(event));
    service.start(); await service.whenIdle();

    expect(service.confirmIdentity(company.id, { name: "三星电子株式会社", officialWebsite: "https://www.samsung.com/" })).toBe(true);
    await flush();
    expect(prepared[1]).toEqual({ id: company.id, name: "三星", hint: { name: "三星电子株式会社", officialWebsite: "https://www.samsung.com/" } });
    expect(events).toContainEqual({ companyId: company.id, status: "pending" });
    rejectResume(new AppError("EXTERNAL.TIMEOUT")); await service.whenIdle();
    expect(db.repos.companies.getById(company.id)).toMatchObject({
      profileStatus: "failed", profileIdentityHint: { name: "三星电子株式会社", officialWebsite: "https://www.samsung.com/" },
    });
    expect(service.confirmIdentity(company.id, { name: "修改后的主体" })).toBe(true);
  });
  it("does not confirm a missing, ready, or enriching company", async () => {
    const db = database(); const company = db.repos.companies.upsert({ name: "Ready" });
    const service = new CompanyProfileEnrichmentService(db.repos.companies, { prepare: async () => async () => profileResult() });
    expect(service.confirmIdentity("missing" as never, { name: "Missing" })).toBe(false);
    db.repos.companies.setProfileStatus(company.id, "enriching");
    expect(service.confirmIdentity(company.id, { name: "Running" })).toBe(false);
    db.repos.companies.update(company.id, { name: company.name });
    expect(service.confirmIdentity(company.id, { name: "Ready" })).toBe(false);
  });
  it("pauses public missing configuration once before claiming, persists guidance, and resumes after configuration applies", async () => {
    const db = database(); const first = db.repos.companies.upsert({ name: "First" }); const second = db.repos.companies.upsert({ name: "Second" });
    let configured = false; const run = vi.fn(async () => profileResult());
    const prepare = vi.fn(async () => { if (!configured) throw new AppError("CONFIG.CREDENTIAL_MISSING", { service: "search" }); return run; });
    const service = new CompanyProfileEnrichmentService(db.repos.companies, { prepare });
    const events: unknown[] = []; service.subscribe((event) => events.push(event));
    service.start(); await service.whenIdle(); service.resume(); await flush();
    expect(prepare).toHaveBeenCalledTimes(1); expect(run).not.toHaveBeenCalled(); expect(events).toHaveLength(1);
    expect(db.repos.companies.getById(first.id)).toMatchObject({ profileStatus: "pending", profileIssue: { code: "CONFIG.CREDENTIAL_MISSING" } });
    expect(db.repos.companies.getById(second.id)?.profileStatus).toBe("pending");
    db.repos.companies.deleteIfUnreferenced(first.id);
    expect(service.getIssue()).toMatchObject({ code: "CONFIG.CREDENTIAL_MISSING" });
    configured = true; service.configurationChanged(); await service.whenIdle();
    expect(run).toHaveBeenCalledTimes(1); expect(service.getIssue()).toBeUndefined();
    expect(db.repos.companies.getById(first.id)?.profileIssue).toBeUndefined();
  });
  it("recovers enriching work and stops before fetching the next company when research takes foreground", async () => {
    const db = database(); const first = db.repos.companies.upsert({ name: "First" }); const second = db.repos.companies.upsert({ name: "Second" });
    db.repos.companies.setProfileStatus(first.id, "enriching"); let busy = true;
    const run = vi.fn(async () => { busy = true; return profileResult(); });
    const service = new CompanyProfileEnrichmentService(db.repos.companies, { prepare: async () => run }, { isForegroundBusy: () => busy });
    service.start(); await service.whenIdle(); expect(run).not.toHaveBeenCalled();
    busy = false; service.resume(); await service.whenIdle(); expect(run).toHaveBeenCalledTimes(1);
    expect(db.repos.companies.getById(second.id)?.profileStatus).toBe("pending");
  });
  it.each(["success", "failure"])("manual edit wins over late %s and discards old provenance", async (outcome) => {
    const db = database(); const company = db.repos.companies.upsert({ name: "Edited" });
    let resolve!: (value: CompanyProfileResult) => void; let reject!: (error: Error) => void;
    const service = new CompanyProfileEnrichmentService(db.repos.companies, { prepare: async () => () => new Promise((yes, no) => { resolve = yes; reject = no; }) });
    service.start(); await flush(); db.repos.companies.update(company.id, { name: "Edited", headquarters: "手工地点" });
    if (outcome === "success") resolve(profileResult()); else reject(new Error("secret"));
    await service.whenIdle(); expect(db.repos.companies.getById(company.id)).toMatchObject({ profileStatus: "ready", headquarters: "手工地点" });
    expect(db.repos.companies.getById(company.id)?.profileProvenance).toBeUndefined();
  });
  it("merges only missing fields atomically and stores ambiguous identity as needs confirmation, never ready", async () => {
    const db = database(); const first = db.repos.companies.upsert({ name: "First" }); const second = db.repos.companies.upsert({ name: "Ambiguous" });
    db.repos.companies.update(first.id, { name: "First", headquarters: "已知地点" }); db.repos.companies.setProfileStatus(first.id, "pending");
    const service = new CompanyProfileEnrichmentService(db.repos.companies, { prepare: async (company) => async () => company.id === first.id
      ? profileResult({ headquarters: "新地点", legalName: "确认全称" })
      : { ...profileResult({}), identity: { disposition: "ambiguous", reason: "同名主体待确认", sources: profileResult().identity.sources } } });
    service.start(); await service.whenIdle();
    expect(db.repos.companies.getById(first.id)).toMatchObject({ headquarters: "已知地点", legalName: "确认全称", profileProvenance: { fields: { legalName: "确认全称" } } });
    expect(db.repos.companies.getById(first.id)?.profileProvenance?.fieldEvidence).not.toHaveProperty("headquarters");
    expect(db.repos.companies.getById(second.id)).toMatchObject({ profileStatus: "failed", profileProvenance: { identity: { disposition: "ambiguous" } } });
  });
  it.each<CompanyProfileFields>([{ aliases: [" "] }, { businessTags: [" "] }, { stockListings: [{ exchange: " ", ticker: "X" }] }, { foundedAt: "2024-02-31" }, { officialWebsite: "ftp://example.test" }, { headquarters: "English only" }, {}])("rejects invalid automatic fields without whole-run retry: %j", async (fields) => {
    const db = database(); const company = db.repos.companies.upsert({ name: "Invalid" }); const run = vi.fn(async () => profileResult(fields));
    const service = new CompanyProfileEnrichmentService(db.repos.companies, { prepare: async () => run }); service.start(); await service.whenIdle();
    expect(run).toHaveBeenCalledTimes(1); expect(db.repos.companies.getById(company.id)?.profileStatus).toBe("failed");
  });
  it("isolates listeners/diagnostics and reports only safe typed errors", async () => {
    const db = database(); db.repos.companies.upsert({ name: "Safe" }); const diagnostics: unknown[] = []; const contexts: unknown[] = [];
    const service = new CompanyProfileEnrichmentService(db.repos.companies, { prepare: async (_company, topics) => { contexts.push(topics); return async () => { throw Object.assign(new Error("sk-secret"), { code: "sk-secret" }); }; } }, { getResearchTopics: () => ["  机器人 ", "机器人"], onFailure: (failure) => { diagnostics.push(failure); throw Error("logger"); } });
    service.subscribe(() => { throw Error("closed"); }); service.start(); await service.whenIdle();
    expect(contexts).toEqual([["机器人"]]); expect(diagnostics).toEqual([expect.objectContaining({ code: "INTERNAL.UNKNOWN", attempts: 1 })]); expect(JSON.stringify(diagnostics)).not.toContain("secret");
  });
});
