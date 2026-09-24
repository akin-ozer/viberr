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
 */
export function GlyphSwap({
  rest,
  alt,
  on,
  spinAlt = false,
}: {
  rest: IconName;
  alt: IconName;
  on: boolean;
  spinAlt?: boolean;
}) {
  return (
    <span className="copy-glyph" data-copied={on ? "true" : undefined} aria-hidden="true">
      <Icon name={rest} />
      <Icon name={alt} className={spinAlt ? "spin" : ""} />
    </span>
  );
}

/** Ruling 451(c): a copy control's glyph, the copy mark trading for the check. */
export function CopyGlyph({ copied }: { copied: boolean }) {
  return <GlyphSwap rest="copy" alt="check" on={copied} />;
}
