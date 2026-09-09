import { Type } from "typebox";
import { ToolExecutionError, type ToolDefinition } from "@deepfield/tool-platform";

const currentDatetimeInputSchema = Type.Object(
  { timeZone: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })) },
  { additionalProperties: false },
);

export const dateTimeOutputSchema = Type.Object(
  {
    utcIso: Type.String(),
    localDate: Type.String(),
    localTime: Type.String(),
    timeZone: Type.String(),
    utcOffset: Type.String(),
    epochMilliseconds: Type.Number(),
  },
  { additionalProperties: false },
);

export interface CurrentDatetimeOptions {
  clock?: () => Date;
  timeZone?: string;
}

function partsByType(
  formatter: Intl.DateTimeFormat,
  date: Date,
): Record<string, string> {
  return Object.fromEntries(
    formatter
      .formatToParts(date)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
}

function formatUtcOffset(parts: Record<string, string>, instant: Date): string {
  const localAsUtc = Date.UTC(
    Number(parts["year"]),
    Number(parts["month"]) - 1,
    Number(parts["day"]),
    Number(parts["hour"]),
    Number(parts["minute"]),
    Number(parts["second"]),
  );
  const instantAtSecond = Math.floor(instant.getTime() / 1000) * 1000;
  const offsetMinutes = Math.round((localAsUtc - instantAtSecond) / 60_000);
  const sign = offsetMinutes < 0 ? "-" : "+";
  const absolute = Math.abs(offsetMinutes);
  const hours = String(Math.floor(absolute / 60)).padStart(2, "0");
  const minutes = String(absolute % 60).padStart(2, "0");
  return `${sign}${hours}:${minutes}`;
}

export function formatAbsoluteDateTime(
  instant: Date,
  requestedTimeZone: string,
): {
  utcIso: string;
  localDate: string;
  localTime: string;
  timeZone: string;
  utcOffset: string;
  epochMilliseconds: number;
} {
  if (!Number.isFinite(instant.getTime())) {
    throw new ToolExecutionError("invalid_input");
  }
  try {
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: requestedTimeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    const parts = partsByType(formatter, instant);
    return {
      utcIso: instant.toISOString(),
      localDate: `${parts["year"]}-${parts["month"]}-${parts["day"]}`,
      localTime: `${parts["hour"]}:${parts["minute"]}:${parts["second"]}`,
      timeZone: formatter.resolvedOptions().timeZone,
      utcOffset: formatUtcOffset(parts, instant),
      epochMilliseconds: instant.getTime(),
    };
  } catch {
    throw new ToolExecutionError("invalid_input");
  }
}

export function formatDateTimeOutput(output: {
  localDate: string;
  localTime: string;
  timeZone: string;
  utcOffset: string;
  utcIso: string;
}): string {
  return `${output.localDate} ${output.localTime} (${output.timeZone}, UTC${output.utcOffset}); UTC ${output.utcIso}`;
}

export function createCurrentDatetimeDefinition(
  options: CurrentDatetimeOptions = {},
): ToolDefinition<typeof currentDatetimeInputSchema, typeof dateTimeOutputSchema> {
  return {
    identity: { name: "get_current_datetime", version: 1 },
    label: "Current Date and Time",
    description: "Get the current date and time in a requested IANA time zone.",
    inputSchema: currentDatetimeInputSchema,
    outputSchema: dateTimeOutputSchema,
    effect: "system.read",
    timeoutMs: 1000,
    retry: { maxRetries: 0, backoffMs: 0 },
    concurrency: 8,
    meter: { category: "none", countsBytes: false, countsTime: true },
    model: {
      formatOutput: formatDateTimeOutput,
    },
    execute: async (input) => {
      const now = options.clock?.() ?? new Date();
      const requestedTimeZone =
        input.timeZone ??
        options.timeZone ??
        (Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
      return formatAbsoluteDateTime(now, requestedTimeZone);
    },
  };
}
