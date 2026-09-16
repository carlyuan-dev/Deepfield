import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getCompanyResearchTemplate, type KeyResearchRun } from "@deepfield/contracts";
import { buildCompanyResearchDocx } from "./company-research-word-document.js";

function qaRun(): KeyResearchRun {
  const template = getCompanyResearchTemplate("product_and_technology");
  const longUrl = "https://example.com/company/%E5%B0%8F%E7%B1%B3/research?section=product-and-technology&asOf=2026-09-15&source=%E5%85%AC%E5%8F%B8%E5%85%AC%E5%91%8A#long-evidence-link";
  return {
    id: "qa-word-run-20260916" as KeyResearchRun["id"], itemId: "qa-item" as KeyResearchRun["itemId"], companyId: "qa-company" as KeyResearchRun["companyId"],
    schemaVersion: "company-research-report-v1", status: "completed", searchStatus: "none",
    direction: "product_and_technology", focusScope: "智能眼镜新品、核心技术、量产进度与竞争差异", asOfDate: "2026-09-15",
    researchContext: {
      companyName: "小米集团", topicName: "智能眼镜与可穿戴设备", topicScope: "中国市场与海外发布进度",
      companyNote: "QA 示例仅验证排版，不代表真实研究结论", currentDate: "2026-09-16",
      direction: "product_and_technology", focusScope: "智能眼镜新品、核心技术、量产进度与竞争差异", asOfDate: "2026-09-15",
    },
    template, harnessVersion: 1, structuringAttempts: 1,
    createdAt: "2026-09-16T01:00:00.000Z", rawCompletedAt: "2026-09-16T01:25:00.000Z", completedAt: "2026-09-16T01:35:00.000Z",
    rawReportText: [
      "# 小米智能眼镜产品与技术调研",
      "",
      "本示例用于验证中文 Word 导出。报告保留 **重点事实**、*不确定性*、引用、代码文本和来源链接，不对内容进行二次改写。",
      "",
      "## 主要发现",
      "",
      "- 新品信息需要结合正式发布资料继续核验。",
      "- 当前公开证据对长期销量与供应能力的支持仍有限。",
      "",
      "3. 这是从三开始的有序条目。",
      "4. 第二个条目用于验证编号延续。",
      "",
      "> 任何计划、估计与预测都应和已经实现的事实分开阅读。",
      "",
      "| 指标 | 当前信息 | 核验状态 |",
      "| --- | --- | --- |",
      "| 产品状态 | 已公开展示 | 仍需正式公告核验 |",
      "| 量产时间 | 尚无一致口径 | 存在不确定性 |",
      "| 长期销量 | 暂无充分公开数据 | 未找到 |",
      "",
      `官方资料：[产品与技术公告](${longUrl})。`,
      "",
      "裸链接：https://bare.example/very/long/path/to/research/document?company=%E5%B0%8F%E7%B1%B3&topic=wearable&lang=zh-CN#evidence",
      "",
      "![远程产品图片仅保留文字](https://images.example/product.png)",
      "",
      "```text",
      "status = uncertain; // 代码仅作为可编辑文本保留",
      "```",
    ].join("\n"),
    structuredContent: {
      coreSummary: [
        "现有资料可以确认产品方向，但若干关键规格仍需正式材料交叉核验。",
        "量产节奏与长期销量缺乏一致公开证据，不能把计划或预测表述为已实现结果。",
      ],
      sections: template.sections.map((section, index) => ({
        sectionId: section.sectionId,
        status: (["found", "partial", "not_found", "not_disclosed", "conflicting"] as const)[index]!,
        summary: `本节保留模板标题“${section.title}”及原始结构化摘要。以下内容用于检查长段落、分页和链接换行，不代表真实公司事实。`,
        facts: [
          {
            text: `第 ${index + 1} 个模块的事实条目使用较长中文段落来验证自然换行和跨页阅读体验。文本明确保留证据边界：已公开的信息、公司声明、计划、估计与预测不能互相替代，缺失的信息也不会被补写。`,
            timeContext: "截至 2026 年 9 月 15 日", claimType: (["reported_fact", "company_statement", "plan", "estimate", "forecast"] as const)[index]!,
            source: { title: `${section.title}来源`, url: index <= 1 ? longUrl : `https://sources.example/research/${index + 1}?module=${section.sectionId}&language=zh-CN` },
          },
          {
            text: `第 ${index + 1} 个模块的第二条事实用于验证同一章节中的多条事实不会被省略，并检查来源元数据与正文保持视觉关联。`,
            timeContext: null,
            claimType: "reported_fact",
            source: {
              title: `${section.title}补充来源`,
              url: index === 0 ? longUrl : index === 2 ? "javascript:alert(1)" : `https://sources.example/supplement/${index + 1}`,
            },
          },
        ],
      })),
    },
  };
}

describe("company research Word QA fixture", () => {
  it("writes the representative fixture with the production builder when requested", async () => {
    const output = process.env.DEEPFIELD_WORD_QA_OUT;
    if (!output) return;
    const run = qaRun();
    const structured = await buildCompanyResearchDocx(run, { raw: false, structured: true });
    const combined = await buildCompanyResearchDocx(run, { raw: true, structured: true });
    mkdirSync(output, { recursive: true });
    writeFileSync(join(output, "company-research-structured.docx"), structured);
    writeFileSync(join(output, "company-research-combined.docx"), combined);
    for (const buffer of [structured, combined]) {
      expect(buffer.subarray(0, 2).toString()).toBe("PK");
      expect(buffer.byteLength).toBeGreaterThan(10_000);
    }
  });
});
