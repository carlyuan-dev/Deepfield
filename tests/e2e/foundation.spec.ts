import { _electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const E2E_KEY = "sk-e2e-dummy-not-real-987654321";
const SCREENSHOT_CHAT = "/private/tmp/deepfield-p3t8-chat.png";
const SCREENSHOT_SPLIT = "/private/tmp/deepfield-p3t8-split.png";

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
  await expect(page.getByText("Deepfield").first()).toBeVisible({ timeout: 30_000 });
  return { app, page };
}

async function closeAppGracefully(running: RunningApp): Promise<void> {
  const closed = running.app.waitForEvent("close");
  await running.app.evaluate(({ app }) => app.quit());
  await closed;
}

async function enterDummyKey(page: Page): Promise<void> {
  await page.getByRole("button", { name: "设置" }).click();
  const keyInput = page.getByLabel("API Key");
  await expect(keyInput).toBeVisible();
  await keyInput.fill(E2E_KEY);
  await page.getByRole("button", { name: "保存" }).click();
  await expect(page.getByText("已配置")).toBeVisible({ timeout: 10_000 });
  await page.getByRole("button", { name: "返回" }).click();
}

async function chatReady(page: Page): Promise<void> {
  await expect(page.getByLabel("消息输入")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(/请先创建或选择一个项目/)).toHaveCount(0);
}

test("agent-first chat shell main path survives a restart", async () => {
  const userDataRoot = mkdtempSync(join(tmpdir(), "deepfield-p3t8-"));
  try {
    // ---------- Run 1: first launch ----------
    const first = await launchApp(userDataRoot);
    let page = first.page;

    // 1) opens directly into Chat, no Project or Capability needed
    await chatReady(page);
    await enterDummyKey(page);

    // 2) Fake Agent first message succeeds and the deterministic title joins 对话
    const composer = page.getByLabel("消息输入");
    await composer.fill("你好");
    await page.getByRole("button", { name: "发送" }).click();
    await expect(page.getByText("测试回复")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("button", { name: "你好" })).toBeVisible();
    await page.screenshot({ path: SCREENSHOT_CHAT });

    // 3) direct Industry Research opens the Capability and collapses Chat to a
    //    narrow rail whose expand arrow sits left of the Capability pane
    await page.getByRole("button", { name: "行业研究" }).click();
    const heading = page.getByRole("heading", { name: "行业研究", exact: true });
    await expect(heading).toBeVisible();
    const expandArrow = page.getByRole("button", { name: "展开 Chat" });
    await expect(expandArrow).toBeVisible();
    const arrowBox = (await expandArrow.boundingBox())!;
    const capabilityBox = (await heading.boundingBox())!;
    expect(arrowBox.x).toBeLessThan(capabilityBox.x);

    // 4) the arrow expands Chat beside the still-mounted Capability
    await expandArrow.click();
    await expect(page.getByRole("button", { name: "收起 Chat" })).toBeVisible();
    await expect(heading).toBeVisible();
    const collapseBox = (await page.getByRole("button", { name: "收起 Chat" }).boundingBox())!;
    const capabilityBoxAfter = (await heading.boundingBox())!;
    expect(collapseBox.x).toBeLessThan(capabilityBoxAfter.x);
    await page.screenshot({ path: SCREENSHOT_SPLIT });

    await closeAppGracefully(first);

    // ---------- Run 2: same user data root ----------
    const second = await launchApp(userDataRoot);
    page = second.page;

    // 5) restart restores the Conversation with history and its sidebar title
    await expect(page.getByText("测试回复")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("button", { name: "你好" })).toBeVisible();
    await chatReady(page);

    await closeAppGracefully(second);
  } finally {
    rmSync(userDataRoot, { recursive: true, force: true });
  }
});
