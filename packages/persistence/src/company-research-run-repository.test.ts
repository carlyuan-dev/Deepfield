import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRepositories, migrate, openDatabase } from "./index.js";

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function openFixture() {
  const directory = mkdtempSync(join(tmpdir(), "deepfield-research-runs-"));
  const path = join(directory, "deepfield.sqlite");
  const db = openDatabase(path);
  migrate(db);
  cleanups.push(() => {
    try {
      db.close();
    } catch {
      // already closed
    }
    rmSync(directory, { recursive: true, force: true });
  });
  return { db, path, repos: createRepositories(db) };
}

function addMembership(repos: ReturnType<typeof createRepositories>, industry: string) {
  const item = repos.capabilityItems.create({ industry });
  const company = repos.companies.upsert({ name: `${industry} Company` });
  repos.itemCompanies.add(item.id, company.id);
  return { item, company };
}

describe("company research run repository", () => {
  it("persists multiple completed versions newest-first across repository reconstruction", () => {
    const fixture = openFixture();
    const { item, company } = addMembership(fixture.repos, "Robotics");

    const first = fixture.repos.companyResearchRuns.createRunning(item.id, company.id, {
      timeScope: "  近一年  ",
      customRequirements: "  关注海外业务  ",
    });
    expect(first).toMatchObject({
      itemId: item.id,
      companyId: company.id,
      status: "running",
      timeScope: "近一年",
      customRequirements: "关注海外业务",
    });
    const firstCompleted = fixture.repos.companyResearchRuns.complete(first.id, "第一版报告");
    fixture.db
      .prepare("UPDATE company_research_runs SET completed_at = ? WHERE id = ?")
      .run("2026-09-09T00:00:00.000Z", firstCompleted.id);

    const second = fixture.repos.companyResearchRuns.createRunning(item.id, company.id, {
      timeScope: "近三个月",
      customRequirements: "   ",
    });
    const secondCompleted = fixture.repos.companyResearchRuns.complete(second.id, "第二版报告");

    fixture.db.close();
    const reopened = openDatabase(fixture.path);
    cleanups.push(() => {
      try {
        reopened.close();
      } catch {
        // already closed
      }
    });
    migrate(reopened);
    const reconstructed = createRepositories(reopened);

    expect(reconstructed.companyResearchRuns.listCompleted(item.id, company.id)).toEqual([
      secondCompleted,
      { ...firstCompleted, completedAt: "2026-09-09T00:00:00.000Z" },
    ]);
  });

  it("enforces one global running row, cleans abandoned work, and cascades membership deletion", () => {
    const { repos } = openFixture();
    const first = addMembership(repos, "Robotics");
    const second = addMembership(repos, "Semiconductors");

    const abandoned = repos.companyResearchRuns.createRunning(first.item.id, first.company.id, {
      timeScope: "近一年",
    });
    expect(repos.companyResearchRuns.getRunning()?.id).toBe(abandoned.id);
    expect(() =>
      repos.companyResearchRuns.createRunning(second.item.id, second.company.id, {
        timeScope: "不限时间",
      }),
    ).toThrow();
    expect(repos.companyResearchRuns.deleteAllRunning()).toBe(1);
    expect(repos.companyResearchRuns.getRunning()).toBeUndefined();

    const firstCompleted = repos.companyResearchRuns.complete(
      repos.companyResearchRuns.createRunning(first.item.id, first.company.id, {
        timeScope: "近一年",
      }).id,
      "Robotics report",
    );
    const secondCompleted = repos.companyResearchRuns.complete(
      repos.companyResearchRuns.createRunning(second.item.id, second.company.id, {
        timeScope: "近一年",
      }).id,
      "Semiconductors report",
    );

    repos.itemCompanies.remove(first.item.id, first.company.id);
    expect(repos.companyResearchRuns.getById(firstCompleted.id)).toBeUndefined();
    expect(repos.companyResearchRuns.listCompleted(first.item.id, first.company.id)).toEqual([]);
    expect(repos.companyResearchRuns.getById(secondCompleted.id)).toEqual(secondCompleted);
  });
});
