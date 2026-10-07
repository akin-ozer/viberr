import { isMarkdownName, languageForName } from "~/ui/code-language";

/**
 * Ruling 691: the names and sizes of a page capture, in ONE place.
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

/** True for a name only Viberr's own page pictures carry. */
export function isPageCaptureName(name: string): boolean {
  return CAPTURE_NAME_RE.test(name);
}

/** The page a picture's name says it is of. */
export function pageOfCaptureName(name: string): string {
  return name.replace(CAPTURE_NAME_RE, "");
}

/** The width a picture's name says it was taken at; null for any other name. */
export function viewOfCaptureName(name: string): PageCaptureViewId | null {
  const view = CAPTURE_NAME_RE.exec(name)?.[1]?.toLowerCase();
  return view === "desktop" || view === "phone" ? view : null;
}

/** The system actor that writes a delivery's capture note. */
export const PAGE_CAPTURE_SYSTEM_ID = "page-capture";
/** The title that note carries. */
export const PAGE_CAPTURE_NOTE_TITLE = "Page captures";
/** How many pages of one delivery are pictured; the rest are counted. */
export const PAGE_CAPTURE_MAX_PAGES = 8;
/** A source name past this is not pictured: the picture's own name must fit
 *  the 200 characters a timeline entry allows an attachment name. */
export const PAGE_CAPTURE_MAX_NAME_CHARS = 178;
