// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { App } from "./App.js";
import {
  chatMessage,
  makeFakeApi,
  project,
  type FakeDesktopApi,
} from "./renderer-test-helpers.js";

async function renderApp(fake: FakeDesktopApi) {
  const user = userEvent.setup();
  const utils = render(<App api={fake} />);
  return { user, ...utils };
}

describe("app shell", () => {
  it("renders the brand, primary navigation, disabled future items and settings", async () => {
    const fake = makeFakeApi();
    fake.projects.list.mockResolvedValue([]);
    await renderApp(fake);

    expect(screen.getByText("Deepfield")).toBeTruthy();
    expect(screen.getByRole("button", { name: "新对话" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "行业研究" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "设置" })).toBeTruthy();
    for (const label of ["公司库", "项目资料库", "任务中心"]) {
      const button = screen.getByRole("button", { name: label }) as HTMLButtonElement;
      expect(button.disabled).toBe(true);
    }
  });

  it("opens the direct capability with the form and no chat rail", async () => {
    const fake = makeFakeApi();
    fake.projects.list.mockResolvedValue([]);
    const { user } = await renderApp(fake);

    await user.click(screen.getByRole("button", { name: "行业研究" }));
    expect(screen.getByRole("heading", { name: "行业研究" })).toBeTruthy();
    expect(screen.getByLabelText("行业")).toBeTruthy();
    expect(document.querySelector("aside")).toBeNull();
  });

  it("opens the capability from chat with the rail open", async () => {
    const fake = makeFakeApi();
    fake.projects.list.mockResolvedValue([]);
    const { user } = await renderApp(fake);

    await user.click(screen.getByRole("button", { name: "新对话" }));
    await user.selectOptions(screen.getByLabelText("模式"), "research");
    expect(screen.getByLabelText("行业")).toBeTruthy();
    const rail = document.querySelector("aside");
    expect(rail).not.toBeNull();
    expect(rail!.className).toContain("chat-rail");
  });

  it("collapses and expands the rail without losing the project form", async () => {
    const fake = makeFakeApi();
    fake.projects.list.mockResolvedValue([]);
    const { user } = await renderApp(fake);

    await user.click(screen.getByRole("button", { name: "新对话" }));
    await user.selectOptions(screen.getByLabelText("模式"), "research");
    await user.click(screen.getByRole("button", { name: "收起 Chat 侧栏" }));
    expect(document.querySelector("aside")!.className).toContain("collapsed");
    expect(screen.getByLabelText("行业")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "展开 Chat 侧栏" }));
    expect(document.querySelector("aside")!.className).not.toContain("collapsed");
    expect(screen.getByLabelText("行业")).toBeTruthy();
  });

  it("lists projects and opens a project workspace from the sidebar", async () => {
    const fake = makeFakeApi();
    fake.projects.list.mockResolvedValue([project({ id: "p1", industry: "低空经济" })]);
    const { user } = await renderApp(fake);

    const projectButton = await screen.findByRole("button", { name: "低空经济" });
    await user.click(projectButton);
    expect(screen.getByText("状态：项目已创建")).toBeTruthy();
    expect(screen.getByRole("button", { name: "打开项目 Chat" })).toBeTruthy();
  });

  it("subscribes to chat events once on mount and unsubscribes on unmount", async () => {
    const fake = makeFakeApi();
    fake.projects.list.mockResolvedValue([]);
    const unsubscribe = vi.fn();
    fake.chat.subscribe.mockImplementation(() => unsubscribe);
    const { unmount } = await renderApp(fake);
    expect(fake.chat.subscribe).toHaveBeenCalledTimes(1);
    unmount();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("provides a polite live region for streaming output", async () => {
    const fake = makeFakeApi();
    fake.projects.list.mockResolvedValue([project({ id: "p1" })]);
    const { user } = await renderApp(fake);

    const projectButton = await screen.findByRole("button", { name: "人形机器人" });
    await user.click(projectButton);
    await user.click(screen.getByRole("button", { name: "打开项目 Chat" }));
    const live = document.querySelector('[aria-live="polite"]');
    expect(live).not.toBeNull();
  });

  it("clears the bound project when 新对话 is clicked", async () => {
    const fake = makeFakeApi();
    fake.projects.list.mockResolvedValue([project({ id: "p1" })]);
    fake.chat.listMessages.mockResolvedValue([chatMessage("m1", "user", "历史问题")]);
    const { user } = await renderApp(fake);

    const projectButton = await screen.findByRole("button", { name: "人形机器人" });
    await user.click(projectButton);
    await user.click(screen.getByRole("button", { name: "打开项目 Chat" }));
    await waitFor(() => expect(screen.getByText("历史问题")).toBeTruthy());

    await user.click(screen.getByRole("button", { name: "新对话" }));
    expect(screen.getByText(/请先创建或选择一个项目/)).toBeTruthy();
    expect(screen.queryByText("历史问题")).toBeNull();
  });
});
