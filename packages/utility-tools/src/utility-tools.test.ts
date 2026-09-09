import { describe, expect, it } from "vitest";
import { ToolExecutionError } from "@deepfield/tool-platform";
import {
  createCalculatorDefinition,
  createConvertTimezoneDefinition,
  createCurrentDatetimeDefinition,
} from "./index.js";

describe("current datetime utility tool", () => {
  it("returns deterministic local fields and rejects an invalid time zone", async () => {
    const definition = createCurrentDatetimeDefinition({
      clock: () => new Date("2026-09-08T16:30:45.123Z"),
      timeZone: "Asia/Shanghai",
    });

    await expect(
      definition.execute(
        {},
        { traceId: "trace-1", actor: "main_agent" },
        new AbortController().signal,
      ),
    ).resolves.toEqual({
      utcIso: "2026-09-08T16:30:45.123Z",
      localDate: "2026-09-09",
      localTime: "00:30:45",
      timeZone: "Asia/Shanghai",
      utcOffset: "+08:00",
      epochMilliseconds: 1_788_885_045_123,
    });

    await expect(
      definition.execute(
        { timeZone: "Not/A_TimeZone" },
        { traceId: "trace-2", actor: "main_agent" },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject<ToolExecutionError>({ code: "invalid_input" });
  });
});

describe("convert timezone utility tool", () => {
  it("converts an offset ISO instant into the requested IANA time zone", async () => {
    const definition = createConvertTimezoneDefinition();
    await expect(
      definition.execute(
        { dateTime: "2026-01-15T12:34:56.789+02:00", timeZone: "America/New_York" },
        { traceId: "trace-1", actor: "main_agent" },
        new AbortController().signal,
      ),
    ).resolves.toEqual({
      utcIso: "2026-01-15T10:34:56.789Z",
      localDate: "2026-01-15",
      localTime: "05:34:56",
      timeZone: "America/New_York",
      utcOffset: "-05:00",
      epochMilliseconds: 1_768_473_296_789,
    });
  });

  it("rejects ambiguous local input and an invalid IANA time zone", async () => {
    const definition = createConvertTimezoneDefinition();
    const execute = (dateTime: string, timeZone: string) =>
      definition.execute(
        { dateTime, timeZone },
        { traceId: "trace-1", actor: "main_agent" },
        new AbortController().signal,
      );
    await expect(
      execute("2026-01-15T12:34:56", "Asia/Shanghai"),
    ).rejects.toMatchObject<ToolExecutionError>({ code: "invalid_input" });
    await expect(
      execute("2026-01-15T12:34:56Z", "Not/A_TimeZone"),
    ).rejects.toMatchObject<ToolExecutionError>({ code: "invalid_input" });
  });
});

describe("calculator utility tool", () => {
  it("evaluates safe arithmetic and rejects executable or invalid expressions", async () => {
    const definition = createCalculatorDefinition();
    const execute = (expression: string) =>
      definition.execute(
        { expression },
        { traceId: "trace-1", actor: "main_agent" },
        new AbortController().signal,
      );

    await expect(execute("2 + 3 * (4 - 1)^2")).resolves.toEqual({ value: 29 });
    await expect(execute("process.exit()")).rejects.toMatchObject<ToolExecutionError>({
      code: "invalid_input",
    });
    await expect(execute("1 / 0")).rejects.toMatchObject<ToolExecutionError>({
      code: "invalid_input",
    });
    await expect(execute("2 +")).rejects.toMatchObject<ToolExecutionError>({
      code: "invalid_input",
    });
  });
});
