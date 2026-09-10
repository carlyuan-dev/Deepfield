// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import type { Company, CompanyId } from "@deepfield/contracts";
import { makeFakeApi } from "../../renderer-test-helpers.js";
import { CompanyProfileForm } from "./CompanyProfileModal.js";

describe("CompanyProfileForm", () => {
  it("replaces all eight structured fields while preserving confirmed-empty states", async () => {
    const user = userEvent.setup();
    const api = makeFakeApi();
    const company: Company = {
      id: "company-1" as CompanyId,
      name: "ACME",
      normalizedName: "acme",
      profileStatus: "failed",
      createdAt: "2026-09-10T00:00:00.000Z",
      updatedAt: "2026-09-10T00:00:00.000Z",
    };
    api.industryResearch.updateCompany.mockImplementation(async (_id, input) => ({
      ...company,
      ...input,
      normalizedName: input.name.toLowerCase(),
      profileStatus: "ready",
    }));
    const onSaved = vi.fn();
    render(<CompanyProfileForm api={api} company={company} onCancel={() => {}} onSaved={onSaved} />);

    await user.clear(screen.getByLabelText("公司名称"));
    await user.type(screen.getByLabelText("公司名称"), "ACME Corporation");
    await user.type(screen.getByLabelText("法定名称（可选）"), "ACME Corporation Ltd.");
    await user.click(screen.getByLabelText("已确认无别名"));
    await user.type(screen.getByLabelText("总部（可选）"), "Boston, US");
    await user.type(screen.getByLabelText(/成立时间/), "1998");
    await user.selectOptions(screen.getByLabelText("官方网站状态"), "none");
    await user.click(screen.getByLabelText("已确认未上市"));
    await user.type(screen.getByLabelText(/业务标签/), "工业机器人，机器视觉");
    await user.click(screen.getByRole("button", { name: "保存" }));

    expect(api.industryResearch.updateCompany).toHaveBeenCalledWith("company-1", {
      name: "ACME Corporation",
      legalName: "ACME Corporation Ltd.",
      aliases: [],
      headquarters: "Boston, US",
      foundedAt: "1998",
      officialWebsite: null,
      stockListings: [],
      businessTags: ["工业机器人", "机器视觉"],
    });
    expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ profileStatus: "ready" }));
  });
});
