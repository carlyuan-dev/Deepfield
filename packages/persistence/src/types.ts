import type {
  ChatMessage,
  CapabilityItem,
  CapabilityItemId,
  Company,
  CompanyId,
  CompanyDraft,
  CompanyProfileInput,
  CompanyProfileFields,
  CompanyProfileStatus,
  Conversation,
  ConversationId,
  CreateIndustryResearchItemInput,
  MessageId,
  ResearchRun,
  ActiveResearchRunSummary,
  CompanyResearchContext,
  CompanyResearchTemplateSnapshot,
  KeyResearchRun,
  ResearchRunSummary,
  StructuredResearchContent,
  ResearchRunId,
  StartCompanyResearchInput,
  ItemCompany,
  UpdateIndustryResearchItemInput,
} from "@deepfield/contracts";

export interface CapabilityItemRepository {
  create(input: CreateIndustryResearchItemInput): CapabilityItem;
  update(itemId: CapabilityItemId, input: UpdateIndustryResearchItemInput): CapabilityItem | undefined;
  delete(itemId: CapabilityItemId): boolean;
  list(): CapabilityItem[];
  getById(itemId: CapabilityItemId): CapabilityItem | undefined;
}

export interface CompanyRepository {
  upsert(draft: CompanyDraft): Company;
  update(companyId: Company["id"], input: CompanyProfileInput): Company | undefined;
  completeProfile(companyId: Company["id"], fields: CompanyProfileFields): Company | undefined;
  setProfileStatus(companyId: Company["id"], status: CompanyProfileStatus): Company | undefined;
  getNextPendingProfile(): Company | undefined;
  resetEnrichingProfiles(): number;
  getByNormalizedName(normalizedName: string): Company | undefined;
  list(): Company[];
  getById(companyId: Company["id"]): Company | undefined;
  deleteIfUnreferenced(companyId: Company["id"]): boolean;
}

export interface ItemCompanyRepository {
  add(itemId: CapabilityItemId, companyId: Company["id"], note?: string): ItemCompany;
  listByItem(itemId: CapabilityItemId): ItemCompany[];
  remove(itemId: CapabilityItemId, companyId: Company["id"]): void;
}

export interface CompanyResearchRunRepository {
  createResearching(
    itemId: CapabilityItemId,
    companyId: CompanyId,
    input: StartCompanyResearchInput,
    context: CompanyResearchContext,
    template: CompanyResearchTemplateSnapshot,
  ): KeyResearchRun;
  completeRaw(runId: ResearchRunId, rawReportText: string): KeyResearchRun;
  failStructuring(runId: ResearchRunId): KeyResearchRun;
  retryStructuring(runId: ResearchRunId): KeyResearchRun;
  completeStructured(runId: ResearchRunId, content: StructuredResearchContent): KeyResearchRun;
  /** Throws unless the run is still researching. */
  deleteResearching(runId: ResearchRunId): boolean;
  recoverAbandoned(): { deletedResearching: number; failedStructuring: number };
  getByIdForTarget(itemId: CapabilityItemId, companyId: CompanyId, runId: ResearchRunId): ResearchRun | undefined;
  /** Global occupancy, excluding report bodies and snapshots. */
  getActive(): ActiveResearchRunSummary | undefined;
  /** Completed and structure_failed summaries, newest terminal artifact first. */
  listRuns(itemId: CapabilityItemId, companyId: CompanyId): ResearchRunSummary[];
}

export interface ConversationRepository {
  create(): Conversation;
  getOrCreateDraft(): Conversation;
  getById(conversationId: ConversationId): Conversation | undefined;
  listRecent(): Conversation[];
  activate(conversationId: ConversationId, title: string): Conversation;
  updateTitle(conversationId: ConversationId, title: string): Conversation;
  delete(conversationId: ConversationId): boolean;
}

export interface MessageRepository {
  append(conversationId: ConversationId, role: "user" | "assistant", content: string, requestId?: string): ChatMessage;
  listByConversation(conversationId: ConversationId, limit?: number): ChatMessage[];
}

export type ToolExecutionStatus = "running" | "completed" | "failed" | "cancelled" | "skipped" | "reused";

export interface ToolExecution {
  id: string;
  traceId: string;
  projectId?: string;
  actor: string;
  toolName: string;
  toolVersion: number;
  status: ToolExecutionStatus;
  agentTurnIndex?: number;
  batchId?: string;
  toolCallId?: string;
  budgetConsumed?: boolean;
  inputSummary?: unknown;
  outputSummary?: unknown;
  errorCode?: string;
  attempts: number;
  retries: number;
  bytesReceived: number;
  resultCount: number;
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
}

export interface ToolExecutionStart {
  id: string;
  traceId: string;
  projectId?: string;
  actor: string;
  toolName: string;
  toolVersion: number;
  agentTurnIndex?: number;
  batchId?: string;
  toolCallId?: string;
  budgetConsumed?: boolean;
  inputSummary?: unknown;
  startedAt: string;
}

export interface ToolExecutionFinish {
  id: string;
  status: "completed" | "failed" | "cancelled";
  outputSummary?: unknown;
  errorCode?: string;
  attempts: number;
  retries: number;
  bytesReceived: number;
  resultCount: number;
  finishedAt: string;
  durationMs?: number;
  budgetConsumed?: boolean;
}

export interface ToolExecutionSynthetic {
  id: string;
  traceId: string;
  projectId?: string;
  actor: string;
  toolName: string;
  toolVersion: number;
  status: "skipped" | "reused" | "failed";
  agentTurnIndex: number;
  batchId: string;
  toolCallId: string;
  errorCode?: string;
  attempts: 0;
  budgetConsumed: false;
  startedAt: string;
  finishedAt: string;
}

export interface ToolExecutionRepository {
  start(record: ToolExecutionStart): void;
  finish(record: ToolExecutionFinish): void;
  recordSynthetic(record: ToolExecutionSynthetic): void;
  getById(id: string): ToolExecution | undefined;
  listRecent(limit: number): ToolExecution[];
  listByConversation(conversationId: ConversationId, limit?: number): ToolExecution[];
}

export interface Repositories {
  capabilityItems: CapabilityItemRepository;
  companies: CompanyRepository;
  itemCompanies: ItemCompanyRepository;
  companyResearchRuns: CompanyResearchRunRepository;
  conversations: ConversationRepository;
  messages: MessageRepository;
  toolExecutions: ToolExecutionRepository;
  runInTransaction<T>(work: () => T): T;
}

export interface NewConversation {
  id: ConversationId;
  title: string;
  hasUserMessage: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CapabilityItemRow {
  id: string;
  type: "industry-research";
  industry: string;
  research_scope: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface CompanyRow {
  id: string;
  name: string;
  normalized_name: string;
  country_or_region: string | null;
  legal_name: string | null;
  aliases_json: string | null;
  headquarters: string | null;
  founded_at: string | null;
  official_website_json: string | null;
  stock_listings_json: string | null;
  business_tags_json: string | null;
  profile_status: CompanyProfileStatus;
  created_at: string;
  updated_at: string;
}

export interface ItemCompanyRow {
  item_id: string;
  company_id: string;
  note: string | null;
  created_at: string;
  updated_at: string;
}

export interface ConversationRow {
  id: string;
  title: string;
  has_user_message: number;
  created_at: string;
  updated_at: string;
}

export interface MessageRow {
  id: string;
  conversation_id: string;
  role: "user" | "assistant";
  content: string;
  created_at: string;
  request_id: string | null;
}

export interface ToolExecutionRow {
  id: string;
  trace_id: string;
  project_id: string | null;
  actor: string;
  tool_name: string;
  tool_version: number;
  status: ToolExecutionStatus;
  agent_turn_index: number | null;
  batch_id: string | null;
  tool_call_id: string | null;
  budget_consumed: number | null;
  input_summary_json: string | null;
  output_summary_json: string | null;
  error_code: string | null;
  attempts: number;
  retries: number;
  bytes_received: number;
  result_count: number;
  started_at: string;
  finished_at: string | null;
  duration_ms: number | null;
}

export interface CompanyResearchRunRow {
  id: string;
  item_id: string;
  company_id: string;
  schema_version: string;
  status: string;
  research_direction: string | null;
  focus_scope: string | null;
  as_of_date: string | null;
  research_context_json: string | null;
  template_id: string | null;
  template_version: number | null;
  template_snapshot_json: string | null;
  harness_version: number | null;
  raw_report_text: string | null;
  raw_completed_at: string | null;
  structured_content_json: string | null;
  structuring_attempts: number;
  last_failure_code: string | null;
  legacy_time_scope: string | null;
  legacy_custom_requirements: string | null;
  legacy_report_text: string | null;
  created_at: string;
  completed_at: string | null;
}
