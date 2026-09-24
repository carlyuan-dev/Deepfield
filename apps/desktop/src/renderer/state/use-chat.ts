import { useCallback, useEffect, useReducer } from "react";
import type {
  ChatRequestOptions,
  ChatSendResult,
  ConversationId,
  DesktopApi,
} from "@deepfield/contracts";
import { chatReducer, initialChatState, type ChatState } from "./chat.js";
import type { ChatEventHub } from "./chat-event-hub.js";

export interface ChatController {
  state: ChatState;
  submit: (content: string, options: ChatRequestOptions) => Promise<ChatSendResult | undefined>;
  reload: () => void;
}

export function useChat(
  api: DesktopApi,
  conversationId: string | undefined,
  eventHub: ChatEventHub,
  requestIdFactory: () => string,
  onRequestStart?: (requestId: string) => void,
): ChatController {
  const [state, dispatch] = useReducer(chatReducer, initialChatState);

  useEffect(() => {
    const unregister = eventHub.subscribe(({ conversationId: routedConversationId, event }) => {
      dispatch({ type: "WORKER_EVENT", conversationId: routedConversationId, event });
    });
    return unregister;
  }, [eventHub]);

  const load = useCallback(
    (target: string): (() => void) => {
      let cancelled = false;
      dispatch({ type: "LOAD_START", conversationId: target });
      void api.chat.listMessages(target).then(
        (messages) => {
          if (!cancelled) {
            dispatch({ type: "LOAD_SUCCESS", conversationId: target, messages });
          }
        },
        () => {
          if (!cancelled) {
            dispatch({ type: "LOAD_ERROR", conversationId: target, error: "加载消息失败" });
          }
        },
      );
      return () => {
        cancelled = true;
      };
    },
    [api],
  );

  useEffect(() => {
    if (conversationId === undefined) {
      dispatch({ type: "RESET" });
      return;
    }
    return load(conversationId);
  }, [conversationId, load]);

  const reload = useCallback((): void => {
    if (conversationId !== undefined) {
      load(conversationId);
    }
  }, [conversationId, load]);

  const submit = useCallback(
    (content: string, options: ChatRequestOptions): Promise<ChatSendResult | undefined> => {
      if (conversationId === undefined || state.sending || state.loadState !== "ready") {
        return Promise.resolve(undefined);
      }
      const requestId = requestIdFactory();
      onRequestStart?.(requestId);
      eventHub.registerRequest(requestId, conversationId as ConversationId);
      dispatch({ type: "USER_SUBMIT", content, requestId });
      return api.chat.send(conversationId, content, requestId, options).then(
        (result) => {
          if (result.requestId !== requestId) {
            eventHub.unregisterRequest(requestId);
            dispatch({ type: "SEND_ERROR", requestId, error: "发送失败，请重试" });
            return undefined;
          }
          return result;
        },
        () => {
          eventHub.unregisterRequest(requestId);
          dispatch({ type: "SEND_ERROR", requestId, error: "发送失败，请重试" });
          return undefined;
        },
      );
    },
    [api, conversationId, state.sending, state.loadState, eventHub, requestIdFactory, onRequestStart],
  );

  return { state, submit, reload };
}
