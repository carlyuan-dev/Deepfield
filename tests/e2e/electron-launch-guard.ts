export function assertElectronE2EAllowed(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): void {
  if (platform !== "darwin") return;
  if (env.CODEX_SANDBOX === "seatbelt") {
    throw new Error(
      "macOS Seatbelt 中 Electron E2E 启动被明确禁止；请勿在 sandbox 内重试或绕过限制。",
    );
  }
  if (env.DEEPFIELD_ALLOW_ELECTRON_E2E !== "1") {
    throw new Error(
      "macOS Electron E2E 需要显式设置 DEEPFIELD_ALLOW_ELECTRON_E2E=1；运行前请先确认 GUI 权限。",
    );
  }
}
