import { useEffect, useRef, type CSSProperties } from "react";

import type { CommandPaletteCommand } from "./commandPaletteCommands";

const COMMAND_PALETTE_MAX_HEIGHT_PX = 950;

export interface CommandPaletteScopeBounds {
  readonly top: number;
  readonly left: number;
  readonly width: number;
  readonly height: number;
}

interface CommandPaletteProps {
  readonly open: boolean;
  readonly query: string;
  readonly commands: ReadonlyArray<CommandPaletteCommand>;
  readonly selectedIndex: number;
  readonly scopeBounds: CommandPaletteScopeBounds | null;
  onClose(): void;
  onQueryChange(value: string): void;
  onSelectedIndexChange(index: number): void;
  onRun(command: CommandPaletteCommand): void;
}

export function resolveCommandPaletteFrameStyle(
  scopeBounds: CommandPaletteScopeBounds | null,
): CSSProperties | undefined {
  if (!scopeBounds) {
    return undefined;
  }

  const roundedTop = Math.max(0, Math.round(scopeBounds.top));
  const roundedLeft = Math.max(0, Math.round(scopeBounds.left));
  const roundedWidth = Math.max(0, Math.round(scopeBounds.width));
  const roundedHeight = Math.max(0, Math.round(scopeBounds.height));
  const resolvedHeight = Math.min(COMMAND_PALETTE_MAX_HEIGHT_PX, roundedHeight);
  const centeredTopOffset = roundedHeight > COMMAND_PALETTE_MAX_HEIGHT_PX
    ? Math.round((roundedHeight - COMMAND_PALETTE_MAX_HEIGHT_PX) / 2)
    : 0;

  return {
    top: `${roundedTop + centeredTopOffset}px`,
    left: `${roundedLeft}px`,
    width: `${roundedWidth}px`,
    height: `${resolvedHeight}px`,
  };
}

export function CommandPalette({
  open,
  query,
  commands,
  selectedIndex,
  scopeBounds,
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

  const isScopedToThread = scopeBounds !== null;
  const frameStyle = resolveCommandPaletteFrameStyle(scopeBounds);

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
    <div className={`palette-overlay${isScopedToThread ? " palette-overlay--scoped" : ""}`} role="presentation" onMouseDown={onClose}>
      <div className={`palette-frame${isScopedToThread ? " palette-frame--scoped" : ""}`} style={frameStyle}>
        <section
          className={`palette-window${isScopedToThread ? " palette-window--scoped" : ""}`}
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
                  ref={(element) => {
                    rowRefs.current[index] = element;
                  }}
                  type="button"
                  className={`palette-row${index === selectedIndex ? " palette-row--active" : ""}${cmd.contextText ? " palette-row--withContext" : " palette-row--withoutContext"}`}
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
                  {cmd.contextText ? <span className="palette-context">{cmd.contextText}</span> : null}
                </button>
              ))
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
