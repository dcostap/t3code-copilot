const NON_MAC_DESKTOP_WINDOW_CONTROLS_INSET_PX = 138;

export function resolveDesktopWindowControlsInsetPx(
  isDesktop: boolean,
  platform: string | null | undefined,
) {
  if (!isDesktop) {
    return 0;
  }

  const normalizedPlatform = platform?.trim().toLowerCase() ?? "";
  if (normalizedPlatform.includes("mac") || normalizedPlatform.includes("darwin")) {
    return 0;
  }

  return NON_MAC_DESKTOP_WINDOW_CONTROLS_INSET_PX;
}

export function readClientPlatform() {
  if (typeof navigator === "undefined") {
    return null;
  }

  const userAgentData = (navigator as Navigator & {
    userAgentData?: {
      platform?: string;
    };
  }).userAgentData;

  if (typeof userAgentData?.platform === "string" && userAgentData.platform.length > 0) {
    return userAgentData.platform;
  }

  return typeof navigator.platform === "string" && navigator.platform.length > 0
    ? navigator.platform
    : null;
}
