import { Value } from "typebox/value";
import { UsageDashboardQuerySchema, validateUtc, type UsageDashboardQuery, type UsageQuery } from "./contracts.js";

export function dateAt(instant: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(instant);
  const part = (type: string) => parts.find((value) => value.type === type)!.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}
export function shiftDate(date: string, days: number): string {
  const value = new Date(`${date}T12:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

// Find the first instant of this local calendar date. Binary search also handles
// 23/25 hour days and zones that advance clocks at midnight (no fixed UTC offsets).
export function startOfDate(date: string, timeZone: string): string {
  const center = Date.parse(`${date}T00:00:00.000Z`);
  let lo = center - 36 * 3_600_000;
  let hi = center + 36 * 3_600_000;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (dateAt(new Date(mid), timeZone) < date) lo = mid + 1;
    else hi = mid;
  }
  return new Date(lo).toISOString();
}

export function validateUsageQuery(query: UsageQuery): void {
  if (query.serviceKind !== "llm" && query.serviceKind !== "search") throw new Error("invalid_usage_query");
  validateUtc(query.from); validateUtc(query.to);
  if (query.from >= query.to) throw new Error("invalid_usage_range");
  // Bound local calendar dates, allowing the extra elapsed hour on a fall DST change.
  const first = dateAt(new Date(query.from), query.timeZone);
  const last = dateAt(new Date(Date.parse(query.to) - 1), query.timeZone);
  validateDateRange(first, last);
}

function validateDateRange(first: string, last: string): void {
  for (const date of [first, last]) {
    const instant = new Date(`${date}T00:00:00.000Z`);
    if (!Number.isFinite(instant.getTime()) || instant.toISOString().slice(0, 10) !== date) throw new Error("invalid_usage_date");
  }
  if (first > last) throw new Error("invalid_usage_range");
  if ((Date.parse(`${last}T00:00:00.000Z`) - Date.parse(`${first}T00:00:00.000Z`)) / 86400000 >= 366) throw new Error("usage_range_too_large");
}

export function resolveDashboardQuery(query: UsageDashboardQuery, now: Date): UsageQuery {
  if (!Value.Check(UsageDashboardQuerySchema, query)) throw new Error("invalid_usage_query");
  const today = dateAt(now, query.timeZone);
  const first = query.range === "custom" ? query.startDate : query.range === "today" ? today
    : query.range === "month" ? `${today.slice(0, 7)}-01` : shiftDate(today, query.range === "7d" ? -6 : -29);
  const last = query.range === "custom" ? query.endDate : today;
  validateDateRange(first, last);
  const resolved = { serviceKind: query.serviceKind, from: startOfDate(first, query.timeZone), to: startOfDate(shiftDate(last, 1), query.timeZone), timeZone: query.timeZone };
  validateUsageQuery(resolved);
  return resolved;
}
