// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { CompanyResearchState, ResearchRun } from "../contracts/index.js";
import { makeFakeApi as makeBaseApi } from "../../../apps/desktop/src/renderer/renderer-test-helpers.js";
import { configuredSettings } from "../../../apps/desktop/src/renderer/features/settings/settings-test-fixtures.js";
import { CompanyResearchPanel } from "./CompanyResearchPanel.js";
import { CompanyResearchModal } from "./CompanyResearchModal.js";
import { activeResearch, researchRun, researchSummary } from "./company-research-test-fixtures.js";

const context = { itemId: "item-research", companyId: "company-research", topicName: "智能眼镜", topicScope: "中国市场", companyName: "小米", companyNote: "重点候选" };
function makeFakeApi() {
  const api = makeBaseApi();
  api.settings.get.mockResolvedValue(configuredSettings());
  return api;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe("two-stage company research", () => {
  it("warns on a completed report without successful search and offers retry", async () => {
    const fake = makeFakeApi();
    const run = researchRun({ searchStatus: "none" });
    fake.companyResearch.getState.mockResolvedValue({ runs: [researchSummary(run)], globalActiveRun: null });
    fake.companyResearch.getRun.mockResolvedValue(run);
    render(<CompanyResearchPanel api={fake} {...context} />);
    expect(await screen.findByText(/本次报告未成功完成联网搜索/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "重新尝试" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "新的调研" })).toBeTruthy();
    expect(screen.getByRole("option").textContent).toContain("未成功联网");
    fireEvent.click(await screen.findByRole("tab", { name: "结构化报告" }));
    expect(screen.getByText(/本次报告未成功完成联网搜索/)).toBeTruthy();
  });

  it("does not warn or offer retry when search succeeded", async () => {
    const fake = makeFakeApi(); const run = researchRun({ searchStatus: "succeeded" });
    fake.companyResearch.getState.mockResolvedValue({ runs: [researchSummary(run)], globalActiveRun: null });
    fake.companyResearch.getRun.mockResolvedValue(run);
    render(<CompanyResearchPanel api={fake} {...context} />);
    await screen.findByRole("tab", { name: "原始调研报告" });
    expect(screen.queryByText(/本次报告未成功完成联网搜索|此历史报告未记录联网搜索状态/)).toBeNull();
    expect(screen.queryByRole("button", { name: "重新尝试" })).toBeNull();
  });

  it.each(["unknown", undefined] as const)("shows historical uncertainty for %s search state", async (searchStatus) => {
    const fake = makeFakeApi(); const run = researchRun(searchStatus === undefined ? {} : { searchStatus });
    fake.companyResearch.getState.mockResolvedValue({ runs: [researchSummary(run)], globalActiveRun: null });
    fake.companyResearch.getRun.mockResolvedValue(run);
    render(<CompanyResearchPanel api={fake} {...context} />);
    expect(await screen.findByText("此历史报告未记录联网搜索状态，无法确认是否成功联网。")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "重新尝试" })).toBeNull();
  });

  it("restores and updates the latest research tool activity beside the running status", async () => {
    const fake = makeFakeApi();
    const run = researchRun({ status: "researching" });
    const state = activeResearch(run);
    state.active!.latestActivity = { callKey: "tool-1", name: "web_search", summary: "宇树科技新品", status: "running" };
    fake.companyResearch.getState.mockResolvedValue(state);
    render(<CompanyResearchPanel api={fake} {...context} />);
    expect(await screen.findByText("正在搜索：宇树科技新品")).toBeTruthy();
    act(() => fake.emitResearch({
      requestId: "r1", runId: run.id, stage: "raw", type: "tool_activity",
      callKey: "tool-2", name: "read_webpage", summary: "unitree.com", status: "completed",
    }));
    expect(await screen.findByText("已读取网页：unitree.com")).toBeTruthy();
  });

  it.each([
    ["tool_failed", "联网工具未能取得足够资料，请检查 Search 配置或稍后重试"],
    ["model_failed", "模型生成调研报告失败，请检查 LLM 配置或稍后重试"],
    ["empty_report", "模型未返回可用的调研报告，请重试"],
    ["protocol_leak", "模型返回了工具协议内容，未保存为报告，请重试"],
    ["language_validation_failed", "模型返回的报告语言不符合要求，请重试"],
    ["incomplete_response", "模型响应未完整结束，请重试"],
  ] as const)("shows the safe %s failure message", async (outcome, message) => {
    const fake = makeFakeApi();
    render(<CompanyResearchPanel api={fake} {...context} />);
    await screen.findByText("还没有调研报告。");
    act(() => fake.emitResearch({ type: "state_changed", itemId: context.itemId, companyId: context.companyId, runId: "failed-run", outcome }));
    expect(await screen.findByText(message)).toBeTruthy();
  });

  it("shows the specific search failure only for the current target without displaying provider text", async () => {
    const fake = makeFakeApi();
    render(<CompanyResearchPanel api={fake} {...context} />);
    await screen.findByText("还没有调研报告。");
    const failure = { type: "state_changed", itemId: context.itemId, companyId: context.companyId, runId: "failed-run", outcome: "web_search_failed" } as const;
    act(() => fake.emitResearch({ ...failure, companyId: "other-company" }));
    await waitFor(() => expect(fake.companyResearch.getState).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("alert")).toBeNull();
    act(() => fake.emitResearch(failure));
    expect(await screen.findByText("联网搜索未成功，请检查 Search 配置或稍后重试")).toBeTruthy();
    expect(screen.queryByText("调研未完成，请稍后重试")).toBeNull();
    expect(screen.queryByRole("tabpanel")).toBeNull();
  });

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
    render(<CompanyResearchPanel api={fake} {...context} />);
    await screen.findByText("还没有调研报告。");
    act(() => fake.emitResearch({ type: "state_changed", itemId: "other-item", companyId: context.companyId, runId: "other-run", outcome: "research_failed" }));
    await waitFor(() => expect(fake.companyResearch.getState).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("alert")).toBeNull();
    act(() => fake.emitResearch({ type: "state_changed", itemId: context.itemId, companyId: context.companyId, runId: "early-run", outcome: "research_failed" }));
    expect(await screen.findByText("调研未完成，请稍后重试")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "重新加载" })).toBeNull();
    const run = researchRun({ status: "researching" });
    fake.companyResearch.getState.mockResolvedValue(activeResearch(run, "未完成草稿"));
    act(() => fake.emitResearch({ type: "state_changed", itemId: context.itemId, companyId: context.companyId, runId: run.id }));
    await screen.findByText("未完成草稿");
    fake.companyResearch.getState.mockResolvedValue({ runs: [], globalActiveRun: null });
    act(() => fake.emitResearch({ type: "state_changed", itemId: context.itemId, companyId: context.companyId, runId: run.id, outcome: "cancelled" }));
    await screen.findByText("还没有调研报告。");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("clears a run execution error when selecting a different successful history entry", async () => {
    const fake = makeFakeApi(); const user = userEvent.setup();
    const failed = researchRun({ id: "failed-history" as ResearchRun["id"], status: "research_failed" });
    const successful = researchRun({ id: "successful-history" as ResearchRun["id"], rawReportText: "成功历史报告" });
    fake.companyResearch.getState.mockResolvedValue({ runs: [researchSummary(failed), researchSummary(successful)], globalActiveRun: null });
    fake.companyResearch.getRun.mockImplementation(async (_item, _company, id) => id === successful.id ? successful : failed);
    render(<CompanyResearchPanel api={fake} {...context} />);
    await screen.findByText("调研未完成，请稍后重试");
    act(() => fake.emitResearch({ type: "state_changed", itemId: failed.itemId, companyId: failed.companyId, runId: failed.id, outcome: "research_failed" }));
    expect((await screen.findByRole("alert")).textContent).toContain("调研未完成，请稍后重试");
    await user.selectOptions(screen.getByLabelText("报告版本"), successful.id);
    expect(await screen.findByText("成功历史报告")).toBeTruthy();
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

  it.each([
    ["empty", undefined, ["开始调研"]],
    ["completed", "completed", ["新的调研"]],
    ["research failure", "research_failed", ["重新尝试", "新的调研"]],
    ["structure failure", "structure_failed", ["重新整理", "新的调研"]],
  ] as const)("shows the intended report actions for %s history", async (_label, status, expected) => {
    const fake = makeFakeApi();
    const run = status === undefined ? undefined : researchRun({
      status,
      ...(status === "research_failed" ? { lastFailureCode: "tool_failed" as const } : {}),
      ...(status === "structure_failed" ? { lastFailureCode: "structuring_failed" as const } : {}),
    });
    fake.companyResearch.getState.mockResolvedValue({ runs: run ? [researchSummary(run)] : [], globalActiveRun: null });
    fake.companyResearch.getRun.mockResolvedValue(run);
    const view = render(<CompanyResearchPanel api={fake} {...context} />);
    await screen.findByText(run ? /报告版本/ : "还没有调研报告。");
    const heading = view.container.querySelector<HTMLElement>(".company-research-heading")!;
    expect(within(heading).getAllByRole("button").map((button) => button.textContent)).toEqual(expected);
    if (status === "research_failed" || status === "structure_failed") {
      expect(screen.getByRole("option").textContent).toContain("（失败待重试）");
    }
    if (status === "research_failed") {
      expect(await screen.findByText("联网工具未能取得足够资料，请检查 Search 配置或稍后重试")).toBeTruthy();
      expect(screen.queryByRole("tabpanel")).toBeNull();
      expect(view.container.querySelector(".company-report-text")).toBeNull();
    }
  });

  it("retries structure failures directly without opening the editable retry modal or rerunning raw research", async () => {
    const fake = makeFakeApi(); const user = userEvent.setup();
    const run = researchRun({ status: "structure_failed", searchStatus: "none", rawReportText: "保留的原始报告", lastFailureCode: "structuring_failed" });
    fake.companyResearch.getState.mockResolvedValue({ runs: [researchSummary(run)], globalActiveRun: null });
    fake.companyResearch.getRun.mockResolvedValue(run);
    fake.companyResearch.retryStructuring.mockResolvedValue({ ...run, status: "structuring", structuringAttempts: run.structuringAttempts + 1 });
    render(<CompanyResearchPanel api={fake} {...context} />);

    await user.click(await screen.findByRole("button", { name: "重新整理" }));

    expect(screen.queryByRole("dialog", { name: "重新尝试调研" })).toBeNull();
    expect(fake.companyResearch.retryStructuring).toHaveBeenCalledWith(context.itemId, context.companyId, run.id);
    expect(fake.companyResearch.retryFailed).not.toHaveBeenCalled();
    expect(fake.companyResearch.start).not.toHaveBeenCalled();
  });

  it("retries the selected failure with edited inputs and keeps the same selected run after completion", async () => {
    const fake = makeFakeApi(); const user = userEvent.setup();
    let run = researchRun({
      status: "research_failed", direction: "operations_and_performance", focusScope: "旧范围",
      asOfDate: "2026-01-01", lastFailureCode: "model_failed",
    });
    let state: CompanyResearchState = { runs: [researchSummary(run)], globalActiveRun: null };
    fake.companyResearch.getState.mockImplementation(async () => state);
    fake.companyResearch.getRun.mockImplementation(async () => run);
    fake.companyResearch.retryFailed.mockImplementation(async (_itemId, _companyId, _runId, input) => {
      run = researchRun({ id: run.id, status: "researching", ...input });
      state = activeResearch(run);
      return run;
    });
    render(<CompanyResearchPanel api={fake} {...context} />);
    await user.click(await screen.findByRole("button", { name: "重新尝试" }));
    const dialog = screen.getByRole("dialog", { name: "重新尝试调研" });
    expect((within(dialog).getByLabelText("研究方向") as HTMLSelectElement).value).toBe("operations_and_performance");
    expect((within(dialog).getByLabelText("关注范围（可选）") as HTMLTextAreaElement).value).toBe("旧范围");
    expect((within(dialog).getByLabelText("截至日期") as HTMLInputElement).value).toBe("2026-01-01");
    await user.selectOptions(within(dialog).getByLabelText("研究方向"), "market_and_commercialization");
    await user.clear(within(dialog).getByLabelText("关注范围（可选）"));
    await user.type(within(dialog).getByLabelText("关注范围（可选）"), "更新后的范围");
    fireEvent.change(within(dialog).getByLabelText("截至日期"), { target: { value: "2026-02-02" } });
    await user.click(within(dialog).getByRole("button", { name: "重新尝试" }));
    expect(fake.companyResearch.retryFailed).toHaveBeenCalledWith(context.itemId, context.companyId, run.id, {
      direction: "market_and_commercialization", focusScope: "更新后的范围", asOfDate: "2026-02-02",
    });
    expect(await screen.findByText("正在联网调研…")).toBeTruthy();

    run = researchRun({ id: run.id, direction: "market_and_commercialization", focusScope: "更新后的范围", asOfDate: "2026-02-02", rawReportText: "重试成功" });
    state = { runs: [researchSummary(run)], globalActiveRun: null };
    act(() => fake.emitResearch({ type: "state_changed", itemId: context.itemId, companyId: context.companyId, runId: run.id }));
    expect(await screen.findByText("重试成功")).toBeTruthy();
    expect((screen.getByLabelText("报告版本") as HTMLSelectElement).value).toBe(run.id);
    expect((screen.getByLabelText("报告版本") as HTMLSelectElement).options).toHaveLength(1);
  });

  it("deletes the selected report after confirmation and selects its next ordered neighbor", async () => {
    const fake = makeFakeApi(); const user = userEvent.setup();
    const newest = researchRun({ id: "run-newest" as ResearchRun["id"], createdAt: "2026-09-09T09:00:00.000Z", rawReportText: "最新报告" });
    const selected = researchRun({ id: "run-selected" as ResearchRun["id"], status: "structure_failed", createdAt: "2026-09-08T09:00:00.000Z", rawReportText: "待删除报告", lastFailureCode: "structuring_failed" });
    const oldest = researchRun({ id: "run-oldest" as ResearchRun["id"], createdAt: "2026-09-07T09:00:00.000Z", rawReportText: "最旧报告" });
    const details = new Map<string, ResearchRun>([newest, selected, oldest].map((run) => [run.id, run]));
    let state: CompanyResearchState = { runs: [newest, selected, oldest].map(researchSummary), globalActiveRun: null };
    fake.companyResearch.getState.mockImplementation(async () => state);
    fake.companyResearch.getRun.mockImplementation(async (_item, _company, id) => details.get(id));
    fake.companyResearch.deleteRun.mockImplementation(async (_item, _company, id) => {
      state = { ...state, runs: state.runs.filter((run) => run.id !== id) };
      details.delete(id);
    });
    render(<CompanyResearchPanel api={fake} {...context} />);
    await user.selectOptions(await screen.findByLabelText("报告版本"), selected.id);
    expect(await screen.findByText("待删除报告")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "删除" }));
    let dialog = screen.getByRole("dialog", { name: "删除调研报告" });
    expect(within(dialog).getByText(/2026\/09\/08/)).toBeTruthy();
    expect(within(dialog).getByText(/整理失败/)).toBeTruthy();
    await user.click(within(dialog).getByRole("button", { name: "取消" }));
    expect(fake.companyResearch.deleteRun).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "删除" }));
    dialog = screen.getByRole("dialog", { name: "删除调研报告" });
    await user.click(within(dialog).getByRole("button", { name: "确认删除" }));
    expect(fake.companyResearch.deleteRun).toHaveBeenCalledWith(context.itemId, context.companyId, selected.id);
    expect(await screen.findByText("最旧报告")).toBeTruthy();
    expect((screen.getByLabelText("报告版本") as HTMLSelectElement).value).toBe(oldest.id);
  });

  it("returns to the empty state after deleting the only report", async () => {
    const fake = makeFakeApi(); const user = userEvent.setup();
    const run = researchRun();
    let state: CompanyResearchState = { runs: [researchSummary(run)], globalActiveRun: null };
    fake.companyResearch.getState.mockImplementation(async () => state);
    fake.companyResearch.getRun.mockResolvedValue(run);
    fake.companyResearch.deleteRun.mockImplementation(async () => { state = { runs: [], globalActiveRun: null }; });
    render(<CompanyResearchPanel api={fake} {...context} />);
    await user.click(await screen.findByRole("button", { name: "删除" }));
    await user.click(within(screen.getByRole("dialog", { name: "删除调研报告" })).getByRole("button", { name: "确认删除" }));
    expect(await screen.findByText("还没有调研报告。")).toBeTruthy();
    expect(screen.getByRole("button", { name: "开始调研" })).toBeTruthy();
    expect(screen.queryByLabelText("报告版本")).toBeNull();
  });

  it("does not restore a deleted report when the authoritative refresh fails", async () => {
    const fake = makeFakeApi(); const user = userEvent.setup();
    const deleted = researchRun({ rawReportText: "已经删除的报告正文" });
    const initial: CompanyResearchState = { runs: [researchSummary(deleted)], globalActiveRun: null };
    fake.companyResearch.getState
      .mockResolvedValueOnce(initial)
      .mockRejectedValueOnce(new Error("private refresh failure"));
    fake.companyResearch.getRun.mockResolvedValue(deleted);
    fake.companyResearch.deleteRun.mockResolvedValue(undefined);
    render(<CompanyResearchPanel api={fake} {...context} />);
    expect(await screen.findByText("已经删除的报告正文")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "删除" }));
    await user.click(within(screen.getByRole("dialog", { name: "删除调研报告" })).getByRole("button", { name: "确认删除" }));
    expect(await screen.findByText("加载调研状态失败，请重试")).toBeTruthy();
    expect(screen.getByRole("button", { name: "重新加载" })).toBeTruthy();
    expect(screen.queryByText("已经删除的报告正文")).toBeNull();
    expect(screen.queryByLabelText("报告版本")).toBeNull();
  });

  it("ends a pending detail load when deletion succeeds but the authoritative refresh fails", async () => {
    const fake = makeFakeApi(); const user = userEvent.setup();
    const pendingDetail = deferred<ResearchRun | undefined>();
    const deleted = researchRun({ rawReportText: "迟到的已删除报告正文" });
    fake.companyResearch.getState
      .mockResolvedValueOnce({ runs: [researchSummary(deleted)], globalActiveRun: null })
      .mockRejectedValueOnce(new Error("private refresh failure"));
    fake.companyResearch.getRun.mockReturnValue(pendingDetail.promise);
    fake.companyResearch.deleteRun.mockResolvedValue(undefined);
    render(<CompanyResearchPanel api={fake} {...context} />);
    expect(await screen.findByText("加载调研报告…")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "删除" }));
    await user.click(within(screen.getByRole("dialog", { name: "删除调研报告" })).getByRole("button", { name: "确认删除" }));

    expect(await screen.findByText("加载调研状态失败，请重试")).toBeTruthy();
    expect(screen.getByRole("button", { name: "重新加载" })).toBeTruthy();
    expect(screen.queryByText("加载调研报告…")).toBeNull();
    expect(screen.queryByLabelText("报告版本")).toBeNull();
    await act(async () => pendingDetail.resolve(deleted));
    expect(screen.queryByText("迟到的已删除报告正文")).toBeNull();
  });

  it("disables report deletion while the same company is queued", async () => {
    const fake = makeFakeApi();
    const run = researchRun();
    fake.companyResearch.getState.mockResolvedValue({
      runs: [researchSummary(run)],
      globalActiveRun: { runId: "other-run" as ResearchRun["id"], itemId: run.itemId, companyId: "other-company" as ResearchRun["companyId"], stage: "raw" },
    });
    fake.companyResearch.getRun.mockResolvedValue(run);
    render(<CompanyResearchPanel api={fake} {...context} queueEntry={{ entryId: "entry", itemId: context.itemId, companyId: context.companyId, mode: "new", input: { direction: "product_and_technology", asOfDate: "2026-09-09" }, status: "pending" }} />);
    expect((await screen.findByRole("button", { name: "删除" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("disables an open deletion confirmation when the same company enters the queue", async () => {
    const fake = makeFakeApi(); const user = userEvent.setup();
    const run = researchRun();
    let state: CompanyResearchState = { runs: [researchSummary(run)], globalActiveRun: null };
    fake.companyResearch.getState.mockImplementation(async () => state);
    fake.companyResearch.getRun.mockResolvedValue(run);
    const view = render(<CompanyResearchPanel api={fake} {...context} />);
    await user.click(await screen.findByRole("button", { name: "删除" }));
    const confirmation = within(screen.getByRole("dialog", { name: "删除调研报告" })).getByRole("button", { name: "确认删除" }) as HTMLButtonElement;
    view.rerender(<CompanyResearchPanel api={fake} {...context} queueEntry={{ entryId: "entry", itemId: context.itemId, companyId: context.companyId, mode: "new", input: { direction: "product_and_technology", asOfDate: "2026-09-09" }, status: "pending" }} />);
    await waitFor(() => expect(confirmation.disabled).toBe(true));
    expect(fake.companyResearch.deleteRun).not.toHaveBeenCalled();
  });

  const markdown = "# 一级标题\n\n## 二级标题\n\n| 列 | 值 |\n| --- | --- |\n| 项 | 内容 |\n\n- 列表项\n\n**重点** https://example.com/report";
  it.each(["saved", "streaming", "structure failed", "legacy"] as const)("renders %s raw reports through the shared Markdown boundary", async (kind) => {
    const fake = makeFakeApi();
    const keyed = researchRun({
      status: kind === "streaming" ? "researching" : kind === "structure failed" ? "structure_failed" : "completed",
      rawReportText: markdown,
      ...(kind === "structure failed" ? { lastFailureCode: "structuring_failed" as const } : {}),
    });
    const legacy: ResearchRun = {
      id: "legacy-markdown" as ResearchRun["id"], itemId: keyed.itemId, companyId: keyed.companyId,
      schemaVersion: "legacy-freeform-v1", status: "completed", timeScope: "近一年", reportText: markdown,
      createdAt: "2026-09-01T00:00:00Z", completedAt: "2026-09-01T01:00:00Z",
    };
    const run = kind === "legacy" ? legacy : keyed;
    fake.companyResearch.getState.mockResolvedValue(kind === "streaming"
      ? activeResearch(keyed, markdown)
      : { runs: [researchSummary(run)], globalActiveRun: null });
    fake.companyResearch.getRun.mockResolvedValue(run);
    render(<CompanyResearchPanel api={fake} {...context} />);
    expect(await screen.findByRole("heading", { level: 1, name: "一级标题" })).toBeTruthy();
    expect(screen.getByRole("heading", { level: 2, name: "二级标题" })).toBeTruthy();
    expect(screen.getByRole("table")).toBeTruthy();
    expect(screen.getByRole("list")).toBeTruthy();
    expect(screen.getByText("重点").closest("strong")).toBeTruthy();
    expect(screen.getByRole("link", { name: "https://example.com/report" })).toBeTruthy();
    expect(screen.queryByText("# 一级标题")).toBeNull();
    expect(screen.queryByText("**重点**")).toBeNull();
  });

  it("keeps the shared Markdown URL popover and copy action in raw reports", async () => {
    const fake = makeFakeApi(); const user = userEvent.setup();
    const copyText = fake.copyText;
    Object.defineProperty(window, "deepfield", { configurable: true, value: { copyText } });
    const run = researchRun({ rawReportText: markdown });
    fake.companyResearch.getState.mockResolvedValue({ runs: [researchSummary(run)], globalActiveRun: null });
    fake.companyResearch.getRun.mockResolvedValue(run);
    render(<CompanyResearchPanel api={fake} {...context} />);
    await user.hover(await screen.findByRole("link", { name: "https://example.com/report" }));
    const popover = await screen.findByRole("dialog", { name: "链接详情" });
    expect(within(popover).getByText("https://example.com/report")).toBeTruthy();
    await user.click(within(popover).getByRole("button", { name: "复制链接" }));
    expect(copyText).toHaveBeenCalledWith("https://example.com/report");
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
    expect(fake.companyResearch.retryFailed).not.toHaveBeenCalled();
    expect(await screen.findByText("正在整理结构化报告…")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "取消调研" }));
    expect(fake.companyResearch.cancel).toHaveBeenCalledWith(run.id);
  });

  it("renders persisted section order, warning statuses, and source text safely", async () => {
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
    for (const text of ["未找到", "未披露", "存在冲突", "设备已经发布", "<img src=x onerror=alert(1)>", "<script>unsafe</script>"]) expect(screen.getByText(text)).toBeTruthy();
    for (const text of ["已找到", "部分找到", "已报道事实", "预测", "2026年"]) expect(screen.queryByText(text)).toBeNull();
    expect(screen.getAllByRole("link")).toHaveLength(1);
    expect(screen.getByRole("link").getAttribute("href")).toBe("https://example.com/one");
    expect(document.querySelector(".structured-research-report img, .structured-research-report script")).toBeNull();
    expect(screen.getByText(/AI 调研结果仅供参考，重要事实仍需人工核验/)).toBeTruthy();
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
    expect(await screen.findByText("无法重新尝试，请稍后重试")).toBeTruthy();
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

  it("does not refresh or block this company for events from other companies", async () => {
    const fake = makeFakeApi();
    const other = { runId: researchRun().id, itemId: researchRun().itemId, companyId: "other" as ResearchRun["companyId"], stage: "raw" as const };
    fake.companyResearch.getState.mockResolvedValue({ runs: [], globalActiveRun: other });
    render(<CompanyResearchPanel api={fake} {...context} />);
    await screen.findByText("还没有调研报告。");
    expect(screen.queryByText("其他公司正在调研，请稍后再试。")).toBeNull();
    expect((screen.getByRole("button", { name: "开始调研" }) as HTMLButtonElement).disabled).toBe(false);
    fake.companyResearch.getState.mockResolvedValue({ runs: [], globalActiveRun: null });
    act(() => fake.emitResearch({ type: "state_changed", ...other }));
    await waitFor(() => expect(fake.companyResearch.getState).toHaveBeenCalledTimes(1));
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
    await user.click(await screen.findByRole("button", { name: "新的调研" }));
    await user.click(screen.getByRole("button", { name: "开始调研" }));
    await waitFor(() => expect((screen.getByLabelText("报告版本") as HTMLSelectElement).value).toBe(newest.id));
    await user.click(screen.getByRole("tab", { name: "原始调研报告" }));
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
    await user.click(await screen.findByRole("button", { name: "新的调研" }));
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
