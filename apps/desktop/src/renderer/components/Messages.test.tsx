// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatMessageView } from "../state/chat.js";
import type { InteractionRecord } from "@deepfield/contracts";
import { Messages } from "./Messages.js";

function message(
  role: ChatMessageView["role"],
  content: string,
  status: ChatMessageView["status"] = "done",
): ChatMessageView {
  return {
    key: `${role}-1`,
    role,
    content,
    status,
    requestId: undefined,
    pending: false,
    toolActivities: [],
  };
}

describe("Chat message rendering", () => {
  it("uses trusted task associations when two packages share the same local task ID", () => {
    const interactions: InteractionRecord[] = ["a", "b"].map(id => ({ id, conversationId: "c", requestId: "r", toolCallId: id, revision: 3, status: "submitted", taskId: "local-task", createdAt: "today", updatedAt: "today", payload: { kind: "approval", summary: `Start ${id}`, operation: { provider: "capability", operationId: "opaque", contractVersion: "1" } } }));
    const tasks = ["a", "b"].map(id => ({ conversationId: "c", sourceRequestId: "r", interactionId: id, analyzeAfter: false, analysisState: "none" as const,
      snapshot: { taskRef: { capabilityId: `package-${id}`, taskId: "local-task" }, status: "running" as const, presentation: { text: `Progress ${id}`, target: { capabilityId: `package-${id}`, viewId: "result", input: {} }, linkLabel: `Open ${id}` } } }));
    const { container } = render(<Messages messages={[{ ...message("assistant", ""), requestId: "r" }]}
      interactionCards={{ interactions, respond: vi.fn() }} capabilityCards={{ tasks, confirmations: [], operations: [], approve: vi.fn(), dismiss: vi.fn(), open: vi.fn() }} />);
    const cards = container.querySelectorAll(".chat-interaction-card");
    expect(cards).toHaveLength(2);
    expect(within(cards[0] as HTMLElement).getByText("Progress a")).toBeTruthy();
    expect(within(cards[1] as HTMLElement).getByText("Progress b")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Open a" })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "Open b" })).toHaveLength(1);
    expect(container.querySelectorAll(".capability-chat-card")).toHaveLength(0);
  });
  it("evolves an approval into one result entry while preserving unrelated operations", () => {
    const interaction: InteractionRecord = { id: "interaction", conversationId: "c", requestId: "r", toolCallId: "t", revision: 3, status: "succeeded",
      createdAt: "today", updatedAt: "today", resultSummary: "主题创建完成", payload: { kind: "approval", summary: "创建主题", operation: { provider: "capability", operationId: "opaque", contractVersion: "1" } } };
    const target = { capabilityId: "company-research", viewId: "companies", input: { itemId: "new" } };
    const { container } = render(<Messages messages={[{ ...message("assistant", ""), requestId: "r" }]}
      interactionCards={{ interactions: [interaction], respond: vi.fn() }}
      capabilityCards={{ tasks: [], confirmations: [], operations: [
        { conversationId: "c", sourceRequestId: "r", invocationId: "executed", interactionId: "interaction", status: "completed", title: "", presentation: { text: "主题创建完成", target, linkLabel: "查看新主题" } },
        { conversationId: "c", sourceRequestId: "r", invocationId: "other", status: "failed", title: "另一个操作失败" },
      ], approve: vi.fn(), dismiss: vi.fn(), open: vi.fn() }} />);
    expect(container.querySelectorAll(".chat-interaction-card, .capability-chat-card")).toHaveLength(2);
    expect(screen.getAllByText("主题创建完成")).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "查看新主题" })).toHaveLength(1);
    expect(screen.getByText("另一个操作失败")).toBeTruthy();
  });
  it("keeps the completed operation link after generic approval replaces the old pending card", () => {
    const user = { ...message("user", "创建"), requestId: "r1" };
    const approval: InteractionRecord = { id: "i1", conversationId: "c1", requestId: "r1", toolCallId: "t1", revision: 2,
      status: "succeeded", createdAt: "2026-09-23", updatedAt: "2026-09-23",
      payload: { kind: "approval", summary: "创建主题", operation: { provider: "company", operationId: "create", contractVersion: "1" } } };
    const operations = [{ conversationId: "c1", sourceRequestId: "r1", invocationId: "v1", status: "completed" as const,
      title: "已创建", presentation: { text: "已创建主题", target: { capabilityId: "company", viewId: "topic", input: { id: "one" } } } }];
    render(<Messages messages={[user]} interactionCards={{ interactions: [approval], respond: vi.fn(async () => approval) }}
      capabilityCards={{ tasks: [], confirmations: [], operations, approve: vi.fn(async () => {}), dismiss: vi.fn(async () => {}), open: vi.fn(async () => {}) }} />);
    expect(screen.getByText("已创建主题")).toBeTruthy();
    expect(screen.getByRole("button", { name: "查看" })).toBeTruthy();
  });
  it("attaches operation controls once after the last assistant reply and never shows analysis checkboxes", () => {
    const user = { ...message("user", "新建主题"), key: "user-op", requestId: "request-op" };
    const first = { ...message("assistant", "正在处理"), key: "assistant-first", requestId: "request-op" };
    const last = { ...message("assistant", "请确认"), key: "assistant-last", requestId: "request-op" };
    const confirmation = { confirmationRef: "confirm", capabilityId: "company", actionId: "create", sourceRequestId: "request-op",
      invocationId: "invocation", inputSummary: { title: "新建主题", fields: [{ label: "主题", value: "半导体" }] }, analyzeAfter: false };
    const cards = { tasks: [], operations: [], confirmations: [confirmation], approve: vi.fn(async () => {}), dismiss: vi.fn(async () => {}), open: vi.fn(async () => {}) };
    const { container, rerender } = render(<Messages messages={[user, first, last]} capabilityCards={cards} />);
    const replies = container.querySelectorAll(".message.assistant");
    expect(replies[0]?.querySelector(".capability-chat-card")).toBeNull();
    expect(replies[1]?.querySelectorAll(".capability-chat-card")).toHaveLength(1);
    expect(container.querySelectorAll("input[type=checkbox]")).toHaveLength(0);
    rerender(<Messages messages={[user]} />);
    expect(container.querySelectorAll(".message.assistant")).toHaveLength(0);
    rerender(<Messages messages={[user]} capabilityCards={cards} />);
    expect(container.querySelectorAll(".message.assistant .capability-chat-card")).toHaveLength(1);
  });
  it.each(["", ".", "。"])("preserves terminal underscores in a bare source URL before '%s' and its copied destination", async (punctuation) => {
    const url = "https://h5.ifeng.com/c/vivoArticle/v002HEzQBOzuQO8W9qYu9BZgIK5Ygahx9hILpwNgkP1uMHc__";
    const copyText = vi.fn(async () => undefined);
    Object.defineProperty(window, "deepfield", { configurable: true, value: { copyText } });
    const { container } = render(<Messages messages={[message("assistant", `${url}${punctuation}`)]} />);
    const link = screen.getByRole("link");
    expect(link.getAttribute("href")).toBe(url);
    expect(link.textContent).toBe(url);
    expect(container.querySelector(".markdown-message")?.textContent).toBe(`${url}${punctuation}`);
    fireEvent.mouseEnter(link);
    fireEvent.click(screen.getByRole("button", { name: "复制链接" }));
    await waitFor(() => expect(copyText).toHaveBeenCalledWith(url));
  });

  it("keeps emphasis delimiters and text after titled links outside their destinations", () => {
    const { container } = render(<Messages messages={[message("assistant", "__https://example.com/report__\n\n[报告](https://example.com/report)__")]} />);
    const links = screen.getAllByRole("link");
    expect(links.map((link) => link.getAttribute("href"))).toEqual([
      "https://example.com/report", "https://example.com/report",
    ]);
    expect(container.querySelector("strong a")?.textContent).toBe("https://example.com/report");
    expect(container.querySelector(".markdown-message")?.textContent).toContain("报告__");
  });

  it.each(["bare", "autolink", "explicit"])(
    "compacts %s URL labels while retaining the complete destination and copy value",
    async (syntax) => {
      const url = "https://example.com/reports/%E4%B8%AD%E5%9B%BD%E4%BA%A7%E4%B8%9A%E7%A0%94%E7%A9%B6%E6%8A%A5%E5%91%8A/%E4%BC%81%E4%B8%9A%E5%88%86%E6%9E%90%E4%B8%8E%E5%B8%82%E5%9C%BA%E5%89%8D%E6%99%AF?q=%E4%B8%AD%E6%96%87&source=research&report=annual-industry-development-2026#details";
      const content = syntax === "bare" ? url : syntax === "autolink" ? `<${url}>` : `[${url}](${url})`;
      const copyText = vi.fn(async () => undefined);
      Object.defineProperty(window, "deepfield", { configurable: true, value: { copyText } });
      render(<Messages messages={[message("assistant", content)]} />);
      const link = screen.getByRole("link", { name: url });

      expect(link.classList.contains("markdown-link-label--bare")).toBe(true);
      expect(link.textContent).toBe(url);
      expect(link.getAttribute("href")).toBe(url);
      fireEvent.mouseEnter(link);
      expect(within(screen.getByRole("dialog")).getByText(url).textContent).toBe(url);
      fireEvent.click(screen.getByRole("button", { name: "复制链接" }));
      await waitFor(() => expect(copyText).toHaveBeenCalledWith(url));
    },
  );

  it("leaves titled links outside the compact URL label treatment", () => {
    render(<Messages messages={[message("assistant", "[阅读 **报告**](https://example.com/report)")]} />);
    const link = screen.getByRole("link", { name: "阅读 报告" });
    expect(link.classList.contains("markdown-link-label--bare")).toBe(false);
    expect(link.querySelector("strong")?.textContent).toBe("报告");
    expect(link.getAttribute("href")).toBe("https://example.com/report");
  });

  afterEach(() => {
    vi.useRealTimers();
    Reflect.deleteProperty(window, "deepfield");
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: undefined,
    });
  });

  it("renders assistant Markdown as semantic content without literal syntax", () => {
    const content = [
      "## 小标题",
      "",
      "含有 **重点**、*补充* 和 `inline()`。",
      "",
      "1. 第一项",
      "2. 第二项",
      "",
      "> 引用内容",
      "",
      "---",
      "",
      "```ts",
      "const answer = 42;",
      "```",
    ].join("\n");

    const { container } = render(<Messages messages={[message("assistant", content)]} />);
    const answer = container.querySelector(".assistant-content");

    expect(within(answer as HTMLElement).getByRole("heading", { level: 2, name: "小标题" })).toBeTruthy();
    expect(answer?.querySelector("strong")?.textContent).toBe("重点");
    expect(answer?.querySelector("em")?.textContent).toBe("补充");
    expect(answer?.querySelector("ol")?.textContent).toContain("第一项");
    expect(answer?.querySelector("blockquote")?.textContent?.trim()).toBe("引用内容");
    expect(answer?.querySelector("hr")).toBeTruthy();
    expect(answer?.querySelector("pre code")?.textContent).toContain("const answer = 42;");
    expect(answer?.textContent).not.toContain("## 小标题");
    expect(answer?.textContent).not.toContain("**重点**");
  });

  it("renders adjacent labeled sources as separate secure anchors", () => {
    const { container } = render(
      <Messages
        messages={[
          message(
            "assistant",
            "> 来源：[微博](https://weibo.example/a)、[网易](https://news.example/b)",
          ),
        ]}
      />,
    );
    const links = Array.from(container.querySelectorAll(".assistant-content a"));

    expect(links.map((link) => [link.textContent, link.getAttribute("href")])).toEqual([
      ["微博", "https://weibo.example/a"],
      ["网易", "https://news.example/b"],
    ]);
    for (const link of links) {
      expect(link.getAttribute("target")).toBe("_blank");
      expect(link.getAttribute("rel")).toBe("noreferrer noopener");
    }
    expect(container.querySelector(".assistant-content")?.textContent).toContain("来源：微博、网易");
    expect(container.querySelector(".assistant-content")?.textContent).not.toContain("](");
  });

  it("preserves the destination of an explicit link with a URL-shaped label", () => {
    const { container } = render(
      <Messages
        messages={[
          message(
            "assistant",
            "[https://label.example](https://actual.example/report)",
          ),
        ]}
      />,
    );
    const link = container.querySelector(".assistant-content a");

    expect(link?.textContent).toBe("https://label.example");
    expect(link?.getAttribute("href")).toBe("https://actual.example/report");
  });

  it.each([
    ["encoded", "https://actual.example/report%E3%80%82", "https://actual.example/report%E3%80%82"],
    ["literal", "https://actual.example/report。", "https://actual.example/report%E3%80%82"],
  ])(
    "does not rewrite an explicit %s Chinese-punctuation destination from its label",
    (_kind, destination, expectedHref) => {
      const { container } = render(
        <Messages
          messages={[
            message(
              "assistant",
              `[https://label.example/path。](${destination})`,
            ),
          ]}
        />,
      );
      const link = container.querySelector(".assistant-content a");

      expect(link?.textContent).toBe("https://label.example/path。");
      expect(link?.getAttribute("href")).toBe(expectedHref);
    },
  );

  it("excludes trailing Chinese sentence punctuation from a bare URL anchor", () => {
    const { container } = render(
      <Messages messages={[message("assistant", "https://plain.example/path。")]} />,
    );
    const answer = container.querySelector(".assistant-content");
    const link = answer?.querySelector("a");

    expect(link?.textContent).toBe("https://plain.example/path");
    expect(link?.getAttribute("href")).toBe("https://plain.example/path");
    expect(answer?.textContent).toBe("https://plain.example/path。");
  });

  it("renders GFM tables with semantic cells instead of pipe syntax", () => {
    const { container } = render(
      <Messages
        messages={[
          message("assistant", "| 公司 | 状态 |\n| --- | --- |\n| Deepfield | 正常 |"),
        ]}
      />,
    );

    const table = container.querySelector(".assistant-content table");
    expect(table).toBeTruthy();
    expect(within(table as HTMLElement).getByRole("columnheader", { name: "公司" })).toBeTruthy();
    expect(within(table as HTMLElement).getByRole("cell", { name: "Deepfield" })).toBeTruthy();
    expect(table?.textContent).not.toContain("|");
  });

  it("keeps raw HTML inert and unsafe link protocols non-clickable", () => {
    const { container } = render(
      <Messages
        messages={[
          message(
            "assistant",
            '<img src=x onerror="alert(1)"> <script>alert(2)</script> [安全链接](https://safe.example) [危险链接](javascript:alert(3))',
          ),
        ]}
      />,
    );
    const answer = container.querySelector(".assistant-content");

    expect(answer?.querySelector("img")).toBeNull();
    expect(answer?.querySelector("script")).toBeNull();
    const links = Array.from(answer?.querySelectorAll("a") ?? []);
    expect(links.map((link) => [link.textContent, link.getAttribute("href")])).toEqual([
      ["安全链接", "https://safe.example"],
    ]);
    expect(answer?.textContent).toContain('<img src=x onerror="alert(1)">');
    expect(answer?.textContent).toContain("危险链接");
  });

  it("preserves footnote reference and return-link metadata", () => {
    const { container } = render(
      <Messages
        messages={[
          message("assistant", "结论有出处。[^1]\n\n[^1]: 脚注内容。"),
        ]}
      />,
    );
    const reference = container.querySelector<HTMLAnchorElement>("a[data-footnote-ref]");
    const back = container.querySelector<HTMLAnchorElement>("a[data-footnote-backref]");

    expect(reference).toBeTruthy();
    expect(reference?.id).toBe("user-content-fnref-1");
    expect(reference?.getAttribute("href")).toBe("#user-content-fn-1");
    expect(reference?.getAttribute("aria-describedby")).toBe("footnote-label");
    expect(container.querySelector(reference?.getAttribute("href") ?? "missing")).toBeTruthy();
    expect(back).toBeTruthy();
    expect(back?.classList.contains("data-footnote-backref")).toBe(true);
    expect(back?.getAttribute("aria-label")).toBeTruthy();
    expect(back?.getAttribute("href")).toBe(`#${reference?.id}`);
    expect(container.querySelector(back?.getAttribute("href") ?? "missing")).toBe(reference);
  });

  it("shows a selectable URL window on hover and hides it after a short delay", () => {
    vi.useFakeTimers();
    render(
      <Messages
        messages={[
          message("assistant", "[详情](https://actual.example/reports/full-path?q=1)"),
        ]}
      />,
    );
    const link = screen.getByRole("link", { name: "详情" });

    expect(screen.queryByRole("dialog", { name: "链接详情" })).toBeNull();
    fireEvent.mouseEnter(link);
    const popover = screen.getByRole("dialog", { name: "链接详情" });
    expect(within(popover).getByText("https://actual.example/reports/full-path?q=1")).toBeTruthy();

    fireEvent.mouseLeave(link);
    expect(screen.getByRole("dialog", { name: "链接详情" })).toBeTruthy();
    act(() => vi.advanceTimersByTime(200));
    expect(screen.queryByRole("dialog", { name: "链接详情" })).toBeNull();
  });

  it("keeps the URL window open while the pointer moves from the link into it", () => {
    vi.useFakeTimers();
    render(<Messages messages={[message("assistant", "[来源](https://source.example/a)")]} />);
    const link = screen.getByRole("link", { name: "来源" });
    fireEvent.mouseEnter(link);
    const popover = screen.getByRole("dialog", { name: "链接详情" });

    fireEvent.mouseLeave(link, { relatedTarget: popover });
    fireEvent.mouseEnter(popover, { relatedTarget: link });
    act(() => vi.advanceTimersByTime(200));
    expect(screen.getByRole("dialog", { name: "链接详情" })).toBe(popover);

    fireEvent.mouseLeave(popover);
    act(() => vi.advanceTimersByTime(200));
    expect(screen.queryByRole("dialog", { name: "链接详情" })).toBeNull();
  });

  it("copies the normalized destination rather than a URL-shaped label", async () => {
    const webClipboardWrite = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: webClipboardWrite },
    });
    const copyText = vi.fn(async () => undefined);
    Object.defineProperty(window, "deepfield", {
      configurable: true,
      value: { copyText },
    });
    render(
      <Messages
        messages={[
          message(
            "assistant",
            "[https://label.example](https://actual.example/report%E3%80%82)",
          ),
        ]}
      />,
    );
    fireEvent.mouseEnter(screen.getByRole("link", { name: "https://label.example" }));

    fireEvent.click(screen.getByRole("button", { name: "复制链接" }));

    await waitFor(() => expect(copyText).toHaveBeenCalledWith("https://actual.example/report%E3%80%82"));
    expect(webClipboardWrite).not.toHaveBeenCalled();
    expect(screen.getByRole("status").textContent).toBe("已复制");
  });

  it("keeps the URL selectable and reports a clipboard failure without blocking", async () => {
    const webClipboardWrite = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: webClipboardWrite },
    });
    Object.defineProperty(window, "deepfield", {
      configurable: true,
      value: { copyText: vi.fn(async () => Promise.reject(new Error("denied"))) },
    });
    render(<Messages messages={[message("assistant", "[来源](https://source.example/a)")]} />);
    fireEvent.focus(screen.getByRole("link", { name: "来源" }));

    fireEvent.click(screen.getByRole("button", { name: "复制链接" }));

    expect((await screen.findByRole("status")).textContent).toBe("复制失败，请手动选择链接");
    expect(webClipboardWrite).not.toHaveBeenCalled();
    expect(screen.getByText("https://source.example/a").classList.contains("markdown-link-url")).toBe(true);
  });

  it("supports keyboard focus and keeps the window while focus moves inside", () => {
    vi.useFakeTimers();
    render(<Messages messages={[message("assistant", "[来源](https://source.example/a)")]} />);
    const link = screen.getByRole("link", { name: "来源" });
    fireEvent.focus(link);
    const copyButton = screen.getByRole("button", { name: "复制链接" });

    fireEvent.blur(link, { relatedTarget: copyButton });
    fireEvent.focus(copyButton);
    act(() => vi.advanceTimersByTime(200));
    expect(screen.getByRole("dialog", { name: "链接详情" })).toBeTruthy();

    fireEvent.blur(copyButton, { relatedTarget: null });
    act(() => vi.advanceTimersByTime(200));
    expect(screen.queryByRole("dialog", { name: "链接详情" })).toBeNull();
  });

  it("keeps preview state isolated between multiple links and excludes unsafe links", () => {
    vi.useFakeTimers();
    render(
      <Messages
        messages={[
          message(
            "assistant",
            "[第一](https://one.example/a) [第二](https://two.example/b) [危险](javascript:alert(1))",
          ),
        ]}
      />,
    );
    const first = screen.getByRole("link", { name: "第一" });
    const second = screen.getByRole("link", { name: "第二" });
    expect(screen.queryByRole("link", { name: "危险" })).toBeNull();

    fireEvent.mouseEnter(first);
    expect(screen.getByText("https://one.example/a")).toBeTruthy();
    expect(screen.queryByText("https://two.example/b")).toBeNull();
    fireEvent.mouseLeave(first);
    act(() => vi.advanceTimersByTime(200));

    fireEvent.mouseEnter(second);
    expect(screen.getByText("https://two.example/b")).toBeTruthy();
    expect(screen.queryByText("https://one.example/a")).toBeNull();
    expect(screen.getAllByRole("button", { name: "复制链接" })).toHaveLength(1);
  });

  it("renders incomplete streaming Markdown safely and upgrades it when completed", () => {
    const { container, rerender } = render(
      <Messages messages={[message("assistant", "**尚未完成", "streaming")]} />,
    );

    expect(container.querySelector(".assistant-content")?.textContent).toContain("**尚未完成");
    expect(container.querySelector(".assistant-content strong")).toBeNull();

    rerender(<Messages messages={[message("assistant", "**尚未完成**", "streaming")]} />);

    expect(container.querySelector(".assistant-content strong")?.textContent).toBe("尚未完成");
    expect(container.querySelector(".assistant-content")?.textContent).not.toContain("**");
  });

  it("keeps user Markdown literal while linkifying bare URLs", () => {
    const { container } = render(
      <Messages messages={[message("user", "**不要加粗** https://user.example/path。")]} />,
    );
    const userContent = container.querySelector(".message.user .message-content");

    expect(userContent?.querySelector("strong")).toBeNull();
    expect(userContent?.textContent).toContain("**不要加粗**");
    expect(userContent?.querySelector("a")?.getAttribute("href")).toBe("https://user.example/path");
  });
});
