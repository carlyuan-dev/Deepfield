import type { Conversation } from "@deepfield/contracts";
import type { Repositories } from "@deepfield/persistence";

export class ConversationService {
  constructor(private readonly repositories: Repositories) {}

  create(): Conversation {
    return this.repositories.conversations.create();
  }

  openInitial(): { active: Conversation; recent: Conversation[] } {
    const recent = this.repositories.conversations.listRecent();
    const active = recent[0] ?? this.repositories.conversations.getOrCreateDraft();
    return { active, recent };
  }

  listRecent(): Conversation[] {
    return this.repositories.conversations.listRecent();
  }
}
