import { cpSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, test, type ElectronApplication } from "@playwright/test";
import { writeCapabilityPreferences } from "../../apps/desktop/src/main/capabilities/preferences.js";
import { cleanupElectronUserData, createElectronUserData, launchElectronE2E } from "./electron-launch.js";

test("company profile editing submits only after explicit save", async () => {
  const userDataDir = createElectronUserData();
  let app: ElectronApplication | undefined;
  try {
    cpSync(resolve("out/capabilities/company-research"), join(userDataDir, "capabilities/company-research"), {
      recursive: true, dereference: true, errorOnExist: true, force: false,
    });
    await writeCapabilityPreferences(join(userDataDir, "capabilities-state.json"), {
      schemaVersion: 1, initialized: true, enabledIds: ["company-research"],
    });
    const running = await launchElectronE2E({ userDataDir });
    app = running.app;
    const { page } = running;
    await page.getByRole("navigation", { name: "主导航" }).getByRole("button", { name: "公司调研", exact: true }).click();
    await page.getByRole("button", { name: "新建主题", exact: true }).click();
    await page.getByLabel("主题名称", { exact: true }).fill("编辑保存验收主题");
    await page.getByRole("button", { name: "创建", exact: true }).click();
    await page.getByRole("button", { name: "添加公司", exact: true }).click();
    await page.getByLabel("公司名称", { exact: true }).fill("编辑保存验收公司");
    await page.getByRole("button", { name: "添加到待确认", exact: true }).click();
    await page.getByRole("button", { name: "确认新增", exact: true }).click();
    await page.getByRole("button", { name: "查看 编辑保存验收公司", exact: true }).click();

    // Chromium's native default action runs after React has switched the heading buttons.
    // jsdom/user-event does not reproduce submission when the clicked node becomes Save.
    await page.evaluate(() => {
      document.documentElement.dataset.profileSubmits = "0";
      document.addEventListener("submit", event => {
        if ((event.target as HTMLFormElement).getAttribute("aria-label") === "编辑公司基本信息") {
          document.documentElement.dataset.profileSubmits = String(Number(document.documentElement.dataset.profileSubmits) + 1);
        }
      }, true);
    });
    const submits = () => page.evaluate(() => Number(document.documentElement.dataset.profileSubmits));
    await page.getByRole("button", { name: "编辑信息", exact: true }).click();
    expect(await submits()).toBe(0);
    await expect(page.getByRole("form", { name: "编辑公司基本信息" })).toBeVisible();
    await expect(page.getByRole("button", { name: "自动填写", exact: true })).toHaveCount(0);
    await expect(page.getByRole("form", { name: "编辑公司基本信息" }).getByRole("button")).toHaveCount(0);
    await page.getByLabel("法定名称（可选）").fill("取消的草稿");
    await page.getByRole("button", { name: "取消", exact: true }).click();
    expect(await submits()).toBe(0);

    await page.getByRole("button", { name: "编辑信息", exact: true }).click();
    await expect(page.getByLabel("法定名称（可选）")).not.toHaveValue("取消的草稿");
    await page.getByLabel("法定名称（可选）").fill("已保存的法定名称");
    await page.getByRole("button", { name: "保存", exact: true }).click();
    await expect(page.getByRole("button", { name: "编辑信息", exact: true })).toBeVisible();
    expect(await submits()).toBe(1);
    await page.getByRole("button", { name: "编辑信息", exact: true }).click();
    await expect(page.getByLabel("法定名称（可选）")).toHaveValue("已保存的法定名称");
    expect(await submits()).toBe(1);
  } finally {
    if (app) await app.close();
    cleanupElectronUserData(userDataDir);
  }
});
