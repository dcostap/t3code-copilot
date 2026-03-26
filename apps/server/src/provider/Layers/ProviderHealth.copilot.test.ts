import { Effect } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockStart,
  mockStop,
  mockGetStatus,
  mockGetAuthStatus,
  mockGetQuota,
  mockListModels,
  MockCopilotClient,
} = vi.hoisted(() => {
  const mockStart = vi.fn();
  const mockStop = vi.fn();
  const mockGetStatus = vi.fn();
  const mockGetAuthStatus = vi.fn();
  const mockGetQuota = vi.fn();
  const mockListModels = vi.fn();
  const MockCopilotClient = vi.fn(function MockCopilotClient() {
    return {
      start: mockStart,
      stop: mockStop,
      getStatus: mockGetStatus,
      getAuthStatus: mockGetAuthStatus,
      listModels: mockListModels,
      rpc: {
        account: {
          getQuota: mockGetQuota,
        },
      },
    };
  });

  return {
    mockStart,
    mockStop,
    mockGetStatus,
    mockGetAuthStatus,
    mockGetQuota,
    mockListModels,
    MockCopilotClient,
  };
});

vi.mock("@github/copilot-sdk", () => ({
  CopilotClient: MockCopilotClient,
}));

const { checkCopilotProviderStatus } = await import("./ProviderHealth");

describe("checkCopilotProviderStatus", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStart.mockResolvedValue(undefined);
    mockStop.mockResolvedValue([]);
    mockGetStatus.mockResolvedValue({ version: "1.2.3" });
    mockGetAuthStatus.mockResolvedValue({
      isAuthenticated: true,
      statusMessage: "Authenticated",
    });
    mockGetQuota.mockResolvedValue(undefined);
    mockListModels.mockResolvedValue([
      {
        id: "claude-opus-4.6",
        name: "Claude Opus 4.6",
        billing: { multiplier: 3 },
      },
    ]);
  });

  it("includes copilot models with billing multipliers in the provider status", async () => {
    const status = await Effect.runPromise(checkCopilotProviderStatus);

    expect(MockCopilotClient).toHaveBeenCalledTimes(1);
    expect(mockListModels).toHaveBeenCalledTimes(1);
    expect(status.provider).toBe("copilot");
    expect(status.authStatus).toBe("authenticated");
    expect(status.models).toEqual([
      expect.objectContaining({
        id: "claude-opus-4.6",
        name: "Claude Opus 4.6",
        billingMultiplier: 3,
      }),
    ]);
  });

  it("skips model loading when copilot is not authenticated", async () => {
    mockGetAuthStatus.mockResolvedValue({
      isAuthenticated: false,
      statusMessage: "Login required",
    });

    const status = await Effect.runPromise(checkCopilotProviderStatus);

    expect(mockListModels).not.toHaveBeenCalled();
    expect(status.models).toBeUndefined();
    expect(status.authStatus).toBe("unauthenticated");
  });
});
