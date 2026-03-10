import type { SlashCommand } from "./slashCommands";

interface CommandPaletteProps {
  readonly commands: ReadonlyArray<SlashCommand>;
  readonly selectedIndex: number;
}

export function CommandPalette({ commands, selectedIndex }: CommandPaletteProps) {
  return (
    <div className="palette" role="listbox">
      {commands.map((cmd, i) => (
        <div
          key={cmd.id}
          className={`palette-row${i === selectedIndex ? " palette-row--active" : ""}`}
          role="option"
          aria-selected={i === selectedIndex}
        >
          <span className="palette-cmd">{cmd.label}</span>
          <span className="palette-desc">{cmd.description}</span>
        </div>
      ))}
    </div>
  );
}
