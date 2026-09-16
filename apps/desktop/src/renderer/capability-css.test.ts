// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(join(process.cwd(), "apps/desktop/src/renderer/capability.css"), "utf8");

describe("company list status alignment", () => {
  it("centers both the enrichment spinner and remove control within a company row", () => {
    expect(css).toMatch(/\.company-profile-spinner\s*\{[^}]*align-self:\s*center;/su);
    expect(css).toMatch(/\.company-remove-button\s*\{[^}]*align-self:\s*center;/su);
  });

  it("keeps fixed research navigation unruled and company detail actions equal height", () => {
    expect(css).not.toMatch(/\.capability-header\s*\{[^}]*border-bottom:/su);
    expect(css).not.toMatch(/\.capability-contextual-navigation\s*\{[^}]*border-bottom:/su);
    expect(css).toMatch(/\.company-detail-action\s*\{[^}]*height:\s*36px;[^}]*white-space:\s*nowrap;/su);
  });
});

describe("Word export choice layout", () => {
  it("keeps each checkbox inline at the left of its label despite generic modal field rules", () => {
    const style = document.createElement("style");
    style.textContent = css;
    document.head.append(style);
    const body = document.createElement("div");
    body.className = "modal-body word-export-choice";
    const label = document.createElement("label");
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    label.append(checkbox, "原始调研报告");
    body.append(label);
    document.body.append(body);

    const labelStyle = getComputedStyle(label);
    const checkboxStyle = getComputedStyle(checkbox);
    expect(labelStyle.flexDirection).toBe("row");
    expect(labelStyle.alignItems).toBe("center");
    expect(labelStyle.justifyContent).toBe("flex-start");
    expect(checkboxStyle.width).toBe("auto");
    expect(checkboxStyle.flexGrow).toBe("0");

    body.remove();
    style.remove();
  });

  it("keeps the tab strip, export button, and feedback in a left-to-right wrapping flow", () => {
    const style = document.createElement("style");
    style.textContent = css;
    document.head.append(style);
    const toolbar = document.createElement("div");
    toolbar.className = "research-tabs-toolbar";
    const tabs = document.createElement("div");
    tabs.className = "research-tabs";
    const exportButton = document.createElement("button");
    toolbar.append(tabs, exportButton);
    document.body.append(toolbar);

    const toolbarStyle = getComputedStyle(toolbar);
    const tabsStyle = getComputedStyle(tabs);
    const buttonStyle = getComputedStyle(exportButton);
    expect(toolbarStyle.flexWrap).toBe("wrap");
    expect(toolbarStyle.justifyContent).toBe("flex-start");
    expect(tabsStyle.flexGrow).toBe("0");
    expect(buttonStyle.flexShrink).toBe("0");

    toolbar.remove();
    style.remove();
  });
});
