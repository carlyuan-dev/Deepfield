import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createCapabilityResourceHandler } from "./resource-handler.js";

it("serves controlled JS with MIME/CORS and revokes access on every request", async () => {
  const root = await mkdtemp(join(tmpdir(), "capability-handler-"));
  try {
    await mkdir(join(root, "dist")); await writeFile(join(root, "dist/ui.js"), "export const ready=true;");
    let ready = true;
    const handler = createCapabilityResourceHandler(() => ready ? [{ id: "example", root, state: "ready" }] : []);
    const request = { method: "GET", url: "deepfield-capability://example/dist/ui.js" };
    const response = await handler(request);
    expect(response.status).toBe(200); expect(response.headers.get("Content-Type")).toBe("text/javascript");
    expect(response.headers.get("Cache-Control")).toBe("no-store"); expect(await response.text()).toBe("export const ready=true;");
    ready = false; expect((await handler(request)).status).toBe(404);
    ready = true; expect((await handler({ ...request, method: "POST" })).status).toBe(404);
    expect((await handler({ ...request, url: "deepfield-capability://example/../private.js" })).status).toBe(404);
  } finally { await rm(root, { recursive: true, force: true }); }
});
