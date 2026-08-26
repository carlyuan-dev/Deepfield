// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { App } from "./App.js";
import { makeFakeApi, type FakeDesktopApi } from "./renderer-test-helpers.js";

async function renderApp(fake: FakeDesktopApi) {
  const user = userEvent.setup();
  const utils = render(<App api={fake} />);
  return { user, ...utils };
}

async function openSettings(fake: FakeDesktopApi, user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "设置" }));
}

describe("settings view", () => {
  it("shows the configured state without echoing any existing key value", async () => {
    const fake = makeFakeApi();
    fake.projects.list.mockResolvedValue([]);
    fake.settings.hasDeepSeekKey.mockResolvedValue(true);
    const { user } = await renderApp(fake);

    await openSettings(fake, user);
    await waitFor(() => expect(screen.getByText("已配置")).toBeTruthy());
    expect(screen.queryByText(/sk-/)).toBeNull();
  });

  it("clears the password input after saving and never renders the key", async () => {
    const fake = makeFakeApi();
    fake.projects.list.mockResolvedValue([]);
    fake.settings.hasDeepSeekKey.mockResolvedValue(false);
    const { user } = await renderApp(fake);

    await openSettings(fake, user);
    await waitFor(() => expect(screen.getByText("未配置")).toBeTruthy());

    const input = screen.getByLabelText("API Key") as HTMLInputElement;
    await user.type(input, "sk-top-secret-value");
    await user.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => expect(fake.settings.setDeepSeekKey).toHaveBeenCalledWith("sk-top-secret-value"));
    await waitFor(() => expect(screen.getByText("已配置")).toBeTruthy());
    expect(input.value).toBe("");
    expect(screen.queryByText(/sk-top-secret-value/)).toBeNull();
  });

  it("rejects blank input on the front end without calling the api", async () => {
    const fake = makeFakeApi();
    fake.projects.list.mockResolvedValue([]);
    const { user } = await renderApp(fake);

    await openSettings(fake, user);
    await user.click(screen.getByRole("button", { name: "保存" }));
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(fake.settings.setDeepSeekKey).not.toHaveBeenCalled();
  });

  it("shows a generic error on save failure without the key", async () => {
    const fake = makeFakeApi();
    fake.projects.list.mockResolvedValue([]);
    fake.settings.setDeepSeekKey.mockRejectedValue(new Error("boom"));
    const { user } = await renderApp(fake);

    await openSettings(fake, user);
    await user.type(screen.getByLabelText("API Key"), "sk-failing-key");
    await user.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect(screen.queryByText(/sk-failing-key/)).toBeNull();
  });

  it("shows a generic error when the key check fails instead of hanging", async () => {
    const fake = makeFakeApi();
    fake.projects.list.mockResolvedValue([]);
    fake.settings.hasDeepSeekKey.mockRejectedValue(new Error("store boom"));
    const { user } = await renderApp(fake);

    await openSettings(fake, user);
    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect(screen.queryByText("检测中…")).toBeNull();
    expect(screen.queryByText(/store boom/)).toBeNull();
    expect(screen.queryByText(/sk-/)).toBeNull();
  });
});
