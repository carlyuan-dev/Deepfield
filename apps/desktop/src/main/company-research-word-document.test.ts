import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getCompanyResearchTemplate, type KeyResearchRun, type ResearchRun } from "@deepfield/contracts";
import { buildCompanyResearchDocx } from "./company-research-word-document.js";

const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture(): KeyResearchRun {
  const template = getCompanyResearchTemplate("product_and_technology");
  const repeatedUrl = "https://example.com/研究报告?company=小米&stage=原始报告#证据";
  return {
    id: "run-word-测试" as KeyResearchRun["id"],
    itemId: "item-word" as KeyResearchRun["itemId"],
    companyId: "company-word" as KeyResearchRun["companyId"],
    schemaVersion: "company-research-report-v1",
    status: "completed",
    searchStatus: "none",
    direction: "product_and_technology",
    focusScope: "新品与核心技术",
    asOfDate: "2026-09-15",
    researchContext: {
      companyName: "小米集团 <测试>", topicName: "智能眼镜与可穿戴设备", topicScope: "中国市场",
      companyNote: "历史候选备注", currentDate: "2026-09-16", direction: "product_and_technology",
      focusScope: "新品与核心技术", asOfDate: "2026-09-15",
    },
    template,
    harnessVersion: 1,
    rawReportText: [
      "# 原始调研报告 <保留>",
      "",
      `正文含 **加粗**、*强调*、[可点击来源](${repeatedUrl}) 与裸链接 https://bare.example/path?q=中文&kind=证据。`,
      "",
      "[参考来源][ref] 与 [不安全链接](javascript:alert(1))。",
      "",
      "![产品图](https://images.example/remote.png)",
      "",
      "- 第一项",
      "- 第二项",
      "",
      "3. 有序三",
      "4. 有序四",
      "",
      "1. 重新开始",
      "",
      "> 引用内容",
      "",
      "| 指标 | 数值 |",
      "| --- | ---: |",
      "| 出货量 | 100 万台 |",
      "",
      "```text",
      "const evidence = '<保持为文本>';",
      "```",
      "",
      `[ref]: ${repeatedUrl}`,
    ].join("\n"),
    structuredContent: {
      coreSummary: ["新品已发布，仍需核验长期销量。", "报告中的不确定性必须保留。"],
      sections: template.sections.map((section, index) => ({
        sectionId: section.sectionId,
        status: (["found", "partial", "not_found", "not_disclosed", "conflicting"] as const)[index]!,
        summary: index === 0 ? "首节摘要包含 <转义字符>。" : null,
        facts: [{
          text: `第 ${index + 1} 节事实完整保留`,
          timeContext: index === 0 ? "截至 2026 年 9 月" : null,
          claimType: (["reported_fact", "company_statement", "plan", "estimate", "forecast"] as const)[index]!,
          source: { title: `来源 ${index + 1}`, url: index === 0 ? repeatedUrl : `https://sources.example/${index + 1}` },
        }],
      })),
    },
    structuringAttempts: 1,
    createdAt: "2026-09-16T01:00:00.000Z",
    rawCompletedAt: "2026-09-16T01:20:00.000Z",
    completedAt: "2026-09-16T01:30:00.000Z",
  };
}

function unzip(buffer: Buffer, member: string): string {
  const directory = mkdtempSync(join(tmpdir(), "deepfield-docx-test-"));
  tempDirectories.push(directory);
  const file = join(directory, "report.docx");
  writeFileSync(file, buffer);
  return execFileSync("unzip", ["-p", file, member], { encoding: "utf8" });
}

function paragraphContaining(documentXml: string, text: string): string {
  const paragraph = documentXml.match(/<w:p(?: [^>]*)?>[\s\S]*?<\/w:p>/g)?.find((candidate) => candidate.includes(text));
  if (!paragraph) throw new Error(`missing paragraph containing: ${text}`);
  return paragraph;
}

describe("company research Word document", () => {
  it("preserves both saved stages, metadata, warnings, Markdown structures and safe links in editable OOXML", async () => {
    const run = fixture();
    const buffer = await buildCompanyResearchDocx(run, { raw: true, structured: true });
    const documentXml = unzip(buffer, "word/document.xml");
    const relationshipsXml = unzip(buffer, "word/_rels/document.xml.rels");

    for (const text of [
      "小米集团 &lt;测试&gt;", "智能眼镜与可穿戴设备", "产品与技术", "新品与核心技术", "2026-09-15",
      "2026-09-16 09:30", "run-word-测试", "本次报告未成功完成联网搜索", "AI 调研结果仅供参考",
      "第一轮 原始调研报告", "原始调研报告 &lt;保留&gt;", "加粗", "强调", "第一项", "有序三", "重新开始", "引用内容",
      "指标", "100 万台", "const evidence = &apos;&lt;保持为文本&gt;&apos;;", "产品图", "结构化报告", "核心结论",
      "新品已发布，仍需核验长期销量。", "一、主要产品与定位", "首节摘要包含 &lt;转义字符&gt;。",
      "资料状态：未找到", "资料状态：未披露", "资料状态：存在冲突", "资料来源",
    ]) expect(documentXml).toContain(text);
    expect(documentXml).not.toContain("资料状态：已找到");
    expect(documentXml).not.toContain("资料状态：部分找到");
    expect(documentXml).not.toContain("时间背景：");
    expect(documentXml).not.toContain("声明类型：");
    expect(documentXml).toContain('<w:br w:type="page"/>');
    expect(documentXml).toContain("<w:tbl>");
    expect(documentXml).toContain("<w:tblHeader");
    expect(documentXml).toContain('<w:cantSplit w:val="false"/>');
    expect(documentXml).toContain("<w:hyperlink");
    expect(relationshipsXml).toContain("https://example.com/研究报告?company=小米&amp;stage=原始报告#证据");
    expect(relationshipsXml).toContain("https://bare.example/path?q=中文&amp;kind=证据");
    expect(relationshipsXml).not.toContain("javascript:");
    expect(relationshipsXml).not.toContain("images.example");
    expect(documentXml).toContain("javascript:alert(1)");
    expect((documentXml.match(/来源附录/g) ?? [])).toHaveLength(1);
    expect((documentXml.match(/https:\/\/bare\.example\/path\?q=中文&amp;kind=证据/g) ?? [])).toHaveLength(2);
    expect(documentXml).not.toContain("证据与来源");
    const numberingXml = unzip(buffer, "word/numbering.xml");
    expect(numberingXml).toContain('<w:start w:val="3"/>');
    expect((numberingXml.match(/<w:abstractNum /g) ?? []).length).toBeGreaterThanOrEqual(4);
  });

  it("keeps raw HTML as inert literal text instead of discarding it", async () => {
    const run = fixture();
    run.rawReportText = "正文\n\n<div>销量仅为公司预测，不是实际结果。</div>";

    const documentXml = unzip(await buildCompanyResearchDocx(run, { raw: true, structured: true }), "word/document.xml");

    expect(documentXml).toContain("&lt;div&gt;销量仅为公司预测，不是实际结果。&lt;/div&gt;");
  });

  it("resolves reference definitions nested in blockquotes", async () => {
    const run = fixture();
    run.rawReportText = [
      "> 参考[公告][r]",
      ">",
      "> [r]: https://example.com/evidence",
    ].join("\n");

    const buffer = await buildCompanyResearchDocx(run, { raw: true, structured: true });
    const documentXml = unzip(buffer, "word/document.xml");
    const relationshipsXml = unzip(buffer, "word/_rels/document.xml.rels");

    expect(documentXml).toContain("公告");
    expect(documentXml).toContain("来源附录");
    expect(relationshipsXml).toContain("https://example.com/evidence");
  });

  it("exports legacy and failed raw-only reports honestly without fabricating structured content", async () => {
    const failed = fixture();
    failed.status = "structure_failed";
    failed.lastFailureCode = "structuring_failed";
    delete failed.structuredContent;
    delete failed.completedAt;
    const failedXml = unzip(await buildCompanyResearchDocx(failed, { raw: true, structured: false }), "word/document.xml");
    expect(failedXml).toContain("第二轮结构化整理未完成");
    expect(failedXml).not.toContain("第二轮 结构化报告");

    const legacy = {
      id: "legacy-1", itemId: "item-word", companyId: "company-word", schemaVersion: "legacy-freeform-v1",
      status: "completed", searchStatus: "unknown", timeScope: "2024 至 2025 年", customRequirements: "保留原始口径",
      reportText: "# 旧版报告\n\n历史内容", createdAt: "2025-01-01T00:00:00.000Z", completedAt: "2025-01-01T01:00:00.000Z",
    } as unknown as ResearchRun;
    const legacyXml = unzip(await buildCompanyResearchDocx(legacy, { raw: true, structured: false }), "word/document.xml");
    expect(legacyXml).toContain("历史旧版报告");
    expect(legacyXml).toContain("公司与研究主题：旧版报告未记录");
    expect(legacyXml).toContain("2024 至 2025 年");
    expect(legacyXml).toContain("保留原始口径");
    expect(legacyXml).not.toContain("第二轮 结构化报告");

    const incompleteSaved = fixture();
    delete incompleteSaved.structuredContent;
    const incompleteXml = unzip(await buildCompanyResearchDocx(incompleteSaved, { raw: true, structured: false }), "word/document.xml");
    expect(incompleteXml).toContain("已保存记录未包含结构化报告");
    expect(incompleteXml).not.toContain("第二轮 结构化报告");
  });

  it("builds ordered chapter sections with bulleted conclusions and facts plus chapter-local deduplicated URLs", async () => {
    const run = fixture();
    const sharedUrl = "https://evidence.example/shared";
    const first = run.structuredContent!.sections[0]!;
    first.facts = [
      { text: "共享来源的事实甲：截至 2026 年上半年，口径仍需核验。", timeContext: "2026 年上半年", claimType: "reported_fact", source: { title: "共同来源甲", url: sharedUrl } },
      { text: "共享来源的事实乙，原文也不变。", timeContext: null, claimType: "forecast", source: { title: "共同来源乙", url: sharedUrl } },
    ];
    run.structuredContent!.sections[1]!.facts[0]!.source = { title: "另一章共同来源", url: sharedUrl };
    run.structuredContent!.sections[2]!.facts[0]!.source = { title: "危险来源", url: "javascript:alert(1)" };

    const buffer = await buildCompanyResearchDocx(run, { raw: false, structured: true });
    const documentXml = unzip(buffer, "word/document.xml");
    const relationshipsXml = unzip(buffer, "word/_rels/document.xml.rels");

    for (const text of [
      "小米集团 &lt;测试&gt; 产品与技术调研报告", "研究主题：智能眼镜与可穿戴设备", "研究方向：产品与技术",
      "重点范围：新品与核心技术", "截至日期：2026-09-15", "核心结论", "一、主要产品与定位",
      "首节摘要包含 &lt;转义字符&gt;。", "共享来源的事实甲：截至 2026 年上半年，口径仍需核验。", "共享来源的事实乙，原文也不变。",
      "资料来源", sharedUrl, "资料状态：未找到", "资料状态：未披露", "资料状态：存在冲突",
      "javascript:alert(1)",
    ]) expect(documentXml).toContain(text);
    expect(documentXml).not.toContain("原始调研报告 &lt;保留&gt;");
    expect(documentXml).not.toContain("摘要：");
    expect(documentXml).not.toContain("证据与来源");
    expect(documentXml).not.toContain("共同来源甲");
    expect(documentXml).not.toContain("共同来源乙");
    expect(documentXml).not.toContain("另一章共同来源");
    expect(documentXml).not.toContain("资料状态：已找到");
    expect(documentXml).not.toContain("资料状态：部分找到");
    expect(documentXml).not.toContain("时间背景：");
    expect(documentXml).not.toContain("声明类型：");
    expect(documentXml).not.toContain("<w:tbl>");
    expect(documentXml).toContain("<w:numPr>");
    expect(documentXml).not.toContain("<w:pageBreakBefore");
    expect(documentXml).toContain('<w:pgSz w:w="11906" w:h="16838"');
    expect((relationshipsXml.match(/https:\/\/evidence\.example\/shared/g) ?? [])).toHaveLength(2);
    expect(relationshipsXml).not.toContain("javascript:");

    const heading = documentXml.indexOf("一、主要产品与定位");
    const summary = documentXml.indexOf("首节摘要包含 &lt;转义字符&gt;。", heading);
    const fact = documentXml.indexOf("共享来源的事实甲：截至 2026 年上半年，口径仍需核验。", summary);
    const sources = documentXml.indexOf("资料来源", fact);
    expect(heading).toBeLessThan(summary);
    expect(summary).toBeLessThan(fact);
    expect(fact).toBeLessThan(sources);
  });

  it("numbers structured fact citations by first URL appearance and keeps source markers outside exact hyperlinks", async () => {
    const run = fixture();
    const sharedUrl = "https://evidence.example/exact?b=2&a=1#原文";
    const nextUrl = "https://evidence.example/next?z=9&y=8";
    run.structuredContent!.sections[0]!.facts = [
      { text: "同章共享事实甲。", timeContext: null, claimType: "reported_fact", source: { title: "标题甲", url: sharedUrl } },
      { text: "同章共享事实乙。", timeContext: null, claimType: "company_statement", source: { title: "标题乙", url: sharedUrl } },
    ];
    run.structuredContent!.sections[1]!.facts = [
      { text: "下一章新来源事实。", timeContext: null, claimType: "reported_fact", source: { title: "新来源", url: nextUrl } },
      { text: "跨章复用来源事实。", timeContext: null, claimType: "reported_fact", source: { title: "另一标题", url: sharedUrl } },
    ];
    run.structuredContent!.sections[2]!.facts = [
      { text: "不安全来源事实。", timeContext: null, claimType: "reported_fact", source: { title: "危险来源", url: "javascript:alert(1)" } },
    ];

    const structured = await buildCompanyResearchDocx(run, { raw: false, structured: true });
    const documentXml = unzip(structured, "word/document.xml");
    const relationshipsXml = unzip(structured, "word/_rels/document.xml.rels");

    expect(paragraphContaining(documentXml, "同章共享事实甲。")).toContain(" [1]");
    expect(paragraphContaining(documentXml, "同章共享事实乙。")).toContain(" [1]");
    expect(paragraphContaining(documentXml, "下一章新来源事实。")).toContain(" [2]");
    expect(paragraphContaining(documentXml, "跨章复用来源事实。")).toContain(" [1]");
    expect(paragraphContaining(documentXml, "不安全来源事实。")).toContain(" [3]");
    expect(paragraphContaining(documentXml, "新品已发布，仍需核验长期销量。")).not.toMatch(/\[\d+\]/);
    expect(paragraphContaining(documentXml, "首节摘要包含 &lt;转义字符&gt;。")).not.toMatch(/\[\d+\]/);

    const firstSource = paragraphContaining(documentXml, "https://evidence.example/exact?b=2&amp;a=1#原文");
    expect(firstSource).toContain("[1] ");
    expect(firstSource).not.toContain("<w:numPr>");
    expect(firstSource.indexOf("[1] ")).toBeLessThan(firstSource.indexOf("<w:hyperlink"));
    expect(firstSource.slice(firstSource.indexOf("<w:hyperlink"))).not.toContain("[1]");
    expect(paragraphContaining(documentXml, "https://evidence.example/next?z=9&amp;y=8")).toContain("[2] ");
    expect(paragraphContaining(documentXml, "javascript:alert(1)（来源链接不可用）")).toContain("[3] ");
    expect(relationshipsXml).toContain("Target=\"https://evidence.example/exact?b=2&amp;a=1#原文\"");
    expect(relationshipsXml).toContain("Target=\"https://evidence.example/next?z=9&amp;y=8\"");
    expect(relationshipsXml).not.toContain("javascript:");

    const combinedXml = unzip(await buildCompanyResearchDocx(run, { raw: true, structured: true }), "word/document.xml");
    expect(paragraphContaining(combinedXml, "同章共享事实甲。")).toContain(" [1]");
    const secondExportXml = unzip(await buildCompanyResearchDocx(run, { raw: false, structured: true }), "word/document.xml");
    expect(paragraphContaining(secondExportXml, "同章共享事实甲。")).toContain(" [1]");
  });

  it("includes exactly the selected report stages while keeping raw-only legacy layout dimensions", async () => {
    const run = fixture();
    const rawXml = unzip(await buildCompanyResearchDocx(run, { raw: true, structured: false }), "word/document.xml");
    expect(rawXml).toContain("原始调研报告 &lt;保留&gt;");
    expect(rawXml).not.toContain("核心结论");
    expect(rawXml).not.toContain("证据与来源");
    expect(rawXml).toContain('<w:pgSz w:w="12240" w:h="15840"');

    const structuredXml = unzip(await buildCompanyResearchDocx(run, { raw: false, structured: true }), "word/document.xml");
    expect(structuredXml).not.toContain("原始调研报告 &lt;保留&gt;");
    expect(structuredXml).toContain("核心结论");

    const combinedXml = unzip(await buildCompanyResearchDocx(run, { raw: true, structured: true }), "word/document.xml");
    expect(combinedXml).toContain("原始调研报告 &lt;保留&gt;");
    expect(combinedXml).toContain("核心结论");
    expect(combinedXml).toContain('<w:br w:type="page"/>');
  });
});
