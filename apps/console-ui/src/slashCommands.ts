export interface PaletteCommand {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly keywords?: ReadonlyArray<string>;
}

/** Simple substring match across id, label, description, and optional keywords. */
export function filterCommands(
  commands: ReadonlyArray<PaletteCommand>,
  query: string,
): ReadonlyArray<PaletteCommand> {
  const q = query.toLowerCase().trim();
  if (q.length === 0) {
    return commands;
  }

  return commands.filter((cmd) => {
    if (cmd.id.toLowerCase().includes(q)) return true;
    if (cmd.label.toLowerCase().includes(q)) return true;
    if (cmd.description.toLowerCase().includes(q)) return true;
    return (cmd.keywords ?? []).some((keyword) => keyword.toLowerCase().includes(q));
  });
}
