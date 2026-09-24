import { memo } from "react";
import { Icon, type IconName } from "~/ui/icon";

/**
 * Ruling 451(c), extended by ruling 459: a glyph that trades for another with
 * state. Both marks are always drawn, stacked in one grid cell, and the sheet
 * trades them on `data-copied` (the attribute ruling 451's tests pin): the
 * resting mark shrinks and blurs out as the other grows in, and the reverse
 * when the state lapses. A swap that React made in one frame read as a flicker
 * between two unrelated icons; this reads as one mark changing its mind.
 *
 * `spinAlt` puts the shared spinner on the alternate for good. The sheet
 * pauses it while it rests hidden, so a loader that leaves freezes where it
 * stands instead of snapping back to 0deg as it fades.
 *
 * `busy` is for a control whose resting mark already trades with its state
 * (Run → Schedule, Archive → Restore, Attach → Rotate) and that also starts a
 * request (ruling 368): that whole resting cell trades for the spinning loader
 * on the same cell rules one level up (the resting cell is the first child,
 * the loader the last), so neither change is a hard swap and there is only
 * ever one loader. Leave it out where the loader is the alternate itself
 * (`alt="loader" spinAlt`).
 *
 * Memoised (ruling 457): the props are four primitives, so a revalidation that
 * brings the same data back re-renders neither the cell nor its two or three
 * glyphs.
 */
export const GlyphSwap = memo(function GlyphSwap({
  rest,
  alt,
  on,
  spinAlt = false,
  busy,
}: {
  rest: IconName;
  alt: IconName;
  on: boolean;
  spinAlt?: boolean;
  busy?: boolean;
}) {
  const swap = (
    <span className="copy-glyph" data-copied={on ? "true" : undefined} aria-hidden="true">
      <Icon name={rest} />
      <Icon name={alt} className={spinAlt ? "spin" : ""} />
    </span>
  );
  if (busy === undefined) return swap;
  return (
    <span className="copy-glyph" data-copied={busy ? "true" : undefined} aria-hidden="true">
      {swap}
      <Icon name="loader" className="spin" />
    </span>
  );
});

/** Ruling 451(c): a copy control's glyph, the copy mark trading for the check. */
export function CopyGlyph({ copied }: { copied: boolean }) {
  return <GlyphSwap rest="copy" alt="check" on={copied} />;
}
