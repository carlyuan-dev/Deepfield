import { describe, expect, it } from "vitest";
import {
  getCompanyResearchTemplate,
  RESEARCH_DIRECTIONS,
  type StructuredResearchContent,
} from "@deepfield/contracts";
import {
  extractMarkdownSources,
  parseStructuredCandidate,
  validateStructuredResearch,
} from "./company-research-harness.js";

const template = getCompanyResearchTemplate("product_and_technology");
const raw = "- [公司公告](https://example.com/a)";
const fallback = "现有公开信息不足以形成可靠的核心判断。";
function content(): StructuredResearchContent {
  return {
    coreSummary: ["公司已发布产品。"],
    sections: template.sections.map(({ sectionId }) => ({
      sectionId, status: "found", summary: "已发布产品。",
      facts: [{ text: "产品已发布。", timeContext: null, claimType: "reported_fact",
        source: { title: "公司公告", url: "https://example.com/a" } }],
    })),
  };
}

describe("structured candidate framing", () => {
  it.each([' {"x":1} \n', '\n```json\n{"x":1}\n```\n', '```json\r\n{"x":1}\r\n```'])
    ("accepts a JSON object with permitted framing: %s", (text) => {
      expect(parseStructuredCandidate(text)).toEqual({ x: 1 });
    });
  it.each([
    "", "null", "[]", "42", '"text"', '{} {}', '{}\n{}',
    'Here is JSON: {}', '{} done', '```\n{}\n```', '```js\n{}\n```',
    '```json\n{}\n```\n```json\n{}\n```', 'before\n```json\n{}\n```',
    '```json\n{}\n```\nafter', '```json\n{}', '{"x":1,}',
  ])("rejects nonobjects, repair, prose and multiple candidates: %s", (text) => {
    expect(() => parseStructuredCandidate(text)).toThrow();
  });
});

describe("Markdown source inheritance", () => {
  it.each([
    [raw, "公司公告", "https://example.com/a"],
    [String.raw`[公司\[公告\]](https://example.com/a_(2026))`, "公司[公告]", "https://example.com/a_(2026)"],
    [String.raw`[公司\]公告](https://example.com/a\(b\))`, "公司]公告", "https://example.com/a(b)"],
    ['[公司公告](<https://example.com/a_(b)> "optional title")', "公司公告", "https://example.com/a_(b)"],
    ["[公司公告](https://example.com/a(b(c)) 'title')", "公司公告", "https://example.com/a(b(c))"],
    ["[ 原始标题 ](HTTPS://Example.COM:443/%61?q=1&x=2#Part)", " 原始标题 ", "HTTPS://Example.COM:443/%61?q=1&x=2#Part"],
    ["[公司公告][ref]\n\n[ref]: https://example.com/a", "公司公告", "https://example.com/a"],
    ["[公司公告][]\n\n[公司公告]: https://example.com/a", "公司公告", "https://example.com/a"],
    ["[公司公告]\n\n[公司公告]: https://example.com/a", "公司公告", "https://example.com/a"],
    ["[公司公告](http://example.com/a)", "公司公告", "http://example.com/a"],
    ["<https://example.com/a>", "https://example.com/a", "https://example.com/a"],
  ])("extracts actual links without URL normalization: %s", (markdown, title, url) => {
    expect(extractMarkdownSources(markdown)).toEqual(new Set([`${title}\u0000${url}`]));
    const candidate = content();
    for (const section of candidate.sections) section.facts[0]!.source = { title, url };
    expect(validateStructuredResearch(JSON.stringify(candidate), markdown, template)).toEqual(candidate);
  });

  it.each([
    "公司公告 https://example.com/a", '[公司公告](javascript:alert(1))',
    '[公司公告](mailto:company@example.com)', '[公司公告](/relative)', '[公司公告](https://)',
    '[公司公告](https://example.com/a "unclosed)', '[公司公告](https://example.com/a(b)',
    String.raw`\[公司公告](https://example.com/a)`, '![公司公告](https://example.com/a)',
    '`[公司公告](https://example.com/a)`', '``[公司公告](https://example.com/a)``',
    '```md\n[公司公告](https://example.com/a)\n```', '~~~\n[公司公告](https://example.com/a)\n~~~',
    '    [公司公告](https://example.com/a)', '\t[公司公告](https://example.com/a)',
    '-     [公司公告](https://example.com/a)', '>     [公司公告](https://example.com/a)',
    '<!-- [公司公告](https://example.com/a) -->',
    '<script>\n[公司公告](https://example.com/a)\n</script>',
    '<div data-source="[公司公告](https://example.com/a)"></div>',
    '[公司公告]: https://example.com/a',
    '[公司公告][ref]\n\n<!--\n[ref]: https://example.com/a\n-->',
    '[公司公告][ref]\n\ntext <!--\n[ref]: https://example.com/a\n-->',
    '[公司公告][ref]\n\ntext `code\n[ref]: https://example.com/a\ncode`',
    '[公司公告][ref]\n\nparagraph\n[ref]: https://example.com/a',
    'text <span title="a > [公司公告](https://example.com/a)">text</span>',
    '<![CDATA[\n[公司公告](https://example.com/a)\n]]>',
    '<?processing\n[公司公告](https://example.com/a)\n?>',
    '[公司公告](https://example.com/a "title\n\nparagraph")',
    '<custom>\n[公司公告](https://example.com/a)\n</custom>',
  ])("does not treat nonlinks as sources: %s", (markdown) => {
    expect(extractMarkdownSources(markdown)).toEqual(new Set());
    expect(() => validateStructuredResearch(JSON.stringify(content()), markdown, template)).toThrow();
  });
  it("keeps real links adjacent to code, images and comments and deduplicates pairs", () => {
    expect(extractMarkdownSources(`\`fake\` ![image](https://example.com/image) <!-- fake --> ${raw}\n${raw}`))
      .toEqual(new Set(["公司公告\u0000https://example.com/a"]));
  });
  it("does not turn a filtered indented continuation into a reference paragraph boundary", () => {
    const markdown = "[公司公告][ref]\n    continuation\n[ref]: https://example.com/a";
    expect(extractMarkdownSources(markdown)).toEqual(new Set());
    expect(() => validateStructuredResearch(JSON.stringify(content()), markdown, template)).toThrow();
  });
  it("does not invent an outer link when its label contains a real link", () => {
    expect(extractMarkdownSources('[outer [inner](https://example.com/b)](https://example.com/a)'))
      .toEqual(new Set(["inner\u0000https://example.com/b"]));
    expect(extractMarkdownSources('[<https://example.com/b>](https://example.com/a)'))
      .toEqual(new Set(["https://example.com/b\u0000https://example.com/b"]));
  });
});

describe("deterministic research validation", () => {
  it.each(RESEARCH_DIRECTIONS)("accepts exactly the supplied template order for %s", (direction) => {
    const supplied = getCompanyResearchTemplate(direction);
    const candidate = content();
    candidate.sections.forEach((section, i) => { section.sectionId = supplied.sections[i]!.sectionId; });
    expect(validateStructuredResearch(JSON.stringify(candidate), raw, supplied)).toEqual(candidate);
  });

  const invalid: [string, (value: StructuredResearchContent) => void][] = [
    ["extra top-level field", (v) => { Object.assign(v, { id: "extra" }); }],
    ["extra section field", (v) => { Object.assign(v.sections[0]!, { title: "extra" }); }],
    ["extra fact field", (v) => { Object.assign(v.sections[0]!.facts[0]!, { id: "extra" }); }],
    ["extra source field", (v) => { Object.assign(v.sections[0]!.facts[0]!.source, { id: "extra" }); }],
    ["missing section", (v) => { v.sections.pop(); }],
    ["extra section", (v) => { v.sections.push(v.sections[0]!); }],
    ["wrong section order", (v) => { v.sections.reverse(); }],
    ["duplicate section", (v) => { v.sections[1]!.sectionId = v.sections[0]!.sectionId; }],
    ["unknown section", (v) => { v.sections[0]!.sectionId = "unknown"; }],
    ["found without facts", (v) => { v.sections[0]!.facts = []; }],
    ["found without summary", (v) => { v.sections[0]!.summary = null; }],
    ["partial without facts", (v) => { Object.assign(v.sections[0]!, { status: "partial", facts: [] }); }],
    ["partial without summary", (v) => { Object.assign(v.sections[0]!, { status: "partial", summary: null }); }],
    ["not_found with facts", (v) => { Object.assign(v.sections[0]!, { status: "not_found", summary: null }); }],
    ["not_found with summary", (v) => { Object.assign(v.sections[0]!, { status: "not_found", facts: [] }); }],
    ["not_disclosed without facts", (v) => { Object.assign(v.sections[0]!, { status: "not_disclosed", summary: null, facts: [] }); }],
    ["not_disclosed with summary", (v) => { v.sections[0]!.status = "not_disclosed"; }],
    ["conflicting with one fact", (v) => { v.sections[0]!.status = "conflicting"; }],
    ["conflicting without summary", (v) => {
      Object.assign(v.sections[0]!, { status: "conflicting", summary: null, facts: [v.sections[0]!.facts[0]!, v.sections[1]!.facts[0]!] });
    }],
    ["blank core summary", (v) => { v.coreSummary = [" \n\t　"]; }],
    ["blank section summary", (v) => { v.sections[0]!.summary = " \t"; }],
    ["blank fact", (v) => { v.sections[0]!.facts[0]!.text = "　"; }],
    ["blank time context", (v) => { v.sections[0]!.facts[0]!.timeContext = " \n"; }],
    ["blank source title", (v) => { v.sections[0]!.facts[0]!.source.title = " "; }],
    ["blank source URL", (v) => { v.sections[0]!.facts[0]!.source.url = " "; }],
    ["new URL", (v) => { v.sections[0]!.facts[0]!.source.url = "https://example.com/b"; }],
    ["renamed source", (v) => { v.sections[0]!.facts[0]!.source.title = "新标题"; }],
    ["normalized URL", (v) => { v.sections[0]!.facts[0]!.source.url = "https://EXAMPLE.com/a"; }],
    ["empty summary array", (v) => { v.coreSummary = []; }],
    ["too many facts", (v) => { v.sections[0]!.facts = Array(9).fill(v.sections[0]!.facts[0]); }],
    ["unknown claim type", (v) => { Object.assign(v.sections[0]!.facts[0]!, { claimType: "verified" }); }],
    ["fallback despite facts", (v) => { v.coreSummary = [fallback]; }],
    ["fallback mixed with conclusions", (v) => { v.coreSummary.push(fallback); }],
  ];
  it.each(invalid)("rejects %s", (_name, mutate) => {
    const candidate = content();
    mutate(candidate);
    expect(() => validateStructuredResearch(JSON.stringify(candidate), raw, template)).toThrow();
  });

  it("accepts the five valid status/content combinations without changing text", () => {
    const candidate = content();
    candidate.sections[1]!.status = "partial";
    Object.assign(candidate.sections[2]!, { status: "not_found", summary: null, facts: [] });
    Object.assign(candidate.sections[3]!, { status: "not_disclosed", summary: null });
    candidate.sections[4]!.status = "conflicting";
    candidate.sections[4]!.facts.push({ ...candidate.sections[0]!.facts[0]!, text: "另一项相反的陈述。" });
    candidate.sections[0]!.facts[0]!.timeContext = " 2026 年 ";
    expect(validateStructuredResearch(`\n\`\`\`json\n${JSON.stringify(candidate)}\n\`\`\``, raw, template)).toEqual(candidate);
  });

  it("requires exactly the fixed fallback when all facts are empty", () => {
    const candidate = content();
    candidate.sections.forEach((section) => Object.assign(section, { status: "not_found", summary: null, facts: [] }));
    for (const summaries of [["Unsupported conclusion"], [fallback, "extra"], [` ${fallback}`]]) {
      candidate.coreSummary = summaries;
      expect(() => validateStructuredResearch(JSON.stringify(candidate), "No sources found.", template)).toThrow();
    }
    candidate.coreSummary = [fallback];
    expect(validateStructuredResearch(JSON.stringify(candidate), "No sources found.", template)).toEqual(candidate);
  });

  it("rejects recombining a title and URL from different raw links", () => {
    expect(() => validateStructuredResearch(JSON.stringify(content()),
      "[公司公告](https://example.com/b) [其他标题](https://example.com/a)", template)).toThrow();
  });
});
