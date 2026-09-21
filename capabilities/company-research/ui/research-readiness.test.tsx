// @vitest-environment jsdom
import { act, fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { makeFakeApi } from "../../../apps/desktop/src/renderer/renderer-test-helpers.js";
import { configuredSettings } from "../../../apps/desktop/src/renderer/features/settings/settings-test-fixtures.js";
import { CompanyResearchPanel } from "./CompanyResearchPanel.js";
import { researchRun, researchSummary } from "./company-research-test-fixtures.js";
import { useCompanyResearch } from "./use-company-research.js";
import { assertResearchReady } from "./research-readiness.js";

const input = { direction: "product_and_technology", focusScope: "关注新品", asOfDate: "2026-09-09" } as const;

describe("research configuration readiness", () => {
  it("distinguishes absent active profiles from absent credentials", async () => {
    const api = makeFakeApi(); const settings = configuredSettings();
    settings.llm.activeProfileId = null;
    api.settings.get.mockResolvedValue(settings);
    await expect(assertResearchReady(api, { search: true })).rejects.toMatchObject({ code: "CONFIG.PROFILE_MISSING", context: { service: "llm" } });
    settings.llm.activeProfileId = settings.llm.profiles[0]!.id;
    settings.llm.profiles[0]!.hasCredential = false;
    await expect(assertResearchReady(api, { search: true })).rejects.toMatchObject({ code: "CONFIG.CREDENTIAL_MISSING", context: { service: "llm" } });
  });
  it("does not mislabel a combined preflight failure as a single service", async () => {
    const api = makeFakeApi(); const settings = configuredSettings();
    settings.llm.profiles[0]!.hasCredential = false;
    settings.search.profiles[0]!.hasCredential = false;
    api.settings.get.mockResolvedValue(settings);
    const error = await assertResearchReady(api, { search: true }).catch((error: unknown) => error);
    expect(error).toMatchObject({ code: "CONFIG.CREDENTIAL_MISSING", context: undefined });
  });
  it("displays backend credential DTOs even when renderer preflight was ready", async () => {
    const api = makeFakeApi(); api.settings.get.mockResolvedValue(configuredSettings());
    api.companyResearch.start.mockRejectedValue({ code: "CONFIG.CREDENTIAL_MISSING", category: "configuration", context: { service: "search" } });
    const user = userEvent.setup();
    const onOpenSettings = vi.fn();
    render(<CompanyResearchPanel api={api} itemId="item-research" companyId="company-research" topicName="主题" companyName="公司" onOpenSettings={onOpenSettings} />);
    await user.click(await screen.findByRole("button", { name: "开始调研" }));
    const dialog = screen.getByRole("dialog");
    await user.type(within(dialog).getByLabelText("关注范围（可选）"), "保留这段草稿");
    await user.click(within(dialog).getByRole("button", { name: "开始调研" }));
    expect(await within(dialog).findByText(/填写当前 Search Profile 的 API Key/)).toBeTruthy();
    expect(within(dialog).queryByRole("button", { name: "重新加载" })).toBeNull();
    await user.click(within(dialog).getByRole("button", { name: "前往设置" }));
    expect(onOpenSettings).toHaveBeenCalledWith("search");
    expect((within(dialog).getByLabelText("关注范围（可选）") as HTMLTextAreaElement).value).toBe("保留这段草稿");
  });

  it("keeps a hidden launch dialog and its draft when Escape is pressed in settings", async () => {
    const api = makeFakeApi(); api.settings.get.mockResolvedValue(configuredSettings());
    const user = userEvent.setup();
    const props = { api, itemId: "item-research", companyId: "company-research", topicName: "主题", companyName: "公司" } as const;
    const view = render(<CompanyResearchPanel {...props} active />);
    await user.click(await screen.findByRole("button", { name: "开始调研" }));
    await user.type(screen.getByLabelText("关注范围（可选）"), "切换设置后保留");
    view.rerender(<CompanyResearchPanel {...props} active={false} />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect((screen.getByLabelText("关注范围（可选）") as HTMLTextAreaElement).value).toBe("切换设置后保留");
    view.rerender(<CompanyResearchPanel {...props} active />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  it.each([
    [false, false, "LLM 和 Search"],
    [false, true, "LLM"],
    [true, false, "Search"],
  ] as const)("blocks research when configured credentials are LLM=%s Search=%s", async (llm, search, missing) => {
    const api = makeFakeApi(); const settings = configuredSettings();
    settings.llm.profiles[0]!.hasCredential = llm;
    settings.search.profiles[0]!.hasCredential = search;
    api.settings.get.mockResolvedValue(settings);
    const { result } = renderHook(() => useCompanyResearch(api, "item-research", "company-research"));
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => {
      await expect(result.current.start(input)).rejects.toThrow(`请先在设置中配置 ${missing}，选择当前 Profile 并填写 API Key。`);
    });
    expect(api.companyResearch.start).not.toHaveBeenCalled();
  });

  it("does not use a credential from an inactive profile", async () => {
    const api = makeFakeApi(); const settings = configuredSettings();
    settings.llm.activeProfileId = null;
    api.settings.get.mockResolvedValue(settings);
    const { result } = renderHook(() => useCompanyResearch(api, "item-research", "company-research"));
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => {
      await expect(result.current.start(input)).rejects.toThrow("请先在设置中配置 LLM，选择当前 Profile 并填写 API Key。");
    });
    expect(api.companyResearch.start).not.toHaveBeenCalled();
  });

  it("shows a safe settings-read failure inside the launch dialog", async () => {
    const api = makeFakeApi();
    api.settings.get.mockRejectedValue(new Error("secret configuration path"));
    const user = userEvent.setup();
    render(<CompanyResearchPanel api={api} itemId="item-research" companyId="company-research" topicName="主题" companyName="公司" />);
    await user.click(await screen.findByRole("button", { name: "开始调研" }));
    const dialog = screen.getByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "开始调研" }));
    expect(await within(dialog).findByText("无法读取配置，请稍后重试或前往设置检查。" )).toBeTruthy();
    expect(screen.queryByText(/secret/)).toBeNull();
    expect(api.companyResearch.start).not.toHaveBeenCalled();
  });

  it.each([
    ["structure_failed", "succeeded", false, true],
    ["structure_failed", "unknown", false, true],
    ["structure_failed", "succeeded", true, false],
    ["structure_failed", "none", false, false],
    ["research_failed", "unknown", false, false],
    ["completed", "none", false, false],
  ] as const)("checks research dependencies for %s/%s (changed=%s)", async (status, searchStatus, changed, allowed) => {
    const api = makeFakeApi(); const settings = configuredSettings();
    settings.search.profiles[0]!.hasCredential = false;
    api.settings.get.mockResolvedValue(settings);
    const run = researchRun({ status, searchStatus, ...input });
    api.companyResearch.getState.mockResolvedValue({ runs: [researchSummary(run)], globalActiveRun: null });
    api.companyResearch.getRun.mockResolvedValue(run);
    api.companyResearch.retryFailed.mockResolvedValue(run);
    const { result } = renderHook(() => useCompanyResearch(api, run.itemId, run.companyId));
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => {
      const retried = result.current.retry({ ...input, focusScope: changed ? "新范围" : "  关注新品  " });
      if (allowed) await retried;
      else await expect(retried).rejects.toThrow("请先在设置中配置 Search，选择当前 Profile 并填写 API Key。");
    });
    expect(api.companyResearch.retryFailed).toHaveBeenCalledTimes(allowed ? 1 : 0);
  });
});
