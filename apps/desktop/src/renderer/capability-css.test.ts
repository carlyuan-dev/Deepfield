// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(join(process.cwd(), "capabilities/company-research/ui/capability.css"), "utf8");
const appCss = readFileSync(join(process.cwd(), "apps/desktop/src/renderer/app.css"), "utf8");

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

  it("uses shared tabular report columns and only colors active research labels with the theme accent", () => {
    const style = document.createElement("style"); style.textContent = `${appCss}\n${css}`; document.head.append(style);
    const row = document.createElement("div"); row.className = "company-list-row";
    const company = document.createElement("button"); company.className = "company-row-button";
    const active = document.createElement("small"); active.className = "company-research-active-status"; active.textContent = "正在收集调研资料"; company.append(active);
    const spinner = document.createElement("span"); spinner.className = "company-profile-spinner";
    const summary = document.createElement("small"); summary.className = "company-report-summary muted";
    const count = document.createElement("span"); count.className = "company-report-count"; count.textContent = "报告 12 份";
    const separator = document.createElement("span"); separator.textContent = "·";
    const time = document.createElement("span"); time.className = "company-report-time"; time.textContent = "最新创建于 2026-09-17 14:05";
    const remove = document.createElement("button"); remove.className = "company-remove-button";
    summary.append(count, separator, time); row.append(company, spinner, summary, remove); document.body.append(row);

    expect(getComputedStyle(row).display).toBe("grid");
    expect(getComputedStyle(spinner).gridColumn).toBe("2");
    expect(getComputedStyle(summary).gridColumn).toBe("3");
    expect(getComputedStyle(remove).gridColumn).toBe("4");
    expect(getComputedStyle(summary).display).toBe("grid");
    expect(getComputedStyle(summary).gridTemplateColumns).toBe("5.5em max-content 14.5em");
    expect(getComputedStyle(summary).fontVariantNumeric).toBe("tabular-nums");
    expect(getComputedStyle(active).color).toBe("var(--accent-strong)");
    expect(getComputedStyle(summary).color).toBe("var(--muted)");
    expect(css).toMatch(/@container\s+company-list\s*\(max-width:\s*560px\)/u);

    row.remove(); style.remove();
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

describe("batch research modal layout", () => {
  it("keeps selection rows on one line without inheriting stacked modal field styles", () => {
    const style = document.createElement("style"); style.textContent = css; document.head.append(style);
    const body = document.createElement("div"); body.className = "modal-body batch-research-modal";
    const list = document.createElement("ul"); list.className = "batch-company-list";
    const row = document.createElement("li"); row.className = "batch-company-row";
    const label = document.createElement("label"); label.className = "batch-company-select";
    const checkbox = document.createElement("input"); checkbox.type = "checkbox";
    const name = document.createElement("span"); name.className = "batch-company-name"; name.textContent = "很长的公司名称";
    const status = document.createElement("small"); status.className = "batch-company-status"; status.textContent = "等待调研";
    const report = document.createElement("small"); report.className = "batch-company-report"; report.textContent = "报告 3 份 最新创建于 2026-09-17";
    label.append(checkbox, name); row.append(label, status, report); list.append(row); body.append(list); document.body.append(body);

    expect(getComputedStyle(row).display).toBe("grid");
    expect(getComputedStyle(row).gridTemplateColumns).toBe("minmax(0, 1fr) max-content max-content");
    expect(getComputedStyle(label).flexDirection).toBe("row");
    expect(getComputedStyle(checkbox).width).toBe("auto");
    expect(getComputedStyle(name).textOverflow).toBe("ellipsis");
    expect(getComputedStyle(name).whiteSpace).toBe("nowrap");
    expect(getComputedStyle(status).whiteSpace).toBe("nowrap");
    expect(getComputedStyle(status).gridColumn).toBe("2");
    expect(getComputedStyle(report).gridColumn).toBe("3");
    expect(getComputedStyle(report).fontVariantNumeric).toBe("tabular-nums");

    body.remove(); style.remove();
  });
});
