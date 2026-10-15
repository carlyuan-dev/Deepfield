import { _electron, type ElectronApplication, type Page } from "@playwright/test";
import { accessSync, constants, cpSync, lstatSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { assertElectronE2EAllowed } from "./electron-launch-guard.js";
import type { ChildProcess } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

const userDataDirectories = new Map<string, { dev: number; ino: number; launched: boolean; child?: ChildProcess }>();

/** Only directories created here are accepted; keep the same directory for restart tests. */
export function createElectronUserData(): string {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "deepfield-e2e-")));
  const { dev, ino } = statSync(directory);
  userDataDirectories.set(directory, { dev, ino, launched: false });
  return directory;
}

function exited(child: ChildProcess): boolean {
  return child.exitCode != null || child.signalCode != null;
}

/** Preserve data if startup never returned a process handle or its exit remains unconfirmed. */
export function cleanupElectronUserData(directory: string): boolean {
  assertUserData(directory);
  const state = userDataDirectories.get(directory)!;
  if (state.launched && (!state.child || !exited(state.child))) {
    console.warn(`Electron E2E userData retained: process exit is unconfirmed; inspect before cleanup: ${directory}`);
    return false;
  }
  rmSync(directory, { recursive: true, force: true });
  userDataDirectories.delete(directory);
  return true;
}

function assertUserData(directory: string): void {
  const identity = userDataDirectories.get(directory);
  const current = lstatSync(directory);
  if (!identity || !current.isDirectory() || current.isSymbolicLink()
    || identity.dev !== current.dev || identity.ino !== current.ino || realpathSync(directory) !== directory) {
    throw new Error(`Electron E2E userData must be an unchanged directory from createElectronUserData(): ${directory}`);
  }
}

function assertFile(path: string, executable = false): void {
  if (!statSync(path).isFile()) throw new Error(`Electron E2E expected a file: ${path}`);
  accessSync(path, executable ? constants.R_OK | constants.X_OK : constants.R_OK);
}

/** Read-only validation also catches cpSync's rewritten, source-pointing Framework links. */
export function validateElectronApp(executablePath: string): string {
  const executable = resolve(executablePath);
  const app = dirname(dirname(dirname(executable)));
  if (!app.endsWith(".app") || dirname(executable) !== join(app, "Contents", "MacOS")) {
    throw new Error(`Electron E2E executable must be inside .app/Contents/MacOS: ${executable}`);
  }
  const root = realpathSync(app);
  function inspect(directory: string): void {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        const target = realpathSync(path);
        const child = relative(root, target);
        if (child === ".." || child.startsWith("../") || isAbsolute(child)) {
          throw new Error(`Electron E2E external app symlink: ${path} -> ${target}; copy with verbatimSymlinks: true`);
        }
      } else if (entry.isDirectory()) inspect(path);
    }
  }
  inspect(app);
  assertFile(executable, true);
  const framework = join(app, "Contents", "Frameworks", "Electron Framework.framework");
  assertFile(join(framework, "Electron Framework"), true);
  assertFile(join(framework, "Resources", "icudtl.dat"));
  return executable;
}

/** The destination is always newly created and owned by this test. */
export function copyElectronAppForE2E(sourceApp: string): { appPath: string; cleanup: () => void } {
  assertElectronE2EAllowed(process.platform, process.env);
  if (!sourceApp.endsWith(".app") || !statSync(sourceApp).isDirectory()) {
    throw new Error(`Electron E2E copy requires an .app directory: ${sourceApp}`);
  }
  const root = mkdtempSync(join(tmpdir(), "deepfield-e2e-app-"));
  const appPath = join(root, basename(sourceApp));
  try {
    cpSync(sourceApp, appPath, { recursive: true, verbatimSymlinks: true, errorOnExist: true, force: false });
    return { appPath, cleanup: () => rmSync(root, { recursive: true, force: true }) };
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

function redact(result: string, env: NodeJS.ProcessEnv): string {
  for (const [key, value] of Object.entries(env)) {
    if (value && /key|token|secret|password|credential/i.test(key)) result = result.split(value).join("[REDACTED]");
  }
  return result.replace(/\bsk-[\w-]+/g, "[REDACTED]")
    .replace(/(Bearer\s+)\S+/gi, "$1[REDACTED]")
    .replace(/https?:\/\/[^\s]+/g, "[URL REDACTED]");
}

function safeDiagnostics(error: unknown, stderr: string, env: NodeJS.ProcessEnv): string {
  const message = redact(error instanceof Error ? error.message : String(error), env);
  // Redact before truncating: cutting through a credential first would expose its suffix.
  const lines = message.split("\n").filter((line, index) => index === 0 || /\[err\]|process did exit|exitCode=|signal=/.test(line));
  return `${lines.join("\n")}\n${stderr}`.slice(-12_000);
}

function stderrCapture(env: NodeJS.ProcessEnv) {
  const decoder = new StringDecoder("utf8");
  let output = "";
  let pending = "";
  let dropping = false;
  function finishLine(): void {
    output = (output + (dropping ? "[oversized stderr line omitted]" : redact(pending, env)) + "\n").slice(-8_000);
    pending = "";
    dropping = false;
  }
  return {
    write(chunk: Buffer): void {
      const parts = decoder.write(chunk).split("\n");
      parts.forEach((part, index) => {
        if (!dropping) {
          if (pending.length + part.length > 16_000) { pending = ""; dropping = true; }
          else pending += part;
        }
        if (index < parts.length - 1) finishLine();
      });
    },
    read(): string {
      // A final partial line could itself end halfway through a credential.
      return output + (pending || dropping ? "[incomplete stderr line omitted]\n" : "");
    },
  };
}

async function boundedClose(app: ElectronApplication, child: ChildProcess): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const close = Promise.resolve().then(() => app.close()).then(() => "closed", () => "rejected");
  const result = await Promise.race([close, new Promise<string>((done) => { timer = setTimeout(() => done("timed out"), 2_000); })]);
  clearTimeout(timer);
  if (exited(child)) return `app.close ${result}; main exit confirmed: exitCode=${child.exitCode}, signal=${child.signalCode}`;
  let killed = false;
  try { killed = child.kill("SIGKILL"); } catch { /* Report the failure below without raw exception data. */ }
  if (!exited(child)) {
    await new Promise<void>((done) => {
      const finish = (): void => { clearTimeout(timeout); child.removeListener("exit", finish); done(); };
      const timeout = setTimeout(finish, 2_000);
      child.once("exit", finish);
      if (exited(child)) finish();
    });
  }
  return `app.close ${result}; main SIGKILL ${killed ? "sent" : "failed"}; exit ${exited(child) ? `confirmed: exitCode=${child.exitCode}, signal=${child.signalCode}` : "unconfirmed; userData must be retained"}`;
}

export interface ElectronE2EOptions {
  userDataDir: string;
  mode?: "fake" | "real";
  executablePath?: string;
}

/** One instance is one run. A failed launch needs diagnosis/review before a new run. */
export function createElectronE2ELauncher(launch: typeof _electron.launch) {
  let stopped = false;
  return async ({ userDataDir, mode = "fake", executablePath = process.env.DEEPFIELD_E2E_EXECUTABLE }: ElectronE2EOptions): Promise<{ app: ElectronApplication; page: Page }> => {
    if (stopped) throw new Error("Electron E2E run stopped after its first startup failure; diagnose and obtain main-agent review before a new run.");
    let app: ElectronApplication | undefined;
    const diagnosticEnv = { ...process.env };
    const stderr = stderrCapture(diagnosticEnv);
    try {
      assertElectronE2EAllowed(process.platform, process.env);
      assertUserData(userDataDir);
      const target = executablePath === undefined ? resolve("out/main/index.js") : validateElectronApp(executablePath);
      if (executablePath === undefined) assertFile(target);
      const env: Record<string, string> = { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)), DEEPFIELD_AGENT_MODE: mode, DEEPFIELD_E2E: "1", DEEPFIELD_USER_DATA_DIR: userDataDir };
      delete env.ELECTRON_RUN_AS_NODE;
      const state = userDataDirectories.get(userDataDir)!;
      state.launched = true;
      delete state.child;
      app = await launch({ ...(executablePath === undefined ? { args: [target] } : { executablePath: target }), env });
      state.child = app.process();
      state.child.stderr?.on("data", stderr.write);
      const page = await app.firstWindow();
      await page.waitForLoadState("domcontentloaded");
      return { app, page };
    } catch (error) {
      stopped = true;
      const child = app?.process();
      const exit = child ? `main exitCode=${child.exitCode}, signal=${child.signalCode} (before cleanup)` : "main exit unavailable unless reported by Playwright above";
      const cleanup = app && child ? await boundedClose(app, child) : "no process handle; retain userData if launch was attempted";
      child?.stderr?.removeListener("data", stderr.write);
      throw new Error(`Electron E2E startup failed; run stopped.\n${safeDiagnostics(error, stderr.read(), diagnosticEnv)}\n${exit}; helper stderr/exit only available if forwarded by Electron/Playwright; ${cleanup}`);
    }
  };
}

export const launchElectronE2E = createElectronE2ELauncher((options) => _electron.launch(options));
