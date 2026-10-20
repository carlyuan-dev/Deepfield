import { createUsageRepository as create } from "@deepfield/base/usage/sqlite";
import { databaseView, type DatabaseInput } from "./database.js";
/** Compatibility for trusted host callers; implementation belongs to Base.Usage. */
export function createUsageRepository(db: DatabaseInput) { return create(databaseView(db)); }
