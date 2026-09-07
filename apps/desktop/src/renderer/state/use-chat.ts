import { useCallback, useEffect, useReducer } from "react";
import type { ChatRequestOptions, DesktopApi } from "@deepfield/contracts";
import { chatReducer, initialChatState, type ChatState } from "./chat.js";
import type { ChatEventHub } from "./chat-event-hub.js";

export interface ChatController {
  state: ChatState;
  submit: (content: string, options: ChatRequestOptions) => void;
  reload: () => void;
}

export function useChat(
  api: DesktopApi,
  projectId: string | undefined,
  eventHub: ChatEventHub,
  requestIdFactory: () => string,
): ChatController {
  const [state, dispatch] = useReducer(chatReducer, initialChatState);

  useEffect(() => {
    const unregister = eventHub.subscribe(({ projectId: routedProjectId, event }) => {
      dispatch({ type: "WORKER_EVENT", projectId: routedProjectId, event });
    });
    return unregister;
  }, [eventHub]);

  const load = useCallback(
    (target: string): (() => void) => {
      let cancelled = false;
      dispatch({ type: "LOAD_START", projectId: target });
      void api.chat.listMessages(target).then(
        (messages) => {
          if (!cancelled) {
            dispatch({ type: "LOAD_SUCCESS", projectId: target, messages });
          }
        },
        () => {
          if (!cancelled) {
            dispatch({ type: "LOAD_ERROR", projectId: target, error: "加载消息失败" });
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
    if (projectId === undefined) {
      dispatch({ type: "RESET" });
      return;
    }
    return load(projectId);
  }, [projectId, load]);

  const reload = useCallback((): void => {
    if (projectId !== undefined) {
      load(projectId);
    }
  }, [projectId, load]);

  const submit = useCallback(
    (content: string, options: ChatRequestOptions) => {
      if (projectId === undefined || state.sending || state.loadState !== "ready") {
        return;
      }
      const requestId = requestIdFactory();
      eventHub.registerRequest(requestId, projectId);
      dispatch({ type: "USER_SUBMIT", content, requestId });
      void api.chat.send(projectId, content, requestId, options).then(
        (result) => {
          if (result.requestId !== requestId) {
            eventHub.unregisterRequest(requestId);
            dispatch({ type: "SEND_ERROR", requestId, error: "发送失败，请重试" });
          }
        },
        () => {
          eventHub.unregisterRequest(requestId);
          dispatch({ type: "SEND_ERROR", requestId, error: "发送失败，请重试" });
        },
      );
    },
    [api, projectId, state.sending, state.loadState, eventHub, requestIdFactory],
  );

  return { state, submit, reload };
}
