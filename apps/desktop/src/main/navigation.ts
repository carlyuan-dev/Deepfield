export function isAllowedNavigation(currentUrl: string, nextUrl: string): boolean {
  if (currentUrl.length === 0) {
    // Electron's own initial load happens before any document URL exists.
    return true;
  }
  let current: URL;
  let next: URL;
  try {
    current = new URL(currentUrl);
    next = new URL(nextUrl);
  } catch {
    return false;
  }
  if (current.protocol !== next.protocol) {
    return false;
  }
  if (current.protocol === "file:") {
    return current.pathname === next.pathname && current.search === next.search;
  }
  if (current.protocol === "http:" || current.protocol === "https:") {
    return current.origin === next.origin;
  }
  return false;
}
