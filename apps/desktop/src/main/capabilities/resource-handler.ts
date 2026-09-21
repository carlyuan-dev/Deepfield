import { readFile } from "node:fs/promises";
import { createCapabilityResourceResolver, type CapabilityResourcePackage } from "./resources.js";

/** Readiness is consulted for every request and again after asynchronous file reads. */
export function createCapabilityResourceHandler(ready: () => readonly CapabilityResourcePackage[]) {
  return async (request: { method: string; url: string }): Promise<Response> => {
    try {
      const snapshot = ready();
      const resolve = await createCapabilityResourceResolver(snapshot);
      const resource = await resolve(request);
      if (!resource) return new Response(null, { status: 404 });
      const bytes = await readFile(resource.path);
      const live = await createCapabilityResourceResolver(ready());
      if ((await live(request))?.path !== resource.path) return new Response(null, { status: 404 });
      return new Response(bytes, { headers: { "Content-Type": resource.mimeType, "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*", "X-Content-Type-Options": "nosniff" } });
    } catch { return new Response(null, { status: 404 }); }
  };
}
