import { useCallback, useEffect, useRef, useState } from "react";
import type { Conversation, DesktopApi } from "@deepfield/contracts";

export interface ConversationController {
  conversations: Conversation[];
  activeConversation: Conversation | undefined;
  loading: boolean;
  error: string | undefined;
  deletionError: string | undefined;
  settingError: string | undefined;
  savingWebSearch: boolean;
  setWebSearchEnabled(id: string, enabled: boolean): Promise<void>;
  open(id: string): void;
  newConversation(): Promise<void>;
  deleteConversation(id: string): Promise<void>;
  acceptUpdated(conversation: Conversation): void;
  retry(): void;
}

export function mergeConversationTitle(current: Conversation, update: Conversation): Conversation {
  return current.id === update.id ? { ...current, title: update.title } : current;
}

export function useConversations(api: DesktopApi): ConversationController {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeConversation, setActiveConversation] = useState<Conversation | undefined>(
    undefined,
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>(undefined);
  const [deletionError, setDeletionError] = useState<string | undefined>(undefined);
  const latestTitles = useRef(new Map<string, string>());
  const latestWebSearch = useRef(new Map<string, boolean>());
  const pendingSettings = useRef(new Set<string>());
  const [savingSettings, setSavingSettings] = useState(new Set<string>());
  const [settingError, setSettingError] = useState<string | undefined>();

  const setWebSearchEnabled = useCallback(async (id: string, enabled: boolean): Promise<void> => {
    if (pendingSettings.current.has(id)) return;
    pendingSettings.current.add(id);
    setSavingSettings(new Set(pendingSettings.current));
    setSettingError(undefined);
    try {
      const saved = await api.conversations.setWebSearchEnabled(id, enabled);
      latestWebSearch.current.set(id, saved.webSearchEnabled === true);
      const patch = (item: Conversation): Conversation => item.id === id
        ? { ...item, webSearchEnabled: saved.webSearchEnabled === true } : item;
      setConversations((previous) => previous.map(patch));
      setActiveConversation((previous) => previous === undefined ? previous : patch(previous));
    } catch {
      setSettingError("保存联网搜索设置失败，请重试");
    } finally {
      pendingSettings.current.delete(id);
      setSavingSettings(new Set(pendingSettings.current));
    }
  }, [api]);

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

  useEffect(() => api.conversations.subscribe((updated) => {
    latestTitles.current.set(updated.id, updated.title);
    // Metadata events only patch known rows. A late event cannot recreate a
    // locally deleted Conversation, and never selects a different one.
    setConversations((previous) => previous.map((item) => mergeConversationTitle(item, updated)));
    setActiveConversation((previous) => previous === undefined ? previous : mergeConversationTitle(previous, updated));
  }), [api]);

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
    const latestTitle = latestTitles.current.get(conversation.id);
    const latestSetting = latestWebSearch.current.get(conversation.id);
    const accepted = {
      ...conversation,
      ...(latestTitle === undefined ? {} : { title: latestTitle }),
      ...(latestSetting === undefined ? {} : { webSearchEnabled: latestSetting }),
    };
    // Always refresh list metadata (e.g. a late first-message title). The
    // active Conversation only changes when the update belongs to the one the
    // user is currently viewing; a late result must never yank the user back
    // to an older Conversation they switched away from.
    setConversations((previous) => {
      const without = previous.filter((item) => item.id !== accepted.id);
      if (!accepted.hasUserMessage) {
        return without;
      }
      return [accepted, ...without];
    });
    setActiveConversation((previous) =>
      previous !== undefined && previous.id === accepted.id ? accepted : previous,
    );
  }, []);

  const deleteConversation = useCallback(async (id: string): Promise<void> => {
    setDeletionError(undefined);
    try {
      await api.conversations.delete(id);
      latestTitles.current.delete(id);
      latestWebSearch.current.delete(id);
      const capturedFallback = conversations.find((conversation) => conversation.id !== id);
      const created = activeConversation?.id === id && capturedFallback === undefined
        ? await api.conversations.create()
        : undefined;
      setConversations((previous) => previous.filter((conversation) => conversation.id !== id));
      setActiveConversation((previous) => {
        if (previous?.id !== id) return previous;
        if (capturedFallback === undefined) return created;
        const title = latestTitles.current.get(capturedFallback.id);
        return title === undefined ? capturedFallback : { ...capturedFallback, title };
      });
    } catch {
      setDeletionError("删除对话失败");
    }
  }, [api, conversations, activeConversation]);

  const retry = useCallback((): void => {
    loadInitial();
  }, [loadInitial]);

  return {
    conversations,
    activeConversation,
    loading,
    error,
    deletionError,
    settingError,
    savingWebSearch: activeConversation !== undefined && savingSettings.has(activeConversation.id),
    setWebSearchEnabled,
    open,
    newConversation,
    deleteConversation,
    acceptUpdated,
    retry,
  };
}
