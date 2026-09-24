// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { CapabilityHost } from "./CapabilityHost.js";
import type { CapabilityUiModule } from "@deepfield/capability-sdk";
import { CapabilityInteractionState } from "./interaction-state.js";

afterEach(cleanup);
const props = { capabilityId: "example", uiEntry: "deepfield-capability://example/dist/ui.js", bridge: { invoke: async () => null, subscribe: () => () => {} }, onClose() {}, onOpenSettings() {} };
it("loads relative CSS and releases it with a failed render", async () => {
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  const module: CapabilityUiModule = { cssPaths: ["ui.css"], createView: () => () => { throw new Error("private"); } };
  render(<CapabilityHost {...props} loadModule={async () => module} />);
  await waitFor(() => expect(document.querySelector("link[data-capability-style]")).not.toBeNull());
  const link = document.querySelector("link[data-capability-style]") as HTMLLinkElement;
  expect(link.href).toBe("deepfield-capability://example/dist/ui.css");
  fireEvent.load(link);
  expect(await screen.findByRole("alert")).toBeTruthy();
  expect(document.querySelector("link[data-capability-style]")).toBeNull();
  log.mockRestore();
});
it.each(["https://evil.test/ui.css", "/ui.css", "../ui.css", "%2e%2e/ui.css", "//other/ui.css"])("rejects escaping CSS %s", async path => {
  render(<CapabilityHost {...props} loadModule={async () => ({ cssPaths: [path], createView: () => () => <p>Loaded</p> })} />);
  expect(await screen.findByRole("alert")).toBeTruthy(); expect(document.querySelector("link[data-capability-style]")).toBeNull();
});
it("treats CSS errors as package failures and cleans every stylesheet", async () => {
  render(<CapabilityHost {...props} loadModule={async () => ({ cssPaths: ["ui.css"], createView: () => () => <p>Loaded</p> })} />);
  await waitFor(() => expect(document.querySelector("link[data-capability-style]")).not.toBeNull());
  fireEvent.error(document.querySelector("link[data-capability-style]")!);
  expect(await screen.findByRole("alert")).toBeTruthy(); expect(document.querySelector("link[data-capability-style]")).toBeNull();
});
it("connects package navigation registration and only opens after the package commits", async () => {
  const interaction = new CapabilityInteractionState();
  const module: CapabilityUiModule = { createView: runtime => function View({ navigation }) {
    const [page, setPage] = runtime.react.useState("original");
    runtime.react.useEffect(() => navigation?.register({
      canLeave: () => true,
      open: async (target, context) => {
        const applied = context.commit(() => setPage("draftId" in target ? `${target.draftId}:${target.revision}` : target.viewId));
        return { status: applied ? "opened" : "blocked" };
      },
    }), [navigation]);
    return <p>{page}</p>;
  } };
  render(<CapabilityHost {...props} interaction={interaction} loadModule={async () => module} />);
  await screen.findByText("original");
  const target = { capabilityId: "example", draftId: "draft", revision: "rev-7" };
  const result = await interaction.open({ kind: "open", requestId: "r", target, view: { capabilityId: "example", viewId: "edit", input: {} }, expiresAt: Date.now() + 1000 }, () => {});
  expect(result).toEqual({ status: "opened" });
  expect(await screen.findByText("draft:rev-7")).toBeTruthy();
});
