import { afterEach, describe, expect, it } from "vitest";
import type {
  CompanyResearchWorkerEvent,
  CompanyResearchWorkerRequest,
} from "@deepfield/contracts";
import { CompanyResearchService, CompanyResearchServiceError } from "./company-research-service.js";
import { openTestDb, type TestDb } from "./application-test-helpers.js";

const dbs: TestDb[] = [];

afterEach(() => {
  for (const db of dbs.splice(0)) db.cleanup();
});

function fixture() {
  const db = openTestDb();
  dbs.push(db);
  const item = db.repos.capabilityItems.create({
    industry: "智能眼镜",
    researchScope: "中国消费级市场",
  });
  const company = db.repos.companies.upsert({
    name: "小米",
  });
  const profiledCompany = db.repos.companies.update(company.id, {
    name: "小米",
    legalName: "小米集团",
    aliases: ["Xiaomi"],
    headquarters: "中国北京",
    foundedAt: "2010-04-06",
    officialWebsite: "https://www.mi.com",
    stockListings: [{ exchange: "HKEX", ticker: "1810" }],
    businessTags: ["消费电子", "智能硬件"],
  })!;
  db.repos.itemCompanies.add(item.id, company.id, "重点候选");
  return { db, item, company: profiledCompany };
}

function serviceWith(
  db: TestDb,
  sendResearch: (request: CompanyResearchWorkerRequest) => AsyncIterable<CompanyResearchWorkerEvent>,
  cancelResearch: (requestId: string, runId: string) => void = () => {},
) {
  return new CompanyResearchService(
    db.repos,
    { get: () => "sk-test" },
    { sendResearch, cancelResearch },
    {
      requestIdFactory: () => "research-request-1",
      now: () => new Date("2026-09-09T08:00:00.000Z"),
    },
  );
}

async function flushBackground(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe("CompanyResearchService", () => {
  it("persists one completed report from the item-company snapshot", async () => {
    const { db, item, company } = fixture();
    let captured: CompanyResearchWorkerRequest | undefined;
    const service = serviceWith(db, (request) => {
      captured = request;
      return (async function* () {
        yield { requestId: request.requestId, runId: request.runId, type: "started" } as const;
        yield {
          requestId: request.requestId,
          runId: request.runId,
          type: "text_delta",
          delta: "报告",
        } as const;
        yield {
          requestId: request.requestId,
          runId: request.runId,
          type: "completed",
          text: "完整报告",
        } as const;
      })();
    });

    const run = service.start(item.id, company.id, {
      timeScope: "近一年",
      customRequirements: "关注新品",
    });
    await flushBackground();

    expect(captured?.context).toEqual({
      currentDate: "2026-09-09",
      companyName: "小米",
      legalName: "小米集团",
      aliases: ["Xiaomi"],
      headquarters: "中国北京",
      foundedAt: "2010-04-06",
      officialWebsite: "https://www.mi.com",
      stockListings: [{ exchange: "HKEX", ticker: "1810" }],
      businessTags: ["消费电子", "智能硬件"],
      industry: "智能眼镜",
      researchScope: "中国消费级市场",
      companyNote: "重点候选",
      timeScope: "近一年",
      customRequirements: "关注新品",
    });
    expect(service.getState(item.id, company.id)).toEqual({
      completed: [expect.objectContaining({ id: run.id, status: "completed", reportText: "完整报告" })],
    });
    expect(db.repos.companies.getById(company.id)).toEqual(company);
  });

  it("removes every non-success run and rejects a global second start", async () => {
    const { db, item, company } = fixture();
    let releaseCancel: (() => void) | undefined;
    let requestCount = 0;
    const service = serviceWith(
      db,
      (request) => {
        requestCount += 1;
        if (requestCount === 1) {
          return (async function* () {
            yield {
              requestId: request.requestId,
              runId: request.runId,
              type: "failed",
              code: "research_failed",
              message: "company research failed",
            } as const;
          })();
        }
        return (async function* () {
          yield { requestId: request.requestId, runId: request.runId, type: "started" } as const;
          yield {
            requestId: request.requestId,
            runId: request.runId,
            type: "text_delta",
            delta: "内存草稿",
          } as const;
          await new Promise<void>((resolve) => {
            releaseCancel = resolve;
          });
          yield { requestId: request.requestId, runId: request.runId, type: "cancelled" } as const;
        })();
      },
      () => releaseCancel?.(),
    );

    service.start(item.id, company.id, { timeScope: "近一年" });
    await flushBackground();
    expect(db.repos.companyResearchRuns.getRunning()).toBeUndefined();

    const active = service.start(item.id, company.id, { timeScope: "近三个月" });
    await flushBackground();
    expect(service.getState(item.id, company.id).active).toEqual({
      run: active,
      draftText: "内存草稿",
    });
    expect(() => service.start(item.id, company.id, { timeScope: "不限时间" })).toThrow(
      CompanyResearchServiceError,
    );
    await service.cancel(active.id);

    expect(db.repos.companyResearchRuns.getRunning()).toBeUndefined();
    expect(service.getState(item.id, company.id)).toEqual({ completed: [] });
  });
});
