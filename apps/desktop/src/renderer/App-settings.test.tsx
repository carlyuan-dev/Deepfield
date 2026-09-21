// @vitest-environment jsdom
import { expect, it } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { App } from "./App.js";
import { conversation, makeFakeApi } from "./renderer-test-helpers.js";

it("keeps the research API stable across unrelated App renders", async () => {
  const fake = makeFakeApi();
  const view = render(<App api={fake} />);
  await userEvent.setup().click(screen.getByRole("button", { name: "研究主题" }));
  await screen.findByRole("heading", { name: "研究主题" });
  await waitFor(() => expect(fake.industryResearch.listItems).toHaveBeenCalledTimes(1));
  view.rerender(<App api={fake} requestIdFactory={() => "another-chat-request"} />);
  expect(fake.industryResearch.listItems).toHaveBeenCalledTimes(1);
});

it("opens the modular settings surface", async () => {
  const fake = makeFakeApi();
  render(<App api={fake} />);
  await userEvent.setup().click(screen.getByRole("button", { name: "设置" }));
  expect(screen.getByRole("navigation", { name: "主导航" })).toBeTruthy();
  expect(await screen.findByRole("navigation", { name: "设置导航" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "＋ 新对话" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "研究主题" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "LLM" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Search" })).toBeTruthy();
  expect(document.querySelector(".settings-modules")).toBeNull();
});

it("preserves an unsent chat draft when returning from settings", async () => {
  const user = userEvent.setup();
  render(<App api={makeFakeApi()} />);
  const input = await screen.findByRole("textbox", { name: "消息输入" });
  await waitFor(() => expect((input as HTMLTextAreaElement).disabled).toBe(false));
  const panes = document.querySelector(".workspace-panes");
  await user.type(input, "尚未发送的草稿");
  expect((input as HTMLTextAreaElement).value).toBe("尚未发送的草稿");
  await user.click(screen.getByRole("button", { name: "设置" }));
  expect(screen.queryByRole("textbox", { name: "消息输入" })).toBeNull();
  expect(document.querySelector(".workspace-panes")).toBe(panes);
  const hiddenInput = document.querySelector('[aria-label="消息输入"]') as HTMLTextAreaElement;
  expect(hiddenInput).toBe(input);
  expect(hiddenInput.value).toBe("尚未发送的草稿");
  await user.click(screen.getByRole("button", { name: "‹ 返回" }));
  expect((screen.getByRole("textbox", { name: "消息输入" }) as HTMLTextAreaElement).value).toBe("尚未发送的草稿");
});

it("leaves settings immediately for every primary navigation destination", async () => {
  const fake = makeFakeApi();
  const first = conversation("settings-first", "第一条对话", true);
  const second = conversation("settings-second", "第二条对话", true);
  fake.conversations.openInitial.mockResolvedValue({ active: first, recent: [first, second] });
  const user = userEvent.setup();
  render(<App api={fake} />);
  await screen.findByRole("textbox", { name: "消息输入" });

  await user.click(screen.getByRole("button", { name: "设置" }));
  await user.click(screen.getByRole("button", { name: "第二条对话" }));
  expect(screen.queryByRole("navigation", { name: "设置导航" })).toBeNull();
  expect(await screen.findByRole("textbox", { name: "消息输入" })).toBeTruthy();

  await user.click(screen.getByRole("button", { name: "设置" }));
  await user.click(screen.getByRole("button", { name: "＋ 新对话" }));
  expect(screen.queryByRole("navigation", { name: "设置导航" })).toBeNull();
  expect(fake.conversations.create).toHaveBeenCalledTimes(1);

  await user.click(screen.getByRole("button", { name: "设置" }));
  await user.click(screen.getByRole("button", { name: "研究主题" }));
  expect(screen.queryByRole("navigation", { name: "设置导航" })).toBeNull();
  expect(await screen.findByRole("heading", { name: "研究主题" })).toBeTruthy();
});
