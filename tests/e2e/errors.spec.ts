import { expect, test, type ElectronApplication } from "@playwright/test";
import { cleanupElectronUserData, createElectronUserData, launchElectronE2E } from "./electron-launch.js";

test("public error DTOs survive the real Electron contextBridge without Error properties", async () => {
  const root = createElectronUserData();
  let app: ElectronApplication | undefined;
  try {
    const running = await launchElectronE2E({ userDataDir: root });
    app = running.app;
    const page = running.page;
    const result = await page.evaluate(async () => {
      const api = window.deepfield;
      const invalid = await api.capabilities.invoke({ capabilityId: "company-research", operation: "companyResearch.start", requestId: "invalid", input: ["i", "c", {}] }).catch((error: unknown) => error);
      const missing = await api.capabilities.invoke({ capabilityId: "company-research", operation: "companyResearch.start", requestId: "missing", input: ["missing", "missing", { moduleIds: ["products_and_positioning", "technology_and_metrics"], asOfDate: "2026-09-01" }] }).catch((error: unknown) => error);
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
      cleanupElectronUserData(root);
    }
  }
});
