import { _electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const E2E_KEY = "sk-e2e-dummy-not-real-987654321";
const SCREENSHOTS = {
  direct: "/private/tmp/deepfield-p1t8-direct.png",
  chat: "/private/tmp/deepfield-p1t8-chat.png",
  rail: "/private/tmp/deepfield-p1t8-rail.png",
};

interface RunningApp {
  app: ElectronApplication;
  page: Page;
}

async function launchApp(userDataRoot: string): Promise<RunningApp> {
  const app = await _electron.launch({
    args: ["out/main/index.js"],
    env: {
      ...process.env,
      DEEPFIELD_AGENT_MODE: "fake",
      DEEPFIELD_E2E: "1",
      DEEPFIELD_USER_DATA_DIR: userDataRoot,
    },
  });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await expect(page.getByText("Deepfield")).toBeVisible({ timeout: 30_000 });
  return { app, page };
}

async function closeAppGracefully(running: RunningApp): Promise<void> {
  const closed = running.app.waitForEvent("close");
  await running.app.evaluate(({ app }) => app.quit());
  await closed;
}

async function assertNoHorizontalOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);
}

interface ShellMetrics {
  bodyScrollTop: number;
  htmlScrollHeight: number;
  htmlClientHeight: number;
  workspaceScrollTop: number;
  workspaceScrollHeight: number;
  workspaceClientHeight: number;
  sidebarScrollTop: number;
  brand: { top: number; bottom: number; left: number; right: number } | null;
  context: { top: number; bottom: number; left: number; right: number } | null;
  viewportWidth: number;
  viewportHeight: number;
}

async function readShellMetrics(page: Page): Promise<ShellMetrics> {
  return page.evaluate(() => {
    const rect = (el: Element | null) => {
      if (!el) {
        return null;
      }
      const r = el.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom, left: r.left, right: r.right };
    };
    const workspace = document.querySelector("main.workspace");
    const sidebar = document.querySelector(".sidebar");
    return {
      bodyScrollTop: document.scrollingElement?.scrollTop ?? 0,
      htmlScrollHeight: document.documentElement.scrollHeight,
      htmlClientHeight: document.documentElement.clientHeight,
      workspaceScrollTop: workspace?.scrollTop ?? -1,
      workspaceScrollHeight: workspace?.scrollHeight ?? -1,
      workspaceClientHeight: workspace?.clientHeight ?? -1,
      sidebarScrollTop: sidebar?.scrollTop ?? -1,
      brand: rect(document.querySelector(".sidebar .brand")),
      context: rect(document.querySelector(".chat-context")),
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
    };
  });
}

// The shell must never scroll: message growth happens inside .messages only.
async function assertChatShellStable(page: Page): Promise<void> {
  const metrics = await readShellMetrics(page);
  expect(metrics, JSON.stringify(metrics)).toMatchObject({
    bodyScrollTop: 0,
    workspaceScrollTop: 0,
    sidebarScrollTop: 0,
  });
  expect(metrics.htmlScrollHeight - metrics.htmlClientHeight).toBeLessThanOrEqual(1);
  expect(metrics.workspaceScrollHeight - metrics.workspaceClientHeight).toBeLessThanOrEqual(1);
  expect(metrics.brand?.top).toBeGreaterThanOrEqual(0);
  expect(metrics.brand?.bottom).toBeLessThanOrEqual(metrics.viewportHeight);
  expect(metrics.context?.top).toBeGreaterThanOrEqual(0);
  expect(metrics.context?.bottom).toBeLessThanOrEqual(metrics.viewportHeight);
}

test("foundation vertical slice survives a restart", async () => {
  const userDataRoot = mkdtempSync(join(tmpdir(), "deepfield-e2e-"));
  try {
    // ---------- Run 1: first launch ----------
    const first = await launchApp(userDataRoot);
    let page = first.page;

    // 2) settings: enter a test-only dummy key, save, see 已配置, no echo
    await page.getByRole("button", { name: "设置" }).click();
    const keyInput = page.getByLabel("API Key");
    await expect(keyInput).toBeVisible();
    await keyInput.fill(E2E_KEY);
    await page.getByRole("button", { name: "保存" }).click();
    await expect(page.getByText("已配置")).toBeVisible({ timeout: 10_000 });
    await expect(keyInput).toHaveValue("");
    expect(await page.content()).not.toContain(E2E_KEY);
    await page.getByRole("button", { name: "返回" }).click();

    // 3/4) direct capability: create 人形机器人, verify canvas + no rail
    await page.getByRole("button", { name: "行业研究" }).click();
    await expect(page.getByRole("heading", { name: "行业研究", exact: true })).toBeVisible();
    await page.getByLabel("行业", { exact: true }).fill("人形机器人");
    await page.getByRole("button", { name: "创建项目" }).click();
    await expect(page.getByText("状态：项目已创建")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(/研究工作流将在下一阶段接入/)).toBeVisible();
    await expect(page.locator("aside")).toHaveCount(0);
    await assertNoHorizontalOverflow(page);
    await page.screenshot({ path: SCREENSHOTS.direct });

    // 5) open project chat, send 你好, expect the fake stream 测试回复
    await page.getByRole("button", { name: "打开项目 Chat" }).click();
    const composer = page.getByLabel("消息输入");
    await expect(composer).toBeVisible();
    await composer.fill("你好");
    await page.getByRole("button", { name: "发送" }).click();
    await expect(page.getByText("测试回复")).toBeVisible({ timeout: 30_000 });
    await expect(page.locator(".message", { hasText: "你好" })).toHaveCount(1);
    await assertChatShellStable(page);
    await assertNoHorizontalOverflow(page);
    await page.screenshot({ path: SCREENSHOTS.chat });

    // 6) close gracefully (before-quit runs; main + utility exit)
    await closeAppGracefully(first);

    // ---------- Run 2: same user data root ----------
    const second = await launchApp(userDataRoot);
    page = second.page;

    // 8) settings still configured without echoing the key
    await page.getByRole("button", { name: "设置" }).click();
    await expect(page.getByText("已配置")).toBeVisible();
    expect(await page.content()).not.toContain(E2E_KEY);
    await page.getByRole("button", { name: "返回" }).click();

    // project + chat history persisted, no duplicate messages
    await page.getByRole("button", { name: "人形机器人" }).click();
    await page.getByRole("button", { name: "打开项目 Chat" }).click();
    await expect(page.getByText("测试回复")).toBeVisible({ timeout: 30_000 });
    await expect(page.locator(".message", { hasText: "你好" })).toHaveCount(1);
    await expect(page.locator(".message", { hasText: "测试回复" })).toHaveCount(1);

    // 9) 新对话 clears to the empty state, then research mode opens the rail
    await page.getByRole("button", { name: "新对话" }).click();
    await expect(page.getByText(/请先创建或选择一个项目/)).toBeVisible();
    await page.getByLabel("模式").selectOption("research");
    await expect(page.getByRole("heading", { name: "行业研究", exact: true })).toBeVisible();
    const rail = page.locator("aside.chat-rail");
    await expect(rail).toBeVisible();
    expect((await rail.boundingBox())?.width).toBeGreaterThan(350);
    await assertNoHorizontalOverflow(page);
    await page.screenshot({ path: SCREENSHOTS.rail });

    // 10) collapse / expand the rail
    await page.getByRole("button", { name: "收起 Chat 侧栏" }).click();
    expect((await rail.boundingBox())?.width).toBeLessThan(60);
    await page.getByRole("button", { name: "展开 Chat 侧栏" }).click();
    expect((await rail.boundingBox())?.width).toBeGreaterThan(350);

    await closeAppGracefully(second);
  } finally {
    rmSync(userDataRoot, { recursive: true, force: true });
  }
});
