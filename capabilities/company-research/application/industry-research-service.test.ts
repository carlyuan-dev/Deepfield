import { afterEach, describe, expect, it, vi } from "vitest";
import { getCompanyResearchTemplate, type CompanyDraft } from "../contracts/index.js";
import { IndustryResearchService } from "./industry-research-service.js";
import { CompanyProfileEnrichmentService } from "./company-profile-enrichment-service.js";
import { openTestDb, type TestDb } from "../../../packages/application/src/testing/application-test-helpers.js";

const dbs: TestDb[] = [];

afterEach(() => {
  for (const db of dbs.splice(0)) {
    db.cleanup();
  }
});

describe("IndustryResearchService", () => {
  it("keeps a committed import successful when starting automatic enrichment fails", () => {
    const db = openTestDb(); dbs.push(db);
    const item = db.repos.capabilityItems.create({ industry: "机器人" });
    const enqueue = vi.fn(() => { throw new Error("profile queue unavailable"); });
    const service = new IndustryResearchService(db.repos, { recognize: async () => [] }, { enqueue });
    const added = service.addCompanies(item.id, [{ name: "甲公司" }]);
    expect(added).toHaveLength(1);
    expect(enqueue).toHaveBeenCalledOnce();
    expect(service.listCompanies(item.id)[0]).toMatchObject({ name: "甲公司", profileStatus: "pending" });
  });
  it.each([
    { removedReady: true, expectedProcessed: 2 },
    { removedReady: false, expectedProcessed: 3 },
  ])("publishes recalculated progress after removing a company (ready=$removedReady)", ({ removedReady, expectedProcessed }) => {
    const db = openTestDb(); dbs.push(db);
    const item = db.repos.capabilityItems.create({ industry: "机器人" });
    const companies = Array.from({ length: 9 }, (_, index) => db.repos.companies.upsert({ name: `公司${index}` }));
    for (const company of companies) db.repos.itemCompanies.add(item.id, company.id);
    const enrichment = new CompanyProfileEnrichmentService(db.repos.companies, { prepare: async () => async () => { throw Error("not called"); } }, {
      isForegroundBusy: () => true,
      getTopicIds: () => [item.id],
      getTopicCompanyIds: () => db.repos.itemCompanies.listByItem(item.id).map(entry => entry.companyId),
    });
    const service = new IndustryResearchService(db.repos, { recognize: async () => [] }, enrichment);
    const progress: Array<ReturnType<typeof enrichment.getProgress>> = [];
    enrichment.subscribeProgress(state => progress.push(state));
    enrichment.start();
    for (const company of companies.slice(0, 3)) db.repos.companies.setProfileStatus(company.id, "ready");
    enrichment.enqueue(companies[0]!.id);
    expect(progress.at(-1)).toMatchObject({ total: 9, processed: 3 });
    service.removeCompany(item.id, companies[removedReady ? 0 : 3]!.id);
    expect(progress.at(-1)).toMatchObject({ total: 8, processed: expectedProcessed });
    service.removeCompanies(item.id, companies.filter((_, index) => index !== (removedReady ? 0 : 3)).map(company => company.id));
    expect(progress.at(-1)).toMatchObject({ status: "idle", total: 0, processed: 0 });
  });

  it("keeps a shared company's other topic queued when removed from one topic", async () => {
    const db = openTestDb(); dbs.push(db);
    const first = db.repos.capabilityItems.create({ industry: "机器人" });
    const second = db.repos.capabilityItems.create({ industry: "软件" });
    const shared = db.repos.companies.upsert({ name: "共享公司" });
    db.repos.itemCompanies.add(first.id, shared.id);
    db.repos.itemCompanies.add(second.id, shared.id);
    const enrichment = new CompanyProfileEnrichmentService(db.repos.companies, { prepare: async () => async () => ({
      identity: { disposition: "matched", matchedName: "共享公司", reason: "已确认", sources: [{ url: "https://example.test", kind: "search_snippet" }] },
      fields: { headquarters: "北京" }, fieldEvidence: { headquarters: [{ url: "https://example.test", kind: "search_snippet" }] },
      sources: [{ url: "https://example.test", kind: "search_snippet", title: "来源", excerpt: "地点" }],
    }) }, {
      getTopicIds: () => [first.id, second.id],
      getTopicCompanyIds: itemId => db.repos.itemCompanies.listByItem(itemId as typeof first.id).map(entry => entry.companyId),
    });
    const service = new IndustryResearchService(db.repos, { recognize: async () => [] }, enrichment);
    enrichment.start();
    service.removeCompany(first.id, shared.id);
    await enrichment.whenIdle();
    expect(service.listCompanies(first.id)).toEqual([]);
    expect(service.listCompanies(second.id)[0]).toMatchObject({ id: shared.id, profileStatus: "ready" });
  });
  it("publishes idle when deletion follows a completed profile cohort", async () => {
    const db = openTestDb(); dbs.push(db);
    const item = db.repos.capabilityItems.create({ industry: "机器人" });
    const first = db.repos.companies.upsert({ name: "已补全公司一" });
    const second = db.repos.companies.upsert({ name: "已补全公司二" });
    db.repos.itemCompanies.add(item.id, first.id);
    db.repos.itemCompanies.add(item.id, second.id);
    const enrichment = new CompanyProfileEnrichmentService(db.repos.companies, { prepare: async () => async () => ({
      identity: { disposition: "matched", matchedName: "已补全公司", reason: "已确认", sources: [{ url: "https://example.test", kind: "search_snippet" }] },
      fields: { headquarters: "北京" }, fieldEvidence: { headquarters: [{ url: "https://example.test", kind: "search_snippet" }] },
      sources: [{ url: "https://example.test", kind: "search_snippet", title: "来源", excerpt: "地点" }],
    }) }, {
      getTopicIds: () => [item.id], getTopicCompanyIds: () => db.repos.itemCompanies.listByItem(item.id).map(entry => entry.companyId),
    });
    const service = new IndustryResearchService(db.repos, { recognize: async () => [] }, enrichment);
    const progress: Array<ReturnType<typeof enrichment.getProgress>> = [];
    enrichment.subscribeProgress(state => progress.push(state));
    enrichment.start(); await enrichment.whenIdle();
    expect(progress.at(-1)).toMatchObject({ status: "completed", total: 2 });
    service.removeCompany(item.id, first.id);
    expect(progress.at(-1)).toMatchObject({ status: "idle", total: 0 });
    service.removeCompany(item.id, second.id);
    expect(progress.at(-1)).toMatchObject({ status: "idle", total: 0 });
  });
  it("keeps shared pending progress visible after deleting another company without a tracked cohort", () => {
    const db = openTestDb(); dbs.push(db);
    const item = db.repos.capabilityItems.create({ industry: "机器人" });
    const other = db.repos.capabilityItems.create({ industry: "软件" });
    const ready = db.repos.companies.upsert({ name: "已完成公司" });
    db.repos.companies.setProfileStatus(ready.id, "ready");
    db.repos.itemCompanies.add(item.id, ready.id);
    const shared = db.repos.companies.upsert({ name: "共享待补公司" });
    db.repos.itemCompanies.add(other.id, shared.id);
    const enrichment = new CompanyProfileEnrichmentService(db.repos.companies, { prepare: async () => async () => { throw Error("not called"); } }, {
      isForegroundBusy: () => true,
      getTopicIds: () => [item.id, other.id],
      getTopicCompanyIds: topic => db.repos.itemCompanies.listByItem(topic as typeof item.id).map(entry => entry.companyId),
    });
    const service = new IndustryResearchService(db.repos, { recognize: async () => [] }, enrichment);
    const progress: Array<ReturnType<typeof enrichment.getProgress>> = [];
    enrichment.subscribeProgress(state => progress.push(state));
    enrichment.start();
    service.addCompany(item.id, { name: shared.name });
    expect(enrichment.getProgress(item.id)).toMatchObject({ status: "waiting", total: 1, processed: 0 });
    service.removeCompany(item.id, ready.id);
    expect(progress.at(-1)).toMatchObject({ itemId: item.id, status: "waiting", total: 1, processed: 0 });
    expect(service.listCompanies(other.id)[0]).toMatchObject({ id: shared.id, profileStatus: "pending" });
  });
  it("aggregates only usable report versions for this topic, using creation time and retaining company metadata", () => {
    const db = openTestDb(); dbs.push(db);
    const service = new IndustryResearchService(db.repos, { recognize: async () => [] });
    const item = service.createItem({ industry: "Robotics" });
    const other = service.createItem({ industry: "Other" });
    const a = service.addCompany(item.id, { name: "A", note: "保留备注" });
    const b = service.addCompany(item.id, { name: "B" });
    service.addCompany(other.id, { name: "A" });
    const repo = db.repos.companyResearchRuns;
    const input = { direction: "product_and_technology", asOfDate: "2026-09-17" } as const;
    const template = getCompanyResearchTemplate(input.direction);
    const create = (topic = item.id, company = a.id) => repo.createResearching(topic, company, input, { ...input, currentDate: input.asOfDate, companyName: "A", topicName: "Robotics" }, template);
    const complete = (id: Parameters<typeof repo.completeRaw>[0]) => { repo.completeRaw(id, "可用原文"); repo.completeStructured(id, { coreSummary: ["总结"], sections: template.sections.map(({ sectionId }) => ({ sectionId, status: "not_found", summary: null, facts: [] })) }); };
    const first = create(); complete(first.id);
    db.db.prepare("UPDATE company_research_runs SET created_at = ?, completed_at = ? WHERE id = ?").run("2026-09-01T00:00:00.000Z", "2026-09-30T00:00:00.000Z", first.id);
    const failedStructure = create(); repo.completeRaw(failedStructure.id, "仍然可读"); repo.failStructuring(failedStructure.id);
    db.db.prepare("UPDATE company_research_runs SET created_at = ? WHERE id = ?").run("2026-09-10T00:00:00.000Z", failedStructure.id);
    const failedRaw = create(); repo.failResearching(failedRaw.id, "model_failed");
    const otherRun = create(other.id); complete(otherRun.id);
    db.db.prepare("INSERT INTO company_research_runs(id,item_id,company_id,schema_version,status,legacy_time_scope,legacy_report_text,created_at,completed_at) VALUES(?,?,?,'legacy-freeform-v1','completed','全部','旧报告',?,?)").run("legacy", item.id, a.id, "2026-09-05T00:00:00.000Z", "2026-09-29T00:00:00.000Z");
    const active = create();
    const read = vi.spyOn(repo, "getByIdForTarget"); const lists = vi.spyOn(repo, "listRuns");
    for (const stage of ["researching", "structuring"]) {
      if (stage === "structuring") repo.completeRaw(active.id, "进行中原文");
      const views = service.listCompanies(item.id);
      expect(views.find(view => view.id === a.id)).toMatchObject({ note: "保留备注", profileStatus: "pending", reportSummary: { count: 3, latestCreatedAt: "2026-09-10T00:00:00.000Z" } });
      expect(views.find(view => view.id === b.id)?.reportSummary).toBeUndefined();
    }
    expect(service.listCompanies(other.id)[0]?.reportSummary?.count).toBe(1);
    repo.deleteTerminal(item.id, a.id, failedStructure.id);
    expect(service.listCompanies(item.id).find(view => view.id === a.id)?.reportSummary).toEqual({ count: 2, latestCreatedAt: "2026-09-05T00:00:00.000Z" });
    expect(read).not.toHaveBeenCalled(); expect(lists).not.toHaveBeenCalled();
  });
  it("normalizes optional fields, deduplicates one batch, and normalizes recognizer drafts", async () => {
    const db = openTestDb();
    dbs.push(db);
    const recognizer = {
      recognize: async (): Promise<CompanyDraft[]> => [
        { name: "  Beta Labs  ", note: "recognizer metadata must be discarded" },
      ],
    };
    const service = new IndustryResearchService(db.repos, recognizer);
    const item = service.createItem({ industry: " 人形机器人 ", researchScope: " \t", notes: " " });

    const added = service.addCompanies(item.id, [
      { name: " ＡＣＭＥ  Corp ", note: " " },
      { name: "acme corp", note: "后出现，不覆盖首项" },
    ]);

    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({ name: "ＡＣＭＥ  Corp", normalizedName: "acme corp" });
    expect(added[0]?.headquarters).toBeUndefined();
    expect(added[0]?.note).toBeUndefined();
    expect(item.researchScope).toBeUndefined();
    expect(item.notes).toBeUndefined();

    await expect(service.recognizeCompanies(item.id, "Beta Labs")).resolves.toEqual([
      { name: "Beta Labs" },
    ]);
  });

  it("cleans orphan companies transactionally while preserving shared and unrelated data", () => {
    const db = openTestDb();
    dbs.push(db);
    const service = new IndustryResearchService(db.repos, { recognize: async () => [] });
    const item = service.createItem({
      industry: " 人形机器人 ",
      researchScope: " 初始范围 ",
      notes: " 初始备注 ",
    });
    const otherItem = service.createItem({ industry: "工业软件" });
    const [first, second] = service.addCompanies(item.id, [
      { name: "公司甲" },
      { name: "公司乙" },
    ]);
    service.addCompany(otherItem.id, { name: "公司甲" });

    const conversation = db.repos.conversations.create();
    db.repos.messages.append(conversation.id, "user", "保留消息");
    db.repos.toolExecutions.start({
      id: "tool-keep",
      traceId: "trace-keep",
      projectId: item.id,
      actor: "test",
      toolName: "search",
      toolVersion: 1,
      startedAt: "2026-09-08T00:00:00.000Z",
    });

    const updated = service.updateItem(item.id, {
      industry: " 具身智能 ",
      researchScope: "  ",
      notes: " 更新备注 ",
    });
    expect(updated).toMatchObject({ industry: "具身智能", notes: "更新备注" });
    expect(updated.researchScope).toBeUndefined();

    service.removeCompanies(item.id, [first!.id, first!.id, second!.id]);
    expect(service.listCompanies(item.id)).toEqual([]);
    expect(db.repos.companies.getById(first!.id)?.name).toBe("公司甲");
    expect(db.repos.companies.getById(second!.id)).toBeUndefined();

    const third = service.addCompany(item.id, { name: "公司丙" });
    service.removeCompany(item.id, third.id);
    expect(db.repos.companies.getById(third.id)).toBeUndefined();
    const fourth = service.addCompany(item.id, { name: "公司丁" });

    service.deleteItem(item.id);
    service.deleteItem(item.id);
    expect(() => service.removeCompanies(item.id, [])).not.toThrow();
    expect(service.getItem(item.id)).toBeUndefined();
    expect(service.listCompanies(otherItem.id).map((company) => company.name)).toEqual(["公司甲"]);
    expect(db.repos.companies.getById(fourth.id)).toBeUndefined();
    expect(db.repos.conversations.getById(conversation.id)).toBeDefined();
    expect(db.repos.messages.listByConversation(conversation.id).map((message) => message.content)).toEqual([
      "保留消息",
    ]);
    expect(db.repos.toolExecutions.getById("tool-keep")).toBeDefined();
    expect(service.listItems().map((entry) => entry.industry)).toEqual(["工业软件"]);
  });

  it("deletes multiple industries atomically and rolls back every deletion on failure", () => {
    const db = openTestDb();
    dbs.push(db);
    const service = new IndustryResearchService(db.repos, { recognize: async () => [] });
    const firstItem = service.createItem({ industry: "机器人" });
    const secondItem = service.createItem({ industry: "工业软件" });
    const firstCompany = service.addCompany(firstItem.id, { name: "公司甲" });
    const secondCompany = service.addCompany(secondItem.id, { name: "公司乙" });
    db.db.exec(
      `CREATE TRIGGER fail_second_item_delete
       BEFORE DELETE ON capability_items
       WHEN OLD.id = '${secondItem.id}'
       BEGIN
         SELECT RAISE(ABORT, 'forced batch failure');
       END`,
    );

    expect(() => service.deleteItems([firstItem.id, secondItem.id])).toThrow(
      "research item deletion failed",
    );
    expect(service.getItem(firstItem.id)).toBeDefined();
    expect(service.getItem(secondItem.id)).toBeDefined();
    expect(db.repos.companies.getById(firstCompany.id)).toBeDefined();
    expect(db.repos.companies.getById(secondCompany.id)).toBeDefined();

    db.db.exec("DROP TRIGGER fail_second_item_delete");
    service.deleteItems([firstItem.id, firstItem.id, secondItem.id]);
    expect(service.getItem(firstItem.id)).toBeUndefined();
    expect(service.getItem(secondItem.id)).toBeUndefined();
    expect(db.repos.companies.getById(firstCompany.id)).toBeUndefined();
    expect(db.repos.companies.getById(secondCompany.id)).toBeUndefined();
  });

  it("validates and replaces the global company profile across industry memberships", () => {
    const db = openTestDb();
    dbs.push(db);
    const service = new IndustryResearchService(db.repos, { recognize: async () => [] });
    const firstItem = service.createItem({ industry: "机器人" });
    const secondItem = service.createItem({ industry: "智能制造" });
    const company = service.addCompany(firstItem.id, { name: "ACME" });
    service.addCompany(secondItem.id, { name: "ACME" });

    const updated = service.updateCompany(company.id, {
      name: " ACME Corporation ",
      legalName: " ACME Corporation Ltd. ",
      aliases: [],
      headquarters: " Boston, US ",
      foundedAt: "1998",
      officialWebsite: null,
      stockListings: [],
      businessTags: [" 工业机器人 ", "机器视觉"],
    });
    expect(updated).toMatchObject({
      name: "ACME Corporation",
      legalName: "ACME Corporation Ltd.",
      headquarters: "Boston, US",
      businessTags: ["工业机器人", "机器视觉"],
    });
    expect(service.listCompanies(firstItem.id)[0]).toMatchObject(updated);
    expect(service.listCompanies(secondItem.id)[0]).toMatchObject(updated);

    expect(() => service.updateCompany(company.id, { name: "ACME", foundedAt: "1998-13" }))
      .toThrow("invalid company profile");
    expect(() => service.updateCompany(company.id, {
      name: "ACME",
      officialWebsite: "ftp://example.com",
    })).toThrow("invalid company profile");
    expect(() => service.updateCompany(company.id, {
      name: "ACME",
      businessTags: [],
    })).toThrow("invalid company profile");
  });

  it("enqueues only newly-created global companies after their memberships are saved", () => {
    const db = openTestDb();
    dbs.push(db);
    const enqueued: string[] = [];
    const service = new IndustryResearchService(
      db.repos,
      { recognize: async () => [] },
      { enqueue: (companyId) => enqueued.push(companyId) },
    );
    const firstItem = service.createItem({ industry: "机器人" });
    const secondItem = service.createItem({ industry: "工业软件" });

    const [first, second] = service.addCompanies(firstItem.id, [
      { name: "First" },
      { name: "Second" },
    ]);
    expect(enqueued).toEqual([first!.id, second!.id]);
    expect(first?.profileStatus).toBe("pending");

    service.addCompany(secondItem.id, { name: " first " });
    expect(enqueued).toEqual([first!.id, second!.id]);
    expect(service.listCompanies(secondItem.id)[0]?.id).toBe(first!.id);
  });

  it("reuses a global company when an imported name matches its primary name or confirmed alias", () => {
    const db = openTestDb();
    dbs.push(db);
    const enqueued: string[] = [];
    const service = new IndustryResearchService(
      db.repos,
      { recognize: async () => [] },
      { enqueue: (companyId) => enqueued.push(companyId) },
    );
    const firstItem = service.createItem({ industry: "搜索引擎" });
    const secondItem = service.createItem({ industry: "人工智能" });
    const google = service.addCompany(firstItem.id, { name: "google" });
    service.updateCompany(google.id, {
      name: "google",
      aliases: ["Google Inc.", "谷歌"],
    });

    const added = service.addCompanies(secondItem.id, [
      { name: "谷歌" },
      { name: "Google" },
      { name: "GooGle" },
    ]);

    expect(added).toHaveLength(1);
    expect(added[0]?.id).toBe(google.id);
    expect(service.listCompanies(secondItem.id).map((company) => company.id)).toEqual([google.id]);
    expect(db.repos.companies.list()).toHaveLength(1);
    expect(enqueued).toEqual([google.id]);
  });

  it("prefers an exact primary name and does not merge an ambiguous alias", () => {
    const db = openTestDb();
    dbs.push(db);
    const service = new IndustryResearchService(db.repos, { recognize: async () => [] });
    const sourceItem = service.createItem({ industry: "来源" });
    const targetItem = service.createItem({ industry: "目标" });
    const google = service.addCompany(sourceItem.id, { name: "google" });
    service.updateCompany(google.id, { name: "google", aliases: ["谷歌", "共同别名"] });
    const chineseGoogle = db.repos.companies.upsert({ name: "谷歌" });
    const another = db.repos.companies.upsert({ name: "另一家公司" });
    db.repos.companies.update(another.id, { name: "另一家公司", aliases: ["共同别名"] });

    const exact = service.addCompany(targetItem.id, { name: "谷歌" });
    const ambiguous = service.addCompany(targetItem.id, { name: "共同别名" });

    expect(exact.id).toBe(chineseGoogle.id);
    expect(exact.id).not.toBe(google.id);
    expect(ambiguous.id).not.toBe(google.id);
    expect(ambiguous.id).not.toBe(another.id);
    expect(ambiguous.name).toBe("共同别名");
  });

  it("delegates an explicit failed-profile retry to the enrichment queue", () => {
    const db = openTestDb();
    dbs.push(db);
    const retried: string[] = [];
    const service = new IndustryResearchService(
      db.repos,
      { recognize: async () => [] },
      {
        enqueue: () => {},
        retry: (companyId) => {
          retried.push(companyId);
          return true;
        },
      },
    );
    const item = service.createItem({ industry: "智能眼镜" });
    const company = service.addCompany(item.id, { name: "乐奇" });

    expect(service.retryCompanyProfile(company.id)).toBe(true);
    expect(retried).toEqual([company.id]);
  });

  it("validates and delegates an explicit company identity hint without editing the profile", () => {
    const db = openTestDb();
    dbs.push(db);
    const confirmations: unknown[] = [];
    const service = new IndustryResearchService(
      db.repos,
      { recognize: async () => [] },
      {
        enqueue: () => {},
        confirmIdentity: (companyId, hint) => {
          confirmations.push({ companyId, hint });
          return true;
        },
      },
    );
    const item = service.createItem({ industry: "智能手机" });
    const company = service.addCompany(item.id, { name: "三星" });

    expect(service.confirmCompanyProfileIdentity(company.id, {
      name: "  三星电子株式会社  ", officialWebsite: " https://www.samsung.com/ ",
    })).toBe(true);
    expect(confirmations).toEqual([{ companyId: company.id, hint: {
      name: "三星电子株式会社", officialWebsite: "https://www.samsung.com/",
    } }]);
    expect(db.repos.companies.getById(company.id)?.name).toBe("三星");
    expect(() => service.confirmCompanyProfileIdentity(company.id, { name: " ", officialWebsite: "https://example.com" })).toThrow(/invalid/i);
    expect(() => service.confirmCompanyProfileIdentity(company.id, { name: "主体", officialWebsite: "ftp://example.com" })).toThrow(/invalid/i);
    expect(() => service.confirmCompanyProfileIdentity(company.id, { name: "主体", officialWebsite: "https://?query" })).toThrow(/invalid/i);
    expect(confirmations).toHaveLength(1);
  });
});
