export interface PaletteCommand {
  readonly id: string;
  readonly label: string;
  readonly description: string;
}

export const paletteCommands: ReadonlyArray<PaletteCommand> = [
  { id: "model", label: "Model", description: "choose what model and reasoning effort to use" },
  { id: "fast", label: "Fast Mode", description: "toggle fast mode to enable fastest inference at 2X plan usage" },
  { id: "permissions", label: "Permissions", description: "choose what the agent is allowed to do" },
  { id: "context", label: "Add Context", description: "add files or directories as context" },
  { id: "compact", label: "Compact Transcript", description: "toggle compact mode for the transcript" },
  { id: "review", label: "Review Changes", description: "review current changes and find issues" },
  { id: "clear", label: "Clear Transcript", description: "clear the transcript" },
  { id: "help", label: "Help", description: "show available commands" },
];

/** Simple substring match across id, label, and description. */
export function filterCommands(query: string): ReadonlyArray<PaletteCommand> {
  const q = query.toLowerCase();
  if (q.length === 0) return paletteCommands;
  return paletteCommands.filter((cmd) =>
    cmd.id.includes(q)
    || cmd.label.toLowerCase().includes(q)
    || cmd.description.toLowerCase().includes(q),
  );
}
