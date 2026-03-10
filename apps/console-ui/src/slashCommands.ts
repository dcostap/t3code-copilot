export interface SlashCommand {
  readonly id: string;
  readonly label: string;
  readonly description: string;
}

export const slashCommands: ReadonlyArray<SlashCommand> = [
  { id: "model", label: "/model", description: "choose what model and reasoning effort to use" },
  { id: "fast", label: "/fast", description: "toggle fast mode to enable fastest inference at 2X plan usage" },
  { id: "permissions", label: "/permissions", description: "choose what the agent is allowed to do" },
  { id: "context", label: "/context", description: "add files or directories as context" },
  { id: "compact", label: "/compact", description: "toggle compact mode for the transcript" },
  { id: "review", label: "/review", description: "review my current changes and find issues" },
  { id: "clear", label: "/clear", description: "clear the transcript" },
  { id: "help", label: "/help", description: "show available commands" },
];

/** Simple substring match on command id. */
export function filterCommands(query: string): ReadonlyArray<SlashCommand> {
  const q = query.toLowerCase();
  if (q.length === 0) return slashCommands;
  return slashCommands.filter((cmd) => cmd.id.includes(q));
}
