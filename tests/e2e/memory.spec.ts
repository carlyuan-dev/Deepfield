import { expect, test, type ElectronApplication } from "@playwright/test";
import { createElectronUserData, launchElectronE2E, cleanupElectronUserData } from "./electron-launch.js";

test("new interactions learn a preference; settings edit, toggle, restart and forget use the same persisted memory", async () => {
  test.setTimeout(180000);
  const userDataDir = createElectronUserData();
  let app: ElectronApplication | undefined;
  try {
    let running = await launchElectronE2E({ userDataDir }); app = running.app;
    let page = running.page;
    page.on("pageerror", error => console.error("Memory renderer error:", error.message));
    await expect(page.getByLabel("消息输入")).toBeVisible();
    await expect(page.getByLabel("记忆说明")).toBeVisible();
    await page.getByRole("button", { name: "知道了", exact: true }).click();
    await expect(page.getByLabel("记忆说明")).toHaveCount(0);
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await page.getByLabel("API Key", { exact: true }).fill("sk-memory-fixture-unused-1234567890");
    await page.getByRole("button", { name: "保存", exact: true }).click();
    await page.getByRole("button", { name: "DeepSeek", exact: true }).click();
    await expect(page.getByText("已保存（留空则保留）", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "设为当前", exact: true }).click();
    await expect(page.getByRole("button", { name: "DeepSeek · 当前", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "‹ 返回", exact: true }).click();
    const composer = page.getByLabel("消息输入");
    for (const text of ["以后回答先给结论，再给依据。", "给我一个简短例子", "嗯，再举一个", "谢谢，今天先到这里"]) {
      await expect(composer).toBeEnabled();
      await composer.fill(text); await page.getByRole("button", { name: "发送", exact: true }).click();
      await expect(composer).toBeEnabled({ timeout: 10000 });
    }
    await expect.poll(async () => page.evaluate(async () => (await window.deepfield.memory!.get()).records.length), { timeout: 75000 }).toBe(1);
    await expect(page.getByRole("button", { name: "管理记忆", exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await page.getByRole("button", { name: "记忆", exact: true }).click();
    await expect(page.getByRole("heading", { name: "记忆", exact: true })).toBeVisible();
    await expect(page.getByLabel("自动学习新记忆", { exact: false })).toBeChecked();
    await page.getByRole("button", { name: /先给结论.*自动学习/ }).click();
    await expect(page.getByRole("textbox", { name: "内容", exact: true })).toBeVisible({ timeout: 5000 });
    await page.getByRole("textbox", { name: "内容", exact: true }).fill("回答先给可执行建议，再给解释。");
    await page.getByRole("button", { name: "保存", exact: true }).click();
    await expect(page.getByRole("button", { name: /先给结论.*手动修改/ })).toBeVisible();
    await page.getByLabel("使用已保存的记忆", { exact: false }).uncheck();
    await page.getByLabel("自动学习新记忆", { exact: false }).uncheck();
    await expect(page.getByLabel("自动学习新记忆", { exact: false })).not.toBeChecked();
    await page.screenshot({ path: "/private/tmp/deepfield-memory-settings.png" });
    await app.close(); app = undefined;
    running = await launchElectronE2E({ userDataDir }); app = running.app; page = running.page;
    await expect(page.getByLabel("消息输入")).toBeVisible();
    await expect(page.getByLabel("记忆说明")).toHaveCount(0);
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await page.getByRole("button", { name: "记忆", exact: true }).click();
    await expect(page.getByLabel("使用已保存的记忆", { exact: false })).not.toBeChecked();
    await expect(page.getByLabel("自动学习新记忆", { exact: false })).not.toBeChecked();
    await page.getByRole("button", { name: /先给结论.*手动修改/ }).click();
    await expect(page.getByRole("textbox", { name: "内容", exact: true })).toHaveValue("回答先给可执行建议，再给解释。");
    page.once("dialog", dialog => { void dialog.accept(); });
    await page.getByRole("button", { name: "删除", exact: true }).click();
    await expect(page.getByText(/暂无记忆/)).toBeVisible();
  } finally {
    if (app) await app.close();
    cleanupElectronUserData(userDataDir);
  }
});
