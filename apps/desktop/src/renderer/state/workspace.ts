export type ChatRailState = "hidden" | "open" | "collapsed";
export type View = "chat" | "capability";
export type CapabilitySource = "directUi" | "chat";

export interface WorkspaceState {
  view: View;
  activeCapability: CapabilitySource;
  chat: { projectId: string | undefined };
  capability: {
    directUi: { projectId: string | undefined; chatRail: ChatRailState };
    chat: { projectId: string | undefined; chatRail: "open" | "collapsed" };
  };
}

export const initialWorkspaceState: WorkspaceState = {
  view: "chat",
  activeCapability: "directUi",
  chat: { projectId: undefined },
  capability: {
    directUi: { projectId: undefined, chatRail: "hidden" },
    chat: { projectId: undefined, chatRail: "open" },
  },
};

export type WorkspaceAction =
  | { type: "OPEN_CHAT" }
  | { type: "OPEN_CAPABILITY_DIRECT"; projectId: string | undefined }
  | { type: "OPEN_CAPABILITY_FROM_CHAT"; projectId: string | undefined }
  | { type: "PROJECT_CREATED"; projectId: string; fromChat: boolean }
  | { type: "OPEN_PROJECT_CHAT"; projectId: string }
  | { type: "COLLAPSE_CHAT" }
  | { type: "EXPAND_CHAT" };

function setActiveRail(state: WorkspaceState, target: "open" | "collapsed"): WorkspaceState {
  if (state.activeCapability === "chat") {
    return {
      ...state,
      capability: { ...state.capability, chat: { ...state.capability.chat, chatRail: target } },
    };
  }
  if (state.capability.directUi.chatRail === "hidden") {
    return state;
  }
  return {
    ...state,
    capability: {
      ...state.capability,
      directUi: { ...state.capability.directUi, chatRail: target },
    },
  };
}

export function workspaceReducer(
  state: WorkspaceState,
  action: WorkspaceAction,
): WorkspaceState {
  switch (action.type) {
    case "OPEN_CHAT":
      return { ...state, view: "chat", chat: { projectId: undefined } };
    case "OPEN_CAPABILITY_DIRECT":
      return {
        ...state,
        view: "capability",
        activeCapability: "directUi",
        capability: {
          ...state.capability,
          directUi: { ...state.capability.directUi, projectId: action.projectId },
        },
      };
    case "OPEN_CAPABILITY_FROM_CHAT":
      return {
        ...state,
        view: "capability",
        activeCapability: "chat",
        capability: {
          ...state.capability,
          chat: { ...state.capability.chat, projectId: action.projectId, chatRail: "open" },
        },
      };
    case "PROJECT_CREATED":
      return action.fromChat
        ? {
            ...state,
            capability: {
              ...state.capability,
              chat: { ...state.capability.chat, projectId: action.projectId },
            },
          }
        : {
            ...state,
            capability: {
              ...state.capability,
              directUi: { ...state.capability.directUi, projectId: action.projectId },
            },
          };
    case "OPEN_PROJECT_CHAT":
      return { ...state, view: "chat", chat: { projectId: action.projectId } };
    case "COLLAPSE_CHAT":
      return setActiveRail(state, "collapsed");
    case "EXPAND_CHAT":
      return setActiveRail(state, "open");
  }
}
