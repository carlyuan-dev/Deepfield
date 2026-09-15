// @vitest-environment jsdom
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ChatMessageView } from "../state/chat.js";
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
