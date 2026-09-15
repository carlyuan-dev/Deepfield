import { Fragment, type ComponentPropsWithoutRef } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

const HTTP_URL = /^https?:\/\//iu;
const TRAILING_CJK_PUNCTUATION = /[，。；：！？、]+$/u;

function MarkdownLink({
  href,
  title,
  children,
}: ComponentPropsWithoutRef<"a">) {
  if (!href) {
    return <>{children}</>;
  }

  const bareUrl = typeof children === "string" && HTTP_URL.test(children);
  const linkText = bareUrl ? children.replace(TRAILING_CJK_PUNCTUATION, "") : children;
  const suffix = bareUrl ? children.slice(String(linkText).length) : "";
  const linkHref = bareUrl ? String(linkText) : href;
  const external = HTTP_URL.test(linkHref);
  return (
    <Fragment>
      <a
        href={linkHref}
        title={title}
        {...(external ? { target: "_blank", rel: "noreferrer noopener" } : {})}
      >
        {linkText}
      </a>
      {suffix}
    </Fragment>
  );
}

export function MarkdownMessage({ content }: { content: string }) {
  return (
    <div className="markdown-message">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ a: MarkdownLink }}>
        {content}
      </ReactMarkdown>
    </div>
  );
}
