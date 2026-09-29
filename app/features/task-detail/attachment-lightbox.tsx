import {
  createContext,
  memo,
  useCallback,
  useContext,
  useEffect,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { languageForName } from "~/ui/code-language";
import { CodeView } from "~/ui/code-view";
import { Icon } from "~/ui/icon";
import { useDialog } from "~/ui/use-dialog";
import { useRemoveFromRecord } from "./remove-from-record";
import { attachmentKind, IMAGE_RE, looksBinary } from "./attachment-kind";

/**
 * Attachment lightbox (owner request 2026-08-21): clicking a piece of image
 * evidence — a timeline thumbnail, an Attachments-panel preview, an inline
 * markdown embed — opens the picture in an in-app popup instead of navigating
 * a new tab to the raw file. The dialog rides the app's one dialog contract
 * (`useDialog`: showModal, Escape, backdrop click, animated close), and keeps
 * an "Open original" link so the raw-file tab is one click away, not gone.
 *
 * Ruling 105 (owner ask 2026-08-31) widens it to TEXT evidence: a yaml/log/
 * txt/md/json/csv attachment opens as a read-only viewer in the same popup,
 * with a Download button (`?download=1` on the serving route). The owner's
 * same-day addendum makes the card UNIVERSAL: every attachment kind opens it
 * and every kind gets the Download button — images show the picture, text
 * files the reader, and anything else (archives, binaries) a no-preview note,
 * so downloading never depends on what the popup can render.
 *
 * The trigger surfaces stay REAL anchors to the serving route: a plain left
 * click is intercepted into the popup, while modified clicks (cmd/ctrl/shift/
 * middle — the browser's own new-tab and save intents) pass through untouched.
 * Without a provider above it (bare renders, other pages reusing these
 * components) the handler does nothing and the anchor behaves exactly as
 * before — the popup is an enhancement, never a dependency.
 *
 * Ruling 363 (owner, 2026-09-20): the reader is a CODE reader. Whether a file
 * is text is no longer a six-extension whitelist — `attachment-kind.ts` rules
 * out images and the known binary kinds by name and the bytes' NUL test rules
 * out the rest — and what it shows is `CodeView`: Shiki tokens by the name's
 * grammar, numbered lines, plain when no grammar is mapped.
 */

/** Re-exported for the panel and the timeline, which split images from files. */
export { IMAGE_RE };

export interface LightboxImage {
  /** Filename, for the caption and the accessible name. */
  name: string;
  /** Serving-route URL (`…/attachments/<file>`). */
  url: string;
}

const LightboxContext = createContext<((img: LightboxImage) => void) | null>(
  null,
);

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

/**
 * Click-handler factory for an attachment link — every kind opens the card
 * (ruling 105 addendum); modified clicks keep the plain anchor. Usage:
 *   const lightbox = useAttachmentLightbox();
 *   <a href={url} target="_blank" onClick={lightbox({ name, url })}>…
 */
export function useAttachmentLightbox(): (
  img: LightboxImage,
) => (e: ReactMouseEvent<HTMLElement>) => void {
  const open = useContext(LightboxContext);
  return useCallback(
    (img: LightboxImage) => (e: ReactMouseEvent<HTMLElement>) => {
      if (!open) return; // no provider: the anchor stays a plain link
      if (e.defaultPrevented || e.button !== 0) return;
      // The browser's own open-in-new-tab / save intents keep the anchor.
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      e.preventDefault();
      open(img);
    },
    [open],
  );
}

/** Show-at-most bound for the text viewer: the popup is a reader, not an
 *  editor — a multi-megabyte log renders its head and the note says so. */
const TEXT_VIEW_MAX_CHARS = 200_000;

/** Interface review 2026-09-24 (writ-5): a fetch that PROVED the file
 *  unservable (404, 413, auth redirect, network) drops Download, so the card
 *  names the likely causes and the one step that clears each: a reload
 *  refreshes a stale list, sends an ended session to sign-in, retries a drop. */
const UNSERVABLE_COPY =
  "Unable to load this file. It may have been removed, or your session may have ended. Reload the page and try again.";

/**
 * Read at most `cap` characters of the body, then STOP the transfer — the
 * route serves up to 50 MB, and `res.text()` would buffer all of it before
 * the display cap could apply (ruling-105 review). Falls back to the buffered
 * read where the body stream is unavailable (older jsdom shims).
 */
async function readTextCapped(
  res: Response,
  cap: number,
): Promise<{ text: string; truncated: boolean }> {
  const reader = res.body?.getReader?.();
  if (!reader) {
    const text = await res.text();
    return { text: text.slice(0, cap), truncated: text.length > cap };
  }
  const decoder = new TextDecoder();
  let out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return { text: out, truncated: false };
    out += decoder.decode(value, { stream: true });
    if (out.length > cap) {
      await reader.cancel();
      return { text: out.slice(0, cap), truncated: true };
    }
  }
}

/** The read-only body of a text attachment, fetched from the member-only
 *  serving route (inert text/plain for the ruling-105 types, a download for
 *  every other name — fetch reads either; nothing is ever rendered).
 *  `onUnservable` fires when the fetch PROVED the file unservable (404, 413,
 *  auth redirect, network failure) so the footer can drop its Download button
 *  — some browsers save a failed download's error body as a file bearing the
 *  attachment's real name. */
function LightboxTextBody({
  url,
  name,
  onUnservable,
}: {
  url: string;
  /** The filename — it picks the grammar (ruling 363). */
  name: string;
  onUnservable: () => void;
}) {
  const [state, setState] = useState<
    | { kind: "loading" }
    | { kind: "failed" }
    | { kind: "binary" }
    | { kind: "ready"; text: string; truncated: boolean }
  >({ kind: "loading" });
  useEffect(() => {
    let cancelled = false;
    setState({ kind: "loading" });
    // A redirect means the response is NOT the attachment (an expired session
    // 302s to /login, whose HTML would otherwise render as the file's
    // "content") — treat it as a load failure, same as a non-2xx.
    fetch(url)
      .then((res) =>
        res.ok && !res.redirected
          ? readTextCapped(res, TEXT_VIEW_MAX_CHARS)
          : Promise.reject(new Error()),
      )
      .then((read) => {
        if (cancelled) return;
        // Ruling 363: the name said "try the reader"; the bytes get the last
        // word — a NUL in the head means this was never text.
        setState(
          looksBinary(read.text) ? { kind: "binary" } : { kind: "ready", ...read },
        );
      })
      .catch(() => {
        if (!cancelled) {
          setState({ kind: "failed" });
          onUnservable();
        }
      });
    return () => {
      cancelled = true;
    };
  }, [url, onUnservable]);
  if (state.kind === "loading") {
    return <p className="lightbox-text-status">Loading…</p>;
  }
  if (state.kind === "failed") {
    return (
      <div className="lightbox-broken">
        <Icon name="file" />
        <p>{UNSERVABLE_COPY}</p>
      </div>
    );
  }
  if (state.kind === "binary") {
    // Same card as a name-decided binary, and the same Download beside it:
    // the fetch succeeded, so the file is servable — just not readable.
    return (
      <div className="lightbox-broken">
        <Icon name="file" />
        <p>This file is not text, so it has no in-app preview. Use Download to save it.</p>
      </div>
    );
  }
  if (state.text === "") {
    // A zero-byte file is a real, loadable attachment — say so instead of
    // showing the blank dialog the failure branch exists to avoid.
    return <p className="lightbox-text-status">This file is empty.</p>;
  }
  return (
    <>
      <CodeView
        className="lightbox-text"
        text={state.text}
        language={languageForName(name)}
      />
      {state.truncated && (
        <p className="lightbox-text-status">
          Showing the first part of a large file. Download it for the rest.
        </p>
      )}
    </>
  );
}

function Lightbox({
  img,
  onClose,
  onRemove,
}: {
  img: LightboxImage;
  onClose: () => void;
  /** Ruling 582: the viewer may take this file off its task's record. */
  onRemove?: () => void;
}) {
  const { ref, close } = useDialog(onClose);
  // The picture may not load — rotated/removed on disk (404), over the serving
  // route's 50 MB inline cap (413), or an unsupported type. Show a message
  // instead of a broken image; "Open original" below still reaches the route.
  const [failed, setFailed] = useState(false);
  // Ruling 105: a text attachment renders as a read-only viewer in the same
  // popup; per the addendum every other kind opens the card too, with a
  // no-preview note standing in for content the popup cannot render.
  // Ruling 363: the name rules out images and the known binary kinds; every
  // other name tries the reader, whose NUL test has the last word.
  const kind = attachmentKind(img.name);
  const isText = kind === "text";
  const isOther = kind === "binary"; // the remaining kind, image, is the <img> branch
  // An HTTP-layer response PROVED the file unservable (404 after the ruling-
  // 105 prune or a delete, 413 over the route's 50 MB cap, auth redirect).
  // Then the footer drops Download: some browsers save a failed download's
  // error body as a file bearing the attachment's real name. The image branch
  // never sets this — <img onError> can't distinguish a 404 from a corrupt-
  // but-servable file, and for the latter Download is exactly the remedy.
  const [fetchFailed, setFetchFailed] = useState(false);
  const markUnservable = useCallback(() => setFetchFailed(true), []);
  // The no-preview card is the one body that never touches the URL, so it
  // would happily offer Download on a file that is already gone — probe once,
  // dropping the body bytes as soon as the status is known.
  useEffect(() => {
    if (!isOther) return;
    let cancelled = false;
    fetch(img.url)
      .then((res) => {
        void res.body?.cancel?.();
        if (!cancelled && !(res.ok && !res.redirected)) setFetchFailed(true);
      })
      .catch(() => {
        if (!cancelled) setFetchFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [img.url, isOther]);
  return (
    <dialog
      className={"modal-card lightbox-card" + (isText ? " text" : "")}
      aria-label={`Attachment ${img.name}`}
      data-screen-label="Attachment lightbox"
      ref={ref}
    >
      {isText ? (
        <LightboxTextBody
          url={img.url}
          name={img.name}
          onUnservable={markUnservable}
        />
      ) : isOther ? (
        <div className="lightbox-broken">
          <Icon name="file" />
          {/* "in-app": the route DOES serve some of these inline (PDFs), so
              Open original below may still render one — the card only says
              this popup has no viewer for the kind. */}
          <p>
            {fetchFailed
              ? UNSERVABLE_COPY
              : "This file type has no in-app preview. Use Download to save it."}
          </p>
        </div>
      ) : failed ? (
        <div className="lightbox-broken">
          <Icon name="file" />
          {/* onError cannot tell a 404 from bytes the browser cannot decode,
              and Download stays for exactly the second case — so point at it. */}
          <p>
            Unable to show this image. Use Download or Open original to get the
            file itself.
          </p>
        </div>
      ) : (
        <img
          className="lightbox-img"
          src={img.url}
          alt={img.name}
          onError={() => setFailed(true)}
        />
      )}
      <div className="lightbox-foot">
        <span className="nm">{img.name}</span>
        {/* Every kind gets the button (ruling 105 addendum) — unless a fetch
            proved the file unservable, see `fetchFailed`. The serving route
            forces a save dialog on `download=1` — the raw URL renders inline
            where the type allows (that is what the viewer itself fetches).
            `attachmentDownloadHref` joins the flag for any URL shape, so a
            caller passing a query cannot corrupt it. The `download` attribute
            keeps a failed response from replacing the task page with an error
            body. */}
        {!fetchFailed && (
          <a
            className="btn ghost sm"
            href={attachmentDownloadHref(img.url)}
            download={img.name}
            rel="noreferrer"
          >
            Download
          </a>
        )}
        {/* The raw file, exactly what the click used to open — for zooming
            further, saving, or sharing the URL. */}
        <a className="btn ghost sm" href={img.url} target="_blank" rel="noreferrer">
          Open original
        </a>
        {onRemove && (
          <button type="button" className="btn ghost sm" onClick={onRemove}>
            Remove
          </button>
        )}
        {/* F22-11: focus the Close control on open, not "Open original" (the
            first focusable) — that link navigates AWAY, so a reflex Enter on a
            freshly-opened lightbox would open the raw file in a new tab. A
            dialog opened with showModal() honors `autofocus`.
            Ruling 148: it takes the shared close design (borderless circle),
            the same control as every modal head and the page overlay. It stays
            the foot's trailing item — the foot sits on the card's own surface,
            where the shared transparent rest and soft hover read correctly,
            and an absolute corner control would sit over the ruling-105 text
            viewer's scrolling first line. */}
        <button
          type="button"
          className="icon-btn modal-close"
          onClick={close}
          aria-label="Close"
          autoFocus
        >
          <Icon name="x" />
        </button>
      </div>
    </dialog>
  );
}

/** Mount once around a page whose descendants show attachment images (the
 *  task page). Renders the popup; `useAttachmentLightbox` triggers it. */
export function AttachmentLightboxProvider({
  children,
  removable = false,
}: {
  children: ReactNode;
  /** Ruling 582: the viewer holds `remove-from-record`, so the card offers
   *  Remove on a task attachment. */
  removable?: boolean;
}) {
  const [img, setImg] = useState<LightboxImage | null>(null);
  return (
    <LightboxContext.Provider value={setImg}>
      {children}
      {removable ? (
        <RemovableLightbox img={img} setImg={setImg} />
      ) : (
        img && <Lightbox img={img} onClose={() => setImg(null)} />
      )}
    </LightboxContext.Provider>
  );
}

/** Ruling 582: the card with Remove on a task attachment, and the confirm it
 *  asks. Its own component, so only a page that offers removal needs the data
 *  router the confirm's fetcher posts through; memoised, so a revalidation
 *  that leaves no card open renders nothing more (ruling 457). */
const RemovableLightbox = memo(function RemovableLightbox({
  img,
  setImg,
}: {
  img: LightboxImage | null;
  setImg: (img: LightboxImage | null) => void;
}) {
  const [askRemove, removeDialog] = useRemoveFromRecord();
  // The task that serves the file takes its removal: its URL ends in
  // `/attachments/<name>`, and anything else the card opens is not one.
  const cut = img ? img.url.lastIndexOf("/attachments/") : -1;
  const remove =
    img && cut > 0
      ? () => {
          // A hand-off to the confirm, so the card goes at once (useDialog).
          setImg(null);
          askRemove({ name: img.name, action: img.url.slice(0, cut) });
        }
      : null;
  return (
    <>
      {img && <Lightbox img={img} onClose={() => setImg(null)} {...(remove ? { onRemove: remove } : {})} />}
      {removeDialog}
    </>
  );
});
