import { useCallback, useEffect, useReducer, useRef } from "react";
import type { DesktopApi } from "@deepfield/contracts";
import { chatReducer, initialChatState, type ChatState } from "./chat.js";
import {
  registerChatListener,
  registerRequestProject,
  setCurrentChatProject,
} from "./chat-events.js";

export interface ChatController {
  state: ChatState;
  submit: (content: string) => void;
}

export function useChat(api: DesktopApi, projectId: string | undefined): ChatController {
  const [state, dispatch] = useReducer(chatReducer, initialChatState);
  const projectRef = useRef(projectId);

  useEffect(() => {
    projectRef.current = projectId;
    setCurrentChatProject(projectId);
  }, [projectId]);

  useEffect(() => {
    const unregister = registerChatListener(({ projectId: routedProjectId, event }) => {
      dispatch({ type: "WORKER_EVENT", projectId: routedProjectId, event });
    });
    return unregister;
  }, []);

  useEffect(() => {
    if (projectId === undefined) {
      dispatch({ type: "RESET" });
      return;
    }
    let cancelled = false;
    dispatch({ type: "LOAD_START", projectId });
    void api.chat
      .listMessages(projectId)
      .then(
        (messages) => {
          if (!cancelled) {
            dispatch({ type: "LOAD_SUCCESS", projectId, messages });
          }
        },
        () => {
          if (!cancelled) {
            dispatch({ type: "LOAD_ERROR", projectId, error: "加载消息失败" });
          }
        },
      );
    return () => {
      cancelled = true;
    };
  }, [api, projectId]);

  const submit = useCallback(
    (content: string) => {
      if (projectId === undefined || state.sending || state.loadState !== "ready") {
        return;
      }
      dispatch({ type: "USER_SUBMIT", content });
      void api.chat
        .send(projectId, content)
        .then(({ requestId }) => {
          registerRequestProject(requestId, projectId);
        })
        .catch(() => {
          dispatch({ type: "SEND_ERROR", error: "发送失败，请重试" });
        });
    },
    [api, projectId, state.sending, state.loadState],
  );

  return { state, submit };
}
