import type { AgentWorkerEvent, ChatMessage } from "@deepfield/contracts";

export type DraftStatus = "streaming" | "done" | "failed";

export interface ChatMessageView {
  key: string;
  role: "user" | "assistant";
  content: string;
  status: "done" | DraftStatus;
  requestId: string | undefined;
}

export interface ChatState {
  projectId: string | undefined;
  loadState: "idle" | "loading" | "ready" | "error";
  loadError: string | undefined;
  messages: ChatMessageView[];
  drafts: Record<string, ChatMessageView>;
  requestProjects: Record<string, string>;
  draftOrder: string[];
  sending: boolean;
  sendError: string | undefined;
  seq: number;
}

export const initialChatState: ChatState = {
  projectId: undefined,
  loadState: "idle",
  loadError: undefined,
  messages: [],
  drafts: {},
  requestProjects: {},
  draftOrder: [],
  sending: false,
  sendError: undefined,
  seq: 0,
};

export type ChatAction =
  | { type: "LOAD_START"; projectId: string }
  | { type: "LOAD_SUCCESS"; projectId: string; messages: ChatMessage[] }
  | { type: "LOAD_ERROR"; projectId: string; error: string }
  | { type: "USER_SUBMIT"; content: string }
  | { type: "WORKER_EVENT"; projectId: string | undefined; event: AgentWorkerEvent }
  | { type: "SEND_ERROR"; error: string }
  | { type: "RESET" };

function toView(message: ChatMessage): ChatMessageView {
  return {
    key: message.id,
    role: message.role,
    content: message.content,
    status: "done",
    requestId: undefined,
  };
}

export function chatReducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case "LOAD_START":
      return {
        ...initialChatState,
        projectId: action.projectId,
        loadState: "loading",
        requestProjects: state.requestProjects,
        drafts: state.drafts,
        draftOrder: state.draftOrder,
      };
    case "LOAD_SUCCESS":
      if (state.projectId !== action.projectId) {
        return state;
      }
      return { ...state, loadState: "ready", messages: action.messages.map(toView) };
    case "LOAD_ERROR":
      if (state.projectId !== action.projectId) {
        return state;
      }
      return { ...state, loadState: "error", loadError: action.error };
    case "USER_SUBMIT":
      return {
        ...state,
        sending: true,
        sendError: undefined,
        seq: state.seq + 1,
        messages: [
          ...state.messages,
          {
            key: `local-${state.seq}`,
            role: "user",
            content: action.content,
            status: "done",
            requestId: undefined,
          },
        ],
      };
    case "WORKER_EVENT": {
      const { event, projectId } = action;
      if (projectId === undefined || state.projectId !== projectId) {
        return state;
      }
      const requestId = event.requestId;
      const existing = state.drafts[requestId];
      if (existing !== undefined && (existing.status === "done" || existing.status === "failed")) {
        return state;
      }
      const requestProjects = { ...state.requestProjects };
      if (requestProjects[requestId] === undefined) {
        requestProjects[requestId] = projectId;
      }
      let draft: ChatMessageView =
        existing ?? {
          key: `draft-${requestId}`,
          role: "assistant",
          content: "",
          status: "streaming",
          requestId,
        };
      const draftOrder =
        existing === undefined ? [...state.draftOrder, requestId] : state.draftOrder;
      let sending = state.sending;
      switch (event.type) {
        case "started":
          draft = { ...draft, status: "streaming" };
          break;
        case "text_delta":
          draft = { ...draft, content: draft.content + event.delta };
          break;
        case "completed":
          draft = { ...draft, content: event.text, status: "done" };
          sending = false;
          break;
        case "failed":
          draft = { ...draft, status: "failed" };
          sending = false;
          break;
      }
      return {
        ...state,
        sending,
        requestProjects,
        draftOrder,
        drafts: { ...state.drafts, [requestId]: draft },
      };
    }
    case "SEND_ERROR":
      return { ...state, sending: false, sendError: action.error };
    case "RESET":
      return initialChatState;
  }
}

export function visibleMessages(state: ChatState): ChatMessageView[] {
  const drafts = state.draftOrder
    .filter((requestId) => state.requestProjects[requestId] === state.projectId)
    .map((requestId) => state.drafts[requestId])
    .filter((draft): draft is ChatMessageView => draft !== undefined);
  return [...state.messages, ...drafts];
}
