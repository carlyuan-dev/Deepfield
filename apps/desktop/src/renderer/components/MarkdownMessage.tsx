import {
  Fragment,
  type ComponentPropsWithoutRef,
} from "react";
import ReactMarkdown, { type ExtraProps } from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Parent, PhrasingContent, Root } from "mdast";
import { UrlPopoverLink } from "./UrlPopoverLink.js";

const HTTP_URL = /^https?:\/\//iu;
const TRAILING_CJK_PUNCTUATION = /[，。；：！？、]+$/u;

function remarkPreserveBareUrlUnderscores() {
  return (tree: Root, file: { value: unknown }) => {
    const source = String(file.value);
    const visit = (parent: Parent) => {
      for (const [index, node] of parent.children.entries()) {
        if ("children" in node) visit(node);
        const next = parent.children[index + 1];
        const start = node.position?.start.offset;
        const end = node.position?.end.offset;
        if (
          node.type !== "link" || next?.type !== "text"
          || start === undefined || end === undefined
          || next.position?.start.offset !== end
          || !HTTP_URL.test(source.slice(start, end))
          || node.children.length !== 1 || node.children[0]?.type !== "text"
        ) continue;

        // GFM leaves terminal underscores as adjacent text. Recover only literal
        // source characters; emphasis delimiters are not sibling text nodes.
        const suffix = /^_+/u.exec(next.value)?.[0];
        if (!suffix || source.slice(end, end + suffix.length) !== suffix) continue;
        node.url += suffix;
        node.children[0].value += suffix;
        next.value = next.value.slice(suffix.length);
      }
    };
    visit(tree);
  };
}

// Only a paragraph made entirely of links and separators is a source list.
// Links embedded in ordinary prose keep their original inline structure.
function remarkSourceLists() {
  return (tree: Root, file: { value: unknown }) => {
    const source = String(file.value);
    const visit = (parent: Parent) => {
      parent.children = parent.children.map(node => {
        if ("children" in node) visit(node);
        if (node.type !== "paragraph") return node;
        node.children = node.children.flatMap((child): PhrasingContent[] => {
          if (child.type !== "link" || child.children.length !== 1 || child.children[0]?.type !== "text") return [child];
          const start = child.position?.start.offset;
          const end = child.position?.end.offset;
          if (start === undefined || end === undefined || !HTTP_URL.test(source.slice(start, end))) return [child];
          // GFM may swallow the Chinese separator and the next bare URL into
          // one destination. Only split literal bare URLs at another URL start.
          const parts = child.children[0].value.split(/([、，；])(?=https?:\/\/)/u);
          if (parts.length < 2) return [child];
          return parts.map((url, index) => index % 2
            ? { type: "text", value: url }
            : { ...child, url, children: [{ type: "text", value: url }] });
        });
        const first = node.children[0];
        const prefix = first?.type === "text" && /^\s*(?:来源|参考资料|参考来源|Sources|References)\s*[:：]\s*$/iu.test(first.value) ? first : undefined;
        const links = node.children.filter(child => child.type === "link");
        if (links.length < 2 || !node.children.every(child =>
          child === prefix || child.type === "link" || (child.type === "text" && /^[\s、,，;；|]*$/u.test(child.value)))) return node;
        return {
          type: "list", ordered: false, spread: false,
          data: { hProperties: { className: ["markdown-source-list"] } },
          children: links.map(link => ({
            type: "listItem", spread: false,
            children: [{ type: "paragraph", children: [link] }],
          })),
        };
      });
    };
    visit(tree);
  };
}

function MarkdownLink({
  href,
  title,
  children,
  node,
  markdownSource,
  target: _target,
  rel: _rel,
  dangerouslySetInnerHTML: _dangerouslySetInnerHTML,
  ...remainingProps
}: ComponentPropsWithoutRef<"a"> & ExtraProps & { markdownSource: string }) {
  if (!href) {
    return <>{children}</>;
  }

  const startOffset = node?.position?.start.offset;
  const endOffset = node?.position?.end.offset;
  const source =
    startOffset === undefined || endOffset === undefined
      ? ""
      : markdownSource.slice(startOffset, endOffset);
  const bareUrl =
    HTTP_URL.test(source) && typeof children === "string" && HTTP_URL.test(children);
  const linkText = bareUrl ? children.replace(TRAILING_CJK_PUNCTUATION, "") : children;
  const suffix = bareUrl ? children.slice(String(linkText).length) : "";
  const linkHref = bareUrl ? String(linkText) : href;
  return (
    <Fragment>
      <UrlPopoverLink {...remainingProps} href={linkHref} title={title}>{linkText}</UrlPopoverLink>
      {suffix}
    </Fragment>
  );
}

export function MarkdownMessage({ content }: { content: string }) {
  return (
    <div className="markdown-message">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkPreserveBareUrlUnderscores, remarkSourceLists]}
        components={{
          a: (props) => <MarkdownLink {...props} markdownSource={content} />,
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
