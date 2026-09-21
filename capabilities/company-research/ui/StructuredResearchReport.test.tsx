// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StructuredResearchReport } from "./StructuredResearchReport.js";
import { researchRun } from "./company-research-test-fixtures.js";

describe("structured research report sources", () => {
  afterEach(() => {
    Reflect.deleteProperty(window, "deepfield");
  });

  it("reuses the chat URL popover and copy action while keeping the source title on screen", async () => {
    const copyText = vi.fn(async () => undefined);
    Object.defineProperty(window, "deepfield", {
      configurable: true,
      value: { copyText },
    });
    render(<StructuredResearchReport run={researchRun()} />);

    const link = screen.getByRole("link", { name: "发布来源" });
    expect(link.getAttribute("href")).toBe("https://example.com/one");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noreferrer noopener");

    fireEvent.mouseEnter(link);
    const popover = screen.getByRole("dialog", { name: "链接详情" });
    expect(within(popover).getByText("https://example.com/one")).toBeTruthy();
    fireEvent.click(within(popover).getByRole("button", { name: "复制链接" }));

    await waitFor(() => expect(copyText).toHaveBeenCalledWith("https://example.com/one"));
    expect(within(popover).getByRole("status").textContent).toBe("已复制");
  });

  it("keeps unsafe source URLs inert", () => {
    const run = researchRun();
    run.structuredContent!.sections[0]!.facts[0]!.source = {
      title: "不可用来源",
      url: "javascript:alert(1)",
    };

    render(<StructuredResearchReport run={run} />);

    expect(screen.queryByRole("link", { name: "不可用来源" })).toBeNull();
    expect(screen.getByText("不可用来源").parentElement?.textContent).toContain("来源链接不可用");
    expect(screen.queryByRole("dialog", { name: "链接详情" })).toBeNull();
  });

  it("treats a schema-valid whitespace-prefixed HTTP source as external without rewriting it", () => {
    const run = researchRun();
    run.structuredContent!.sections[0]!.facts[0]!.source = {
      title: "带前导空格的来源",
      url: "  https://example.com/original",
    };

    render(<StructuredResearchReport run={run} />);

    const link = screen.getByRole("link", { name: "带前导空格的来源" });
    expect(link.getAttribute("href")).toBe("  https://example.com/original");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noreferrer noopener");
  });

  it("shows only warning statuses while preserving summaries and exact fact wording", () => {
    const run = researchRun();
    for (const [index, section] of run.structuredContent!.sections.entries()) {
      section.summary = `第 ${index + 1} 节摘要保留原文。`;
      section.facts = [{
        text: `第 ${index + 1} 节事实：截至 2026 年 9 月，仍可能调整。`,
        timeContext: "独立时间背景不应展示",
        claimType: "plan",
        source: { title: `来源 ${index + 1}`, url: `https://example.com/${index + 1}` },
      }];
    }

    render(<StructuredResearchReport run={run} />);

    expect(screen.queryByText("已找到")).toBeNull();
    expect(screen.queryByText("部分找到")).toBeNull();
    expect(screen.getByText("未找到")).toBeTruthy();
    expect(screen.getByText("未披露")).toBeTruthy();
    expect(screen.getByText("存在冲突")).toBeTruthy();
    expect(screen.getByText("第 1 节摘要保留原文。")).toBeTruthy();
    expect(screen.getByText("第 1 节事实：截至 2026 年 9 月，仍可能调整。")).toBeTruthy();
    expect(screen.queryByText("独立时间背景不应展示")).toBeNull();
    expect(screen.queryByText("计划")).toBeNull();
  });

  it("keeps the missing-section warning", () => {
    const run = researchRun();
    run.structuredContent!.sections.splice(0, 1);

    render(<StructuredResearchReport run={run} />);

    expect(screen.getByRole("alert").textContent).toBe("本节内容暂不可用。");
  });
});
