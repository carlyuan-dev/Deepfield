import { useEffect, useRef, useState } from "react";
import type {
  ChatRequestOptions,
  Conversation,
  DesktopApi,
  SkillSummary,
} from "@deepfield/contracts";
import { useChat } from "../state/use-chat.js";
import type { ChatEventHub } from "../state/chat-event-hub.js";
import { visibleMessages } from "../state/chat.js";
import { Composer } from "./Composer.js";
import { Messages } from "./Messages.js";
import { SkillPicker } from "./SkillPicker.js";

export interface ChatViewProps {
  api: DesktopApi;
  eventHub: ChatEventHub;
  requestIdFactory: () => string;
  conversation: Conversation;
  acceptUpdated(conversation: Conversation): void;
}

export function ChatView({
  api,
  eventHub,
  requestIdFactory,
  conversation,
  acceptUpdated,
}: ChatViewProps) {
  const { state, submit, reload } = useChat(api, conversation.id, eventHub, requestIdFactory);
  const [draft, setDraft] = useState("");
  const [skills, setSkills] = useState<SkillSummary[]>([]);
  const [selectedSkillName, setSelectedSkillName] = useState<string | undefined>(undefined);
  const lastSubmitted = useRef("");
  const messages = visibleMessages(state);

  // Load once on mount. A loading failure must leave ordinary Chat usable, so
  // it degrades to an empty Skill list.
  useEffect(() => {
    let cancelled = false;
    void api.skills.list().then(
      (summaries) => {
        if (!cancelled) {
          setSkills(summaries);
        }
      },
      () => {
        if (!cancelled) {
          setSkills([]);
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [api]);

  useEffect(() => {
    if (state.sendError !== undefined && lastSubmitted.current.length > 0) {
      setDraft(lastSubmitted.current);
    }
  }, [state.sendError]);

  return (
    <section className="chat-view" aria-label="Chat">
      <header className="chat-header">
        <div className="chat-context">{conversation.title}</div>
        {state.loadState === "error" && (
          <div className="error" role="alert">
            {state.loadError}
            <button onClick={reload}>重新加载</button>
          </div>
        )}
        {state.sendError !== undefined && (
          <p className="error" role="alert">
            {state.sendError}
          </p>
        )}
      </header>
      {state.loadState === "loading" ? (
        <p className="muted">加载消息…</p>
      ) : (
        <>
          <Messages messages={messages} />
          <Composer
            value={draft}
            onChange={setDraft}
            disabled={state.sending || state.loadState !== "ready"}
            actions={
              <>
                <SkillPicker
                  skills={skills}
                  value={selectedSkillName}
                  disabled={state.sending}
                  onChange={setSelectedSkillName}
                />
                {selectedSkillName !== undefined && (
                  <span className="skill-pill">Skill: {selectedSkillName}</span>
                )}
              </>
            }
            onSubmit={(content) => {
              lastSubmitted.current = content;
              setDraft("");
              const options: ChatRequestOptions = {
                webSearch: false,
                ...(selectedSkillName !== undefined ? { skillName: selectedSkillName } : {}),
              };
              const sendResult = submit(content, options);
              // The selected Skill applies to exactly one send.
              if (selectedSkillName !== undefined) {
                setSelectedSkillName(undefined);
              }
              void sendResult.then((result) => {
                if (result !== undefined) {
                  acceptUpdated(result.conversation);
                }
              });
            }}
          />
        </>
      )}
    </section>
  );
}
