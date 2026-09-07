import { describe, expect, it } from "vitest";
import {
  initialWorkspaceState,
  workspaceReducer,
} from "./workspace.js";

describe("workspace shell", () => {
  it("starts expanded with no active Capability", () => {
    expect(initialWorkspaceState).toEqual({
      activeCapability: undefined,
      chatPane: "expanded",
    });
  });

  it("direct workflow entry opens the Capability and collapses Chat", () => {
    const state = workspaceReducer(initialWorkspaceState, {
      type: "OPEN_CAPABILITY_DIRECT",
      capabilityId: "industry-research",
    });
    expect(state).toEqual({
      activeCapability: "industry-research",
      chatPane: "collapsed",
    });
  });

  it("a Conversation click expands Chat while the Capability stays mounted", () => {
    const collapsed = workspaceReducer(initialWorkspaceState, {
      type: "OPEN_CAPABILITY_DIRECT",
      capabilityId: "industry-research",
    });
    const state = workspaceReducer(collapsed, { type: "OPEN_CONVERSATION" });
    expect(state).toEqual({
      activeCapability: "industry-research",
      chatPane: "expanded",
    });
  });

  it("collapses and expands only the layout state", () => {
    let state = workspaceReducer(initialWorkspaceState, {
      type: "OPEN_CAPABILITY_FROM_CHAT",
      capabilityId: "industry-research",
    });
    expect(state.chatPane).toBe("expanded");
    state = workspaceReducer(state, { type: "COLLAPSE_CHAT" });
    expect(state.chatPane).toBe("collapsed");
    expect(state.activeCapability).toBe("industry-research");
    state = workspaceReducer(state, { type: "EXPAND_CHAT" });
    expect(state.chatPane).toBe("expanded");
    expect(state.activeCapability).toBe("industry-research");
  });
});
