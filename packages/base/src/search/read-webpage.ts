import { fetchResource, type FetchResourceDeps } from "./fetch-resource.js";
import { createHtmlParser } from "./html-parser.js";
import { MAX_HTML_BYTES } from "./parsing-contracts.js";
import { MAX_READ_WEBPAGE_TEXT_CHARS, type ReadWebpageOutput } from "./output-contracts.js";
import type { ResourceScope } from "./resource-store.js";
import { SearchResourceError } from "./errors.js";

// Named gate titles must describe the page itself, rather than an article discussing
// captcha/login. A matching instruction in the body is also required.
const CHALLENGE_TITLE = /^(?:安全检测|安全验证|人机验证|访问验证|访问受限|security (?:check|verification)|just a moment|attention required|access denied)(?:\s*[-|–—].*|[.!！。…]*)$/i;
const CHALLENGE_TEXT = /正在进行安全检测|请.{0,16}(?:完成|通过).{0,8}(?:验证|安全检测)|verify (?:that )?you are human|checking your browser|performing security verification|enable javascript and cookies to continue/i;
const LOGIN_TITLE = /^(?:登录|用户登录|请登录|login|log in|sign in)(?:\s*[-|–—].*|[.!！。]*)$/i;
const LOGIN_TEXT = /请(?:先)?登录(?:后|以)(?:阅读|查看|访问|继续)|(?:log in|sign in) to (?:read|view|access|continue)/i;
// Observed title-less challenge shell. Match the entire instruction, so an
// article quoting or discussing it remains ordinary readable content.
const TITLELESS_CHALLENGE = /^正在进行安全检测(?:\.{3}|…+)\s*为保障您的访问安全，系统正在检测当前网络环境，该过程通常需要几秒钟，请耐心等待[。！!]?$/;

function assertReadableContent(title: string, text: string): void {
  if ((CHALLENGE_TITLE.test(title.trim()) && CHALLENGE_TEXT.test(text)) ||
      (LOGIN_TITLE.test(title.trim()) && LOGIN_TEXT.test(text)) ||
      (title.trim().length === 0 && TITLELESS_CHALLENGE.test(text.trim()))) {
    throw new SearchResourceError("access_restricted");
  }
  if (text.trim().length === 0) {
    throw new SearchResourceError("content_unavailable");
  }
}

export function createWebpageReader(deps: FetchResourceDeps) {
  const parse = createHtmlParser({ store: deps.store, maxChars: MAX_READ_WEBPAGE_TEXT_CHARS, maxLinks: 500 });
  return async (url: string, scope: ResourceScope, signal: AbortSignal, onExternalDispatch?: () => void, onProgress?: () => void): Promise<ReadWebpageOutput> => {
    const fetched = await fetchResource(deps, { maxBytes: MAX_HTML_BYTES, acceptedMime: ["text/html", "application/xhtml+xml"] }, url, scope, signal, onExternalDispatch, onProgress);
    const parsed = await parse(fetched.resourceId, scope, signal);
    assertReadableContent(parsed.title, parsed.text);
    return {
      title: parsed.title, url: parsed.canonicalUrl, requestedUrl: url, finalUrl: fetched.finalUrl,
      text: parsed.text, truncated: parsed.truncated, characterCount: parsed.characterCount,
    };
  };
}
