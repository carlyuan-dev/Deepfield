// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { CompanyResearchState, ResearchRun } from "@deepfield/contracts";
import { makeFakeApi } from "../../renderer-test-helpers.js";
import { CompanyResearchPanel } from "./CompanyResearchPanel.js";
import { CompanyResearchModal } from "./CompanyResearchModal.js";
import { activeResearch, researchRun, researchSummary } from "./company-research-test-fixtures.js";

const context = { itemId: "item-research", companyId: "company-research", topicName: "智能眼镜", topicScope: "中国市场", companyName: "小米", companyNote: "重点候选" };
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe("two-stage company research", () => {
  it.each(["pending", "reject"] as const)("keeps the same-run stream on early structure failure while first detail reads %s", async (outcome) => {
    const fake = makeFakeApi(); const user = userEvent.setup();
    const initialDetail = deferred<ResearchRun | undefined>();
    const failedDetail = deferred<ResearchRun | undefined>();
    const otherDetail = deferred<ResearchRun | undefined>();
    const run = researchRun({ status: "researching" });
    const failed = researchRun({ status: "structure_failed" });
    const other = researchRun({ id: "other-run" as ResearchRun["id"], status: "structure_failed" });
    fake.companyResearch.getState.mockResolvedValue(activeResearch(run, "本轮流式原文"));
    fake.companyResearch.getRun.mockReturnValueOnce(initialDetail.promise).mockReturnValueOnce(failedDetail.promise).mockReturnValue(otherDetail.promise);
    render(<CompanyResearchPanel api={fake} {...context} />);
    await screen.findByText("本轮流式原文");
    fake.companyResearch.getState.mockResolvedValue(activeResearch({ ...run, status: "structuring" }, ""));
    act(() => fake.emitResearch({ type: "state_changed", itemId: run.itemId, companyId: run.companyId, runId: run.id }));
    await waitFor(() => expect(fake.companyResearch.getRun).toHaveBeenCalledTimes(1));
    fake.companyResearch.getState.mockResolvedValue({ runs: [researchSummary(failed), researchSummary(other)], globalActiveRun: null });
    act(() => fake.emitResearch({ type: "state_changed", itemId: run.itemId, companyId: run.companyId, runId: run.id }));
    await screen.findByText("整理失败，请重试");
    await waitFor(() => expect(fake.companyResearch.getRun).toHaveBeenCalledTimes(2));
    if (outcome === "reject") {
      await act(async () => { initialDetail.reject(new Error("private initial read")); failedDetail.reject(new Error("private failed read")); });
      await screen.findByText("加载调研报告失败，请重试");
    }
    expect(screen.getByText("本轮流式原文")).toBeTruthy();
    expect(screen.queryByText(/private/)).toBeNull();
    await user.selectOptions(screen.getByLabelText("报告版本"), other.id);
    expect(screen.queryByText("本轮流式原文")).toBeNull();
    if (outcome === "pending") await act(async () => { initialDetail.resolve(failed); failedDetail.resolve(failed); });
    expect(screen.queryByText("本轮流式原文")).toBeNull();
    await act(async () => otherDetail.resolve({ ...other, rawReportText: "另一轮原文" }));
    expect(await screen.findByText("另一轮原文")).toBeTruthy();
    expect(screen.queryByText("本轮流式原文")).toBeNull();
  });

  it("identifies saved reports with snapshot context and history cutoff after live target edits", async () => {
    const fake = makeFakeApi(); const user = userEvent.setup();
    const run = researchRun({
      focusScope: "历史新品范围", asOfDate: "2025-06-30",
      researchContext: {
        companyName: "历史公司名称", legalName: "历史公司全称", aliases: ["历史别名"],
        headquarters: "历史总部", foundedAt: "2001-02-03", officialWebsite: "https://example.com/saved",
        stockListings: [{ exchange: "HKEX", ticker: "1234" }], businessTags: ["历史业务"],
        topicName: "历史研究主题", topicScope: "历史主题范围", companyNote: "历史候选备注",
        currentDate: "2025-07-01", direction: "product_and_technology", focusScope: "历史新品范围", asOfDate: "2025-06-30",
      },
    });
    fake.companyResearch.getState.mockResolvedValue({ runs: [researchSummary(run)], globalActiveRun: null });
    fake.companyResearch.getRun.mockResolvedValue(run);
    const view = render(<CompanyResearchPanel api={fake} {...context} companyName="当前公司名称" topicName="当前研究主题" />);
    const header = await screen.findByRole("region", { name: "报告研究背景" });
    expect([...header.querySelectorAll("dt")].map((node) => node.textContent)).toEqual(["研究主题", "研究方向", "重点研究范围", "截止日期"]);
    expect([...header.querySelectorAll("dd")].map((node) => node.textContent)).toEqual(["历史研究主题", "产品与技术", "历史新品范围", "2025-06-30"]);
    expect(screen.getByRole("option").textContent).toContain("截至 2025-06-30");
    expect(within(header).queryByRole("textbox")).toBeNull();
    expect(within(header).queryByRole("button")).toBeNull();
    view.rerender(<CompanyResearchPanel api={fake} {...context} companyName="再次改名" topicName="再次修改主题" topicScope="当前范围" />);
    expect(within(header).getByText("历史研究主题")).toBeTruthy();
    expect(screen.queryByText("再次改名")).toBeNull();
    await user.click(screen.getByRole("tab", { name: "原始调研报告" }));
    expect(screen.getByRole("region", { name: "报告研究背景" })).toBeTruthy();
    expect(screen.getByText("历史新品范围")).toBeTruthy();
    expect(await screen.findByText(/原始事实/)).toBeTruthy();
  });

  it("defaults completed reports to raw with the raw tab before the structured tab", async () => {
    const fake = makeFakeApi(); const user = userEvent.setup();
    const run = researchRun();
    fake.companyResearch.getState.mockResolvedValue({ runs: [researchSummary(run)], globalActiveRun: null });
    fake.companyResearch.getRun.mockResolvedValue(run);
    render(<CompanyResearchPanel api={fake} {...context} />);
    await screen.findByRole("tab", { name: "结构化报告" });
    expect(screen.getAllByRole("tab").map((node) => node.textContent)).toEqual(["原始调研报告", "结构化报告"]);
    expect(screen.getByRole("tab", { name: "原始调研报告" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("tabpanel").textContent).toContain("原始事实");
    expect(within(screen.getByRole("tabpanel")).queryByText("核心结论")).toBeNull();
    await user.click(screen.getByRole("tab", { name: "结构化报告" }));
    expect(within(screen.getByRole("tabpanel")).getByText("核心结论")).toBeTruthy();
  });

  it.each(["resolve", "reject"] as const)("retains the streamed raw body across an empty structuring snapshot and detail %s without leaking across runs or navigation", async (outcome) => {
    const fake = makeFakeApi();
    const pending = deferred<ResearchRun | undefined>();
    const nextDetail = deferred<ResearchRun | undefined>();
    const run = researchRun({ status: "researching" });
    fake.companyResearch.getState.mockResolvedValue(activeResearch(run, "流式原文"));
    fake.companyResearch.getRun.mockReturnValueOnce(pending.promise).mockReturnValue(nextDetail.promise);
    const view = render(<CompanyResearchPanel api={fake} {...context} />);
    await screen.findByText("流式原文");
    act(() => fake.emitResearch({ type: "text_delta", stage: "raw", requestId: "raw-request", runId: run.id, delta: "追加事实" }));
    await screen.findByText("流式原文追加事实");

    const structuring = researchRun({ status: "structuring" });
    // Production clears the transient draft as soon as raw is durably saved.
    fake.companyResearch.getState.mockResolvedValue(activeResearch(structuring, ""));
    act(() => fake.emitResearch({ type: "state_changed", itemId: run.itemId, companyId: run.companyId, runId: run.id }));
    await screen.findByText("正在整理结构化报告…");
    expect(screen.getByText("流式原文追加事实")).toBeTruthy();
    expect(fake.companyResearch.getRun).toHaveBeenCalledWith(context.itemId, context.companyId, run.id);

    await act(async () => {
      if (outcome === "resolve") pending.resolve(structuring);
      else pending.reject(new Error("private storage error"));
    });
    if (outcome === "resolve") {
      expect(await screen.findByText(/原始事实/)).toBeTruthy();
      expect(screen.queryByText("流式原文追加事实")).toBeNull();
    } else {
      expect(await screen.findByText("加载调研报告失败，请重试")).toBeTruthy();
      expect(screen.getByText("流式原文追加事实")).toBeTruthy();
      expect(screen.queryByText(/private storage/)).toBeNull();
    }

    const next = researchRun({ id: "next-run" as ResearchRun["id"], status: "structuring" });
    fake.companyResearch.getState.mockResolvedValue(activeResearch({ ...next, status: "researching" }, "下一轮原文"));
    act(() => fake.emitResearch({ type: "state_changed", itemId: next.itemId, companyId: next.companyId, runId: next.id }));
    await screen.findByText("下一轮原文");
    expect(screen.queryByText("流式原文追加事实")).toBeNull();
    expect(screen.queryByText(/原始事实/)).toBeNull();
    fake.companyResearch.getState.mockResolvedValue(activeResearch(next, ""));
    act(() => fake.emitResearch({ type: "state_changed", itemId: next.itemId, companyId: next.companyId, runId: next.id }));
    await waitFor(() => expect(fake.companyResearch.getRun).toHaveBeenLastCalledWith(context.itemId, context.companyId, next.id));
    expect(screen.queryByText("流式原文追加事实")).toBeNull();
    expect(screen.queryByText(/原始事实/)).toBeNull();
    expect(screen.getByText("下一轮原文")).toBeTruthy();

    fake.companyResearch.getState.mockResolvedValue({ runs: [], globalActiveRun: null });
    view.rerender(<CompanyResearchPanel api={fake} {...context} companyId="other" />);
    await screen.findByText("还没有调研报告。");
    await act(async () => nextDetail.resolve(next));
    expect(screen.queryByText("流式原文追加事实")).toBeNull();
    expect(screen.queryByText(/原始事实/)).toBeNull();
    expect(screen.queryByText("下一轮原文")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows only matching safe research failure outcomes and treats cancellation as nonfailure", async () => {
    const fake = makeFakeApi();
    const user = userEvent.setup();
    render(<CompanyResearchPanel api={fake} {...context} />);
    await screen.findByText("还没有调研报告。");
    act(() => fake.emitResearch({ type: "state_changed", itemId: "other-item", companyId: context.companyId, runId: "other-run", outcome: "research_failed" }));
    await waitFor(() => expect(fake.companyResearch.getState).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole("alert")).toBeNull();
    act(() => fake.emitResearch({ type: "state_changed", itemId: context.itemId, companyId: context.companyId, runId: "early-run", outcome: "research_failed" }));
    expect(await screen.findByText("调研未完成，请稍后重试")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "重新加载" }));
    const run = researchRun({ status: "researching" });
    fake.companyResearch.getState.mockResolvedValue(activeResearch(run, "未完成草稿"));
    act(() => fake.emitResearch({ type: "state_changed", itemId: context.itemId, companyId: context.companyId, runId: run.id }));
    await screen.findByText("未完成草稿");
    fake.companyResearch.getState.mockResolvedValue({ runs: [], globalActiveRun: null });
    act(() => fake.emitResearch({ type: "state_changed", itemId: context.itemId, companyId: context.companyId, runId: run.id, outcome: "cancelled" }));
    await screen.findByText("还没有调研报告。");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("does not leak late state, start errors, or subscriptions after navigation", async () => {
    const fake = makeFakeApi();
    const user = userEvent.setup();
    const pendingStart = deferred<ResearchRun>();
    const pendingState = deferred<CompanyResearchState>();
    fake.companyResearch.start.mockReturnValue(pendingStart.promise);
    const view = render(<CompanyResearchPanel api={fake} {...context} />);
    await user.click(await screen.findByRole("button", { name: "开始调研" }));
    await user.click(screen.getAllByRole("button", { name: "开始调研" })[1]!);
    fake.companyResearch.getState.mockReturnValueOnce(pendingState.promise);
    act(() => fake.emitResearch({ type: "state_changed", itemId: context.itemId, companyId: context.companyId, runId: "old" }));
    view.rerender(<CompanyResearchPanel api={fake} {...context} companyId="other" />);
    await screen.findByText("还没有调研报告。");
    await act(async () => {
      pendingStart.reject(new Error("secret"));
      pendingState.resolve(activeResearch(researchRun({ status: "researching" }), "旧公司草稿"));
    });
    expect(screen.queryByText("旧公司草稿")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(fake.researchListeners.size).toBe(1);
  });

  it("reconciles deltas included in a pending refresh without duplicating or dropping them", async () => {
    const fake = makeFakeApi();
    const run = researchRun({ status: "researching" });
    const pending = deferred<CompanyResearchState>();
    fake.companyResearch.getState.mockResolvedValue(activeResearch(run, "甲"));
    render(<CompanyResearchPanel api={fake} {...context} />);
    await screen.findByText("甲");
    fake.companyResearch.getState.mockReturnValueOnce(pending.promise).mockResolvedValue(activeResearch(run, "甲乙丙"));
    act(() => fake.emitResearch({ type: "state_changed", itemId: run.itemId, companyId: run.companyId, runId: run.id }));
    act(() => {
      fake.emitResearch({ type: "text_delta", stage: "raw", requestId: "req", runId: run.id, delta: "乙" });
      fake.emitResearch({ type: "text_delta", stage: "raw", requestId: "req", runId: run.id, delta: "丙" });
    });
    await act(async () => pending.resolve(activeResearch(run, "甲乙")));
    await waitFor(() => expect(fake.companyResearch.getState).toHaveBeenCalledTimes(3));
    expect(screen.getByText("甲乙丙")).toBeTruthy();
  });

  it("reads raw during structuring, retains it after failure, and retries the selected run", async () => {
    const fake = makeFakeApi();
    const user = userEvent.setup();
    let run = researchRun({ status: "structuring" });
    let state = activeResearch(run);
    fake.companyResearch.getState.mockImplementation(async () => state);
    fake.companyResearch.getRun.mockImplementation(async () => run);
    fake.companyResearch.retryStructuring.mockImplementation(async () => {
      run = { ...run, status: "structuring" };
      state = activeResearch(run);
      return run;
    });
    render(<CompanyResearchPanel api={fake} {...context} />);
    expect(await screen.findByText("正在整理结构化报告…")).toBeTruthy();
    expect(await screen.findByText(/公司关键调研原始报告/)).toBeTruthy();
    run = { ...run, status: "structure_failed", lastFailureCode: "structuring_failed" };
    state = { runs: [researchSummary(run)], globalActiveRun: null };
    act(() => fake.emitResearch({ type: "state_changed", runId: run.id, ...context }));
    expect(await screen.findByText("整理失败，请重试")).toBeTruthy();
    expect(screen.getByText(/原始事实/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "重新整理" }));
    expect(fake.companyResearch.retryStructuring).toHaveBeenCalledWith(context.itemId, context.companyId, run.id);
    expect(await screen.findByText("正在整理结构化报告…")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "取消调研" }));
    expect(fake.companyResearch.cancel).toHaveBeenCalledWith(run.id);
  });

  it("renders persisted section order, statuses, and source text safely", async () => {
    const fake = makeFakeApi();
    const user = userEvent.setup();
    const run = researchRun();
    const first = run.structuredContent!.sections[0]!;
    first.facts.push({ text: "<img src=x onerror=alert(1)>", timeContext: null, claimType: "forecast", source: { title: "<script>unsafe</script>", url: "javascript:alert(1)" } });
    run.structuredContent!.sections.reverse();
    fake.companyResearch.getState.mockResolvedValue({ runs: [researchSummary(run)], globalActiveRun: null });
    fake.companyResearch.getRun.mockResolvedValue(run);
    render(<CompanyResearchPanel api={fake} {...context} />);
    await user.click(await screen.findByRole("tab", { name: "结构化报告" }));
    expect(await screen.findByText("核心结论")).toBeTruthy();
    expect(within(screen.getByRole("tabpanel")).getAllByRole("heading", { level: 3 }).map((heading) => heading.textContent)).toEqual(["核心结论", "主要产品与定位", "核心技术与指标", "研发与产品阶段", "竞争力与替代方案", "技术瓶颈与路线图"]);
    for (const text of ["已找到", "部分找到", "未找到", "未披露", "存在冲突", "已报道事实", "预测", "2026年", "<img src=x onerror=alert(1)>", "<script>unsafe</script>"]) expect(screen.getByText(text)).toBeTruthy();
    expect(screen.getAllByRole("link")).toHaveLength(1);
    expect(screen.getByRole("link").getAttribute("href")).toBe("https://example.com/one");
    expect(document.querySelector(".structured-research-report img, .structured-research-report script")).toBeNull();
    expect(screen.getByText("AI 调研结果仅供参考，重要事实仍需人工核验。")).toBeTruthy();
  });

  it("keeps saved raw content readable while a failed-stage detail refresh is pending", async () => {
    const fake = makeFakeApi();
    const run = researchRun({ status: "structuring" });
    const pending = deferred<ResearchRun | undefined>();
    fake.companyResearch.getState.mockResolvedValue(activeResearch(run));
    fake.companyResearch.getRun.mockResolvedValueOnce(run).mockReturnValue(pending.promise);
    render(<CompanyResearchPanel api={fake} {...context} />);
    await screen.findByText(/原始事实/);
    await waitFor(() => expect(fake.companyResearch.getRun).toHaveBeenCalledTimes(1));
    fake.companyResearch.getState.mockResolvedValue({ runs: [researchSummary({ ...run, status: "structure_failed" })], globalActiveRun: null });
    act(() => fake.emitResearch({ type: "state_changed", itemId: run.itemId, companyId: run.companyId, runId: run.id }));
    await screen.findByText("整理失败，请重试");
    expect(screen.getByText(/原始事实/)).toBeTruthy();
    await act(async () => pending.resolve({ ...run, status: "structure_failed" }));
  });

  it("keeps raw content and shows safe errors when retry or detail loading fails", async () => {
    const fake = makeFakeApi();
    const user = userEvent.setup();
    const run = researchRun({ status: "structure_failed" });
    fake.companyResearch.getState.mockResolvedValue({ runs: [researchSummary(run)], globalActiveRun: null });
    fake.companyResearch.getRun.mockRejectedValueOnce(new Error("secret storage path")).mockResolvedValue(run);
    fake.companyResearch.retryStructuring.mockRejectedValue(new Error("secret provider response"));
    render(<CompanyResearchPanel api={fake} {...context} />);
    expect(await screen.findByText("加载调研报告失败，请重试")).toBeTruthy();
    expect(screen.queryByText(/secret/)).toBeNull();
    await user.click(screen.getByRole("button", { name: "重新加载" }));
    await screen.findByText(/原始事实/);
    await user.click(screen.getByRole("button", { name: "重新整理" }));
    expect(await screen.findByText("无法重新整理，请稍后重试")).toBeTruthy();
    expect(screen.getByText(/原始事实/)).toBeTruthy();
    expect(screen.queryByText(/secret/)).toBeNull();
  });

  it("loads a legacy body through target-scoped getRun and displays original inputs", async () => {
    const fake = makeFakeApi();
    const run: ResearchRun = { id: researchRun().id, itemId: researchRun().itemId, companyId: researchRun().companyId, schemaVersion: "legacy-freeform-v1", status: "completed", createdAt: "2026-09-01T00:00:00Z", completedAt: "2026-09-01T01:00:00Z", timeScope: "近一年", customRequirements: "历史要求", reportText: "旧报告正文" };
    fake.companyResearch.getState.mockResolvedValue({ runs: [researchSummary(run)], globalActiveRun: null });
    fake.companyResearch.getRun.mockResolvedValue(run);
    render(<CompanyResearchPanel api={fake} {...context} />);
    expect(await screen.findByText("旧报告正文")).toBeTruthy();
    expect(fake.companyResearch.getRun).toHaveBeenCalledWith(context.itemId, context.companyId, run.id);
    for (const text of ["旧版原始报告", "近一年", "历史要求"]) expect(screen.getByText(text)).toBeTruthy();
    expect(screen.queryByRole("tab")).toBeNull();
    expect(screen.queryByRole("region", { name: "报告研究背景" })).toBeNull();
    expect(screen.getByRole("option").textContent).not.toContain("截至");
  });

  it("refreshes global occupancy from events for other companies", async () => {
    const fake = makeFakeApi();
    const other = { runId: researchRun().id, itemId: researchRun().itemId, companyId: "other" as ResearchRun["companyId"], stage: "raw" as const };
    fake.companyResearch.getState.mockResolvedValue({ runs: [], globalActiveRun: other });
    render(<CompanyResearchPanel api={fake} {...context} />);
    expect(await screen.findByText("其他公司正在调研，请稍后再试。")).toBeTruthy();
    expect((screen.getByRole("button", { name: "开始调研" }) as HTMLButtonElement).disabled).toBe(true);
    fake.companyResearch.getState.mockResolvedValue({ runs: [], globalActiveRun: null });
    act(() => fake.emitResearch({ type: "state_changed", ...other }));
    await waitFor(() => expect((screen.getByRole("button", { name: "开始调研" }) as HTMLButtonElement).disabled).toBe(false));
  });

  it("discards a stale initial snapshot when deltas arrive during subscription", async () => {
    const fake = makeFakeApi();
    const pending = deferred<CompanyResearchState>();
    const run = researchRun({ status: "researching" });
    fake.companyResearch.getState.mockReturnValueOnce(pending.promise).mockResolvedValue(activeResearch(run, "早期文字"));
    render(<CompanyResearchPanel api={fake} {...context} />);
    act(() => fake.emitResearch({ type: "text_delta", stage: "raw", requestId: "req", runId: run.id, delta: "早期文字" }));
    await act(async () => pending.resolve(activeResearch(run, "早期文字")));
    expect(await screen.findByText("早期文字")).toBeTruthy();
    act(() => fake.emitResearch({ type: "text_delta", stage: "raw", requestId: "req", runId: run.id, delta: "追加" }));
    expect(await screen.findByText("早期文字追加")).toBeTruthy();
    expect(screen.queryByText("早期文字早期文字追加")).toBeNull();
  });

  it("does not overwrite a completed snapshot with a late start response", async () => {
    const fake = makeFakeApi();
    const user = userEvent.setup();
    const pending = deferred<ResearchRun>();
    const run = researchRun();
    fake.companyResearch.start.mockReturnValue(pending.promise);
    fake.companyResearch.getRun.mockResolvedValue(run);
    render(<CompanyResearchPanel api={fake} {...context} />);
    await user.click(await screen.findByRole("button", { name: "开始调研" }));
    await user.click(screen.getAllByRole("button", { name: "开始调研" })[1]!);
    fake.companyResearch.getState.mockResolvedValue({ runs: [researchSummary(run)], globalActiveRun: null });
    act(() => fake.emitResearch({ type: "state_changed", runId: run.id, itemId: run.itemId, companyId: run.companyId }));
    expect(await screen.findByText(/原始事实/)).toBeTruthy();
    expect(screen.getByRole("tab", { name: "结构化报告" })).toBeTruthy();
    await act(async () => pending.resolve(researchRun({ status: "researching" })));
    expect(await screen.findByText(/原始事实/)).toBeTruthy();
    expect(screen.getByRole("tab", { name: "结构化报告" })).toBeTruthy();
    expect(screen.queryByText("正在联网调研…")).toBeNull();
  });

  it("selects a fast completed new run when starting from existing history", async () => {
    const fake = makeFakeApi();
    const user = userEvent.setup();
    const old = researchRun();
    const newest = researchRun({ id: "new-run" as ResearchRun["id"], rawReportText: "本次新报告" });
    fake.companyResearch.getState.mockResolvedValue({ runs: [researchSummary(old)], globalActiveRun: null });
    fake.companyResearch.getRun.mockImplementation(async (_item, _company, id) => id === old.id ? old : newest);
    fake.companyResearch.start.mockImplementation(async () => {
      fake.companyResearch.getState.mockResolvedValue({ runs: [researchSummary(newest), researchSummary(old)], globalActiveRun: null });
      return researchRun({ id: newest.id, status: "researching" });
    });
    render(<CompanyResearchPanel api={fake} {...context} />);
    await user.click(await screen.findByRole("button", { name: "重新调研" }));
    await user.click(screen.getByRole("button", { name: "开始调研" }));
    await user.click(await screen.findByRole("tab", { name: "原始调研报告" }));
    expect(await screen.findByText("本次新报告")).toBeTruthy();
    expect((screen.getByLabelText("报告版本") as HTMLSelectElement).value).toBe(newest.id);
  });

  it("ignores late detail results across history selection and company navigation", async () => {
    const fake = makeFakeApi();
    const user = userEvent.setup();
    const pending = deferred<ResearchRun | undefined>();
    const first = researchRun();
    const second = researchRun({ id: "run-2" as ResearchRun["id"], rawReportText: "第二版正文" });
    fake.companyResearch.getState.mockImplementation(async (_item, company) => ({ runs: company === context.companyId ? [researchSummary(first), researchSummary(second)] : [], globalActiveRun: null }));
    fake.companyResearch.getRun.mockImplementation((_item, _company, id) => id === first.id ? pending.promise : Promise.resolve(second));
    const view = render(<CompanyResearchPanel api={fake} {...context} />);
    await user.selectOptions(await screen.findByLabelText("报告版本"), second.id);
    await user.click(await screen.findByRole("tab", { name: "原始调研报告" }));
    expect(await screen.findByText("第二版正文")).toBeTruthy();
    view.rerender(<CompanyResearchPanel api={fake} {...context} companyId="other" companyName="另一公司" />);
    await act(async () => pending.resolve(first));
    expect(await screen.findByText("还没有调研报告。")).toBeTruthy();
    expect(screen.queryByText("新品已发布")).toBeNull();
    expect(screen.queryByText("第二版正文")).toBeNull();
    expect(fake.researchListeners.size).toBe(1);
  });

  it("validates local date and scope, and shows only safe start errors", async () => {
    const fake = makeFakeApi();
    const user = userEvent.setup();
    fake.companyResearch.start.mockRejectedValue(new Error("secret backend detail"));
    render(<CompanyResearchPanel api={fake} {...context} />);
    await user.click(await screen.findByRole("button", { name: "开始调研" }));
    const date = screen.getByLabelText("截至日期") as HTMLInputElement;
    const now = new Date();
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    expect(date.value).toBe(today);
    expect(date.max).toBe(today);
    expect((screen.getByLabelText("关注范围（可选）") as HTMLTextAreaElement).maxLength).toBe(1000);
    fireEvent.change(date, { target: { value: "2999-01-01" } });
    fireEvent.submit(date.closest("form")!);
    expect(fake.companyResearch.start).not.toHaveBeenCalled();
    fireEvent.change(date, { target: { value: today } });
    fireEvent.submit(date.closest("form")!);
    expect(await screen.findByText("无法开始调研，请稍后重试")).toBeTruthy();
    expect(screen.queryByText(/secret backend/)).toBeNull();
  });

  it("reuses the newest v1 inputs even when a legacy summary is newer", async () => {
    const fake = makeFakeApi();
    const user = userEvent.setup();
    const run = researchRun({ direction: "operations_and_performance", focusScope: "利润与现金流", asOfDate: "2026-01-01" });
    const legacy: ResearchRun = { id: "legacy" as ResearchRun["id"], itemId: run.itemId, companyId: run.companyId, schemaVersion: "legacy-freeform-v1", status: "completed", createdAt: run.createdAt, completedAt: run.createdAt, timeScope: "近一年", reportText: "旧报告" };
    fake.companyResearch.getState.mockResolvedValue({ runs: [researchSummary(legacy), researchSummary(run)], globalActiveRun: null });
    fake.companyResearch.getRun.mockResolvedValue(legacy);
    render(<CompanyResearchPanel api={fake} {...context} />);
    await user.click(await screen.findByRole("button", { name: "重新调研" }));
    expect((screen.getByLabelText("研究方向") as HTMLSelectElement).value).toBe("operations_and_performance");
    expect((screen.getByLabelText("关注范围（可选）") as HTMLTextAreaElement).value).toBe("利润与现金流");
    expect((screen.getByLabelText("截至日期") as HTMLInputElement).value).toBe("2026-01-01");
  });

  it("falls back from invalid inherited launch inputs and rejects excessive scope", async () => {
    const fake = makeFakeApi();
    render(<CompanyResearchModal {...context} initial={{ direction: "obsolete" as "product_and_technology", focusScope: "x".repeat(1001), asOfDate: "2025-02-30" }} onClose={() => {}} onStart={async (input) => { await fake.companyResearch.start(context.itemId, context.companyId, input); }} />);
    const date = screen.getByLabelText("截至日期") as HTMLInputElement;
    expect(date.value).toBe(date.max);
    expect((screen.getByLabelText("研究方向") as HTMLSelectElement).value).toBe("product_and_technology");
    const scope = screen.getByLabelText("关注范围（可选）") as HTMLTextAreaElement;
    expect(scope.value).toBe("");
    fireEvent.change(scope, { target: { value: "x".repeat(1001) } });
    fireEvent.submit(scope.closest("form")!);
    expect(fake.companyResearch.start).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toBeTruthy();
  });
});
