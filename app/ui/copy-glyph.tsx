import { Icon } from "~/ui/icon";

/**
 * Ruling 451(c): a copy control's glyph. Both marks are always drawn, stacked
 * in one grid cell, and the sheet trades them on `data-copied`: the copy mark
 * shrinks and blurs out as the check grows in, and the reverse when the
 * confirmation lapses. A swap that React made in one frame read as a flicker
 * between two unrelated icons; this reads as one mark changing its mind.
 */
export function CopyGlyph({ copied }: { copied: boolean }) {
  return (
    <span className="copy-glyph" data-copied={copied ? "true" : undefined} aria-hidden="true">
      <Icon name="copy" />
      <Icon name="check" />
    </span>
  );
}
