// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { Sidebar } from "./Sidebar.js";

const css = readFileSync(
  resolve(process.cwd(), "apps/desktop/src/renderer/app.css"),
  "utf8",
);

afterEach(cleanup);

describe("Sidebar conversation row layout", () => {
  it("keeps the delete control compact and truncates a long title on one line", () => {
    const style = document.createElement("style");
    style.textContent = css;
    document.head.append(style);

    render(
      <Sidebar
        conversations={[
          {
            id: "conversation-1" as never,
            title: "搜索宇树科技最近三个月的人形机器人产品与业务进展",
            hasUserMessage: true,
            createdAt: "2026-09-14T00:00:00.000Z",
            updatedAt: "2026-09-14T00:00:00.000Z",
          },
        ]}
        activeConversationId="conversation-1"
        connectionStatus="connected"
        active="chat"
        onNewConversation={() => {}}
        onOpenConversation={() => {}}
        onDeleteConversation={() => {}}
        deletionError={undefined}
        onOpenResearch={() => {}}
        onOpenSettings={() => {}}
      />,
    );

    const title = screen.getByRole("button", {
      name: "搜索宇树科技最近三个月的人形机器人产品与业务进展",
    });
    const deletion = screen.getByRole("button", {
      name: "删除搜索宇树科技最近三个月的人形机器人产品与业务进展",
    });

    expect(getComputedStyle(deletion).width).toBe("28px");
    expect(getComputedStyle(title).whiteSpace).toBe("nowrap");
    expect(getComputedStyle(title).textOverflow).toBe("ellipsis");
  });
});
