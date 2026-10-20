import type { DatabaseSync } from "node:sqlite";
import type { Database } from "@deepfield/base/database";
import { adoptDatabase, openDatabase as openOwner } from "@deepfield/base/database/runtime";

export type DatabaseInput = Database | DatabaseSync;
/** Temporary trusted-host bridge for existing native callers. */
export function databaseView(db: DatabaseInput): Database {
  return "version" in db ? db : adoptDatabase(db).database;
}

export function openDatabase(path: string): DatabaseSync {
  return openOwner(path).legacy((db) => db);
}
