/// <reference types="vite/client" />

import type { DesktopBridge } from "@t3tools/contracts";

declare global {
  interface Window {
    desktopBridge?: DesktopBridge;
  }
}

export {};
