import { databaseView, type DatabaseInput } from "./database.js";

export function runInTransaction<T>(db: DatabaseInput, work: () => T): T {
  // Legacy generic signature; Base still rejects async/thenable work at runtime.
  return databaseView(db).transaction(work as () => T extends PromiseLike<unknown> ? never : T);
}
