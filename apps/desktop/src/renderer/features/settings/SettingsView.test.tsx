// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { makeFakeApi } from "../../renderer-test-helpers.js";
import { SettingsView } from "./SettingsView.js";
import { listSearchProviderManifests } from "@deepfield/retrieval";

const settings = {
  schemaVersion: 1 as const,
  llm: { activeProfileId: "l1", profiles: [{ id: "l1", name: "主模型", provider: "deepseek" as const, protocol: "openai_compatible" as const, baseUrl: "https://api.deepseek.com", modelId: "deepseek-test", contextWindow: 128000, hasCredential: true }] },
  search: { activeProfileId: null, profiles: [], manifests: [{ id: "zhipu" as const, displayName: "智谱搜索", defaultBaseUrl: "https://open.bigmodel.cn/api/paas/v4", optionFields: [{ key: "searchEngine", label: "搜索引擎", type: "select" as const, required: false, options: [{ value: "search_std", label: "search_std" }] }], capabilities: { timeFilter: "none" as const, domainFilter: false, publishedDate: true } }] },
};

const multiProfileSettings = {
  schemaVersion: 1 as const,
  llm: {
    activeProfileId: "l1",
    profiles: [
      { id: "l1", name: "模型一", provider: "deepseek" as const, protocol: "openai_compatible" as const, baseUrl: "https://api.deepseek.com", modelId: "model-1", contextWindow: 128000, hasCredential: true },
      { id: "l2", name: "模型二", provider: "qwen" as const, protocol: "openai_compatible" as const, baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", modelId: "model-2", contextWindow: 128000, hasCredential: true },
    ],
  },
  search: {
    activeProfileId: "s1",
    profiles: [
      { id: "s1", name: "搜索一", provider: "zhipu" as const, baseUrl: "https://open.bigmodel.cn/api/paas/v4", options: {}, hasCredential: true },
      { id: "s2", name: "搜索二", provider: "tavily" as const, baseUrl: "https://api.tavily.com", options: {}, hasCredential: true },
    ],
    manifests: [
      { id: "zhipu" as const, displayName: "智谱搜索", defaultBaseUrl: "https://open.bigmodel.cn/api/paas/v4", optionFields: [], capabilities: { timeFilter: "none" as const, domainFilter: false, publishedDate: true } },
      { id: "tavily" as const, displayName: "Tavily", defaultBaseUrl: "https://api.tavily.com", optionFields: [], capabilities: { timeFilter: "exact_range" as const, domainFilter: false, publishedDate: true } },
    ],
  },
};

describe("SettingsView", () => {
  it("selects Doubao Custom defaults and diagnoses an unsaved search credential", async () => {
    const api = makeFakeApi();
    api.settings.get.mockResolvedValue({ ...settings, search: { ...settings.search, manifests: [...listSearchProviderManifests()] } });
    api.settings.diagnoseSearch.mockResolvedValue({ ok: true, latencyMs: 1, summary: "ok" });
    render(<SettingsView api={api} onKeySaved={() => {}} onBack={() => {}} initialModule="search" />);
    const user = userEvent.setup();
    await user.selectOptions(await screen.findByLabelText("Provider"), "doubao");
    expect(screen.getByLabelText("Base URL").getAttribute("value")).toBe("https://open.feedcoopapi.com");
    expect(screen.queryByLabelText("搜索引擎")).toBeNull();
    await user.type(screen.getByLabelText("API Key"), "doubao-search-key");
    await user.click(screen.getByRole("button", { name: "测试连接" }));
    expect(api.settings.diagnoseSearch).toHaveBeenCalledWith({ name: "豆包搜索 Custom", provider: "doubao", baseUrl: "https://open.feedcoopapi.com", options: {}, apiKey: "doubao-search-key" });
    expect(api.settings.saveSearchProfile).not.toHaveBeenCalled();
    expect(api.settings.diagnoseLlm).not.toHaveBeenCalled();
  });
  it("opens the requested settings module from a recovery action", async () => {
    const api = makeFakeApi(); api.settings.get.mockResolvedValue(settings);
    render(<SettingsView api={api} onKeySaved={() => {}} onBack={() => {}} initialModule="search" />);
    expect(screen.getByRole("button", { name: "Search" }).getAttribute("aria-current")).toBe("page");
    expect(await screen.findByLabelText("搜索引擎")).toBeTruthy();
  });

  it("leaves testing state after a transport rejection and hides arbitrary messages", async () => {
    const api = makeFakeApi(); api.settings.get.mockResolvedValue(settings);
    api.settings.diagnoseLlm.mockRejectedValue(new Error("secret token"));
    render(<SettingsView api={api} onKeySaved={() => {}} onBack={() => {}} />);
    await screen.findByDisplayValue("主模型");
    await userEvent.setup().click(screen.getByRole("button", { name: "测试连接" }));
    expect(await screen.findByText(/连接失败/)).toBeTruthy();
    expect(screen.queryByText(/secret token|检测中/)).toBeNull();
    expect(screen.getByRole("button", { name: "测试连接" }).hasAttribute("disabled")).toBe(false);
  });
  it("presents a missing LLM key distinctly from rejected credentials", async () => {
    const api = makeFakeApi(); api.settings.get.mockResolvedValue(settings);
    api.settings.diagnoseLlm.mockResolvedValueOnce({ ok: false, latencyMs: 0, code: "invalid_config", message: "secret token", error: { code: "CONFIG.CREDENTIAL_MISSING", category: "configuration", context: { service: "llm" } } });
    render(<SettingsView api={api} onKeySaved={() => {}} onBack={() => {}} />);
    await screen.findByDisplayValue("主模型");
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "测试连接" }));
    expect(await screen.findByText(/LLM.*API Key.*填写/)).toBeTruthy();
    expect(screen.queryByText(/secret token/)).toBeNull();
    api.settings.diagnoseLlm.mockResolvedValueOnce({ ok: false, latencyMs: 0, code: "unauthorized", message: "secret token", error: { code: "EXTERNAL.AUTHENTICATION_FAILED", category: "external", context: { service: "llm" } } });
    await user.click(screen.getByRole("button", { name: "测试连接" }));
    expect(await screen.findByText(/LLM.*认证失败/)).toBeTruthy();
  });
  it.each(["LLM", "Search"] as const)("allows saving %s without a key while explaining it is unavailable", async (module) => {
    const api = makeFakeApi();
    const view = { ...multiProfileSettings, llm: { ...multiProfileSettings.llm, profiles: multiProfileSettings.llm.profiles.map((profile) => ({ ...profile, hasCredential: false })) }, search: { ...multiProfileSettings.search, profiles: multiProfileSettings.search.profiles.map((profile) => ({ ...profile, hasCredential: false })) } };
    api.settings.get.mockResolvedValue(view);
    api.settings.saveLlmProfile.mockResolvedValue(view);
    api.settings.saveSearchProfile.mockResolvedValue(view);
    render(<SettingsView api={api} onKeySaved={() => {}} onBack={() => {}} />);
    await screen.findByDisplayValue("模型一");
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: module }));
    expect(screen.getByText(`未填写 API Key，可保存配置，但 ${module} 尚不可用。`)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "保存" }));
    const save = module === "LLM" ? api.settings.saveLlmProfile : api.settings.saveSearchProfile;
    expect(save).toHaveBeenCalledWith(expect.not.objectContaining({ apiKey: expect.anything() }));
  });

  it.each(["LLM", "Search"] as const)("keeps an existing %s key when a replacement is cleared", async (module) => {
    const api = makeFakeApi(); api.settings.get.mockResolvedValue(multiProfileSettings);
    render(<SettingsView api={api} onKeySaved={() => {}} onBack={() => {}} />);
    await screen.findByDisplayValue("模型一");
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: module }));
    const key = screen.getByLabelText(/^API Key/);
    await user.type(key, "replacement");
    await user.clear(key);
    expect(screen.getByText("已保存（留空则保留）")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "保存" }));
    const save = module === "LLM" ? api.settings.saveLlmProfile : api.settings.saveSearchProfile;
    expect(save).toHaveBeenCalledWith(expect.not.objectContaining({ apiKey: expect.anything() }));
  });
  it("uses deepseek-flash when creating and testing a new LLM profile", async () => {
    const api = makeFakeApi(); api.settings.get.mockResolvedValue(settings);
    api.settings.diagnoseLlm.mockResolvedValue({ ok: true, latencyMs: 1, summary: "OK" });
    render(<SettingsView api={api} onKeySaved={() => {}} onBack={() => {}} />);
    await screen.findByDisplayValue("主模型");
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "＋ 新建 Profile" }));
    await user.click(screen.getByRole("button", { name: "测试连接" }));
    expect(api.settings.diagnoseLlm).toHaveBeenCalledWith(expect.objectContaining({
      provider: "deepseek", modelId: "deepseek-flash",
    }));
  });
  it("renders editable LLM fields, saved-key state, and manifest-driven Search fields", async () => {
    const api = makeFakeApi(); api.settings.get.mockResolvedValue(settings);
    render(<SettingsView api={api} onKeySaved={() => {}} onBack={() => {}} />);
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
    render(<SettingsView api={api} onKeySaved={() => {}} onBack={() => {}} />); await screen.findByDisplayValue("主模型");
    const user = userEvent.setup(); const button = screen.getByRole("button", { name: "测试连接" });
    await user.click(button); expect(screen.getByText("检测中…")).toBeTruthy();
    await user.type(screen.getByLabelText("Model ID"), "2"); await user.click(button);
    expect(await screen.findByText(/连接正常/)).toBeTruthy();
    first({ ok: false, latencyMs: 99, code: "provider_error", message: "old" });
    await waitFor(() => expect(screen.queryByText(/old/)).toBeNull());
  });

  it("restores each saved LLM Profile diagnostic when switching", async () => {
    const api = makeFakeApi(); api.settings.get.mockResolvedValue(multiProfileSettings);
    api.settings.diagnoseLlm
      .mockResolvedValueOnce({ ok: true, latencyMs: 11, summary: "one" })
      .mockResolvedValueOnce({ ok: true, latencyMs: 22, summary: "two" });
    render(<SettingsView api={api} onKeySaved={() => {}} onBack={() => {}} />); await screen.findByDisplayValue("模型一");
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "测试连接" }));
    expect(await screen.findByText("连接正常 · 11ms")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "模型二" }));
    expect(screen.getByText("未检测")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "测试连接" }));
    expect(await screen.findByText("连接正常 · 22ms")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: /模型一/ }));
    expect(screen.getByText("连接正常 · 11ms")).toBeTruthy();
  });

  it("restores each saved Search Profile diagnostic when switching", async () => {
    const api = makeFakeApi(); api.settings.get.mockResolvedValue(multiProfileSettings);
    api.settings.diagnoseSearch
      .mockResolvedValueOnce({ ok: true, latencyMs: 31, summary: "one" })
      .mockResolvedValueOnce({ ok: true, latencyMs: 42, summary: "two" });
    render(<SettingsView api={api} onKeySaved={() => {}} onBack={() => {}} />); await screen.findByDisplayValue("模型一");
    const user = userEvent.setup(); await user.click(screen.getByRole("button", { name: "Search" }));
    expect(await screen.findByDisplayValue("搜索一")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "测试连接" }));
    expect(await screen.findByText("连接正常 · 31ms")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "搜索二" }));
    expect(screen.getByText("未检测")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "测试连接" }));
    expect(await screen.findByText("连接正常 · 42ms")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: /搜索一/ }));
    expect(screen.getByText("连接正常 · 31ms")).toBeTruthy();
  });

  it("gives every new Profile an independent black diagnostic state", async () => {
    const api = makeFakeApi(); api.settings.get.mockResolvedValue(multiProfileSettings);
    api.settings.diagnoseLlm.mockResolvedValue({ ok: true, latencyMs: 55, summary: "new" });
    render(<SettingsView api={api} onKeySaved={() => {}} onBack={() => {}} />); await screen.findByDisplayValue("模型一");
    const user = userEvent.setup(); await user.click(screen.getByRole("button", { name: "＋ 新建 Profile" }));
    await user.click(screen.getByRole("button", { name: "测试连接" }));
    expect(await screen.findByText("连接正常 · 55ms")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "＋ 新建 Profile" }));
    expect(screen.getByText("未检测")).toBeTruthy();
  });

  it("opens 用量信息 without saving settings and preserves the in-progress Profile draft", async () => {
    const api = makeFakeApi(); api.settings.get.mockResolvedValue(settings);
    render(<SettingsView api={api} onKeySaved={() => {}} onBack={() => {}} />);
    await screen.findByDisplayValue("主模型");
    const user = userEvent.setup();
    const modelId = screen.getByLabelText("Model ID");
    await user.clear(modelId);
    await user.type(modelId, "draft-model");

    const navigation = screen.getByRole("navigation", { name: "设置导航" });
    await user.click(within(navigation).getByRole("button", { name: "用量信息" }));
    expect(await screen.findByRole("heading", { name: "用量信息" })).toBeTruthy();
    expect(api.usage.getDashboard).toHaveBeenCalledTimes(1);
    expect(api.settings.saveLlmProfile).not.toHaveBeenCalled();
    expect(api.settings.activateLlmProfile).not.toHaveBeenCalled();
    expect(screen.queryByRole("combobox", { name: /Profile/i })).toBeNull();

    await user.click(within(navigation).getByRole("button", { name: "LLM" }));
    expect((screen.getByLabelText("Model ID") as HTMLInputElement).value).toBe("draft-model");
  });
});
