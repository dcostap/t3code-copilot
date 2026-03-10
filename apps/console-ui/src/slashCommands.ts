export interface SlashCommand {
  readonly id: string;
  readonly label: string;
  readonly description: string;
}

export const slashCommands: ReadonlyArray<SlashCommand> = [
  { id: "help", label: "/help", description: "Show available commands" },
  { id: "clear", label: "/clear", description: "Clear the transcript" },
  { id: "model", label: "/model", description: "Switch model" },
  { id: "compact", label: "/compact", description: "Toggle compact mode" },
  { id: "context", label: "/context", description: "Add context files" },
  { id: "settings", label: "/settings", description: "Open settings" },
  { id: "history", label: "/history", description: "Browse session history" },
];

/** Simple substring match on command id. */
export function filterCommands(query: string): ReadonlyArray<SlashCommand> {
  const q = query.toLowerCase();
  if (q.length === 0) return slashCommands;
  return slashCommands.filter((cmd) => cmd.id.includes(q));
}
