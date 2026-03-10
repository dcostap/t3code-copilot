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

interface UseComposerWithPaletteOptions {
  onSubmit?(value: string): Promise<void> | void;
}

function autoResize(el: HTMLTextAreaElement) {
  el.style.height = "auto";
  el.style.height = `${el.scrollHeight}px`;
}

export function useComposerWithPalette(options: UseComposerWithPaletteOptions = {}): ComposerPaletteState {
  const [value, setValue] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const paletteOpen = value.startsWith("/");
  const query = paletteOpen ? value.slice(1) : "";
  const filteredCommands = useMemo(() => (paletteOpen ? filterCommands(query) : []), [paletteOpen, query]);

  const dismiss = useCallback(() => {
    setValue("");
    setSelectedIndex(0);
    const ta = textareaRef.current;
    if (ta) {
      ta.style.height = "auto";
    }
  }, []);

  const submit = useCallback(async () => {
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      return;
    }

    await options.onSubmit?.(trimmed);
    setValue("");
    setSelectedIndex(0);
    const ta = textareaRef.current;
    if (ta) {
      ta.style.height = "auto";
    }
  }, [options, value]);

  const acceptCommand = useCallback(
    (cmd: SlashCommand) => {
      setValue(cmd.label + " ");
      setSelectedIndex(0);
      requestAnimationFrame(() => {
        const ta = textareaRef.current;
        if (ta) {
          const len = cmd.label.length + 1;
          ta.selectionStart = len;
          ta.selectionEnd = len;
          ta.focus();
          autoResize(ta);
        }
      });
    },
    [],
  );

  const onChange = useCallback(
    (e: ChangeEvent<HTMLTextAreaElement>) => {
      const next = e.target.value;
      setValue(next);
      setSelectedIndex(0);
      autoResize(e.target);
    },
    [],
  );

  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (paletteOpen && filteredCommands.length > 0 && e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIndex((i) => (i + 1) % filteredCommands.length);
      } else if (paletteOpen && filteredCommands.length > 0 && e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIndex((i) => (i - 1 + filteredCommands.length) % filteredCommands.length);
      } else if (paletteOpen && filteredCommands.length > 0 && (e.key === "Tab" || e.key === "Enter")) {
        if (filteredCommands.length > 0) {
          e.preventDefault();
          const cmd = filteredCommands[selectedIndex];
          if (cmd) acceptCommand(cmd);
        }
      } else if (e.key === "Escape") {
        e.preventDefault();
        dismiss();
      } else if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        void submit();
      }
    },
    [paletteOpen, filteredCommands, selectedIndex, acceptCommand, dismiss, submit],
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
