import {
  AlignmentType,
  BorderStyle,
  Document,
  ExternalHyperlink,
  HeadingLevel,
  PageBreak,
  Packer,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableLayoutType,
  TableRow,
  TextRun,
  VerticalAlign,
  WidthType,
  type FileChild,
  type IParagraphOptions,
  type ParagraphChild,
} from "docx";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import { Value } from "typebox/value";
import { CompanyResearchWordExportSelectionSchema, type CompanyResearchWordExportSelection } from "../contracts/ipc.js";
import { RESEARCH_SECTION_STATUS_LABELS, type KeyResearchRun, type ResearchRun } from "../contracts/index.js";

type MdNode = {
  type: string;
  value?: string;
  url?: string;
  alt?: string;
  identifier?: string;
  ordered?: boolean;
  start?: number;
  depth?: number;
  children?: MdNode[];
};

type MarkdownContext = {
  definitions: Map<string, string>;
  sources: Map<string, string>;
  numbering: Array<{
    reference: string;
    levels: Array<{
      level: number;
      format: "bullet" | "decimal";
      text: string;
      start?: number;
      alignment: "left";
      style: { paragraph: { indent: { left: number; hanging: number } } };
    }>;
  }>;
  nextNumberingId: number;
};

const BODY_FONT = { ascii: "Aptos", hAnsi: "Aptos", eastAsia: "Microsoft YaHei" } as const;
const CODE_FONT = { ascii: "Courier New", hAnsi: "Courier New", eastAsia: "Microsoft YaHei" } as const;
const SAFE_LINK = /^https?:$/;
const TABLE_BORDER = { style: BorderStyle.SINGLE, size: 4, color: "D9D9D9" } as const;
const TABLE_BORDERS = {
  top: TABLE_BORDER, bottom: TABLE_BORDER, left: TABLE_BORDER, right: TABLE_BORDER,
  insideHorizontal: TABLE_BORDER, insideVertical: TABLE_BORDER,
} as const;
function numberingLevels(format: "bullet" | "decimal", start = 1) {
  return Array.from({ length: 6 }, (_, level) => ({
    level,
    format,
    text: format === "bullet" ? (level % 2 === 0 ? "•" : "◦") : `%${level + 1}.`,
    ...(format === "decimal" ? { start } : {}),
    alignment: AlignmentType.LEFT,
    style: { paragraph: { indent: { left: 480 + level * 360, hanging: 240 } } },
  }));
}

function isSafeLink(value: string): boolean {
  try {
    return SAFE_LINK.test(new URL(value).protocol);
  } catch {
    return false;
  }
}

function plainText(node: MdNode): string {
  if (node.type === "image" || node.type === "imageReference") return node.alt ?? "图片";
  if (typeof node.value === "string") return node.value;
  return (node.children ?? []).map(plainText).join("");
}

function sourceUrl(node: MdNode, context: MarkdownContext): string | undefined {
  if (node.type === "link" || node.type === "image") return node.url;
  if (node.type === "linkReference" || node.type === "imageReference") {
    return context.definitions.get((node.identifier ?? "").toLowerCase());
  }
  return undefined;
}

function recordSource(context: MarkdownContext, url: string, title: string): void {
  if (isSafeLink(url) && !context.sources.has(url)) context.sources.set(url, title.trim() || url);
}

function inlineChildren(nodes: readonly MdNode[], context: MarkdownContext, style: { bold?: boolean; italics?: boolean } = {}): ParagraphChild[] {
  const children: ParagraphChild[] = [];
  for (const node of nodes) {
    if (node.type === "text") {
      children.push(new TextRun({ text: node.value ?? "", ...style }));
    } else if (node.type === "strong") {
      children.push(...inlineChildren(node.children ?? [], context, { ...style, bold: true }));
    } else if (node.type === "emphasis") {
      children.push(...inlineChildren(node.children ?? [], context, { ...style, italics: true }));
    } else if (node.type === "delete") {
      children.push(new TextRun({ text: plainText(node), ...style, strike: true }));
    } else if (node.type === "inlineCode") {
      children.push(new TextRun({ text: node.value ?? "", ...style, font: CODE_FONT }));
    } else if (node.type === "html") {
      children.push(new TextRun({ text: node.value ?? "", ...style }));
    } else if (node.type === "break") {
      children.push(new TextRun({ text: "", break: 1, ...style }));
    } else if (node.type === "link" || node.type === "linkReference") {
      const rawUrl = sourceUrl(node, context);
      const rawLabel = plainText(node);
      const trailing = node.type === "link" && rawUrl === rawLabel ? rawUrl?.match(/[。；，：！？]+$/u)?.[0] ?? "" : "";
      const url = trailing ? rawUrl!.slice(0, -trailing.length) : rawUrl;
      const label = trailing ? rawLabel.slice(0, -trailing.length) : rawLabel || url || "链接";
      if (url && isSafeLink(url)) {
        recordSource(context, url, label);
        children.push(new ExternalHyperlink({
          link: url,
          children: [new TextRun({ text: label, color: "0563C1", underline: { type: "single" }, ...style })],
        }));
        if (trailing) children.push(new TextRun({ text: trailing, ...style }));
      } else {
        children.push(new TextRun({ text: url ? `${label}（${url}）` : label, ...style }));
      }
    } else if (node.type === "image" || node.type === "imageReference") {
      const url = sourceUrl(node, context);
      const label = node.alt?.trim() || "图片";
      children.push(new TextRun({ text: url ? `图片：${label}（${url}）` : `图片：${label}`, ...style }));
    } else {
      children.push(...inlineChildren(node.children ?? [], context, style));
    }
  }
  return children;
}

function paragraphFromInline(nodes: readonly MdNode[], context: MarkdownContext, options: IParagraphOptions = {}): Paragraph {
  return new Paragraph({ ...options, children: inlineChildren(nodes, context) });
}

function markdownTable(node: MdNode, context: MarkdownContext): Table {
  const rows = node.children ?? [];
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    layout: TableLayoutType.AUTOFIT,
    borders: TABLE_BORDERS,
    margins: { top: 100, bottom: 100, left: 120, right: 120, marginUnitType: WidthType.DXA },
    rows: rows.map((row, rowIndex) => new TableRow({
      tableHeader: rowIndex === 0,
      cantSplit: rowIndex === 0,
      children: (row.children ?? []).map((cell) => new TableCell({
        verticalAlign: VerticalAlign.CENTER,
        ...(rowIndex === 0 ? { shading: { type: ShadingType.CLEAR, fill: "D9EAF7", color: "auto" } }
          : rowIndex % 2 === 0 ? { shading: { type: ShadingType.CLEAR, fill: "F7FAFC", color: "auto" } } : {}),
        borders: TABLE_BORDERS,
        margins: { top: 100, bottom: 100, left: 120, right: 120, marginUnitType: WidthType.DXA },
        children: [paragraphFromInline(cell.children ?? [], context, {
          spacing: { before: 0, after: 0 },
          ...(rowIndex === 0 ? { run: { bold: true } } : {}),
        })],
      })),
    })),
  });
}

function markdownBlocks(markdown: string, context: MarkdownContext): FileChild[] {
  const root = unified().use(remarkParse).use(remarkGfm).parse(markdown) as MdNode;
  const collectDefinitions = (nodes: readonly MdNode[]): void => {
    for (const node of nodes) {
      if (node.type === "definition" && node.identifier && node.url) {
        context.definitions.set(node.identifier.toLowerCase(), node.url);
      }
      collectDefinitions(node.children ?? []);
    }
  };
  collectDefinitions(root.children ?? []);
  const render = (nodes: readonly MdNode[], listDepth = 0): FileChild[] => {
    const output: FileChild[] = [];
    for (const node of nodes) {
      if (node.type === "definition") continue;
      if (node.type === "heading") {
        const level = Math.min(6, Math.max(1, node.depth ?? 2));
        output.push(new Paragraph({
          heading: ([HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3, HeadingLevel.HEADING_4, HeadingLevel.HEADING_5, HeadingLevel.HEADING_6] as const)[level - 1]!,
          children: inlineChildren(node.children ?? [], context),
        }));
      } else if (node.type === "paragraph") {
        output.push(paragraphFromInline(node.children ?? [], context));
      } else if (node.type === "list") {
        const numberingReference = node.ordered ? `deepfield-numbered-${context.nextNumberingId++}` : "deepfield-bullets";
        if (node.ordered) context.numbering.push({ reference: numberingReference, levels: numberingLevels("decimal", node.start ?? 1) });
        for (const item of node.children ?? []) {
          const itemChildren = item.children ?? [];
          const first = itemChildren[0];
          if (first?.type === "paragraph") {
            output.push(paragraphFromInline(first.children ?? [], context, node.ordered
              ? { numbering: { reference: numberingReference, level: Math.min(listDepth, 5) } }
              : { numbering: { reference: "deepfield-bullets", level: Math.min(listDepth, 5) } }));
          }
          output.push(...render(itemChildren.slice(first?.type === "paragraph" ? 1 : 0), listDepth + 1));
        }
      } else if (node.type === "blockquote") {
        for (const block of node.children ?? []) {
          if (block.type === "paragraph") output.push(paragraphFromInline(block.children ?? [], context, {
            indent: { left: 480, right: 240 },
            run: { italics: true, color: "404040" },
          }));
          else output.push(...render([block], listDepth));
        }
      } else if (node.type === "table") {
        output.push(markdownTable(node, context));
      } else if (node.type === "code") {
        for (const line of (node.value ?? "").split("\n")) {
          output.push(new Paragraph({ style: "Code", children: [new TextRun({ text: line || " ", font: CODE_FONT })] }));
        }
      } else if (node.type === "html") {
        output.push(new Paragraph({ text: node.value ?? "" }));
      } else if (node.type === "thematicBreak") {
        output.push(new Paragraph({ text: "" }));
      } else {
        output.push(...render(node.children ?? [], listDepth));
      }
    }
    return output;
  };
  return render(root.children ?? []);
}

function metadataRow(label: string, value: string): TableRow {
  return new TableRow({
    cantSplit: true,
    children: [
      new TableCell({
        width: { size: 28, type: WidthType.PERCENTAGE }, verticalAlign: VerticalAlign.CENTER,
        shading: { type: ShadingType.CLEAR, fill: "EAF2F8", color: "auto" }, borders: TABLE_BORDERS,
        margins: { top: 100, bottom: 100, left: 120, right: 120, marginUnitType: WidthType.DXA },
        children: [new Paragraph({ spacing: { before: 0, after: 0 }, children: [new TextRun({ text: label, bold: true })] })],
      }),
      new TableCell({
        width: { size: 72, type: WidthType.PERCENTAGE }, verticalAlign: VerticalAlign.CENTER, borders: TABLE_BORDERS,
        margins: { top: 100, bottom: 100, left: 120, right: 120, marginUnitType: WidthType.DXA },
        children: [new Paragraph({ spacing: { before: 0, after: 0 }, text: value })],
      }),
    ],
  });
}

function formatTimestamp(value: string | undefined): string {
  if (!value) return "未知";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "未知";
  const values = Object.fromEntries(new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(date).map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day} ${values.hour}:${values.minute}`;
}

function warningParagraph(label: string, text: string): Paragraph {
  return new Paragraph({
    keepNext: false,
    children: [new TextRun({ text: `${label}：`, bold: true }), new TextRun(text)],
  });
}

function safeSourceChildren(title: string, url: string, context: MarkdownContext): ParagraphChild[] {
  if (!isSafeLink(url)) return [new TextRun(`${title}（来源链接不可用：${url}）`)];
  recordSource(context, url, title);
  const hyperlink = new ExternalHyperlink({ link: url, children: [new TextRun({ text: url, color: "0563C1", underline: { type: "single" } })] });
  return title.trim() === url ? [hyperlink] : [new TextRun({ text: `${title} `, bold: true }), hyperlink];
}

const CHINESE_SECTION_NUMBERS = ["一", "二", "三", "四", "五", "六", "七", "八", "九", "十"] as const;

function structuredSourceUrlChildren(url: string, citationNumber: number): ParagraphChild[] {
  const marker = new TextRun(`[${citationNumber}] `);
  if (!isSafeLink(url)) return [marker, new TextRun(`${url}（来源链接不可用）`)];
  const hyperlink = new ExternalHyperlink({ link: url, children: [new TextRun({ text: url, color: "0563C1", underline: { type: "single" } })] });
  return [marker, hyperlink];
}

function structuredBlocks(run: KeyResearchRun, combined: boolean): FileChild[] {
  const content = run.structuredContent;
  if (!content) return [];
  const citationNumbers = new Map<string, number>();
  const citationNumberFor = (url: string): number => {
    const existing = citationNumbers.get(url);
    if (existing !== undefined) return existing;
    const assigned = citationNumbers.size + 1;
    citationNumbers.set(url, assigned);
    return assigned;
  };
  const children: FileChild[] = [
    ...(combined ? [new Paragraph({ children: [new PageBreak()] })] : []),
    new Paragraph({ style: "Title", text: `${run.researchContext.companyName} ${run.template.title}调研报告` }),
    new Paragraph({ spacing: { line: 336, after: 80 }, children: [
      new TextRun({ text: `研究主题：${run.researchContext.topicName}　` }),
      new TextRun({ text: `研究方向：${run.template.title}` }),
    ] }),
    new Paragraph({ spacing: { line: 336, after: 180 }, children: [
      new TextRun({ text: `重点范围：${run.focusScope?.trim() || "未指定"}　` }),
      new TextRun({ text: `截至日期：${run.asOfDate}` }),
    ] }),
    warningParagraph("核验提示", "AI 调研结果仅供参考，重要事实、预测与来源仍需人工核验。"),
    ...(!combined && run.searchStatus === "none" ? [warningParagraph("联网状态提示", "本次报告未成功完成联网搜索，内容的时效性与来源尚未核验。")] : []),
    ...(!combined && (run.searchStatus ?? "unknown") === "unknown" ? [warningParagraph("联网状态提示", "此历史报告未记录联网搜索状态，无法确认是否成功联网。")] : []),
    new Paragraph({ heading: HeadingLevel.HEADING_2, text: "核心结论" }),
    ...content.coreSummary.map((text) => new Paragraph({ numbering: { reference: "deepfield-bullets", level: 0 }, spacing: { line: 336, after: 140 }, text })),
  ];
  for (const [index, templateSection] of run.template.sections.entries()) {
    const section = content.sections.find((candidate) => candidate.sectionId === templateSection.sectionId);
    children.push(new Paragraph({ heading: HeadingLevel.HEADING_2, text: `${CHINESE_SECTION_NUMBERS[index] ?? index + 1}、${templateSection.title}` }));
    if (!section) {
      children.push(warningParagraph("资料状态", "本节内容未保存在结构化报告中。"));
      continue;
    }
    if (section.status !== "found" && section.status !== "partial") {
      children.push(new Paragraph({ keepNext: section.summary !== null || section.facts.length > 0, spacing: { line: 336, after: 100 }, children: [
        new TextRun({ text: `资料状态：${RESEARCH_SECTION_STATUS_LABELS[section.status]}`, bold: true, color: "595959" }),
      ] }));
    }
    if (section.summary) children.push(new Paragraph({ keepNext: section.facts.length > 0, spacing: { line: 336, after: 140 }, text: section.summary }));
    if (section.facts.length === 0) continue;
    for (const fact of section.facts) {
      const citationNumber = citationNumberFor(fact.source.url);
      children.push(new Paragraph({
        numbering: { reference: "deepfield-bullets", level: 0 },
        children: [new TextRun({ text: fact.text }), new TextRun({ text: ` [${citationNumber}]` })],
        spacing: { line: 336, after: 140 },
      }));
    }
    const sourceUrls = [...new Set(section.facts.map((fact) => fact.source.url))];
    children.push(
      new Paragraph({ heading: HeadingLevel.HEADING_3, text: "资料来源" }),
      ...sourceUrls.map((url) => new Paragraph({
        spacing: { line: 336, after: 120 },
        children: structuredSourceUrlChildren(url, citationNumberFor(url)),
      })),
    );
  }
  return children;
}

function sourceAppendix(context: MarkdownContext): FileChild[] {
  if (context.sources.size === 0) return [];
  return [
    new Paragraph({ heading: HeadingLevel.HEADING_1, text: "来源附录" }),
    ...[...context.sources].map(([url, title]) => new Paragraph({
      numbering: { reference: "deepfield-sources", level: 0 },
      children: safeSourceChildren(title, url, context),
    })),
  ];
}

export async function buildCompanyResearchDocx(run: ResearchRun, selection: CompanyResearchWordExportSelection): Promise<Buffer> {
  if (!Value.Check(CompanyResearchWordExportSelectionSchema, selection) || (!selection.raw && !selection.structured)) {
    throw new Error("invalid report stage selection");
  }
  const context: MarkdownContext = {
    definitions: new Map(), sources: new Map(), nextNumberingId: 1,
    numbering: [
      { reference: "deepfield-bullets", levels: numberingLevels("bullet") },
      { reference: "deepfield-sources", levels: numberingLevels("decimal") },
    ],
  };
  const isLegacy = run.schemaVersion === "legacy-freeform-v1";
  const companyName = isLegacy ? "历史调研" : run.researchContext.companyName;
  const title = isLegacy ? "历史旧版报告" : `${companyName} ${run.template.title} 调研报告`;
  const reportText = isLegacy ? run.reportText : run.rawReportText ?? "";
  const generatedAt = formatTimestamp(isLegacy ? run.completedAt : run.completedAt ?? run.rawCompletedAt);
  const metadata = isLegacy
    ? [
      ["公司与研究主题", "旧版报告未记录"], ["调研时间范围", run.timeScope],
      ["补充要求", run.customRequirements ?? "未记录"], ["报告生成时间", generatedAt],
      ["运行标识", `${run.id} / legacy-freeform-v1`],
    ]
    : [
      ["公司", run.researchContext.companyName], ["研究主题", run.researchContext.topicName],
      ["研究方向", run.template.title], ["重点研究范围", run.focusScope?.trim() || "未指定"],
      ["截止日期", run.asOfDate], ["报告生成时间", generatedAt],
      ["运行与版本", `${run.id} / ${run.schemaVersion} / 模板 v${run.template.templateVersion} / Harness v${run.harnessVersion}`],
    ];
  const children: FileChild[] = [];
  if (selection.raw) {
    children.push(
      new Paragraph({ style: "Title", text: title }),
      new Paragraph({ text: "本文档忠实导出已保存的调研内容，包括研究背景、原始报告、可用的结构化报告与实际来源链接。" }),
      warningParagraph("核验提示", "AI 调研结果仅供参考，重要事实、预测与来源仍需人工核验。"),
    );
    if (isLegacy) children.push(new Paragraph({ text: "公司与研究主题：旧版报告未记录。" }));
    const searchStatus = run.searchStatus ?? "unknown";
    if (searchStatus === "none") children.push(warningParagraph("联网状态提示", "本次报告未成功完成联网搜索，内容的时效性与来源尚未核验。"));
    else if (searchStatus === "unknown") children.push(warningParagraph("联网状态提示", "此历史报告未记录联网搜索状态，无法确认是否成功联网。"));
    if (!isLegacy && run.status === "research_failed") children.push(warningParagraph("完整性提示", "本次调研未正常完成，以下内容是失败前已保存的原始报告，可能不完整。"));
    if (!isLegacy && run.status === "structure_failed") children.push(warningParagraph("结构化整理提示", "第二轮结构化整理未完成，本文档仅包含已保存的第一轮原始报告。"));
    if (!isLegacy && run.status === "completed" && !run.structuredContent) children.push(warningParagraph("结构化内容提示", "已保存记录未包含结构化报告，本文档仅包含已保存的第一轮原始报告。"));
    children.push(
      new Paragraph({ heading: HeadingLevel.HEADING_1, text: "研究元数据" }),
      new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, layout: TableLayoutType.FIXED, columnWidths: [2600, 6700], borders: TABLE_BORDERS, rows: metadata.map(([label, value]) => metadataRow(label!, value!)) }),
      new Paragraph({ heading: HeadingLevel.HEADING_1, text: isLegacy ? "第一轮 旧版原始报告" : "第一轮 原始调研报告" }),
      ...markdownBlocks(reportText, context),
      ...sourceAppendix(context),
    );
  }
  if (selection.structured) {
    if (isLegacy || !run.structuredContent) throw new Error("structured report is unavailable");
    children.push(...structuredBlocks(run, selection.raw));
  }

  const document = new Document({
    title,
    creator: "Deepfield",
    description: "Deepfield 保存的公司调研报告导出",
    styles: {
      default: {
        document: { run: { font: BODY_FONT, size: 22, color: "000000", language: { eastAsia: "zh-CN" } }, paragraph: { spacing: { line: selection.raw ? 330 : 336, after: 160 } } },
        title: { run: { font: BODY_FONT, size: 34, bold: true, color: "000000" }, paragraph: { spacing: { before: 0, after: 280 }, keepNext: true } },
        heading1: { run: { font: BODY_FONT, size: 28, bold: true, color: "000000" }, paragraph: { spacing: { before: 320, after: 140 }, keepNext: true } },
        heading2: { run: { font: BODY_FONT, size: 24, bold: true, color: "000000" }, paragraph: { spacing: { before: 240, after: 100 }, keepNext: true } },
        heading3: { run: { font: BODY_FONT, size: 22, bold: true, color: "000000" }, paragraph: { spacing: { before: 180, after: 80 }, keepNext: true } },
      },
      paragraphStyles: [{
        id: "Code", name: "Code", basedOn: "Normal", next: "Normal",
        run: { font: CODE_FONT, size: 20, color: "202020" },
        paragraph: { indent: { left: 360 }, spacing: { before: 0, after: 40, line: 280 } },
      }],
    },
    numbering: {
      config: context.numbering,
    },
    sections: [{
      properties: { page: { size: selection.raw && !selection.structured ? { width: 12240, height: 15840 } : { width: 11906, height: 16838 }, margin: { top: 1080, right: 1080, bottom: 1080, left: 1080, header: 540, footer: 540 } } },
      children,
    }],
  });
  return Packer.toBuffer(document);
}
