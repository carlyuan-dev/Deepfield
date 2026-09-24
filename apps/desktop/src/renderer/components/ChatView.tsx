import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type {
  ChatRequestOptions,
  Conversation,
  DesktopApi,
  SkillSummary,
  ChatCapabilityTaskCard,
  ChatCapabilityConfirmation,
  ChatCapabilityOperationCard,
  InteractionRecord,
  RespondCommand,
} from "@deepfield/contracts";
import { useChat } from "../state/use-chat.js";
import type { ChatEventHub } from "../state/chat-event-hub.js";
import { visibleMessages } from "../state/chat.js";
import { Composer } from "./Composer.js";
import { Messages } from "./Messages.js";
import { SkillPicker } from "./SkillPicker.js";
import { WebSearchToggle } from "./WebSearchToggle.js";

export interface ChatViewProps {
  api: DesktopApi;
  eventHub: ChatEventHub;
  requestIdFactory: () => string;
  conversation: Conversation;
  acceptUpdated(conversation: Conversation): void;
  setWebSearchEnabled(id: string, enabled: boolean): Promise<void>;
  savingWebSearch: boolean;
  settingError: string | undefined;
  openInteractionEditor?(interaction: InteractionRecord): Promise<void>;
  onNewInteraction?(interaction: InteractionRecord): void;
  onRequestStart?(requestId: string): void;
}

export function ChatView({
  api,
  eventHub,
  requestIdFactory,
  conversation,
  acceptUpdated,
  setWebSearchEnabled,
  savingWebSearch,
  settingError,
  openInteractionEditor,
  onNewInteraction,
  onRequestStart,
}: ChatViewProps) {
  const { state, submit, reload } = useChat(api, conversation.id, eventHub, requestIdFactory, onRequestStart);
  const [draft, setDraft] = useState("");
  const [taskCards, setTaskCards] = useState<ChatCapabilityTaskCard[]>([]);
  const [confirmations, setConfirmations] = useState<ChatCapabilityConfirmation[]>([]);
  const [operations, setOperations] = useState<ChatCapabilityOperationCard[]>([]);
  const [interactions, setInteractions] = useState<InteractionRecord[]>([]);
  const [interactionsReady, setInteractionsReady] = useState(false);
  const [skills, setSkills] = useState<SkillSummary[]>([]);
  const [selectedSkillName, setSelectedSkillName] = useState<string | undefined>(undefined);
  const webSearchEnabled = conversation.webSearchEnabled === true;
  const lastSubmitted = useRef("");
  const currentConversationId = useRef(conversation.id);
  currentConversationId.current = conversation.id;
  const newInteractionCallback = useRef(onNewInteraction);
  newInteractionCallback.current = onNewInteraction;
  const autoRequestIds = useRef(new Set<string>());
  const messagesRef = useRef<HTMLDivElement>(null);
  const followOutput = useRef(true);
  const messages = visibleMessages(state);

  useEffect(() => {
    let active = true;
    let initialized = false;
    let eventDuringInitialLoad = false;
    const known = new Set<string>();
    setInteractions([]);
    setInteractionsReady(!api.chat.listInteractions);
    const load = (fromEvent: boolean) => { if (!api.chat.listInteractions) return; void api.chat.listInteractions(conversation.id).then(items => {
      if (active && currentConversationId.current === conversation.id) {
        if ((initialized && fromEvent) || (!initialized && eventDuringInitialLoad)) {
          for (const item of items) if (!known.has(item.id) && item.status === "waiting" && item.payload.kind === "approval")
            newInteractionCallback.current?.(item);
        }
        for (const item of items) known.add(item.id);
        initialized = true;
        setInteractions(items); setInteractionsReady(true);
        if (eventDuringInitialLoad) { eventDuringInitialLoad = false; load(true); }
      }
    }).catch(() => { if (active && currentConversationId.current === conversation.id) { setInteractions([]); setInteractionsReady(true); } }); };
    load(false);
    const unsubscribe = api.chat.onInteractions?.(id => { if (id === conversation.id) {
      if (!initialized) eventDuringInitialLoad = true;
      else load(true);
    } });
    return () => { active = false; unsubscribe?.(); };
  }, [api, conversation.id]);

  useEffect(() => {
    const capability = api.chatCapability;
    if (!capability) return;
    return capability.subscribeStream((conversationId, event) => {
      if (!autoRequestIds.current.has(event.requestId)) {
        autoRequestIds.current.add(event.requestId);
        eventHub.registerRequest(event.requestId, conversationId);
      }
      eventHub.emit(event);
      if ((event.type === "completed" || event.type === "failed") && conversationId === conversation.id) reload();
    });
  }, [api, eventHub, conversation.id, reload]);

  useEffect(() => {
    const capability = api.chatCapability;
    if (!capability) return;
    let active = true;
    const load = () => {
      void Promise.all([capability.listTasks(conversation.id), capability.listConfirmations(conversation.id), capability.listOperations(conversation.id)]).then(([tasks, pending, resolved]) => {
        if (active) { setTaskCards(tasks); setConfirmations(pending); setOperations(resolved); }
      }).catch(() => { if (active) { setTaskCards([]); setConfirmations([]); setOperations([]); } });
    };
    void capability.setActiveConversation(conversation.id).then(load, load);
    const unsubscribe = capability.subscribe(id => { if (id === conversation.id) { load(); if (!state.sending) reload(); } });
    return () => { active = false; unsubscribe(); };
  }, [api, conversation.id, reload, state.sending]);

  useLayoutEffect(() => {
    const element = messagesRef.current;
    if (element !== null && followOutput.current) {
      element.scrollTop = element.scrollHeight;
    }
  }, [conversation.id, state.loadState, messages.length, messages.at(-1)?.content, taskCards, confirmations, operations, interactions]);

  const handleMessagesScroll = (element: HTMLDivElement): void => {
    followOutput.current =
      element.scrollHeight - element.scrollTop - element.clientHeight <= 40;
  };

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
      {settingError !== undefined && <p className="chat-content-status error" role="alert">{settingError}</p>}
      {state.loadState === "error" && (
        <div className="chat-content-status error" role="alert">
          {state.loadError}
          <button onClick={reload}>重新加载</button>
        </div>
      )}
      {state.sendError !== undefined && (
        <p className="chat-content-status error" role="alert">
          {state.sendError}
        </p>
      )}
      {state.loadState === "loading" ? (
        <p className="muted">加载消息…</p>
      ) : (
        <>
          <Messages
            messages={messages}
            messagesRef={messagesRef}
            onScroll={handleMessagesScroll}
            interactionCards={{ interactions: interactions.filter(item => item.conversationId === conversation.id),
              respond: async (_item, command: RespondCommand) => {
                const ownerId = conversation.id;
                const result = await api.chat.respondInteraction!(ownerId, command);
                if (currentConversationId.current === ownerId) {
                  setInteractions(previous => previous.map(item => item.id === result.id ? result : item));
                  void api.chat.listInteractions?.(ownerId).then(items => { if (currentConversationId.current === ownerId) setInteractions(items); });
                }
                return result;
              },
              ...(openInteractionEditor ? { openEditor: openInteractionEditor } : {}),
            }}
            capabilityCards={{ tasks: taskCards, confirmations: interactionsReady ? confirmations : [], operations: interactionsReady ? operations : [],
            approve: async (ref, analyzeAfter) => {
              const ownerId = conversation.id;
              const result = await api.chatCapability?.approve(conversation.id, ref, analyzeAfter);
              const [tasks, pending, resolved] = await Promise.all([api.chatCapability?.listTasks(conversation.id), api.chatCapability?.listConfirmations(conversation.id), api.chatCapability?.listOperations(conversation.id)]);
              if (currentConversationId.current === ownerId) {
                setTaskCards(tasks ?? []); setConfirmations(pending ?? []); setOperations(resolved ?? []);
                reload();
              }
              if (result && typeof result === "object" && "status" in result && result.status === "error") throw new Error("confirmation failed");
            },
            dismiss: async ref => { const ownerId = conversation.id; await api.chatCapability?.dismiss(ownerId, ref);
              const [pending, resolved] = await Promise.all([api.chatCapability?.listConfirmations(ownerId), api.chatCapability?.listOperations(ownerId)]);
              if (currentConversationId.current === ownerId) { setConfirmations(pending ?? []); setOperations(resolved ?? []); } },
            open: async target => { const result = await api.chatCapability?.open(conversation.id, target); if (result?.status !== "opened") throw new Error(result?.message ?? "open failed"); },
            }} />
          <Composer
            value={draft}
            onChange={setDraft}
            disabled={savingWebSearch || state.sending || state.loadState !== "ready"}
            actions={
              <>
                <WebSearchToggle
                  enabled={webSearchEnabled}
                  disabled={savingWebSearch || state.sending}
                  onChange={(enabled) => { void setWebSearchEnabled(conversation.id, enabled); }}
                />
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
              if (savingWebSearch) return;
              lastSubmitted.current = content;
              setDraft("");
              const options: ChatRequestOptions = {
                webSearch: webSearchEnabled,
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
