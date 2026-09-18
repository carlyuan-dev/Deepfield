// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ToolActivity } from "./ToolActivity.js";
afterEach(cleanup);

it("restores compact tool history with exact query, count, duration and safe source links", () => {
  render(<ToolActivity terminal activities={[{ callKey: "req-call", name: "web_search", status: "completed", queryOrUrl: "original full query", durationMs: 123, resultCount: 1, sources: [{ title: "Original source", url: "https://example.test/path?a=1&b=2" }, { title: "Unsafe", url: "javascript:alert(1)" }] }]} />);
  expect(screen.queryByText("original full query")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: /已调用 1 个工具/ }));
  expect(screen.getByText("original full query")).toBeTruthy();
  expect(screen.getByText("123ms")).toBeTruthy();
  expect(screen.getByText("1 条结果")).toBeTruthy();
  expect(screen.getByRole("link", { name: "Original source" }).getAttribute("href")).toBe("https://example.test/path?a=1&b=2");
  expect(screen.queryByText("Unsafe")).toBeNull();
});
