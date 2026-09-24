import type { CapabilityInteractionEditor } from "@deepfield/capability-sdk";
import type { DesktopApi } from "@deepfield/contracts";

/** A package receives only methods for the interaction selected by the host. */
export function createBoundInteractionEditor(
  chat: DesktopApi["chat"],
  owner: { conversationId: string; interactionId: string },
  onRespond: (decision: "approve" | "cancel") => void,
): CapabilityInteractionEditor {
  const { conversationId, interactionId } = owner;
  return {
    read: async () => { const value = await chat.readInteractionEditor(conversationId, interactionId);
      return { revision: value.interaction.revision, status: value.interaction.status,
        formId: value.formId, actionId: value.actionId, snapshot: value.form }; },
    beginEdit: async expectedRevision => { await chat.beginInteractionEdit(conversationId, interactionId, expectedRevision); },
    update: async (expectedRevision, patch) => { const value = await chat.updateInteractionEditor(conversationId, interactionId, expectedRevision, patch); return { revision: value.interaction.revision }; },
    transition: async (expectedRevision, transitionId) => { const value = await chat.transitionInteractionEditor(conversationId, interactionId, expectedRevision, transitionId); return { revision: value.interaction.revision }; },
    respond: async (expectedRevision, decision) => {
      const result = await chat.respondInteractionEditor(conversationId, { interactionId, expectedRevision, response: { kind: "decision", decision } });
      if (result.id !== interactionId || result.conversationId !== conversationId || result.status === "waiting" || result.status === "editing") {
        throw new Error("内容已更新，请核对后重试。");
      }
      if (result.status !== "executing") onRespond(decision);
    },
    subscribe: listener => chat.onInteractions(id => { if (id === conversationId) listener(); }),
  };
}
