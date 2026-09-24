// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { CapabilitySnapshot } from "@deepfield/contracts";
import type { CapabilityUiModule } from "@deepfield/capability-sdk";
import { App } from "../App.js";
import { makeFakeApi } from "../renderer-test-helpers.js";
import { ViewNavigation } from "../../main/capabilities/view-navigation.js";

afterEach(cleanup);
it("preserves a dirty page across packages and opens the retained target only on explicit retry", async () => {
  const api = makeFakeApi();
  const snapshot: CapabilitySnapshot = { issues: [], packages: ["a", "b"].map(id => ({
    id, name: id, description: id, version: "1.0.0", status: "ready", enabledNextStart: true,
    navigation: { title: `Package ${id}`, order: 0, route: `/${id}` }, uiEntry: `deepfield-capability://${id}/ui.js`,
  })) };
  api.capabilityManagement = { list: async () => snapshot, subscribe: () => () => {}, setEnabled: async () => {}, restart: async () => {} };
  const navigation = new ViewNavigation(async target => ({ status: "resolved", view: "viewId" in target ? target : { capabilityId: target.capabilityId, viewId: "edit", input: {} } }));
  api.capabilityNavigation = { subscribe: listener => navigation.attach(1, listener), ack: async (id, capabilityId, result) => navigation.ack(1, id, capabilityId, result), retry: id => navigation.retry(1, id) };
  const load = async (url: string): Promise<CapabilityUiModule> => {
    const id = new URL(url).hostname;
    return { createView: runtime => function View({ navigation }) {
      const [value, setValue] = runtime.react.useState(id === "a" ? "unsaved" : "");
      const [page, setPage] = runtime.react.useState("home");
      runtime.react.useEffect(() => navigation?.register({ canLeave: () => !value, open: async (_target, context) => {
        return { status: context.commit(() => setPage(context.view.viewId)) ? "opened" : "blocked" };
      } }), [navigation, value]);
      return <><p>{id}:{page}</p><input aria-label={`input-${id}`} value={value} onChange={event => setValue(event.target.value)} /></>;
    } };
  };
  render(<App api={api} loadCapabilityModule={load} />);
  fireEvent.click(await screen.findByRole("button", { name: "Package a" }));
  const input = await screen.findByLabelText("input-a") as HTMLInputElement;
  let result;
  await act(async () => { result = await navigation.open({ capabilityId: "b", viewId: "detail", input: {} }); });
  expect(result).toEqual({ status: "blocked", message: "unsaved_input" });
  expect(input.value).toBe("unsaved");
  expect(screen.queryByLabelText("input-b")).toBeNull();
  fireEvent.change(input, { target: { value: "" } });
  fireEvent.click(await screen.findByRole("button", { name: "打开" }));
  await waitFor(() => expect(screen.getByText("b:detail")).toBeTruthy());
  expect(screen.queryByLabelText("input-a")).toBeNull();
  navigation.dispose();
});
