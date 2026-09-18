import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { DatabaseSync } from "node:sqlite";
import { createRepositories, migrate, openDatabase } from "@deepfield/persistence";
import type { Repositories } from "@deepfield/persistence";

export interface TestDb {
  db: DatabaseSync;
  repos: Repositories;
  cleanup(): void;
}

export function openTestDb(): TestDb {
  const dir = mkdtempSync(join(tmpdir(), "deepfield-app-"));
  const db = openDatabase(join(dir, "deepfield.sqlite"));
  migrate(db);
  const repos = createRepositories(db);
  return {
    db,
    repos,
    cleanup: () => {
      try {
        db.close();
      } catch {
        // already closed by the test
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
