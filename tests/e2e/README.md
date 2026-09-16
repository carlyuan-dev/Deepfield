# Electron E2E launch safety

The Electron Playwright suite opens a native macOS application. Never run it when
`CODEX_SANDBOX=seatbelt`: macOS can abort the process during application
registration or `NSApplication` initialization, before the test harness can clean
up normally. Do not retry the launch with elevated permissions from that sandbox.

On macOS outside Seatbelt, first confirm that the current session is allowed to
open GUI applications, then opt in explicitly:

```sh
DEEPFIELD_ALLOW_ELECTRON_E2E=1 npx playwright test
```

The guard runs while `playwright.config.ts` is loaded, before Electron launch.
Builds and pure Vitest/Node tests do not require the opt-in. Electron specs must
continue to use a temporary user-data directory and close the application from a
`finally` block so assertion failures cannot leave a test process behind.
