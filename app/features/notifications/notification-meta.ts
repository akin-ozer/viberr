import type { IconName } from "~/ui/icon";

/**
 * THE shared notification kind → icon/color mapping + markdown stripper
 * (contracts §4 / ruling 14 — the mock duplicates both ×3; port once).
 * The `act-*` classes are the timeline event palette in viberr.css.
 */

export interface NtfMeta {
  icon: IconName;
  cls:
    | "act-blocked"
    | "act-completion"
    | "act-transition"
    | "act-comment"
    | "act-quality"
    | "act-policy";
}

export function ntfMeta(n: {
  kind: string;
  ptype?: "input" | "blocked" | null;
}): NtfMeta {
  if (n.kind === "packet") {
    return n.ptype === "blocked"
      ? { icon: "alert", cls: "act-blocked" }
      : { icon: "check", cls: "act-completion" };
  }
  if (n.kind === "approval") return { icon: "arrow", cls: "act-transition" };
  if (n.kind === "mention") return { icon: "message", cls: "act-comment" };
  if (n.kind === "quality") return { icon: "flag", cls: "act-quality" };
  return { icon: "alert", cls: "act-policy" }; // "policy" + unknown fallback
}

/** Strips the RichText micro-format markers (popovers render plain text). */
export function plainText(s: string | null | undefined): string {
  return (s || "").replace(/\*\*/g, "").replace(/`/g, "");
}
