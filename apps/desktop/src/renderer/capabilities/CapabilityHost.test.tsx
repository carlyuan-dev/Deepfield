// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { CapabilityHost } from "./CapabilityHost.js";
import type { CapabilityUiModule } from "@deepfield/capability-sdk";

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
