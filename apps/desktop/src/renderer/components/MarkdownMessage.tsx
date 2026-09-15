import {
  Fragment,
  type ComponentPropsWithoutRef,
  useEffect,
  useRef,
  useState,
} from "react";
import ReactMarkdown, { type ExtraProps } from "react-markdown";
import remarkGfm from "remark-gfm";

const HTTP_URL = /^https?:\/\//iu;
const TRAILING_CJK_PUNCTUATION = /[，。；：！？、]+$/u;
const POPOVER_HIDE_DELAY_MS = 140;

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
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [copyStatus, setCopyStatus] = useState<"idle" | "copied" | "failed">("idle");
  const hideTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const cancelHide = () => {
    if (hideTimer.current !== undefined) {
      clearTimeout(hideTimer.current);
      hideTimer.current = undefined;
    }
  };
  const showPopover = () => {
    cancelHide();
    setPopoverOpen(true);
  };
  const scheduleHide = () => {
    cancelHide();
    hideTimer.current = setTimeout(() => {
      setPopoverOpen(false);
      setCopyStatus("idle");
      hideTimer.current = undefined;
    }, POPOVER_HIDE_DELAY_MS);
  };

  useEffect(() => cancelHide, []);

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
  const external = HTTP_URL.test(linkHref);
  const safeProps = Object.fromEntries(
    Object.entries(remainingProps).filter(([name]) => !/^on/iu.test(name)),
  ) as ComponentPropsWithoutRef<"a">;
  const copyLink = async () => {
    try {
      if (navigator.clipboard === undefined) {
        throw new Error("clipboard unavailable");
      }
      await navigator.clipboard.writeText(linkHref);
      setCopyStatus("copied");
    } catch {
      setCopyStatus("failed");
    }
  };

  return (
    <Fragment>
      <span className="markdown-link-shell">
        <a
          {...safeProps}
          href={linkHref}
          title={title}
          {...(external ? { target: "_blank", rel: "noreferrer noopener" } : {})}
          onMouseEnter={showPopover}
          onMouseLeave={scheduleHide}
          onFocus={showPopover}
          onBlur={scheduleHide}
        >
          {linkText}
        </a>
        {popoverOpen && (
          <span
            className="markdown-link-popover"
            role="dialog"
            aria-label="链接详情"
            onMouseEnter={showPopover}
            onMouseLeave={scheduleHide}
            onFocus={showPopover}
            onBlur={scheduleHide}
          >
            <span className="markdown-link-url">{linkHref}</span>
            <span className="markdown-link-actions">
              <button type="button" onClick={() => void copyLink()}>
                复制链接
              </button>
              {copyStatus !== "idle" && (
                <span className={`markdown-link-copy-status ${copyStatus}`} role="status">
                  {copyStatus === "copied" ? "已复制" : "复制失败，请手动选择链接"}
                </span>
              )}
            </span>
          </span>
        )}
      </span>
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
