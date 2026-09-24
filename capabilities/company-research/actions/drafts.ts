import { createHash, randomUUID } from "node:crypto";
import { canonicalActionJson, type DraftRef } from "@deepfield/capability-sdk";
import type { Repositories } from "@deepfield/persistence";
import type { StartCompanyResearchInput } from "../contracts/index.js";
import type { CompanyResearchService } from "../application/company-research-service.js";
export const CAPABILITY_ID = "company-research";
export type ProtocolStore = Repositories["companyResearchProtocol"];
export type ResearchParameters = StartCompanyResearchInput & { itemId: string; companyId: string };
export interface PreparedResearch { draftRef: DraftRef; parameters: ResearchParameters }
export interface StoredDraft extends PreparedResearch { submittedTaskId?: string }
export function protocolError(code: "revision_changed" | "not_found" | "expired"): Error & { code: string } { return Object.assign(new Error(code), { code }); }
export function revision(value: unknown): string { return `sha256:${createHash("sha256").update(canonicalActionJson(value)).digest("hex")}`; }

export class ResearchDrafts {
  constructor(readonly store: ProtocolStore, private readonly research: CompanyResearchService) {}
  prepare(parameters: ResearchParameters): PreparedResearch {
    const normalized = this.normalize(parameters);
    const draft = { draftRef: { capabilityId: CAPABILITY_ID, draftId: randomUUID(), revision: randomUUID() }, parameters: normalized };
    this.save(draft); return draft;
  }
  get(ref: DraftRef): StoredDraft {
    if (ref.capabilityId !== CAPABILITY_ID) throw protocolError("not_found");
    const data = this.store.getDraft(ref.draftId);
    if (!data) throw protocolError("not_found");
    const draft = JSON.parse(data) as StoredDraft;
    if (draft.draftRef.revision !== ref.revision) throw protocolError("revision_changed");
    return draft;
  }
  update(ref: DraftRef, parameters: ResearchParameters): PreparedResearch {
    const current = this.get(ref);
    if (current.submittedTaskId) throw protocolError("expired");
    const draft = { draftRef: { ...ref, revision: randomUUID() }, parameters: this.normalize(parameters) };
    this.save(draft); return draft;
  }
  /** Synchronous revision invalidation as soon as an external draft is edited. */
  invalidate(ref: DraftRef): PreparedResearch { const current = this.get(ref); return this.update(ref, current.parameters); }
  validate(prepared: PreparedResearch): StoredDraft {
    const current = this.get(prepared.draftRef);
    if (revision(current.parameters) !== revision(prepared.parameters)) throw protocolError("revision_changed");
    this.normalize(current.parameters);
    return current;
  }
  save(draft: StoredDraft): void { this.store.saveDraft(draft.draftRef.draftId, JSON.stringify(draft)); }
  private normalize(parameters: ResearchParameters): ResearchParameters {
    const { itemId, companyId, direction, asOfDate, focusScope } = parameters;
    const input = { direction, asOfDate, ...(focusScope?.trim() ? { focusScope: focusScope.trim() } : {}) };
    this.research.validateBatchEntry(itemId, companyId, input);
    return { itemId, companyId, ...input };
  }
}
