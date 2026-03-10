import { useCallback, useMemo, useRef, useState, type ChangeEvent, type KeyboardEvent } from "react";
import { filterCommands, type SlashCommand } from "./slashCommands";

export interface ComposerPaletteState {
  readonly value: string;
  readonly paletteOpen: boolean;
  readonly filteredCommands: ReadonlyArray<SlashCommand>;
  readonly selectedIndex: number;
  readonly textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  onChange(e: ChangeEvent<HTMLTextAreaElement>): void;
  onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>): void;
  dismiss(): void;
}

export function useComposerWithPalette(): ComposerPaletteState {
  const [value, setValue] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const paletteOpen = value.startsWith("/");
  const query = paletteOpen ? value.slice(1) : "";
  const filteredCommands = useMemo(() => (paletteOpen ? filterCommands(query) : []), [paletteOpen, query]);

  const dismiss = useCallback(() => {
    setValue("");
    setSelectedIndex(0);
  }, []);

  const acceptCommand = useCallback(
    (cmd: SlashCommand) => {
      setValue(cmd.label + " ");
      setSelectedIndex(0);
      // Move cursor to end
      requestAnimationFrame(() => {
        const ta = textareaRef.current;
        if (ta) {
          const len = cmd.label.length + 1;
          ta.selectionStart = len;
          ta.selectionEnd = len;
          ta.focus();
        }
      });
    },
    [],
  );

  const onChange = useCallback(
    (e: ChangeEvent<HTMLTextAreaElement>) => {
      const next = e.target.value;
      setValue(next);
      // Reset selection when filter text changes
      setSelectedIndex(0);
    },
    [],
  );

  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (!paletteOpen || filteredCommands.length === 0) return;

      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIndex((i) => (i + 1) % filteredCommands.length);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIndex((i) => (i - 1 + filteredCommands.length) % filteredCommands.length);
      } else if (e.key === "Tab" || e.key === "Enter") {
        // Only intercept when palette is open with results
        if (filteredCommands.length > 0) {
          e.preventDefault();
          const cmd = filteredCommands[selectedIndex];
          if (cmd) acceptCommand(cmd);
        }
      } else if (e.key === "Escape") {
        e.preventDefault();
        dismiss();
      }
    },
    [paletteOpen, filteredCommands, selectedIndex, acceptCommand, dismiss],
  );

  return {
    value,
    paletteOpen: paletteOpen && filteredCommands.length > 0,
    filteredCommands,
    selectedIndex,
    textareaRef,
    onChange,
    onKeyDown,
    dismiss,
  };
}
