import { describe, expect, it, vi } from "vitest";
import { AppError } from "@deepfield/contracts";
import { type ResearchRun } from "../../../../capabilities/company-research/contracts/index.js";
import { createCompanyResearchWordExportService } from "./company-research-word-export.js";
import { researchRun } from "./ipc-test-helpers.js";

const DEFAULT_RUN = researchRun({
  status: "completed", rawReportText: "已保存原文", rawCompletedAt: "2026-09-11T01:00:00.000Z",
  structuredContent: { coreSummary: ["结论"], sections: [] }, completedAt: "2026-09-11T01:10:00.000Z",
});

function setup(run: ResearchRun | null | "default" = "default") {
  const selectedRun = run === "default" ? structuredClone(DEFAULT_RUN) : run ?? undefined;
  const getRun = vi.fn(() => selectedRun);
  const showSaveDialog = vi.fn(async (_options: unknown): Promise<{ canceled: boolean; filePath?: string }> => ({ canceled: false, filePath: "/chosen/报告.docx" }));
  const buildDocument = vi.fn(async (_run: ResearchRun, _selection: { raw: boolean; structured: boolean }) => Buffer.from("docx"));
  const writeFile = vi.fn(async () => {});
  const rename = vi.fn(async () => {});
  const unlink = vi.fn(async () => {});
  const service = createCompanyResearchWordExportService({
    getRun, showSaveDialog, buildDocument, writeFile, rename, unlink,
    randomToken: () => "token",
  });
  return { service, getRun, showSaveDialog, buildDocument, writeFile, rename, unlink, run: selectedRun };
}

describe("company research Word export service", () => {
  it("looks up and snapshots the owned saved run before the save dialog, then atomically publishes the document", async () => {
    const f = setup();
    f.showSaveDialog.mockImplementation(async (rawOptions) => {
      const options = rawOptions as { defaultPath: string };
      (f.run as { rawReportText?: string }).rawReportText = "被并发修改";
      expect(options.defaultPath).toBe("ACME-产品与技术-2026-09-11.docx");
      return { canceled: false, filePath: "/chosen/报告.docx" };
    });
    await expect(f.service.export("item-1", "company-1", "run-1", { raw: true, structured: true })).resolves.toEqual({ status: "saved" });
    expect(f.getRun).toHaveBeenCalledWith("item-1", "company-1", "run-1");
    expect(f.buildDocument.mock.calls[0]![0]).toMatchObject({ rawReportText: "已保存原文" });
    expect(f.buildDocument.mock.calls[0]![1]).toEqual({ raw: true, structured: true });
    expect(f.writeFile).toHaveBeenCalledWith("/chosen/.报告.docx.token.tmp", Buffer.from("docx"), { flag: "wx" });
    expect(f.rename).toHaveBeenCalledWith("/chosen/.报告.docx.token.tmp", "/chosen/报告.docx");
  });

  it("treats native cancellation as neutral and never builds or writes", async () => {
    const f = setup();
    f.showSaveDialog.mockResolvedValue({ canceled: true });
    await expect(f.service.export("item-1", "company-1", "run-1", { raw: true, structured: false })).resolves.toEqual({ status: "cancelled" });
    expect(f.buildDocument).not.toHaveBeenCalled();
    expect(f.writeFile).not.toHaveBeenCalled();
    expect(f.rename).not.toHaveBeenCalled();
  });

  it("rejects missing ownership and active or empty failed reports before opening a dialog", async () => {
    for (const run of [null, researchRun(), researchRun({ status: "research_failed", lastFailureCode: "tool_failed" })]) {
      const f = setup(run);
      const error = await f.service.export("item-1", "company-1", "run-1", { raw: true, structured: false }).catch((value) => value);
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe(run === null ? "RESOURCE.NOT_FOUND" : "BUSINESS.CONFLICT");
      expect(f.showSaveDialog).not.toHaveBeenCalled();
    }
  });

  it("rejects empty or unavailable selections before opening the native save dialog", async () => {
    const structured = setup();
    for (const selection of [{ raw: false, structured: false }, { raw: false, structured: true, extra: true } as never]) {
      const error = await structured.service.export("item-1", "company-1", "run-1", selection).catch((value) => value);
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe("INPUT.INVALID");
    }
    expect(structured.showSaveDialog).not.toHaveBeenCalled();

    const rawOnly = setup(researchRun({ status: "structure_failed", rawReportText: "原始正文", lastFailureCode: "structuring_failed" }));
    const unavailable = await rawOnly.service.export("item-1", "company-1", "run-1", { raw: false, structured: true }).catch((value) => value);
    expect(unavailable).toBeInstanceOf(AppError);
    expect((unavailable as AppError).code).toBe("BUSINESS.CONFLICT");
    expect(rawOnly.showSaveDialog).not.toHaveBeenCalled();
  });

  it("cleans the sibling temporary file and returns only a bounded storage error when saving fails", async () => {
    const f = setup();
    f.rename.mockRejectedValue(new Error("/chosen/private-path sk-secret"));
    const original = structuredClone(f.run);
    const error = await f.service.export("item-1", "company-1", "run-1", { raw: true, structured: true }).catch((value) => value);
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe("STORAGE.FAILED");
    expect(f.unlink).toHaveBeenCalledWith("/chosen/.报告.docx.token.tmp");
    expect(f.run).toEqual(original);
    expect(JSON.stringify(error)).not.toContain("chosen");
    expect(JSON.stringify(error)).not.toContain("secret");
  });

  it("never changes the native-dialog-approved destination and never removes a colliding temporary file it did not create", async () => {
    const f = setup();
    f.showSaveDialog.mockResolvedValue({ canceled: false, filePath: "/chosen/report" });
    const wrongExtension = await f.service.export("item-1", "company-1", "run-1", { raw: true, structured: true }).catch((value) => value);
    expect(wrongExtension).toBeInstanceOf(AppError);
    expect((wrongExtension as AppError).code).toBe("INPUT.INVALID");
    expect(f.writeFile).not.toHaveBeenCalled();

    f.showSaveDialog.mockResolvedValue({ canceled: false, filePath: "/chosen/report.docx" });
    f.writeFile.mockRejectedValueOnce(new Error("EEXIST"));
    const collision = await f.service.export("item-1", "company-1", "run-1", { raw: true, structured: true }).catch((value) => value);
    expect(collision).toBeInstanceOf(AppError);
    expect((collision as AppError).code).toBe("STORAGE.FAILED");
    expect(f.rename).not.toHaveBeenCalled();
    expect(f.unlink).not.toHaveBeenCalled();
  });
});
