import { useEffect, useRef } from "react";

import type { PaletteCommand } from "./slashCommands";

interface CommandPaletteProps {
  readonly open: boolean;
  readonly query: string;
  readonly commands: ReadonlyArray<PaletteCommand>;
  readonly selectedIndex: number;
  onClose(): void;
  onQueryChange(value: string): void;
  onSelectedIndexChange(index: number): void;
  onRun(command: PaletteCommand): void;
}

export function CommandPalette({
  open,
  query,
  commands,
  selectedIndex,
  onClose,
  onQueryChange,
  onSelectedIndexChange,
  onRun,
}: CommandPaletteProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!open) {
      return;
    }

    const focusInput = () => {
      inputRef.current?.focus();
      inputRef.current?.select();
    };

    focusInput();
    requestAnimationFrame(focusInput);
  }, [open]);

  if (!open) {
    return null;
  }

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Tab") {
      event.preventDefault();
      return;
    }

    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (commands.length > 0) {
        onSelectedIndexChange((selectedIndex + 1) % commands.length);
      }
      return;
    }

    if (event.key === "ArrowUp") {
      event.preventDefault();
      if (commands.length > 0) {
        onSelectedIndexChange((selectedIndex - 1 + commands.length) % commands.length);
      }
      return;
    }

    if (event.key === "Enter") {
      event.preventDefault();
      const command = commands[selectedIndex];
      if (command) {
        onRun(command);
      }
      return;
    }

    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
    }
  };

  return (
    <div className="palette-overlay" role="presentation" onMouseDown={onClose}>
      <section
        className="palette-window"
        aria-label="Command palette"
        role="dialog"
        aria-modal="true"
        onMouseDown={(event) => {
          event.stopPropagation();
        }}
      >
        <input
          ref={inputRef}
          className="palette-search"
          type="text"
          placeholder="Search commands"
          spellCheck={false}
          value={query}
          onChange={(event) => {
            onQueryChange(event.target.value);
          }}
          onKeyDown={handleKeyDown}
        />
        <div className="palette-results" role="listbox">
          {commands.length === 0 ? (
            <div className="palette-empty">No results.</div>
          ) : (
            commands.map((cmd, index) => (
              <button
                key={cmd.id}
                type="button"
                className={`palette-row${index === selectedIndex ? " palette-row--active" : ""}`}
                tabIndex={-1}
                role="option"
                aria-selected={index === selectedIndex}
                onMouseEnter={() => {
                  onSelectedIndexChange(index);
                }}
                onClick={() => {
                  onRun(cmd);
                }}
              >
                <span className="palette-marker" aria-hidden="true">{index === selectedIndex ? "›" : ""}</span>
                <span className="palette-cmd">{cmd.label}</span>
                <span className="palette-desc">{cmd.description}</span>
              </button>
            ))
          )}
        </div>
      </section>
    </div>
  );
}
