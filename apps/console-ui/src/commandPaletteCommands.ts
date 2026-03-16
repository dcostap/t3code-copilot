export interface CommandPaletteCommand {
  readonly id: string;
  readonly label: string;
  readonly contextText?: string;
  readonly keywords?: ReadonlyArray<string>;
}

/** Simple substring match across id, label, optional context text, and optional keywords. */
export function filterCommandPaletteCommands(
  commands: ReadonlyArray<CommandPaletteCommand>,
  query: string,
): ReadonlyArray<CommandPaletteCommand> {
  const q = query.toLowerCase().trim();
  if (q.length === 0) {
    return commands;
  }

  return commands.filter((command) => {
    if (command.id.toLowerCase().includes(q)) return true;
    if (command.label.toLowerCase().includes(q)) return true;
    if (command.contextText?.toLowerCase().includes(q)) return true;
    return (command.keywords ?? []).some((keyword) => keyword.toLowerCase().includes(q));
  });
}
