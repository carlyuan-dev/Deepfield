import { Value } from "typebox/value";
import {
  StructuredResearchContentSchema,
  type CompanyResearchTemplateSnapshot,
  type StructuredResearchContent,
} from "@deepfield/contracts";

export const COMPANY_RESEARCH_HARNESS_VERSION = 1 as const;
const EMPTY_FACTS_SUMMARY = "现有公开信息不足以形成可靠的核心判断。";
const punctuation = /[!"#$%&'()*+,\-./:;<=>?@[\]\\^_`{|}~]/;
const unescapeMarkdown = (text: string): string => text.replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\]\\^_`{|}~])/g, "$1");
const referenceKey = (text: string): string => unescapeMarkdown(text).trim().replace(/\s+/g, " ").toLowerCase();
const sourceKey = (title: string, url: string): string => `${title}\u0000${url}`;

function isHttpUrl(url: string): boolean {
  if (!/^https?:\/\//i.test(url) || /[\s\u0000-\u001f\u007f]/u.test(url)) return false;
  try {
    const parsed = new URL(url);
    return (parsed.protocol === "http:" || parsed.protocol === "https:") && parsed.hostname.length > 0;
  } catch {
    return false;
  }
}

type Span = { value: string; end: number };
function escapedAt(text: string, index: number): boolean {
  return text[index] === "\\" && punctuation.test(text[index + 1] ?? "");
}

function readLabel(text: string, start: number): Span | undefined {
  let depth = 1;
  for (let i = start + 1; i < text.length; i++) {
    if (escapedAt(text, i)) { i++; continue; }
    if (text[i] === "\n" && /^\s*\n/.test(text.slice(i + 1))) return;
    if (text[i] === "[") depth++;
    if (text[i] === "]" && --depth === 0) {
      return { value: text.slice(start + 1, i), end: i + 1 };
    }
  }
}

function readDestination(text: string, start: number): Span | undefined {
  let i = start;
  if (text[i] === "<") {
    for (i++; i < text.length; i++) {
      if (escapedAt(text, i)) { i++; continue; }
      if (text[i] === "\n" || text[i] === "<") return;
      if (text[i] === ">") return { value: unescapeMarkdown(text.slice(start + 1, i)), end: i + 1 };
    }
    return;
  }
  let depth = 0;
  for (; i < text.length; i++) {
    if (escapedAt(text, i)) { i++; continue; }
    const char = text[i]!;
    if (/[\s\u0000-\u001f<>]/u.test(char)) break;
    if (char === "(") depth++;
    if (char === ")") {
      if (depth === 0) break;
      depth--;
    }
  }
  if (depth !== 0 || i === start) return;
  return { value: unescapeMarkdown(text.slice(start, i)), end: i };
}

function skipWhitespace(text: string, start: number): number {
  let i = start;
  while (i < text.length && /\s/u.test(text[i]!)) i++;
  return i;
}

function readTitleEnd(text: string, start: number): number | undefined {
  const opening = text[start];
  if (opening !== '"' && opening !== "'" && opening !== "(") return;
  const closing = opening === "(" ? ")" : opening;
  for (let i = start + 1; i < text.length; i++) {
    if (escapedAt(text, i)) { i++; continue; }
    if (text[i] === "\n" && /^[ \t]*\n/.test(text.slice(i + 1))) return;
    if (text[i] === closing) return i + 1;
    if (opening === "(" && text[i] === "(") return;
  }
}

function readInlineDestination(text: string, start: number): Span | undefined {
  const destination = readDestination(text, skipWhitespace(text, start + 1));
  if (!destination) return;
  let end = skipWhitespace(text, destination.end);
  if (end > destination.end && text[end] !== ")") {
    const titleEnd = readTitleEnd(text, end);
    if (titleEnd === undefined) return;
    end = skipWhitespace(text, titleEnd);
  }
  if (text[end] === ")" && !/\n[ \t]*\n/.test(text.slice(start, end))) {
    return { value: destination.value, end: end + 1 };
  }
}

function readHtmlTagEnd(text: string, start: number): number | undefined {
  if (!/^<\/?[A-Za-z][A-Za-z0-9-]*(?=[\s/>])/.test(text.slice(start))) return;
  let quote: string | undefined;
  for (let i = start + 1; i < text.length; i++) {
    const char = text[i];
    if (quote) {
      if (char === quote) quote = undefined;
    } else if (char === '"' || char === "'") quote = char;
    else if (char === ">") return i + 1;
    else if (char === "<") return;
  }
}

function containsLink(label: string, references: Map<string, string>): boolean {
  for (let i = 0; i < label.length; i++) {
    if (escapedAt(label, i)) { i++; continue; }
    if (label[i] === "<" && /^<https?:\/\/[^<>\s]+>/i.test(label.slice(i))) return true;
    if (label[i] !== "[") continue;
    const nested = readLabel(label, i);
    if (!nested) continue;
    if (label[nested.end] === "(" && readInlineDestination(label, nested.end)) return true;
    const ref = label[nested.end] === "[" ? readLabel(label, nested.end) : undefined;
    if (references.has(referenceKey(ref?.value || nested.value))) return true;
  }
  return false;
}

function opaqueInlineEnd(text: string, start: number): number | undefined {
  for (const [opening, closing] of [["<!--", "-->"], ["<?", "?>"], ["<![CDATA[", "]]>"]] as const) {
    if (text.startsWith(opening, start)) {
      const end = text.indexOf(closing, start + opening.length);
      return end < 0 ? text.length : end + closing.length;
    }
  }
  if (text[start] === "<") return readHtmlTagEnd(text, start);
  if (text[start] !== "`") return;
  const ticks = /^`+/.exec(text.slice(start))![0];
  let closing = text.indexOf(ticks, start + ticks.length);
  while (closing >= 0 && (text[closing - 1] === "`" || text[closing + ticks.length] === "`")) {
    closing = text.indexOf(ticks, closing + ticks.length);
  }
  return closing < 0 ? start + ticks.length : closing + ticks.length;
}

/** Focused Markdown link parser: inline and reference links, balanced destinations,
 * angle destinations and punctuation escapes. Code, images and HTML are not
 * evidence. Reference identifiers alone are normalized per Markdown syntax;
 * source labels/destinations are never trimmed or URL-canonicalized.
 */
export function extractMarkdownSources(markdown: string): Set<string> {
  const references = new Map<string, string>();
  let fence: { marker: string; length: number } | undefined;
  let htmlEnd: RegExp | undefined;
  const lines = markdown.split(/\r\n?|\n/).map((original) => {
    // Handle ordinary block quote/list containers before recognizing code blocks.
    const line = original.replace(/^(?: {0,3}>[ \t]?)+/, "")
      .replace(/^ {0,3}(?:[-+*]|\d+[.)])( +)/, (_match: string, spaces: string) => spaces.length > 4 ? spaces.slice(1) : "");
    if (fence) {
      const closing = /^ {0,3}(`+|~+)[ \t]*$/.exec(line);
      if (closing && closing[1]![0] === fence.marker && closing[1]!.length >= fence.length) fence = undefined;
      return "";
    }
    if (htmlEnd) {
      if (htmlEnd.test(line)) htmlEnd = undefined;
      return "";
    }
    const opening = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (opening && !(opening[1]![0] === "`" && opening[2]!.includes("`"))) {
      fence = { marker: opening[1]![0]!, length: opening[1]!.length };
      return "";
    }
    if (/^(?: {4}|\t)/.test(line)) return "";
    const specialHtml = /^ {0,3}(<!--|<\?|<!\[CDATA\[|<![A-Z])/.exec(line);
    if (specialHtml) {
      const closing = specialHtml[1] === "<!--" ? /-->/
        : specialHtml[1] === "<?" ? /\?>/
          : specialHtml[1] === "<![CDATA[" ? /\]\]>/ : />/;
      if (!closing.test(line)) htmlEnd = closing;
      // Inline comments with trailing real Markdown are handled by the scanner.
      else if (specialHtml[1] === "<!--") return line;
      return "";
    }
    const rawTag = /^ {0,3}<(script|pre|style|textarea)(?:\s|>|$)/i.exec(line);
    if (rawTag) {
      const closing = new RegExp(`</${rawTag[1]}>`, "i");
      if (!closing.test(line)) htmlEnd = closing;
      return "";
    }
    if (/^ {0,3}<\/?(?:address|article|aside|blockquote|body|details|div|dl|fieldset|figure|footer|form|h[1-6]|head|header|hr|html|iframe|li|main|nav|ol|p|section|table|tbody|td|th|thead|tr|ul)(?:\s|\/?>|$)/i.test(line)) {
      htmlEnd = /^\s*$/;
      return "";
    }
    const tagStart = /^ {0,3}</.exec(line);
    const tagEnd = tagStart ? readHtmlTagEnd(line, tagStart[0].length - 1) : undefined;
    if (tagEnd !== undefined && !line.slice(tagEnd).trim()) {
      htmlEnd = /^\s*$/;
      return "";
    }
    return line;
  });
  const blockText = lines.join("\n");
  // Record opaque spans before collecting definitions: a definition inside a
  // multiline code span, comment or HTML attribute cannot authorize a reference.
  const opaque: { start: number; end: number }[] = [];
  for (let i = 0; i < blockText.length;) {
    if (escapedAt(blockText, i)) { i += 2; continue; }
    const end = opaqueInlineEnd(blockText, i);
    if (end !== undefined) { opaque.push({ start: i, end }); i = end; }
    else i++;
  }
  let offset = 0;
  let spanIndex = 0;
  let previousDefinition = false;
  const text = lines.map((line, index) => {
    const start = offset;
    offset += line.length + 1;
    const canDefine = index === 0 || !lines[index - 1]!.trim() || previousDefinition;
    previousDefinition = false;
    while (opaque[spanIndex] && opaque[spanIndex]!.end <= start) spanIndex++;
    const span = opaque[spanIndex];
    const definitionStart = /^ {0,3}\[/.exec(line);
    if (definitionStart && canDefine) {
      const bracket = start + definitionStart[0].length - 1;
      if (span && span.start <= bracket && bracket < span.end) return line;
      const label = readLabel(line, definitionStart[0].length - 1);
      if (label && line[label.end] === ":") {
        const destination = readDestination(line, skipWhitespace(line, label.end + 1));
        if (destination) {
          let end = skipWhitespace(line, destination.end);
          if (end > destination.end && end < line.length) {
            const titleEnd = readTitleEnd(line, end);
            end = titleEnd === undefined ? -1 : skipWhitespace(line, titleEnd);
          }
          if (end === line.length) {
            const key = referenceKey(label.value);
            if (key && !references.has(key)) references.set(key, destination.value);
            previousDefinition = true;
            return "";
          }
        }
      }
    }
    return line;
  }).join("\n");
  const sources = new Set<string>();
  for (let i = 0; i < text.length;) {
    if (escapedAt(text, i)) { i += 2; continue; }
    if (text[i] === "<") {
      const autolink = /^<(https?:\/\/[^<>\s]+)>/i.exec(text.slice(i));
      if (autolink && isHttpUrl(autolink[1]!)) {
        sources.add(sourceKey(autolink[1]!, autolink[1]!));
        i += autolink[0].length;
        continue;
      }
    }
    const opaqueEnd = opaqueInlineEnd(text, i);
    if (opaqueEnd !== undefined) { i = opaqueEnd; continue; }
    const isImage = text[i] === "!" && text[i + 1] === "[";
    const start = isImage ? i + 1 : i;
    if (text[start] !== "[") { i++; continue; }
    const label = readLabel(text, start);
    if (!label) { i++; continue; }
    // Markdown forbids links within links; only the inner link is active.
    if (!isImage && containsLink(label.value, references)) { i++; continue; }
    let destination: Span | undefined;
    if (text[label.end] === "(") destination = readInlineDestination(text, label.end);
    else {
      const reference = text[label.end] === "[" ? readLabel(text, label.end) : undefined;
      const url = references.get(referenceKey(reference?.value || label.value));
      if (url !== undefined) destination = { value: url, end: reference?.end ?? label.end };
    }
    if (!destination) { i = isImage ? label.end : i + 1; continue; }
    const title = unescapeMarkdown(label.value);
    if (!isImage && title.trim() && !title.includes("\u0000") && isHttpUrl(destination.value)) {
      sources.add(sourceKey(title, destination.value));
    }
    i = destination.end;
  }
  return sources;
}

export function parseStructuredCandidate(text: string): unknown {
  const trimmed = text.trim();
  const fence = /^```json[ \t]*\r?\n([\s\S]*?)\r?\n```$/.exec(trimmed);
  const candidate: unknown = JSON.parse(fence ? fence[1]! : trimmed);
  if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new Error("Structured research must be one JSON object");
  }
  return candidate;
}

function requireNonblank(text: string): void {
  if (!text.trim()) throw new Error("Structured research text must be nonblank");
}

export function validateStructuredResearch(
  candidateText: string,
  rawMarkdown: string,
  template: CompanyResearchTemplateSnapshot,
): StructuredResearchContent {
  const candidate = parseStructuredCandidate(candidateText);
  if (!Value.Check(StructuredResearchContentSchema, candidate)) {
    throw new Error("Structured research does not match the content schema");
  }
  if (candidate.sections.length !== template.sections.length) {
    throw new Error("Structured research must match the template sections");
  }
  const sources = extractMarkdownSources(rawMarkdown);
  candidate.coreSummary.forEach(requireNonblank);
  for (const [index, section] of candidate.sections.entries()) {
    if (section.sectionId !== template.sections[index]!.sectionId) {
      throw new Error("Structured research sections must be in exact template order");
    }
    if (section.summary !== null) requireNonblank(section.summary);
    const count = section.facts.length;
    const validStatus = section.status === "not_found"
      ? section.summary === null && count === 0
      : section.status === "not_disclosed"
        ? section.summary === null && count >= 1
        : section.summary !== null && count >= (section.status === "conflicting" ? 2 : 1);
    if (!validStatus) throw new Error("Structured research status and content disagree");
    for (const fact of section.facts) {
      requireNonblank(fact.text);
      if (fact.timeContext !== null) requireNonblank(fact.timeContext);
      requireNonblank(fact.source.title);
      requireNonblank(fact.source.url);
      if (!sources.has(sourceKey(fact.source.title, fact.source.url))) {
        throw new Error("Structured research source must match a raw Markdown title and URL pair");
      }
    }
  }
  const allFactsEmpty = candidate.sections.every((section) => section.facts.length === 0);
  if (allFactsEmpty
    ? candidate.coreSummary.length !== 1 || candidate.coreSummary[0] !== EMPTY_FACTS_SUMMARY
    : candidate.coreSummary.some((summary) => summary.trim() === EMPTY_FACTS_SUMMARY)) {
    throw new Error("Structured research must use the fixed fallback only when all facts are empty");
  }
  return candidate;
}
