/**
 * Shared 24px stroke icon set. Unknown names fall back to "dot".
 */

const ICON_PATHS = {
  board:
    '<rect x="3" y="3" width="7" height="18" rx="1.5"/><rect x="14" y="3" width="7" height="11" rx="1.5"/>',
  review: '<path d="M4 5h16M4 12h16M4 19h10"/>',
  inbox:
    '<path d="M3 12h5l2 3h4l2-3h5"/><path d="M5 6h14l2 6v6a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-6z"/>',
  shield: '<path d="M12 3l7 3v5c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6z"/>',
  agents:
    '<rect x="5" y="8" width="14" height="11" rx="2"/><path d="M12 8V4M9 4h6M9 13h.01M15 13h.01M9 16h6"/>',
  github:
    '<path d="M9 19c-4 1.5-4-2.5-6-3m12 5v-3.5c0-1 .1-1.4-.5-2 2.8-.3 5.5-1.4 5.5-6a4.6 4.6 0 0 0-1.3-3.2 4.3 4.3 0 0 0-.1-3.2s-1-.3-3.4 1.3a11.5 11.5 0 0 0-6 0C6.3 3.3 5.3 3.6 5.3 3.6a4.3 4.3 0 0 0-.1 3.2A4.6 4.6 0 0 0 4 10c0 4.6 2.7 5.7 5.5 6-.4.4-.5.9-.5 1.8V21"/>',
  // Ruling 459: the Google mark drawn in the set's own stroke, one colour
  // (currentColor, never the brand four), so a sign-in control pairs outline
  // with outline instead of a typed ExtraBold "G" beside the GitHub glyph. An
  // open ring on the clock's r 8.5, from half past one round to three, and the
  // bar in to the centre.
  google: '<path d="M18 6A8.5 8.5 0 1 0 20.5 12H12.5"/>',
  activity: '<path d="M3 12h4l3 8 4-16 3 8h4"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4-4"/>',
  filter: '<path d="M3 5h18l-7 8v6l-4-2v-4z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  branch:
    '<circle cx="6" cy="6" r="2.5"/><circle cx="6" cy="18" r="2.5"/><circle cx="18" cy="7" r="2.5"/><path d="M6 8.5v7M18 9.5c0 4-6 2.5-6 6.5"/>',
  pr: '<circle cx="6" cy="6" r="2.5"/><circle cx="6" cy="18" r="2.5"/><circle cx="18" cy="18" r="2.5"/><path d="M6 8.5v7M18 15.5V11a3 3 0 0 0-3-3h-3l2.5-2.5M11.5 8 14 10.5"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h8"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  alert: '<path d="M12 4l9 16H3z"/><path d="M12 10v4M12 17h.01"/>',
  file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h6"/>',
  // `file` without its lines: a timeline file tile prints the type on it.
  page: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>',
  lock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 20c1.5-4 4.5-6 8-6s6.5 2 8 6"/>',
  cpu: '<rect x="7" y="7" width="10" height="10" rx="1.5"/><path d="M9 1.5v3M15 1.5v3M9 19.5v3M15 19.5v3M1.5 9h3M1.5 15h3M19.5 9h3M19.5 15h3"/>',
  message:
    '<path d="M21 12a8 8 0 0 1-11.5 7.2L4 20l1-4.8A8 8 0 1 1 21 12z"/>',
  // Ruling 459, a departure from the mock (design/html-app/app/ui.jsx): sparkle,
  // hand and flag are recentred on the 24px box. The mock drew the sparkle 2
  // units high, the hand 2 left and 1 high and the flag 2 left, so each sat off
  // centre in every round badge, tile and icon-only button that shows it alone.
  // Same strokes, translated: only the absolute commands moved. app.css.test.ts
  // measures every glyph's box against the centre.
  sparkle:
    '<path d="M12 5l1.8 5.2L19 12l-5.2 1.8L12 19l-1.8-5.2L5 12l5.2-1.8z"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-2.6-6.4M21 4v5h-5"/>',
  // The busy-state glyph: a three-quarter arc with no arrowhead (lucide's
  // `loader-circle`, the glyph shadcn/reui's Spinner draws), meant to be
  // rendered with the `spin` class. Every busy state trades its glyph for
  // this one (ruling 459: sign-in, attach, import and rebuild spun `refresh`
  // or the memory chip), and ruling 368's 2026-09-24 extension put it in
  // place of every in-flight starter's icon, Home's re-scan, the KB re-index
  // and the MCP test among them. Only the board's re-scan still spins its own
  // `refresh`, where the arrow IS the meaning and already the glyph at rest.
  // app.css.test.ts holds the line.
  loader: '<path d="M21 12a9 9 0 1 1-6.219-8.56"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  bolt: '<path d="M13 3L5 13h6l-1 8 8-10h-6z"/>',
  memory:
    '<rect x="4" y="6" width="16" height="12" rx="2"/><path d="M8 6V3M12 6V3M16 6V3M8 18v3M12 18v3M16 18v3"/>',
  dot: '<circle cx="12" cy="12" r="4"/>',
  send: '<path d="M4 12l16-8-6 16-3-6z"/>',
  // Recentred against the mock (ruling 459); see the note above `sparkle`.
  hand: '<path d="M9 12V7a1.5 1.5 0 0 1 3 0v4M12 11V5.5a1.5 1.5 0 0 1 3 0V11M15 11V7a1.5 1.5 0 0 1 3 0v6c0 4-2.5 7-6 7s-6-2.5-6-6v-1l1.5-1.5"/>',
  flag: '<path d="M7 21V4M7 4h10l-1.5 3L17 10H7"/>',
  bell: '<path d="M18 9a6 6 0 1 0-12 0c0 6-2 7.5-2 7.5h16S18 15 18 9"/><path d="M10.3 20a2 2 0 0 0 3.4 0"/>',
  chevron: '<path d="M9 6l6 6-6 6"/>',
  sliders:
    '<path d="M4 6h8M16 6h4M4 12h2M10 12h10M4 18h10M18 18h2"/><circle cx="14" cy="6" r="2"/><circle cx="8" cy="12" r="2"/><circle cx="16" cy="18" r="2"/>',
  grip: '<circle cx="9" cy="5.5" r="1"/><circle cx="15" cy="5.5" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="9" cy="18.5" r="1"/><circle cx="15" cy="18.5" r="1"/>',
  ext: '<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
  term: '<rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="M7 9.5l3 3-3 3M13 15.5h4"/>',
  // Ruling 500: a code block's head in a comment (the angle brackets).
  code: '<path d="M8.5 7L3.5 12l5 5M15.5 7l5 5-5 5"/>',
  // Ruling 365: the board card's status and problem marks — a circle family
  // (failed, done, held, resting) so the chips read as one set at 13px.
  xcircle: '<circle cx="12" cy="12" r="8.5"/><path d="M9 9l6 6M15 9l-6 6"/>',
  checkcircle: '<circle cx="12" cy="12" r="8.5"/><path d="M8 12.5l2.5 2.5L16 9.5"/>',
  ban: '<circle cx="12" cy="12" r="8.5"/><path d="M6.5 6.5l11 11"/>',
  ring: '<circle cx="12" cy="12" r="5.5"/>',
  // Ruling 499: an agent's to-do step, in the same circle family: a dotted
  // ring waiting, an arrow in the ring under way, `checkcircle` done.
  todo: '<circle cx="12" cy="12" r="8.5" stroke-dasharray=".1 3.2"/>',
  todonow: '<circle cx="12" cy="12" r="8.5"/><path d="M8 12h7.5M12.5 9l3 3-3 3"/>',
  // Ruling 366: the product's own mark, for the console chip of a Viberr tool.
  viberr: '<path d="M5 5l7 14 7-14"/>',
  // Ruling 458(f): the glyphs the mock drew as local SVGs (kb-browser.jsx's
  // folder and uploads, org-settings.jsx's pencil, home.jsx's pin star) join
  // the one set, paths verbatim. A state is its own name, as in the circle
  // family: `folderopen` for an expanded tree row, `starfilled` for a pinned
  // project (its path carries the fill, since the <svg> paints none).
  folder:
    '<path d="M3.5 7a2 2 0 0 1 2-2h3.6l2 2h7.4a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/>',
  folderopen:
    '<path d="M3.5 8V6.5a2 2 0 0 1 2-2h3.6l2 2h7.4a2 2 0 0 1 2 2V10M3.5 8h16.2l-1.6 9a2 2 0 0 1-2 1.6H6.6a2 2 0 0 1-2-1.6z"/>',
  folderup:
    '<path d="M3.5 7a2 2 0 0 1 2-2h3.6l2 2h7.4a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/><path d="M12 16v-5.5M9.5 12.5L12 10l2.5 2.5"/>',
  upload: '<path d="M12 16V5M7.5 9L12 4.5 16.5 9M5 19.5h14"/>',
  edit: '<path d="M4 20l1-4L16 5a2.1 2.1 0 0 1 3 3L8 19z"/><path d="M13.5 7.5l3 3"/>',
  star: '<path d="M12 3.6l2.6 5.3 5.8.8-4.2 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.2-4.1 5.8-.8z"/>',
  starfilled:
    '<path fill="currentColor" d="M12 3.6l2.6 5.3 5.8.8-4.2 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.2-4.1 5.8-.8z"/>',
  // Ruling 503: an epic — work stacked into one body, on the box's centre.
  epic: '<path d="M12 3.5l8.5 4.5L12 12.5 3.5 8z"/><path d="M3.5 12L12 16.5 20.5 12M3.5 16L12 20.5 20.5 16"/>',
} as const;

export type IconName = keyof typeof ICON_PATHS;

/** Free-form icon text (e.g. profile frontmatter) → a renderable name. */
export function storeIcon(name: string): IconName {
  // SAFETY: the `in` check is the invariant — when it passes, `name` is a key
  // of ICON_PATHS; any other value maps to the "dot" fallback glyph.
  return name in ICON_PATHS ? (name as IconName) : "dot";
}

/**
 * Ruling 457: one `{__html}` object per glyph, made once. React 19 compares
 * `dangerouslySetInnerHTML` by the object's identity, so a fresh object on each
 * render re-parsed the markup and replaced the SVG's children every time an
 * icon re-rendered (60 per task-page render, 133 per board revalidation).
 */
const ICON_HTML = new Map<IconName, { __html: string }>();

function iconHtml(name: IconName): { __html: string } {
  let html = ICON_HTML.get(name);
  if (!html) {
    html = { __html: ICON_PATHS[name] || ICON_PATHS.dot };
    ICON_HTML.set(name, html);
  }
  return html;
}

export function Icon({
  name,
  className,
}: {
  name: IconName;
  className?: string;
}) {
  return (
    <svg
      className={"ico " + (className || "")}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      dangerouslySetInnerHTML={iconHtml(name)}
      aria-hidden="true"
    />
  );
}
