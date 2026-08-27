import { describe, expect, it } from "vitest";
import ipaddr from "ipaddr.js";
import { UrlPolicy, isPublicAddress, type DnsAnswer } from "./url-policy.js";

describe("ipaddr.js 2.2.0 dependency compat", () => {
  it("imports as a Node ESM default and classifies addresses (gate A2)", () => {
    expect(typeof ipaddr.parse).toBe("function");
    expect(ipaddr.parse("127.0.0.1").range()).toBe("loopback");
    expect(ipaddr.parse("93.184.216.34").range()).toBe("unicast");
    expect(ipaddr.parse("::ffff:127.0.0.1").kind()).toBe("ipv6");
  });

  it("integrates with the retrieval package end to end", async () => {
    expect(isPublicAddress("93.184.216.34")).toBe(true);
    expect(isPublicAddress("127.0.0.1")).toBe(false);
    const policy = new UrlPolicy({
      lookup: async (): Promise<readonly DnsAnswer[]> => [{ address: "93.184.216.34", family: 4 }],
    });
    const result = await policy.check("https://example.com/x");
    expect(result.ok).toBe(true);
  });
});
