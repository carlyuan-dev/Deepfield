import type {
  ChatMessage,
  CapabilityItem,
  CapabilityItemId,
  Company,
  CompanyId,
  CompanyDraft,
  Conversation,
  ConversationId,
  CreateIndustryResearchItemInput,
  MessageId,
  ResearchRun,
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
  createRunning(
    itemId: CapabilityItemId,
    companyId: CompanyId,
    input: StartCompanyResearchInput,
  ): ResearchRun;
  complete(runId: ResearchRunId, reportText: string): ResearchRun;
  delete(runId: ResearchRunId): boolean;
  deleteAllRunning(): number;
  getById(runId: ResearchRunId): ResearchRun | undefined;
  getRunning(): ResearchRun | undefined;
  listCompleted(itemId: CapabilityItemId, companyId: CompanyId): ResearchRun[];
}

export interface ConversationRepository {
  create(): Conversation;
  getOrCreateDraft(): Conversation;
  getById(conversationId: ConversationId): Conversation | undefined;
  listRecent(): Conversation[];
  activate(conversationId: ConversationId, title: string): Conversation;
  updateTitle(conversationId: ConversationId, title: string): Conversation;
}

export interface MessageRepository {
  append(conversationId: ConversationId, role: "user" | "assistant", content: string): ChatMessage;
  listByConversation(conversationId: ConversationId, limit?: number): ChatMessage[];
}

export type ToolExecutionStatus = "running" | "completed" | "failed" | "cancelled";

export interface ToolExecution {
  id: string;
  traceId: string;
  projectId?: string;
  actor: string;
  toolName: string;
  toolVersion: number;
  status: ToolExecutionStatus;
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
}

export interface ToolExecutionRepository {
  start(record: ToolExecutionStart): void;
  finish(record: ToolExecutionFinish): void;
  getById(id: string): ToolExecution | undefined;
  listRecent(limit: number): ToolExecution[];
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
}

export interface ToolExecutionRow {
  id: string;
  trace_id: string;
  project_id: string | null;
  actor: string;
  tool_name: string;
  tool_version: number;
  status: ToolExecutionStatus;
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
  status: "running" | "completed";
  time_scope: string;
  custom_requirements: string | null;
  report_text: string | null;
  created_at: string;
  completed_at: string | null;
}
