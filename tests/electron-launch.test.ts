import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { _electron, ElectronApplication, Page } from "@playwright/test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupElectronUserData, copyElectronAppForE2E, createElectronE2ELauncher, createElectronUserData, validateElectronApp } from "./e2e/electron-launch.js";

const cleanup: Array<() => void> = [];
function directory(): string {
  const root = mkdtempSync(join(tmpdir(), "deepfield-launch-unit-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
function userData(): string {
  const root = createElectronUserData();
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
function bundle(): { app: string; executable: string; framework: string } {
  const app = join(directory(), "Deepfield.app");
  const executable = join(app, "Contents/MacOS/Deepfield");
  const framework = join(app, "Contents/Frameworks/Electron Framework.framework");
  mkdirSync(join(app, "Contents/MacOS"), { recursive: true });
  mkdirSync(join(framework, "Versions/A/Resources"), { recursive: true });
  writeFileSync(executable, "fixture");
  chmodSync(executable, 0o755);
  writeFileSync(join(framework, "Versions/A/Electron Framework"), "fixture");
  chmodSync(join(framework, "Versions/A/Electron Framework"), 0o755);
  writeFileSync(join(framework, "Versions/A/Resources/icudtl.dat"), "fixture");
  symlinkSync("A", join(framework, "Versions/Current"));
  symlinkSync("Versions/Current/Resources", join(framework, "Resources"));
  symlinkSync("Versions/Current/Electron Framework", join(framework, "Electron Framework"));
  return { app, executable, framework };
}
function fakeApp() {
  const page = { waitForLoadState: vi.fn().mockResolvedValue(undefined) } as unknown as Page;
  const child = Object.assign(new EventEmitter(), { stderr: new PassThrough(), exitCode: null as number | null, signalCode: null as string | null, kill: vi.fn().mockReturnValue(true) });
  const close = vi.fn(async () => { child.exitCode = 0; child.emit("exit", 0, null); });
  const app = { firstWindow: vi.fn().mockResolvedValue(page), close, process: () => child } as unknown as ElectronApplication;
  const launch = vi.fn<typeof _electron.launch>().mockResolvedValue(app);
  return { app, close, launch, child };
}

beforeEach(() => {
  vi.stubEnv("CODEX_SANDBOX", "");
  vi.stubEnv("DEEPFIELD_ALLOW_ELECTRON_E2E", "1");
});
afterEach(() => {
  cleanup.splice(0).reverse().forEach((dispose) => dispose());
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("shared Electron launch boundary (no GUI)", () => {
  it("checks the real boundary guard before calling even an injected launcher", async () => {
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
    cleanup.push(() => Object.defineProperty(process, "platform", platform));
    vi.stubEnv("CODEX_SANDBOX", "seatbelt");
    const { launch } = fakeApp();
    await expect(createElectronE2ELauncher(launch)({ userDataDir: userData() })).rejects.toThrow(/Seatbelt/);
    expect(launch).not.toHaveBeenCalled();
  });

  it("forces isolated E2E data, removes RunAsNode, defaults fake and supports explicit real mode/restart", async () => {
    const { executable } = bundle();
    const root = userData();
    vi.stubEnv("ELECTRON_RUN_AS_NODE", "1");
    vi.stubEnv("DEEPFIELD_AGENT_MODE", "real");
    vi.stubEnv("DEEPFIELD_USER_DATA_DIR", "/must-not-use");
    const { launch } = fakeApp();
    const run = createElectronE2ELauncher(launch);
    await run({ userDataDir: root, executablePath: executable });
    expect(launch.mock.calls[0]?.[0]?.env).toMatchObject({ DEEPFIELD_AGENT_MODE: "fake", DEEPFIELD_E2E: "1", DEEPFIELD_USER_DATA_DIR: root });
    expect(launch.mock.calls[0]?.[0]?.env).not.toHaveProperty("ELECTRON_RUN_AS_NODE");
    await run({ userDataDir: root, executablePath: executable, mode: "real" });
    expect(launch.mock.calls[1]?.[0]?.env?.DEEPFIELD_AGENT_MODE).toBe("real");
  });

  it("rejects caller-owned data directories before spawning", async () => {
    const { launch } = fakeApp();
    await expect(createElectronE2ELauncher(launch)({ userDataDir: directory() })).rejects.toThrow(/createElectronUserData/);
    expect(launch).not.toHaveBeenCalled();
  });

  it("copies Framework relative links verbatim and keeps the copy self-contained", () => {
    const source = bundle();
    const copy = copyElectronAppForE2E(source.app);
    cleanup.push(copy.cleanup);
    expect(readlinkSync(join(copy.appPath, "Contents/Frameworks/Electron Framework.framework/Resources"))).toBe("Versions/Current/Resources");
    rmSync(source.app, { recursive: true });
    expect(() => validateElectronApp(join(copy.appPath, "Contents/MacOS/Deepfield"))).not.toThrow();
  });

  it("rejects Framework links escaping to the original app before spawning", async () => {
    const source = bundle();
    const copy = copyElectronAppForE2E(source.app);
    cleanup.push(copy.cleanup);
    const resource = join(copy.appPath, "Contents/Frameworks/Electron Framework.framework/Resources");
    rmSync(resource);
    symlinkSync(join(source.framework, "Versions/A/Resources"), resource);
    const { launch } = fakeApp();
    await expect(createElectronE2ELauncher(launch)({ userDataDir: userData(), executablePath: join(copy.appPath, "Contents/MacOS/Deepfield") })).rejects.toThrow(/external app symlink.*verbatimSymlinks/);
    expect(launch).not.toHaveBeenCalled();
  });

  it("closes a failed startup, reports safe evidence and blocks subsequent launches", async () => {
    const { executable } = bundle();
    const { app, launch, close } = fakeApp();
    vi.stubEnv("PROVIDER_API_KEY", "private-test-value");
    vi.mocked(app.firstWindow).mockRejectedValue(new Error("firstWindow failed private-test-value\n[pid=12][err] ICU missing icudtl.dat\n[pid=12] process did exit: exitCode=1, signal=null\nENV_DUMP=must-not-print"));
    const run = createElectronE2ELauncher(launch);
    const options = { userDataDir: userData(), executablePath: executable };
    const error = await run(options).catch((failure: Error) => failure);
    expect(String(error)).toContain("ICU missing icudtl.dat");
    expect(String(error)).toContain("exitCode=1");
    expect(String(error)).not.toMatch(/private-test-value|ENV_DUMP/);
    expect(close).toHaveBeenCalledOnce();
    await expect(run(options)).rejects.toThrow(/run stopped/);
    expect(launch).toHaveBeenCalledOnce();
  });

  it("bounds a hung close and retains data when the held child does not confirm exit", async () => {
    vi.useFakeTimers();
    const { executable } = bundle();
    const { app, launch, close, child } = fakeApp();
    const root = userData();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    close.mockImplementation(() => new Promise(() => {}));
    vi.mocked(app.firstWindow).mockRejectedValue(new Error("window unavailable"));
    const result = createElectronE2ELauncher(launch)({ userDataDir: root, executablePath: executable }).catch(String);
    await vi.advanceTimersByTimeAsync(4_001);
    expect(await result).toContain("app.close timed out; main SIGKILL sent; exit unconfirmed");
    expect(child.kill).toHaveBeenCalledExactlyOnceWith("SIGKILL");
    expect(cleanupElectronUserData(root)).toBe(false);
    expect(existsSync(root)).toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(root));
  });

  it("kills only the held child after close rejection and permits cleanup after confirmed exit", async () => {
    const { executable } = bundle();
    const { app, launch, close, child } = fakeApp();
    const root = userData();
    close.mockRejectedValue(new Error("close rejected"));
    child.kill.mockImplementation(() => { child.signalCode = "SIGKILL"; child.emit("exit", null, "SIGKILL"); return true; });
    vi.mocked(app.firstWindow).mockRejectedValue(new Error("window unavailable"));
    await expect(createElectronE2ELauncher(launch)({ userDataDir: root, executablePath: executable })).rejects.toThrow(/app.close rejected; main SIGKILL sent; exit confirmed/);
    expect(child.kill).toHaveBeenCalledExactlyOnceWith("SIGKILL");
    expect(cleanupElectronUserData(root)).toBe(true);
    expect(existsSync(root)).toBe(false);
  });

  it("redacts split credentials before truncation and drops an oversized incomplete stderr line", async () => {
    const { executable } = bundle();
    const { app, launch, child } = fakeApp();
    vi.stubEnv("PROVIDER_API_KEY", "private-test-value");
    vi.mocked(app.firstWindow).mockImplementation(async () => {
      child.stderr.write("private-");
      child.stderr.write("test-value" + "x".repeat(7_990) + "\n");
      child.stderr.write("x".repeat(16_000) + "private-");
      child.stderr.write("test-value\nICU startup evidence\n");
      child.stderr.write("private-");
      throw new Error("startup failed private-test-value" + "x".repeat(12_000));
    });
    const error = await createElectronE2ELauncher(launch)({ userDataDir: userData(), executablePath: executable }).catch(String);
    expect(String(error)).not.toMatch(/private-|test-value/);
    expect(String(error)).toContain("[oversized stderr line omitted]");
    expect(String(error)).toContain("ICU startup evidence");
    expect(String(error)).toContain("[incomplete stderr line omitted]");
  });
});
