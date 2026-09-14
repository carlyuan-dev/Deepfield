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
  const aliases = row.aliases_json === null ? undefined : JSON.parse(row.aliases_json);
  const officialWebsite =
    row.official_website_json === null ? undefined : JSON.parse(row.official_website_json);
  const stockListings =
    row.stock_listings_json === null ? undefined : JSON.parse(row.stock_listings_json);
  const businessTags =
    row.business_tags_json === null ? undefined : JSON.parse(row.business_tags_json);
  return {
    id: row.id as Company["id"],
    name: row.name,
    normalizedName: row.normalized_name,
    profileStatus: row.profile_status,
    ...(row.legal_name !== null ? { legalName: row.legal_name } : {}),
    ...(aliases !== undefined ? { aliases } : {}),
    ...(row.headquarters !== null
      ? { headquarters: row.headquarters }
      : row.country_or_region !== null
        ? { headquarters: row.country_or_region }
        : {}),
    ...(row.founded_at !== null ? { foundedAt: row.founded_at } : {}),
    ...(officialWebsite !== undefined ? { officialWebsite } : {}),
    ...(stockListings !== undefined ? { stockListings } : {}),
    ...(businessTags !== undefined ? { businessTags } : {}),
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
    ...(row.request_id !== null ? { requestId: row.request_id } : {}),
  };
}
