import { expect, it } from "vitest";
import { openDatabase } from "@deepfield/base/database/runtime";
import { companyResearchMigrations } from "./migrations.js";

it("clears legacy headquarters and evidence once while preserving frozen reports and later edits", () => {
  const owner = openDatabase(":memory:");
  try {
    const db = owner.scope("capability:company-research").database;
    db.exec("CREATE TABLE companies(headquarters TEXT, country_or_region TEXT, profile_provenance_json TEXT); CREATE TABLE company_research_runs(research_context_json TEXT)");
    db.run("INSERT INTO companies VALUES (?, ?, ?)", "北京", "中国", JSON.stringify({ fields: { headquarters: "北京", foundedAt: "1998" }, fieldEvidence: { headquarters: ["hq"], foundedAt: ["date"] } }));
    const frozen = JSON.stringify({ headquarters: "北京", companyNote: "历史备注" });
    db.run("INSERT INTO company_research_runs VALUES (?)", frozen);
    db.migrate(companyResearchMigrations, () => {});
    const row = db.get("SELECT * FROM companies")!;
    expect(row.headquarters).toBeNull();
    expect(row.country_or_region).toBeNull();
    expect(JSON.parse(row.profile_provenance_json as string)).toEqual({ fields: { foundedAt: "1998" }, fieldEvidence: { foundedAt: ["date"] } });
    expect(db.get("SELECT research_context_json FROM company_research_runs")?.research_context_json).toBe(frozen);
    db.run("UPDATE companies SET headquarters = ?", "中国／北京市／海淀区");
    db.migrate(companyResearchMigrations, () => {});
    expect(db.get("SELECT headquarters FROM companies")?.headquarters).toBe("中国／北京市／海淀区");
  } finally { owner.close(); }
});
