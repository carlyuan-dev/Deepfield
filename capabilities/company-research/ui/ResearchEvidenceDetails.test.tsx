// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { makeFakeApi } from "../../../apps/desktop/src/renderer/renderer-test-helpers.js";
import type { ResearchEvidenceView } from "../contracts/research-evidence.js";
import { ResearchEvidenceDetails } from "./ResearchEvidenceDetails.js";
function fixture(partial = false): ResearchEvidenceView {
  return { status: partial ? "partial" : "complete", counts: { visibleEntries: 1, savedEntries: 1, visibleBytes: 20, savedBytes: partial ? 10 : 20, omittedEntries: 0, omittedBytes: partial ? 10 : 0, prepared: 1, dispatched: 1 }, groups: [{ modelRequestId: "m", phase: "ordinary", responseState: "failed", projections: [{ evidenceId: "e", mapping: "mapped", toolName: "web_search", capturedAt: "2026-10-09", savedText: "结果组的共同正文", visibleBytes: 20, savedBytes: partial ? 10 : 20, archiveClipping: { reason: partial ? "item_limit" : "none", omittedBytes: partial ? 10 : 0 }, sources: [{ url: "https://source.test/a?q=raw", title: "来源一", kind: "search_snippet", sourceDate: { provider: "doubao", fieldName: "PublishTime", rawValue: "2026-01-01T12:00:00+08:00", normalizedValue: "2026-01-01", precision: "datetime", nature: "published", evidenceSource: "provider_metadata", status: "valid" } }, { url: "https://source.test/a?q=raw", title: "来源二", kind: "search_snippet" }] }] }] };
}
const target = { itemId: "i", companyId: "c", runId: "r" };
describe("research evidence details", () => {
  it("labels canonical, requested and actual fetch URLs separately", async () => {
    const api = makeFakeApi(); const view = fixture();
    if (view.status !== "complete") throw new Error("complete fixture required");
    view.groups[0]!.projections[0]!.sources = [{ title: "规范来源", url: "https://c.test/canonical", requestedUrl: "https://a.test/source", finalUrl: "https://b.test/final", kind: "page_excerpt" }];
    api.companyResearch.getEvidence.mockResolvedValue(view);
    render(<ResearchEvidenceDetails api={api} {...target} />);
    await screen.findByText("检索依据");
    expect(screen.getByText("返回的规范 / 来源链接：")).toBeTruthy();
    expect(screen.getByText("请求链接：")).toBeTruthy();
    expect(screen.getByText("实际获取链接：")).toBeTruthy();
    expect(screen.getByRole("link", { name: "规范来源", hidden: true }).getAttribute("href")).toBe("https://c.test/canonical");
    expect(screen.getByRole("link", { name: "https://a.test/source", hidden: true }).getAttribute("href")).toBe("https://a.test/source");
    expect(screen.getByRole("link", { name: "https://b.test/final", hidden: true }).getAttribute("href")).toBe("https://b.test/final");
  });
  it.each([
    { changed: false, omittedItems: null, expected: false },
    { changed: true, omittedItems: null, expected: true },
    { changed: false, omittedItems: 2, expected: true },
  ])("shows clipping only with positive evidence: %j", async ({ changed, omittedItems, expected }) => {
    const api = makeFakeApi(); const view = fixture();
    if (view.status !== "complete") throw new Error("complete fixture required");
    view.groups[0]!.projections[0]!.modelClipping = { version: "v1", beforeBytes: 20, afterBytes: changed ? 10 : 20,
      beforeHash: "a".repeat(64), afterHash: (changed ? "b" : "a").repeat(64), omittedItems };
    api.companyResearch.getEvidence.mockResolvedValue(view);
    render(<ResearchEvidenceDetails api={api} {...target} />);
    await screen.findByText("检索依据");
    expect(screen.queryByText(/模型收到的结果已裁剪/) !== null).toBe(expected);
    expect(screen.queryByText(/检索依据部分留存/)).toBeNull();
  });
  it.each([false, true])("shows grouped evidence and original URL (%s)", async partial => {
    const api = makeFakeApi(); api.companyResearch.getEvidence.mockResolvedValue(fixture(partial));
    const copyText = vi.fn().mockResolvedValue(undefined); Object.defineProperty(window, "deepfield", { configurable: true, value: { copyText } });
    render(<ResearchEvidenceDetails api={api} {...target} />);
    await screen.findByText("检索依据");
    expect(screen.getByText(partial ? /检索依据部分留存/ : /检索依据已留存/)).toBeTruthy();
    expect(screen.getAllByRole("link", { hidden: true })).toHaveLength(2);
    expect(screen.getAllByText("结果组的共同正文")).toHaveLength(1);
    expect(screen.getByText(/PublishTime/).textContent).toContain("2026-01-01T12:00:00+08:00");
    expect(screen.getByText(/发表日期未知/)).toBeTruthy();
    expect(screen.getByText(/已发送，响应失败/)).toBeTruthy();
    fireEvent.mouseEnter(screen.getByText("来源一")); fireEvent.click(screen.getByText("复制链接"));
    await waitFor(() => expect(copyText).toHaveBeenCalledWith("https://source.test/a?q=raw"));
    if (partial) expect(screen.getByText(/单片段容量上限/)).toBeTruthy();
  });
  it("hides legacy and rejects a late response after a run switch", async () => {
    const api = makeFakeApi(); let resolve!: (view: ResearchEvidenceView) => void;
    api.companyResearch.getEvidence.mockImplementationOnce(() => new Promise(yes => { resolve = yes; })).mockResolvedValue({ status: "legacy_missing" });
    const ui = render(<ResearchEvidenceDetails api={api} {...target} />);
    ui.rerender(<ResearchEvidenceDetails api={api} {...target} runId="old" />);
    await act(async () => { resolve(fixture()); });
    expect(screen.queryByText("检索依据")).toBeNull(); expect(screen.queryByText("结果组的共同正文")).toBeNull();
  });
  it("shows required missing evidence separately from legacy", async () => {
    const api = makeFakeApi(); api.companyResearch.getEvidence.mockResolvedValue({ status: "evidence_incomplete" });
    render(<ResearchEvidenceDetails api={api} {...target} />);
    expect(await screen.findByText(/evidence_incomplete/)).toBeTruthy();
  });
  it("shows read failure without claiming missing archive", async () => {
    const api = makeFakeApi(); api.companyResearch.getEvidence.mockRejectedValue(new Error("storage"));
    render(<ResearchEvidenceDetails api={api} {...target} />);
    expect(await screen.findByText(/检索依据读取失败/)).toBeTruthy();
    expect(screen.queryByText(/evidence_incomplete/)).toBeNull();
  });
});
