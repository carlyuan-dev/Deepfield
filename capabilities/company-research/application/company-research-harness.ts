import { Value } from "typebox/value";
import { StructuredResearchContentSchema, type CompanyResearchModelErrorCategory, type CompanyResearchValidationIssue, type CompanyResearchTemplateSnapshot, type StructuredResearchContent } from "../contracts/index.js";

export const COMPANY_RESEARCH_HARNESS_VERSION = 1 as const;
const EMPTY_FACTS_SUMMARY = "现有公开信息不足以形成可靠的核心判断。";
const punctuation = /[!"#$%&'()*+,\-./:;<=>?@[\]\\^_`{|}~]/;
const unescapeMarkdown = (text: string): string => text.replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\]\\^_`{|}~])/g, "$1");
const referenceKey = (text: string): string => unescapeMarkdown(text).trim().replace(/\s+/g, " ").toLowerCase();
const sourceKey = (title: string, url: string): string => `${title}\u0000${url}`;

type StructureCategory = Extract<CompanyResearchModelErrorCategory, "json_parse" | "schema_invalid" | "shape_invalid" | "status_invalid" | "source_mismatch">;
export type StructuredResearchRepairHint =
  | { kind: "json_syntax"; position: number }
  | { kind: "multiple_top_level_objects"; count: number };
export class StructuredResearchValidationError extends Error {
  constructor(
    readonly category: StructureCategory,
    readonly issues: CompanyResearchValidationIssue[] = [],
    readonly repairHint?: StructuredResearchRepairHint,
  ) {
    super(category);
    this.name = "StructuredResearchValidationError";
  }
}

function actualType(value: unknown): CompanyResearchValidationIssue["actual"] {
  return value === null ? "null" : Array.isArray(value) ? "array" : ["object", "string", "number", "boolean", "undefined"].includes(typeof value)
    ? typeof value as CompanyResearchValidationIssue["actual"] : "undefined";
}
function safePath(path: string): string {
  return path.split("/").slice(1, 9).map((part) => /^(?:[A-Za-z][A-Za-z0-9_-]*|[0-9]{1,3})$/u.test(part) ? `/${part}` : "/*").join("").slice(0, 160);
}
function atPath(value: unknown, path: string): unknown {
  for (const segment of path.split("/").slice(1)) {
    if (typeof value !== "object" || value === null) return undefined;
    value = (value as Record<string, unknown>)[segment.replace(/~1/gu, "/").replace(/~0/gu, "~")];
  }
  return value;
}
function schemaIssues(value: unknown): CompanyResearchValidationIssue[] {
  return Value.Errors(StructuredResearchContentSchema, value).slice(0, 20).map((error) => {
    const params = error.params as Record<string, unknown>;
    const required = error.keyword === "required" && Array.isArray(params.requiredProperties) ? params.requiredProperties[0] : undefined;
    const rawPath = `${error.instancePath}${typeof required === "string" ? `/${required}` : ""}`;
    const path = safePath(rawPath);
    const expected = error.keyword === "required" ? "required" : error.keyword === "additionalProperties" ? "allowed_property"
      : error.keyword === "const" || error.keyword === "enum" ? "enum" : error.keyword === "type" && typeof params.type === "string" ? params.type : "schema";
    return { path, expected, actual: actualType(atPath(value, rawPath)) };
  });
}

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
  const sourceLines = markdown.split(/\r\n?|\n/).map((original) => {
    // Handle ordinary block quote/list containers before recognizing code blocks.
    return original.replace(/^(?: {0,3}>[ \t]?)+/, "")
      .replace(/^ {0,3}(?:[-+*]|\d+[.)])( +)/, (_match: string, spaces: string) => spaces.length > 4 ? spaces.slice(1) : "");
  });
  const closedFenceLines = new Set<number>();
  const lines = sourceLines.map((line, index) => {
    if (fence) {
      const closing = /^ {0,3}(`+|~+)[ \t]*$/.exec(line);
      if (closing && closing[1]![0] === fence.marker && closing[1]!.length >= fence.length) {
        fence = undefined;
        closedFenceLines.add(index);
      }
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
    // A recognized block ending is a boundary; filtered paragraph content is not.
    const canDefine = index === 0 || !sourceLines[index - 1]!.trim()
      || closedFenceLines.has(index - 1) || previousDefinition;
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

function topLevelObjectSlices(text: string): string[] | undefined {
  const slices: string[] = [];
  let index = 0;
  while (index < text.length) {
    index = skipWhitespace(text, index);
    if (index === text.length) break;
    if (text[index] !== "{") return;
    const start = index;
    let depth = 0;
    let inString = false;
    for (; index < text.length; index++) {
      const char = text[index]!;
      if (inString) {
        if (char === "\\") index++;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') inString = true;
      else if (char === "{") depth++;
      else if (char === "}" && --depth === 0) {
        index++;
        slices.push(text.slice(start, index));
        break;
      }
    }
    if (depth !== 0 || inString) return;
  }
  return slices.length > 0 ? slices : undefined;
}

function hasDuplicateJsonObjectKeys(text: string): boolean {
  const objects: Array<Set<string> | undefined> = [];
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!;
    if (char === "{") { objects.push(new Set()); continue; }
    if (char === "[") { objects.push(undefined); continue; }
    if (char === "}" || char === "]") { objects.pop(); continue; }
    if (char !== '"') continue;
    const start = index;
    for (index++; index < text.length; index++) {
      if (text[index] === "\\") index++;
      else if (text[index] === '"') break;
    }
    const object = objects.at(-1);
    const next = skipWhitespace(text, index + 1);
    if (object === undefined || text[next] !== ":") continue;
    const key = JSON.parse(text.slice(start, index + 1)) as string;
    if (object.has(key)) return true;
    object.add(key);
  }
  return false;
}

function structuralSyntaxPosition(text: string): number | undefined {
  const stack: string[] = [];
  let inString = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!;
    if (inString) {
      if (char === "\\") index++;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{" || char === "[") stack.push(char);
    else if (char === "}" || char === "]") {
      const expected = char === "}" ? "{" : "[";
      if (stack.at(-1) !== expected) return index;
      stack.pop();
    }
  }
  return inString || stack.length > 0 ? text.length : undefined;
}

function jsonSyntaxRepairHint(error: unknown, text: string): StructuredResearchRepairHint {
  const positionMatch = error instanceof SyntaxError ? /\bposition\s+(\d+)\b/iu.exec(error.message) : null;
  let position = positionMatch === null ? structuralSyntaxPosition(text) : Number(positionMatch[1]);
  if (position === undefined) {
    const lineMatch = error instanceof SyntaxError ? /\bline\s+(\d+)\s+column\s+(\d+)\b/iu.exec(error.message) : null;
    if (lineMatch !== null) {
      const line = Number(lineMatch[1]);
      const column = Number(lineMatch[2]);
      if (Number.isSafeInteger(line) && line >= 1 && Number.isSafeInteger(column) && column >= 1) {
        const lines = text.split("\n", line);
        if (lines.length === line) position = lines.slice(0, -1).reduce((total, value) => total + value.length + 1, 0) + column - 1;
      }
    }
  }
  return { kind: "json_syntax", position: Number.isSafeInteger(position) && position! >= 0 ? position! : text.length };
}

export function parseStructuredCandidate(text: string): unknown {
  const trimmed = text.trim();
  const fence = /^```json[ \t]*\r?\n([\s\S]*?)\r?\n```$/.exec(trimmed);
  const payload = fence ? fence[1]! : trimmed;
  let candidate: unknown;
  try { candidate = JSON.parse(payload); }
  catch (error) {
    const slices = topLevelObjectSlices(payload);
    if (slices && slices.length >= 2) {
      try {
        const objects = slices.map((slice) => JSON.parse(slice) as Record<string, unknown>);
        const duplicateKey = slices.some(hasDuplicateJsonObjectKeys);
        if (!duplicateKey && objects.length === 2) {
          const firstKeys = Object.keys(objects[0]!);
          const secondKeys = Object.keys(objects[1]!);
          if (firstKeys.length === 1 && secondKeys.length === 1 &&
            new Set([firstKeys[0], secondKeys[0]]).size === 2 &&
            [firstKeys[0], secondKeys[0]].every((key) => key === "coreSummary" || key === "sections")) {
            const summaryObject = firstKeys[0] === "coreSummary" ? objects[0]! : objects[1]!;
            const sectionsObject = firstKeys[0] === "sections" ? objects[0]! : objects[1]!;
            return { coreSummary: summaryObject.coreSummary, sections: sectionsObject.sections };
          }
        }
        throw new StructuredResearchValidationError("json_parse", [{
          path: "", expected: duplicateKey ? "unique_json_keys" : "single_json_object", actual: "string",
        }], { kind: "multiple_top_level_objects", count: objects.length });
      } catch (splitError) {
        if (splitError instanceof StructuredResearchValidationError) throw splitError;
      }
    }
    throw new StructuredResearchValidationError("json_parse", [
      { path: "", expected: "valid_json_syntax", actual: "string" },
    ], jsonSyntaxRepairHint(error, payload));
  }
  if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new StructuredResearchValidationError("shape_invalid", [{ path: "", expected: "object", actual: actualType(candidate) }]);
  }
  return candidate;
}

function requireNonblank(text: string): void {
  if (!text.trim()) throw new StructuredResearchValidationError("shape_invalid", [{ path: "", expected: "nonblank", actual: "string" }]);
}

function validateStructuredResearchCandidate(
  candidateText: string,
  template: CompanyResearchTemplateSnapshot,
  rawSources?: Set<string>,
): StructuredResearchContent {
  const candidate = parseStructuredCandidate(candidateText);
  if (!Value.Check(StructuredResearchContentSchema, candidate)) {
    throw new StructuredResearchValidationError("schema_invalid", schemaIssues(candidate));
  }
  if (candidate.sections.length !== template.sections.length) {
    throw new StructuredResearchValidationError("shape_invalid", [{ path: "/sections", expected: "template_sections", actual: "array" }]);
  }
  candidate.coreSummary.forEach(requireNonblank);
  for (const [index, section] of candidate.sections.entries()) {
    if (section.sectionId !== template.sections[index]!.sectionId) {
      throw new StructuredResearchValidationError("shape_invalid", [{ path: `/sections/${index}/sectionId`, expected: "template_order", actual: "string" }]);
    }
    if (section.summary !== null) requireNonblank(section.summary);
    const count = section.facts.length;
    const validStatus = section.status === "not_found"
      ? section.summary === null && count === 0
      : section.status === "not_disclosed"
        ? section.summary === null && count >= 1
        : section.summary !== null && count >= (section.status === "conflicting" ? 2 : 1);
    if (!validStatus) throw new StructuredResearchValidationError("status_invalid", [{ path: `/sections/${index}/status`, expected: "status_content_pairing", actual: "string" }]);
    for (const fact of section.facts) {
      requireNonblank(fact.text);
      if (fact.timeContext !== null) requireNonblank(fact.timeContext);
      requireNonblank(fact.source.title);
      requireNonblank(fact.source.url);
      if (!isHttpUrl(fact.source.url)) {
        throw new StructuredResearchValidationError(rawSources === undefined ? "shape_invalid" : "source_mismatch", [{ path: `/sections/${index}/facts`, expected: rawSources === undefined ? "http_source_url" : "raw_source_pair", actual: "array" }]);
      }
      if (rawSources !== undefined && !rawSources.has(sourceKey(fact.source.title, fact.source.url))) {
        throw new StructuredResearchValidationError("source_mismatch", [{ path: `/sections/${index}/facts`, expected: "raw_source_pair", actual: "array" }]);
      }
    }
  }
  const allFactsEmpty = candidate.sections.every((section) => section.facts.length === 0);
  if (allFactsEmpty
    ? candidate.coreSummary.length !== 1 || candidate.coreSummary[0] !== EMPTY_FACTS_SUMMARY
    : candidate.coreSummary.some((summary) => summary.trim() === EMPTY_FACTS_SUMMARY)) {
    throw new StructuredResearchValidationError("shape_invalid", [{ path: "/coreSummary", expected: "facts_fallback_pairing", actual: "array" }]);
  }
  return candidate;
}

/** Structure-only validation shared by evaluation arm S and production arm T. */
export function validateStructuredResearchContent(
  candidateText: string,
  template: CompanyResearchTemplateSnapshot,
): StructuredResearchContent {
  return validateStructuredResearchCandidate(candidateText, template);
}

export function validateStructuredResearch(
  candidateText: string,
  rawMarkdown: string,
  template: CompanyResearchTemplateSnapshot,
): StructuredResearchContent {
  return validateStructuredResearchCandidate(candidateText, template, extractMarkdownSources(rawMarkdown));
}
