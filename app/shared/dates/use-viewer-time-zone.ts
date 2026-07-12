import { useSyncExternalStore } from "react";

/**
 * Hydration-safe viewer time zone.
 *
 * React uses the server snapshot during SSR and the first hydration render,
 * so date grouping and clock labels are deterministically UTC on both sides.
 * Immediately after hydration it reads the browser's stable IANA zone and
 * re-renders the labels for the viewer without replacing mismatched markup.
 */
export const HYDRATION_TIME_ZONE = "UTC";

const subscribe = () => () => {};
const serverSnapshot = () => HYDRATION_TIME_ZONE;

function browserSnapshot(): string {
  try {
    return (
      Intl.DateTimeFormat().resolvedOptions().timeZone || HYDRATION_TIME_ZONE
    );
  } catch {
    return HYDRATION_TIME_ZONE;
  }
}

export function useViewerTimeZone(): string {
  return useSyncExternalStore(subscribe, browserSnapshot, serverSnapshot);
}
