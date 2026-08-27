import { describe, expect, it } from "vitest";
import { createPinnedLookup } from "./node-http-adapter.js";
import type { DnsAnswer } from "./url-policy.js";

const ADDRESSES: readonly DnsAnswer[] = [
  { address: "93.184.216.34", family: 4 },
  { address: "2606:4700::1111", family: 6 },
];

describe("pinned lookup (focused revision)", () => {
  it("returns the full validated snapshot when all=true (Node 24 autoSelectFamily contract)", () => {
    const lookup = createPinnedLookup("example.com", ADDRESSES);
    const callback = (error: Error | null, value?: unknown): void => {
      expect(error).toBeNull();
      expect(value).toEqual([
        { address: "93.184.216.34", family: 4 },
        { address: "2606:4700::1111", family: 6 },
      ]);
    };
    lookup("example.com", { all: true, family: 0, verbatim: true }, callback as never);
  });

  it("returns a single matching-family address when all is not set", () => {
    const lookup = createPinnedLookup("example.com", ADDRESSES);
    let v4: unknown;
    let v6: unknown;
    lookup("example.com", { family: 4 }, ((_e: Error | null, address?: string, family?: number) => {
      v4 = [address, family];
    }) as never);
    lookup("example.com", { family: 6 }, ((_e: Error | null, address?: string, family?: number) => {
      v6 = [address, family];
    }) as never);
    expect(v4).toEqual(["93.184.216.34", 4]);
    expect(v6).toEqual(["2606:4700::1111", 6]);
  });

  it("fails on hostname mismatch, empty addresses and missing family", () => {
    const lookup = createPinnedLookup("example.com", ADDRESSES);
    let mismatchError: unknown;
    lookup("evil.example", { all: true }, (error) => {
      mismatchError = error;
    });
    expect(String(mismatchError)).toContain("hostname");

    let emptyError: unknown;
    createPinnedLookup("example.com", [])( "example.com", { all: true }, (error) => {
      emptyError = error;
    });
    expect(String(emptyError)).toContain("no pinned");

    let familyError: unknown;
    lookup("example.com", { family: 5 }, (error) => {
      familyError = error;
    });
    expect(String(familyError)).toContain("family");
  });

  it("never re-resolves: the lookup only serves the checked addresses", () => {
    const lookup = createPinnedLookup("example.com", ADDRESSES);
    let calls = 0;
    const wrapped = (hostname: string, options: unknown, callback: unknown): void => {
      calls += 1;
      lookup(hostname, options as never, callback as never);
    };
    wrapped("example.com", { all: true }, (() => {}) as never);
    wrapped("example.com", { all: true }, (() => {}) as never);
    expect(calls).toBe(2); // each call serves the pinned snapshot, no DNS
  });
});

describe("pinned lookup snapshot isolation (focused revision)", () => {
  it("serves an internal frozen copy even when the caller mutates the source array", () => {
    const mutable: DnsAnswer[] = [
      { address: "93.184.216.34", family: 4 },
      { address: "2606:4700::1111", family: 6 },
    ];
    const lookup = createPinnedLookup("example.com", mutable);
    mutable[0] = { address: "10.0.0.1", family: 4 };
    mutable.length = 0;
    let result: unknown;
    lookup("example.com", { all: true }, (error, addresses) => {
      result = addresses;
    });
    expect(result).toEqual([
      { address: "93.184.216.34", family: 4 },
      { address: "2606:4700::1111", family: 6 },
    ]);
  });
});
