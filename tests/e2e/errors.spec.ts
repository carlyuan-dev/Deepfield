import { _electron, expect, test, type ElectronApplication } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

test("public error DTOs survive the real Electron contextBridge without Error properties", async () => {
  const root = mkdtempSync(join(tmpdir(), "deepfield-errors-"));
  let app: ElectronApplication | undefined;
  try {
    app = await _electron.launch({ args: ["out/main/index.js"], env: { ...process.env, DEEPFIELD_AGENT_MODE: "fake", DEEPFIELD_E2E: "1", DEEPFIELD_USER_DATA_DIR: root } });
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    const result = await page.evaluate(async () => {
      const api = window.deepfield;
      const invalid = await api.companyResearch.start("i", "c", {} as never).catch((error: unknown) => error);
      const missing = await api.companyResearch.start("missing", "missing", { direction: "product_and_technology", asOfDate: "2026-09-01" }).catch((error: unknown) => error);
      const diagnostic = await api.settings.diagnoseLlm({ name: "Test", provider: "custom", protocol: "openai_compatible", baseUrl: "https://never-contact.invalid", modelId: "test", contextWindow: 32000 });
      return { invalid, missing, diagnostic, isError: invalid instanceof Error };
    });
    expect(result.invalid).toEqual({ code: "INPUT.INVALID", category: "input" });
    expect(result.missing).toEqual({ code: "RESOURCE.NOT_FOUND", category: "resource" });
    expect(result.isError).toBe(false);
    expect(result.diagnostic).toMatchObject({ ok: false, error: { code: "CONFIG.CREDENTIAL_MISSING", category: "configuration", context: { service: "llm" } } });
  } finally {
    try {
      if (app) {
        const closed = app.waitForEvent("close");
        await app.evaluate(({ app }) => app.quit());
        await closed;
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});
