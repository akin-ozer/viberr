import type { LinkDescriptor } from "react-router";
import interLatin400 from "@fontsource/inter/files/inter-latin-400-normal.woff2?url";
import interLatin500 from "@fontsource/inter/files/inter-latin-500-normal.woff2?url";
import interLatin700 from "@fontsource/inter/files/inter-latin-700-normal.woff2?url";

/**
 * Ruling 454: the Inter faces a first paint needs are preloaded, so the
 * browser fetches them while it parses the HTML instead of discovering them
 * only after the root stylesheet has been downloaded, parsed and matched.
 *
 * Only faces the page will certainly draw are named: a preload the page never
 * uses costs its bytes on every cold load. The `?url` import resolves to the
 * same hashed file the `@fontsource` CSS references, so the preloaded response
 * is the one the `@font-face` rule uses. Fonts are always fetched in CORS mode,
 * hence `crossOrigin`; without it the preload is fetched twice.
 *
 *  - Every page (root): 400, the body weight every unstyled line of text
 *    uses, and 700, the weight of `.btn`, `.pill` and the field labels, which
 *    the login page, Home and the workspace all draw on first paint.
 *  - The project workspace (`routes/project`) adds 500: the rail, the crumbs,
 *    the board's card titles, column heads and filter chips (ruling 365(g)).
 *
 * 600 and 800 (a page title, a name, the brand mark) and JetBrains Mono (the
 * ⌘K chip, keys and counts) are short runs of text; they load from the
 * stylesheet as before, and the metric-matched "Inter Fallback" face in
 * app.css keeps their swap from moving the text around them.
 */
function fontPreload(href: string): LinkDescriptor {
  return { rel: "preload", as: "font", type: "font/woff2", href, crossOrigin: "anonymous" };
}

export const SHELL_FONT_PRELOADS: LinkDescriptor[] = [
  fontPreload(interLatin400),
  fontPreload(interLatin700),
];

export const WORKSPACE_FONT_PRELOADS: LinkDescriptor[] = [fontPreload(interLatin500)];
