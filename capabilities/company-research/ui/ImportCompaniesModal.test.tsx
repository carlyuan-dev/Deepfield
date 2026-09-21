// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { makeFakeApi } from "../../../apps/desktop/src/renderer/renderer-test-helpers.js";
import { ImportCompaniesModal } from "./ImportCompaniesModal.js";

describe("ImportCompaniesModal", () => {
  it("keeps manual company entry out of the recognition flow", async () => {
    const user = userEvent.setup();
    const api = makeFakeApi();
    api.industryResearch.recognizeCompanies.mockResolvedValue([]);
    api.industryResearch.addCompanies.mockResolvedValue([]);
    const onClose = vi.fn();
    render(
      <ImportCompaniesModal
        api={api}
        itemId="item-1"
        onClose={onClose}
        onCompaniesAdded={() => {}}
      />,
    );

    await user.type(screen.getByLabelText("公司文本"), "没有可识别的名称");
    await user.click(screen.getByRole("button", { name: "识别公司" }));
    expect((await screen.findByRole("alert")).textContent).toContain("没有识别到公司");
    expect(screen.queryByRole("button", { name: "添加公司名称" })).toBeNull();
    expect(screen.queryByLabelText("公司名称")).toBeNull();
    expect(api.industryResearch.addCompanies).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });
});
