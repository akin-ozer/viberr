import { type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router";
import { z } from "zod";
import { Icon } from "./icon";
import { useDialog } from "./use-dialog";

/** Overlay routes are opened from the shell with the path to return to in
 *  history state (top-bell, user-menu). Browser history state survives reloads
 *  and back/forward and is not the app's to trust, so it is parsed here rather
 *  than asserted. */
const overlayReturnState = z
  .object({ returnTo: z.string().optional().catch(undefined) })
  .catch({});

/**
 * Full-page modal built on native <dialog> via useDialog (focus trap, initial
 * focus, Escape, backdrop-click close, scroll lock, focus restore — come from
 * showModal() + the hook; the old hand-rolled trap and scrim div are gone).
 * Closing goes back where the shell opened it from (ruling 657: the overlay
 * routes each kept a copy of that close).
 */
export function PageOverlay({ label, children }: { label: string; children: ReactNode }) {
  const navigate = useNavigate();
  const location = useLocation();
  const { ref: panelRef, close } = useDialog(() => {
    // useDialog still ends an exit the overlay did not outlive (a row's page,
    // or Back, replaced it mid-fade); going back then would undo where the
    // person went.
    if (!panelRef.current) return;
    const { returnTo } = overlayReturnState.parse(location.state);
    navigate(returnTo ?? "/");
  });

  return (
    <dialog
      className="page-overlay"
      aria-label={label}
      data-screen-label={label + " · overlay"}
      ref={panelRef}
    >
      <button
        type="button"
        className="icon-btn modal-close overlay-x"
        onClick={close}
        aria-label="Close"
      >
        <Icon name="x" />
      </button>
      <div className="page-overlay-body">{children}</div>
    </dialog>
  );
}
