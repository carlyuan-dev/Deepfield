import { _electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const E2E_KEY = "sk-e2e-dummy-not-real-987654321";
const SCREENSHOT_COMPANY_LIST = "/private/tmp/deepfield-p4t7-company-list.png";
const SCREENSHOT_COMPANY_DETAIL = "/private/tmp/deepfield-p4t7-company-detail.png";
const SCREENSHOT_BATCH_DELETE = "/private/tmp/deepfield-p4t7-batch-delete.png";
const SCREENSHOT_IMPORT_CANDIDATES = "/private/tmp/deepfield-p4t7-import-candidates.png";

interface RunningApp { app: ElectronApplication; page: Page; }

async function launchApp(userDataRoot: string): Promise<RunningApp> {
  const executablePath = process.env.DEEPFIELD_E2E_EXECUTABLE;
  const app = await _electron.launch({
    ...(executablePath === undefined ? { args: ["out/main/index.js"] } : { executablePath }),
    env: {
      ...process.env,
      DEEPFIELD_AGENT_MODE: "fake",
      DEEPFIELD_E2E: "1",
      DEEPFIELD_USER_DATA_DIR: userDataRoot,
    },
  });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await expect(page.getByText("Deepfield").first()).toBeVisible({ timeout: 30_000 });
  return { app, page };
}

async function closeAppGracefully(running: RunningApp): Promise<void> {
  const closed = running.app.waitForEvent("close");
  await running.app.evaluate(({ app }) => app.quit());
  await closed;
}

async function chatReady(page: Page): Promise<void> {
  await expect(page.getByLabel("消息输入")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByLabel("DeepSeek 连接状态：未连接")).toBeVisible();
}

async function enterDummyKey(page: Page): Promise<void> {
  await page.getByRole("button", { name: "设置" }).click();
  const keyInput = page.getByLabel("API Key");
  await expect(keyInput).toBeVisible();
  await keyInput.fill(E2E_KEY);
  await page.getByRole("button", { name: "保存" }).click();
  await expect(page.getByText("已配置")).toBeVisible({ timeout: 10_000 });
  await page.getByRole("button", { name: "‹ 返回" }).click();
  await expect(page.getByLabel("消息输入")).toBeVisible();
}

async function addDraft(page: Page, name: string, country: string): Promise<void> {
  await page.getByLabel("公司名称").fill(name);
  await page.getByLabel("国籍/地区（可选）").fill(country);
  await page.getByRole("button", { name: "添加到待确认" }).click();
}

test("agent-first chat and industry research main path survive a restart", async () => {
  const userDataRoot = mkdtempSync(join(tmpdir(), "deepfield-p4t7-"));
  try {
    const first = await launchApp(userDataRoot);
    let page = first.page;

    // Chat starts immediately. Shift+Enter keeps a newline; plain Enter sends.
    await chatReady(page);
    await enterDummyKey(page);
    const composer = page.getByLabel("消息输入");
    await composer.fill("第一行");
    await composer.press("Shift+Enter");
    await expect(composer).toHaveValue("第一行\n");
    await composer.fill("第一行\n第二行");
    await expect(composer).toHaveValue("第一行\n第二行");
    await composer.press("Enter");
    await expect(page.locator(".message.assistant")).toHaveCount(1, { timeout: 30_000 });
    await expect(page.locator(".message.assistant .assistant-content")).toContainText("测试回复");

    // Create and edit one research item.
    await page.getByRole("button", { name: "行业研究" }).click();
    await expect(page.getByRole("heading", { name: "行业研究", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "添加行业" }).click();
    const createDialog = page.getByRole("dialog", { name: "添加行业" });
    await createDialog.getByLabel("行业", { exact: true }).fill("人形机器人");
    await createDialog.getByLabel("研究范围（可选）").fill("中国市场");
    await createDialog.getByLabel("备注（可选）").fill("关注量产进度");
    await createDialog.getByRole("button", { name: "创建", exact: true }).click();
    await page.getByRole("button", { name: /返回调研列表/ }).click();
    await page.getByRole("button", { name: "编辑 人形机器人" }).click();
    const editDialog = page.getByRole("dialog", { name: "编辑行业" });
    await editDialog.getByLabel("行业", { exact: true }).fill("具身智能");
    await editDialog.getByLabel("研究范围（可选）").fill("全球市场");
    await editDialog.getByLabel("备注（可选）").fill("关注商业化进度");
    await editDialog.getByRole("button", { name: "保存", exact: true }).click();
    await page.getByRole("button", { name: /^具身智能/ }).click();
    await expect(page.getByRole("heading", { name: "具身智能" })).toBeVisible();
    await expect(page.getByText("全球市场")).toBeVisible();

    // Add three companies in one confirmation batch.
    await page.getByRole("button", { name: "添加公司" }).click();
    await addDraft(page, "优必选", "中国");
    await addDraft(page, "Figure AI", "美国");
    await addDraft(page, "Agility Robotics", "美国");
    await page.getByRole("button", { name: "确认新增" }).click();
    await expect(page.getByText("优必选", { exact: true })).toBeVisible();
    await expect(page.getByText("Figure AI", { exact: true })).toBeVisible();
    await expect(page.getByText("Agility Robotics", { exact: true })).toBeVisible();
    await page.screenshot({ path: SCREENSHOT_COMPANY_LIST });

    // Company detail is a third in-Capability level.
    await page.getByRole("button", { name: "查看 优必选" }).click();
    await expect(page.getByRole("heading", { name: "优必选" })).toBeVisible();
    await expect(page.getByText("公司调研内容将在下一阶段生成")).toBeVisible();
    await page.screenshot({ path: SCREENSHOT_COMPANY_DETAIL });
    await page.getByRole("button", { name: /返回公司列表/ }).click();

    // Single removal requires confirmation; cancellation preserves the row.
    await page.getByRole("button", { name: "删除公司 优必选" }).click();
    const singleConfirm = page.getByRole("dialog", { name: "移除公司" });
    await singleConfirm.getByRole("button", { name: "取消" }).click();
    await expect(page.getByText("优必选", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "删除公司 优必选" }).click();
    await page.getByRole("dialog", { name: "移除公司" }).getByRole("button", { name: "确认移除" }).click();
    await expect(page.getByText("优必选", { exact: true })).toHaveCount(0);

    // Batch selection also preserves selection when confirmation is cancelled.
    await page.getByRole("button", { name: "批量删除" }).click();
    await page.getByRole("button", { name: "全选" }).click();
    await expect(page.getByRole("button", { name: "删除已选（2）" })).toBeEnabled();
    await page.screenshot({ path: SCREENSHOT_BATCH_DELETE });
    await page.getByRole("button", { name: "删除已选（2）" }).click();
    await page.getByRole("dialog", { name: "批量移除公司" }).getByRole("button", { name: "取消" }).click();
    await expect(page.getByRole("button", { name: "删除已选（2）" })).toBeEnabled();
    await page.getByRole("button", { name: "删除已选（2）" }).click();
    await page.getByRole("button", { name: "确认移除 2 家公司" }).click();
    await expect(page.getByText("暂无公司，可手动添加或从文本识别。")).toBeVisible();

    // Fake recognition never calls DeepSeek; edit the candidate before import.
    await page.getByRole("button", { name: "一键导入公司" }).click();
    const importDialog = page.getByRole("dialog", { name: "一键导入公司" });
    await importDialog.getByLabel("公司文本").fill("从这段材料中识别示例公司");
    await importDialog.getByRole("button", { name: "识别公司" }).click();
    const candidateName = importDialog.getByLabel("候选 1 公司名称");
    await expect(candidateName).toHaveValue("Deepfield 演示公司");
    await candidateName.fill("Deepfield 演示公司（已校对）");
    await page.screenshot({ path: SCREENSHOT_IMPORT_CANDIDATES });
    await importDialog.getByRole("button", { name: "确认导入" }).click();
    await expect(page.getByText("Deepfield 演示公司（已校对）", { exact: true })).toBeVisible();

    // Industry deletion is a list-level selection flow with a second confirmation.
    await page.getByRole("button", { name: /返回调研列表/ }).click();
    await page.getByRole("button", { name: "删除行业" }).click();
    await page.getByRole("checkbox", { name: "选择 具身智能" }).click();
    await page.getByRole("button", { name: "确认删除（1）" }).click();
    await page.getByRole("dialog", { name: "删除行业" }).getByRole("button", { name: "取消" }).click();
    await expect(page.getByRole("button", { name: "确认删除（1）" })).toBeEnabled();
    await page.getByRole("button", { name: "确认删除（1）" }).click();
    await page.getByRole("button", { name: "确认删除 1 个行业" }).click();
    await expect(page.getByText("还没有行业研究条目")).toBeVisible();

    // Capability closes back to a usable Chat and the conversation persists.
    await page.getByRole("button", { name: "关闭 Capability" }).click();
    await expect(page.locator(".capability-pane")).toHaveCount(0);
    await expect(composer).toBeEnabled();
    await closeAppGracefully(first);

    const second = await launchApp(userDataRoot);
    page = second.page;
    await chatReady(page);
    await expect(page.locator(".message.assistant")).toHaveCount(1, { timeout: 30_000 });
    await expect(page.locator(".message.user")).toContainText("第一行");
    await closeAppGracefully(second);
  } finally {
    rmSync(userDataRoot, { recursive: true, force: true });
  }
});

test("research navigation stays visible while only its content scrolls", async () => {
  const userDataRoot = mkdtempSync(join(tmpdir(), "deepfield-navigation-"));
  let running: RunningApp | undefined;
  try {
    running = await launchApp(userDataRoot);
    const { page } = running;
    await page.setViewportSize({ width: 760, height: 420 });
    await expect(page.getByLabel("消息输入")).toBeVisible({ timeout: 15_000 });
    await page.getByRole("button", { name: "研究主题" }).click();

    await page.getByRole("button", { name: "新建主题" }).click();
    const closeBox = await page.getByRole("button", { name: "关闭 Capability" }).boundingBox();
    expect(closeBox).not.toBeNull();
    const coveringElement = await page.evaluate(({ x, y }) => {
      const element = document.elementFromPoint(x, y);
      return element?.closest(".modal-backdrop")?.className ?? null;
    }, { x: closeBox!.x + closeBox!.width / 2, y: closeBox!.y + closeBox!.height / 2 });
    expect(coveringElement).toContain("modal-backdrop");

    const longTopic = "超长研究主题名称".repeat(10);
    const dialog = page.getByRole("dialog", { name: "新建主题" });
    await dialog.getByLabel("主题名称").fill(longTopic);
    await dialog.getByRole("button", { name: "创建", exact: true }).click();
    await expect(page.getByRole("heading", { name: longTopic })).toBeVisible();
    await expect(page.getByRole("button", { name: /返回调研列表/ })).toBeVisible();

    const before = await page.evaluate(() => {
      const pane = document.querySelector<HTMLElement>(".capability-pane")!;
      const header = document.querySelector<HTMLElement>(".capability-header")!;
      const contextual = document.querySelector<HTMLElement>(".capability-contextual-navigation")!;
      const body = document.querySelector<HTMLElement>(".capability-body")!;
      const inner = document.querySelector<HTMLElement>(".capability-body-inner")!;
      const spacer = document.createElement("div");
      spacer.style.height = "1400px";
      spacer.setAttribute("data-layout-spacer", "true");
      inner.append(spacer);
      const breadcrumb = document.querySelector<HTMLElement>(".breadcrumb")!;
      const close = document.querySelector<HTMLElement>(".capability-close")!;
      const paneRect = pane.getBoundingClientRect();
      const breadcrumbRect = breadcrumb.getBoundingClientRect();
      const closeRect = close.getBoundingClientRect();
      return {
        headerTop: header.getBoundingClientRect().top,
        contextualTop: contextual.getBoundingClientRect().top,
        paneScrollHeight: pane.scrollHeight,
        paneClientHeight: pane.clientHeight,
        bodyScrollHeight: body.scrollHeight,
        bodyClientHeight: body.clientHeight,
        breadcrumbRight: breadcrumbRect.right,
        closeLeft: closeRect.left,
        closeRight: closeRect.right,
        paneRight: paneRect.right,
      };
    });
    expect(before.paneScrollHeight).toBe(before.paneClientHeight);
    expect(before.bodyScrollHeight).toBeGreaterThan(before.bodyClientHeight);
    expect(before.breadcrumbRight).toBeLessThanOrEqual(before.closeLeft);
    expect(before.closeRight).toBeLessThanOrEqual(before.paneRight);

    await page.locator(".capability-body").evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    const after = await page.evaluate(() => ({
      headerTop: document.querySelector<HTMLElement>(".capability-header")!.getBoundingClientRect().top,
      contextualTop: document.querySelector<HTMLElement>(".capability-contextual-navigation")!.getBoundingClientRect().top,
      bodyScrollTop: document.querySelector<HTMLElement>(".capability-body")!.scrollTop,
    }));
    expect(after.bodyScrollTop).toBeGreaterThan(0);
    expect(after.headerTop).toBe(before.headerTop);
    expect(after.contextualTop).toBe(before.contextualTop);
    await expect(page.getByRole("button", { name: "关闭 Capability" })).toBeVisible();
    await expect(page.getByRole("button", { name: /返回调研列表/ })).toBeVisible();

  } finally {
    if (running !== undefined) await running.app.close();
    rmSync(userDataRoot, { recursive: true, force: true });
  }
});
