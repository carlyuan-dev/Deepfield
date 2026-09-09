import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { createRepositories, migrate, openDatabase } from "./index.js";

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) {
    cleanup();
  }
});

describe("Capability A persistence", () => {
  it("reopens items, reuses companies across items, and removes only membership", () => {
    const dir = mkdtempSync(join(tmpdir(), "deepfield-capability-"));
    const path = join(dir, "deepfield.sqlite");
    const db = openDatabase(path);
    migrate(db);
    cleanups.push(() => {
      try {
        db.close();
      } catch {
        // already closed
      }
      rmSync(dir, { recursive: true, force: true });
    });

    const repos = createRepositories(db);
    const first = repos.capabilityItems.create({
      industry: "人形机器人",
      researchScope: "整机与核心零部件",
      notes: "首轮研究",
    });
    const second = repos.capabilityItems.create({
      industry: "工业软件",
    });

    const company = repos.companies.upsert({
      name: "  ＡＣＭＥ\t  Corp  ",
      countryOrRegion: "US",
    });
    const reused = repos.companies.upsert({ name: "acme corp" });
    expect(reused.id).toBe(company.id);
    expect(company.normalizedName).toBe("acme corp");
    expect(company.name).toBe("ＡＣＭＥ\t  Corp");

    repos.itemCompanies.add(first.id, company.id, "首选供应商");
    repos.itemCompanies.add(first.id, company.id, "重复关联应被忽略");
    repos.itemCompanies.add(second.id, company.id, "跨条目复用");
    expect(repos.itemCompanies.listByItem(first.id)).toHaveLength(1);
    expect(repos.itemCompanies.listByItem(second.id)).toHaveLength(1);

    repos.itemCompanies.remove(first.id, company.id);
    expect(repos.itemCompanies.listByItem(first.id)).toEqual([]);
    expect(repos.companies.getById(company.id)?.name).toBe("ＡＣＭＥ\t  Corp");
    expect(repos.itemCompanies.listByItem(second.id)).toHaveLength(1);

    db.close();
    const reopened = openDatabase(path);
    cleanups.push(() => {
      try {
        reopened.close();
      } catch {
        // already closed
      }
    });
    migrate(reopened);
    const reopenedRepos = createRepositories(reopened);

    expect(reopenedRepos.capabilityItems.getById(first.id)?.industry).toBe("人形机器人");
    expect(reopenedRepos.capabilityItems.list()).toHaveLength(2);
    expect(reopenedRepos.companies.getById(company.id)?.normalizedName).toBe("acme corp");
    expect(reopenedRepos.itemCompanies.listByItem(first.id)).toEqual([]);
    expect(reopenedRepos.itemCompanies.listByItem(second.id)).toHaveLength(1);

    const tableNames = reopened
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as unknown as Array<{ name: string }>;
    const names = tableNames.map((table) => table.name);
    expect(names).not.toContain("projects");
    expect(names).not.toContain("project_activity_events");
    expect(names).toEqual(
      expect.arrayContaining([
        "capability_items",
        "companies",
        "capability_item_companies",
        "conversations",
        "messages",
        "tool_executions",
      ]),
    );
  });
});
