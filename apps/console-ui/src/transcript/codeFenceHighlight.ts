export interface CodeHighlightSpan {
  readonly from: number;
  readonly to: number;
  readonly className: string;
}

type FenceLanguageProfile = "script" | "python" | "shell" | "css" | "html";

interface AbsoluteCodeHighlightSpan extends CodeHighlightSpan {}

const LANGUAGE_PROFILES: Readonly<Record<string, FenceLanguageProfile>> = {
  bash: "shell",
  css: "css",
  html: "html",
  javascript: "script",
  js: "script",
  jsx: "script",
  python: "python",
  py: "python",
  sh: "shell",
  shell: "shell",
  ts: "script",
  tsx: "script",
  typescript: "script",
};

const SCRIPT_KEYWORDS = new Set([
  "as",
  "async",
  "await",
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "debugger",
  "default",
  "delete",
  "do",
  "else",
  "enum",
  "export",
  "extends",
  "finally",
  "for",
  "from",
  "function",
  "if",
  "implements",
  "import",
  "in",
  "instanceof",
  "interface",
  "let",
  "new",
  "of",
  "package",
  "private",
  "protected",
  "public",
  "readonly",
  "return",
  "satisfies",
  "static",
  "super",
  "switch",
  "this",
  "throw",
  "try",
  "type",
  "typeof",
  "using",
  "var",
  "void",
  "while",
  "with",
  "yield",
]);

const SCRIPT_TYPE_KEYWORDS = new Set([
  "any",
  "bigint",
  "boolean",
  "never",
  "number",
  "object",
  "string",
  "symbol",
  "unknown",
  "undefined",
  "void",
]);

const PYTHON_KEYWORDS = new Set([
  "and",
  "as",
  "assert",
  "async",
  "await",
  "break",
  "case",
  "class",
  "continue",
  "def",
  "del",
  "elif",
  "else",
  "except",
  "False",
  "finally",
  "for",
  "from",
  "global",
  "if",
  "import",
  "in",
  "is",
  "lambda",
  "match",
  "None",
  "nonlocal",
  "not",
  "or",
  "pass",
  "raise",
  "return",
  "True",
  "try",
  "while",
  "with",
  "yield",
]);

const SHELL_KEYWORDS = new Set([
  "case",
  "do",
  "done",
  "elif",
  "else",
  "esac",
  "export",
  "fi",
  "for",
  "function",
  "if",
  "in",
  "local",
  "readonly",
  "return",
  "select",
  "then",
  "until",
  "while",
]);

const CSS_KEYWORDS = new Set([
  "@container",
  "@font-face",
  "@import",
  "@keyframes",
  "@layer",
  "@media",
  "@page",
  "@supports",
  "from",
  "to",
]);

const HTML_TAG_NAME = /[A-Za-z][A-Za-z0-9:-]*/y;
const IDENTIFIER = /[A-Za-z_$][\w$-]*/y;
const NUMBER_LITERAL = /(?:0[xX][\dA-Fa-f]+|0[bB][01]+|0[oO][0-7]+|\d+(?:\.\d+)?(?:e[+-]?\d+)?n?)/y;
const CSS_NUMBER_LITERAL = /(?:#[\dA-Fa-f]+|\d+(?:\.\d+)?(?:%|[A-Za-z]+)?)/y;
const OPERATOR = /(?:===|!==|==|!=|=>|<=|>=|&&|\|\||\?\?|\+\+|--|[-+*/%=&|^~<>!?:]+)/y;

function resolveLanguageProfile(language: string) {
  const normalized = language.trim().toLowerCase();
  if (normalized.length === 0) {
    return null;
  }

  return LANGUAGE_PROFILES[normalized] ?? null;
}

function isWhitespace(character: string | undefined) {
  return character === " " || character === "\t" || character === "\r" || character === "\n";
}

function isIdentifierStart(character: string | undefined) {
  return character !== undefined && /[A-Za-z_$]/.test(character);
}

function pushSpan(
  spans: AbsoluteCodeHighlightSpan[],
  from: number,
  to: number,
  className: string,
) {
  if (to <= from) {
    return;
  }

  const previous = spans[spans.length - 1];
  if (previous && previous.to === from && previous.className === className) {
    spans[spans.length - 1] = {
      from: previous.from,
      to,
      className,
    };
    return;
  }

  spans.push({ from, to, className });
}

function readQuotedString(
  source: string,
  start: number,
  quote: "'" | "\"" | "`",
) {
  let index = start + 1;
  while (index < source.length) {
    const character = source[index];
    if (character === "\\") {
      index += 2;
      continue;
    }
    if (character === quote) {
      return index + 1;
    }
    if (quote !== "`" && character === "\n") {
      return index;
    }
    index += 1;
  }
  return source.length;
}

function readDelimitedSpan(source: string, start: number, terminator: string) {
  const endIndex = source.indexOf(terminator, start);
  return endIndex === -1 ? source.length : endIndex + terminator.length;
}

function matchAt(pattern: RegExp, source: string, start: number) {
  pattern.lastIndex = start;
  const match = pattern.exec(source);
  if (!match || match.index !== start) {
    return null;
  }
  return match[0];
}

function findPreviousNonWhitespaceCharacter(source: string, index: number) {
  let cursor = index - 1;
  while (cursor >= 0) {
    const character = source[cursor];
    if (!isWhitespace(character)) {
      return character;
    }
    cursor -= 1;
  }
  return null;
}

function findNextNonWhitespaceCharacter(source: string, index: number) {
  let cursor = index;
  while (cursor < source.length) {
    const character = source[cursor];
    if (!isWhitespace(character)) {
      return character;
    }
    cursor += 1;
  }
  return null;
}

function tokenizeScript(source: string) {
  const spans: AbsoluteCodeHighlightSpan[] = [];
  let index = 0;
  while (index < source.length) {
    const character = source[index];
    if (character === "/" && source[index + 1] === "/") {
      const end = readDelimitedSpan(source, index, "\n");
      pushSpan(spans, index, end === source.length ? end : end - 1, "tok-comment");
      index = end;
      continue;
    }
    if (character === "/" && source[index + 1] === "*") {
      const end = readDelimitedSpan(source, index, "*/");
      pushSpan(spans, index, end, "tok-comment");
      index = end;
      continue;
    }
    if (character === "'" || character === "\"" || character === "`") {
      const end = readQuotedString(source, index, character);
      pushSpan(spans, index, end, "tok-string");
      index = end;
      continue;
    }
    const numberLiteral = matchAt(NUMBER_LITERAL, source, index);
    if (numberLiteral) {
      pushSpan(spans, index, index + numberLiteral.length, "tok-number");
      index += numberLiteral.length;
      continue;
    }
    const identifier = matchAt(IDENTIFIER, source, index);
    if (identifier && isIdentifierStart(identifier[0])) {
      const previousCharacter = findPreviousNonWhitespaceCharacter(source, index);
      const nextCharacter = findNextNonWhitespaceCharacter(source, index + identifier.length);
      const className =
        previousCharacter === "."
          ? "tok-propertyName"
          : SCRIPT_TYPE_KEYWORDS.has(identifier)
            ? "tok-typeName"
            : SCRIPT_KEYWORDS.has(identifier)
              ? "tok-keyword"
              : nextCharacter === ":"
                ? "tok-propertyName"
                : "tok-variableName";
      pushSpan(spans, index, index + identifier.length, className);
      index += identifier.length;
      continue;
    }
    const operator = matchAt(OPERATOR, source, index);
    if (operator) {
      pushSpan(spans, index, index + operator.length, "tok-operator");
      index += operator.length;
      continue;
    }
    index += 1;
  }
  return spans;
}

function tokenizePython(source: string) {
  const spans: AbsoluteCodeHighlightSpan[] = [];
  let index = 0;
  while (index < source.length) {
    if (source.startsWith('"""', index) || source.startsWith("'''", index)) {
      const delimiter = source.slice(index, index + 3);
      const end = readDelimitedSpan(source, index + 3, delimiter);
      pushSpan(spans, index, end, "tok-string");
      index = end;
      continue;
    }
    const character = source[index];
    if (character === "#") {
      const end = readDelimitedSpan(source, index, "\n");
      pushSpan(spans, index, end === source.length ? end : end - 1, "tok-comment");
      index = end;
      continue;
    }
    if (character === "'" || character === "\"") {
      const end = readQuotedString(source, index, character);
      pushSpan(spans, index, end, "tok-string");
      index = end;
      continue;
    }
    const numberLiteral = matchAt(NUMBER_LITERAL, source, index);
    if (numberLiteral) {
      pushSpan(spans, index, index + numberLiteral.length, "tok-number");
      index += numberLiteral.length;
      continue;
    }
    const identifier = matchAt(IDENTIFIER, source, index);
    if (identifier && isIdentifierStart(identifier[0])) {
      const className = PYTHON_KEYWORDS.has(identifier)
        ? "tok-keyword"
        : /^[A-Z]/.test(identifier)
          ? "tok-typeName"
          : "tok-variableName";
      pushSpan(spans, index, index + identifier.length, className);
      index += identifier.length;
      continue;
    }
    const operator = matchAt(OPERATOR, source, index);
    if (operator) {
      pushSpan(spans, index, index + operator.length, "tok-operator");
      index += operator.length;
      continue;
    }
    index += 1;
  }
  return spans;
}

function tokenizeShell(source: string) {
  const spans: AbsoluteCodeHighlightSpan[] = [];
  let index = 0;
  while (index < source.length) {
    const character = source[index];
    if (character === "#") {
      const previousCharacter = findPreviousNonWhitespaceCharacter(source, index);
      if (previousCharacter === null || previousCharacter === "\n" || previousCharacter === ";") {
        const end = readDelimitedSpan(source, index, "\n");
        pushSpan(spans, index, end === source.length ? end : end - 1, "tok-comment");
        index = end;
        continue;
      }
    }
    if (character === "'" || character === "\"") {
      const end = readQuotedString(source, index, character);
      pushSpan(spans, index, end, "tok-string");
      index = end;
      continue;
    }
    if (character === "$" && source[index + 1] === "{") {
      const end = readDelimitedSpan(source, index + 2, "}");
      pushSpan(spans, index, end, "tok-variableName");
      index = end;
      continue;
    }
    const identifier = matchAt(IDENTIFIER, source, index);
    if (identifier && isIdentifierStart(identifier[0])) {
      const className = SHELL_KEYWORDS.has(identifier)
        ? "tok-keyword"
        : "tok-variableName";
      pushSpan(spans, index, index + identifier.length, className);
      index += identifier.length;
      continue;
    }
    const operator = matchAt(OPERATOR, source, index);
    if (operator) {
      pushSpan(spans, index, index + operator.length, "tok-operator");
      index += operator.length;
      continue;
    }
    index += 1;
  }
  return spans;
}

function tokenizeCss(source: string) {
  const spans: AbsoluteCodeHighlightSpan[] = [];
  let index = 0;
  while (index < source.length) {
    const character = source[index];
    if (character === "/" && source[index + 1] === "*") {
      const end = readDelimitedSpan(source, index, "*/");
      pushSpan(spans, index, end, "tok-comment");
      index = end;
      continue;
    }
    if (character === "'" || character === "\"") {
      const end = readQuotedString(source, index, character);
      pushSpan(spans, index, end, "tok-string");
      index = end;
      continue;
    }
    if (character === "@") {
      const atRule = matchAt(/@[A-Za-z-]+/y, source, index);
      if (atRule) {
        const className = CSS_KEYWORDS.has(atRule) ? "tok-keyword" : "tok-variableName";
        pushSpan(spans, index, index + atRule.length, className);
        index += atRule.length;
        continue;
      }
    }
    const numberLiteral = matchAt(CSS_NUMBER_LITERAL, source, index);
    if (numberLiteral) {
      pushSpan(spans, index, index + numberLiteral.length, "tok-number");
      index += numberLiteral.length;
      continue;
    }
    const identifier = matchAt(IDENTIFIER, source, index);
    if (identifier && isIdentifierStart(identifier[0])) {
      const nextCharacter = findNextNonWhitespaceCharacter(source, index + identifier.length);
      const previousCharacter = findPreviousNonWhitespaceCharacter(source, index);
      const className =
        nextCharacter === ":"
          ? "tok-propertyName"
          : previousCharacter === "."
            ? "tok-typeName"
            : "tok-variableName";
      pushSpan(spans, index, index + identifier.length, className);
      index += identifier.length;
      continue;
    }
    index += 1;
  }
  return spans;
}

function tokenizeHtml(source: string) {
  const spans: AbsoluteCodeHighlightSpan[] = [];
  let index = 0;
  while (index < source.length) {
    if (source.startsWith("<!--", index)) {
      const end = readDelimitedSpan(source, index, "-->");
      pushSpan(spans, index, end, "tok-comment");
      index = end;
      continue;
    }
    if (source[index] !== "<") {
      index += 1;
      continue;
    }

    let cursor = index + 1;
    if (source[cursor] === "/") {
      cursor += 1;
    }
    const tagName = matchAt(HTML_TAG_NAME, source, cursor);
    if (!tagName) {
      index += 1;
      continue;
    }

    pushSpan(spans, cursor, cursor + tagName.length, "tok-tagName");
    cursor += tagName.length;
    while (cursor < source.length && source[cursor] !== ">") {
      if (isWhitespace(source[cursor]) || source[cursor] === "/") {
        cursor += 1;
        continue;
      }
      const attributeName = matchAt(/[A-Za-z_:][A-Za-z0-9_.:-]*/y, source, cursor);
      if (!attributeName) {
        cursor += 1;
        continue;
      }
      pushSpan(spans, cursor, cursor + attributeName.length, "tok-attributeName");
      cursor += attributeName.length;
      while (cursor < source.length && isWhitespace(source[cursor])) {
        cursor += 1;
      }
      if (source[cursor] !== "=") {
        continue;
      }
      cursor += 1;
      while (cursor < source.length && isWhitespace(source[cursor])) {
        cursor += 1;
      }
      const quote = source[cursor];
      if (quote === "'" || quote === "\"") {
        const end = readQuotedString(source, cursor, quote);
        pushSpan(spans, cursor, end, "tok-string");
        cursor = end;
        continue;
      }
      const value = matchAt(/[^\s>]+/y, source, cursor);
      if (value) {
        pushSpan(spans, cursor, cursor + value.length, "tok-string");
        cursor += value.length;
      }
    }
    index = cursor < source.length ? cursor + 1 : cursor;
  }
  return spans;
}

function findLineIndexForOffset(lineStarts: ReadonlyArray<number>, offset: number) {
  let low = 0;
  let high = lineStarts.length - 1;

  while (low <= high) {
    const mid = low + ((high - low) >> 1);
    const lineStart = lineStarts[mid] ?? 0;
    const nextLineStart =
      mid + 1 < lineStarts.length ? (lineStarts[mid + 1] ?? Number.MAX_SAFE_INTEGER) : Number.MAX_SAFE_INTEGER;

    if (offset < lineStart) {
      high = mid - 1;
      continue;
    }
    if (offset >= nextLineStart) {
      low = mid + 1;
      continue;
    }
    return mid;
  }

  return Math.max(0, Math.min(lineStarts.length - 1, low));
}

function tokenizeForProfile(profile: FenceLanguageProfile, source: string) {
  switch (profile) {
    case "script":
      return tokenizeScript(source);
    case "python":
      return tokenizePython(source);
    case "shell":
      return tokenizeShell(source);
    case "css":
      return tokenizeCss(source);
    case "html":
      return tokenizeHtml(source);
  }
}

export function highlightCodeFence(
  language: string,
  lines: ReadonlyArray<string>,
): ReadonlyArray<ReadonlyArray<CodeHighlightSpan>> {
  const profile = resolveLanguageProfile(language);
  if (!profile || lines.length === 0) {
    return lines.map(() => []);
  }

  const code = lines.join("\n");
  const lineStarts: number[] = [];
  let offset = 0;
  for (const line of lines) {
    lineStarts.push(offset);
    offset += line.length + 1;
  }

  const spans = lines.map(() => [] as CodeHighlightSpan[]);
  for (const span of tokenizeForProfile(profile, code)) {
    const startLineIndex = findLineIndexForOffset(lineStarts, span.from);
    for (let lineIndex = startLineIndex; lineIndex < lines.length; lineIndex += 1) {
      const lineStart = lineStarts[lineIndex] ?? 0;
      if (span.to <= lineStart) {
        break;
      }
      const lineEnd = lineStart + (lines[lineIndex]?.length ?? 0);
      if (span.from >= lineEnd) {
        continue;
      }

      const localFrom = Math.max(0, span.from - lineStart);
      const localTo = Math.min(lineEnd, span.to) - lineStart;
      if (localFrom >= localTo) {
        continue;
      }

      spans[lineIndex]?.push({
        from: localFrom,
        to: localTo,
        className: span.className,
      });
    }
  }

  return spans;
}
