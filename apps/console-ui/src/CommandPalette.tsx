import { useEffect, useRef } from "react";

import type { CommandPaletteCommand } from "./commandPaletteCommands";

interface CommandPaletteProps {
  readonly open: boolean;
  readonly query: string;
  readonly commands: ReadonlyArray<CommandPaletteCommand>;
  readonly selectedIndex: number;
  onClose(): void;
  onQueryChange(value: string): void;
  onSelectedIndexChange(index: number): void;
  onRun(command: CommandPaletteCommand): void;
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
  const rowRefs = useRef<Array<HTMLButtonElement | null>>([]);

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

  useEffect(() => {
    if (!open) {
      return;
    }

    const selectedRow = rowRefs.current[selectedIndex];
    if (!selectedRow) {
      return;
    }

    selectedRow.scrollIntoView({
      block: "nearest",
    });
  }, [commands.length, open, selectedIndex]);

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
      if (commands.length > 0 && selectedIndex < commands.length - 1) {
        onSelectedIndexChange(selectedIndex + 1);
      }
      return;
    }

    if (event.key === "ArrowUp") {
      event.preventDefault();
      if (commands.length > 0 && selectedIndex > 0) {
        onSelectedIndexChange(selectedIndex - 1);
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
      <div className="palette-frame">
        <section
          className="palette-window"
          aria-label="Command palette"
          role="dialog"
          aria-modal="true"
          onMouseDown={(event) => {
            event.stopPropagation();
          }}
        >
          <div className="palette-searchShell">
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
          </div>
          <div className="palette-results" role="listbox">
            {commands.length === 0 ? (
              <div className="palette-empty">No results.</div>
            ) : (
              commands.map((cmd, index) => (
                <button
                  key={cmd.id}
                  ref={(element) => {
                    rowRefs.current[index] = element;
                  }}
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
                  <span className="palette-rowBody">
                    <span className="palette-cmd">{cmd.label}</span>
                    {cmd.contextText ? <span className="palette-context">{cmd.contextText}</span> : null}
                  </span>
                </button>
              ))
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
