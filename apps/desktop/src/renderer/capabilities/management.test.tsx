// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { App } from "../App.js";
import { capabilityItem, makeFakeApi } from "../renderer-test-helpers.js";
import { companyManagementFixture, loadCompanyFixture } from "./company-test-fixture.js";

afterEach(cleanup);
it("keeps zero-package navigation empty and management available", async () => {
  const api = makeFakeApi();
  Object.assign(api, { capabilityManagement: { list: async () => ({ packages: [], issues: [] }), subscribe: () => () => {}, setEnabled: vi.fn(), restart: vi.fn() } });
  render(<App api={api} />);
  await screen.findByRole("textbox", { name: "消息输入" });
  expect(screen.queryByText("研究主题")).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "设置" }));
  await userEvent.click(screen.getByRole("button", { name: "能力" }));
  expect(screen.getByText("勾选或取消勾选以选择启用的能力，配置将在软件重启后生效。")).toBeTruthy();
  expect(await screen.findByText("暂无已安装能力")).toBeTruthy();
});

it("changes only next-start selection and preserves a package draft across settings", async () => {
  const api = makeFakeApi(); const management = companyManagementFixture(); api.capabilityManagement = management;
  const user = userEvent.setup();
  render(<App api={api} loadCapabilityModule={loadCompanyFixture} />);
  await user.click(await screen.findByRole("button", { name: "研究主题" }));
  await user.click(await screen.findByRole("button", { name: "新建主题" }));
  const input = screen.getByRole("textbox", { name: "主题名称" });
  await user.type(input, "保留这个主题草稿");
  await user.click(screen.getByRole("button", { name: "设置" }));
  await user.click(screen.getByRole("button", { name: "能力" }));
  const row = (await screen.findByText("公司研究")).closest("section");
  expect(row).not.toBeNull();
  expect(row?.classList.contains("capability-setting")).toBe(true);
  expect(row?.textContent).toContain("1.0.0");
  expect(row?.textContent).toContain("研究主题与公司");
  expect(row?.textContent).toContain("当前状态：可用");
  expect(row?.textContent).not.toContain("下次启动启用公司研究");
  expect(row?.querySelector(".capability-setting-description")?.getAttribute("title")).toBe("研究主题与公司");
  await user.click(screen.getByLabelText("下次启动启用公司研究"));
  expect(await screen.findByText("下次启动生效")).toBeTruthy();
  expect((await management.list()).packages[0]?.status).toBe("ready");
  expect((screen.getByLabelText("下次启动启用公司研究") as HTMLInputElement).checked).toBe(false);
  expect(screen.getByRole("button", { name: "研究主题" })).toBeTruthy();
  await user.keyboard("{Escape}");
  await user.click(screen.getByRole("button", { name: "‹ 返回" }));
  expect(screen.getByRole("textbox", { name: "主题名称" })).toBe(input);
  expect((input as HTMLInputElement).value).toBe("保留这个主题草稿");
});

it("isolates a package import failure and Chat remains usable", async () => {
  const api = makeFakeApi(); api.capabilityManagement = companyManagementFixture();
  const loader = vi.fn(async () => { throw new Error("sk-private-error"); });
  const user = userEvent.setup(); render(<App api={api} loadCapabilityModule={loader} />);
  await screen.findByRole("textbox", { name: "消息输入" });
  expect(loader).not.toHaveBeenCalled();
  await user.click(await screen.findByRole("button", { name: "研究主题" }));
  expect(await screen.findByText("能力界面不可用 · ui_load_failed")).toBeTruthy();
  expect(document.body.textContent).not.toContain("sk-private-error");
  await user.click(screen.getByRole("button", { name: "返回 Chat" }));
  const input = screen.getByRole("textbox", { name: "消息输入" });
  await user.type(input, "Chat仍可输入"); expect((input as HTMLTextAreaElement).value).toBe("Chat仍可输入");
});

it.each([
  { title: "添加公司", field: "公司名称" },
  { title: "一键导入公司", field: "公司文本" },
])("preserves $title drafts and pending recognition through settings Escape", async ({ title, field }) => {
  const api = makeFakeApi(); api.capabilityManagement = companyManagementFixture();
  api.industryResearch.listItems.mockResolvedValue([capabilityItem({ industry: "测试主题" })]);
  let finishRecognition!: (drafts: { name: string }[]) => void;
  api.industryResearch.recognizeCompanies.mockImplementation(() => new Promise(resolve => { finishRecognition = resolve; }));
  const user = userEvent.setup(); render(<App api={api} loadCapabilityModule={loadCompanyFixture} />);
  await user.click(await screen.findByRole("button", { name: "研究主题" }));
  await user.click(await screen.findByRole("button", { name: /^测试主题/ }));
  await user.click(await screen.findByRole("button", { name: title }));
  const input = screen.getByRole("textbox", { name: field });
  await user.type(input, "保留公司文本");
  if (title === "一键导入公司") await user.click(screen.getByRole("button", { name: "识别公司" }));
  await user.click(screen.getByRole("button", { name: "设置" }));
  await user.keyboard("{Escape}");
  if (title === "一键导入公司") await act(async () => finishRecognition([{ name: "识别出的公司" }]));
  await user.click(screen.getByRole("button", { name: "‹ 返回" }));
  expect(screen.getByRole("dialog", { name: title })).toBeTruthy();
  expect(screen.getByRole("textbox", { name: field })).toBe(input);
  expect((input as HTMLInputElement).value).toBe("保留公司文本");
  if (title === "一键导入公司") {
    expect((screen.getByRole("textbox", { name: "公司名称" }) as HTMLInputElement).value).toBe("识别出的公司");
    expect((screen.getByRole("button", { name: "确认导入" }) as HTMLButtonElement).disabled).toBe(false);
  }
});

it("restores the legacy workspace once and revocation returns to Chat", async () => {
  const api = makeFakeApi(); const management = companyManagementFixture(); api.capabilityManagement = management;
  render(<App api={api} loadCapabilityModule={loadCompanyFixture} initialWorkspace={{ activeCapability: "industry-research", chatPane: "collapsed" }} />);
  expect(await screen.findByRole("heading", { name: "研究主题" })).toBeTruthy();
  act(() => management.publish({ packages: [], issues: [] }));
  await waitFor(() => expect(screen.queryByRole("heading", { name: "研究主题" })).toBeNull());
  expect(screen.getByRole("textbox", { name: "消息输入" })).toBeTruthy();
  expect(screen.queryByRole("alert")).toBeNull();
});

it("preserves deletion confirmation through settings Escape without deleting", async () => {
  const api = makeFakeApi(); api.capabilityManagement = companyManagementFixture();
  api.industryResearch.listItems.mockResolvedValue([capabilityItem({ industry: "保留主题" })]);
  const user = userEvent.setup(); render(<App api={api} loadCapabilityModule={loadCompanyFixture} />);
  await user.click(await screen.findByRole("button", { name: "研究主题" }));
  await screen.findByRole("button", { name: /^保留主题/ });
  await user.click(screen.getByRole("button", { name: "删除主题" }));
  await user.click(screen.getByRole("checkbox"));
  await user.click(screen.getByRole("button", { name: "确认删除（1）" }));
  const dialog = screen.getByRole("dialog", { name: "删除主题" });
  await user.click(screen.getByRole("button", { name: "设置" })); await user.keyboard("{Escape}");
  await user.click(screen.getByRole("button", { name: "‹ 返回" }));
  expect(screen.getByRole("dialog", { name: "删除主题" })).toBe(dialog);
  expect(api.industryResearch.deleteItems).not.toHaveBeenCalled();
});

it("treats a missing previously selected package as ordinary Chat", async () => {
  render(<App api={makeFakeApi()} initialWorkspace={{ activeCapability: "industry-research", chatPane: "collapsed" }} />);
  expect(await screen.findByRole("textbox", { name: "消息输入" })).toBeTruthy();
  expect(screen.queryByRole("alert")).toBeNull();
});
