/// <reference types="vite/client" />

import type { DesktopBridge } from "@t3tools/contracts";

declare global {
  interface BlockHistoryScrollDiagnosticEntry {
    index: number;
    timeMs: number;
    kind: "scroll" | "write" | "geometry";
    source: string;
    scrollTop: number;
    scrollHeight: number;
    clientHeight: number;
    offsetFromBottom: number;
    scrolling: boolean;
    deltaTop?: number;
    deltaHeight?: number;
    blockIndex?: number;
    blockType?: string;
    blockKey?: string;
    measurementKey?: string;
    commandWidgetSignatures?: string;
    previousHeight?: number;
    nextHeight?: number;
  }

  interface BlockHistoryScrollDiagnosticStore {
    entries: BlockHistoryScrollDiagnosticEntry[];
    clear(): void;
    print(limit?: number): void;
  }

  interface Window {
    desktopBridge?: DesktopBridge;
    __blockHistoryScrollDiagnostics?: BlockHistoryScrollDiagnosticStore;
  }
}

export {};
