import { dirname, basename, join } from "node:path";
import type { DocumentSavePort } from "../../../../capabilities/company-research/host-ports.js";
import { Value } from "typebox/value";
import { AppError, CompanyResearchWordExportSelectionSchema, type CompanyResearchWordExportSelection } from "@deepfield/contracts";
import { type ResearchRun } from "../../../../capabilities/company-research/contracts/index.js";
import { buildCompanyResearchDocx } from "../../../../capabilities/company-research/export/company-research-word-document.js";

export type CompanyResearchWordExportResult = { status: "saved" | "cancelled" };

export interface CompanyResearchWordExportService {
  export(itemId: string, companyId: string, runId: string, selection: CompanyResearchWordExportSelection): Promise<CompanyResearchWordExportResult>;
}

type SaveDialogOptions = {
  title: string;
  defaultPath: string;
  buttonLabel: string;
  filters: Array<{ name: string; extensions: string[] }>;
  properties: ["createDirectory", "showOverwriteConfirmation"];
};

type ExportDependencies = DocumentSavePort & {
  getRun(itemId: string, companyId: string, runId: string): ResearchRun | undefined;
  showSaveDialog(options: SaveDialogOptions): Promise<{ canceled: boolean; filePath?: string }>;
  buildDocument?(run: ResearchRun, selection: CompanyResearchWordExportSelection): Promise<Buffer>;
};

function safeFileNamePart(value: string): string {
  const cleaned = value.replace(/[<>:"/\\|?*\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim().replace(/[. ]+$/g, "");
  return (cleaned || "调研报告").slice(0, 48);
}

function defaultFileName(run: ResearchRun): string {
  if (run.schemaVersion === "legacy-freeform-v1") return `历史调研-${safeFileNamePart(run.completedAt.slice(0, 10))}.docx`;
  return `${safeFileNamePart(run.researchContext.companyName)}-${safeFileNamePart(run.template.title)}-${safeFileNamePart(run.asOfDate)}.docx`;
}

function canExport(run: ResearchRun): boolean {
  if (run.schemaVersion === "legacy-freeform-v1") return run.reportText.trim().length > 0;
  if (run.status === "researching" || run.status === "structuring") return false;
  return (run.rawReportText?.trim().length ?? 0) > 0;
}

function hasRaw(run: ResearchRun): boolean {
  return run.schemaVersion === "legacy-freeform-v1"
    ? run.reportText.trim().length > 0
    : (run.rawReportText?.trim().length ?? 0) > 0;
}

function hasStructured(run: ResearchRun): boolean {
  return run.schemaVersion === "company-research-report-v1"
    && run.status === "completed"
    && run.structuredContent !== undefined;
}

export function createCompanyResearchWordExportService(deps: ExportDependencies): CompanyResearchWordExportService {
  return {
    async export(itemId, companyId, runId, selection) {
      if (!Value.Check(CompanyResearchWordExportSelectionSchema, selection) || (!selection.raw && !selection.structured)) {
        throw new AppError("INPUT.INVALID");
      }
      let authoritative: ResearchRun | undefined;
      try {
        authoritative = deps.getRun(itemId, companyId, runId);
      } catch {
        throw new AppError("RESOURCE.NOT_FOUND");
      }
      if (!authoritative) throw new AppError("RESOURCE.NOT_FOUND");
      if (!canExport(authoritative)) throw new AppError("BUSINESS.CONFLICT");
      if ((selection.raw && !hasRaw(authoritative)) || (selection.structured && !hasStructured(authoritative))) {
        throw new AppError("BUSINESS.CONFLICT");
      }
      const snapshot = structuredClone(authoritative);
      const selected = structuredClone(selection);
      const choice = await deps.showSaveDialog({
        title: "导出公司调研报告",
        defaultPath: defaultFileName(snapshot),
        buttonLabel: "导出 Word",
        filters: [{ name: "Word 文档", extensions: ["docx"] }],
        properties: ["createDirectory", "showOverwriteConfirmation"],
      });
      if (choice.canceled || !choice.filePath) return { status: "cancelled" };
      if (!choice.filePath.toLowerCase().endsWith(".docx")) throw new AppError("INPUT.INVALID");
      const destination = choice.filePath;
      const temporary = join(dirname(destination), `.${basename(destination)}.${deps.randomToken()}.tmp`);
      let temporaryCreated = false;
      try {
        const document = await (deps.buildDocument ?? buildCompanyResearchDocx)(snapshot, selected);
        await deps.writeFile(temporary, document, { flag: "wx" });
        temporaryCreated = true;
        await deps.rename(temporary, destination);
        return { status: "saved" };
      } catch {
        if (temporaryCreated) {
          try { await deps.unlink(temporary); } catch { /* best-effort cleanup */ }
        }
        throw new AppError("STORAGE.FAILED");
      }
    },
  };
}
