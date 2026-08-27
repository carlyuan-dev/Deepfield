import { promises as dnsPromises } from "node:dns";
import ipaddr from "ipaddr.js";

export type PolicyFailureCode = "url_blocked" | "network_unavailable";

export interface DnsAnswer {
  address: string;
  family: 4 | 6;
}

export interface DnsLookup {
  (hostname: string): Promise<readonly DnsAnswer[]>;
}

export interface CheckedTarget {
  /** Normalized, userinfo-free href used for the request. */
  href: string;
  protocol: "http:" | "https:";
  hostname: string;
  port: number;
  path: string;
  /** Every address the connection may use; all already validated as public. */
  addresses: readonly DnsAnswer[];
}

export type UrlCheckResult =
  | { ok: true; target: CheckedTarget }
  | { ok: false; code: PolicyFailureCode };

const LOCALHOST_NAMES = new Set(["localhost", "localhost.localdomain"]);
const HOSTNAME_RE = /^[a-z0-9-]+(\.[a-z0-9-]+)*$/i;

async function defaultLookup(hostname: string): Promise<readonly DnsAnswer[]> {
  try {
    const records = await dnsPromises.lookup(hostname, { all: true });
    return records.map((record) => ({
      address: record.address,
      family: record.family === 6 ? 6 : 4,
    }));
  } catch {
    return [];
  }
}

/**
 * Public-address classifier. Only plain public unicast is allowed; everything
 * else (loopback, private, link-local, CGNAT, reserved, multicast, broadcast,
 * unspecified, documentation, NAT64/6to4 transition prefixes, IPv4-mapped
 * private addresses...) is rejected.
 */
export function isPublicAddress(address: string): boolean {
  let parsed: ipaddr.IPv4 | ipaddr.IPv6;
  try {
    parsed = ipaddr.parse(address);
  } catch {
    return false;
  }
  if (parsed.kind() === "ipv6" && parsed.range() === "ipv4Mapped") {
    parsed = (parsed as ipaddr.IPv6).toIPv4Address();
  }
  return parsed.range() === "unicast";
}

/**
 * Anti-DNS-rebinding policy: it validates the URL and resolves the hostname
 * through one injected lookup, then hands back the exact checked addresses.
 * The transport must pin the socket to those addresses (never a second DNS
 * resolution) and must re-run the whole policy on every redirect.
 */
export class UrlPolicy {
  readonly #lookup: DnsLookup;

  constructor(options: { lookup?: DnsLookup } = {}) {
    this.#lookup = options.lookup ?? defaultLookup;
  }

  async check(input: string): Promise<UrlCheckResult> {
    let url: URL;
    try {
      url = new URL(input);
    } catch {
      return { ok: false, code: "url_blocked" };
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return { ok: false, code: "url_blocked" };
    }
    if (url.username !== "" || url.password !== "") {
      return { ok: false, code: "url_blocked" };
    }
    const port = url.port === "" ? (url.protocol === "http:" ? 80 : 443) : Number(url.port);
    if (url.protocol === "http:" ? port !== 80 : port !== 443) {
      return { ok: false, code: "url_blocked" };
    }
    const rawHost = url.hostname;
    if (rawHost.length === 0) {
      return { ok: false, code: "url_blocked" };
    }
    const hostname = rawHost.startsWith("[") && rawHost.endsWith("]") ? rawHost.slice(1, -1) : rawHost;
    if (hostname.length === 0) {
      return { ok: false, code: "url_blocked" };
    }
    const addresses = await this.#resolveAddresses(hostname);
    if (addresses === undefined) {
      return { ok: false, code: "url_blocked" };
    }
    if (addresses.length === 0) {
      return { ok: false, code: "network_unavailable" };
    }
    for (const answer of addresses) {
      if (answer.family !== 4 && answer.family !== 6) {
        return { ok: false, code: "network_unavailable" };
      }
      let parsed: ipaddr.IPv4 | ipaddr.IPv6;
      try {
        parsed = ipaddr.parse(answer.address);
      } catch {
        return { ok: false, code: "network_unavailable" }; // malformed address
      }
      if (
        (parsed.kind() === "ipv4" && answer.family !== 4) ||
        (parsed.kind() === "ipv6" && answer.family !== 6)
      ) {
        return { ok: false, code: "network_unavailable" }; // family/address mismatch
      }
      if (!isPublicAddress(answer.address)) {
        // ANY forbidden answer rejects the whole request; never pick the
        // public subset out of a mixed result.
        return { ok: false, code: "url_blocked" };
      }
    }
    return {
      ok: true,
      target: {
        href: url.href,
        protocol: url.protocol === "https:" ? "https:" : "http:",
        hostname,
        port,
        path: url.pathname + url.search,
        addresses,
      },
    };
  }

  async #resolveAddresses(hostname: string): Promise<readonly DnsAnswer[] | undefined> {
    let literal: ipaddr.IPv4 | ipaddr.IPv6;
    try {
      literal = ipaddr.parse(hostname);
    } catch {
      literal = undefined as never;
    }
    if (literal !== undefined) {
      // A literal IP in the URL: no DNS step, the address itself is the only
      // connection target.
      return [
        {
          address: hostname,
          family: literal.kind() === "ipv6" ? 6 : 4,
        },
      ];
    }
    if (!HOSTNAME_RE.test(hostname)) {
      return undefined; // malformed/empty hostname -> blocked
    }
    const lower = hostname.toLowerCase();
    if (LOCALHOST_NAMES.has(lower) || lower.endsWith(".localhost") || lower.endsWith(".local")) {
      return undefined;
    }
    let answers: readonly DnsAnswer[];
    try {
      answers = await this.#lookup(lower);
    } catch {
      return [];
    }
    return answers;
  }
}