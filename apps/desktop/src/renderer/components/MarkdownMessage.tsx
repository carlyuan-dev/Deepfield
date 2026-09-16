import {
  Fragment,
  type ComponentPropsWithoutRef,
} from "react";
import ReactMarkdown, { type ExtraProps } from "react-markdown";
import remarkGfm from "remark-gfm";
import { UrlPopoverLink } from "./UrlPopoverLink.js";

const HTTP_URL = /^https?:\/\//iu;
const TRAILING_CJK_PUNCTUATION = /[，。；：！？、]+$/u;

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
        remarkPlugins={[remarkGfm]}
        components={{
          a: (props) => <MarkdownLink {...props} markdownSource={content} />,
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
