// @vitest-environment jsdom
import { act, render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { AppError, toPublicError, type CompanyId, type ItemCompanyView } from "@deepfield/contracts";
import { IndustryResearchCapability } from "./IndustryResearchCapability.js";
import { capabilityItem, makeFakeApi } from "../../renderer-test-helpers.js";
import { profileResult } from "../../../../../../packages/application/src/testing/company-profile-test-fixtures.js";

describe("profile recovery presentation", () => {
  it("loads persisted queue guidance, opens the correct Settings module, and clears on resume", async () => {
    const fake = makeFakeApi(); const item = capabilityItem({ id: "topic", industry: "机器人" });
    const base: ItemCompanyView = { id: "company" as CompanyId, name: "待补全公司", normalizedName: "待补全公司", itemId: item.id, profileStatus: "pending", createdAt: "", updatedAt: "" };
    fake.industryResearch.listItems.mockResolvedValue([item]);
    fake.industryResearch.listCompanies.mockResolvedValue([{ ...base, profileIssue: toPublicError(new AppError("CONFIG.CREDENTIAL_MISSING", { service: "search" })) }]);
    const settings = vi.fn(); const user = userEvent.setup();
    render(<IndustryResearchCapability api={fake} onClose={() => {}} onOpenSettings={settings} />);
    await user.click(await screen.findByRole("button", { name: /^机器人/ }));
    await user.click(await screen.findByRole("button", { name: "前往设置" }));
    expect(settings).toHaveBeenCalledWith("search");
    fake.industryResearch.listCompanies.mockResolvedValue([base]);
    await act(async () => fake.emitProfile({ companyId: base.id, status: "pending" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "前往设置" })).toBeNull());
  });
  it("shows ambiguous identity inline and confirms the precise subject without editing facts", async () => {
    const fake = makeFakeApi(); const item = capabilityItem({ id: "topic", industry: "机器人" });
    const company: ItemCompanyView = { id: "company" as CompanyId, name: "同名公司", normalizedName: "同名公司", itemId: item.id, profileStatus: "failed", createdAt: "", updatedAt: "", profileProvenance: { ...profileResult({}), identity: { disposition: "ambiguous", reason: "检索到三个同名主体，无法确认具体公司", sources: profileResult().identity.sources } } };
    fake.industryResearch.listItems.mockResolvedValue([item]);
    fake.industryResearch.listCompanies.mockResolvedValue([company]);
    const user = userEvent.setup(); render(<IndustryResearchCapability api={fake} onClose={() => {}} />);
    await user.click(await screen.findByRole("button", { name: /^机器人/ }));
    const badge = await screen.findByText("身份待确认");
    expect(badge.closest(".company-row-button")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "确认主体 同名公司" }));
    expect(screen.getByRole("dialog", { name: "确认公司主体" })).toBeTruthy();
    expect(screen.getByText("检索到三个同名主体，无法确认具体公司")).toBeTruthy();
    expect(screen.getByText(/对所有研究主题生效/)).toBeTruthy();
    await user.type(screen.getByLabelText("精确主体名称"), "三星电子株式会社");
    await user.type(screen.getByLabelText("官方网站（可选）"), "ftp://example.com");
    await user.click(screen.getByRole("button", { name: "确认并继续补全" }));
    expect((await screen.findByRole("alert")).textContent).toBe("请输入 http:// 或 https:// 开头的网站地址");
    expect(fake.industryResearch.confirmCompanyProfileIdentity).not.toHaveBeenCalled();
    await user.clear(screen.getByLabelText("官方网站（可选）"));
    await user.type(screen.getByLabelText("官方网站（可选）"), "https://www.samsung.com/");
    await user.click(screen.getByRole("button", { name: "确认并继续补全" }));
    await waitFor(() => expect(fake.industryResearch.confirmCompanyProfileIdentity).toHaveBeenCalledWith(company.id, { name: "三星电子株式会社", officialWebsite: "https://www.samsung.com/" }));
    expect(fake.industryResearch.updateCompany).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog", { name: "确认公司主体" })).toBeNull();
  });

  it("prefills the latest saved hint after technical failure and keeps retry plus modify actions", async () => {
    const fake = makeFakeApi(); const item = capabilityItem({ id: "topic", industry: "机器人" });
    fake.industryResearch.listItems.mockResolvedValue([item]);
    fake.industryResearch.listCompanies.mockResolvedValue([{ id: "company" as CompanyId, name: "三星", normalizedName: "三星", itemId: item.id, profileStatus: "failed", createdAt: "", updatedAt: "", profileIdentityHint: { name: "三星电子株式会社", officialWebsite: "https://www.samsung.com/" }, profileIssue: toPublicError(new AppError("EXTERNAL.INVALID_RESPONSE", { service: "llm" })) }]);
    const user = userEvent.setup(); render(<IndustryResearchCapability api={fake} onClose={() => {}} active={false} />);
    await user.click(await screen.findByRole("button", { name: /^机器人/ }));
    expect(await screen.findByText("结果格式错误，请重试")).toBeTruthy();
    expect(screen.getByRole("button", { name: "重试补全 三星" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "修改主体 三星" }));
    expect((screen.getByLabelText("精确主体名称") as HTMLInputElement).value).toBe("三星电子株式会社");
    expect((screen.getByLabelText("官方网站（可选）") as HTMLInputElement).value).toBe("https://www.samsung.com/");
    await user.keyboard("{Escape}");
    expect(screen.getByRole("dialog", { name: "确认公司主体" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "取消" }));
    expect(fake.industryResearch.confirmCompanyProfileIdentity).not.toHaveBeenCalled();
  });
});
