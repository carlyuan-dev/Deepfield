// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { makeFakeApi } from "../../renderer-test-helpers.js";
import { SettingsView } from "./SettingsView.js";

const settings = {
  schemaVersion: 1 as const,
  llm: { activeProfileId: "l1", profiles: [{ id: "l1", name: "主模型", provider: "deepseek" as const, protocol: "openai_compatible" as const, baseUrl: "https://api.deepseek.com", modelId: "deepseek-test", contextWindow: 128000, hasCredential: true }] },
  search: { activeProfileId: null, profiles: [], manifests: [{ id: "zhipu" as const, displayName: "智谱搜索", defaultBaseUrl: "https://open.bigmodel.cn/api/paas/v4", optionFields: [{ key: "searchEngine", label: "搜索引擎", type: "select" as const, required: false, options: [{ value: "search_std", label: "search_std" }] }], capabilities: { timeFilter: "none" as const, domainFilter: false, publishedDate: true } }] },
};

describe("SettingsView", () => {
  it("renders editable LLM fields, saved-key state, and manifest-driven Search fields", async () => {
    const api = makeFakeApi(); api.settings.get.mockResolvedValue(settings);
    render(<SettingsView api={api} onKeySaved={() => {}} />);
    expect(await screen.findByDisplayValue("主模型")).toBeTruthy();
    expect(screen.getByLabelText("Base URL")).toBeTruthy(); expect((screen.getByLabelText(/^API Key/) as HTMLInputElement).value).toBe("");
    expect(screen.getByText("已保存（留空则保留）")).toBeTruthy();
    await userEvent.setup().click(screen.getByRole("button", { name: "Search" }));
    expect(await screen.findByLabelText("搜索引擎")).toBeTruthy();
  });

  it("keeps only the latest diagnostic result", async () => {
    const api = makeFakeApi(); api.settings.get.mockResolvedValue(settings);
    let first!: (value: any) => void;
    api.settings.diagnoseLlm.mockImplementationOnce(() => new Promise((resolve) => { first = resolve; })).mockResolvedValueOnce({ ok: true, latencyMs: 2, summary: "new" });
    render(<SettingsView api={api} onKeySaved={() => {}} />); await screen.findByDisplayValue("主模型");
    const user = userEvent.setup(); const button = screen.getByRole("button", { name: "测试连接" });
    await user.click(button); expect(screen.getByText("检测中…")).toBeTruthy();
    await user.type(screen.getByLabelText("Model ID"), "2"); await user.click(button);
    expect(await screen.findByText(/连接正常/)).toBeTruthy();
    first({ ok: false, latencyMs: 99, code: "provider_error", message: "old" });
    await waitFor(() => expect(screen.queryByText(/old/)).toBeNull());
  });
});
