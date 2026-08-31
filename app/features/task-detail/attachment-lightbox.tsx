import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { Icon } from "~/ui/icon";
import { useDialog } from "~/ui/use-dialog";

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
 * with a Download button (`?download=1` on the serving route). Any other kind
 * (archives, binaries) is not interceptable — the factory leaves the anchor
 * alone and the click stays a plain download link.
 *
 * The trigger surfaces stay REAL anchors to the serving route: a plain left
 * click is intercepted into the popup, while modified clicks (cmd/ctrl/shift/
 * middle — the browser's own new-tab and save intents) pass through untouched.
 * Without a provider above it (bare renders, other pages reusing these
 * components) the handler does nothing and the anchor behaves exactly as
 * before — the popup is an enhancement, never a dependency.
 */

/** Image-typed attachment names — thumbnail previews + the image lightbox. */
export const IMAGE_RE = /\.(png|jpe?g|webp|gif)$/i;

/** Text-typed attachment names the read-only viewer renders (ruling 105).
 *  Mirrors the serving route's inert-text whitelist (task-attachments.server
 *  INLINE_TYPES) — a name matching here must fetch as text, never render. */
export const TEXT_VIEW_RE = /\.(txt|log|md|json|ya?ml|csv)$/i;

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
 * Click-handler factory for an attachment link — images AND viewable text
 * files; anything else keeps the plain anchor. Usage:
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
      // Only kinds the popup can actually show — others keep the raw link.
      if (!IMAGE_RE.test(img.name) && !TEXT_VIEW_RE.test(img.name)) return;
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

/** The read-only body of a text attachment, fetched from the member-only
 *  serving route (which serves these types as inert text/plain). */
function LightboxTextBody({ url }: { url: string }) {
  const [state, setState] = useState<
    | { kind: "loading" }
    | { kind: "failed" }
    | { kind: "ready"; text: string; truncated: boolean }
  >({ kind: "loading" });
  useEffect(() => {
    let cancelled = false;
    setState({ kind: "loading" });
    fetch(url)
      .then((res) => (res.ok ? res.text() : Promise.reject(new Error())))
      .then((text) => {
        if (cancelled) return;
        const truncated = text.length > TEXT_VIEW_MAX_CHARS;
        setState({
          kind: "ready",
          text: truncated ? text.slice(0, TEXT_VIEW_MAX_CHARS) : text,
          truncated,
        });
      })
      .catch(() => {
        if (!cancelled) setState({ kind: "failed" });
      });
    return () => {
      cancelled = true;
    };
  }, [url]);
  if (state.kind === "loading") {
    return <p className="lightbox-text-status">Loading…</p>;
  }
  if (state.kind === "failed") {
    return (
      <div className="lightbox-broken">
        <Icon name="file" />
        <p>This attachment could not be loaded.</p>
      </div>
    );
  }
  return (
    <>
      <pre className="lightbox-text" tabIndex={0}>
        {state.text}
      </pre>
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
}: {
  img: LightboxImage;
  onClose: () => void;
}) {
  const { ref, close } = useDialog(onClose);
  // The picture may not load — rotated/removed on disk (404), over the serving
  // route's 50 MB inline cap (413), or an unsupported type. Show a message
  // instead of a broken image; "Open original" below still reaches the route.
  const [failed, setFailed] = useState(false);
  // Ruling 105: a text attachment renders as a read-only viewer in the same
  // popup — the factory only intercepts names one of the two kinds can show.
  const isText = TEXT_VIEW_RE.test(img.name);
  return (
    <dialog
      className={"modal-card lightbox-card" + (isText ? " text" : "")}
      aria-label={`Attachment ${img.name}`}
      data-screen-label="Attachment lightbox"
      ref={ref}
    >
      {isText ? (
        <LightboxTextBody url={img.url} />
      ) : failed ? (
        <div className="lightbox-broken">
          <Icon name="file" />
          <p>This attachment could not be loaded.</p>
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
        {isText && (
          // The serving route forces a save dialog on `?download=1` — the raw
          // URL renders inline (that is what the viewer itself fetches).
          <a
            className="btn ghost sm"
            href={`${img.url}?download=1`}
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
        {/* F22-11: focus the Close control on open, not "Open original" (the
            first focusable) — that link navigates AWAY, so a reflex Enter on a
            freshly-opened lightbox would open the raw file in a new tab. A
            dialog opened with showModal() honors `autofocus`. */}
        <button
          type="button"
          className="icon-btn"
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
}: {
  children: ReactNode;
}) {
  const [img, setImg] = useState<LightboxImage | null>(null);
  return (
    <LightboxContext.Provider value={setImg}>
      {children}
      {img && <Lightbox img={img} onClose={() => setImg(null)} />}
    </LightboxContext.Provider>
  );
}
