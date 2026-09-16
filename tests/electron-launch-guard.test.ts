import { describe, expect, it } from "vitest";
import { assertElectronE2EAllowed } from "./e2e/electron-launch-guard.js";

describe("Electron E2E launch guard", () => {
  it("always rejects macOS Seatbelt even when the opt-in flag is set", () => {
    expect(() => assertElectronE2EAllowed("darwin", {
      CODEX_SANDBOX: "seatbelt",
      DEEPFIELD_ALLOW_ELECTRON_E2E: "1",
    })).toThrow(/Seatbelt.*Electron E2E.*禁止/u);
  });

  it("requires an explicit GUI opt-in on macOS outside Seatbelt", () => {
    expect(() => assertElectronE2EAllowed("darwin", {})).toThrow(
      /DEEPFIELD_ALLOW_ELECTRON_E2E=1.*GUI 权限/u,
    );
    expect(() => assertElectronE2EAllowed("darwin", {
      DEEPFIELD_ALLOW_ELECTRON_E2E: "1",
    })).not.toThrow();
  });

  it("does not block non-macOS environments", () => {
    expect(() => assertElectronE2EAllowed("linux", { CODEX_SANDBOX: "seatbelt" })).not.toThrow();
  });
});
