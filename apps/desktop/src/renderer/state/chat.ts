import type { AgentWorkerEvent, ChatMessage } from "@deepfield/contracts";

export type DraftStatus = "streaming" | "done" | "failed";

export interface ToolActivityView {
  callKey: string;
  name: string;
  status: "running" | "completed" | "failed";
  summary?: string;
  durationMs?: number;
  errorCode?: string;
}

export interface ChatMessageView {
  key: string;
  role: "user" | "assistant";
  content: string;
  status: "done" | DraftStatus;
  requestId: string | undefined;
  pending: boolean;
  /** Display-only skill used for this assistant reply; not persisted. */
  skillName?: string;
  /** Display-only marker for a reply generated with server-side web search. */
  webSearch?: boolean;
  /** Display-only tool activity for this reply; never persisted. */
  toolActivities: ToolActivityView[];
}

export interface ChatState {
  conversationId: string | undefined;
  loadState: "idle" | "loading" | "ready" | "error";
  loadError: string | undefined;
  messages: ChatMessageView[];
  drafts: Record<string, ChatMessageView>;
  requestConversations: Record<string, string>;
  draftOrder: string[];
  sending: boolean;
  sendError: string | undefined;
  seq: number;
}

export const initialChatState: ChatState = {
  conversationId: undefined,
  loadState: "idle",
  loadError: undefined,
  messages: [],
  drafts: {},
  requestConversations: {},
  draftOrder: [],
  sending: false,
  sendError: undefined,
  seq: 0,
};

export type ChatAction =
  | { type: "LOAD_START"; conversationId: string }
  | { type: "LOAD_SUCCESS"; conversationId: string; messages: ChatMessage[] }
  | { type: "LOAD_ERROR"; conversationId: string; error: string }
  | { type: "USER_SUBMIT"; content: string; requestId: string }
  | { type: "WORKER_EVENT"; conversationId: string | undefined; event: AgentWorkerEvent }
  | { type: "SEND_ERROR"; requestId: string; error: string }
  | { type: "RESET" };

function toView(message: ChatMessage): ChatMessageView {
  return {
    key: message.id,
    role: message.role,
    content: message.content,
    status: "done",
    requestId: message.requestId,
    pending: false,
    toolActivities: (message.toolExecutions ?? []).map((execution) => ({
      callKey: execution.callKey,
      name: execution.name,
      status: execution.status,
      ...(execution.durationMs === undefined ? {} : { durationMs: execution.durationMs }),
      ...(execution.errorCode === undefined ? {} : { errorCode: execution.errorCode }),
    })),
  };
}

function finalizeDraft(
  state: ChatState,
  messages: ChatMessageView[],
  requestConversations: Record<string, string>,
  requestId: string,
  draft: ChatMessageView,
): ChatState {
  const userIndex = messages.findIndex((message) => message.requestId === requestId);
  if (userIndex < 0) {
    return {
      ...state,
      messages,
      requestConversations,
      drafts: { ...state.drafts, [requestId]: draft },
    };
  }
  const finalized = { ...draft, key: `assistant-${requestId}`, requestId };
  const finalizedMessages = [...messages];
  finalizedMessages.splice(userIndex + 1, 0, finalized);
  const drafts = { ...state.drafts };
  delete drafts[requestId];
  const cleanedRequestConversations = { ...requestConversations };
  delete cleanedRequestConversations[requestId];
  return {
    ...state,
    messages: finalizedMessages,
    requestConversations: cleanedRequestConversations,
    draftOrder: state.draftOrder.filter((id) => id !== requestId),
    drafts,
  };
}

export function chatReducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case "LOAD_START":
      return {
        ...initialChatState,
        conversationId: action.conversationId,
        loadState: "loading",
        requestConversations: state.requestConversations,
        drafts: state.drafts,
        draftOrder: state.draftOrder,
      };
    case "LOAD_SUCCESS":
      if (state.conversationId !== action.conversationId) {
        return state;
      }
      return {
        ...state,
        loadState: "ready",
        messages: action.messages.map(toView),
        sending: state.draftOrder.some(
          (requestId) =>
            state.requestConversations[requestId] === action.conversationId &&
            state.drafts[requestId]?.status === "streaming",
        ),
      };
    case "LOAD_ERROR":
      if (state.conversationId !== action.conversationId) {
        return state;
      }
      return { ...state, loadState: "error", loadError: action.error };
    case "USER_SUBMIT":
      return {
        ...state,
        sending: true,
        sendError: undefined,
        seq: state.seq + 1,
        requestConversations:
          state.conversationId === undefined
            ? state.requestConversations
            : { ...state.requestConversations, [action.requestId]: state.conversationId },
        messages: [
          ...state.messages,
          {
            key: `local-${state.seq}`,
            role: "user",
            content: action.content,
            status: "done",
            requestId: action.requestId,
            pending: true,
            toolActivities: [],
          },
        ],
      };
    case "SEND_ERROR":
      const requestConversations = { ...state.requestConversations };
      delete requestConversations[action.requestId];
      return {
        ...state,
        sending: false,
        sendError: action.error,
        messages: state.messages.filter(
          (message) => !(message.pending && message.requestId === action.requestId),
        ),
        requestConversations,
      };
    case "WORKER_EVENT": {
      const { event, conversationId } = action;
      if (conversationId === undefined) {
        return state;
      }
      const requestId = event.requestId;
      if (
        state.conversationId !== conversationId &&
        state.requestConversations[requestId] !== conversationId
      ) {
        return state;
      }
      const existing = state.drafts[requestId];
      if (existing !== undefined && (existing.status === "done" || existing.status === "failed")) {
        return state;
      }
      if (existing === undefined && state.requestConversations[requestId] === undefined) {
        const finalizedAssistantIndex = state.messages.findIndex(
          (message) => message.key === `assistant-${requestId}`,
        );
        const latestRequestUserIndex = state.messages.findLastIndex(
          (message) => message.role === "user" && message.requestId === requestId,
        );
        if (finalizedAssistantIndex > latestRequestUserIndex) {
          return state;
        }
      }
      const requestConversations = { ...state.requestConversations };
      if (requestConversations[requestId] === undefined) {
        requestConversations[requestId] = conversationId;
      }
      const messages =
        state.conversationId === conversationId
          ? state.messages.map((message) =>
              message.pending && message.requestId === requestId
                ? { ...message, pending: false }
                : message,
            )
          : state.messages;
      let draft: ChatMessageView =
        existing ?? {
          key: `draft-${requestId}`,
          role: "assistant",
          content: "",
          status: "streaming",
          requestId,
          pending: false,
          toolActivities: [],
        };
      const draftOrder =
        existing === undefined ? [...state.draftOrder, requestId] : state.draftOrder;
      let sending = state.sending;
      switch (event.type) {
        case "started":
          draft = {
            ...draft,
            status: "streaming",
            ...(event.skillName !== undefined ? { skillName: event.skillName } : {}),
            ...(event.webSearch === true ? { webSearch: true } : {}),
          };
          break;
        case "text_delta":
          draft = { ...draft, content: draft.content + event.delta };
          break;
        case "tool_activity": {
          const activityIndex = draft.toolActivities.findIndex(
            (activity) => activity.callKey === event.callKey,
          );
          const activity: ToolActivityView = {
            callKey: event.callKey,
            name: event.name,
            status: event.status,
            ...(event.summary === undefined ? {} : { summary: event.summary }),
          };
          if (activityIndex < 0) {
            draft = { ...draft, toolActivities: [...draft.toolActivities, activity] };
          } else {
            const toolActivities = [...draft.toolActivities];
            toolActivities[activityIndex] = activity;
            draft = { ...draft, toolActivities };
          }
          break;
        }
        case "completed":
          draft = {
            ...draft,
            content: event.text,
            status: "done",
            toolActivities: draft.toolActivities.map((activity) =>
              activity.status === "running" ? { ...activity, status: "completed" } : activity,
            ),
          };
          sending = state.conversationId === conversationId ? false : state.sending;
          return { ...finalizeDraft(state, messages, requestConversations, requestId, draft), sending };
        case "failed":
          draft = {
            ...draft,
            status: "failed",
            toolActivities: draft.toolActivities.map((activity) =>
              activity.status === "running" ? { ...activity, status: "failed" } : activity,
            ),
          };
          sending = state.conversationId === conversationId ? false : state.sending;
          return { ...finalizeDraft(state, messages, requestConversations, requestId, draft), sending };
      }
      return {
        ...state,
        sending,
        messages,
        requestConversations,
        draftOrder,
        drafts: { ...state.drafts, [requestId]: draft },
      };
    }
    case "RESET":
      return initialChatState;
  }
}

export function visibleMessages(state: ChatState): ChatMessageView[] {
  const drafts = state.draftOrder
    .filter(
      (requestId) => state.requestConversations[requestId] === state.conversationId,
    )
    .filter(
      (requestId) =>
        !state.messages.some(
          (message) => message.role === "assistant" && message.requestId === requestId,
        ),
    )
    .map((requestId) => state.drafts[requestId])
    .filter((draft): draft is ChatMessageView => draft !== undefined);
  return [...state.messages, ...drafts];
}
