import type { DesktopApi } from "@deepfield/contracts";

declare global {
  interface Window {
    deepfield: DesktopApi;
  }
}

export {};
