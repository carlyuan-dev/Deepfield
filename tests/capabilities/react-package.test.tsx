// @vitest-environment jsdom
import { mkdtemp, readFile, rm, writeFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import type { CapabilityBridge, CapabilityEvent, CapabilityUiModule } from "@deepfield/capability-sdk";
import type { CapabilityUiBuildOptions } from "../../scripts/capabilities/build-ui.js";
import { CapabilityHost } from "../../apps/desktop/src/renderer/capabilities/CapabilityHost.js";
import { createCapabilityResourceResolver } from "../../apps/desktop/src/main/capabilities/resources.js";

const temporaryRoots: string[] = [];
afterEach(async () => { await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

it("mounts the independently built real research page with the host React and disposes subscriptions/styles", async () => {
  const output = await realpath(await mkdtemp(join(tmpdir(), "capability-react-")));
  temporaryRoots.push(output);
  const buildOptions: CapabilityUiBuildOptions = {
    entry: resolve("apps/desktop/src/renderer/features/industry-research/package-ui.tsx"),
    css: resolve("apps/desktop/src/renderer/capability.css"), capabilityId: "company-research", outDir: join(output, "dist"),
  };
  // Vite/esbuild needs a Node realm, not jsdom's different Uint8Array realm.
  const buildScript = pathToFileURL(resolve("scripts/capabilities/build-ui.ts")).href;
  const result = await promisify(execFile)(process.execPath, ["--input-type=module", "-e", `import {buildCapabilityUi} from ${JSON.stringify(buildScript)}; console.log(JSON.stringify(await buildCapabilityUi(${JSON.stringify(buildOptions)})));`]);
  const modules = JSON.parse(result.stdout) as string[];
  expect(modules.some(id => /node_modules\/(?:react|react-dom|react-markdown)\//.test(id))).toBe(false);
  const resolveResource = await createCapabilityResourceResolver([{ id: "company-research", root: output, state: "ready" }]);
  const script = await resolveResource({ method: "GET", url: "deepfield-capability://company-research/dist/ui.js" });
  expect(script?.mimeType).toBe("text/javascript");
  const code = await readFile(script!.path, "utf8");
  expect(code).not.toContain("react.production");
  const css = await readFile(join(output, "dist/ui.css"), "utf8");
  expect(css).toContain('[data-capability-ui="company-research"]');
  expect(css).not.toMatch(/(?:^|})\s*\.primary-button\s*\{/);
  // Browser entry is ESM; mark the temp fixture likewise for native Node loading.
  await writeFile(join(output, "package.json"), '{"type":"module"}');
  const ui = createRequire(import.meta.url)(script!.path) as CapabilityUiModule;
  expect(typeof ui.createView).toBe("function");
  const subscriptions = new Set<(event: CapabilityEvent) => void>();
  const bridge: CapabilityBridge = {
    async invoke(call) {
      expect(call.capabilityId).toBe("company-research");
      if (call.operation === "industryResearch.listItems" || call.operation === "industryResearch.listCompanies") return [];
      if (call.operation === "industryResearch.createItem") return { id: "topic-1", industry: "离线主题", createdAt: "2026-09-21", updatedAt: "2026-09-21" };
      if (call.operation === "companyResearchBatch.getState" || call.operation === "industryResearch.getCompanyProfileProgress") return null;
      throw new Error(`Unexpected offline operation: ${call.operation}`);
    },
    subscribe(listener) { subscriptions.add(listener); return () => { subscriptions.delete(listener); }; },
  };
  const { unmount } = render(<CapabilityHost capabilityId="company-research" module={ui} cssUrls={["deepfield-capability://company-research/dist/ui.css"]} bridge={bridge} onClose={() => {}} onOpenSettings={() => {}} />);
  expect(await screen.findByText("研究主题")).toBeTruthy();
  await screen.findByText("还没有研究主题");
  fireEvent.click(screen.getByRole("button", { name: "新建主题" }));
  fireEvent.change(screen.getByLabelText("主题名称"), { target: { value: "离线主题" } });
  fireEvent.click(screen.getByRole("button", { name: "创建" }));
  await screen.findByText("暂无公司，可手动添加或从文本识别。");
  for (const name of ["添加公司", "一键导入公司", "批量调研公司"]) {
    fireEvent.click(screen.getByRole("button", { name }));
    expect(screen.getByRole("dialog", { name })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: `关闭${name}` }));
  }
  expect(subscriptions.size).toBeGreaterThan(0);
  await waitFor(() => expect(document.querySelectorAll('link[data-capability-style="company-research"]')).toHaveLength(1));
  unmount();
  expect(subscriptions.size).toBe(0);
  expect(document.querySelectorAll('link[data-capability-style="company-research"]')).toHaveLength(0);
}, 30_000);
