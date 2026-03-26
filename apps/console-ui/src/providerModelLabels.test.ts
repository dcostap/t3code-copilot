import { describe, expect, it } from "vitest";

import { formatCopilotBillingMultiplier, formatProviderModelLabel } from "./providerModelLabels";

describe("providerModelLabels", () => {
  it("formats copilot billing multipliers as a compact x suffix", () => {
    expect(formatCopilotBillingMultiplier(3)).toBe("(3x)");
  });

  it("appends the copilot billing multiplier to the label when metadata exists", () => {
    const label = formatProviderModelLabel({
      provider: "copilot",
      model: "claude-opus-4.6",
      baseLabel: "Copilot CLI: Claude Opus 4.6",
      copilotModelById: new Map([
        [
          "claude-opus-4.6",
          {
            id: "claude-opus-4.6",
            name: "Claude Opus 4.6",
            supportsReasoningEffort: false,
            billingMultiplier: 3,
          },
        ],
      ]),
    });

    expect(label).toBe("Copilot CLI: Claude Opus 4.6 (3x)");
  });

  it("leaves labels unchanged when the provider is not copilot or the multiplier is missing", () => {
    expect(formatProviderModelLabel({
      provider: "codex",
      model: "gpt-5.4",
      baseLabel: "Codex: GPT-5.4",
      copilotModelById: new Map(),
    })).toBe("Codex: GPT-5.4");

    expect(formatProviderModelLabel({
      provider: "copilot",
      model: "gpt-5.4",
      baseLabel: "Copilot CLI: GPT-5.4",
      copilotModelById: new Map([
        [
          "gpt-5.4",
          {
            id: "gpt-5.4",
            name: "GPT-5.4",
            supportsReasoningEffort: false,
          },
        ],
      ]),
    })).toBe("Copilot CLI: GPT-5.4");
  });

  it("falls back to the SDK model name and multiplier for legacy Gemini aliases", () => {
    expect(formatProviderModelLabel({
      provider: "copilot",
      model: "gemini-3.1-pro",
      copilotModelById: new Map([
        [
          "gemini-3-pro-preview",
          {
            id: "gemini-3-pro-preview",
            name: "Gemini 3 Pro (Preview)",
            supportsReasoningEffort: false,
            billingMultiplier: 1,
          },
        ],
      ]),
    })).toBe("Gemini 3 Pro (Preview) (1x)");
  });
});
