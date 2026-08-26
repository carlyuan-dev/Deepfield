import { describe, expect, it } from "vitest";
import { initialWorkspaceState, workspaceReducer } from "./workspace.js";

describe("workspace reducer", () => {
  it("opens the direct capability with the rail hidden", () => {
    const state = workspaceReducer(initialWorkspaceState, {
      type: "OPEN_CAPABILITY_DIRECT",
      projectId: undefined,
    });
    expect(state.view).toBe("capability");
    expect(state.activeCapability).toBe("directUi");
    expect(state.capability.directUi.chatRail).toBe("hidden");
    expect(state.capability.directUi.projectId).toBeUndefined();
  });

  it("opens the capability from chat with the rail open and binds the chat project", () => {
    const state = workspaceReducer(initialWorkspaceState, {
      type: "OPEN_CAPABILITY_FROM_CHAT",
      projectId: "p1",
    });
    expect(state.view).toBe("capability");
    expect(state.activeCapability).toBe("chat");
    expect(state.capability.chat.chatRail).toBe("open");
    expect(state.capability.chat.projectId).toBe("p1");
  });

  it("keeps the rail hidden after a direct project is created and opens project chat from it", () => {
    let state = workspaceReducer(initialWorkspaceState, {
      type: "OPEN_CAPABILITY_DIRECT",
      projectId: undefined,
    });
    state = workspaceReducer(state, { type: "PROJECT_CREATED", projectId: "p9", fromChat: false });
    expect(state.view).toBe("capability");
    expect(state.capability.directUi.projectId).toBe("p9");
    expect(state.capability.directUi.chatRail).toBe("hidden");

    state = workspaceReducer(state, { type: "OPEN_PROJECT_CHAT", projectId: "p9" });
    expect(state.view).toBe("chat");
    expect(state.chat.projectId).toBe("p9");
  });

  it("keeps the rail open after a chat-launched project is created", () => {
    let state = workspaceReducer(initialWorkspaceState, {
      type: "OPEN_CAPABILITY_FROM_CHAT",
      projectId: "p1",
    });
    state = workspaceReducer(state, { type: "PROJECT_CREATED", projectId: "p2", fromChat: true });
    expect(state.view).toBe("capability");
    expect(state.capability.chat.projectId).toBe("p2");
    expect(state.capability.chat.chatRail).toBe("open");
  });

  it("collapse and expand preserve the central capability and project state", () => {
    let state = workspaceReducer(initialWorkspaceState, {
      type: "OPEN_CAPABILITY_FROM_CHAT",
      projectId: "p1",
    });
    state = workspaceReducer(state, { type: "COLLAPSE_CHAT" });
    expect(state.capability.chat.chatRail).toBe("collapsed");
    expect(state.capability.chat.projectId).toBe("p1");
    expect(state.view).toBe("capability");

    state = workspaceReducer(state, { type: "EXPAND_CHAT" });
    expect(state.capability.chat.chatRail).toBe("open");
    expect(state.capability.chat.projectId).toBe("p1");
    expect(state.capability.chat.projectId).toBe("p1");
  });

  it("keeps a hidden direct rail hidden across collapse and expand", () => {
    let state = workspaceReducer(initialWorkspaceState, {
      type: "OPEN_CAPABILITY_DIRECT",
      projectId: undefined,
    });
    state = workspaceReducer(state, { type: "COLLAPSE_CHAT" });
    expect(state.capability.directUi.chatRail).toBe("hidden");
    state = workspaceReducer(state, { type: "EXPAND_CHAT" });
    expect(state.capability.directUi.chatRail).toBe("hidden");
  });

  it("opening chat clears any bound project so 新对话 starts fresh", () => {
    let state = workspaceReducer(initialWorkspaceState, {
      type: "OPEN_PROJECT_CHAT",
      projectId: "p1",
    });
    state = workspaceReducer(state, { type: "OPEN_CHAT" });
    expect(state.view).toBe("chat");
    expect(state.chat.projectId).toBeUndefined();
  });

  it("opening a direct capability with a project id binds the workspace", () => {
    const state = workspaceReducer(initialWorkspaceState, {
      type: "OPEN_CAPABILITY_DIRECT",
      projectId: "p5",
    });
    expect(state.view).toBe("capability");
    expect(state.capability.directUi.projectId).toBe("p5");
    expect(state.capability.directUi.chatRail).toBe("hidden");
  });
});
