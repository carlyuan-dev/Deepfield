export type ChatPaneState = "expanded" | "collapsed";
export type CapabilityId = "industry-research";

export interface WorkspaceState {
  activeCapability: CapabilityId | undefined;
  chatPane: ChatPaneState;
}

export const initialWorkspaceState: WorkspaceState = {
  activeCapability: undefined,
  chatPane: "expanded",
};

export type WorkspaceAction =
  | { type: "OPEN_CONVERSATION" }
  | { type: "OPEN_CAPABILITY_DIRECT"; capabilityId: CapabilityId }
  | { type: "OPEN_CAPABILITY_FROM_CHAT"; capabilityId: CapabilityId }
  | { type: "CLOSE_CAPABILITY" }
  | { type: "COLLAPSE_CHAT" }
  | { type: "EXPAND_CHAT" };

export function workspaceReducer(
  state: WorkspaceState,
  action: WorkspaceAction,
): WorkspaceState {
  switch (action.type) {
    case "OPEN_CONVERSATION":
      // A Conversation click expands Chat while any open Capability stays
      // mounted; layout only changes, never the Capability.
      return { ...state, chatPane: "expanded" };
    case "OPEN_CAPABILITY_DIRECT":
      return { activeCapability: action.capabilityId, chatPane: "collapsed" };
    case "OPEN_CAPABILITY_FROM_CHAT":
      return { activeCapability: action.capabilityId, chatPane: "expanded" };
    case "CLOSE_CAPABILITY":
      return { activeCapability: undefined, chatPane: "expanded" };
    case "COLLAPSE_CHAT":
      return { ...state, chatPane: "collapsed" };
    case "EXPAND_CHAT":
      return { ...state, chatPane: "expanded" };
  }
}
