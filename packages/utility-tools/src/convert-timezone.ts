import { Type } from "typebox";
import { ToolExecutionError, type ToolDefinition } from "@deepfield/tool-platform";
import {
  dateTimeOutputSchema,
  formatAbsoluteDateTime,
  formatDateTimeOutput,
} from "./current-datetime.js";

const convertTimezoneInputSchema = Type.Object(
  {
    dateTime: Type.String({ minLength: 1, maxLength: 100 }),
    timeZone: Type.String({ minLength: 1, maxLength: 100 }),
  },
  { additionalProperties: false },
);

const ABSOLUTE_ISO_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-](\d{2}):(\d{2}))$/u;

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function parseAbsoluteIso(dateTime: string): Date {
  const match = ABSOLUTE_ISO_PATTERN.exec(dateTime);
  if (match === null) throw new ToolExecutionError("invalid_input");
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6] ?? "0");
  const offsetHour = match[8] === undefined ? 0 : Number(match[8]);
  const offsetMinute = match[9] === undefined ? 0 : Number(match[9]);
  const daysInMonth = [
    31,
    isLeapYear(year) ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];
  if (
    year < 1 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > (daysInMonth[month - 1] ?? 0) ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    offsetHour > 23 ||
    offsetMinute > 59
  ) {
    throw new ToolExecutionError("invalid_input");
  }
  const epochMilliseconds = Date.parse(dateTime);
  if (!Number.isFinite(epochMilliseconds)) {
    throw new ToolExecutionError("invalid_input");
  }
  return new Date(epochMilliseconds);
}

export function createConvertTimezoneDefinition(): ToolDefinition<
  typeof convertTimezoneInputSchema,
  typeof dateTimeOutputSchema
> {
  return {
    identity: { name: "convert_timezone", version: 1 },
    label: "Convert Time Zone",
    userFacing: { name: "时区转换", description: "将日期时间转换到指定时区" },
    description: "Convert an absolute ISO 8601 date-time into an IANA time zone.",
    inputSchema: convertTimezoneInputSchema,
    outputSchema: dateTimeOutputSchema,
    effect: "local.compute",
    timeoutMs: 1000,
    retry: { maxRetries: 0, backoffMs: 0 },
    concurrency: 8,
    meter: { category: "none", countsBytes: false, countsTime: true },
    model: { formatOutput: formatDateTimeOutput },
    execute: async ({ dateTime, timeZone }) =>
      formatAbsoluteDateTime(parseAbsoluteIso(dateTime), timeZone),
  };
}
