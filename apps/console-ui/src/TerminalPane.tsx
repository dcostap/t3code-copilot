import { FitAddon } from "@xterm/addon-fit";
import { DEFAULT_TERMINAL_ID, type TerminalSessionSnapshot } from "@t3tools/contracts";
import { Terminal } from "@xterm/xterm";
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
} from "react";

import type { ConsoleDataState } from "./consoleData/useConsoleData";

export interface TerminalPaneHandle {
  focus(): void;
  focusPrompt(options?: { readonly reveal?: boolean }): void;
  hasFocusWithinPane(): boolean;
  openSearch(): void;
  isHistoryActive(): boolean;
  hasHistorySelection(): boolean;
  selectAllHistory(): boolean;
  insertPromptText(text: string): void;
  deletePromptBackward(): void;
  deletePromptForward(): void;
  submitPrompt(): void;
}

interface TerminalPaneProps {
  readonly sessionThreadId: string;
  readonly cwd: string;
  readonly paneActive: boolean;
  readonly terminalId?: string;
  readonly openTerminal: ConsoleDataState["openTerminal"];
  readonly writeTerminal: ConsoleDataState["writeTerminal"];
  readonly resizeTerminal: ConsoleDataState["resizeTerminal"];
  readonly subscribeToTerminalEvents: ConsoleDataState["subscribeToTerminalEvents"];
}

function writeSystemMessage(terminal: Terminal, message: string) {
  terminal.write(`\r\n[terminal] ${message}\r\n`);
}

function terminalThemeFromApp() {
  const isDark = document.documentElement.classList.contains("dark");
  const bodyStyles = getComputedStyle(document.body);
  const background =
    bodyStyles.backgroundColor || (isDark ? "rgb(14, 18, 24)" : "rgb(255, 255, 255)");
  const foreground = bodyStyles.color || (isDark ? "rgb(237, 241, 247)" : "rgb(28, 33, 41)");

  if (isDark) {
    return {
      background,
      foreground,
      cursor: "rgb(180, 203, 255)",
      selectionBackground: "rgba(180, 203, 255, 0.25)",
      scrollbarSliderBackground: "rgba(255, 255, 255, 0.1)",
      scrollbarSliderHoverBackground: "rgba(255, 255, 255, 0.18)",
      scrollbarSliderActiveBackground: "rgba(255, 255, 255, 0.22)",
      black: "rgb(24, 30, 38)",
      red: "rgb(255, 122, 142)",
      green: "rgb(134, 231, 149)",
      yellow: "rgb(244, 205, 114)",
      blue: "rgb(137, 190, 255)",
      magenta: "rgb(208, 176, 255)",
      cyan: "rgb(124, 232, 237)",
      white: "rgb(210, 218, 230)",
      brightBlack: "rgb(110, 120, 136)",
      brightRed: "rgb(255, 168, 180)",
      brightGreen: "rgb(176, 245, 186)",
      brightYellow: "rgb(255, 224, 149)",
      brightBlue: "rgb(174, 210, 255)",
      brightMagenta: "rgb(229, 203, 255)",
      brightCyan: "rgb(167, 244, 247)",
      brightWhite: "rgb(244, 247, 252)",
    };
  }

  return {
    background,
    foreground,
    cursor: "rgb(38, 56, 78)",
    selectionBackground: "rgba(37, 63, 99, 0.2)",
    scrollbarSliderBackground: "rgba(0, 0, 0, 0.15)",
    scrollbarSliderHoverBackground: "rgba(0, 0, 0, 0.25)",
    scrollbarSliderActiveBackground: "rgba(0, 0, 0, 0.3)",
    black: "rgb(44, 53, 66)",
    red: "rgb(191, 70, 87)",
    green: "rgb(60, 126, 86)",
    yellow: "rgb(146, 112, 35)",
    blue: "rgb(72, 102, 163)",
    magenta: "rgb(132, 86, 149)",
    cyan: "rgb(53, 127, 141)",
    white: "rgb(210, 215, 223)",
    brightBlack: "rgb(112, 123, 140)",
    brightRed: "rgb(212, 95, 112)",
    brightGreen: "rgb(85, 148, 111)",
    brightYellow: "rgb(173, 133, 45)",
    brightBlue: "rgb(91, 124, 194)",
    brightMagenta: "rgb(153, 107, 172)",
    brightCyan: "rgb(70, 149, 164)",
    brightWhite: "rgb(236, 240, 246)",
  };
}

function writeSnapshotToTerminal(terminal: Terminal, snapshot: TerminalSessionSnapshot) {
  terminal.write("\u001bc");
  if (snapshot.history.length > 0) {
    terminal.write(snapshot.history);
  }
}

export const TerminalPane = forwardRef<TerminalPaneHandle, TerminalPaneProps>(function TerminalPane(
  {
    sessionThreadId,
    cwd,
    paneActive,
    terminalId = DEFAULT_TERMINAL_ID,
    openTerminal,
    writeTerminal,
    resizeTerminal,
    subscribeToTerminalEvents,
  },
  ref,
) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const resizeFrameRef = useRef<number | null>(null);

  const sendTerminalInput = useCallback(async (data: string, fallbackError: string) => {
    const activeTerminal = terminalRef.current;
    if (!activeTerminal) {
      return;
    }
    try {
      await writeTerminal({
        threadId: sessionThreadId,
        terminalId,
        data,
      });
    } catch (error) {
      writeSystemMessage(activeTerminal, error instanceof Error ? error.message : fallbackError);
    }
  }, [sessionThreadId, terminalId, writeTerminal]);

  useImperativeHandle(ref, () => ({
    focus() {
      terminalRef.current?.focus();
    },
    focusPrompt() {
      terminalRef.current?.focus();
    },
    hasFocusWithinPane() {
      const container = containerRef.current;
      return Boolean(container && container.contains(document.activeElement));
    },
    openSearch() {},
    isHistoryActive() {
      const container = containerRef.current;
      return Boolean(container && container.contains(document.activeElement));
    },
    hasHistorySelection() {
      return terminalRef.current?.hasSelection() ?? false;
    },
    selectAllHistory() {
      return false;
    },
    insertPromptText(text: string) {
      void sendTerminalInput(text, "Failed to write to terminal");
    },
    deletePromptBackward() {
      void sendTerminalInput("\u007f", "Failed to delete terminal input");
    },
    deletePromptForward() {
      void sendTerminalInput("\u001b[3~", "Failed to delete terminal input");
    },
    submitPrompt() {
      void sendTerminalInput("\r", "Failed to submit terminal input");
    },
  }), [sendTerminalInput]);

  useEffect(() => {
    const mount = containerRef.current;
    if (!mount) {
      return;
    }

    let disposed = false;
    const fitAddon = new FitAddon();
    const terminal = new Terminal({
      cursorBlink: true,
      lineHeight: 1.2,
      fontSize: 12,
      scrollback: 5_000,
      fontFamily: '"SF Mono", "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace',
      theme: terminalThemeFromApp(),
    });

    const syncSize = (force = false) => {
      if (resizeFrameRef.current !== null) {
        window.cancelAnimationFrame(resizeFrameRef.current);
      }
      resizeFrameRef.current = window.requestAnimationFrame(() => {
        resizeFrameRef.current = null;
        const activeTerminal = terminalRef.current;
        const activeFitAddon = fitAddonRef.current;
        if (!activeTerminal || !activeFitAddon) {
          return;
        }
        const previousCols = activeTerminal.cols;
        const previousRows = activeTerminal.rows;
        const wasAtBottom = activeTerminal.buffer.active.viewportY >= activeTerminal.buffer.active.baseY;
        activeFitAddon.fit();
        if (wasAtBottom) {
          activeTerminal.scrollToBottom();
        }
        if (!force && activeTerminal.cols === previousCols && activeTerminal.rows === previousRows) {
          return;
        }
        void resizeTerminal({
          threadId: sessionThreadId,
          terminalId,
          cols: activeTerminal.cols,
          rows: activeTerminal.rows,
        }).catch((error) => {
          writeSystemMessage(
            activeTerminal,
            error instanceof Error ? error.message : "Failed to resize terminal",
          );
        });
      });
    };

    terminal.loadAddon(fitAddon);
    terminal.open(mount);
    fitAddon.fit();
    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;

    const inputDisposable = terminal.onData((data) => {
      void sendTerminalInput(data, "Terminal write failed");
    });

    const unsubscribe = subscribeToTerminalEvents((event) => {
      if (event.threadId !== sessionThreadId || event.terminalId !== terminalId) {
        return;
      }
      const activeTerminal = terminalRef.current;
      if (!activeTerminal) {
        return;
      }

      if (event.type === "output") {
        activeTerminal.write(event.data);
        return;
      }

      if (event.type === "started" || event.type === "restarted") {
        writeSnapshotToTerminal(activeTerminal, event.snapshot);
        return;
      }

      if (event.type === "cleared") {
        activeTerminal.clear();
        activeTerminal.write("\u001bc");
        return;
      }

      if (event.type === "error") {
        writeSystemMessage(activeTerminal, event.message);
        return;
      }

      if (event.type === "exited") {
        const details = [
          typeof event.exitCode === "number" ? `code ${event.exitCode}` : null,
          typeof event.exitSignal === "number" ? `signal ${event.exitSignal}` : null,
        ]
          .filter((value): value is string => value !== null)
          .join(", ");
        writeSystemMessage(
          activeTerminal,
          details.length > 0 ? `Process exited (${details})` : "Process exited",
        );
      }
    });

    const themeObserver = new MutationObserver(() => {
      const activeTerminal = terminalRef.current;
      if (!activeTerminal) {
        return;
      }
      activeTerminal.options.theme = terminalThemeFromApp();
      activeTerminal.refresh(0, activeTerminal.rows - 1);
    });
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "style"],
    });

    const resizeObserver = typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver(() => {
          syncSize();
        });
    resizeObserver?.observe(mount);

    void (async () => {
      try {
        const snapshot = await openTerminal({
          threadId: sessionThreadId,
          terminalId,
          cwd,
          cols: terminal.cols,
          rows: terminal.rows,
        });
        if (disposed) {
          return;
        }
        writeSnapshotToTerminal(terminal, snapshot);
        syncSize(true);
        if (paneActive) {
          window.requestAnimationFrame(() => {
            terminal.focus();
          });
        }
      } catch (error) {
        if (disposed) {
          return;
        }
        writeSystemMessage(
          terminal,
          error instanceof Error ? error.message : "Failed to open terminal",
        );
      }
    })();

    return () => {
      disposed = true;
      if (resizeFrameRef.current !== null) {
        window.cancelAnimationFrame(resizeFrameRef.current);
      }
      resizeObserver?.disconnect();
      themeObserver.disconnect();
      unsubscribe();
      inputDisposable.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
      terminal.dispose();
    };
  }, [cwd, openTerminal, paneActive, resizeTerminal, sendTerminalInput, sessionThreadId, subscribeToTerminalEvents, terminalId]);

  useEffect(() => {
    if (!paneActive) {
      return;
    }
    const terminal = terminalRef.current;
    if (!terminal) {
      return;
    }
    const frame = window.requestAnimationFrame(() => {
      terminal.focus();
    });
    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [paneActive]);

  return <div ref={containerRef} className="terminal-pane" />;
});
