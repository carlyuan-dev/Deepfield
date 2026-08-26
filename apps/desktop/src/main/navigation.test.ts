import { describe, expect, it } from "vitest";
import { isAllowedNavigation } from "./navigation.js";

describe("isAllowedNavigation", () => {
  it("allows the initial load when the current url is empty", () => {
    expect(
      isAllowedNavigation("", "file:///Applications/Deepfield.app/out/renderer/index.html"),
    ).toBe(true);
  });

  it("allows same-origin http/https navigation", () => {
    expect(isAllowedNavigation("http://localhost:5173/", "http://localhost:5173/settings")).toBe(
      true,
    );
    expect(
      isAllowedNavigation("https://app.example.com/a", "https://app.example.com/b?q=1"),
    ).toBe(true);
  });

  it("rejects cross-origin http/https navigation", () => {
    expect(isAllowedNavigation("http://localhost:5173/", "http://localhost:5174/")).toBe(false);
    expect(isAllowedNavigation("https://app.example.com/", "https://evil.example.com/")).toBe(
      false,
    );
  });

  it("allows file navigation with identical pathname and search, ignoring hash", () => {
    const app = "file:///Applications/Deepfield.app/Contents/Resources/out/renderer/index.html";
    expect(isAllowedNavigation(app, `${app}#/companies/1`)).toBe(true);
    expect(isAllowedNavigation(`${app}?x=1`, `${app}?x=1#top`)).toBe(true);
  });

  it("rejects file navigation to other paths or search", () => {
    const app = "file:///Applications/Deepfield.app/Contents/Resources/out/renderer/index.html";
    expect(isAllowedNavigation(app, "file:///etc/passwd")).toBe(false);
    expect(isAllowedNavigation(app, "file:///tmp/other.html")).toBe(false);
    expect(isAllowedNavigation(`${app}?x=1`, app)).toBe(false);
  });

  it("rejects file navigation to a different hostname", () => {
    expect(
      isAllowedNavigation("file:///app/index.html", "file://remote/app/index.html"),
    ).toBe(false);
    expect(
      isAllowedNavigation("file://remote/app/index.html", "file:///app/index.html"),
    ).toBe(false);
    expect(
      isAllowedNavigation("file://remote/a/index.html", "file://remote/a/index.html"),
    ).toBe(true);
  });

  it("rejects scheme switches and unsupported schemes", () => {
    const app = "file:///tmp/app/index.html";
    expect(isAllowedNavigation(app, "http://localhost:5173/")).toBe(false);
    expect(isAllowedNavigation("http://localhost:5173/", app)).toBe(false);
    expect(isAllowedNavigation(app, "data:text/html,hi")).toBe(false);
    expect(isAllowedNavigation(app, "about:blank")).toBe(false);
  });

  it("rejects unparseable urls", () => {
    expect(isAllowedNavigation("file:///tmp/app/index.html", "not a url")).toBe(false);
    expect(isAllowedNavigation("not a url", "file:///tmp/app/index.html")).toBe(false);
  });
});
