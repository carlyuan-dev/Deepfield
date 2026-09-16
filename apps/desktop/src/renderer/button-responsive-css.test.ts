import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const app = readFileSync(new URL("./app.css", import.meta.url), "utf8");
const capability = readFileSync(new URL("./capability.css", import.meta.url), "utf8");
const chat = readFileSync(new URL("./chat.css", import.meta.url), "utf8");
const settings = readFileSync(new URL("./settings.css", import.meta.url), "utf8");
const rail = readFileSync(new URL("./rail.css", import.meta.url), "utf8");

describe("responsive action buttons", () => {
  it("lets narrow capability headings wrap whole action groups without crushing buttons", () => {
    expect(capability).toMatch(/\.company-research-heading\s*\{[^}]*flex-wrap:\s*wrap;/su);
    expect(capability).toMatch(/\.company-research-heading\s*>\s*div:first-child\s*\{[^}]*flex:\s*1 1 280px;[^}]*min-width:\s*0;/su);
    expect(capability).toMatch(/\.company-research-actions\s*\{[^}]*flex-wrap:\s*wrap;/su);
    expect(capability).toMatch(/\.company-research-actions\s*>\s*button[\s\S]*?\{[^}]*flex:\s*0 0 auto;[^}]*white-space:\s*nowrap;/u);
    expect(capability).toMatch(/\.company-report-version-controls\s*\{[^}]*flex-wrap:\s*nowrap;/su);
    expect(capability).toMatch(/\.company-report-version\s*\{[^}]*flex:\s*1 1 auto;[^}]*min-width:\s*0;/su);
    expect(capability).toMatch(/\.modal-actions\s*\{[^}]*flex-wrap:\s*wrap;/su);
    expect(capability).toMatch(/\.modal-close\s*\{[^}]*flex:\s*0 0 32px;/su);
    expect(capability).toMatch(/\.research-item-edit-button[\s\S]*?\{[^}]*flex:\s*0 0 auto;[^}]*white-space:\s*nowrap;/u);
    expect(capability).not.toMatch(/\.capability-page-heading\s*\{[^}]*flex-direction:\s*column;/su);
  });

  it("keeps Chat controls usable while long tool text remains flexible", () => {
    expect(chat).toMatch(/\.composer-actions\s*\{[^}]*flex-wrap:\s*wrap;/su);
    expect(chat).toMatch(/\.composer-actions\s*>\s*button[\s\S]*?\{[^}]*flex:\s*0 0 auto;[^}]*white-space:\s*nowrap;/u);
    expect(chat).toMatch(/\.chat-content-status\s*\{[^}]*flex-wrap:\s*wrap;/su);
    expect(chat).toMatch(/\.markdown-link-actions\s*\{[^}]*flex-wrap:\s*wrap;/su);
    expect(chat).toMatch(/\.tool-activity-toggle,[\s\S]*?\.tool-activity-batch-toggle\s*\{[^}]*min-width:\s*0;[^}]*max-width:\s*100%;/u);
    expect(chat).toMatch(/\.tool-activity-summary\s*\{[^}]*text-overflow:\s*ellipsis;[^}]*white-space:\s*nowrap;/su);
  });

  it("keeps Settings actions intact and profile names elastic", () => {
    expect(settings).toMatch(/\.profile-list button\s*\{[^}]*min-width:\s*0;[^}]*text-overflow:\s*ellipsis;[^}]*white-space:\s*nowrap;/su);
    expect(settings).toMatch(/\.diagnostic-row\s*>\s*button,[\s\S]*?\.editor-actions\s*>\s*button\s*\{[^}]*flex:\s*0 0 auto;[^}]*white-space:\s*nowrap;/u);
  });

  it("preserves intentional navigation and collapsed-rail behavior", () => {
    expect(app).toMatch(/\.nav-conversation-open\s*\{[^}]*text-overflow:\s*ellipsis;[^}]*white-space:\s*nowrap;/su);
    expect(app).toMatch(/\.pane-message\s*\{[^}]*flex-wrap:\s*wrap;/su);
    expect(app).toMatch(/\.pane-message\s*>\s*button\s*\{[^}]*flex:\s*0 0 auto;[^}]*white-space:\s*nowrap;/su);
    expect(app).toMatch(/\.capability-close\s*\{[^}]*flex:\s*0 0 28px;/su);
    expect(rail).toMatch(/\.chat-rail\.collapsed button\s*\{[^}]*writing-mode:\s*vertical-rl;/su);
    expect(rail).toMatch(/\.rail-header\s*>\s*button\s*\{[^}]*flex:\s*0 0 auto;[^}]*white-space:\s*nowrap;/su);
    expect(app).not.toMatch(/(?:^|\n)button\s*\{[^}]*white-space:\s*nowrap;/su);
  });
});
