export interface CommandPaletteCommand {
  readonly id: string;
  readonly label: string;
  readonly keywords?: ReadonlyArray<string>;
  readonly priority?: number;
  readonly shortcutLabel?: string;
}

function tokenizeCommandPaletteQuery(query: string) {
  return query
    .toLowerCase()
    .trim()
    .split(/\s+/)
    .filter((token) => token.length > 0);
}

function commandSearchFields(command: CommandPaletteCommand) {
  return [
    command.label,
    ...(command.keywords ?? []),
  ].map((value) => value.toLowerCase());
}

function matchesOrderedTokens(haystack: string, tokens: ReadonlyArray<string>) {
  let position = 0;
  for (const token of tokens) {
    const foundAt = haystack.indexOf(token, position);
    if (foundAt === -1) {
      return false;
    }
    position = foundAt + token.length;
  }
  return true;
}

function scoreCommandPaletteCommand(command: CommandPaletteCommand, normalizedQuery: string, tokens: ReadonlyArray<string>) {
  const fields = commandSearchFields(command);
  const joined = fields.join("\n");

  if (command.label.toLowerCase().includes(normalizedQuery)) {
    return 6;
  }
  if (joined.includes(normalizedQuery)) {
    return 5;
  }
  if (matchesOrderedTokens(command.label.toLowerCase(), tokens)) {
    return 4;
  }
  if (fields.some((field) => matchesOrderedTokens(field, tokens))) {
    return 3;
  }
  if (matchesOrderedTokens(joined, tokens)) {
    return 2;
  }
  if (tokens.every((token) => joined.includes(token))) {
    return 1;
  }
  return 0;
}

/** Token-aware filtering across visible labels and hidden keyword aliases with ordered matching. */
export function filterCommandPaletteCommands(
  commands: ReadonlyArray<CommandPaletteCommand>,
  query: string,
): ReadonlyArray<CommandPaletteCommand> {
  const normalizedQuery = query.toLowerCase().trim();
  const tokens = tokenizeCommandPaletteQuery(query);
  if (tokens.length === 0) {
    return commands;
  }

  return commands
    .map((command, index) => ({
      command,
      index,
      priority: command.priority ?? 0,
      score: scoreCommandPaletteCommand(command, normalizedQuery, tokens),
    }))
    .filter((entry) => entry.score > 0)
    .toSorted((left, right) =>
      right.priority - left.priority
      || right.score - left.score
      || left.index - right.index)
    .map((entry) => entry.command);
}
