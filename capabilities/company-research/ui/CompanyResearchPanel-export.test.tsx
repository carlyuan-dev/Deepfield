// @vitest-environment jsdom
import { act, fireEvent, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { CompanyResearchState, ResearchRun } from "../contracts/index.js";
import { makeFakeApi } from "../../../apps/desktop/src/renderer/renderer-test-helpers.js";
import { CompanyResearchPanel } from "./CompanyResearchPanel.js";
import { activeResearch, researchRun, researchSummary } from "./company-research-test-fixtures.js";

const context = { itemId: "item-research", companyId: "company-research", topicName: "智能眼镜", topicScope: "中国市场", companyName: "小米", companyNote: "重点候选" };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe("company research Word export", () => {
  it("opens beside the report tabs and defaults to structured independently of the visible raw tab", async () => {
    const api = makeFakeApi(); const user = userEvent.setup();
    const run = researchRun({ id: "run-selected" as ResearchRun["id"], rawReportText: "选中正文" });
    api.companyResearch.getState.mockResolvedValue({ runs: [researchSummary(run)], globalActiveRun: null });
    api.companyResearch.getRun.mockResolvedValue(run);
    render(<CompanyResearchPanel api={api} {...context} />);
    await screen.findByText("选中正文");
    const button = screen.getByRole("button", { name: "导出 Word" });
    const toolbar = button.parentElement;
    const tabs = screen.getByRole("tablist", { name: "报告视图" });
    expect(toolbar?.getAttribute("role")).toBe("group");
    expect(tabs.lastElementChild).toBe(screen.getByRole("tab", { name: "结构化报告" }));
    expect(tabs.nextElementSibling).toBe(button);
    await user.click(button);
    expect(screen.getByRole("dialog", { name: "选择导出内容" })).toBeTruthy();
    const raw = screen.getByRole("checkbox", { name: "原始调研报告" }) as HTMLInputElement;
    const structured = screen.getByRole("checkbox", { name: "结构化报告" }) as HTMLInputElement;
    expect(raw.checked).toBe(false); expect(structured.checked).toBe(true);
    await user.click(screen.getByRole("button", { name: "确认导出" }));
    expect(api.companyResearch.exportWord).toHaveBeenCalledWith(context.itemId, context.companyId, run.id, { raw: false, structured: true });
    const feedback = await screen.findByText("Word 报告已保存。");
    expect(button.nextElementSibling).toBe(feedback);
  });

  it("defaults to raw when structured is unavailable, explains disabled choices, and blocks an empty selection", async () => {
    const api = makeFakeApi(); const user = userEvent.setup();
    const run = researchRun({ status: "structure_failed", rawReportText: "仅原始正文", lastFailureCode: "structuring_failed" });
    api.companyResearch.getState.mockResolvedValue({ runs: [researchSummary(run)], globalActiveRun: null });
    api.companyResearch.getRun.mockResolvedValue(run);
    render(<CompanyResearchPanel api={api} {...context} />);
    await user.click(await screen.findByRole("button", { name: "导出 Word" }));
    const raw = screen.getByRole("checkbox", { name: "原始调研报告" }) as HTMLInputElement;
    const structured = screen.getByRole("checkbox", { name: "结构化报告" }) as HTMLInputElement;
    expect(raw.checked).toBe(true); expect(structured.disabled).toBe(true);
    expect(screen.getByText("此版本没有可用的结构化报告。")).toBeTruthy();
    await user.click(raw);
    expect((screen.getByRole("button", { name: "确认导出" }) as HTMLButtonElement).disabled).toBe(true);
    expect(api.companyResearch.exportWord).not.toHaveBeenCalled();
  });

  it("stays disabled until the selected persisted body is loaded and rejects active content", async () => {
    const api = makeFakeApi(); const pending = deferred<ResearchRun | undefined>(); const empty = researchRun({ rawReportText: "   " });
    api.companyResearch.getState.mockResolvedValue({ runs: [researchSummary(empty)], globalActiveRun: null }); api.companyResearch.getRun.mockReturnValue(pending.promise);
    const view = render(<CompanyResearchPanel api={api} {...context} />);
    const exportButton = await screen.findByRole("button", { name: "导出 Word" }) as HTMLButtonElement;
    expect(exportButton.disabled).toBe(true); await act(async () => pending.resolve(empty)); expect(exportButton.disabled).toBe(true); view.unmount();
    const activeApi = makeFakeApi(); const active = researchRun({ status: "researching", companyId: "active-company" as ResearchRun["companyId"] });
    activeApi.companyResearch.getState.mockResolvedValue(activeResearch(active, "尚未保存的流式正文"));
    render(<CompanyResearchPanel api={activeApi} {...context} companyId="active-company" />);
    await screen.findByText("尚未保存的流式正文");
    expect((screen.getByRole("button", { name: "导出 Word" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("supports both choices and ignores duplicate confirmation while saving", async () => {
    const api = makeFakeApi(); const user = userEvent.setup(); const run = researchRun(); const saving = deferred<{ status: "saved" | "cancelled" }>();
    api.companyResearch.getState.mockResolvedValue({ runs: [researchSummary(run)], globalActiveRun: null }); api.companyResearch.getRun.mockResolvedValue(run); api.companyResearch.exportWord.mockReturnValue(saving.promise);
    render(<CompanyResearchPanel api={api} {...context} />);
    await user.click(await screen.findByRole("button", { name: "导出 Word" })); await user.click(screen.getByRole("checkbox", { name: "原始调研报告" }));
    const confirm = screen.getByRole("button", { name: "确认导出" }); fireEvent.click(confirm); fireEvent.click(confirm);
    expect(screen.getByRole("button", { name: "导出中…" })).toBeTruthy(); expect(api.companyResearch.exportWord).toHaveBeenCalledTimes(1);
    expect(api.companyResearch.exportWord).toHaveBeenCalledWith(context.itemId, context.companyId, run.id, { raw: true, structured: true });
    await act(async () => saving.resolve({ status: "saved" })); expect(await screen.findByText("Word 报告已保存。")).toBeTruthy();
  });

  it.each([
    ["cancelled", { status: "cancelled" as const }, "已取消导出。", "status"],
    ["failed", new Error("private path and provider details"), "导出 Word 失败，请重试。", "alert"],
  ] as const)("presents a safe, scoped %s outcome", async (_case, outcome, message, role) => {
    const api = makeFakeApi(); const user = userEvent.setup(); const run = researchRun();
    api.companyResearch.getState.mockResolvedValue({ runs: [researchSummary(run)], globalActiveRun: null }); api.companyResearch.getRun.mockResolvedValue(run);
    if (outcome instanceof Error) api.companyResearch.exportWord.mockRejectedValue(outcome); else api.companyResearch.exportWord.mockResolvedValue(outcome);
    render(<CompanyResearchPanel api={api} {...context} />);
    await user.click(await screen.findByRole("button", { name: "导出 Word" })); await user.click(screen.getByRole("button", { name: "确认导出" }));
    expect(await screen.findByRole(role, { name: message })).toBeTruthy(); expect(screen.queryByText(/private path|provider details/)).toBeNull();
  });

  it("closes a stale choice dialog on version switch and exports only a fresh selection", async () => {
    const api = makeFakeApi(); const user = userEvent.setup();
    const first = researchRun({ id: "run-first" as ResearchRun["id"], rawReportText: "第一版正文" }); const second = researchRun({ id: "run-second" as ResearchRun["id"], rawReportText: "第二版正文" });
    api.companyResearch.getState.mockResolvedValue({ runs: [researchSummary(first), researchSummary(second)], globalActiveRun: null }); api.companyResearch.getRun.mockImplementation(async (_item, _company, runId) => runId === first.id ? first : second);
    render(<CompanyResearchPanel api={api} {...context} />);
    await user.click(await screen.findByRole("button", { name: "导出 Word" })); await user.selectOptions(screen.getByLabelText("报告版本"), second.id); await screen.findByText("第二版正文");
    expect(screen.queryByRole("dialog", { name: "选择导出内容" })).toBeNull(); expect(api.companyResearch.exportWord).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "导出 Word" })); await user.click(screen.getByRole("button", { name: "确认导出" }));
    expect(api.companyResearch.exportWord).toHaveBeenCalledWith(context.itemId, context.companyId, second.id, { raw: false, structured: true });
  });

  it("does not surface a late export result after switching targets", async () => {
    const api = makeFakeApi(); const user = userEvent.setup(); const first = researchRun();
    const second = researchRun({ itemId: "item-two" as ResearchRun["itemId"], companyId: "company-two" as ResearchRun["companyId"], rawReportText: "第二家公司正文" }); const saving = deferred<{ status: "saved" | "cancelled" }>();
    api.companyResearch.getState.mockImplementation(async (itemId, companyId): Promise<CompanyResearchState> => ({ runs: [researchSummary(itemId === first.itemId && companyId === first.companyId ? first : second)], globalActiveRun: null }));
    api.companyResearch.getRun.mockImplementation(async (itemId, companyId) => itemId === first.itemId && companyId === first.companyId ? first : second); api.companyResearch.exportWord.mockReturnValueOnce(saving.promise);
    const view = render(<CompanyResearchPanel api={api} {...context} />);
    await user.click(await screen.findByRole("button", { name: "导出 Word" })); await user.click(screen.getByRole("button", { name: "确认导出" }));
    view.rerender(<CompanyResearchPanel api={api} {...context} itemId="item-two" companyId="company-two" companyName="第二家公司" />); await screen.findByText("第二家公司正文");
    await act(async () => saving.resolve({ status: "saved" })); expect(screen.queryByText("Word 报告已保存。")).toBeNull();
  });

  it("keeps an open export choice stable when another company streams tool and text events", async () => {
    const api = makeFakeApi(); const user = userEvent.setup(); const run = researchRun();
    api.companyResearch.getState.mockResolvedValue({ runs: [researchSummary(run)], globalActiveRun: null });
    api.companyResearch.getRun.mockResolvedValue(run);
    render(<CompanyResearchPanel api={api} {...context} />);
    await user.click(await screen.findByRole("button", { name: "导出 Word" }));
    expect(api.companyResearch.getState).toHaveBeenCalledTimes(1);
    expect(api.companyResearch.getRun).toHaveBeenCalledTimes(1);

    act(() => {
      api.emitResearch({ type: "tool_activity", requestId: "foreign-request", runId: "foreign-run", stage: "raw", callKey: "call-1", name: "web_search", status: "running" });
      api.emitResearch({ type: "text_delta", requestId: "foreign-request", runId: "foreign-run", stage: "raw", delta: "foreign text" });
      api.emitResearch({ type: "state_changed", itemId: "other-item", companyId: "other-company", runId: "foreign-run" });
    });

    expect(screen.getByRole("dialog", { name: "选择导出内容" })).toBeTruthy();
    expect((screen.getByRole("button", { name: "确认导出" }) as HTMLButtonElement).disabled).toBe(false);
    expect(api.companyResearch.getState).toHaveBeenCalledTimes(1);
    expect(api.companyResearch.getRun).toHaveBeenCalledTimes(1);
  });
});
