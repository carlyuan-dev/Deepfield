import { runProfileDiagnostic } from "./profile-diagnose-runner.js";

// Only structured whitelisted stdout is allowed; dependency debug logging must
// never accidentally echo a request, credentials, response body or prompt.
console.log = console.info = console.warn = console.error = console.debug = () => {};
async function main(): Promise<number> {
  if (process.env.DEEPFIELD_PROFILE_DIAGNOSE_LIVE !== "1") return 1;
  const chunks: Buffer[] = []; let bytes = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > 1_000_000) return 1;
    chunks.push(buffer);
  }
  let input: unknown;
  try { input = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return 1; }
  return runProfileDiagnostic(input, (line) => process.stdout.write(`${line}\n`));
}
try { process.exitCode = await main(); }
catch { process.exitCode = 1; }
if (process.exitCode === 1) process.stderr.write("profile_diagnose_harness_failed\n");
