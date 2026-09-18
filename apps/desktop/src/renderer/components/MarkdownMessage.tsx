import {
  Fragment,
  type ComponentPropsWithoutRef,
} from "react";
import ReactMarkdown, { type ExtraProps } from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Parent, Root } from "mdast";
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
        remarkPlugins={[remarkGfm, remarkPreserveBareUrlUnderscores]}
        components={{
          a: (props) => <MarkdownLink {...props} markdownSource={content} />,
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
