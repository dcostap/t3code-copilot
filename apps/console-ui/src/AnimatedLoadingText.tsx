function joinClassNames(...classNames: ReadonlyArray<string | undefined>) {
  return classNames.filter((className): className is string => Boolean(className)).join(" ");
}

export function resolveAnimatedLoadingTextCharacterDelaySeconds(textLength: number) {
  return textLength <= 48
    ? 0.028
    : textLength >= 120
      ? 0.04
      : 0.028 + ((textLength - 48) / (120 - 48)) * 0.012;
}

interface AnimatedLoadingTextTimingOptions {
  readonly characterDelaySeconds?: number;
}

export function buildAnimatedLoadingTextSegments(text: string, options?: AnimatedLoadingTextTimingOptions) {
  const perCharacterDelaySeconds =
    options?.characterDelaySeconds ?? resolveAnimatedLoadingTextCharacterDelaySeconds(text.length);
  return Array.from(text).map((char, index) => ({
    key: `${index}:${char === " " ? "space" : char}`,
    value: char === " " ? "\u00A0" : char,
    delaySeconds: index * perCharacterDelaySeconds,
  }));
}

interface AnimatedLoadingTextElementOptions extends AnimatedLoadingTextTimingOptions {
  readonly className?: string;
}

export function createAnimatedLoadingTextElement(
  text: string,
  options?: AnimatedLoadingTextElementOptions & { readonly document?: Document },
) {
  const ownerDocument = options?.document ?? (typeof document !== "undefined" ? document : null);
  if (!ownerDocument) {
    throw new Error("Animated loading text requires a document.");
  }

  const root = ownerDocument.createElement("span");
  root.className = joinClassNames("loading-text", options?.className);

  for (const segment of buildAnimatedLoadingTextSegments(text, options)) {
    const charElement = ownerDocument.createElement("span");
    charElement.className = "loading-text__char";
    charElement.textContent = segment.value;
    charElement.style.animationDelay = `${segment.delaySeconds}s`;
    root.append(charElement);
  }

  return root;
}

interface AnimatedLoadingTextProps {
  readonly text: string;
  readonly className?: string;
  readonly characterDelaySeconds?: number;
}

export function AnimatedLoadingText({ text, className, characterDelaySeconds }: AnimatedLoadingTextProps) {
  return (
    <span className={joinClassNames("loading-text", className)}>
      {buildAnimatedLoadingTextSegments(
        text,
        characterDelaySeconds !== undefined ? { characterDelaySeconds } : undefined,
      ).map((segment) => (
        <span
          key={segment.key}
          className="loading-text__char"
          style={{ animationDelay: `${segment.delaySeconds}s` }}
        >
          {segment.value}
        </span>
      ))}
    </span>
  );
}
