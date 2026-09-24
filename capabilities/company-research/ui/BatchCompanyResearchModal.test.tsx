// @vitest-environment jsdom
import { act, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { CapabilityItemId, CompanyId } from "@deepfield/contracts";
import type { CompanyProfileProgress, CompanyResearchBatchState, ItemCompanyView } from "../contracts/index.js";
import { IndustryResearchCapability } from "./IndustryResearchCapability.js";
import { capabilityItem, makeFakeApi } from "../../../apps/desktop/src/renderer/renderer-test-helpers.js";
import { researchRun, researchSummary } from "./company-research-test-fixtures.js";

const company = (id: string, name: string, profileStatus: ItemCompanyView["profileStatus"] = "ready"): ItemCompanyView => ({ id: id as CompanyId, itemId: "topic" as CapabilityItemId, name, normalizedName: name, profileStatus, createdAt: "", updatedAt: "" });

describe("batch company research UI", () => {
  it.each(["detail", "settings", "topic", "chat-only"] as const)("keeps profile completion local to the visible company list when leaving for %s", async destination => {
    const fake = makeFakeApi(); const listeners = new Set<(state: CompanyProfileProgress) => void>();
    fake.industryResearch.subscribeCompanyProfileProgress.mockImplementation(listener => { listeners.add(listener); return () => listeners.delete(listener); });
    fake.industryResearch.listItems.mockResolvedValue([capabilityItem({ id: "topic", industry: "机器人" })]);
    fake.industryResearch.listCompanies.mockResolvedValue([company("a", "A公司")]);
    const completed: CompanyProfileProgress = { itemId: "topic", status: "completed", processed: 3, failed: 1, total: 3 };
    const emit = (state: CompanyProfileProgress) => act(() => { for (const listener of listeners) listener(state); });
    const user = userEvent.setup(); const view = render(<IndustryResearchCapability api={fake} onClose={() => {}} />);
    await user.click(await screen.findByRole("button", { name: /^机器人/ }));
    await screen.findByRole("button", { name: "查看 A公司" });
    emit(completed); expect(screen.getByText("公司资料补全已完成")).toBeTruthy();
    emit({ itemId: "topic", status: "idle", processed: 0, failed: 0, total: 0 });
    expect(screen.queryByText("公司资料补全已完成")).toBeNull();
    emit({ itemId: "topic", status: "running", processed: 0, failed: 0, total: 1 });
    expect(screen.getByText("正在自动补全公司信息")).toBeTruthy();
    emit(completed);
    fake.industryResearch.getCompanyProfileProgress.mockResolvedValue(completed);

    if (destination === "detail") await user.click(screen.getByRole("button", { name: "查看 A公司" }));
    else if (destination === "topic") await user.click(screen.getByRole("button", { name: "‹ 返回调研列表" }));
    else if (destination === "settings") view.rerender(<IndustryResearchCapability api={fake} onClose={() => {}} active={false} />);
    else view.rerender(<div>Chat</div>);
    emit(completed);
    if (destination === "detail") await user.click(screen.getByRole("button", { name: "‹ 返回公司列表" }));
    else if (destination === "topic") await user.click(screen.getByRole("button", { name: /^机器人/ }));
    else {
      view.rerender(<IndustryResearchCapability api={fake} onClose={() => {}} active />);
      if (destination === "chat-only") await user.click(await screen.findByRole("button", { name: /^机器人/ }));
    }
    await screen.findByRole("button", { name: "查看 A公司" });
    expect(screen.queryByText("公司资料补全已完成")).toBeNull();
  });

  it.each(["detail", "settings", "topic", "chat-only"] as const)("forgets completion after leaving for %s, including completion while away", async destination => {
    const fake = makeFakeApi(); const listeners = new Set<(state: CompanyResearchBatchState) => void>();
    fake.companyResearchBatch.subscribe.mockImplementation(listener => { listeners.add(listener); return () => listeners.delete(listener); });
    fake.industryResearch.listItems.mockResolvedValue([capabilityItem({ id: "topic", industry: "机器人" })]);
    fake.industryResearch.listCompanies.mockResolvedValue([company("a", "A公司")]);
    const terminal: CompanyResearchBatchState = { batchId: "b", itemId: "topic", status: "completed", entries: [], succeeded: 2, failed: 0, processed: 2, total: 2 };
    const emit = () => act(() => { for (const listener of listeners) listener(terminal); });
    const user = userEvent.setup();
    const view = render(<IndustryResearchCapability api={fake} onClose={() => {}} />);
    await user.click(await screen.findByRole("button", { name: /^机器人/ }));
    await screen.findByRole("button", { name: "查看 A公司" });
    emit(); expect(screen.getByText("调研队列已完成")).toBeTruthy();
    // A late snapshot is never a reason to restore a finished notice.
    fake.companyResearchBatch.getState.mockResolvedValue(terminal);
    if (destination === "detail") await user.click(screen.getByRole("button", { name: "查看 A公司" }));
    else if (destination === "topic") await user.click(screen.getByRole("button", { name: "‹ 返回调研列表" }));
    else if (destination === "settings") view.rerender(<IndustryResearchCapability api={fake} onClose={() => {}} active={false} />);
    else view.rerender(<div>Chat</div>);
    emit();
    if (destination === "detail") await user.click(screen.getByRole("button", { name: "‹ 返回公司列表" }));
    else if (destination === "topic") await user.click(screen.getByRole("button", { name: /^机器人/ }));
    else {
      view.rerender(<IndustryResearchCapability api={fake} onClose={() => {}} active />);
      if (destination === "chat-only") await user.click(await screen.findByRole("button", { name: /^机器人/ }));
    }
    await screen.findByRole("button", { name: "查看 A公司" });
    expect(screen.queryByText("调研队列已完成")).toBeNull();
  });

  it("refreshes report metadata after generation and after returning from a report deletion", async () => {
    const fake = makeFakeApi();
    const a = company("a", "A公司"); const b = company("b", "B公司");
    fake.industryResearch.listItems.mockResolvedValue([capabilityItem({ id: "topic", industry: "机器人" })]);
    fake.industryResearch.listCompanies.mockResolvedValue([a, b]);
    const user = userEvent.setup(); render(<IndustryResearchCapability api={fake} onClose={() => {}} />);
    await user.click(await screen.findByRole("button", { name: /^机器人/ }));
    await screen.findByRole("button", { name: "查看 A公司" });
    expect(screen.queryByText(/报告 \d+ 份/)).toBeNull();
    const date = new Date(2026, 8, 17, 14, 5).toISOString();
    let finishRefresh!: (companies: ItemCompanyView[]) => void;
    fake.industryResearch.listCompanies.mockImplementationOnce(() => new Promise(resolve => { finishRefresh = resolve; }));
    act(() => fake.emitResearch({ type: "state_changed", itemId: "topic", companyId: "a", runId: "run" }));
    expect(screen.getByRole("button", { name: "查看 A公司" })).toBeTruthy();
    expect(screen.queryByText("加载公司列表…")).toBeNull();
    await act(async () => finishRefresh([{ ...a, reportSummary: { count: 2, latestCreatedAt: date } }, b]));
    expect(await screen.findByLabelText("报告 2 份 · 最新创建于 2026-09-17 14:05")).toBeTruthy();
    expect(fake.companyResearch.getRun).not.toHaveBeenCalled();
    const row = screen.getByRole("button", { name: "查看 A公司" }).parentElement!;
    expect(within(row).getByLabelText(/报告 2 份/).nextElementSibling).toBe(within(row).getByRole("button", { name: "删除公司 A公司" }));
    const run = researchRun({ itemId: a.itemId, companyId: a.id });
    const older = researchRun({ id: "older" as typeof run.id, itemId: a.itemId, companyId: a.id });
    fake.companyResearch.getState.mockResolvedValue({ runs: [researchSummary(run), researchSummary(older)], globalActiveRun: null });
    fake.companyResearch.getRun.mockResolvedValue(run);
    fake.companyResearch.deleteRun.mockImplementation(async () => {
      fake.companyResearch.getState.mockResolvedValue({ runs: [researchSummary(older)], globalActiveRun: null });
      fake.industryResearch.listCompanies.mockResolvedValue([{ ...a, reportSummary: { count: 1, latestCreatedAt: date } }, b]);
    });
    await user.click(screen.getByRole("button", { name: "查看 A公司" }));
    await user.click(await screen.findByRole("button", { name: "删除" }));
    await user.click(within(screen.getByRole("dialog", { name: "删除调研报告" })).getByRole("button", { name: "确认删除" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "删除调研报告" })).toBeNull());
    await user.click(screen.getByRole("button", { name: "‹ 返回公司列表" }));
    expect(await screen.findByLabelText("报告 1 份 · 最新创建于 2026-09-17 14:05")).toBeTruthy();
    expect(screen.queryByText(/报告 2 份/)).toBeNull();
  });

  it("renders report counts and timestamps as shared semantic columns while no-report rows stay plain", async () => {
    const fake = makeFakeApi(); const date = new Date(2026, 8, 17, 14, 5).toISOString();
    fake.industryResearch.listItems.mockResolvedValue([capabilityItem({ id: "topic", industry: "机器人" })]);
    fake.industryResearch.listCompanies.mockResolvedValue([
      { ...company("a", "三份公司"), reportSummary: { count: 3, latestCreatedAt: date } },
      { ...company("b", "四份公司"), reportSummary: { count: 4, latestCreatedAt: date } },
      { ...company("c", "十二份公司"), reportSummary: { count: 12, latestCreatedAt: date } },
      company("d", "无报告公司"),
    ]);
    const user = userEvent.setup(); render(<IndustryResearchCapability api={fake} onClose={() => {}} />);
    await user.click(await screen.findByRole("button", { name: /^机器人/ }));
    for (const count of [3, 4, 12]) {
      const summary = screen.getByLabelText(`报告 ${count} 份 · 最新创建于 2026-09-17 14:05`);
      expect(within(summary).getByText(`报告 ${count} 份`)).toHaveProperty("className", "company-report-count");
      expect(within(summary).getByText("2026-09-17 14:05").tagName).toBe("TIME");
    }
    expect(screen.getByRole("button", { name: "查看 无报告公司" }).parentElement?.querySelector(".company-report-summary")).toBeNull();
  });

  it("keeps batch actions outside the scrolling body and shows one-line queue and report metadata", async () => {
    const fake = makeFakeApi(); const date = new Date(2026, 8, 17, 14, 5).toISOString();
    fake.industryResearch.listItems.mockResolvedValue([capabilityItem({ id: "topic", industry: "机器人" })]);
    fake.industryResearch.listCompanies.mockResolvedValue([
      { ...company("a", "名字很长但应当保持单行显示的公司"), reportSummary: { count: 3, latestCreatedAt: date } },
      company("b", "等待中的公司"),
      company("c", "可选择的公司"),
    ]);
    const input = { direction: "product_and_technology" as const, asOfDate: "2026-09-17" };
    fake.companyResearchBatch.getState.mockResolvedValue({
      batchId: "batch", itemId: "other-topic", status: "running",
      entries: [
        { entryId: "running", itemId: "other-topic", companyId: "a", input, status: "running", stage: "structure" },
        { entryId: "pending", itemId: "other-topic", companyId: "b", input, status: "pending" },
      ],
      processed: 0, succeeded: 0, failed: 0, total: 2,
    });
    const user = userEvent.setup(); const view = render(<IndustryResearchCapability api={fake} onClose={() => {}} />);
    await user.click(await screen.findByRole("button", { name: /^机器人/ }));
    await user.click(screen.getByRole("button", { name: "批量调研公司" }));

    const dialog = screen.getByRole("dialog", { name: "批量调研公司" });
    const body = dialog.querySelector<HTMLElement>(".batch-research-modal")!;
    const footer = within(dialog).getByRole("button", { name: "下一步" }).parentElement!;
    expect(footer).toHaveProperty("className", expect.stringContaining("modal-footer"));
    expect(footer.parentElement).toBe(dialog);
    expect(body.contains(footer)).toBe(false);
    expect(within(dialog).getByText("正在整理调研结果")).toBeTruthy();
    expect(within(dialog).getByText("等待调研")).toBeTruthy();
    expect((within(dialog).getByRole("checkbox", { name: "选择 名字很长但应当保持单行显示的公司" }) as HTMLInputElement).disabled).toBe(true);
    expect((within(dialog).getByRole("checkbox", { name: "选择 等待中的公司" }) as HTMLInputElement).disabled).toBe(true);
    expect(within(dialog).getByLabelText("报告 3 份 最新创建于 2026-09-17")).toBeTruthy();
    const longName = within(dialog).getByText("名字很长但应当保持单行显示的公司");
    expect(longName).toHaveProperty("title", "名字很长但应当保持单行显示的公司");

    await user.click(screen.getByRole("checkbox", { name: "选择 可选择的公司" }));
    await user.click(screen.getByRole("button", { name: "下一步" }));
    await user.click(screen.getByRole("button", { name: "下一步" }));
    const confirmDialog = screen.getByRole("dialog", { name: "批量调研公司" });
    const confirmBody = confirmDialog.querySelector<HTMLElement>(".batch-research-modal")!;
    const confirmFooter = within(confirmDialog).getByRole("button", { name: "开始调研" }).parentElement!;
    expect(confirmFooter.parentElement).toBe(confirmDialog);
    expect(confirmBody.contains(confirmFooter)).toBe(false);
    view.unmount();
  });

  it("keeps shared defaults and company overrides while moving backward and reselecting", async () => {
    const fake = makeFakeApi();
    fake.industryResearch.listItems.mockResolvedValue([capabilityItem({ id: "topic", industry: "机器人" })]);
    fake.industryResearch.listCompanies.mockResolvedValue([company("a", "A公司"), company("b", "B公司"), company("c", "C公司"), company("d", "D公司", "pending")]);
    fake.companyResearchBatch.start.mockResolvedValue({ batchId: "batch", itemId: "topic", status: "running", entries: [], processed: 0, succeeded: 0, failed: 0, total: 2 });
    const user = userEvent.setup(); render(<IndustryResearchCapability api={fake} onClose={() => {}} />);
    await user.click(await screen.findByRole("button", { name: /^机器人/ }));
    const toolbar = screen.getByRole("button", { name: "批量调研公司" }).parentElement!;
    expect(within(toolbar).getAllByRole("button").map(button => button.textContent)).toEqual(["批量调研公司", "添加公司", "批量删除", "一键导入公司"]);
    await user.click(screen.getByRole("button", { name: "批量调研公司" }));
    await user.click(screen.getByRole("checkbox", { name: "选择 A公司" }));
    await user.click(screen.getByRole("checkbox", { name: "选择 B公司" }));
    expect((screen.getByRole("checkbox", { name: /选择 D公司/ }) as HTMLInputElement).disabled).toBe(false);
    expect(screen.queryByText(/公司资料尚未就绪/)).toBeNull();
    await user.click(screen.getByRole("button", { name: "下一步" }));
    await user.selectOptions(screen.getByLabelText("研究方向"), "market_and_commercialization");
    await user.type(screen.getByLabelText("关注范围（可选）"), "共同范围");
    await user.click(screen.getByRole("button", { name: "下一步" }));
    expect(screen.queryByText("共同范围")).toBeNull();
    await user.click(screen.getByRole("button", { name: "编辑 B公司" }));
    await user.clear(screen.getByLabelText("关注范围（可选）")); await user.type(screen.getByLabelText("关注范围（可选）"), "B范围");
    await user.selectOptions(screen.getByLabelText("研究方向"), "operations_and_performance");
    await user.click(screen.getByRole("button", { name: "确认修改" }));
    expect(fake.companyResearch.start).not.toHaveBeenCalled(); expect(fake.companyResearchBatch.start).not.toHaveBeenCalled();
    expect(within(screen.getByTestId("batch-confirm-b")).getByText("已修改")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "上一步" }));
    await user.clear(screen.getByLabelText("关注范围（可选）")); await user.type(screen.getByLabelText("关注范围（可选）"), "新共同范围");
    await user.click(screen.getByRole("button", { name: "下一步" }));
    await user.click(screen.getByRole("button", { name: "上一步" }));
    await user.click(screen.getByRole("button", { name: "上一步" }));
    await user.click(screen.getByRole("checkbox", { name: "选择 B公司" }));
    await user.click(screen.getByRole("checkbox", { name: "选择 C公司" }));
    await user.click(screen.getByRole("button", { name: "下一步" })); await user.click(screen.getByRole("button", { name: "下一步" }));
    await user.click(screen.getByRole("button", { name: "开始调研" }));
    await waitFor(() => expect(fake.companyResearchBatch.start).toHaveBeenCalledTimes(1));
    expect(fake.companyResearchBatch.start.mock.calls[0]?.[1]).toEqual([
      expect.objectContaining({ companyId: "a", input: expect.objectContaining({ focusScope: "新共同范围" }) }),
      expect.objectContaining({ companyId: "c", input: expect.objectContaining({ focusScope: "新共同范围" }) }),
    ]);
  });

  it("renders selected-topic progress, permits navigation, cancels once, and rejects a stale snapshot", async () => {
    const fake = makeFakeApi(); const listeners = new Set<(state: CompanyResearchBatchState) => void>();
    const item = capabilityItem({ id: "topic", industry: "机器人" }); const a = company("a", "A公司");
    fake.industryResearch.listItems.mockResolvedValue([item]); fake.industryResearch.listCompanies.mockResolvedValue([a]);
    let resolveSnapshot!: (state: CompanyResearchBatchState | null) => void;
    fake.companyResearchBatch.subscribe.mockImplementation((listener) => { listeners.add(listener); return () => listeners.delete(listener); });
    fake.companyResearchBatch.getState.mockImplementation(() => new Promise((resolve) => { resolveSnapshot = resolve; }));
    let finishCancel!: () => void; fake.companyResearchBatch.cancel.mockImplementation(() => new Promise<void>((resolve) => { finishCancel = resolve; }));
    const running: CompanyResearchBatchState = { batchId: "batch", itemId: "topic", status: "running", entries: [{ companyId: "a", input: { direction: "product_and_technology", asOfDate: "2026-09-17" }, status: "running", stage: "raw" }], processed: 1, succeeded: 1, failed: 0, total: 2 };
    const user = userEvent.setup(); render(<IndustryResearchCapability api={fake} onClose={() => {}} />);
    await user.click(await screen.findByRole("button", { name: /^机器人/ }));
    act(() => { for (const listener of listeners) listener(running); });
    resolveSnapshot({ ...running, status: "paused", processed: 0 });
    expect(await screen.findByText("正在进行公司调研")).toBeTruthy();
    expect(screen.getByRole("progressbar", { name: "调研队列进度" }).textContent).toContain("0/1");
    expect(screen.getByRole("status", { name: "调研队列进行中" })).toBeTruthy();
    expect(screen.getByText("正在收集调研资料")).toHaveProperty("className", "company-research-active-status");
    await user.click(screen.getByRole("button", { name: "查看 A公司" }));
    expect(await screen.findByRole("heading", { name: "A公司" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "‹ 返回公司列表" }));
    await user.dblClick(screen.getByRole("button", { name: "取消整个调研队列" }));
    await waitFor(() => expect(fake.companyResearchBatch.cancel).toHaveBeenCalledTimes(1));
    expect(fake.companyResearchBatch.cancel).toHaveBeenCalledWith("batch");
    finishCancel();
  });

  it("shows paused actions without a spinner", async () => {
    const fake = makeFakeApi(); const item = capabilityItem({ id: "topic", industry: "机器人" });
    fake.industryResearch.listItems.mockResolvedValue([item]); fake.industryResearch.listCompanies.mockResolvedValue([company("a", "A公司")]);
    fake.companyResearchBatch.resume.mockResolvedValue({ batchId: "b", itemId: "topic", status: "running", entries: [], processed: 0, succeeded: 0, failed: 0, total: 1 });
    fake.companyResearchBatch.getState.mockResolvedValue({ batchId: "b", itemId: "topic", status: "paused", entries: [], processed: 0, succeeded: 0, failed: 0, total: 1, issue: { code: "CONFIG.CREDENTIAL_MISSING", category: "configuration", context: { service: "search" } } });
    const settings = vi.fn(); const user = userEvent.setup(); render(<IndustryResearchCapability api={fake} onClose={() => {}} onOpenSettings={settings} />);
    await user.click(await screen.findByRole("button", { name: /^机器人/ }));
    expect(await screen.findByText(/调研队列已暂停/)).toBeTruthy();
    expect(screen.queryByRole("status", { name: "调研队列进行中" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "前往设置" })); expect(settings).toHaveBeenCalledWith("search");
    await user.click(screen.getByRole("button", { name: "继续调研" })); expect(fake.companyResearchBatch.resume).toHaveBeenCalledWith("b");
  });

  it("shows a recovered running entry as paused without a row spinner while pending entries still wait", async () => {
    const fake = makeFakeApi(); const item = capabilityItem({ id: "topic", industry: "机器人" });
    fake.industryResearch.listItems.mockResolvedValue([item]); fake.industryResearch.listCompanies.mockResolvedValue([company("a", "A公司"), company("b", "B公司")]);
    const input = { direction: "product_and_technology" as const, asOfDate: "2026-09-17" };
    fake.companyResearchBatch.getState.mockResolvedValue({ batchId: "batch", itemId: "topic", status: "paused", entries: [{ companyId: "a", input, status: "running", stage: "structure", interrupted: true }, { companyId: "b", input, status: "pending" }], processed: 0, succeeded: 0, failed: 0, total: 2 });
    const user = userEvent.setup(); render(<IndustryResearchCapability api={fake} onClose={() => {}} />);
    await user.click(await screen.findByRole("button", { name: /^机器人/ }));
    expect(await screen.findByText("已暂停")).toBeTruthy();
    expect(screen.getByText("等待调研")).toBeTruthy();
    expect(screen.queryByRole("status", { name: /A公司.*正在/ })).toBeNull();
    expect(screen.getByRole("button", { name: "查看 A公司" })).toBeTruthy();
  });
});
