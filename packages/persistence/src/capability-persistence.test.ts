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

  it("persists a shared company profile without overwriting it during reuse", () => {
    const db = openDatabase(":memory:");
    migrate(db);
    cleanups.push(() => db.close());
    const repos = createRepositories(db);
    const first = repos.capabilityItems.create({ industry: "机器人" });
    const second = repos.capabilityItems.create({ industry: "工业软件" });

    const company = repos.companies.upsert({ name: "ACME" });
    expect(company.profileStatus).toBe("pending");
    const profiled = repos.companies.update(company.id, {
      name: "ACME Corporation",
      legalName: "ACME Corporation Ltd.",
      aliases: [],
      headquarters: "Boston, Massachusetts, US",
      foundedAt: "1998",
      officialWebsite: null,
      stockListings: [],
      businessTags: ["工业机器人", "机器视觉"],
    });
    expect(profiled).toMatchObject({
      id: company.id,
      normalizedName: "acme corporation",
      aliases: [],
      officialWebsite: null,
      stockListings: [],
      businessTags: ["工业机器人", "机器视觉"],
      profileStatus: "ready",
    });

    repos.itemCompanies.add(first.id, company.id, "首选供应商");
    repos.itemCompanies.add(second.id, company.id, "竞品");
    const reused = repos.companies.upsert({ name: "acme corporation" });
    expect(reused).toEqual(profiled);
    expect(repos.companies.getById(company.id)).toEqual(profiled);
    expect(repos.itemCompanies.listByItem(first.id)[0]?.note).toBe("首选供应商");
    expect(repos.itemCompanies.listByItem(second.id)[0]?.note).toBe("竞品");
  });

  it("persists profile queue state and recovers interrupted work", () => {
    const db = openDatabase(":memory:");
    migrate(db);
    cleanups.push(() => db.close());
    const repos = createRepositories(db);
    const first = repos.companies.upsert({ name: "First" });
    const second = repos.companies.upsert({ name: "Second" });

    expect(repos.companies.getNextPendingProfile()?.id).toBe(first.id);
    expect(repos.companies.setProfileStatus(first.id, "enriching")?.profileStatus).toBe("enriching");
    expect(repos.companies.getNextPendingProfile()?.id).toBe(second.id);
    expect(repos.companies.resetEnrichingProfiles()).toBe(1);
    expect(repos.companies.getById(first.id)?.profileStatus).toBe("pending");
    expect(repos.companies.setProfileStatus(first.id, "failed")?.profileStatus).toBe("failed");
  });

  it("rejects a profile rename that conflicts with another normalized name", () => {
    const db = openDatabase(":memory:");
    migrate(db);
    cleanups.push(() => db.close());
    const repos = createRepositories(db);
    const first = repos.companies.upsert({ name: "Alpha" });
    repos.companies.upsert({ name: "Beta" });

    expect(() =>
      repos.companies.update(first.id, {
        name: " ＢＥＴＡ ",
      }),
    ).toThrow(/already exists/i);
    expect(repos.companies.getById(first.id)?.name).toBe("Alpha");
  });

  it("migrates legacy country data into headquarters and marks existing companies ready", () => {
    const db = openDatabase(":memory:");
    cleanups.push(() => db.close());
    db.exec(`
      CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
      INSERT INTO schema_migrations(version, applied_at) VALUES
        (1, ''), (2, ''), (3, ''), (4, ''), (5, '');
      CREATE TABLE companies(
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        normalized_name TEXT NOT NULL UNIQUE,
        country_or_region TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO companies VALUES('legacy', 'Legacy Co', 'legacy co', 'Singapore', '', '');
    `);

    migrate(db);
    const company = createRepositories(db).companies.getById("legacy" as never);
    expect(company).toMatchObject({
      headquarters: "Singapore",
      profileStatus: "ready",
    });
    expect(company).not.toHaveProperty("countryOrRegion");
    const cleared = createRepositories(db).companies.update("legacy" as never, {
      name: "Legacy Co",
    });
    expect(cleared?.headquarters).toBeUndefined();
  });
});
