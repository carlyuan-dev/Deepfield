import type { ModuleMigration } from "@deepfield/base/database";

export const companyResearchMigrations: readonly ModuleMigration[] = [{
  version: 1,
  key: "reset-legacy-headquarters",
  up(db) {
    // The module migration ledger makes this reset one-time; frozen reports are untouched.
    db.run(`UPDATE companies SET headquarters = NULL, country_or_region = NULL,
      profile_provenance_json = CASE WHEN profile_provenance_json IS NULL THEN NULL
        ELSE json_remove(profile_provenance_json, '$.fields.headquarters', '$.fieldEvidence.headquarters') END`);
  },
}];
