import type { ToastInput } from "~/ui/toast";

export type NotificationReadResult =
  | { ok: true; changed: number }
  | { ok: false; error: string };

/** Feedback copy is derived only from the completed server response. */
export function notificationReadAllFeedback(
  result: NotificationReadResult,
): ToastInput {
  if (!result.ok) return { kind: "error", text: result.error };
  return {
    kind: "success",
    text:
      result.changed > 0
        ? "All notifications marked read"
        : "Notifications were already read",
  };
}
