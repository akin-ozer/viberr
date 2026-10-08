import { describe, expect, it } from "vitest";
import { attachmentDownloadHref } from "./attachment-download-href";

/**
 * D04-U11 (pass 32): the download URL's query flag is joined by ONE function
 * for every lightbox caller. Before, `${url}?download=1` was concatenated
 * inline, safe only because each of the four call sites happened to pass a
 * query-less serving-route URL — an invariant stated in a comment. Canary:
 * restore the inline concatenation and the query case reads `…?x=1?download=1`.
 */
describe("attachmentDownloadHref", () => {
  const base = "/projects/viberr-core/tasks/VIB-1/attachments";

  it("appends the flag to a query-less serving-route URL", () => {
    expect(attachmentDownloadHref(`${base}/capture.yml`)).toBe(
      `${base}/capture.yml?download=1`,
    );
  });

  it("joins with & when the URL already carries a query", () => {
    expect(attachmentDownloadHref(`${base}/capture.yml?x=1`)).toBe(
      `${base}/capture.yml?x=1&download=1`,
    );
  });

  it("keeps a fragment after the flag", () => {
    expect(attachmentDownloadHref(`${base}/notes.md#top`)).toBe(
      `${base}/notes.md?download=1#top`,
    );
    expect(attachmentDownloadHref(`${base}/notes.md?x=1#top`)).toBe(
      `${base}/notes.md?x=1&download=1#top`,
    );
  });
});
