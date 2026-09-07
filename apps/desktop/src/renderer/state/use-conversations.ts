import { useCallback, useEffect, useState } from "react";
import type { Conversation, DesktopApi } from "@deepfield/contracts";

export interface ConversationController {
  conversations: Conversation[];
  activeConversation: Conversation | undefined;
  loading: boolean;
  error: string | undefined;
  open(id: string): void;
  newConversation(): Promise<void>;
  acceptUpdated(conversation: Conversation): void;
  retry(): void;
}

export function useConversations(api: DesktopApi): ConversationController {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeConversation, setActiveConversation] = useState<Conversation | undefined>(
    undefined,
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>(undefined);

  const loadInitial = useCallback((): void => {
    setLoading(true);
    setError(undefined);
    void api.conversations.openInitial().then(
      ({ active, recent }) => {
        setConversations(recent);
        setActiveConversation(active);
        setLoading(false);
      },
      () => {
        setError("加载对话失败");
        setLoading(false);
      },
    );
  }, [api]);

  useEffect(() => {
    loadInitial();
  }, [loadInitial]);

  const open = useCallback(
    (id: string): void => {
      const target = conversations.find((conversation) => conversation.id === id);
      if (target !== undefined) {
        setActiveConversation(target);
        setError(undefined);
      }
    },
    [conversations],
  );

  const newConversation = useCallback(async (): Promise<void> => {
    // A blank draft is already open: creating another empty Conversation is a no-op.
    if (activeConversation !== undefined && !activeConversation.hasUserMessage) {
      return;
    }
    try {
      const created = await api.conversations.create();
      setActiveConversation(created);
      setError(undefined);
    } catch {
      setError("创建对话失败");
    }
  }, [api, activeConversation]);

  const acceptUpdated = useCallback((conversation: Conversation): void => {
    // Always refresh list metadata (e.g. a late first-message title). The
    // active Conversation only changes when the update belongs to the one the
    // user is currently viewing; a late result must never yank the user back
    // to an older Conversation they switched away from.
    setConversations((previous) => {
      const without = previous.filter((item) => item.id !== conversation.id);
      if (!conversation.hasUserMessage) {
        return without;
      }
      return [conversation, ...without];
    });
    setActiveConversation((previous) =>
      previous !== undefined && previous.id === conversation.id ? conversation : previous,
    );
  }, []);

  const retry = useCallback((): void => {
    loadInitial();
  }, [loadInitial]);

  return {
    conversations,
    activeConversation,
    loading,
    error,
    open,
    newConversation,
    acceptUpdated,
    retry,
  };
}
