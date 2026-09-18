export interface RuntimeSystemContextOptions {
  clock?: () => Date;
  timeZone?: string;
}

function dateInTimeZone(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? "";
  return `${value("year")}-${value("month")}-${value("day")}`;
}

export function buildRuntimeSystemContext(
  options: RuntimeSystemContextOptions = {},
): string {
  const date = options.clock?.() ?? new Date();
  const timeZone =
    options.timeZone ?? (Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
  return [`当前日期：${dateInTimeZone(date, timeZone)}`, `本机时区：${timeZone}`].join("\n");
}
