import {
  type ComponentPropsWithoutRef,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";

const POPOVER_HIDE_DELAY_MS = 140;

export function isSafeHttpUrl(value: string): boolean {
  try {
    return ["http:", "https:"].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

export function UrlPopoverLink({
  href,
  children,
  target: _target,
  rel: _rel,
  dangerouslySetInnerHTML: _dangerouslySetInnerHTML,
  ...remainingProps
}: Omit<ComponentPropsWithoutRef<"a">, "href"> & { href: string; children: ReactNode }) {
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

  const external = isSafeHttpUrl(href);
  const safeProps = Object.fromEntries(
    Object.entries(remainingProps).filter(([name]) => !/^on/iu.test(name)),
  ) as ComponentPropsWithoutRef<"a">;
  const copyLink = async () => {
    try {
      await window.deepfield.copyText(href);
      setCopyStatus("copied");
    } catch {
      setCopyStatus("failed");
    }
  };

  return (
    <span className="markdown-link-shell">
      <a
        {...safeProps}
        href={href}
        {...(external ? { target: "_blank", rel: "noreferrer noopener" } : {})}
        onMouseEnter={showPopover}
        onMouseLeave={scheduleHide}
        onFocus={showPopover}
        onBlur={scheduleHide}
      >
        {children}
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
          <span className="markdown-link-url">{href}</span>
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
  );
}
