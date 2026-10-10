import { isMarkdownName, languageForName } from "~/ui/code-language";

/**
 * Ruling 86: the names and sizes of a page capture, in ONE place.
 *
 * Viberr renders a delivered page (HTML or markdown) in a headless browser and
 * keeps the picture on the task beside the file. The writer
 * (`page-capture.server.ts`), every reader that must tell Viberr's own picture
 * from a file somebody delivered (the run claims, the kept delivery, the packet
 * candidates) and the card that prints it all read these, so the name a
 * picture is saved under is the name they recognise. Client-safe: the card and
 * the lightbox import it.
 */

/** The widths a page is pictured at. */
export type PageCaptureViewId = "desktop" | "phone";

export interface PageCaptureView {
  id: PageCaptureViewId;
  /** The viewport the page is loaded at. */
  width: number;
  height: number;
  /** The tallest picture kept of a delivered page: six screens. */
  maxHeight: number;
  /** Laid out as a phone lays it out (the page's own viewport setting). */
  mobile: boolean;
  /** "Desktop, 1280 px wide": how the card and the note name the view. */
  label: string;
}

/** Both views, in the order they are taken and shown. Each cap is six screens
 *  and under the image reader's 8000 px side limit. */
export const PAGE_CAPTURE_VIEWS: readonly PageCaptureView[] = [
  { id: "desktop", width: 1280, height: 800, maxHeight: 4800, mobile: false, label: "Desktop, 1280 px wide" },
  { id: "phone", width: 390, height: 844, maxHeight: 5064, mobile: true, label: "Phone, 390 px wide" },
];

export function pageCaptureView(id: PageCaptureViewId): PageCaptureView {
  return PAGE_CAPTURE_VIEWS.find((view) => view.id === id) ?? PAGE_CAPTURE_VIEWS[0]!;
}

/** What kind of page a file is, by its name; null when it is not one. `.mdx`
 *  is not: its JSX and imports are not markdown (`isMarkdownName`). */
export type PageKind = "html" | "markdown";

export function pageKindOf(name: string): PageKind | null {
  if (isMarkdownName(name)) return "markdown";
  return languageForName(name) === "html" ? "html" : null;
}

/** The extensions {@link pageKindOf} accepts, as a sentence prints them. */
export const PAGE_EXTENSIONS_TEXT = ".html, .htm, .md and .markdown";

/** The name a page's picture is kept under. No timestamp on purpose: the next
 *  delivery's picture of the same file replaces this one. */
export function pageCaptureName(file: string, view: PageCaptureViewId): string {
  return `${file}.capture-${view}.png`;
}

const CAPTURE_NAME_RE = /\.capture-(desktop|phone)\.png$/i;

/** The page a picture's name says it is of. */
export function pageOfCaptureName(name: string): string {
  return name.replace(CAPTURE_NAME_RE, "");
}

/** The width a picture's name says it was taken at; null for any other name.
 *  The lightbox opens a tall picture in a scroller by this: how a picture
 *  opens, never whose it is, so the suffix alone decides there. */
export function viewOfCaptureName(name: string): PageCaptureViewId | null {
  const view = CAPTURE_NAME_RE.exec(name)?.[1]?.toLowerCase();
  return view === "desktop" || view === "phone" ? view : null;
}

/**
 * True for a name that ends the way Viberr's own page pictures do
 * (`post.html.capture-desktop.png`). The ending alone: whether a file of that
 * name IS Viberr's own is {@link pageCapturesAmong}'s to say, which also asks
 * whose page it pictures.
 */
export function isPageCaptureName(name: string): boolean {
  return CAPTURE_NAME_RE.test(name);
}

/**
 * The names among `files` (one folder's listing) that are Viberr's own page
 * pictures: ending like one, and either of a page that is itself among
 * `files` or among the names `recorded`, which the task's record says the
 * last render wrote (the page it pictured may since have left the task).
 *
 * The suffix alone is not enough. An agent that screenshots its own work may
 * name the file `landing.capture-desktop.png`, or picture a page that is not
 * on the task: that file is the agent's, to be claimed by its run, kept with
 * the delivery and offered as a screenshot like any other. Only the picture
 * of a page the folder holds is the name the renderer writes and replaces.
 * The page is matched in either Unicode form (ruling 76): the store keeps a
 * picture's name composed whatever form its page was stored in.
 */
export function pageCapturesAmong(files: readonly string[], recorded: Iterable<string> = []): Set<string> {
  const pages = new Set<string>();
  for (const file of files) {
    if (pageKindOf(file) !== null) pages.add(file.normalize("NFC"));
  }
  const written = new Set(recorded);
  const own = new Set<string>();
  for (const file of files) {
    if (!isPageCaptureName(file)) continue;
    if (written.has(file) || pages.has(pageOfCaptureName(file).normalize("NFC"))) own.add(file);
  }
  return own;
}

/** The pictures a task's `pageCaptures` record names. */
export function recordedPageCaptures(
  record: { pages: readonly { shots: readonly { name: string }[] }[] } | null | undefined,
): string[] {
  return (record?.pages ?? []).flatMap((page) => page.shots.map((shot) => shot.name));
}

/** The system actor that writes a delivery's capture note. */
export const PAGE_CAPTURE_SYSTEM_ID = "page-capture";
/** The title that note carries. */
export const PAGE_CAPTURE_NOTE_TITLE = "Page captures";
/** How many pages of one delivery are pictured; the rest are counted. */
export const PAGE_CAPTURE_MAX_PAGES = 8;
/** A source name past this is not pictured: the picture's own name must fit
 *  the 200 characters a timeline entry allows an attachment name. A page a
 *  revision's gates built is pictured under a longer name (its path, a mark
 *  for each folder and the revision), which the server holds to the same 200
 *  where it pictures one. */
export const PAGE_CAPTURE_MAX_NAME_CHARS = 178;
/** The furthest down a page an agent's stretch may start: the walk to it
 *  stays well inside a page's 25 seconds. */
export const PAGE_CAPTURE_MAX_FROM = 40_000;
