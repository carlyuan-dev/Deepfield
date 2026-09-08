import { _electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const E2E_KEY = "sk-e2e-dummy-not-real-987654321";
const SCREENSHOT_CHAT = "/private/tmp/deepfield-p3ux2-chat.png";
const SCREENSHOT_SPLIT = "/private/tmp/deepfield-p3ux2-split.png";
const SCREENSHOT_SETTINGS = "/private/tmp/deepfield-p3ux2-settings.png";

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

async function enterDummyKey(page: Page): Promise<void> {
  await page.getByRole("button", { name: "设置" }).click();
  const keyInput = page.getByLabel("API Key");
  await expect(keyInput).toBeVisible();
  await keyInput.fill(E2E_KEY);
  await page.getByRole("button", { name: "保存" }).click();
  await expect(page.getByText("已配置")).toBeVisible({ timeout: 10_000 });
  await page.getByRole("button", { name: "‹ 返回" }).click();
  await expect(page.getByLabel("DeepSeek 连接状态：未连接")).toBeVisible();
}

async function closeAppGracefully(running: RunningApp): Promise<void> {
  const closed = running.app.waitForEvent("close");
  await running.app.evaluate(({ app }) => app.quit());
  await closed;
}

async function chatReady(page: Page): Promise<void> {
  await expect(page.getByLabel("消息输入")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(/请先创建或选择一个项目/)).toHaveCount(0);
  await expect(page.getByLabel("DeepSeek 连接状态：未连接")).toBeVisible();
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

    // 2) Fake Agent handles three turns without network; the Conversation is selected.
    const composer = page.getByLabel("消息输入");
    for (const [index, question] of ["你好", "第二轮", "第三轮"].entries()) {
      await composer.fill(question);
      await page.getByRole("button", { name: "发送" }).click();
      await expect(page.locator(".message.assistant")).toHaveCount(index + 1, {
        timeout: 30_000,
      });
      await expect(composer).toBeEnabled();
    }
    await expect(page.getByRole("button", { name: "你好" })).toBeVisible();
    await expect(page.locator(".message")).toHaveCount(6);
    await expect(page.locator(".chat-pane-title")).toHaveText("你好");
    const assistantContent = page.locator(".message.assistant .assistant-content").first();
    await expect(assistantContent).toBeVisible();
    const assistantStyles = await assistantContent.evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        backgroundColor: style.backgroundColor,
        borderWidth: style.borderWidth,
        borderStyle: style.borderStyle,
        borderRadius: style.borderRadius,
        boxShadow: style.boxShadow,
      };
    });
    expect(assistantStyles.backgroundColor).toBe("rgba(0, 0, 0, 0)");
    expect(assistantStyles.borderWidth).toBe("0px");
    expect(assistantStyles.borderStyle).toBe("none");
    expect(assistantStyles.borderRadius).toBe("0px");
    expect(assistantStyles.boxShadow).toBe("none");
    const assistantBox = await assistantContent.boundingBox();
    const composerBox = await page.locator(".composer").boundingBox();
    expect(assistantBox).not.toBeNull();
    expect(composerBox).not.toBeNull();
    expect(Math.abs(assistantBox!.width - composerBox!.width)).toBeLessThanOrEqual(1);
    const chatHeaderHeight = (await page.locator(".chat-pane-header").boundingBox())!.height;
    await page.screenshot({ path: SCREENSHOT_CHAT });

    // 3) direct Industry Research opens the Capability and collapses Chat to a
    //    narrow rail whose expand arrow sits left of the Capability pane
    await page.getByRole("button", { name: "行业研究" }).click();
    const heading = page.getByRole("heading", { name: "行业研究", exact: true });
    await expect(heading).toBeVisible();
    const expandArrow = page.getByRole("button", { name: "展开 Chat" });
    await expect(expandArrow).toBeVisible();
    await expect(page.locator(".workspace-panes")).toHaveClass(/collapsed/);
    const arrowBox = (await expandArrow.boundingBox())!;
    const capabilityBox = (await heading.boundingBox())!;
    expect(arrowBox.x).toBeLessThan(capabilityBox.x);

    // Settings is a sidebar mode and must not discard the split state.
    await page.getByRole("button", { name: "设置" }).click();
    await expect(page.getByRole("navigation", { name: "设置导航" })).toBeVisible();
    await expect(page.getByRole("button", { name: "‹ 返回" })).toBeVisible();
    await expect(page.getByText("设置")).toBeVisible();
    await expect(page.getByRole("button", { name: "模型与密钥" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    await expect(page.getByRole("heading", { name: "模型与密钥" })).toBeVisible();
    await page.screenshot({ path: SCREENSHOT_SETTINGS });

    await page.getByRole("button", { name: "‹ 返回" }).click();
    await expect(page.getByRole("navigation", { name: "主导航" })).toBeVisible();
    await expect(heading).toBeVisible();
    await expect(page.locator(".workspace-panes")).toHaveClass(/collapsed/);
    await expect(page.locator(".chat-pane-header")).toHaveClass(/collapsed/);

    // 4) the arrow expands Chat beside the still-mounted Capability
    await expandArrow.click();
    await expect(page.getByRole("button", { name: "收起 Chat" })).toBeVisible();
    await expect(page.locator(".workspace-panes")).toHaveClass(/expanded/);
    await expect(heading).toBeVisible();
    const splitHeaderHeight = (await page.locator(".chat-pane-header").boundingBox())!.height;
    expect(Math.abs(splitHeaderHeight - chatHeaderHeight)).toBeLessThanOrEqual(1);
    const collapseBox = (await page.getByRole("button", { name: "收起 Chat" }).boundingBox())!;
    const capabilityBoxAfter = (await heading.boundingBox())!;
    expect(collapseBox.x).toBeLessThan(capabilityBoxAfter.x);
    await page.screenshot({ path: SCREENSHOT_SPLIT });

    // 5) the generic Capability close returns to chat-only.
    await page.getByRole("button", { name: "关闭 Capability" }).click();
    await expect(page.locator(".capability-pane")).toHaveCount(0);
    await expect(page.locator(".chat-pane")).toHaveClass(/expanded/);

    await closeAppGracefully(first);

    // ---------- Run 2: same user data root ----------
    const second = await launchApp(userDataRoot);
    page = second.page;

    // 6) restart restores the Conversation with history, selection, and bottom position
    await expect(page.locator(".message.assistant")).toHaveCount(3, { timeout: 30_000 });
    await expect(page.getByRole("button", { name: "你好" })).toBeVisible();
    await expect(page.getByRole("button", { name: "你好" })).toHaveAttribute("aria-current", "page");
    await chatReady(page);
    const atBottom = await page.locator(".messages").evaluate((element) => {
      const messages = element as HTMLElement;
      return messages.scrollTop + messages.clientHeight >= messages.scrollHeight - 1;
    });
    expect(atBottom).toBe(true);

    await closeAppGracefully(second);
  } finally {
    rmSync(userDataRoot, { recursive: true, force: true });
  }
});
