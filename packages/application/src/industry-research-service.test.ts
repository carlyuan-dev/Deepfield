import { afterEach, describe, expect, it } from "vitest";
import type { CompanyDraft } from "@deepfield/contracts";
import { IndustryResearchService } from "./industry-research-service.js";
import { openTestDb, type TestDb } from "./application-test-helpers.js";

const dbs: TestDb[] = [];

afterEach(() => {
  for (const db of dbs.splice(0)) {
    db.cleanup();
  }
});

describe("IndustryResearchService", () => {
  it("normalizes optional fields, deduplicates one batch, and normalizes recognizer drafts", async () => {
    const db = openTestDb();
    dbs.push(db);
    const recognizer = {
      recognize: async (): Promise<CompanyDraft[]> => [
        { name: "  Beta Labs  ", countryOrRegion: " \t", note: "  " },
      ],
    };
    const service = new IndustryResearchService(db.repos, recognizer);
    const item = service.createItem({ industry: " 人形机器人 ", researchScope: " \t", notes: " " });

    const added = service.addCompanies(item.id, [
      { name: " ＡＣＭＥ  Corp ", countryOrRegion: " ", note: " " },
      { name: "acme corp", countryOrRegion: "US", note: "后出现，不覆盖首项" },
    ]);

    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({ name: "ＡＣＭＥ  Corp", normalizedName: "acme corp" });
    expect(added[0]?.countryOrRegion).toBeUndefined();
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
});
