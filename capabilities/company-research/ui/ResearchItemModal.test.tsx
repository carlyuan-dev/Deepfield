// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { CapabilityInteractionEditor, CapabilityFormSnapshot } from "@deepfield/capability-sdk";
import { makeFakeApi } from "../../../apps/desktop/src/renderer/renderer-test-helpers.js";
import { ResearchItemModal } from "./ResearchItemModal.js";
import { useInteractionForm } from "./form-control.js";

function editorFixture() {
  let revision = 1; let status = "waiting";
  let values = { industry: "模型主题", notes: "初稿" };
  const listeners = new Set<() => void>(); const createTopic = vi.fn();
  const snapshot = (): CapabilityFormSnapshot => ({ draft: { capabilityId: "company-research", draftId: "d", revision: String(revision) }, view: { capabilityId: "company-research", viewId: "form", input: {} }, values: { ...values }, inputSchema: {}, transitions: [], readyToSubmit: true });
  const assertRevision = (expected: number) => { if (revision !== expected) throw new Error("revision_changed"); };
  const notify = () => listeners.forEach(listener => listener());
  const editor: CapabilityInteractionEditor = {
    read: async () => ({ revision, status, formId: "topic", actionId: "topics.create", snapshot: snapshot() }),
    beginEdit: vi.fn(async expected => { assertRevision(expected); status = "editing"; revision++; notify(); }),
    update: async (expected, patch) => { assertRevision(expected); values = { ...values, ...patch as object }; status = "waiting"; revision++; notify(); return { revision }; },
    transition: async () => ({ revision }),
    respond: async (expected, decision) => { assertRevision(expected); if (decision === "approve") createTopic(values); status = decision === "approve" ? "resolved" : "cancelled"; revision++; notify(); },
    subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); },
  };
  return { editor, createTopic, modelPatch: (patch: Partial<typeof values>) => { if (status !== "waiting") throw new Error("human_editing"); values = { ...values, ...patch }; revision++; notify(); } };
}
it("uses the original topic form for user edits and model patches, with exactly one final create", async () => {
  const api = makeFakeApi(); const f = editorFixture();
  function Form() { const { control, error } = useInteractionForm(f.editor); return control ? <><ResearchItemModal api={api} control={control} onClose={() => {}} onSaved={() => {}} />{error && <p>{error}</p>}</> : null; }
  render(<Form />);
  const name = await screen.findByLabelText("主题名称");
  fireEvent.change(name, { target: { value: "用户修改的主题" } });
  expect(f.editor.beginEdit).toHaveBeenCalledWith(1);
  await waitFor(async () => expect((await f.editor.read()).status).toBe("waiting"));
  await act(async () => f.modelPatch({ notes: "模型深化后的备注" }));
  await waitFor(() => expect((screen.getByLabelText("备注（可选）") as HTMLTextAreaElement).value).toBe("模型深化后的备注"));
  fireEvent.click(screen.getByRole("button", { name: "创建" }));
  await waitFor(() => expect(f.createTopic).toHaveBeenCalledTimes(1));
  expect(f.createTopic).toHaveBeenCalledWith({ industry: "用户修改的主题", notes: "模型深化后的备注" });
  expect(api.industryResearch.createItem).not.toHaveBeenCalled();
});
it("preserves ordinary manual creation", async () => {
  const api = makeFakeApi(); const saved = vi.fn();
  render(<ResearchItemModal api={api} onClose={() => {}} onSaved={saved} />);
  fireEvent.change(screen.getByLabelText("主题名称"), { target: { value: "手动主题" } });
  fireEvent.click(screen.getByRole("button", { name: "创建" }));
  await waitFor(() => expect(api.industryResearch.createItem).toHaveBeenCalledOnce());
  expect(api.industryResearch.createItem).toHaveBeenCalledWith({ industry: "手动主题" });
});
