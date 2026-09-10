import { afterEach, describe, expect, it } from "vitest";
import type { CompanyProfileFields } from "@deepfield/contracts";
import { CompanyProfileEnrichmentService } from "./company-profile-enrichment-service.js";
import { openTestDb, type TestDb } from "./application-test-helpers.js";

const dbs: TestDb[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) db.cleanup();
});

describe("CompanyProfileEnrichmentService", () => {
  it("runs the persisted queue serially and isolates per-company failures", async () => {
    const db = openTestDb();
    dbs.push(db);
    const first = db.repos.companies.upsert({ name: "First" });
    const second = db.repos.companies.upsert({ name: "Second" });
    let active = 0;
    let maxActive = 0;
    const calls: string[] = [];
    const completer = {
      complete: async (name: string): Promise<CompanyProfileFields> => {
        calls.push(name);
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise<void>((resolve) => setImmediate(resolve));
        active -= 1;
        if (name === "Second") {
          throw Object.assign(new Error("provider secret"), { code: "network_error" });
        }
        return {
          aliases: [],
          headquarters: "波士顿，美国",
          officialWebsite: null,
          stockListings: [],
          businessTags: ["Robotics"],
        };
      },
    };
    const events: Array<{ companyId: string; status: string }> = [];
    const service = new CompanyProfileEnrichmentService(db.repos.companies, completer, {
      onFailure: () => {},
    });
    service.subscribe((event) => events.push(event));

    service.start();
    await service.whenIdle();

    expect(calls).toEqual(["First", "Second", "Second"]);
    expect(maxActive).toBe(1);
    expect(db.repos.companies.getById(first.id)).toMatchObject({
      profileStatus: "ready",
      aliases: [],
      officialWebsite: null,
      stockListings: [],
    });
    expect(db.repos.companies.getById(second.id)?.profileStatus).toBe("failed");
    expect(events).toEqual([
      { companyId: first.id, status: "enriching" },
      { companyId: first.id, status: "ready" },
      { companyId: second.id, status: "enriching" },
      { companyId: second.id, status: "failed" },
    ]);
  });

  it("recovers interrupted work and pauses subsequent jobs for foreground research", async () => {
    const db = openTestDb();
    dbs.push(db);
    const first = db.repos.companies.upsert({ name: "First" });
    db.repos.companies.setProfileStatus(first.id, "enriching");
    let foregroundBusy = true;
    const calls: string[] = [];
    const service = new CompanyProfileEnrichmentService(
      db.repos.companies,
      { complete: async (name) => { calls.push(name); return {}; } },
      { isForegroundBusy: () => foregroundBusy },
    );

    service.start();
    await service.whenIdle();
    expect(db.repos.companies.getById(first.id)?.profileStatus).toBe("pending");
    expect(calls).toEqual([]);

    foregroundBusy = false;
    service.resume();
    await service.whenIdle();
    expect(calls).toEqual(["First"]);
    expect(db.repos.companies.getById(first.id)?.profileStatus).toBe("ready");
  });

  it("rejects every semantically invalid automatic field and never writes partial bad data", async () => {
    const db = openTestDb();
    dbs.push(db);
    const invalidProfiles: Record<string, CompanyProfileFields> = {
      "Blank Alias": { aliases: [" "] },
      "Blank Tag": { businessTags: [" "] },
      "Blank Listing": { stockListings: [{ exchange: " ", ticker: "ACME" }] },
      "Invalid Date": { foundedAt: "2024-02-31" },
      "Invalid Website": { officialWebsite: "ftp://example.com" },
    };
    const invalid = Object.keys(invalidProfiles).map((name) =>
      db.repos.companies.upsert({ name }),
    );
    const service = new CompanyProfileEnrichmentService(db.repos.companies, {
      complete: async (name) => invalidProfiles[name]!,
    });
    service.start();
    await service.whenIdle();

    for (const company of invalid) {
      expect(db.repos.companies.getById(company.id)).toEqual({
        ...company,
        profileStatus: "failed",
        updatedAt: expect.any(String),
      });
    }
  });

  it("trims valid automatic fields and never overwrites a manual edit after failure", async () => {
    const db = openTestDb();
    dbs.push(db);
    const valid = db.repos.companies.upsert({ name: "Valid" });
    const edited = db.repos.companies.upsert({ name: "Edited" });
    let rejectEdited: ((reason: Error) => void) | undefined;
    const service = new CompanyProfileEnrichmentService(db.repos.companies, {
      complete: async (name) => {
        if (name === "Valid") return {
          aliases: [" Alias "],
          headquarters: " 上海，中国 ",
          foundedAt: "2024-02-29",
          officialWebsite: " https://example.com ",
          stockListings: [{ exchange: " NYSE ", ticker: " ACME " }],
          businessTags: [" Robotics "],
        };
        return new Promise((_resolve, reject) => { rejectEdited = reject; });
      },
    });
    service.start();
    while (db.repos.companies.getById(edited.id)?.profileStatus !== "enriching") {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    db.repos.companies.update(edited.id, { name: "Edited", headquarters: "Shanghai" });
    rejectEdited?.(new Error("provider failed"));
    await service.whenIdle();

    expect(db.repos.companies.getById(valid.id)).toMatchObject({
      profileStatus: "ready",
      aliases: ["Alias"],
      headquarters: "上海，中国",
      foundedAt: "2024-02-29",
      officialWebsite: "https://example.com",
      stockListings: [{ exchange: "NYSE", ticker: "ACME" }],
      businessTags: ["Robotics"],
    });
    expect(db.repos.companies.getById(edited.id)).toMatchObject({
      profileStatus: "ready",
      headquarters: "Shanghai",
    });
  });

  it("retries a transient completion failure once before saving a successful profile", async () => {
    const db = openTestDb();
    dbs.push(db);
    const company = db.repos.companies.upsert({ name: "Retry Me" });
    let attempts = 0;
    const service = new CompanyProfileEnrichmentService(db.repos.companies, {
      complete: async () => {
        attempts += 1;
        if (attempts === 1) throw Object.assign(new Error("temporary"), { code: "network_error" });
        return { headquarters: "上海，中国", businessTags: ["机器人"] };
      },
    });

    service.start();
    await service.whenIdle();

    expect(attempts).toBe(2);
    expect(db.repos.companies.getById(company.id)).toMatchObject({
      profileStatus: "ready",
      headquarters: "上海，中国",
    });
  });

  it("rejects an English-only automatic headquarters and retries for a Chinese value", async () => {
    const db = openTestDb();
    dbs.push(db);
    const company = db.repos.companies.upsert({ name: "Google" });
    let attempts = 0;
    const service = new CompanyProfileEnrichmentService(db.repos.companies, {
      complete: async () => {
        attempts += 1;
        return attempts === 1
          ? { headquarters: "Mountain View, California, USA", businessTags: ["人工智能"] }
          : { headquarters: "山景城，美国", businessTags: ["人工智能"] };
      },
    });

    service.start();
    await service.whenIdle();

    expect(attempts).toBe(2);
    expect(db.repos.companies.getById(company.id)).toMatchObject({
      profileStatus: "ready",
      headquarters: "山景城，美国",
    });
  });

  it("requeues a failed company only when the user explicitly retries it", async () => {
    const db = openTestDb();
    dbs.push(db);
    const company = db.repos.companies.upsert({ name: "乐奇" });
    db.repos.companies.setProfileStatus(company.id, "failed");
    const events: string[] = [];
    const service = new CompanyProfileEnrichmentService(db.repos.companies, {
      complete: async () => ({ headquarters: "深圳，中国", businessTags: ["智能眼镜"] }),
    });
    service.subscribe((event) => events.push(event.status));

    expect(service.retry(company.id)).toBe(true);
    await service.whenIdle();

    expect(events).toEqual(["pending", "enriching", "ready"]);
    expect(db.repos.companies.getById(company.id)).toMatchObject({
      profileStatus: "ready",
      headquarters: "深圳，中国",
    });
    expect(service.retry(company.id)).toBe(false);
  });

  it("passes research topics for disambiguation and reports only sanitized failure details", async () => {
    const db = openTestDb();
    dbs.push(db);
    const company = db.repos.companies.upsert({ name: "乐奇" });
    const contexts: unknown[] = [];
    const failures: unknown[] = [];
    const service = new CompanyProfileEnrichmentService(
      db.repos.companies,
      {
        complete: async (_name, context) => {
          contexts.push(context);
          throw Object.assign(new Error("raw provider response and secret"), {
            code: "schema_invalid",
            httpStatus: 200,
            fields: ["stockListings"],
          });
        },
      },
      {
        getResearchTopics: () => ["人形机器人"],
        onFailure: (failure) => failures.push(failure),
      },
    );

    service.start();
    await service.whenIdle();

    expect(contexts).toEqual([
      { researchTopics: ["人形机器人"] },
      { researchTopics: ["人形机器人"] },
    ]);
    expect(failures).toEqual([{
      companyId: company.id,
      code: "schema_invalid",
      httpStatus: 200,
      fields: ["stockListings"],
      attempts: 2,
    }]);
    expect(JSON.stringify(failures)).not.toContain("raw provider response");
    expect(db.repos.companies.getById(company.id)?.profileStatus).toBe("failed");
  });

  it("does not retry a missing API key and reports the actual attempt count", async () => {
    const db = openTestDb();
    dbs.push(db);
    const company = db.repos.companies.upsert({ name: "No Key" });
    let attempts = 0;
    const failures: Array<{ attempts: number }> = [];
    const service = new CompanyProfileEnrichmentService(
      db.repos.companies,
      {
        complete: async () => {
          attempts += 1;
          throw Object.assign(new Error("missing"), { code: "missing_api_key" });
        },
      },
      { onFailure: (failure) => failures.push(failure) },
    );

    service.start();
    await service.whenIdle();

    expect(attempts).toBe(1);
    expect(failures).toEqual([expect.objectContaining({
      companyId: company.id,
      attempts: 1,
    })]);
  });

  it("keeps the provider's sanitized incomplete reason in failure diagnostics", async () => {
    const db = openTestDb();
    dbs.push(db);
    const company = db.repos.companies.upsert({ name: "乐奇" });
    const failures: unknown[] = [];
    const service = new CompanyProfileEnrichmentService(
      db.repos.companies,
      {
        complete: async () => {
          throw Object.assign(new Error("provider body must stay private"), {
            code: "response_incomplete",
            httpStatus: 200,
            incompleteReason: "max_output_tokens",
          });
        },
      },
      { onFailure: (failure) => failures.push(failure) },
    );

    service.start();
    await service.whenIdle();

    expect(failures).toEqual([{
      companyId: company.id,
      code: "response_incomplete",
      httpStatus: 200,
      incompleteReason: "max_output_tokens",
      attempts: 2,
    }]);
    expect(JSON.stringify(failures)).not.toContain("provider body must stay private");
  });

  it("maps an untrusted incomplete reason to a bounded diagnostic value", async () => {
    const db = openTestDb();
    dbs.push(db);
    db.repos.companies.upsert({ name: "Untrusted" });
    const failures: unknown[] = [];
    const service = new CompanyProfileEnrichmentService(
      db.repos.companies,
      {
        complete: async () => {
          throw Object.assign(new Error("private"), {
            code: "response_incomplete",
            incompleteReason: "raw provider text with sk-secret",
          });
        },
      },
      { onFailure: (failure) => failures.push(failure) },
    );

    service.start();
    await service.whenIdle();

    expect(failures).toEqual([expect.objectContaining({ incompleteReason: "unknown" })]);
    expect(JSON.stringify(failures)).not.toContain("sk-secret");
  });

  it("keeps processing and notifying healthy listeners when another listener throws", async () => {
    const db = openTestDb();
    dbs.push(db);
    const company = db.repos.companies.upsert({ name: "Listener Race" });
    const events: string[] = [];
    const service = new CompanyProfileEnrichmentService(db.repos.companies, {
      complete: async () => ({ headquarters: "北京，中国", businessTags: ["机器人"] }),
    });
    service.subscribe(() => { throw new Error("renderer destroyed"); });
    service.subscribe((event) => events.push(event.status));

    service.start();
    await service.whenIdle();

    expect(db.repos.companies.getById(company.id)?.profileStatus).toBe("ready");
    expect(events).toEqual(["enriching", "ready"]);
  });

  it("retries an HTTP 408 completion response once", async () => {
    const db = openTestDb();
    dbs.push(db);
    db.repos.companies.upsert({ name: "Request Timeout" });
    let attempts = 0;
    const service = new CompanyProfileEnrichmentService(
      db.repos.companies,
      {
        complete: async () => {
          attempts += 1;
          throw Object.assign(new Error("request timeout"), {
            code: "http_error",
            httpStatus: 408,
          });
        },
      },
      { onFailure: () => {} },
    );

    service.start();
    await service.whenIdle();

    expect(attempts).toBe(2);
  });

  it("marks a company failed even when diagnostic logging throws", async () => {
    const db = openTestDb();
    dbs.push(db);
    const company = db.repos.companies.upsert({ name: "Logger Race" });
    const service = new CompanyProfileEnrichmentService(
      db.repos.companies,
      {
        complete: async () => {
          throw Object.assign(new Error("network"), { code: "network_error" });
        },
      },
      { onFailure: () => { throw new Error("logger unavailable"); } },
    );

    service.start();
    await service.whenIdle();

    expect(db.repos.companies.getById(company.id)?.profileStatus).toBe("failed");
  });
});
