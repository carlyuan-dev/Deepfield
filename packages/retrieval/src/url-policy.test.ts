import { describe, expect, it } from "vitest";
import { UrlPolicy, isPublicAddress, type DnsAnswer, type DnsLookup } from "./url-policy.js";

function fakeLookup(answers: Record<string, readonly DnsAnswer[]>): DnsLookup {
  return async (hostname) => answers[hostname] ?? [];
}

const PUBLIC_V4: DnsAnswer = { address: "93.184.216.34", family: 4 };
const PRIVATE_V4: DnsAnswer = { address: "10.0.0.5", family: 4 };
const PUBLIC_V6: DnsAnswer = { address: "2606:4700::1111", family: 6 };

const lookup = fakeLookup({
  "example.com": [PUBLIC_V4, PUBLIC_V6],
  "mixed.example": [PUBLIC_V4, PRIVATE_V4],
  "private.example": [PRIVATE_V4],
  "nowhere.example": [],
});

async function code(input: string, policy: UrlPolicy): Promise<string | null> {
  const result = await policy.check(input);
  return result.ok ? null : result.code;
}

describe("url policy", () => {
  it("classifies public vs non-public addresses", () => {
    expect(isPublicAddress("93.184.216.34")).toBe(true);
    expect(isPublicAddress("2606:4700::1111")).toBe(true);
    expect(isPublicAddress("127.0.0.1")).toBe(false);
    expect(isPublicAddress("10.0.0.1")).toBe(false);
    expect(isPublicAddress("169.254.169.254")).toBe(false);
    expect(isPublicAddress("100.64.0.1")).toBe(false);
    expect(isPublicAddress("198.18.0.1")).toBe(false);
    expect(isPublicAddress("192.0.2.1")).toBe(false);
    expect(isPublicAddress("224.0.0.1")).toBe(false);
    expect(isPublicAddress("240.0.0.1")).toBe(false);
    expect(isPublicAddress("255.255.255.255")).toBe(false);
    expect(isPublicAddress("0.0.0.0")).toBe(false);
    expect(isPublicAddress("::1")).toBe(false);
    expect(isPublicAddress("fe80::1")).toBe(false);
    expect(isPublicAddress("fc00::1")).toBe(false);
    expect(isPublicAddress("ff02::1")).toBe(false);
    expect(isPublicAddress("2001:db8::1")).toBe(false);
    expect(isPublicAddress("::ffff:127.0.0.1")).toBe(false);
    expect(isPublicAddress("::ffff:10.0.0.1")).toBe(false);
    expect(isPublicAddress("::ffff:169.254.169.254")).toBe(false);
    expect(isPublicAddress("64:ff9b::1")).toBe(false);
    expect(isPublicAddress("garbage-not-an-ip")).toBe(false);
  });

  it("accepts public http/https with default or explicit allowed ports only", async () => {
    const policy = new UrlPolicy({ lookup });
    const result = await policy.check("http://example.com/a?b=c");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.target.protocol).toBe("http:");
      expect(result.target.port).toBe(80);
      expect(result.target.path).toBe("/a?b=c");
      expect(result.target.addresses).toEqual([PUBLIC_V4, PUBLIC_V6]);
    }
    const explicit = await policy.check("https://example.com:443/");
    expect(explicit.ok).toBe(true);
    if (explicit.ok) {
      expect(explicit.target.port).toBe(443);
    }
  });

  it("rejects wrong schemes, ports, userinfo and empty/invalid hosts", async () => {
    const policy = new UrlPolicy({ lookup });
    expect(await code("file:///etc/passwd", policy)).toBe("url_blocked");
    expect(await code("ftp://example.com/", policy)).toBe("url_blocked");
    expect(await code("ws://example.com/", policy)).toBe("url_blocked");
    expect(await code("data:text/html,x", policy)).toBe("url_blocked");
    expect(await code("http://example.com:8080/", policy)).toBe("url_blocked");
    expect(await code("http://example.com:443/", policy)).toBe("url_blocked");
    expect(await code("https://example.com:80/", policy)).toBe("url_blocked");
    expect(await code("http://user:pass@example.com/", policy)).toBe("url_blocked");
    expect(await code("http://user@example.com/", policy)).toBe("url_blocked");
    expect(await code("http://", policy)).toBe("url_blocked");
    expect(await code("not a url", policy)).toBe("url_blocked");
  });

  it("rejects literal private/loopback/metadata IPs in URLs", async () => {
    const policy = new UrlPolicy({ lookup });
    expect(await code("http://127.0.0.1/", policy)).toBe("url_blocked");
    expect(await code("http://10.1.2.3/", policy)).toBe("url_blocked");
    expect(await code("http://169.254.169.254/latest/meta-data/", policy)).toBe("url_blocked");
    expect(await code("http://192.168.1.1/", policy)).toBe("url_blocked");
    expect(await code("http://[::1]/", policy)).toBe("url_blocked");
    expect(await code("http://[fe80::1]/", policy)).toBe("url_blocked");
    expect(await code("http://[fc00::1]/", policy)).toBe("url_blocked");
    expect(await code("http://[::ffff:10.0.0.1]/", policy)).toBe("url_blocked");
    // a literal public IPv6 address needs no DNS and is allowed
    expect(await code("https://[2606:4700::1111]/", policy)).toBe(null);
  });

  it("blocks normalized decimal/hex/octal/short IPv4 forms after URL normalization", async () => {
    const policy = new UrlPolicy({ lookup });
    expect(await code("http://2130706433/", policy)).toBe("url_blocked"); // 127.0.0.1
    expect(await code("http://127.1/", policy)).toBe("url_blocked");
    expect(await code("http://0x7f000001/", policy)).toBe("url_blocked");
    expect(await code("http://0177.0.0.1/", policy)).toBe("url_blocked");
  });

  it("rejects localhost-family hostnames without touching the network", async () => {
    const policy = new UrlPolicy({ lookup });
    expect(await code("http://localhost/", policy)).toBe("url_blocked");
    expect(await code("http://localhost.localdomain/", policy)).toBe("url_blocked");
    expect(await code("http://foo.localhost/", policy)).toBe("url_blocked");
    expect(await code("http://printer.local/", policy)).toBe("url_blocked");
  });

  it("rejects when any DNS answer is forbidden (mixed results included)", async () => {
    const policy = new UrlPolicy({ lookup });
    expect(await code("http://mixed.example/", policy)).toBe("url_blocked");
    expect(await code("http://private.example/", policy)).toBe("url_blocked");
  });

  it("fails safely when DNS has no results", async () => {
    const policy = new UrlPolicy({ lookup });
    expect(await code("http://nowhere.example/", policy)).toBe("network_unavailable");
  });

  it("fails safely on malformed DNS answers", async () => {
    const bad: DnsLookup = async () => [{ address: "not-an-ip", family: 4 }];
    const policy = new UrlPolicy({ lookup: bad });
    expect(await code("http://example.com/", policy)).toBe("network_unavailable");
    const badFamily: DnsLookup = async () => [{ address: "93.184.216.34", family: 9 as never }];
    const policy2 = new UrlPolicy({ lookup: badFamily });
    expect(await code("http://example.com/", policy2)).toBe("network_unavailable");
  });

  it("uses the injected lookup and never falls back to a second resolution", async () => {
    let calls = 0;
    const counting: DnsLookup = async (hostname) => {
      calls += 1;
      return hostname === "example.com" ? [PUBLIC_V4] : [];
    };
    const policy = new UrlPolicy({ lookup: counting });
    const result = await policy.check("http://example.com/x");
    expect(result.ok).toBe(true);
    expect(calls).toBe(1);
    if (result.ok) {
      expect(result.target.addresses).toEqual([PUBLIC_V4]);
    }
  });

  it("returns a frozen defensive copy of the validated addresses", async () => {
    const mutable: DnsAnswer[] = [{ address: "93.184.216.34", family: 4 }];
    const policy = new UrlPolicy({ lookup: async () => mutable });
    const result = await policy.check("http://example.com/");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(Object.isFrozen(result.target.addresses)).toBe(true);
      expect(Object.isFrozen(result.target.addresses[0])).toBe(true);
      mutable[0] = { address: "10.0.0.1", family: 4 }; // mutate the source
      expect(result.target.addresses[0]!.address).toBe("93.184.216.34");
    }
  });
});
