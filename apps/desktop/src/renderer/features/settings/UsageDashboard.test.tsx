// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import type { UsageDashboard, UsageSummary, UsageTrendPoint, UsageTrendSummary } from "@deepfield/base/usage";
import { afterEach, describe, expect, it, vi } from "vitest";

import { makeFakeApi } from "../../renderer-test-helpers.js";
import { UsageDashboardView } from "./UsageDashboard.js";

const summary = (overrides: Partial<UsageSummary> = {}): UsageSummary => ({
  requests: 0,
  running: 0,
  succeeded: 0,
  failed: 0,
  cancelled: 0,
  interrupted: 0,
  inputTokens: null,
  outputTokens: null,
  cacheReadTokens: null,
  cacheWriteTokens: null,
  totalTokens: null,
  resultCount: null,
  reportedUsageRequests: 0,
  unknownUsageRequests: 0,
  partialUsageRequests: 0,
  incompleteAttemptCountRequests: 0,
  ...overrides,
});

const trendSummary = (overrides: Partial<UsageTrendSummary> = {}): UsageTrendSummary => ({
  ...summary(),
  inputCacheHitTokens: null,
  inputCacheMissTokens: null,
  inputCacheUnknownTokens: null,
  cacheSplitUnknownRequests: 0,
  ...overrides,
});

const trendPoint = (overrides: Partial<UsageTrendPoint> & Pick<UsageTrendPoint, "date" | "from" | "to" | "label">): UsageTrendPoint => ({
  ...trendSummary(),
  coverage: "tracked",
  future: false,
  ...overrides,
});

const dashboard = (overrides: Partial<UsageDashboard> = {}): UsageDashboard => ({
  inFlightRequests: 0,
  summary: summary(),
  daily: [],
  trend: {
    granularity: "day",
    points: [],
    summary: trendSummary(),
    models: [],
    selectedModel: null,
  },
  providers: [],
  unknownUsage: { dismissibleCount: 0, networkFailureCount: 0, otherFailureCount: 0, nonDismissibleCount: 0, partialCount: 0, incompleteAttemptCount: 0, snapshot: [], acknowledgeSnapshot: [] },
  historicalNotice: { droppedRecords: 0, interruptedRequests: 0, fingerprint: null },
  health: {
    collectionStartedAt: "2026-09-01T16:00:00.000Z",
    lastInitializedAt: "2026-09-18T00:00:00.000Z",
    cleanShutdown: true,
    previousUncleanShutdown: false,
    interruptedRequests: 0,
    pendingRecords: 0,
    recoverableRecords: 0,
    failedRecords: 0,
    droppedRecords: 0,
    currentFailure: false,
    lastErrorCode: null,
    degraded: false,
  },
  from: "2026-08-31T16:00:00.000Z",
  to: "2026-09-30T16:00:00.000Z",
  timeZone: "Asia/Shanghai",
  ...overrides,
});

const llmDashboard = (): UsageDashboard => dashboard({
  unknownUsage: { dismissibleCount: 0, networkFailureCount: 0, otherFailureCount: 0, nonDismissibleCount: 1, partialCount: 3, incompleteAttemptCount: 1, snapshot: [], acknowledgeSnapshot: ["success@unknown.complete.success"] },
  summary: summary({
    requests: 4,
    succeeded: 3,
    failed: 1,
    inputTokens: 120,
    outputTokens: null,
    totalTokens: 150,
    reportedUsageRequests: 0,
    unknownUsageRequests: 1,
    partialUsageRequests: 3,
    incompleteAttemptCountRequests: 1,
  }),
  daily: [
    { date: "2026-09-01", from: "2026-08-31T16:00:00.000Z", to: "2026-09-01T16:00:00.000Z", coverage: "untracked", ...summary() },
    { date: "2026-09-02", from: "2026-09-01T16:00:00.000Z", to: "2026-09-02T16:00:00.000Z", coverage: "tracked", ...summary({ requests: 4, succeeded: 3, failed: 1, inputTokens: 120, outputTokens: null, totalTokens: 150, reportedUsageRequests: 0, unknownUsageRequests: 1, partialUsageRequests: 3 }) },
  ],
  trend: {
    granularity: "day",
    points: [
      trendPoint({ date: "2026-09-01", label: "2026-09-01", from: "2026-08-31T16:00:00.000Z", to: "2026-09-01T16:00:00.000Z", coverage: "untracked" }),
      trendPoint({
        date: "2026-09-02", label: "2026-09-02", from: "2026-09-01T16:00:00.000Z", to: "2026-09-02T16:00:00.000Z",
        requests: 4, succeeded: 3, failed: 1, inputTokens: 120, outputTokens: null, totalTokens: 150,
        inputCacheHitTokens: 60, inputCacheMissTokens: 40, inputCacheUnknownTokens: 20, cacheSplitUnknownRequests: 1,
        reportedUsageRequests: 0, unknownUsageRequests: 1, partialUsageRequests: 3,
      }),
      trendPoint({
        date: "2026-09-03", label: "2026-09-03", from: "2026-09-02T16:00:00.000Z", to: "2026-09-03T16:00:00.000Z",
        inputCacheHitTokens: 10, inputCacheUnknownTokens: null, cacheSplitUnknownRequests: 1,
      }),
    ],
    summary: trendSummary({
      requests: 4, succeeded: 3, failed: 1, inputTokens: 120, outputTokens: null, totalTokens: 150,
      inputCacheHitTokens: 60, inputCacheMissTokens: 40, inputCacheUnknownTokens: 20, cacheSplitUnknownRequests: 1,
      reportedUsageRequests: 0, unknownUsageRequests: 1, partialUsageRequests: 3,
    }),
    models: [
      { providerId: "deepseek", modelId: "deepseek-flash" },
      { providerId: "qwen", modelId: "qwen-plus" },
    ],
    selectedModel: { providerId: "deepseek", modelId: "deepseek-flash" },
  },
  providers: [{
    providerId: "deepseek",
    ...summary({ requests: 4, succeeded: 3, failed: 1, inputTokens: 120, outputTokens: null, totalTokens: 150, reportedUsageRequests: 0, unknownUsageRequests: 1, partialUsageRequests: 3 }),
    models: [{ modelId: "deepseek-flash", ...summary({ requests: 4, succeeded: 3, failed: 1, inputTokens: 120, outputTokens: null, totalTokens: 150, reportedUsageRequests: 0, unknownUsageRequests: 1, partialUsageRequests: 3 }) }],
  }],
});

const searchDashboard = (): UsageDashboard => dashboard({
  summary: summary({ requests: 5, succeeded: 4, failed: 1, resultCount: 12 }),
  daily: [{ date: "2026-09-18", from: "2026-09-17T16:00:00.000Z", to: "2026-09-18T16:00:00.000Z", coverage: "tracked", ...summary({ requests: 5, succeeded: 4, failed: 1, resultCount: 12 }) }],
  trend: {
    granularity: "day",
    points: [trendPoint({ date: "2026-09-18", label: "2026-09-18", from: "2026-09-17T16:00:00.000Z", to: "2026-09-18T16:00:00.000Z", requests: 5, succeeded: 4, failed: 1, resultCount: 12 })],
    summary: trendSummary({ requests: 5, succeeded: 4, failed: 1, resultCount: 12 }),
    models: [],
    selectedModel: null,
  },
  providers: [{ providerId: "zhipu", ...summary({ requests: 5, succeeded: 4, failed: 1, resultCount: 12 }), models: [] }],
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("UsageDashboardView", () => {
  it("explains network-only unknown usage and deletes exactly the displayed snapshot", async () => {
    const api = makeFakeApi();
    const first = dashboard({ summary: summary({ requests: 4, failed: 2, unknownUsageRequests: 2, totalTokens: 120 }), unknownUsage: {
      dismissibleCount: 2, networkFailureCount: 2, otherFailureCount: 0, nonDismissibleCount: 0,
      partialCount: 0, incompleteAttemptCount: 0, snapshot: [{ attemptId: "a", revision: 2 }, { attemptId: "b", revision: 3 }], acknowledgeSnapshot: [],
    } });
    const after = dashboard({ summary: summary({ requests: 2, totalTokens: 120 }) });
    api.usage.getDashboard.mockResolvedValueOnce(first).mockResolvedValue(after);
    api.usage.deleteUnknownFailures.mockResolvedValue(2);
    render(<UsageDashboardView api={api} />);
    expect(await screen.findByText("2 次网络失败请求未返回 Token 用量")).toBeTruthy();
    const dismiss = screen.getByRole("button", { name: "永久删除这 2 条失败记录" });
    expect(dismiss.getAttribute("title")).toContain("永久删除");
    await userEvent.click(dismiss);
    expect(api.usage.deleteUnknownFailures).toHaveBeenCalledWith(first.unknownUsage.snapshot);
    await waitFor(() => expect(api.usage.getDashboard).toHaveBeenCalledTimes(2));
    expect(screen.queryByText("2 次网络失败请求未返回 Token 用量")).toBeNull();
    expect(screen.getByText("120")).toBeTruthy();
  });
  it("refreshes the current filter after a pending deletion instead of restoring stale LLM data", async () => {
    const api = makeFakeApi();
    let finishDelete!: () => void;
    api.usage.deleteUnknownFailures.mockImplementation(() => new Promise<number>((resolve) => { finishDelete = () => resolve(1); }));
    const llm = dashboard({ summary: summary({ requests: 1, failed: 1, unknownUsageRequests: 1 }), unknownUsage: { dismissibleCount: 1, networkFailureCount: 1, otherFailureCount: 0, nonDismissibleCount: 0, partialCount: 0, incompleteAttemptCount: 0, snapshot: [{ attemptId: "a", revision: 2 }], acknowledgeSnapshot: [] } });
    api.usage.getDashboard.mockImplementation(async ({ serviceKind }) => serviceKind === "search" ? searchDashboard() : llm);
    render(<UsageDashboardView api={api} />);
    await screen.findByText("1 次网络失败请求未返回 Token 用量");
    await userEvent.click(screen.getByRole("button", { name: "永久删除这 1 条失败记录" }));
    await userEvent.click(screen.getByRole("button", { name: "Search" }));
    await waitFor(() => expect(api.usage.getDashboard).toHaveBeenLastCalledWith(expect.objectContaining({ serviceKind: "search" })));
    await act(async () => { finishDelete(); });
    await waitFor(() => expect(api.usage.getDashboard).toHaveBeenCalledTimes(3));
    expect(api.usage.getDashboard).toHaveBeenLastCalledWith(expect.objectContaining({ serviceKind: "search" }));
    expect(within(screen.getByLabelText("用量概览")).getByText("Search 请求次数")).toBeTruthy();
  });
  it("shows all-model totals plus fixed request and truthful token charts for the selected model", async () => {
    const api = makeFakeApi();
    api.usage.getDashboard.mockResolvedValue(llmDashboard());

    render(<UsageDashboardView api={api} />);

    expect(await screen.findByText("DeepSeek")).toBeTruthy();
    expect(screen.getByText("deepseek-flash")).toBeTruthy();
    expect(within(screen.getByLabelText("已记录输入 Token")).getByText("120")).toBeTruthy();
    expect(within(screen.getByLabelText("已记录输出 Token")).getByText("未知")).toBeTruthy();
    expect(screen.getByText("全部模型的全局用量")).toBeTruthy();
    expect(screen.getByText("1 次请求用量未知，记录不可删除")).toBeTruthy();
    expect(screen.getByText("3 次请求仅部分上报")).toBeTruthy();
    expect(screen.getByText("1 次请求的实际尝试数可能不完整")).toBeTruthy();
    expect(screen.getByText("仅统计本应用可观测用量，不代表服务商账单或剩余额度。")).toBeTruthy();
    expect(screen.getByRole("figure", { name: "LLM 请求次数趋势" }).querySelector("svg")?.getAttribute("viewBox")).toBe("0 0 720 320");
    expect(screen.getByRole("figure", { name: "LLM Token 趋势" }).querySelector("svg")?.getAttribute("viewBox")).toBe("0 0 720 320");
    expect(screen.getByRole("heading", { name: /API 请求次数/ })).toBeTruthy();
    expect(screen.getByText("缓存命中输入")).toBeTruthy();
    expect(screen.getByText("未命中输入")).toBeTruthy();
    expect(screen.getByText("输出")).toBeTruthy();
    expect(screen.getByText("未分类输入")).toBeTruthy();
    const modelSelector = screen.getByRole("combobox", { name: "模型" }) as HTMLSelectElement;
    const selectedModelNote = screen.getByText("图表模型：DeepSeek / deepseek-flash");
    expect(modelSelector.value).toBe("deepseek\u0000deepseek-flash");
    expect(modelSelector.closest(".usage-chart-model-controls")?.contains(selectedModelNote)).toBe(true);
    expect(modelSelector.compareDocumentPosition(selectedModelNote) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(document.querySelector(".usage-filters")?.contains(modelSelector)).toBe(false);
    expect(screen.queryByRole("combobox", { name: /Profile/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /明细|费用|金额|余额/ })).toBeNull();
    expect(api.usage.getDashboard).toHaveBeenCalledWith({
      serviceKind: "llm",
      range: "month",
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    });
  });

  it("refetches for period and resource switches and keeps Search grouped by provider only", async () => {
    const api = makeFakeApi();
    api.usage.getDashboard.mockImplementation(async ({ serviceKind }) => serviceKind === "search" ? searchDashboard() : llmDashboard());
    render(<UsageDashboardView api={api} />);
    const user = userEvent.setup();

    await screen.findByText("DeepSeek");
    await user.click(screen.getByRole("button", { name: "近7天" }));
    await waitFor(() => expect(api.usage.getDashboard).toHaveBeenLastCalledWith(expect.objectContaining({ serviceKind: "llm", range: "7d" })));
    await user.click(screen.getByRole("button", { name: "Search" }));

    expect(await screen.findByText("智谱搜索")).toBeTruthy();
    const chart = screen.getByRole("figure", { name: "Search 请求次数趋势" });
    expect(chart.querySelector("[data-series='search']")?.classList.contains("usage-search-fill")).toBe(true);
    expect(screen.getByRole("list", { name: "Provider 贡献" }).querySelector("[data-series='search']")?.classList.contains("usage-search-fill")).toBe(true);
    expect(screen.getByText("5 次")).toBeTruthy();
    expect(screen.queryByRole("list", { name: "模型贡献" })).toBeNull();
    expect(screen.queryByRole("combobox", { name: "模型" })).toBeNull();
    expect(api.usage.getDashboard).toHaveBeenLastCalledWith(expect.objectContaining({ serviceKind: "search", range: "7d" }));
  });

  it("offers periods in the required order and queries only a complete valid custom range", async () => {
    const api = makeFakeApi();
    api.usage.getDashboard.mockResolvedValue(llmDashboard());
    render(<UsageDashboardView api={api} />);
    await screen.findByText("DeepSeek");
    const user = userEvent.setup();
    const period = screen.getByRole("group", { name: "统计周期" });
    expect(within(period).getAllByRole("button").map((button) => button.textContent)).toEqual(["今天", "近7天", "近30天", "本月", "自定义"]);

    await user.click(within(period).getByRole("button", { name: "今天" }));
    await waitFor(() => expect(api.usage.getDashboard).toHaveBeenLastCalledWith(expect.objectContaining({ range: "today" })));
    const callsBeforeCustom = api.usage.getDashboard.mock.calls.length;
    await user.click(within(period).getByRole("button", { name: "自定义" }));
    expect(await screen.findByText("请选择开始和结束日期。")).toBeTruthy();
    expect(api.usage.getDashboard).toHaveBeenCalledTimes(callsBeforeCustom);

    fireEvent.change(screen.getByLabelText("开始日期"), { target: { value: "2026-09-18" } });
    fireEvent.change(screen.getByLabelText("结束日期"), { target: { value: "2026-09-16" } });
    expect(screen.getByRole("alert").textContent).toContain("开始日期不能晚于结束日期");
    expect(api.usage.getDashboard).toHaveBeenCalledTimes(callsBeforeCustom);

    fireEvent.change(screen.getByLabelText("结束日期"), { target: { value: "2026-09-20" } });
    await waitFor(() => expect(api.usage.getDashboard).toHaveBeenLastCalledWith(expect.objectContaining({
      range: "custom", startDate: "2026-09-18", endDate: "2026-09-20",
    })));
  });

  it("keeps the Provider/model selection stable across period changes and keeps a single option selectable", async () => {
    const api = makeFakeApi();
    api.usage.getDashboard.mockImplementation(async (query) => {
      const model = query.serviceKind === "llm" ? query.model : undefined;
      const next = llmDashboard();
      if (model) next.trend.selectedModel = model;
      return next;
    });
    render(<UsageDashboardView api={api} />);
    const selector = await screen.findByRole("combobox", { name: "模型" });
    await userEvent.setup().selectOptions(selector, "qwen\u0000qwen-plus");
    await waitFor(() => expect(api.usage.getDashboard).toHaveBeenLastCalledWith(expect.objectContaining({
      model: { providerId: "qwen", modelId: "qwen-plus" },
    })));
    await userEvent.setup().click(screen.getByRole("button", { name: "近30天" }));
    await waitFor(() => expect(api.usage.getDashboard).toHaveBeenLastCalledWith(expect.objectContaining({
      range: "30d", model: { providerId: "qwen", modelId: "qwen-plus" },
    })));
    expect((screen.getByRole("combobox", { name: "模型" }) as HTMLSelectElement).value).toBe("qwen\u0000qwen-plus");

    const one = llmDashboard();
    one.trend.models = [{ providerId: "qwen", modelId: "qwen-plus" }];
    one.trend.selectedModel = { providerId: "qwen", modelId: "qwen-plus" };
    api.usage.getDashboard.mockResolvedValue(one);
    await userEvent.setup().click(screen.getByRole("button", { name: "本月" }));
    await waitFor(() => expect(screen.getByRole("combobox", { name: "模型" }).querySelectorAll("option")).toHaveLength(1));
  });

  it("makes every plot column focusable and dismisses truthful tooltips with Escape", async () => {
    const api = makeFakeApi();
    api.usage.getDashboard.mockResolvedValue(llmDashboard());
    render(<UsageDashboardView api={api} />);
    await screen.findByText("DeepSeek");
    const requestChart = screen.getByRole("figure", { name: "LLM 请求次数趋势" });
    const tokenChart = screen.getByRole("figure", { name: "LLM Token 趋势" });
    const zeroColumn = within(requestChart).getByLabelText("2026-9-3：0 次请求");
    fireEvent.focus(zeroColumn);
    expect((await screen.findByRole("tooltip")).textContent).toContain("2026-9-3");
    expect(screen.getByRole("tooltip").textContent).toContain("请求 0");
    expect(screen.getByRole("tooltip").textContent).not.toContain("部分统计");
    fireEvent.keyDown(zeroColumn, { key: "Escape" });
    expect(screen.queryByRole("tooltip")).toBeNull();

    const untrackedColumn = within(requestChart).getByLabelText("2026-9-1：未统计");
    fireEvent.pointerEnter(untrackedColumn, { clientX: 8, clientY: 20 });
    expect((await screen.findByRole("tooltip")).textContent).toContain("未统计");
    fireEvent.pointerLeave(untrackedColumn);

    const tokenColumn = within(tokenChart).getByLabelText("2026-9-2：Token 150");
    fireEvent.focus(tokenColumn);
    const tokenTooltip = await screen.findByRole("tooltip");
    expect(tokenTooltip.querySelector(".usage-tooltip-header")?.textContent).toBe("2026-9-2总计 150");
    const tokenRows = [...tokenTooltip.querySelectorAll(".usage-tooltip-metric-row")];
    expect(tokenRows).toHaveLength(4);
    expect(tokenRows.map((row) => row.textContent)).toEqual([
      "输入（命中缓存）60", "输入（未命中缓存）40", "输出未知", "输入（未分类）20",
    ]);
    expect(tokenRows.every((row) => row.querySelector(".usage-tooltip-swatch"))).toBe(true);
    expect(tokenRows.every((row) => row.querySelector(".usage-tooltip-value"))).toBe(true);
    expect(tokenTooltip.textContent).not.toContain("部分统计");
    fireEvent.blur(tokenColumn);
    const unknownSplitColumn = within(tokenChart).getByLabelText("2026-9-3：Token 未知");
    fireEvent.focus(unknownSplitColumn);
    expect((await screen.findByRole("tooltip")).textContent).not.toContain("输入（未分类）");
  });

  it("measures and clamps a wide tooltip inside a narrow plot at a 30% column", async () => {
    const api = makeFakeApi();
    const narrow = llmDashboard();
    narrow.trend.points = [
      trendPoint({ date: "2026-09-01", label: "2026-09-01", from: "2026-08-31T16:00:00.000Z", to: "2026-09-01T16:00:00.000Z" }),
      trendPoint({
        date: "2026-09-02", label: "2026-09-02", from: "2026-09-01T16:00:00.000Z", to: "2026-09-02T16:00:00.000Z",
        inputCacheUnknownTokens: null, cacheSplitUnknownRequests: 1,
      }),
      trendPoint({ date: "2026-09-03", label: "2026-09-03", from: "2026-09-02T16:00:00.000Z", to: "2026-09-03T16:00:00.000Z" }),
      trendPoint({ date: "2026-09-04", label: "2026-09-04", from: "2026-09-03T16:00:00.000Z", to: "2026-09-04T16:00:00.000Z" }),
      trendPoint({ date: "2026-09-05", label: "2026-09-05", from: "2026-09-04T16:00:00.000Z", to: "2026-09-05T16:00:00.000Z" }),
    ];
    api.usage.getDashboard.mockResolvedValue(narrow);
    render(<UsageDashboardView api={api} />);
    await screen.findByText("DeepSeek");
    const tokenChart = screen.getByRole("figure", { name: "LLM Token 趋势" });
    const svg = tokenChart.querySelector("svg")!;
    vi.spyOn(svg, "getBoundingClientRect").mockReturnValue({
      x: 0, y: 0, left: 0, top: 0, right: 320, bottom: 320, width: 320, height: 320, toJSON: () => ({}),
    });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      const isTooltip = this.classList.contains("usage-chart-tooltip");
      const width = isTooltip ? 260 : this.classList.contains("usage-chart-plot") ? 320 : 0;
      const height = isTooltip ? 80 : width;
      return { x: 0, y: 0, left: 0, top: 0, right: width, bottom: height, width, height, toJSON: () => ({}) };
    });

    const thirtyPercentColumn = within(tokenChart).getByLabelText("2026-9-2：Token 未知");
    fireEvent.pointerEnter(thirtyPercentColumn, { clientX: 96, clientY: 40 });
    const tooltip = await screen.findByRole("tooltip");
    expect(tooltip.textContent).not.toContain("输入（未分类）");
    expect(tooltip.style.left).toBe("8px");
    const left = Number.parseFloat(tooltip.style.left);
    expect(left).toBeGreaterThanOrEqual(8);
    expect(left + 260).toBeLessThanOrEqual(312);
  });

  it("dismisses a persistent tooltip when its plot or same-bucket content changes size", async () => {
    const resizeCallbacks: ResizeObserverCallback[] = [];
    vi.stubGlobal("ResizeObserver", class {
      constructor(callback: ResizeObserverCallback) { resizeCallbacks.push(callback); }
      observe() {}
      unobserve() {}
      disconnect() {}
    });
    let plotWidth = 320;
    let tooltipWidth = 260;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      const isTooltip = this.classList.contains("usage-chart-tooltip");
      const width = isTooltip ? tooltipWidth : this.classList.contains("usage-chart-plot") ? plotWidth : 0;
      const height = isTooltip ? 80 : 320;
      return { x: 0, y: 0, left: 0, top: 0, right: width, bottom: height, width, height, toJSON: () => ({}) };
    });
    const api = makeFakeApi();
    api.usage.getDashboard.mockResolvedValue(llmDashboard());
    render(<UsageDashboardView api={api} />);
    await screen.findByText("DeepSeek");
    const tokenChart = screen.getByRole("figure", { name: "LLM Token 趋势" });
    const column = within(tokenChart).getByLabelText("2026-9-3：Token 未知");

    fireEvent.focus(column);
    expect(await screen.findByRole("tooltip")).toBeTruthy();
    tooltipWidth = 280;
    act(() => resizeCallbacks.at(-1)?.([], {} as ResizeObserver));
    expect(screen.queryByRole("tooltip")).toBeNull();

    fireEvent.blur(column);
    fireEvent.focus(column);
    expect(await screen.findByRole("tooltip")).toBeTruthy();
    plotWidth = 300;
    act(() => resizeCallbacks.at(-1)?.([], {} as ResizeObserver));
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("keeps every row of a multiline token tooltip inside the plot after a bottom-edge pointer", async () => {
    const api = makeFakeApi();
    const lowerEdge = llmDashboard();
    const point = lowerEdge.trend.points[1];
    if (!point) throw new Error("expected the tracked token fixture");
    point.outputTokens = 30;
    point.coverage = "partial";
    api.usage.getDashboard.mockResolvedValue(lowerEdge);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      const isTooltip = this.classList.contains("usage-chart-tooltip");
      const width = isTooltip ? 260 : this.classList.contains("usage-chart-plot") ? 320 : 0;
      const height = isTooltip ? 127 : 320;
      return { x: 0, y: 0, left: 0, top: 0, right: width, bottom: height, width, height, toJSON: () => ({}) };
    });
    render(<UsageDashboardView api={api} />);
    await screen.findByText("DeepSeek");
    const tokenChart = screen.getByRole("figure", { name: "LLM Token 趋势" });
    const column = within(tokenChart).getByLabelText("2026-9-2：Token 150");

    fireEvent.pointerEnter(column, { clientX: 160, clientY: 310 });
    const tooltip = await screen.findByRole("tooltip");
    expect(tooltip.textContent).toContain("输入（命中缓存）60");
    expect(tooltip.textContent).toContain("输入（未命中缓存）40");
    expect(tooltip.textContent).toContain("输入（未分类）20");
    expect(tooltip.textContent).toContain("输出30");
    expect(tooltip.textContent).not.toContain("部分统计");
    const top = tooltip.style.top.endsWith("%")
      ? Number.parseFloat(tooltip.style.top) / 100 * 320
      : Number.parseFloat(tooltip.style.top);
    expect(top).toBeGreaterThanOrEqual(8);
    expect(top + 127).toBeLessThanOrEqual(312);
  });

  it("keeps responsive axis labels outside the non-uniform SVG transform", async () => {
    const api = makeFakeApi();
    api.usage.getDashboard.mockResolvedValue(llmDashboard());
    render(<UsageDashboardView api={api} />);
    await screen.findByText("DeepSeek");
    const requestChart = screen.getByRole("figure", { name: "LLM 请求次数趋势" });
    expect(requestChart.querySelectorAll("svg text")).toHaveLength(0);
    expect(requestChart.querySelectorAll(".usage-axis-label").length).toBeGreaterThanOrEqual(5);
  });

  it("renders an isolated observed request bucket as a visible point", async () => {
    const api = makeFakeApi();
    const today = llmDashboard();
    today.trend.granularity = "hour";
    today.trend.points = [
      trendPoint({ date: "2026-09-18", label: "00:00 +08:00", from: "2026-09-17T16:00:00.000Z", to: "2026-09-17T17:00:00.000Z", requests: 3 }),
      trendPoint({ date: "2026-09-18", label: "01:00 +08:00", from: "2026-09-17T17:00:00.000Z", to: "2026-09-17T18:00:00.000Z", future: true }),
    ];
    api.usage.getDashboard.mockResolvedValue(today);
    render(<UsageDashboardView api={api} />);
    await screen.findByText("DeepSeek");
    const requestChart = screen.getByRole("figure", { name: "LLM 请求次数趋势" });
    expect(requestChart.querySelectorAll(".usage-request-marker")).toHaveLength(1);
  });

  it("names hourly buckets and marks future hours as not yet occurred", async () => {
    const api = makeFakeApi();
    const today = llmDashboard();
    today.trend.granularity = "hour";
    today.trend.points = [trendPoint({
      date: "2026-09-18", label: "15:00 +08:00", from: "2026-09-18T07:00:00.000Z", to: "2026-09-18T08:00:00.000Z", future: true,
    })];
    api.usage.getDashboard.mockResolvedValue(today);
    render(<UsageDashboardView api={api} />);
    await screen.findByText("DeepSeek");
    const column = within(screen.getByRole("figure", { name: "LLM 请求次数趋势" })).getByLabelText("15:00~16:00：未来时段");
    fireEvent.focus(column);
    expect((await screen.findByRole("tooltip")).textContent).toContain("15:00~16:00");
    expect(screen.getByRole("tooltip").textContent).toContain("未来时段 · 尚未发生");
    expect(screen.getByRole("tooltip").textContent).not.toContain("请求 0");
  });

  it("renders loading, safe error, retry, and empty states", async () => {
    const api = makeFakeApi();
    let rejectFirst!: (reason: Error) => void;
    api.usage.getDashboard
      .mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectFirst = reject; }))
      .mockResolvedValueOnce(dashboard());
    render(<UsageDashboardView api={api} />);

    expect(screen.getByRole("status").textContent).toContain("正在加载用量");
    rejectFirst(new Error("secret database path"));
    expect((await screen.findByRole("alert")).textContent).toContain("无法读取用量，请重试");
    expect(screen.queryByText(/secret database path/)).toBeNull();
    await userEvent.setup().click(screen.getByRole("button", { name: "重试" }));
    expect(await screen.findByText("此范围内暂无 LLM 用量记录。")).toBeTruthy();
  });

  it("keeps untracked and partial daily coverage visible when the range has zero requests", async () => {
    const api = makeFakeApi();
    api.usage.getDashboard.mockResolvedValue(dashboard({
      daily: [
        { date: "2026-08-31", from: "2026-08-30T16:00:00.000Z", to: "2026-08-31T16:00:00.000Z", coverage: "untracked", ...summary() },
        { date: "2026-09-01", from: "2026-08-31T16:00:00.000Z", to: "2026-09-01T16:00:00.000Z", coverage: "partial", ...summary() },
      ],
    }));
    render(<UsageDashboardView api={api} />);

    expect(await screen.findByText("此范围内暂无 LLM 用量记录。")).toBeTruthy();
    expect(screen.getByRole("figure", { name: "LLM 请求次数趋势" })).toBeTruthy();
    expect(screen.getByRole("figure", { name: "LLM Token 趋势" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Provider 贡献" })).toBeNull();
  });

  it("surfaces degraded collection health without exposing the collection start time", async () => {
    const api = makeFakeApi();
    api.usage.getDashboard.mockResolvedValue(dashboard({
      health: {
        ...dashboard().health,
        degraded: true,
        currentFailure: true,
        previousUncleanShutdown: true,
        interruptedRequests: 2,
        pendingRecords: 3,
        failedRecords: 4,
        droppedRecords: 1,
        lastErrorCode: "write_failed",
      },
    }));
    render(<UsageDashboardView api={api} />);

    expect(await screen.findByText("用量记录当前不可用")).toBeTruthy();
    expect(screen.getByText(/待重试 0 条/)).toBeTruthy();
    expect(screen.getByText("部分用量记录尚未写入")).toBeTruthy();
    expect(screen.queryByText(/统计启用时间/)).toBeNull();
  });

  it("does not invent a model identity when the ledger is empty", async () => {
    const api = makeFakeApi();
    api.usage.getDashboard.mockResolvedValue(dashboard());
    render(<UsageDashboardView api={api} />);
    expect(await screen.findByText("此范围内暂无 LLM 用量记录。")).toBeTruthy();
    const selector = screen.getByRole("combobox", { name: "模型" });
    expect((selector as HTMLSelectElement).disabled).toBe(true);
    expect(within(selector).getByRole("option").textContent).toBe("暂无模型");
    expect(api.usage.getDashboard).toHaveBeenCalledWith(expect.not.objectContaining({ model: expect.anything() }));
  });

  it("ignores a stale response after the resource changes", async () => {
    const api = makeFakeApi();
    let resolveLlm!: (value: UsageDashboard) => void;
    api.usage.getDashboard.mockImplementation(({ serviceKind }) => serviceKind === "llm"
      ? new Promise((resolve) => { resolveLlm = resolve; })
      : Promise.resolve(searchDashboard()));
    render(<UsageDashboardView api={api} />);

    await userEvent.setup().click(screen.getByRole("button", { name: "Search" }));
    expect(await screen.findByText("智谱搜索")).toBeTruthy();
    await act(async () => { resolveLlm(llmDashboard()); await Promise.resolve(); });
    expect(screen.getByText("智谱搜索")).toBeTruthy();
    expect(screen.queryByText("DeepSeek")).toBeNull();
  });

  it("polls low-frequency only for visible active data and stops after unmount", async () => {
    vi.useFakeTimers();
    const api = makeFakeApi();
    api.usage.getDashboard.mockResolvedValue(dashboard({ summary: summary({ requests: 1, running: 1 }) }));
    const view = render(<UsageDashboardView api={api} />);
    await act(async () => { await Promise.resolve(); });
    expect(api.usage.getDashboard).toHaveBeenCalledTimes(1);

    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(api.usage.getDashboard).toHaveBeenCalledTimes(2);
    view.unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(api.usage.getDashboard).toHaveBeenCalledTimes(2);
  });
});
