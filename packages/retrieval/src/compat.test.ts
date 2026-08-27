import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import ipaddr from "ipaddr.js";
import * as cheerio from "cheerio";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { UrlPolicy, isPublicAddress, type DnsAnswer } from "./url-policy.js";

const FIXTURES = join(import.meta.dirname, "..", "..", "..", "tests", "fixtures", "retrieval");

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

describe("Task 7 parser dependency gate", () => {
  it("imports cheerio@1.1.2 and pdfjs-dist@4.10.38 in Node ESM and parses smallest fixtures", async () => {
    const dom = cheerio.load("<h1>你好</h1><p>Hello</p>");
    expect(dom("p").text()).toBe("Hello");
    expect(dom("h1").text()).toBe("你好");

    const data = new Uint8Array(readFileSync(join(FIXTURES, "report-two-pages.pdf")));
    const pdf = await getDocument({
      data,
      isEvalSupported: false,
      useSystemFonts: false,
      disableFontFace: true,
      standardFontDataUrl: "data:application/octet-stream;base64,",
    }).promise;
    expect(pdf.numPages).toBe(2);
    const page = await pdf.getPage(1);
    const text = await page.getTextContent();
    expect(text.items.map((item) => (item as { str: string }).str).join("")).toContain("人形");
    await pdf.destroy();
  });
});
