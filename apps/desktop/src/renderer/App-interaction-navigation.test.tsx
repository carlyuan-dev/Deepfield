// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { CapabilitySnapshot, InteractionEditorState, InteractionRecord } from "@deepfield/contracts";
import type { CapabilityUiModule } from "@deepfield/capability-sdk";
import { App } from "./App.js";
import { conversation, makeFakeApi } from "./renderer-test-helpers.js";
import { ViewNavigation } from "../main/capabilities/view-navigation.js";

afterEach(cleanup);

const makeInteraction = (id: string, requestId: string): InteractionRecord => ({
  id, conversationId: "c1", requestId, toolCallId: `tool-${id}`, revision: 1,
  status: "waiting", createdAt: "2026-09-23T00:00:00Z", updatedAt: "2026-09-23T00:00:00Z",
  payload: { kind: "approval", summary: `Save ${id}`, operation: { provider: "a", operationId: "save", contractVersion: "1",
    draftRef: JSON.stringify({ capabilityId: "a", draftId: id, revision: "1" }) } },
});

it("opens a new bound form, then preserves the dirty old form when the next navigation is blocked", async () => {
  const api = makeFakeApi();
  const c1 = conversation("c1");
  api.conversations.openInitial.mockResolvedValue({ active: c1, recent: [c1] });
  const snapshot: CapabilitySnapshot = { issues: [], packages: [{ id: "a", name: "A", description: "A", version: "1", status: "ready", enabledNextStart: true,
    navigation: { title: "Package a", order: 0, route: "/a" }, uiEntry: "deepfield-capability://a/ui.js" }] };
  api.capabilityManagement = { list: async () => snapshot, subscribe: () => () => {}, setEnabled: async () => {}, restart: async () => {} };
  const navigation = new ViewNavigation(async target => ({ status: "resolved", view: "viewId" in target ? target : { capabilityId: target.capabilityId, viewId: "edit", input: {} } }));
  api.capabilityNavigation = { subscribe: listener => navigation.attach(1, listener), ack: async (id, capabilityId, result) => navigation.ack(1, id, capabilityId, result),
    retry: id => navigation.retry(1, id), noteManualNavigation: async () => { navigation.noteManualNavigation(); } };
  const listeners = new Set<(id: string) => void>();
  let interactions: InteractionRecord[] = [];
  api.chat.listInteractions.mockImplementation(async () => interactions);
  api.chat.onInteractions.mockImplementation(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; });
  api.chat.readInteractionEditor.mockImplementation(async (_conversationId, id): Promise<InteractionEditorState> => {
    const item = interactions.find(value => value.id === id)!;
    return { interaction: item, formId: id, actionId: "save", form: { draft: { capabilityId: "a", draftId: id, revision: "1" },
      view: { capabilityId: "a", viewId: id, input: {} }, values: {}, inputSchema: {}, transitions: [], readyToSubmit: true } };
  });
  api.chat.autoOpenInteractionEditor.mockImplementation(async (_conversationId, id) => {
    await new Promise(resolve => setTimeout(resolve, 0));
    return navigation.open({ capabilityId: "a", viewId: id, input: {} });
  });
  api.chat.openInteractionEditor.mockImplementation(async (_conversationId, id) => {
    await new Promise(resolve => setTimeout(resolve, 0));
    return navigation.open({ capabilityId: "a", viewId: id, input: {} });
  });
  const load = async (): Promise<CapabilityUiModule> => ({ createView: runtime => function View({ navigation: uiNavigation, interactionEditor }) {
    const [page, setPage] = runtime.react.useState("home");
    const [dirty, setDirty] = runtime.react.useState(false);
    const [bound, setBound] = runtime.react.useState("none");
    runtime.react.useEffect(() => {
      let active = true;
      if (!interactionEditor) { setBound("none"); return; }
      void interactionEditor.read().then(value => { if (active) setBound(value.formId); });
      return () => { active = false; };
    }, [interactionEditor]);
    runtime.react.useEffect(() => uiNavigation?.register({ canLeave: () => !dirty && !interactionEditor,
      open: async (_target, context) => ({ status: context.commit(() => setPage(context.view.viewId)) ? "opened" : "blocked" }) }), [uiNavigation, dirty, interactionEditor]);
    return <><p>page:{page}</p><p>bound:{bound}</p><input aria-label="form-dirty" type="checkbox" checked={dirty} onChange={event => setDirty(event.target.checked)} /></>;
  } });
  render(<App api={api} loadCapabilityModule={load} requestIdFactory={(() => { let n = 0; return () => `r${++n}`; })()} />);
  fireEvent.click(await screen.findByRole("button", { name: "Package a" }));
  await screen.findByText("page:home");
  const trigger = async (id: string, requestId: string) => {
    fireEvent.change(screen.getByLabelText("消息输入"), { target: { value: `request ${id}` } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    act(() => api.emit({ type: "started", requestId }));
    interactions = [...interactions, makeInteraction(id, requestId)];
    act(() => { for (const listener of listeners) listener("c1"); });
  };
  await trigger("first", "r1");
  await waitFor(() => expect(screen.getByText("page:first")).toBeTruthy());
  await waitFor(() => expect(screen.getByText("bound:first")).toBeTruthy());
  fireEvent.click(screen.getByLabelText("form-dirty"));
  act(() => api.emit({ type: "handed_off", requestId: "r1" }));
  await trigger("second", "r2");
  await waitFor(() => expect(api.chat.autoOpenInteractionEditor).toHaveBeenCalledWith("c1", "second"));
  expect(screen.getByText("page:first")).toBeTruthy();
  expect(screen.getByText("bound:first")).toBeTruthy();
  expect((screen.getByLabelText("form-dirty") as HTMLInputElement).checked).toBe(true);
  fireEvent.click(screen.getAllByRole("button", { name: "查看或编辑表单" }).at(-1)!);
  await waitFor(() => expect(api.chat.openInteractionEditor).toHaveBeenCalledWith("c1", "second"));
  await screen.findByText("打开表单失败。");
  expect(screen.getByText("page:first")).toBeTruthy();
  expect(screen.getByText("bound:first")).toBeTruthy();
  expect((screen.getByLabelText("form-dirty") as HTMLInputElement).checked).toBe(true);
  // A terminal result arrives before the interaction subscription refreshes React.
  fireEvent.click(screen.getByLabelText("form-dirty"));
  interactions = interactions.map(item => item.id === "first" ? { ...item, status: "succeeded" as const } : item);
  await act(async () => { expect(await navigation.open({ capabilityId: "a", viewId: "created-result", input: {} })).toMatchObject({ status: "opened" }); });
  expect(screen.getByText("page:created-result")).toBeTruthy();
  expect(screen.getByText("bound:none")).toBeTruthy();
  navigation.dispose();
});
