// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import type { CapabilityManagementApi, CapabilitySnapshot } from "@deepfield/contracts";
import { CapabilitiesSettings } from "./CapabilitiesSettings.js";

afterEach(cleanup);

const snapshot: CapabilitySnapshot = {
  packages: [{ id: "example", name: "示例能力", description: "示例", version: "1.0.0", status: "ready", enabledNextStart: true }],
  issues: [],
};

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

it("waits for capability saving, then disables and deduplicates restart", async () => {
  const saving = deferred();
  const restart = vi.fn(() => new Promise<void>(() => {}));
  const api = {
    list: async () => snapshot,
    subscribe: () => () => {},
    setEnabled: vi.fn(() => saving.promise),
    restart,
  } as CapabilityManagementApi & { restart(): Promise<void> };
  render(<CapabilitiesSettings api={api} />);
  const user = userEvent.setup();
  const restartButton = await screen.findByRole("button", { name: "重新启动" });
  expect(screen.getByText("重启会中断正在运行的任务")).toBeTruthy();

  await user.click(screen.getByLabelText("下次启动启用示例能力"));
  expect((restartButton as HTMLButtonElement).disabled).toBe(true);
  saving.resolve();
  await waitFor(() => expect((restartButton as HTMLButtonElement).disabled).toBe(false));

  await user.click(restartButton);
  expect(screen.getByRole("button", { name: "正在重启…" })).toBeTruthy();
  expect((restartButton as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByLabelText("下次启动启用示例能力") as HTMLInputElement).disabled).toBe(true);
  await user.click(restartButton);
  expect(restart).toHaveBeenCalledTimes(1);
});

it("restores restart after failure without exposing the raw error", async () => {
  const api = {
    list: async () => snapshot,
    subscribe: () => () => {},
    setEnabled: vi.fn(async () => {}),
    restart: vi.fn(async () => { throw new Error("private restart detail"); }),
  } as CapabilityManagementApi & { restart(): Promise<void> };
  render(<CapabilitiesSettings api={api} />);

  await userEvent.setup().click(await screen.findByRole("button", { name: "重新启动" }));
  expect((await screen.findByRole("alert")).textContent).toBe("无法重新启动应用，请重试");
  expect(screen.queryByText(/private restart detail/)).toBeNull();
  expect((screen.getByRole("button", { name: "重新启动" }) as HTMLButtonElement).disabled).toBe(false);
});
