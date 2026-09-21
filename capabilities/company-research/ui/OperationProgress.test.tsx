// @vitest-environment jsdom
import { render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { CompanyProfileProgress, CompanyResearchBatchState } from "../contracts/index.js";
import { OperationProgress } from "./OperationProgress.js";

const batch = (overrides: Partial<CompanyResearchBatchState> = {}): CompanyResearchBatchState => ({ batchId: "b", itemId: "topic", status: "running", entries: [], processed: 1, succeeded: 1, failed: 0, total: 2, ...overrides });
const profile = (overrides: Partial<CompanyProfileProgress> = {}): CompanyProfileProgress => ({ itemId: "topic", status: "running", processed: 1, failed: 0, total: 3, ...overrides });
const renderProgress = (batchState: CompanyResearchBatchState | null, profileState: CompanyProfileProgress | null, props: Partial<React.ComponentProps<typeof OperationProgress>> = {}) => {
  const onCancel = vi.fn(async () => {}); const onResume = vi.fn(async () => {}); const onOpenSettings = vi.fn();
  render(<OperationProgress batch={batchState} profile={profileState} onCancel={onCancel} onResume={onResume} onOpenSettings={onOpenSettings} {...props} />);
  return { onCancel, onResume, onOpenSettings };
};

describe("OperationProgress", () => {
  it("permits retrying cancellation when settlement fails after the cancelling snapshot", async () => {
    let reject!: (reason: unknown) => void;
    const cancel = vi.fn(() => new Promise<void>((_resolve, fail) => { reject = fail; }));
    const view = render(<OperationProgress batch={batch()} profile={null} onCancel={cancel} onResume={async () => {}} />);
    await userEvent.setup().click(screen.getByRole("button", { name: "取消批量调研" }));
    view.rerender(<OperationProgress batch={batch({ status: "cancelling" })} profile={null} onCancel={cancel} onResume={async () => {}} />);
    reject({ code: "STORAGE.FAILED", category: "storage" });
    await screen.findByRole("alert");
    expect((screen.getByRole("button", { name: "取消批量调研" }) as HTMLButtonElement).disabled).toBe(false);
  });
  it("lets current profile work replace a stale terminal batch, then lets a new active batch replace the profile notice", () => {
    const { rerender } = render(<OperationProgress batch={batch({ status: "completed" })} profile={profile()} onCancel={async () => {}} onResume={async () => {}} />);
    expect(screen.getByText("正在自动补全公司信息")).toBeTruthy();
    expect(screen.queryByText("批量调研已完成")).toBeNull();
    rerender(<OperationProgress batch={batch({ status: "completed" })} profile={profile({ status: "completed", processed: 3, failed: 1 })} onCancel={async () => {}} onResume={async () => {}} />);
    expect(screen.getByText("公司资料补全已完成")).toBeTruthy();
    expect(screen.getByText("成功 2 · 失败 1")).toBeTruthy();
    expect(screen.queryByText("批量调研已完成")).toBeNull();
    expect(screen.queryByText("正在自动补全公司信息")).toBeNull();
    expect(screen.queryByRole("progressbar", { name: "公司资料补全进度" })).toBeNull();
    expect(screen.queryByRole("status", { name: "公司资料补全进行中" })).toBeNull();
    rerender(<OperationProgress batch={batch()} profile={profile({ status: "completed", processed: 3, failed: 1 })} onCancel={async () => {}} onResume={async () => {}} />);
    expect(screen.getByText("正在批量进行公司调研")).toBeTruthy();
    expect(screen.queryByText("公司资料补全已完成")).toBeNull();
  });

  it("catches rejected cancel and resume actions, shows safe feedback, and remains retryable", async () => {
    const cancel = vi.fn().mockRejectedValueOnce({ code: "STORAGE.FAILED", category: "storage" }).mockResolvedValue(undefined);
    const user = userEvent.setup(); const { rerender } = render(<OperationProgress batch={batch()} profile={null} onCancel={cancel} onResume={async () => {}} />);
    await user.click(screen.getByRole("button", { name: "取消批量调研" }));
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "无法保存调研状态，请稍后重试。");
    await user.click(screen.getByRole("button", { name: "取消批量调研" })); expect(cancel).toHaveBeenCalledTimes(2);
    const resume = vi.fn().mockRejectedValue({ code: "BUSINESS.CONFLICT", category: "business" });
    rerender(<OperationProgress batch={batch({ status: "paused" })} profile={null} onCancel={async () => {}} onResume={resume} />);
    await user.click(screen.getByRole("button", { name: "继续调研" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("当前调研状态不允许此操作"));
  });

  it("explains paused authentication and recovered pauses with explicit recovery actions", async () => {
    const onOpenSettings = vi.fn(); const { rerender } = render(<OperationProgress batch={batch({ status: "paused", issue: { code: "EXTERNAL.AUTHENTICATION_FAILED", category: "external", context: { service: "search" } } })} profile={null} onCancel={async () => {}} onResume={async () => {}} onOpenSettings={onOpenSettings} />);
    expect(screen.getByText(/Search 认证失败/)).toBeTruthy();
    await userEvent.setup().click(screen.getByRole("button", { name: "前往设置" })); expect(onOpenSettings).toHaveBeenCalledWith("search");
    rerender(<OperationProgress batch={batch({ status: "paused" })} profile={null} onCancel={async () => {}} onResume={async () => {}} />);
    expect(screen.getByText(/应用重新启动后已暂停/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "继续调研" })).toBeTruthy();
  });

  it("reports terminal success and failure counts and orders active status text before bar, spinner, and cancel", () => {
    const { container, rerender } = render(<OperationProgress batch={batch({ status: "completed", processed: 3, succeeded: 2, failed: 1, total: 3 })} profile={null} onCancel={async () => {}} onResume={async () => {}} />);
    expect(screen.getByText("成功 2 · 失败 1")).toBeTruthy();
    expect(screen.queryByRole("progressbar")).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
    rerender(<OperationProgress batch={batch()} profile={null} onCancel={async () => {}} onResume={async () => {}} />);
    expect(screen.getByText("正在批量进行公司调研")).toHaveProperty("className", "operation-progress-active");
    const progress = container.querySelector(".operation-progress")!;
    expect([...progress.children].map((node) => node.className)).toEqual(["operation-progress-summary", "operation-progress-bar", "company-profile-spinner", "operation-link"]);
  });
});
