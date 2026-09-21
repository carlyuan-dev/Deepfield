// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { App } from "../App.js";
import { makeFakeApi } from "../renderer-test-helpers.js";
import { companyManagementFixture, loadCompanyFixture } from "./company-test-fixture.js";

afterEach(cleanup);
it("keeps zero-package navigation empty and management available", async () => {
  const api = makeFakeApi();
  Object.assign(api, { capabilityManagement: { list: async () => ({ packages: [], issues: [] }), subscribe: () => () => {}, setEnabled: vi.fn() } });
  render(<App api={api} />);
  await screen.findByRole("textbox", { name: "消息输入" });
  expect(screen.queryByText("研究主题")).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "设置" }));
  await userEvent.click(screen.getByRole("button", { name: "能力" }));
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
  expect(await screen.findByText("当前状态：可用")).toBeTruthy();
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

it("restores the legacy workspace once and revocation returns to Chat", async () => {
  const api = makeFakeApi(); const management = companyManagementFixture(); api.capabilityManagement = management;
  render(<App api={api} loadCapabilityModule={loadCompanyFixture} initialWorkspace={{ activeCapability: "industry-research", chatPane: "collapsed" }} />);
  expect(await screen.findByRole("heading", { name: "研究主题" })).toBeTruthy();
  act(() => management.publish({ packages: [], issues: [] }));
  await waitFor(() => expect(screen.queryByRole("heading", { name: "研究主题" })).toBeNull());
  expect(screen.getByRole("textbox", { name: "消息输入" })).toBeTruthy();
  expect(screen.queryByRole("alert")).toBeNull();
});

it("treats a missing previously selected package as ordinary Chat", async () => {
  render(<App api={makeFakeApi()} initialWorkspace={{ activeCapability: "industry-research", chatPane: "collapsed" }} />);
  expect(await screen.findByRole("textbox", { name: "消息输入" })).toBeTruthy();
  expect(screen.queryByRole("alert")).toBeNull();
});
