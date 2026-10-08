// Lives apart from attachment-lightbox.tsx for react-doctor's
// only-export-components. That file still exports the `useAttachmentLightbox`
// hook, so it is not a Fast Refresh boundary (see use-command-palette.ts).

/**
 * The serving-route URL with the save-dialog flag. D04-U11 (pass 32): the
 * "every call site passes a query-less URL" invariant lived in a comment here
 * and in the markdown gate only; a fifth caller passing `…?x=1` would have
 * produced `…?x=1?download=1`. One function joins the flag correctly for any
 * URL shape (query or not, fragment kept last), so no caller has to know.
 */
export function attachmentDownloadHref(url: string): string {
  const hashAt = url.indexOf("#");
  const base = hashAt === -1 ? url : url.slice(0, hashAt);
  const hash = hashAt === -1 ? "" : url.slice(hashAt);
  return `${base}${base.includes("?") ? "&" : "?"}download=1${hash}`;
}
