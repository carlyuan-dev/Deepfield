import {
  Children,
  type ComponentPropsWithoutRef,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

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
  const anchorRef = useRef<HTMLAnchorElement>(null);
  const popoverRef = useRef<HTMLSpanElement>(null);
  const [position, setPosition] = useState({ left: 0, top: 0, width: 0, maxHeight: 0 });

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
  useLayoutEffect(() => {
    if (!popoverOpen) return;
    const positionPopover = () => {
      const anchor = anchorRef.current;
      const popup = popoverRef.current;
      if (!anchor || !popup) return;
      const rect = anchor.getBoundingClientRect();
      const pane = anchor.closest(".chat-pane, .capability-pane")?.getBoundingClientRect();
      const leftBound = Math.max(8, (pane?.left ?? 0) + 8);
      const rightBound = Math.min(window.innerWidth - 8, (pane?.right ?? window.innerWidth) - 8);
      const width = Math.max(0, Math.min(520, rightBound - leftBound));
      const left = Math.max(leftBound, Math.min(rect.left, rightBound - width));
      const below = window.innerHeight - rect.bottom - 14;
      const above = rect.top - 14;
      // Measure wrapped content at its final width before choosing a side.
      popup.style.width = `${width}px`;
      const height = popup.scrollHeight;
      const placeAbove = below < Math.min(height, 180) && above > below;
      const maxHeight = Math.max(0, placeAbove ? above : below);
      const top = placeAbove ? Math.max(8, rect.top - Math.min(height, maxHeight) - 6) : rect.bottom + 6;
      setPosition({ left, top, width, maxHeight });
    };
    positionPopover();
    window.addEventListener("scroll", positionPopover, true);
    window.addEventListener("resize", positionPopover);
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(positionPopover);
    if (anchorRef.current) observer?.observe(anchorRef.current);
    const pane = anchorRef.current?.closest(".chat-pane, .capability-pane");
    if (pane) observer?.observe(pane);
    return () => {
      window.removeEventListener("scroll", positionPopover, true);
      window.removeEventListener("resize", positionPopover);
      observer?.disconnect();
    };
  }, [popoverOpen, copyStatus]);

  const external = isSafeHttpUrl(href);
  const labelParts = Children.toArray(children);
  const bareUrlLabel = labelParts.every((part) => typeof part === "string")
    && isSafeHttpUrl(labelParts.join(""));
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
    <span className={`markdown-link-shell${bareUrlLabel ? " markdown-link-shell--bare" : ""}`}>
      <a
        ref={anchorRef}
        {...safeProps}
        className={[safeProps.className, bareUrlLabel ? "markdown-link-label--bare" : undefined].filter(Boolean).join(" ") || undefined}
        href={href}
        {...(external ? { target: "_blank", rel: "noreferrer noopener" } : {})}
        onMouseEnter={showPopover}
        onMouseLeave={scheduleHide}
        onFocus={showPopover}
        onBlur={scheduleHide}
        onKeyDown={event => {
          if (event.key === "Escape") setPopoverOpen(false);
          if (event.key === "ArrowDown" || (event.key === "Tab" && !event.shiftKey && popoverOpen)) {
            event.preventDefault();
            popoverRef.current?.querySelector("button")?.focus();
          }
        }}
      >
        {children}
      </a>
      {popoverOpen && createPortal(
        <span
          ref={popoverRef}
          style={position}
          className="markdown-link-popover"
          role="dialog"
          aria-label="链接详情"
          onMouseEnter={showPopover}
          onMouseLeave={scheduleHide}
          onFocus={showPopover}
          onBlur={scheduleHide}
          onKeyDown={event => {
            if (event.key === "Escape") { anchorRef.current?.focus(); setPopoverOpen(false); }
            if (event.key === "Tab" && event.shiftKey) { event.preventDefault(); anchorRef.current?.focus(); }
          }}
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
        </span>, document.body
      )}
    </span>
  );
}
