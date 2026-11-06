import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type PermissionHandler = (
  webContents: unknown,
  permission: string,
  callback: (allowed: boolean) => void,
) => void;

const electronMock = vi.hoisted(() => {
  const state: {
    permissionHandler?: PermissionHandler;
    options?: Record<string, unknown>;
  } = {};
  const webContents = {
    getURL: vi.fn(() => "file:///app/index.html"),
    on: vi.fn(),
    session: {
      setPermissionRequestHandler: vi.fn((handler: PermissionHandler) => {
        state.permissionHandler = handler;
      }),
    },
    setWindowOpenHandler: vi.fn(),
  };
  class BrowserWindow {
    constructor(options: Record<string, unknown>) { state.options = options; }
    static getAllWindows = vi.fn(() => []);
    readonly webContents = webContents;
    readonly loadFile = vi.fn(async () => undefined);
    readonly loadURL = vi.fn(async () => undefined);
  }
  return {
    BrowserWindow,
    openExternal: vi.fn(async () => undefined),
    state,
    webContents,
  };
});

vi.mock("electron", () => ({
  BrowserWindow: electronMock.BrowserWindow,
  shell: { openExternal: electronMock.openExternal },
}));

import { createWindow } from "./window.js";

describe("desktop window permissions", () => {
  afterEach(() => vi.unstubAllEnvs());
  beforeEach(() => {
    vi.clearAllMocks();
    Reflect.deleteProperty(electronMock.state, "permissionHandler");
  });

  it("continues denying clipboard web permission requests", () => {
    createWindow();
    let allowed: boolean | undefined;

    electronMock.state.permissionHandler?.(
      electronMock.webContents,
      "clipboard-sanitized-write",
      (value) => {
        allowed = value;
      },
    );

    expect(allowed).toBe(false);
  });

  it("keeps background tests hidden and unfocusable while normal launches remain visible", () => {
    vi.stubEnv("DEEPFIELD_E2E_BACKGROUND", "1");
    vi.stubEnv("DEEPFIELD_E2E", "1");
    createWindow();
    expect(electronMock.state.options).toMatchObject({ show: false, focusable: false, webPreferences: { backgroundThrottling: false } });
    vi.stubEnv("DEEPFIELD_E2E", "0");
    createWindow();
    expect(electronMock.state.options).toMatchObject({ show: true, focusable: true });
  });
});
