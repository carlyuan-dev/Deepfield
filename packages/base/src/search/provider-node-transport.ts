import http from "node:http";
import https from "node:https";
import { SearchProviderError } from "./search-provider.js";
import type { ProviderEndpoint, ProviderTransport, ProviderTransportRequest, ProviderTransportResponse } from "./provider-http-client.js";

/** Default transport: node:http/https against the bound endpoint. */
export function createNodeProviderTransport(): ProviderTransport {
  return {
    async request(endpoint: ProviderEndpoint, request: ProviderTransportRequest): Promise<ProviderTransportResponse> {
      const mod = endpoint.origin.startsWith("https:") ? https : http;
      return new Promise<ProviderTransportResponse>((resolve, reject) => {
        const outgoing = mod.request(
          endpoint.origin + request.path,
          {
            method: request.method,
            headers: request.headers,
            signal: request.signal,
          },
          (response) => {
            const headers: Record<string, string | string[] | undefined> = {};
            for (const [name, value] of Object.entries(response.headers)) {
              headers[name] = value as string | string[] | undefined;
            }
            resolve({
              statusCode: response.statusCode ?? 0,
              headers,
              body: response,
              destroy: () => response.destroy(),
            });
          },
        );
        outgoing.on("error", () => reject(new SearchProviderError("network_unavailable")));
        if (request.body !== undefined) {
          outgoing.write(request.body);
        }
        outgoing.end();
      });
    },
  };
}
