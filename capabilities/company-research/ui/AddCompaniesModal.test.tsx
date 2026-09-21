// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { makeFakeApi } from "../../../apps/desktop/src/renderer/renderer-test-helpers.js";
import { AddCompaniesModal } from "./AddCompaniesModal.js";

describe("AddCompaniesModal", () => {
  it("collects multiple name-only drafts and submits them together", async () => {
    const user = userEvent.setup();
    const api = makeFakeApi();
    api.industryResearch.addCompanies.mockImplementation(async (_itemId, drafts) => drafts.map((draft, index) => ({
      id: `company-${index}` as never,
      itemId: "item-1" as never,
      name: draft.name,
      normalizedName: draft.name.toLowerCase(),
      profileStatus: "pending",
      createdAt: "2026-09-10T00:00:00.000Z",
      updatedAt: "2026-09-10T00:00:00.000Z",
    })));
    const onClose = vi.fn();
    const onCompaniesAdded = vi.fn();
    render(
      <AddCompaniesModal
        api={api}
        itemId="item-1"
        onClose={onClose}
        onCompaniesAdded={onCompaniesAdded}
      />,
    );

    const input = screen.getByLabelText("公司名称");
    await user.type(input, "乐奇");
    await user.click(screen.getByRole("button", { name: "添加到待确认" }));
    await user.type(input, "Meta");
    await user.click(screen.getByRole("button", { name: "添加到待确认" }));

    const pending = screen.getByRole("list", { name: "待确认公司" });
    expect(within(pending).getByText("乐奇")).toBeTruthy();
    expect(within(pending).getByText("Meta")).toBeTruthy();
    expect(screen.queryByLabelText(/国家|地区|备注/u)).toBeNull();

    await user.click(screen.getByRole("button", { name: "确认新增" }));

    expect(api.industryResearch.addCompanies).toHaveBeenCalledWith("item-1", [
      { name: "乐奇" },
      { name: "Meta" },
    ]);
    expect(onCompaniesAdded).toHaveBeenCalledWith(expect.arrayContaining([
      expect.objectContaining({ name: "乐奇" }),
      expect.objectContaining({ name: "Meta" }),
    ]));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
