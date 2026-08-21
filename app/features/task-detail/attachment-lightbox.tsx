import {
  createContext,
  useCallback,
  useContext,
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
 * The trigger surfaces stay REAL anchors to the serving route: a plain left
 * click is intercepted into the popup, while modified clicks (cmd/ctrl/shift/
 * middle — the browser's own new-tab and save intents) pass through untouched.
 * Without a provider above it (bare renders, other pages reusing these
 * components) the handler does nothing and the anchor behaves exactly as
 * before — the popup is an enhancement, never a dependency.
 */

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
 * Click-handler factory for an image-attachment link. Usage:
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
  return (
    <dialog
      className="modal-card lightbox-card"
      aria-label={`Attachment ${img.name}`}
      data-screen-label="Attachment lightbox"
      ref={ref}
    >
      {failed ? (
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
