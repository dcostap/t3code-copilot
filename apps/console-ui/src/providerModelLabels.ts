import { type ProviderKind, type ServerProviderModel } from "@t3tools/contracts";

const copilotBillingMultiplierFormatter = new Intl.NumberFormat(undefined, {
  maximumFractionDigits: 1,
});
const COPILOT_MODEL_LOOKUP_ALIASES = {
  "gemini-3.1-pro": "gemini-3-pro-preview",
} as const satisfies Record<string, string>;

export function formatCopilotBillingMultiplier(multiplier: number): string {
  return `(${copilotBillingMultiplierFormatter.format(multiplier)}x)`;
}

export function formatProviderModelLabel(input: {
  readonly provider: ProviderKind;
  readonly model: string;
  readonly baseLabel?: string;
  readonly copilotModelById: ReadonlyMap<string, ServerProviderModel>;
}): string {
  const label = input.baseLabel ?? input.model;
  if (input.provider !== "copilot") {
    return label;
  }

  const resolvedModelId = input.copilotModelById.has(input.model)
    ? input.model
    : (COPILOT_MODEL_LOOKUP_ALIASES[input.model as keyof typeof COPILOT_MODEL_LOOKUP_ALIASES] ?? input.model);
  const modelMetadata = input.copilotModelById.get(resolvedModelId);
  const resolvedLabel = input.baseLabel ?? modelMetadata?.name ?? input.model;
  const multiplier = modelMetadata?.billingMultiplier;
  if (typeof multiplier !== "number") {
    return resolvedLabel;
  }

  return `${resolvedLabel} ${formatCopilotBillingMultiplier(multiplier)}`;
}
