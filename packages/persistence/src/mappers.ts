import type {
  ChatMessage,
  CapabilityItem,
  Company,
  Conversation,
  ConversationId,
  ItemCompany,
  MessageId,
} from "@deepfield/contracts";
import type {
  ConversationRow,
  MessageRow,
  CapabilityItemRow,
  CompanyRow,
  ItemCompanyRow,
} from "./types.js";

export function toCapabilityItem(row: CapabilityItemRow): CapabilityItem {
  return {
    id: row.id as CapabilityItem["id"],
    type: row.type,
    industry: row.industry,
    ...(row.research_scope !== null ? { researchScope: row.research_scope } : {}),
    ...(row.notes !== null ? { notes: row.notes } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function toCompany(row: CompanyRow): Company {
  return {
    id: row.id as Company["id"],
    name: row.name,
    normalizedName: row.normalized_name,
    ...(row.country_or_region !== null ? { countryOrRegion: row.country_or_region } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function toItemCompany(row: ItemCompanyRow): ItemCompany {
  return {
    itemId: row.item_id as ItemCompany["itemId"],
    companyId: row.company_id as ItemCompany["companyId"],
    ...(row.note !== null ? { note: row.note } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function toConversation(row: ConversationRow): Conversation {
  return {
    id: row.id as ConversationId,
    title: row.title,
    hasUserMessage: row.has_user_message === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function toMessage(row: MessageRow): ChatMessage {
  return {
    id: row.id as MessageId,
    conversationId: row.conversation_id as ConversationId,
    role: row.role,
    content: row.content,
    createdAt: row.created_at,
  };
}
