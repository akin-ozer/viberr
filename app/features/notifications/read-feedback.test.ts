import { describe, expect, it } from "vitest";
import { notificationReadAllFeedback } from "./read-feedback";

describe("notificationReadAllFeedback", () => {
  it("reports success only after a successful response", () => {
    expect(notificationReadAllFeedback({ ok: true, changed: 4 })).toEqual({
      kind: "success",
      text: "All notifications marked read",
    });
    expect(notificationReadAllFeedback({ ok: true, changed: 0 })).toEqual({
      kind: "success",
      text: "Notifications were already read",
    });
  });

  it("preserves server errors as error feedback", () => {
    expect(
      notificationReadAllFeedback({ ok: false, error: "Read failed" }),
    ).toEqual({ kind: "error", text: "Read failed" });
  });
});
