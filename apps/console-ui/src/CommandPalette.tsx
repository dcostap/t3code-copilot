import type { SlashCommand } from "./slashCommands";

interface CommandPaletteProps {
  readonly commands: ReadonlyArray<SlashCommand>;
  readonly selectedIndex: number;
}

export function CommandPalette({ commands, selectedIndex }: CommandPaletteProps) {
  return (
    <div className="palette-container">
      <ul className="palette-list" role="listbox">
        {commands.map((cmd, i) => (
          <li
            key={cmd.id}
            className={`palette-item${i === selectedIndex ? " palette-item--selected" : ""}`}
            role="option"
            aria-selected={i === selectedIndex}
          >
            <span className="palette-label">{cmd.label}</span>
            <span className="palette-desc">{cmd.description}</span>
          </li>
        ))}
      </ul>
      <div className="palette-hint">
        <kbd>↑↓</kbd> navigate · <kbd>Tab</kbd> accept · <kbd>Esc</kbd> dismiss
      </div>
    </div>
  );
}
