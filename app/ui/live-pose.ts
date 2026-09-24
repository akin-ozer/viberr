/**
 * Closing a surface whose entrance is still playing — "always animate from
 * the presentation value, never the target" (Apple, "Designing Fluid
 * Interfaces").
 *
 * The app's dialogs enter on keyframes and leave on a `[data-closing]`
 * transition. Chrome starts no transition on a property a CSS animation is
 * still driving, so a surface closed mid-entrance got no exit at all: it
 * vanished in one frame, and the close then waited out its fallback timer
 * (measured 2026-09-24 — closed halfway in, opacity went .50 → 0 with no
 * transition; closed after the entrance, the same rule fades 1 → 0). The
 * controller dock pinned too until ruling 459 made its entrance a transition,
 * which a close retargets from where it is with nothing pinned.
 *
 * `pinLivePose` holds the element where its entrance has got to: its live
 * opacity and transform written inline and the entrance switched off, then a
 * forced style pass so that pose is what the next change transitions FROM. It
 * returns the release. Call the release only once `[data-closing]` is on the
 * element — the closing rule is what keeps the entrance off afterwards — and
 * the exit transition runs from the pinned pose.
 */
export function pinLivePose(el: HTMLElement): () => void {
  const live = getComputedStyle(el);
  el.style.opacity = live.opacity;
  el.style.transform = live.transform;
  el.style.animation = "none";
  // Reading layout commits the pinned pose as the before-change style.
  void el.offsetWidth;
  return () => {
    el.style.removeProperty("opacity");
    el.style.removeProperty("transform");
    el.style.removeProperty("animation");
  };
}
