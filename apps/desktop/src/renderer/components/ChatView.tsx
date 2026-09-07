import { useEffect, useRef, useState } from "react";
import type { ChatRequestOptions, DesktopApi, SkillSummary } from "@deepfield/contracts";
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
  projectId: string | undefined;
  projectLabel: string | undefined;
  onOpenResearch(): void;
  onNeedProject(): void;
}

export function ChatView({
  api,
  eventHub,
  requestIdFactory,
  projectId,
  projectLabel,
  onOpenResearch,
  onNeedProject,
}: ChatViewProps) {
  const { state, submit, reload } = useChat(api, projectId, eventHub, requestIdFactory);
  const [mode, setMode] = useState<"chat" | "research">("chat");
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
    <section className="chat-view" aria-label="项目 Chat">
      <header className="chat-header">
        <div className="chat-context">项目：{projectLabel ?? "未选择项目"}</div>
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
      <label className="mode-select">
        模式
        <select
          value={mode}
          onChange={(event) => {
            const next = event.target.value;
            setMode(next as "chat" | "research");
            if (next === "research") {
              onOpenResearch();
            }
          }}
        >
          <option value="chat">Chat</option>
          <option value="research">行业研究</option>
        </select>
      </label>
      {projectId === undefined ? (
        <div className="chat-empty">
          <p>当前为项目对话模式，请先创建或选择一个项目。</p>
          <button onClick={onNeedProject}>创建 / 选择项目</button>
        </div>
      ) : state.loadState === "loading" ? (
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
              submit(content, options);
              // The selected Skill applies to exactly one send.
              if (selectedSkillName !== undefined) {
                setSelectedSkillName(undefined);
              }
            }}
          />
        </>
      )}
    </section>
  );
}
