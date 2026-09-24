import type { DatabaseSync } from "node:sqlite";
import { Value } from "typebox/value";
import { AgentWorkerEventSchema, ChatTranscriptMessageSchema, type AgentWorkerEvent, type ChatToolExecution, type ChatTranscriptMessage, type ConversationId } from "./legacy-company-contracts/index.js";

export interface ChatSessionRecord {
  requestId: string;
  network: "enabled" | "disabled";
  completed: boolean;
  failed?: boolean;
  awaitingUser?: boolean;
  messages: ChatTranscriptMessage[];
  activities: ChatToolExecution[];
}

/** SQLite is the only durable source; the UI and Pi context are projections. */
export function createChatSessionRepository(db: DatabaseSync) {
  const read = (conversationId: ConversationId, requestId: string): ChatSessionRecord | undefined => {
    const row = db.prepare("SELECT data_json FROM chat_sessions WHERE conversation_id = ? AND request_id = ?").get(conversationId, requestId) as { data_json: string } | undefined;
    return row ? JSON.parse(row.data_json) as ChatSessionRecord : undefined;
  };
  const update = (conversationId: ConversationId, requestId: string, network: ChatSessionRecord["network"], change: (record: ChatSessionRecord) => void) => {
    const record = read(conversationId, requestId) ?? { requestId, network, completed: false, messages: [], activities: [] };
    change(record);
    db.prepare("INSERT INTO chat_sessions(conversation_id, request_id, data_json) VALUES (?, ?, ?) ON CONFLICT(conversation_id, request_id) DO UPDATE SET data_json = excluded.data_json").run(conversationId, requestId, JSON.stringify(record));
  };
  return {
    list(conversationId: ConversationId): ChatSessionRecord[] {
      return (db.prepare("SELECT data_json FROM chat_sessions WHERE conversation_id = ? ORDER BY rowid").all(conversationId) as { data_json: string }[]).map(row => JSON.parse(row.data_json) as ChatSessionRecord);
    },
    checkpoint(conversationId: ConversationId, requestId: string, network: ChatSessionRecord["network"], messages: ChatTranscriptMessage[]) {
      if (!messages.every(message => Value.Check(ChatTranscriptMessageSchema, message))) throw new Error("invalid chat transcript");
      update(conversationId, requestId, network, record => { record.messages = messages; });
    },
    activity(conversationId: ConversationId, requestId: string, network: ChatSessionRecord["network"], event: Extract<AgentWorkerEvent, { type: "tool_activity" }>) {
      if (!Value.Check(AgentWorkerEventSchema, event)) throw new Error("invalid chat activity");
      const { requestId: _requestId, type: _type, ...activity } = event;
      update(conversationId, requestId, network, record => {
        const index = record.activities.findIndex(item => item.callKey === activity.callKey);
        if (index < 0) record.activities.push(activity);
        else record.activities[index] = { ...record.activities[index], ...activity };
      });
    },
    complete(conversationId: ConversationId, requestId: string) {
      const record = read(conversationId, requestId);
      if (record) update(conversationId, requestId, record.network, current => { current.completed = true; });
    },
    awaitUser(conversationId: ConversationId, requestId: string) {
      const record = read(conversationId, requestId);
      if (record) update(conversationId, requestId, record.network, current => { current.awaitingUser = true; });
    },
    fail(conversationId: ConversationId, requestId: string) {
      const record = read(conversationId, requestId);
      if (record) update(conversationId, requestId, record.network, current => {
        current.failed = true;
        current.activities = current.activities.map(activity => activity.status === "running" ? { ...activity, status: "failed" } : activity);
      });
    },
  };
}
